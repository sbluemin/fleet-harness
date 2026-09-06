import { describe, expect, it } from "vitest";

import { createRemoteJoinGuard, normalizeRemoteJoinSource } from "../core/host/remote-join-guard.js";

function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

/** begin -> settle 한 쌍을 한 줄로 — 실제 호출 순서를 테스트에서 흉내 내지 않으면 in-flight가 새어 나간다. */
function attempt(guard: ReturnType<typeof createRemoteJoinGuard>, source: string, outcome: "paired" | "rejected"): string {
  const verdict = guard.begin(source);
  if (verdict === "ok") guard.settle(source, outcome);
  return verdict;
}

describe("remote join failure budget", () => {
  it("spends the budget on failures only", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 3, windowMs: 60_000 });

    // 성공은 아무리 반복해도 예산을 쓰지 않는다 — 정상 페어링은 벌 대상이 아니다.
    for (let i = 0; i < 20; i += 1) expect(attempt(guard, "203.0.113.5", "paired")).toBe("ok");

    expect(attempt(guard, "203.0.113.5", "rejected")).toBe("ok");
    expect(attempt(guard, "203.0.113.5", "rejected")).toBe("ok");
    expect(attempt(guard, "203.0.113.5", "rejected")).toBe("ok");
    expect(guard.begin("203.0.113.5")).toBe("throttled");
  });

  it("caps concurrent attempts so a distributed flood cannot pile up", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 100, windowMs: 60_000, concurrency: 2 });

    // 각기 다른 출처라 출처별 예산은 걸리지 않는다 — 그 바닥을 받치는 것이 동시 상한이다.
    expect(guard.begin("a")).toBe("ok");
    expect(guard.begin("b")).toBe("ok");
    expect(guard.begin("c")).toBe("busy");

    guard.settle("a", "rejected");
    expect(guard.begin("c")).toBe("ok");
  });
});
