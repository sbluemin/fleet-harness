import crypto from "node:crypto";

/**
 * 액세스 링크는 주소·1회용 자격·서버 신원을 한 문자열로 묶는다. 자격과 지문은 fragment에
 * 실려 요청에 포함되지 않으므로 서버 로그나 중계 지점에 남지 않는다.
 *
 * 링크를 신뢰한다는 것이 곧 그 서버를 신뢰한다는 뜻이므로 파싱은 관대할 이유가 없다.
 * 모양이 어긋난 링크는 고쳐 쓰지 않고 거절한다.
 */
export interface ValidatedAccessLink {
  readonly origin: string;
  /** 인증서 핀의 키. URL이 대괄호로 감싼 IPv6 리터럴은 벗겨서 담는다. */
  readonly hostname: string;
  readonly port: number;
  readonly consoleUrl: string;
  readonly joinUrl: string;
  readonly token: string;
  /** 구분자 없는 대문자 SHA-256 hex. */
  readonly fingerprint: string;
}

export const ACCESS_LINK_PATH = "/join";
export const ACCESS_JOIN_PATH = "/api/v1/join";

const MAX_ACCESS_LINK_LENGTH = 2048;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{16,512}$/u;
const CERTIFICATE_FINGERPRINT = /^[0-9A-F]{64}$/u;

/** 링크 후보인지만 가른다 — 유효성은 parseAccessLink가 판정한다. */
export function isAccessLinkInput(value: string): boolean {
  return value.startsWith("https://");
}

export function parseAccessLink(input: string): ValidatedAccessLink {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_ACCESS_LINK_LENGTH) throw invalidLink();
  if (/[\u0000-\u001f\u007f\s]/u.test(input)) throw invalidLink();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidLink();
  }
  // https만 받는다. 링크가 서버 신원을 실어 나르는 유일한 채널이라, 평문 강등을 허용하면
  // 지문 대조 자체가 무의미해진다. 자격이 URL에 섞여 들어오는 형태도 함께 막는다.
  if (url.protocol !== "https:" || url.username || url.password || url.search) throw invalidLink();
  if (url.pathname !== ACCESS_LINK_PATH || url.hostname.length === 0) throw invalidLink();
  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw invalidLink();
  const credential = readLinkCredential(url.hash);
  return {
    origin: url.origin,
    hostname: pinHostname(url.hostname),
    port,
    consoleUrl: new URL("/console/", url.origin).toString(),
    joinUrl: new URL(ACCESS_JOIN_PATH, url.origin).toString(),
    token: credential.token,
    fingerprint: credential.fingerprint,
  };
}

/** 인증서 핀은 호스트 단위다. Chromium은 검증기에 대괄호 없는 호스트명을 넘긴다. */
export function pinHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unwrapped.toLowerCase();
}

/** 콘솔은 구분자 없이 발급하지만, 손으로 옮긴 콜론 표기도 같은 값으로 본다. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/:/gu, "").toUpperCase();
}

/** 제시된 PEM 인증서의 지문. 읽을 수 없는 인증서는 불일치가 아니라 판정 불가로 되돌린다. */
export function certificateFingerprint(certificatePem: string): string | null {
  if (typeof certificatePem !== "string" || certificatePem.length === 0) return null;
  try {
    return normalizeFingerprint(new crypto.X509Certificate(certificatePem).fingerprint256);
  } catch {
    return null;
  }
}

function readLinkCredential(hash: string): { readonly token: string; readonly fingerprint: string } {
  const parameters = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const keys = [...parameters.keys()];
  // 정확히 t와 f만. 중복 키나 잉여 키가 붙은 링크는 우리가 발급한 것이 아니다.
  if (keys.length !== 2 || !keys.includes("t") || !keys.includes("f")) throw invalidLink();
  const token = parameters.get("t") ?? "";
  const fingerprint = normalizeFingerprint(parameters.get("f") ?? "");
  if (!ACCESS_TOKEN.test(token) || !CERTIFICATE_FINGERPRINT.test(fingerprint)) throw invalidLink();
  return { token, fingerprint };
}

function invalidLink(): Error {
  return new Error("pairing_target_invalid");
}
