import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPendingInitialInputQueue } from "../../fleet-plugins/terminal/server/agent-api/pending-initial-input.js";
import type { TerminalRuntime } from "../../fleet-plugins/terminal/server/shared/runtime.js";

function createFakeRuntime(): {
  readonly runtime: TerminalRuntime;
  readonly writes: Array<{ readonly sessionId: string; readonly data: string }>;
  emitOutput(sessionId: string): void;
} {
  const writes: Array<{ readonly sessionId: string; readonly data: string }> = [];
  const outputListeners = new Set<(sessionId: string) => void>();

  const runtime = {
    write: (sessionId: string, data: string) => {
      writes.push({ sessionId, data });
      return true;
    },
    subscribeOutput: (listener: (sessionId: string) => void) => {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },
    // 사용되지 않는 TerminalRuntime 메서드 — 타입 충족용 스텁
    handleUpgrade: () => undefined as never,
    issueTicket: () => ({ ticket: "", ttlMs: 0 }),
    canAttach: () => true,
    attach: async () => undefined,
    terminate: () => false,
    getMessagePolicy: () => undefined,
    getRenameCommand: () => undefined,
    getScrollbackTail: () => [],
    onExit: () => () => undefined,
    registerLaunchResolver: () => () => undefined,
    stop: async () => undefined,
  } as unknown as TerminalRuntime;

  return {
    runtime,
    writes,
    emitOutput: (sessionId) => {
      for (const listener of outputListeners) listener(sessionId);
    },
  };
}

describe("pending initial input queue (quiescence)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) 출력 정온 후 텍스트 write 다음 crMs 후 CR write", () => {
    const { runtime, writes, emitOutput } = createFakeRuntime();
    const queue = createPendingInitialInputQueue({ terminalRuntime: runtime, settleMs: 700, crMs: 250, maxWaitMs: 8_000 });

    queue.enqueue("s1", "hello");
    expect(writes).toHaveLength(0);

    // 출력 이벤트 발생 → settle 타이머 시작
    emitOutput("s1");
    expect(writes).toHaveLength(0);

    // settle 타이머 만료 → 텍스트 write
    vi.advanceTimersByTime(700);
    expect(writes).toEqual([{ sessionId: "s1", data: "hello" }]);

    // crMs 경과 → CR write
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([
      { sessionId: "s1", data: "hello" },
      { sessionId: "s1", data: "\r" },
    ]);
  });

  it("(b) 연속 출력 중에는 settle 타이머가 리셋되어 조기 flush 안 함", () => {
    const { runtime, writes, emitOutput } = createFakeRuntime();
    const queue = createPendingInitialInputQueue({ terminalRuntime: runtime, settleMs: 700, crMs: 250, maxWaitMs: 8_000 });

    queue.enqueue("s1", "prompt");

    // 600ms 간격으로 3번 출력 → settle 타이머 계속 리셋
    emitOutput("s1");
    vi.advanceTimersByTime(600);
    emitOutput("s1");
    vi.advanceTimersByTime(600);
    emitOutput("s1");
    vi.advanceTimersByTime(600);

    // 아직 settle 미만(마지막 출력 후 600ms 경과) — 미발화
    expect(writes).toHaveLength(0);

    // 마지막 출력 후 700ms 경과 → flush
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ sessionId: "s1", data: "prompt" });
  });

  it("(c) 출력이 없어도 maxWaitMs 초과 시 강제 flush", () => {
    const { runtime, writes } = createFakeRuntime();
    const queue = createPendingInitialInputQueue({ terminalRuntime: runtime, settleMs: 700, crMs: 250, maxWaitMs: 8_000 });

    queue.enqueue("s1", "forced");
    expect(writes).toHaveLength(0);

    // maxWait 경과 → 강제 flush
    vi.advanceTimersByTime(8_000);
    expect(writes).toEqual([{ sessionId: "s1", data: "forced" }]);

    // crMs 후 CR
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([
      { sessionId: "s1", data: "forced" },
      { sessionId: "s1", data: "\r" },
    ]);
  });

  it("(d) disarm 호출 시 타이머·리스너 정리 — 이후 아무것도 write하지 않음", () => {
    const { runtime, writes, emitOutput } = createFakeRuntime();
    const queue = createPendingInitialInputQueue({ terminalRuntime: runtime, settleMs: 700, crMs: 250, maxWaitMs: 8_000 });

    queue.enqueue("s1", "disarmed");
    emitOutput("s1");

    // settle 타이머 만료 전에 disarm
    vi.advanceTimersByTime(300);
    queue.disarm("s1");

    // settle 만료 시점 통과
    vi.advanceTimersByTime(700);
    // maxWait 통과
    vi.advanceTimersByTime(8_000);

    expect(writes).toHaveLength(0);
  });
});
