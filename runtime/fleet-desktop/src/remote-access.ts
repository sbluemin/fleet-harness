import { certificateFingerprint, type ValidatedAccessLink } from "./remote-access-link.js";

/** Chromium 검증 결과 코드. 0=수락, -2=거부, -3=Chromium 판정 그대로. */
export const CERTIFICATE_ACCEPTED = 0;
export const CERTIFICATE_REJECTED = -2;
export const CERTIFICATE_DEFAULT = -3;

const REMOTE_REQUEST_TIMEOUT_MS = 8_000;

/** Electron이 검증기에 넘기는 값 중 이 게이트가 실제로 읽는 부분만 선언한다. */
export interface CertificateVerifyRequest {
  readonly hostname: string;
  readonly certificate?: { readonly data?: string };
}

export type CertificateVerifyProc = (request: CertificateVerifyRequest, callback: (verificationResult: number) => void) => void;

export interface PinnableSession {
  setCertificateVerifyProc(proc: CertificateVerifyProc | null): void;
}

/** `session.fetch`와 형태를 맞춘 최소 계약. 조인과 신원 확인이 같은 쿠키 항아리를 써야 한다. */
export type SessionFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteCertificatePins {
  pin(hostname: string, fingerprint: string): void;
  unpin(hostname: string): void;
  clear(): void;
}

/**
 * 링크가 실어 나른 지문을 그 호스트의 유일한 신뢰 근거로 고정한다. 이 훅은 신뢰를 넓히지
 * 않는다 — 핀이 걸리지 않은 호스트는 Chromium 판정을 그대로 되돌려 주고, 핀이 걸린
 * 호스트만 지문이 일치할 때 수락한다. 자체서명 인증서는 이 경로 밖에서는 계속 거부된다.
 *
 * 검증기는 세션당 하나뿐이라 호스트별 판정을 이 레지스트리 한 곳에서 분배한다. Electron이
 * 넘기는 요청에는 포트가 없으므로 핀의 단위도 호스트다.
 */
export function installRemoteCertificatePins(session: PinnableSession, log?: (message: string) => void): RemoteCertificatePins {
  const pins = new Map<string, string>();
  session.setCertificateVerifyProc((request, callback) => {
    const hostname = request.hostname?.toLowerCase() ?? "";
    const expected = pins.get(hostname);
    if (expected === undefined) {
      callback(CERTIFICATE_DEFAULT);
      return;
    }
    const presented = certificateFingerprint(request.certificate?.data ?? "");
    if (presented !== null && presented === expected) {
      callback(CERTIFICATE_ACCEPTED);
      return;
    }
    log?.(`remote certificate pin mismatch host=${redactHost(hostname)}`);
    callback(CERTIFICATE_REJECTED);
  });
  return {
    pin(hostname, fingerprint): void { pins.set(hostname, fingerprint); },
    unpin(hostname): void { pins.delete(hostname); },
    clear(): void { pins.clear(); },
  };
}

/**
 * 링크의 1회용 자격을 세션으로 바꾼다. 자격은 본문으로만 보내 URL과 로그에 남기지 않고,
 * 리다이렉트는 받지 않는다 — 조인은 지문을 확인한 그 서버에서만 성립해야 한다.
 */
export async function joinRemoteConsole(sessionFetch: SessionFetch, link: ValidatedAccessLink, timeoutMs = REMOTE_REQUEST_TIMEOUT_MS): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await sessionFetch(link.joinUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token }),
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error("remote_link_rejected");
    if (response.status === 403) throw new Error("remote_link_host_mismatch");
    if (!response.ok) throw new Error("remote_link_unverified");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("remote_link_")) throw error;
    throw new Error("remote_link_unreachable", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function redactHost(value: string): string {
  return /^[a-z0-9._:-]{1,255}$/u.test(value) ? value : "invalid";
}
