import { describe, expect, it, vi } from "vitest";

import { createDelegationIntentLedger } from "../../src/fleet/delegation-intent.js";
import { createExecutionAssignmentCache } from "../../src/fleet/execution-assignment.js";

/**
 * 위임 실행의 배정 상태. 두 가지가 실제 장애로 이어졌던 자리라 여기서 고정한다:
 * 배정은 실행 하나에 한 번이어야 하고(두 번째 요청·재시도에서 모델이 바뀌면 안 된다),
 * 상태의 범위는 Objective id가 아니라 SDK 세션 id여야 한다(두 세션이 같은 도구 호출 id를 갖는다).
 */
describe("delegated assignment state", () => {
  it("assigns once per run, shares the first in-flight decision, and retries a failed one", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const resolve = vi.fn(async ({ sessionId, agentId }: { sessionId: string; agentId: string }): Promise<{ modelId: string } | { error: string }> => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((settle) => { release = settle; });
      }
      return { modelId: `assigned-${sessionId}-${agentId}` };
    });
    const cache = createExecutionAssignmentCache({ resolve });

    const first = cache.assign({ sessionId: "s1", agentId: "a1" });
    const concurrent = cache.assign({ sessionId: "s1", agentId: "a1" });
    expect(resolve).toHaveBeenCalledTimes(1);
    release?.();
    expect(await first).toMatchObject({ modelId: "assigned-s1-a1" });
    expect(await concurrent).toMatchObject({ modelId: "assigned-s1-a1" });

    // 이후 요청은 판정을 다시 하지 않는다.
    expect(await cache.assign({ sessionId: "s1", agentId: "a1" })).toMatchObject({ modelId: "assigned-s1-a1" });
    expect(resolve).toHaveBeenCalledTimes(1);

    // 실패는 캐시하지 않는다 — 다음 요청이 다시 시도해 성공할 수 있다.
    resolve.mockImplementationOnce(async () => ({ error: "not yet matched" }));
    expect(await cache.assign({ sessionId: "s1", agentId: "a2" })).toMatchObject({ error: "not yet matched" });
    expect(await cache.assign({ sessionId: "s1", agentId: "a2" })).toMatchObject({ modelId: "assigned-s1-a2" });

    // 세션을 접으면 그 세션의 배정만 사라진다.
    cache.releaseSession("s1");
    expect(cache.size).toBe(0);
  });

  it("refuses new assignments over capacity instead of evicting a live one", async () => {
    let calls = 0;
    const cache = createExecutionAssignmentCache({
      maxAssignments: 1,
      resolve: async () => ({ modelId: `model-${++calls}` }),
    });
    expect(await cache.assign({ sessionId: "s1", agentId: "a1" })).toMatchObject({ modelId: "model-1" });
    expect(await cache.assign({ sessionId: "s2", agentId: "a2" })).toMatchObject({ error: expect.stringContaining("too many") });
    // 살아 있는 배정은 그대로다.
    expect(await cache.assign({ sessionId: "s1", agentId: "a1" })).toMatchObject({ modelId: "model-1" });
  });

  it("scopes the intent ledger by SDK session and refuses overflow without evicting", async () => {
    const ledger = createDelegationIntentLedger({ maxPending: 1, maxBound: 1 });
    expect(ledger.record({ sessionId: "s1", toolUseId: "call-1", subagentType: "fleet:execute" })).toBe(true);
    // 다른 세션의 같은 도구 호출 id는 별개다.
    expect(ledger.record({ sessionId: "s2", toolUseId: "call-1", subagentType: "fleet:execute" })).toBe(false);

    expect(ledger.bind({ sessionId: "s2", toolUseId: "call-1", taskId: "task-1" })).toBe(false);
    expect(ledger.bind({ sessionId: "s1", toolUseId: "call-1", taskId: "task-1" })).toBe(true);
    expect(await ledger.awaitIntent("s1", "task-1", 10)).toMatchObject({ sessionId: "s1" });
    expect(await ledger.awaitIntent("s2", "task-1", 10)).toBeUndefined();

    ledger.releaseSession("s1");
    expect(await ledger.awaitIntent("s1", "task-1", 10)).toBeUndefined();
    expect(ledger.size).toEqual({ pending: 0, bound: 0 });
  });
});
