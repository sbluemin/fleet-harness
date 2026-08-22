import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { normalizeFingerprint, pinHostname } from "@fleet-console/access-protocol";

/** Chromium 검증 결과 코드. 0=수락, -2=거부, -3=Chromium 판정 그대로. */
export const CERTIFICATE_ACCEPTED = 0;
export const CERTIFICATE_REJECTED = -2;
export const CERTIFICATE_DEFAULT = -3;

export const REMOTE_REQUEST_TIMEOUT_MS = 8_000;

/** Electron이 검증기에 넘기는 값 중 이 게이트가 실제로 읽는 부분만 선언한다. */
export interface CertificateVerifyRequest {
  readonly hostname: string;
  readonly certificate?: { readonly data?: string };
}

/** 핀 비교 표기는 Console의 접근 프로토콜이 단독 정의한다 — 여기서 다시 정의하지 않는다. */
export { normalizeFingerprint, pinHostname };

export type CertificateVerifyProc = (request: CertificateVerifyRequest, callback: (verificationResult: number) => void) => void;

export interface PinnableSession {
  setCertificateVerifyProc(proc: CertificateVerifyProc | null): void;
}

/** `session.fetch`와 형태를 맞춘 최소 계약. 조인과 이후 요청이 같은 쿠키 항아리를 써야 한다. */
export type SessionFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteCertificatePins {
  pin(hostname: string, fingerprint: string): void;
  unpin(hostname: string): void;
  clear(): void;
}

/**
 * Console이 실어 보낸 지문을 그 호스트의 유일한 신뢰 근거로 고정한다. 이 훅은 신뢰를 넓히지
 * 않는다 — 핀이 걸리지 않은 호스트는 Chromium 판정을 그대로 되돌려 주고, 핀이 걸린 호스트만
 * 지문이 일치할 때 수락한다. 자체서명 인증서는 이 경로 밖에서는 계속 거부된다.
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
    pin(hostname, fingerprint): void { pins.set(pinHostname(hostname), normalizeFingerprint(fingerprint)); },
    unpin(hostname): void { pins.delete(pinHostname(hostname)); },
    clear(): void { pins.clear(); },
  };
}

/**
 * Chromium이 이 호스트를 처음 보기 전에, 우리가 직접 인증서를 확인한다.
 *
 * Chromium은 (인증서, 호스트) 쌍의 검증 결과를 캐시하고, 그 캐시는 핀 교체·연결 종료·
 * 검증기 재설치·clearCache·setSSLConfig 어느 것으로도 무효화되지 않는다(실측). 지문이
 * 어긋난 대상을 한 번이라도 Chromium에 통과시키면 그 실패가 캐시에 남아, 뒤이어 고친
 * 올바른 대상까지 앱을 재시작할 때까지 거부된다. 그래서 어긋난 대상은 Chromium에
 * 도달하기 전에 여기서 끝난다.
 *
 * 이 확인이 Chromium의 검증기를 대신하지는 않는다. 확인과 요청 사이에 인증서가 바뀌면
 * 핀이 그 요청을 막는다 — 그 경우는 사용자 오타가 아니라 실제 교체이므로 시끄러워야 한다.
 */
export async function confirmRemoteIdentity(hostname: string, port: number, expected: string, timeoutMs = REMOTE_REQUEST_TIMEOUT_MS): Promise<void> {
  const presented = await readPresentedFingerprint(hostname, port, timeoutMs);
  if (presented === null) throw new Error("remote_link_unreachable");
  if (presented !== normalizeFingerprint(expected)) throw new Error("remote_link_fingerprint_mismatch");
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
 * 조인한다. 링크를 처음 쓸 때는 1회용 자격을 함께 보내고, 이미 페어링된 콘솔로 돌아갈 때는
 * 아무것도 보내지 않는다 — 그때의 통행증은 창의 쿠키 항아리에 있는 페어링 쿠키이고, 이 요청이
 * 그것을 세션으로 바꾼다. 그래서 제어권을 회수당했거나 접속이 끊긴 뒤에도 링크 없이 돌아온다.
 *
 * 자격은 본문으로만 보내 URL과 로그에 남기지 않고, 리다이렉트는 받지 않는다 — 조인은 지문을
 * 확인한 그 서버에서만 성립해야 한다.
 *
 * 기기 이름은 자격이 아니라 상대편 운영자를 위한 표식이다. 그것이 없으면 원격 콘솔의 기기
 * 목록에서 어느 줄을 끊어야 하는지 알 수 없다.
 */
export async function joinRemoteConsole(sessionFetch: SessionFetch, joinUrl: string, token: string | null, device: string | null = null, timeoutMs = REMOTE_REQUEST_TIMEOUT_MS): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await sessionFetch(joinUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      // 기기 이름을 함께 보낸다 — 원격 쪽 목록에서 "이름 없는 기기"로만 보이면 회수를 결정할 수 없다.
      body: JSON.stringify({ ...(token === null ? {} : { token }), ...(device === null ? {} : { device }) }),
      signal: controller.signal,
    });
    // 자격을 내밀었는데 거절당한 것과, 이 콘솔이 더 이상 이 기기를 알아보지 못하는 것은 다른 사실이다.
    if (response.status === 401) throw new Error(token === null ? "remote_host_not_paired" : "remote_link_rejected");
    if (response.status === 403) throw new Error("remote_link_host_mismatch");
    /**
     * 409는 자격 문제가 아니다 — 그 콘솔이 지금은 받을 수 없다는 뜻이고, 이유가 둘이다.
     * 제어를 다른 기기가 쥐고 있거나, 그 콘솔이 기억할 수 있는 기기 수가 다 찼거나. 서버는
     * 둘을 다른 코드로 보내는데 여기서 하나로 뭉개면, 자리만 비면 되는 경우와 남의 기기를
     * 지워야 하는 경우에 같은 안내가 나가 사용자가 듣는 해법이 틀린다.
     */
    if (response.status === 409) throw new Error(await readConflictCode(response));
    if (!response.ok) throw new Error("remote_link_unverified");
  } catch (error) {
    // 이 함수가 스스로 내린 판정은 그대로 올려 보낸다. 접두사만으로 가르면 "이 기기를 모른다"는
    // 판정이 도달 실패로 뭉개져, 사용자는 네트워크를 의심하며 링크를 다시 받지 않는다.
    if (error instanceof Error && (error.message.startsWith("remote_link_") || error.message === "remote_host_not_paired")) throw error;
    throw new Error("remote_link_unreachable", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** 읽을 수 없는 본문은 지금까지의 뜻으로 되돌린다 — 제어 경합이 둘 중 훨씬 흔하다. */
async function readConflictCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly error?: unknown };
    return body.error === "paired_device_limit" ? "remote_link_device_limit" : "remote_link_control_held";
  } catch {
    return "remote_link_control_held";
  }
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

function redactHost(value: string): string {
  return /^[a-z0-9._:-]{1,255}$/u.test(value) ? value : "invalid";
}
