import type { ConsoleHealth, ConsoleLockPayload } from "./console-contract-types.js";

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
    // 신규 /api/v1/health를 우선 확인하되, 레거시 /health만 서빙하는 구버전 데몬을 업그레이드 중 probe할 때
    // 신규 경로가 없어 unhealthy로 오판되는 것을 막기 위해 레거시 /health로 폴백한다.
    // 이 오판은 ensureDaemon이 workspaceCount>0 보호를 건너뛰고 활성 데몬을 종료시키는 회귀로 이어진다.
    const primary = await probeEndpoint(`${lock.endpoint}api/v1/health`, lock);
    if (primary.healthy) return primary;
    const legacy = await probeEndpoint(`${lock.endpoint}health`, lock);
    return legacy.healthy ? legacy : primary;
  }

  async function probeEndpoint(url: string, lock: ConsoleLockPayload): Promise<ConsoleProbeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
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
