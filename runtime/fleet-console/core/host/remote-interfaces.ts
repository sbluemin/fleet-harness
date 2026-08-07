import os from "node:os";

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
      candidates.push({ kind, label: kind === "tailscale" ? "Tailscale" : labelFor(name), address: entry.address });
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
  return /^(?:en|eth|wl|wlan)/u.test(interfaceName) ? "Local network" : `Local network (${sanitizeName(interfaceName)})`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 24) || "interface";
}
