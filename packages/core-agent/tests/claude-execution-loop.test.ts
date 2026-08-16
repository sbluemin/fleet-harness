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

  it("disposes a late SDK when disposal wins the creation race", async () => {
    const created = deferred<ClaudeGatewaySdk>();
    const sdk = fakeSdk();
    const loop = makeLoop({ createSdk: () => created.promise });
    const starting = loop.start();
    const disposing = loop.dispose();
    created.resolve(sdk);
    await expect(starting).rejects.toThrow("Session disposed");
    await disposing;
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("rejects run before start, after dispose, and on a blank prompt", async () => {
    const loop = makeLoop();
    await expect(loop.run("hello")).rejects.toThrow("Session not started");
    await loop.start();
    await expect(loop.run("")).rejects.toThrow("Message required");
    await expect(loop.run("   \n\t")).rejects.toThrow("Message required");
    await loop.dispose();
    await expect(loop.run("hello")).rejects.toThrow("Session disposed");
    await expect(loop.start()).rejects.toThrow("Session disposed");
  });
});

describe("createClaudeExecutionLoop queue", () => {
  it("runs queued prompts in call order", async () => {
    const order: string[] = [];
    const firstTurn = deferred<void>();
    const sdk = fakeSdk({
      startTurn: async (turn) => {
        order.push(turn.prompt);
        if (turn.prompt === "first") await firstTurn.promise;
        return immediateRun([resultMessage()]);
      },
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const first = loop.run("first");
    const second = loop.run("second");
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    firstTurn.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    await loop.dispose();
  });

  it("lets a later queued turn run after an earlier turn fails", async () => {
    const sdk = fakeSdk({
      startTurn: async (turn) => {
        if (turn.prompt === "bad") throw new Error("boom");
        return immediateRun([resultMessage()]);
      },
    });
    const events: ClaudeExecutionEvent[] = [];
    const loop = makeLoop({ createSdk: async () => sdk, onEvent: (event) => events.push(event) });
    await loop.start();
    await expect(loop.run("bad")).rejects.toThrow("boom");
    await loop.run("good");
    expect(events).toEqual([{ kind: "result", isError: false, source: "message" }]);
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

  it("neither captures nor forwards resume in oneshot mode", async () => {
    const sdk = fakeSdk({
      startTurn: async () => immediateRun([
        { type: "system", subtype: "init", session_id: "child-session" },
        resultMessage(),
      ]),
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      continuation: { kind: "oneshot" },
    });
    await loop.start();
    await loop.run("first");
    await loop.run("second");
    expect(sdk.startTurn.mock.calls[0]?.[0].resume).toBeUndefined();
    expect(sdk.startTurn.mock.calls[1]?.[0].resume).toBeUndefined();
    await loop.dispose();
  });

  it("ignores a late session_id from a canceled turn after a newer turn has started", async () => {
    const abandoned = hangFirstNext();
    const live = hangUntilReleasedThenMessages([
      { type: "system", subtype: "init", session_id: "live" },
      resultMessage(),
    ]);
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "old") return abandoned;
      if (turn.prompt === "new") return live;
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      continuation: { kind: "resume-child" },
    });
    await loop.start();
    const first = loop.run("old");
    await abandoned.started;
    loop.cancel();
    await first;
    expect(abandoned.close).toHaveBeenCalledOnce();

    const second = loop.run("new");
    await live.started;
    expect(sdk.startTurn.mock.calls[1]?.[0].resume).toBeUndefined();

    abandoned.releaseNext({ type: "system", subtype: "init", session_id: "abandoned" });
    await Promise.resolve();
    await Promise.resolve();
    expect(live.close).not.toHaveBeenCalled();
    expect(runs[1]?.close).not.toHaveBeenCalled();

    live.release();
    await second;
    await loop.run("later");
    expect(sdk.startTurn.mock.calls[2]?.[0].resume).toBe("live");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["old", "new", "later"]);
    expect(abandoned.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("rejects a builder result that carries prompt or resume", async () => {
    const sdk = fakeSdk();
    const loop = makeLoop({
      createSdk: async () => sdk,
      buildTurn: (prompt) => {
        if (prompt === "prompt-key") return { model: "sonnet", prompt: "stolen" } as ClaudeExecutionTurn;
        if (prompt === "resume-key") return { model: "sonnet", resume: "hijack" } as ClaudeExecutionTurn;
        return { model: "sonnet" };
      },
    });
    await loop.start();
    await expect(loop.run("prompt-key")).rejects.toThrow(/loop-owned/);
    await expect(loop.run("resume-key")).rejects.toThrow(/loop-owned/);
    expect(sdk.startTurn).not.toHaveBeenCalled();
    await loop.run("ok");
    expect(sdk.startTurn).toHaveBeenCalledOnce();
    await loop.dispose();
  });
});

describe("createClaudeExecutionLoop settlement", () => {
  it("forwards decoded events in order from a decoder isolated to the turn", async () => {
    const sdk = fakeSdk({
      startTurn: async (turn) => {
        if (turn.prompt === "one") {
          return immediateRun([
            textDelta("hi"),
            {
              type: "assistant",
              message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { q: 1 } }] },
            },
            resultMessage(),
          ]);
        }
        return immediateRun([
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
          resultMessage("done"),
        ]);
      },
    });
    const events: ClaudeExecutionEvent[] = [];
    const loop = makeLoop({ createSdk: async () => sdk, onEvent: (event) => events.push(event) });
    await loop.start();
    await loop.run("one");
    await loop.run("two");
    expect(events).toEqual([
      { kind: "text", text: "hi" },
      { kind: "tool-start", id: "t1", name: "WebSearch", input: { q: 1 } },
      { kind: "result", isError: false, source: "message" },
      { kind: "tool-end", id: "t1", isError: false },
      { kind: "result", isError: false, detail: "done", source: "message" },
    ]);
    await loop.dispose();
  });

  it("emits no synthetic result on clean EOF when settlement is result", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const sdk = fakeSdk({ startTurn: async () => immediateRun([textDelta("hi")]) });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result" },
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
    await loop.dispose();
  });

  it("emits incomplete when result-required EOFs without a result", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const sdk = fakeSdk({ startTurn: async () => immediateRun([textDelta("hi")]) });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required" },
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([
      { kind: "text", text: "hi" },
      { kind: "result", isError: true, source: "incomplete" },
    ]);
    await loop.dispose();
  });

  it("does not emit incomplete after a message result", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const sdk = fakeSdk({
      startTurn: async () => immediateRun([resultMessage(), textDelta("late")]),
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required" },
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "result", isError: false, source: "message" }]);
    await loop.dispose();
  });

  it("closes the active run once on a result and resolves without waiting for iterator EOF", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const hanging = resultThenHang();
    const sdk = fakeSdk({ startTurn: async () => hanging });
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "result", isError: false, source: "message" }]);
    expect(hanging.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("emits a message result once when run.close() throws and still resolves", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "hello") return resultThenThrowOnClose();
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "result", isError: false, source: "message" }]);
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    await loop.run("later");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["hello", "later"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(runs[0]?.close).toHaveBeenCalledOnce();
  });

  it("resolves a message result even when iterator.return() never settles", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const hanging = resultThenHangReturn();
    const sdk = fakeSdk({ startTurn: async () => hanging });
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "result", isError: false, source: "message" }]);
    expect(hanging.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("does not close a newer run when an old iterator.return() later settles", async () => {
    const old = resultThenHangReturn();
    const next = hangPastClose();
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "old") return old;
      return next;
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    await loop.run("old");
    expect(old.close).toHaveBeenCalledOnce();
    const later = loop.run("new");
    await next.started;
    expect(next.close).not.toHaveBeenCalled();
    old.releaseReturn();
    await Promise.resolve();
    await Promise.resolve();
    expect(next.close).not.toHaveBeenCalled();
    expect(runs[1]?.close).not.toHaveBeenCalled();
    loop.cancel();
    await later;
    expect(next.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("emits only the result when later text and an iterator error are already buffered", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const sdk = fakeSdk({
      startTurn: async () => immediateRun(
        [resultMessage(), textDelta("late")],
        new Error("late"),
      ),
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "result", isError: false, source: "message" }]);
    await loop.dispose();
  });

  it("emits watchdog exactly once and ignores a later iterator error", async () => {
    vi.useFakeTimers();
    const events: ClaudeExecutionEvent[] = [];
    const hanging = hangingRun({ throwOnClose: true });
    const sdk = fakeSdk({ startTurn: async () => hanging });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required", watchdogMs: 1_000 },
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    const running = loop.run("hello");
    await hanging.started;
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    expect(events).toEqual([{ kind: "result", isError: true, source: "watchdog" }]);
    expect(hanging.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("rejects run with a watchdog onEvent throw and still closes the SDK slot once", async () => {
    vi.useFakeTimers();
    const hanging = hangingRun({ throwOnClose: true });
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "hello") return hanging;
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required", watchdogMs: 1_000 },
      onEvent: (event) => {
        if (event.kind === "result" && event.source === "watchdog") {
          throw new Error("watchdog listener failed");
        }
      },
    });
    await loop.start();
    const running = loop.run("hello");
    await hanging.started;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hanging.close).toHaveBeenCalledOnce();
    await expect(running).rejects.toThrow("watchdog listener failed");
    await loop.run("later");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["hello", "later"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("resolves a nonthrowing watchdog without waiting for iterator EOF", async () => {
    vi.useFakeTimers();
    const events: ClaudeExecutionEvent[] = [];
    const hanging = hangPastClose();
    const sdk = fakeSdk({ startTurn: async () => hanging });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required", watchdogMs: 1_000 },
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    const running = loop.run("hello");
    await hanging.started;
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    expect(events).toEqual([{ kind: "result", isError: true, source: "watchdog" }]);
    expect(hanging.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("rejects a watchdog observer throw without waiting for iterator EOF", async () => {
    vi.useFakeTimers();
    const hanging = hangPastClose();
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "hello") return hanging;
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required", watchdogMs: 1_000 },
      onEvent: (event) => {
        if (event.kind === "result" && event.source === "watchdog") {
          throw new Error("watchdog listener failed");
        }
      },
    });
    await loop.start();
    const running = loop.run("hello");
    await hanging.started;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hanging.close).toHaveBeenCalledOnce();
    await expect(running).rejects.toThrow("watchdog listener failed");
    await loop.run("later");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["hello", "later"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("rejects a message-result observer throw and still closes the SDK slot once", async () => {
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "bad") return immediateRun([resultMessage("ok")]);
      return immediateRun([resultMessage()]);
    });
    let failed = false;
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => {
        if (!failed && event.kind === "result" && event.source === "message") {
          failed = true;
          throw new Error("result listener failed");
        }
      },
    });
    await loop.start();
    await expect(loop.run("bad")).rejects.toThrow("result listener failed");
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    await loop.run("good");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["bad", "good"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("rejects an incomplete observer throw and still closes the SDK slot once", async () => {
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "bad") return immediateRun([textDelta("hi")]);
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required" },
      onEvent: (event) => {
        if (event.kind === "result" && event.source === "incomplete") {
          throw new Error("incomplete listener failed");
        }
      },
    });
    await loop.start();
    await expect(loop.run("bad")).rejects.toThrow("incomplete listener failed");
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    await loop.run("good");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["bad", "good"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("does not arm a watchdog for non-positive delays", async () => {
    vi.useFakeTimers();
    const hanging = hangingRun();
    const sdk = fakeSdk({ startTurn: async () => hanging });
    const loop = makeLoop({
      createSdk: async () => sdk,
      settlement: { kind: "result-required", watchdogMs: 0 },
    });
    await loop.start();
    const running = loop.run("hello");
    await hanging.started;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hanging.close).not.toHaveBeenCalled();
    hanging.close();
    await running;
    await loop.dispose();
  });

  it("rejects an iterator failure before a terminal result, once", async () => {
    const sdk = fakeSdk({
      startTurn: async () => immediateRun([], new Error("stream died")),
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    await expect(loop.run("hello")).rejects.toThrow("stream died");
    await loop.dispose();
  });

  it("does not reject a later iterator error after a terminal result", async () => {
    const events: ClaudeExecutionEvent[] = [];
    const sdk = fakeSdk({
      startTurn: async () => immediateRun([resultMessage("ok")], new Error("late")),
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("hello");
    expect(events).toEqual([{ kind: "result", isError: false, detail: "ok", source: "message" }]);
    await loop.dispose();
  });
});

describe("createClaudeExecutionLoop cancel and dispose", () => {
  it("remembers cancellation while startTurn is pending and leaves the queued turn untouched", async () => {
    const starting = deferred<ClaudeGatewayRun>();
    const canceled = immediateRun([textDelta("late"), resultMessage()]);
    const sdk = fakeSdk({
      startTurn: async (turn) => turn.prompt === "one"
        ? starting.promise
        : immediateRun([resultMessage("next")]),
    });
    const events: ClaudeExecutionEvent[] = [];
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    const first = loop.run("one");
    const queued = loop.run("two");
    await vi.waitFor(() => expect(sdk.startTurn).toHaveBeenCalledOnce());
    loop.cancel();
    starting.resolve(canceled);
    await Promise.all([first, queued]);
    expect(canceled.close).toHaveBeenCalledOnce();
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["one", "two"]);
    expect(events).toEqual([
      { kind: "result", isError: false, detail: "next", source: "message" },
    ]);
    await loop.dispose();
  });

  it("does not let an idle cancel preempt the next turn", async () => {
    const sdk = fakeSdk();
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    loop.cancel();
    await loop.run("one");
    expect(sdk.startTurn).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("keeps cancellation quiet when a pending startTurn rejects", async () => {
    const starting = deferred<ClaudeGatewayRun>();
    const sdk = fakeSdk({ startTurn: async () => starting.promise });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const running = loop.run("one");
    await vi.waitFor(() => expect(sdk.startTurn).toHaveBeenCalledOnce());
    loop.cancel();
    starting.reject(new Error("start failed after cancel"));
    await expect(running).resolves.toBeUndefined();
    await loop.dispose();
  });

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

  it("resolves cancel without waiting for iterator cleanup", async () => {
    const hanging = neverUnblockOnClose();
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "one") return hanging;
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const running = loop.run("one");
    await hanging.started;
    loop.cancel();
    loop.cancel();
    await running;
    expect(hanging.close).toHaveBeenCalledOnce();
    await loop.run("two");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["one", "two"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
  });

  it("cancels quietly when run.close() throws", async () => {
    const hanging = neverUnblockOnClose({ throwFromClose: true });
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "one") return hanging;
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const running = loop.run("one");
    await hanging.started;
    loop.cancel();
    loop.cancel();
    await running;
    expect(hanging.close).toHaveBeenCalledOnce();
    await loop.run("two");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["one", "two"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
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

  it("disposes without waiting for iterator cleanup", async () => {
    const hanging = neverUnblockOnClose();
    const startTurn = vi.fn(async (turn: ClaudeGatewayTurn) => {
      if (turn.prompt === "active") return hanging;
      return immediateRun([resultMessage()]);
    });
    const sdk = fakeSdk({ startTurn });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const first = loop.run("active");
    const queued = loop.run("queued");
    await hanging.started;
    await loop.dispose();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["active"]);
    expect(hanging.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("disposes quietly when run.close() throws", async () => {
    const hanging = neverUnblockOnClose({ throwFromClose: true });
    const startTurn = vi.fn(async (turn: ClaudeGatewayTurn) => {
      if (turn.prompt === "active") return hanging;
      return immediateRun([resultMessage()]);
    });
    const sdk = fakeSdk({ startTurn });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const first = loop.run("active");
    const queued = loop.run("queued");
    await hanging.started;
    await loop.dispose();
    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["active"]);
    expect(hanging.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(hanging.close).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it("closes once after an iterator failure so a queued turn can occupy the SDK slot", async () => {
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "bad") return immediateRun([textDelta("hi")], new Error("stream died"));
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const failed = loop.run("bad");
    const queued = loop.run("good");
    await expect(failed).rejects.toThrow("stream died");
    await queued;
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["bad", "good"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("rejects a synchronous asyncIterator factory throw, closes once, and runs a later queued turn", async () => {
    const factoryError = new Error("iterator factory failed");
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "bad") return throwingIteratorFactory(factoryError);
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const failed = loop.run("bad");
    const queued = loop.run("good");
    await expect(failed).rejects.toBe(factoryError);
    await queued;
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["bad", "good"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("closes once after a nonterminal onEvent throw so a later turn can occupy the SDK slot", async () => {
    const { sdk, runs } = exclusiveSdk((turn) => {
      if (turn.prompt === "bad") return immediateRun([textDelta("hi"), resultMessage()]);
      return immediateRun([resultMessage()]);
    });
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => {
        if (event.kind === "text") throw new Error("listener failed");
      },
    });
    await loop.start();
    await expect(loop.run("bad")).rejects.toThrow("listener failed");
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    await loop.run("good");
    expect(sdk.startTurn).toHaveBeenCalledTimes(2);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
  });

  it("closes once on clean EOF so the next turn can occupy the SDK slot", async () => {
    const { sdk, runs } = exclusiveSdk(() => immediateRun([textDelta("hi")]));
    const events: ClaudeExecutionEvent[] = [];
    const loop = makeLoop({
      createSdk: async () => sdk,
      onEvent: (event) => events.push(event),
    });
    await loop.start();
    await loop.run("first");
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    await loop.run("second");
    expect(sdk.startTurn.mock.calls.map((call) => call[0].prompt)).toEqual(["first", "second"]);
    expect(runs[1]?.close).toHaveBeenCalledOnce();
    await loop.dispose();
    expect(runs[0]?.close).toHaveBeenCalledOnce();
    expect(runs[1]?.close).toHaveBeenCalledOnce();
  });

  it("suppresses a startTurn failure once dispose has begun", async () => {
    const startTurnGate = deferred<void>();
    const sdk = fakeSdk({
      startTurn: async () => {
        await startTurnGate.promise;
        throw new Error("sdk went away");
      },
    });
    const loop = makeLoop({ createSdk: async () => sdk });
    await loop.start();
    const running = loop.run("hello");
    await vi.waitFor(() => expect(sdk.startTurn).toHaveBeenCalled());
    const disposing = loop.dispose();
    startTurnGate.resolve();
    await expect(running).resolves.toBeUndefined();
    await disposing;
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
