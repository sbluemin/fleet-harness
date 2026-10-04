import { performance } from "node:perf_hooks";

import type { ConsoleHealth, ConsoleLockPayload } from "../transport/console-contract-types.js";

export interface ConsoleProbeResult {
  readonly healthy: boolean;
  readonly lock: ConsoleLockPayload | null;
  readonly health?: ConsoleHealth;
  readonly error?: string;
  /** 인증된 health의 초기화 안내. 기다릴 이유일 뿐 healthy나 신호 권한은 아니다. */
  readonly starting?: true;
  /** endpoint가 연결을 거절했다 — 그 주소에서 아무 프로세스도 듣고 있지 않다는 확정 신호다. */
  readonly refused?: true;
}

export interface ConsoleHealthDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface ConsoleProbeOptions {
  /** primary와 legacy probe가 함께 나눠 쓰는 전체 시간 예산. */
  readonly timeoutMs?: number;
  /** 호출자의 수명주기가 끝나면 현재 endpoint 요청도 함께 중단한다. */
  readonly signal?: AbortSignal;
}

const HEALTH_TIMEOUT_MS = 5_000;

export function createConsoleHealthClient(deps: ConsoleHealthDeps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());

  async function probe(lock: ConsoleLockPayload | null, options: ConsoleProbeOptions = {}): Promise<ConsoleProbeResult> {
    if (!lock) return { healthy: false, lock: null, error: "lock missing" };
    const deadline = options.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : now() + Math.max(0, options.timeoutMs);
    // 신규 /api/v1/health를 우선 확인하되, 레거시 /health만 서빙하는 구버전 데몬을 업그레이드 중 probe할 때
    // 신규 경로가 없어 unhealthy로 오판되는 것을 막기 위해 레거시 /health로 폴백한다.
    // 이 오판은 ensureDaemon이 workspaceCount>0 보호를 건너뛰고 활성 데몬을 종료시키는 회귀로 이어진다.
    const primary = await probeEndpoint(`${lock.endpoint}api/v1/health`, lock, remainingBudget(deadline), options.signal);
    if (primary.healthy || primary.starting || options.signal?.aborted) return primary;
    const remaining = remainingBudget(deadline);
    if (remaining <= 0) return primary;
    const legacy = await probeEndpoint(`${lock.endpoint}health`, lock, remaining, options.signal);
    if (legacy.healthy) return legacy;
    // 재사용된 keep-alive 소켓이 먼저 끊김으로 실패해도, 뒤이은 새 연결의 거절이 "아무도 듣지 않음"의 최신 증거다.
    return legacy.refused ? { ...primary, refused: true } : primary;
  }

  async function probeEndpoint(
    url: string,
    lock: ConsoleLockPayload,
    budgetMs: number,
    callerSignal?: AbortSignal,
  ): Promise<ConsoleProbeResult> {
    const timeoutMs = Math.min(HEALTH_TIMEOUT_MS, budgetMs);
    if (callerSignal?.aborted) return { healthy: false, lock, error: "health check aborted" };
    if (timeoutMs <= 0) return { healthy: false, lock, error: "health check timed out" };
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeCallerAbort: (() => void) | undefined;
    const request = (async (): Promise<ConsoleProbeResult> => {
      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${lock.token}` },
          signal: controller.signal,
        });
        if (res.status === 503) {
          const body = await res.json().catch(() => null) as { error?: unknown; pid?: unknown } | null;
          if (body?.error === "console_starting" && body.pid === lock.pid) {
            return { healthy: false, lock, starting: true, error: "console_starting" };
          }
        }
        if (!res.ok) return { healthy: false, lock, error: `health failed: ${res.status}` };
        return { healthy: true, lock, health: await res.json() as ConsoleHealth };
      } catch (err) {
        const refused = (err as { cause?: { code?: unknown } } | null)?.cause?.code === "ECONNREFUSED";
        return { healthy: false, lock, error: err instanceof Error ? err.message : String(err), ...(refused ? { refused: true as const } : {}) };
      }
    })();
    try {
      const timedOut = new Promise<ConsoleProbeResult>((resolve) => {
        timeout = setTimeout(() => {
          resolve({ healthy: false, lock, error: "health check timed out" });
          controller.abort();
        }, timeoutMs);
      });
      const interrupted = new Promise<ConsoleProbeResult>((resolve) => {
        if (!callerSignal) return;
        const onAbort = (): void => {
          resolve({ healthy: false, lock, error: "health check aborted" });
          controller.abort();
        };
        callerSignal.addEventListener("abort", onAbort, { once: true });
        removeCallerAbort = () => callerSignal.removeEventListener("abort", onAbort);
        if (callerSignal.aborted) onAbort();
      });
      return await Promise.race([request, timedOut, interrupted]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeCallerAbort?.();
    }
  }

  return { probe };

  function remainingBudget(deadline: number): number {
    return Number.isFinite(deadline)
      ? Math.max(0, deadline - now())
      : HEALTH_TIMEOUT_MS;
  }
}
