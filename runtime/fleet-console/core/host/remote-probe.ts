import net from "node:net";
import tls from "node:tls";

import { normalizeFingerprint } from "./access-link.js";

const REMOTE_PROBE_TIMEOUT_MS = 6_000;

export type RemoteProbeResult =
  | { readonly state: "match" }
  | { readonly state: "mismatch"; readonly presented: string }
  | { readonly state: "unreachable" };

/**
 * 호스트를 목록에 들이기 전에, 그 주소가 정말 그 인증서를 내미는지 우리가 직접 확인한다.
 *
 * 체인 검증은 끄고 제시된 인증서만 읽는다 — 자체서명이라 체인은 애초에 성립하지 않고, 우리가
 * 믿는 근거는 링크가 실어 온 지문 하나뿐이기 때문이다. 여기서 어긋나면 링크가 낡았거나 주소가
 * 다른 기계를 가리키고 있다는 뜻이고, 어느 쪽이든 자격을 보내서는 안 된다.
 */
export function probeRemoteIdentity(hostname: string, port: number, expected: string, timeoutMs = REMOTE_PROBE_TIMEOUT_MS): Promise<RemoteProbeResult> {
  return new Promise((resolve) => {
    const settle = (result: RemoteProbeResult): void => {
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect({
      host: hostname,
      port,
      rejectUnauthorized: false,
      // IP 리터럴에는 SNI를 붙이지 않는다 — 규격상 SNI는 이름에만 쓴다.
      ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, () => {
      const certificate = socket.getPeerX509Certificate();
      if (!certificate) {
        settle({ state: "unreachable" });
        return;
      }
      const presented = normalizeFingerprint(certificate.fingerprint256);
      settle(presented === normalizeFingerprint(expected) ? { state: "match" } : { state: "mismatch", presented });
    });
    socket.setTimeout(timeoutMs, () => settle({ state: "unreachable" }));
    socket.on("error", () => settle({ state: "unreachable" }));
  });
}
