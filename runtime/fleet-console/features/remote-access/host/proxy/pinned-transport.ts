import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { normalizeFingerprint } from "../remote-identity.js";

/**
 * 원격 콘솔로 가는 broker의 유일한 출구.
 *
 * 연결마다 TLS를 새로 열고, `secureConnect`에서 인증서 지문을 핀과 대조한 **뒤에만** 그 소켓을 HTTP에
 * 넘긴다 — 핀이 어긋나면 HTTP 바이트(곧 세션 쿠키)를 한 바이트도 쓰지 않고 소켓을 파기한다. TLS 세션을
 * 재사용하지 않으므로 핀 교체 전의 합의가 새 연결로 넘어오지 않는다. redirect는 따라가지 않는다.
 */
export interface PinnedTarget {
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
}

export interface PinnedRequest {
  readonly method: "GET" | "POST";
  /** 이미 정규화·허용목록 검사를 마친 경로와 쿼리. */
  readonly path: string;
  readonly headers: http.OutgoingHttpHeaders;
  readonly signal: AbortSignal;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export class PinRejectedError extends Error {
  constructor() {
    super("pin_rejected");
    this.name = "PinRejectedError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function connectPinned(target: PinnedTarget, signal: AbortSignal, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    const socket = tls.connect({
      host: target.hostname,
      port: target.port,
      // 자체서명 인증서는 CA로 검증할 수 없다 — 신뢰는 아래의 지문 대조가 전부다.
      rejectUnauthorized: false,
      ...(net.isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
    });
    const timer = setTimeout(() => fail(new Error("upstream_timeout")), timeoutMs);
    const onAbort = (): void => fail(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    function fail(error: Error): void {
      done();
      socket.destroy();
      reject(error);
    }
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerX509Certificate();
      if (!certificate || normalizeFingerprint(certificate.fingerprint256) !== normalizeFingerprint(target.fingerprint)) {
        fail(new PinRejectedError());
        return;
      }
      done();
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

/** 핀 검증을 마친 소켓 위에서 요청 하나를 보내고 응답 머리를 돌려준다. 본문은 호출자가 소비한다. */
export async function pinnedRequest(target: PinnedTarget, request: PinnedRequest): Promise<http.IncomingMessage> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await connectPinned(target, request.signal, timeoutMs);
  return await new Promise((resolve, reject) => {
    const authority = target.port === 443 ? target.hostname : `${target.hostname}:${target.port}`;
    const outgoing = https.request({
      method: request.method,
      path: request.path,
      headers: { ...request.headers, host: authority },
      // agent를 두지 않아야 createConnection이 쓰인다. `agent: false`면 Node가 새 Agent를 만들어 이 함수를
      // 건너뛰고 기본 호스트로 핀 없는 연결을 따로 연다 — 세션 쿠키가 검증되지 않은 소켓으로 나간다.
      createConnection: () => socket,
    });
    const timer = setTimeout(() => outgoing.destroy(new Error("upstream_timeout")), timeoutMs);
    const onAbort = (): void => { outgoing.destroy(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted")); };
    request.signal.addEventListener("abort", onAbort, { once: true });
    outgoing.on("response", (response) => {
      clearTimeout(timer);
      // 응답 머리가 온 뒤에도 abort는 소켓째 끊는다 — 스트림이 epoch보다 오래 살지 않는다.
      response.once("close", () => request.signal.removeEventListener("abort", onAbort));
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.destroy();
        reject(new Error("upstream_redirect"));
        return;
      }
      resolve(response);
    });
    outgoing.on("error", (error) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    outgoing.end(request.body);
  });
}

/** 응답 본문을 한도 안에서 모두 읽는다. 넘치면 소켓을 끊고 실패한다. */
export function readBounded(response: http.IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        response.destroy();
        reject(new Error("upstream_body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => resolve(Buffer.concat(chunks)));
    response.once("error", reject);
    response.once("aborted", () => reject(new Error("upstream_aborted")));
  });
}
