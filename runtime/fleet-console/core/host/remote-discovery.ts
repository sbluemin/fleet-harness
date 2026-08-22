// Finding a console to reach over the network: which local interfaces can host one,
// and whether the TLS identity at an address is the one the link promised.

import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { normalizeFingerprint } from "./access-link.js";

// ─── local interface candidates ────────────────────────────────────────────────

/**
 * 원격을 열 수 있는 주소 후보. 사용자가 IP를 외워 적게 하지 않으려면 이 기계가 실제로 가진
 * 주소를 골라 주어야 한다. 라벨은 그 주소가 어떤 망에 붙어 있는지를 말한다 — 100.64/10은
 * CGNAT 대역이고 Tailscale이 쓰는 곳이라, 사설망과 구분해 부르는 편이 고를 때 도움이 된다.
 */
export interface RemoteInterfaceCandidate {
  readonly kind: "tailscale" | "local";
  readonly label: string;
  readonly address: string;
}

interface NetworkAddress {
  readonly family: string;
  readonly internal: boolean;
  readonly address: string;
}

export function listRemoteInterfaces(interfaces: NodeJS.Dict<NetworkAddress[]> = os.networkInterfaces()): readonly RemoteInterfaceCandidate[] {
  const candidates: RemoteInterfaceCandidate[] = [];
  const seen = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || seen.has(entry.address)) continue;
      seen.add(entry.address);
      const kind = isCarrierGradeNat(entry.address) ? "tailscale" : "local";
      candidates.push({ kind, label: kind === "tailscale" ? `Tailscale (${sanitizeName(name)})` : labelFor(name), address: entry.address });
    }
  }
  // Tailscale을 먼저 — 그 주소는 어디서든 닿고, 사설망 주소는 같은 망에서만 닿는다.
  return candidates.sort((left, right) => (left.kind === right.kind ? left.address.localeCompare(right.address) : left.kind === "tailscale" ? -1 : 1));
}

/** 100.64.0.0/10. Tailscale이 노드에 나눠 주는 대역이다. */
function isCarrierGradeNat(address: string): boolean {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127;
}

function labelFor(interfaceName: string): string {
  return `Local network (${sanitizeName(interfaceName)})`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 24) || "interface";
}

// ─── TLS identity probe ────────────────────────────────────────────────────────

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
