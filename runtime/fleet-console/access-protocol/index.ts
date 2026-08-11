/**
 * 액세스 링크는 주소·1회용 자격·서버 신원·이름을 하나의 봉투에 담아 `fleet://join?code=`로
 * 실어 나른다. 주소를 URL 껍데기에 두지 않는 이유는 두 가지다 — 붙여넣는 사람 눈에 사설 IP와
 * 포트가 드러나지 않고, 봉투가 버전을 가지므로 나중에 필드를 늘려도 옛 링크를 구분할 수 있다.
 *
 * 이 스킴은 브라우저가 따라갈 수 없다. 링크를 여는 주체는 Fleet 네이티브 셸(Desktop과 Mobile)이며,
 * 브라우저 원격 접속은 별도 결정 전까지 열지 않는다.
 *
 * 링크를 신뢰한다는 것이 곧 그 서버를 신뢰한다는 뜻이므로 파싱은 관대할 이유가 없다. 모양이
 * 어긋난 링크는 고쳐 쓰지 않고 거절한다.
 */
export interface AccessLinkPayload {
  readonly v: number;
  /** `https://host:port`. origin 형태 그대로이며 경로·질의·fragment를 갖지 않는다. */
  readonly endpoint: string;
  readonly token: string;
  /** 구분자 없는 대문자 SHA-256 hex. */
  readonly fingerprint: string;
  /** 발급한 콘솔이 스스로를 부르는 이름. 목록에서 호스트를 알아보는 유일한 단서다. */
  readonly label: string;
}

export interface ValidatedAccessLink {
  readonly origin: string;
  /** 인증서 핀의 키. URL이 대괄호로 감싼 IPv6 리터럴은 벗겨서 담는다. */
  readonly hostname: string;
  readonly port: number;
  readonly label: string;
  readonly consoleUrl: string;
  readonly joinUrl: string;
  readonly token: string;
  readonly fingerprint: string;
}

export const ACCESS_LINK_SCHEME = "fleet:";
export const ACCESS_LINK_HOST = "join";
export const ACCESS_LINK_PREFIX = "fleet://join?code=";
export const ACCESS_LINK_VERSION = 1;
export const ACCESS_JOIN_PATH = "/api/v1/join";

export const MAX_ACCESS_LABEL_LENGTH = 48;

const MAX_ACCESS_LINK_LENGTH = 4096;
const ACCESS_TOKEN = /^[A-Za-z0-9_-]{16,512}$/u;
const CERTIFICATE_FINGERPRINT = /^[0-9A-F]{64}$/u;
const PAYLOAD_KEYS = ["v", "endpoint", "token", "fingerprint", "label"] as const;
const BASE64_URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_URL_DECODE = createBase64UrlDecodeTable();

/** 링크 후보인지만 가른다 — 유효성은 parseAccessLink가 판정한다. */
export function isAccessLinkInput(value: string): boolean {
  return value.trimStart().toLowerCase().startsWith("fleet://");
}

export function encodeAccessLink(payload: Omit<AccessLinkPayload, "v">): string {
  const envelope: AccessLinkPayload = {
    v: ACCESS_LINK_VERSION,
    endpoint: payload.endpoint,
    token: payload.token,
    fingerprint: normalizeFingerprint(payload.fingerprint),
    label: sanitizeAccessLabel(payload.label),
  };
  return `${ACCESS_LINK_PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}`;
}

export function parseAccessLink(input: string): ValidatedAccessLink {
  if (typeof input !== "string") throw invalidLink();
  const candidate = input.trim();
  if (candidate.length === 0 || candidate.length > MAX_ACCESS_LINK_LENGTH) throw invalidLink();
  if (containsDisallowedLinkWhitespace(candidate)) throw invalidLink();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidLink();
  }
  // 봉투 하나만 받는다. 자격이 다른 자리에 섞여 들어오는 형태는 우리가 발급한 것이 아니다.
  if (url.protocol !== ACCESS_LINK_SCHEME || url.username || url.password || url.hash) throw invalidLink();
  if (url.hostname !== ACCESS_LINK_HOST || url.port !== "" || url.pathname !== "") throw invalidLink();
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "code") throw invalidLink();
  return readPayload(decodePayload(url.searchParams.get("code") ?? ""));
}

function decodePayload(code: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(code)) throw invalidLink();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(code));
  } catch {
    throw invalidLink();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidLink();
  }
}

function readPayload(value: unknown): ValidatedAccessLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidLink();
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((key) => keys.includes(key))) throw invalidLink();
  if (entry.v !== ACCESS_LINK_VERSION) throw invalidLink();
  if (typeof entry.endpoint !== "string" || typeof entry.token !== "string" || typeof entry.fingerprint !== "string" || typeof entry.label !== "string") throw invalidLink();
  const endpoint = readEndpoint(entry.endpoint);
  const token = entry.token;
  const fingerprint = normalizeFingerprint(entry.fingerprint);
  if (!ACCESS_TOKEN.test(token) || !CERTIFICATE_FINGERPRINT.test(fingerprint)) throw invalidLink();
  const label = sanitizeAccessLabel(entry.label);
  if (label.length === 0) throw invalidLink();
  return {
    origin: endpoint.origin,
    hostname: pinHostname(endpoint.hostname),
    port: endpoint.port,
    label,
    consoleUrl: new URL("/console/", endpoint.origin).toString(),
    joinUrl: new URL(ACCESS_JOIN_PATH, endpoint.origin).toString(),
    token,
    fingerprint,
  };
}

/**
 * endpoint는 https origin뿐이다. 링크가 서버 신원을 실어 나르는 유일한 채널이라, 평문 강등을
 * 허용하면 지문 대조 자체가 무의미해진다.
 */
function readEndpoint(value: string): { readonly origin: string; readonly hostname: string; readonly port: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidLink();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw invalidLink();
  if (url.pathname !== "/" && url.pathname !== "") throw invalidLink();
  if (url.hostname.length === 0) throw invalidLink();
  const port = url.port === "" ? 443 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw invalidLink();
  return { origin: url.origin, hostname: url.hostname, port };
}

/** 인증서 핀은 호스트 단위다. Chromium은 검증기에 대괄호 없는 호스트명을 넘긴다. */
export function pinHostname(hostname: string): string {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unwrapped.toLowerCase();
}

/**
 * 링크와 UI가 같은 표기를 쓰도록 지문 비교는 항상 정규화한 뒤 수행한다. 콘솔은 구분자 없이
 * 발급하지만 손으로 옮긴 콜론·공백 표기도 같은 값으로 본다.
 *
 * 지문 표기의 유일한 정의다 — 두 벌이 되면 한쪽만 고쳐진 채로 갈라진다.
 */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/gu, "").toUpperCase();
}

/**
 * 라벨은 목록에 그대로 그려지므로 제어문자와 방향 재정의 문자를 남겨 두지 않는다 — 호스트
 * 이름이 옆줄의 주소를 가리는 형태로 읽히면 안 된다.
 */
export function sanitizeAccessLabel(value: string): string {
  return Array.from(value)
    .filter((character) => !isDisallowedAccessLabelCharacter(character.codePointAt(0)!))
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ACCESS_LABEL_LENGTH);
}

function containsDisallowedLinkWhitespace(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f || isWhitespaceCharacter(character)) return true;
  }
  return false;
}

function isWhitespaceCharacter(character: string): boolean {
  return character.trim().length === 0;
}

function isDisallowedAccessLabelCharacter(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function toBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_URL_ALPHABET[first >> 2];
    encoded += BASE64_URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) encoded += BASE64_URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) encoded += BASE64_URL_ALPHABET[third & 0x3f];
  }
  return encoded;
}

function fromBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw invalidLink();
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const decoded = BASE64_URL_DECODE[character.charCodeAt(0)] ?? -1;
    if (decoded < 0) throw invalidLink();
    buffer = (buffer << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw invalidLink();
  return bytes;
}

function createBase64UrlDecodeTable(): Int16Array {
  const table = new Int16Array(128);
  table.fill(-1);
  for (let index = 0; index < BASE64_URL_ALPHABET.length; index += 1) {
    table[BASE64_URL_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
}

function invalidLink(): Error {
  return new Error("pairing_target_invalid");
}
