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

  it("clears a source's failures once it finally pairs", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 2, windowMs: 60_000 });

    attempt(guard, "198.51.100.7", "rejected");
    attempt(guard, "198.51.100.7", "paired");

    // 한 번 붙은 기기가 앞선 실패 때문에 다음에 막히면 안 된다.
    expect(attempt(guard, "198.51.100.7", "rejected")).toBe("ok");
    expect(attempt(guard, "198.51.100.7", "rejected")).toBe("ok");
    expect(guard.begin("198.51.100.7")).toBe("throttled");
  });

  it("forgets failures when the window passes", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 1, windowMs: 60_000 });

    attempt(guard, "203.0.113.9", "rejected");
    expect(guard.begin("203.0.113.9")).toBe("throttled");

    clock.advance(60_001);
    expect(attempt(guard, "203.0.113.9", "rejected")).toBe("ok");
  });

  it("keeps one source's budget out of another's", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 1, windowMs: 60_000 });

    attempt(guard, "203.0.113.1", "rejected");

    expect(guard.begin("203.0.113.1")).toBe("throttled");
    expect(attempt(guard, "203.0.113.2", "rejected")).toBe("ok");
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

  it("bounds its own table so the tracker is not itself an attack surface", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 1, windowMs: 60_000, sourceSlots: 4 });

    for (let i = 0; i < 200; i += 1) attempt(guard, `10.0.0.${i}`, "rejected");

    // 가장 오래된 칸부터 밀려났으므로 초기 출처는 다시 통과하고, 최근 출처는 여전히 막힌다.
    expect(guard.begin("10.0.0.0")).toBe("ok");
    guard.settle("10.0.0.0", "rejected");
    expect(guard.begin("10.0.0.199")).toBe("throttled");
  });

  it("reports every rejection so the owner is not left guessing", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 1, windowMs: 60_000 });

    expect(guard.stats()).toEqual({ count: 0, lastAt: null });

    attempt(guard, "203.0.113.4", "rejected");
    guard.begin("203.0.113.4");
    guard.begin("203.0.113.4");

    expect(guard.stats()).toEqual({ count: 2, lastAt: clock.now() });
  });

  it("answers how long a throttled source must wait", () => {
    const clock = fakeClock();
    const guard = createRemoteJoinGuard({ now: clock.now, failureLimit: 1, windowMs: 60_000 });

    attempt(guard, "203.0.113.6", "rejected");
    clock.advance(20_000);

    expect(guard.retryAfterSeconds("203.0.113.6")).toBe(40);
    expect(guard.retryAfterSeconds("203.0.113.99")).toBe(60);
  });
});

describe("remote join source normalization", () => {
  it("treats an IPv4-mapped address as the same source", () => {
    // 표기가 갈리면 한 출처가 예산을 두 번 받는다.
    expect(normalizeRemoteJoinSource("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeRemoteJoinSource("203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeRemoteJoinSource("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeRemoteJoinSource(undefined)).toBe("unknown");
    expect(normalizeRemoteJoinSource("")).toBe("unknown");
  });
});
