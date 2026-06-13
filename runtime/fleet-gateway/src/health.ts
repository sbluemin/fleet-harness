import type { GatewayHealth, GatewayLockPayload } from "./api-types.js";

export interface GatewayProbeResult {
  readonly healthy: boolean;
  readonly lock: GatewayLockPayload | null;
  readonly health?: GatewayHealth;
  readonly error?: string;
}

export interface GatewayHealthDeps {
  readonly fetch?: typeof fetch;
}

const HEALTH_TIMEOUT_MS = 5_000;

export function createGatewayHealthClient(deps: GatewayHealthDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;

  async function probe(lock: GatewayLockPayload | null): Promise<GatewayProbeResult> {
    if (!lock) return { healthy: false, lock: null, error: "lock missing" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`http://${lock.host}:${lock.port}/health`, {
        headers: { Authorization: `Bearer ${lock.token}` },
        signal: controller.signal,
      });
      if (!res.ok) return { healthy: false, lock, error: `health failed: ${res.status}` };
      return { healthy: true, lock, health: await res.json() as GatewayHealth };
    } catch (err) {
      return { healthy: false, lock, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { probe };
}
