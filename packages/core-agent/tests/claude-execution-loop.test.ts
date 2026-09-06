import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClaudeExecutionLoop,
  type ClaudeExecutionContinuation,
  type ClaudeExecutionEvent,
  type ClaudeExecutionLoopOptions,
  type ClaudeExecutionSettlement,
  type ClaudeExecutionTurn,
} from "../src/claude/index.js";
import type { ClaudeGatewayMessage, ClaudeGatewayRun, ClaudeGatewaySdk, ClaudeGatewayTurn } from "../src/claude/index.js";
import * as root from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("public boundary", () => {
  it("exports the loop and decoder only from the claude subpath", () => {
    expect("createClaudeExecutionLoop" in root).toBe(false);
    expect("createClaudeExecutionEventDecoder" in root).toBe(false);
  });
});

describe("createClaudeExecutionLoop lifecycle", () => {
  it("is start-idempotent and concurrent-call safe, creating one SDK", async () => {
    const created = deferred<ClaudeGatewaySdk>();
    const createSdk = vi.fn(() => created.promise);
    const loop = makeLoop({ createSdk });
    const first = loop.start();
    const second = loop.start();
    expect(createSdk).toHaveBeenCalledOnce();
    created.resolve(fakeSdk());
    await Promise.all([first, second]);
    await loop.start();
    expect(createSdk).toHaveBeenCalledOnce();
    await loop.dispose();
  });
});

describe("createClaudeExecutionLoop continuation", () => {
  it("resumes a child session only after observing the first session_id", async () => {
    const sdk = fakeSdk({
      startTurn: async () => immediateRun([
        { type: "system", subtype: "init", session_id: "child-session" },
        resultMessage(),
      ]),
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      continuation: { kind: "resume-child" },
    });
    await loop.start();
    await loop.run("first");
    await loop.run("second");
    expect(sdk.startTurn.mock.calls[0]?.[0].resume).toBeUndefined();
    expect(sdk.startTurn.mock.calls[1]?.[0].resume).toBe("child-session");
    expect(sdk.startTurn.mock.calls[0]?.[0].prompt).toBe("first");
    await loop.dispose();
  });
});

describe("createClaudeExecutionLoop cancel and dispose", () => {

  it("cancels only the active run and is safe to call repeatedly", async () => {
    const first = hangingRun();
    const second = hangingRun();
    const runs = [first, second];
    const sdk = fakeSdk({ startTurn: async () => runs.shift() ?? immediateRun([resultMessage()]) });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const running = loop.run("one");
    await first.started;
    loop.cancel();
    loop.cancel();
    await running;
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    const later = loop.run("two");
    await second.started;
    second.close();
    await later;
    expect(second.close).toHaveBeenCalled();
    await loop.dispose();
  });

  it("closes an active turn on dispose, skips queued turns, and disposes the SDK once", async () => {
    const active = hangingRun({ throwOnClose: true });
    const startTurn = vi.fn(async (turn: ClaudeGatewayTurn) => {
      if (turn.prompt === "active") return active;
      return immediateRun([resultMessage()]);
    });
    const sdk = fakeSdk({ startTurn });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const first = loop.run("active");
    const queued = loop.run("queued");
    await active.started;
    await loop.dispose();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["active"]);
    expect(active.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(active.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });
});

function makeLoop(overrides: Partial<ClaudeExecutionLoopOptions> = {}) {
  const continuation: ClaudeExecutionContinuation = overrides.continuation ?? { kind: "resume-child" };
  const settlement: ClaudeExecutionSettlement = overrides.settlement ?? { kind: "result" };
  return createClaudeExecutionLoop({
    createSdk: overrides.createSdk ?? (async () => fakeSdk()),
    buildTurn: overrides.buildTurn ?? (() => ({ model: "sonnet" })),
    continuation,
    settlement,
    ...(overrides.onEvent ? { onEvent: overrides.onEvent } : {}),
  });
}

function fakeSdk(overrides: {
  startTurn?: (turn: ClaudeGatewayTurn) => Promise<ClaudeGatewayRun>;
} = {}): ClaudeGatewaySdk & {
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly startTurn: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async () => undefined);
  const startTurn = vi.fn(overrides.startTurn ?? (async () => immediateRun([resultMessage()])));
  return {
    configDir: "/tmp/fake",
    models: ["sonnet"],
    startTurn,
    // 실행 루프는 턴 축만 쓴다 — 세션을 부르는 순간이 있다면 그것은 계약 위반이므로 던진다.
    openSession: async () => {
      throw new Error("the execution loop must not open a session");
    },
    dispose,
  };
}

type FakeRun = ClaudeGatewayRun & { readonly close: ReturnType<typeof vi.fn> };

/**
 * 실 SDK와 같이, 앞 턴의 close() 전에는 다음 startTurn을 거부한다.
 * next() 거절만으로는 슬롯이 풀리지 않는 계약을 테스트가 그대로 재현한다.
 */
function exclusiveSdk(createRun: (turn: ClaudeGatewayTurn) => FakeRun): {
  readonly sdk: ClaudeGatewaySdk & {
    readonly dispose: ReturnType<typeof vi.fn>;
    readonly startTurn: ReturnType<typeof vi.fn>;
  };
  readonly runs: FakeRun[];
} {
  let active: FakeRun | null = null;
  const runs: FakeRun[] = [];
  const sdk = fakeSdk({
    startTurn: async (turn) => {
      if (active !== null) {
        throw new Error("A turn is already running on this instance. Await it, or create another instance.");
      }
      const run = createRun(turn);
      const innerClose = run.close;
      const close = vi.fn(() => {
        if (active === run) active = null;
        innerClose();
      });
      Object.assign(run, { close });
      active = run;
      runs.push(run);
      return run;
    },
  });
  return { sdk, runs };
}

function throwingIteratorFactory(error: unknown): FakeRun {
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    [Symbol.asyncIterator](): AsyncIterator<ClaudeGatewayMessage> {
      throw error;
    },
  };
}

function resultThenThrowOnClose(error: unknown = new Error("close failed")): FakeRun {
  const close = vi.fn(() => {
    throw error;
  });
  return {
    close,
    getContextUsage: async () => null,
    async *[Symbol.asyncIterator]() {
      yield resultMessage();
    },
  };
}

function immediateRun(
  messages: readonly ClaudeGatewayMessage[],
  iterateError?: unknown,
): ClaudeGatewayRun & { readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
      if (iterateError !== undefined) throw iterateError;
    },
  };
}

function hangFirstNext(): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
  releaseNext(message: ClaudeGatewayMessage): void;
} {
  const started = deferred<void>();
  const nextGate = deferred<ClaudeGatewayMessage>();
  let yielded = false;
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    started: started.promise,
    releaseNext(message) {
      nextGate.resolve(message);
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          started.resolve();
          if (!yielded) {
            yielded = true;
            const value = await nextGate.promise;
            return { value, done: false };
          }
          return { value: undefined, done: true };
        },
        async return() {
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function hangUntilReleasedThenMessages(
  messages: readonly ClaudeGatewayMessage[],
): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
  release(): void;
} {
  const started = deferred<void>();
  const gate = deferred<void>();
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    started: started.promise,
    release() {
      gate.resolve();
    },
    async *[Symbol.asyncIterator]() {
      started.resolve();
      await gate.promise;
      for (const message of messages) yield message;
    },
  };
}

function resultThenHang(): ClaudeGatewayRun & { readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    async *[Symbol.asyncIterator]() {
      yield resultMessage();
      // close()가 이터레이터를 끝내지 않는다. 메시지 종점 뒤에 EOF를 기다리면 run()이 멈춘다.
      await new Promise(() => undefined);
    },
  };
}

/**
 * 생성기가 아니라 수동 이터레이터. 첫 next는 result를 주고 return()은 호출 측이 풀어 주기 전에는
 * 끝나지 않는다. 생성기 return()은 yield 자리에서 바로 끝나서 약한 가짜다.
 */
function resultThenHangReturn(): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  releaseReturn(): void;
} {
  let yielded = false;
  const returnGate = deferred<void>();
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    releaseReturn() {
      returnGate.resolve();
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!yielded) {
            yielded = true;
            return { value: resultMessage(), done: false };
          }
          await new Promise(() => undefined);
          return { value: undefined, done: true };
        },
        async return() {
          await returnGate.promise;
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** close()가 next/return 어느 쪽도 풀지 않는다. 취소·폐기가 EOF를 기다리면 멈춘다. */
function neverUnblockOnClose(options: { throwFromClose?: boolean } = {}): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
} {
  const started = deferred<void>();
  const close = vi.fn(() => {
    if (options.throwFromClose) throw new Error("close failed");
  });
  return {
    close,
    getContextUsage: async () => null,
    started: started.promise,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          started.resolve();
          await new Promise(() => undefined);
          return { value: undefined, done: true };
        },
        async return() {
          await new Promise(() => undefined);
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function hangPastClose(): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
} {
  const started = deferred<void>();
  const close = vi.fn();
  return {
    close,
    getContextUsage: async () => null,
    started: started.promise,
    async *[Symbol.asyncIterator]() {
      started.resolve();
      // close()가 이터레이터를 끝내지 않는다. 워치독 종점은 EOF를 기다리면 안 된다.
      await new Promise(() => undefined);
    },
  };
}

function hangingRun(options: { throwOnClose?: boolean } = {}): ClaudeGatewayRun & {
  readonly close: ReturnType<typeof vi.fn>;
  readonly started: Promise<void>;
} {
  let closed = false;
  const gate = deferred<void>();
  const started = deferred<void>();
  const close = vi.fn(() => {
    closed = true;
    gate.resolve();
  });
  return {
    close,
    getContextUsage: async () => null,
    started: started.promise,
    async *[Symbol.asyncIterator]() {
      started.resolve();
      if (!closed) await gate.promise;
      if (options.throwOnClose) throw new Error("run closed");
    },
  };
}

function resultMessage(result?: string): ClaudeGatewayMessage {
  return {
    type: "result",
    is_error: false,
    session_id: "child-session",
    ...(result === undefined ? {} : { result }),
  };
}

function textDelta(text: string): ClaudeGatewayMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
