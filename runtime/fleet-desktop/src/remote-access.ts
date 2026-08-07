import net from "node:net";
import tls from "node:tls";

import { certificateFingerprint, normalizeFingerprint, type ValidatedAccessLink } from "./remote-access-link.js";

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
 * Chromium이 이 호스트를 처음 보기 전에, 우리가 직접 인증서를 확인한다.
 *
 * Chromium은 (인증서, 호스트) 쌍의 검증 결과를 캐시하고, 그 캐시는 핀 교체·연결 종료·
 * 검증기 재설치·clearCache·setSSLConfig 어느 것으로도 무효화되지 않는다(실측). 지문이
 * 어긋난 링크를 한 번이라도 Chromium에 통과시키면 그 실패가 캐시에 남아, 뒤이어 붙여넣은
 * 올바른 링크까지 앱을 재시작할 때까지 거부된다. 그래서 어긋난 링크는 Chromium에
 * 도달하기 전에 여기서 끝난다.
 *
 * 이 확인이 Chromium의 검증기를 대신하지는 않는다. 확인과 요청 사이에 인증서가 바뀌면
 * 핀이 그 요청을 막는다 — 그 경우는 사용자 오타가 아니라 실제 교체이므로 시끄러워야 한다.
 */
export async function confirmRemoteIdentity(link: ValidatedAccessLink, timeoutMs = REMOTE_REQUEST_TIMEOUT_MS): Promise<void> {
  const presented = await readPresentedFingerprint(link.hostname, link.port, timeoutMs);
  if (presented === null) throw new Error("remote_link_unreachable");
  if (presented !== link.fingerprint) throw new Error("remote_link_fingerprint_mismatch");
}

function readPresentedFingerprint(hostname: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const settle = (value: string | null): void => {
      socket.destroy();
      resolve(value);
    };
    // 신원 확인이 목적이므로 체인 검증은 끄고 제시된 인증서만 읽는다. IP 리터럴에는 SNI를 붙이지 않는다.
    const socket = tls.connect({
      host: hostname,
      port,
      rejectUnauthorized: false,
      ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, () => {
      const certificate = socket.getPeerX509Certificate();
      settle(certificate ? normalizeFingerprint(certificate.fingerprint256) : null);
    });
    socket.setTimeout(timeoutMs, () => settle(null));
    socket.on("error", () => settle(null));
  });
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
