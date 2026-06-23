import type { ConsoleHealth, ConsoleLockPayload } from "./api-types.js";

export interface ConsoleProbeResult {
  readonly healthy: boolean;
  readonly lock: ConsoleLockPayload | null;
  readonly health?: ConsoleHealth;
  readonly error?: string;
}

export interface ConsoleHealthDeps {
  readonly fetch?: typeof fetch;
}

const HEALTH_TIMEOUT_MS = 5_000;

export function createConsoleHealthClient(deps: ConsoleHealthDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;

  async function probe(lock: ConsoleLockPayload | null): Promise<ConsoleProbeResult> {
    if (!lock) return { healthy: false, lock: null, error: "lock missing" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${lock.endpoint}health`, {
        headers: { Authorization: `Bearer ${lock.token}` },
        signal: controller.signal,
      });
      if (!res.ok) return { healthy: false, lock, error: `health failed: ${res.status}` };
      return { healthy: true, lock, health: await res.json() as ConsoleHealth };
    } catch (err) {
      return { healthy: false, lock, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { probe };
}
