import { describe, expect, it, vi } from "vitest";

import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

import {
  createCarrierResultReminderRouter,
  createDelayedPtyWriter,
  formatCarrierResultReminderMessage,
  sanitizeCarrierResultReminder,
  type PtyInputChunk,
  type PtyWriteSink,
} from "../src/index.js";

describe("carrier result reminder router", () => {
  it("extracts only finalized events with system reminders", () => {
    const writes: string[] = [];
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    const unsubscribe = createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
      resolveSink() {
        return createArraySink(writes);
      },
    });

    expect(handlers).toHaveLength(1);
    handlers[0]?.(trackStatusEvent());
    handlers[0]?.(finalizedEvent("done"));

    expect(writes).toEqual(["done\r"]);
    unsubscribe();
    expect(handlers).toEqual([]);
  });

  it("applies host-resolved message policy when formatting reminder chunks", () => {
    const writes: string[] = [];
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        return createArraySink(writes);
      },
      resolvePolicy() {
        return { bracketedPaste: true, lineTerminator: "\r" };
      },
    });

    handlers[0]?.(finalizedEvent("done"));

    expect(writes).toEqual(["\x1b[200~done\x1b[201~\r"]);
  });

  it("applies an opt-in host delivery policy without changing the CLI profile", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
      createCarrierResultReminderRouter({
        streamRegister(handler) {
          handlers.push(handler);
          return () => undefined;
        },
        resolveSink: () => createArraySink(writes),
        resolvePolicy: () => ({ bracketedPaste: true, lineTerminator: "\r" }),
        resolveSessionKey: () => "session-1",
        delivery: { submitDelayMs: 250 },
      });

      handlers[0]?.(finalizedEvent("done"));
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["\x1b[200~done\x1b[201~"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["\x1b[200~done\x1b[201~", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores finalized events without a string systemReminder", () => {
    let resolveCount = 0;
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        resolveCount += 1;
        return createArraySink([]);
      },
    });

    handlers[0]?.(finalizedEvent(undefined));

    expect(resolveCount).toBe(0);
  });

  it("quietly drops blank reminders after sanitization", () => {
    let resolveCount = 0;
    const writes: string[] = [];
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        resolveCount += 1;
        return createArraySink(writes);
      },
    });

    handlers[0]?.(finalizedEvent(" \t\n\r\x07\x1b[201~ "));

    expect(resolveCount).toBe(0);
    expect(writes).toEqual([]);
  });

  it("removes terminal control chars while preserving input whitespace", () => {
    expect(sanitizeCarrierResultReminder("a\x00b\tc\nd\re\x7Ff\x9Fg")).toBe("ab\tc\nd\refg");
  });

  it("removes bracketed paste end markers", () => {
    expect(sanitizeCarrierResultReminder(`a\x1b[201~b\x9B201~c`)).toBe("abc");
  });

  it("returns formatter chunks in write order", () => {
    expect(formatCarrierResultReminderMessage({ bracketedPaste: true, lineTerminator: "\n" }, "hello", "darwin")).toEqual([
      { data: "\x1b[200~hello\x1b[201~\n" },
    ]);
    expect(formatCarrierResultReminderMessage({ multilineStrategy: "paste-mode" }, "a\nb", "darwin")).toEqual([
      { data: "\x1b[200~a\nb\x1b[201~\r" },
    ]);
    expect(formatCarrierResultReminderMessage({ lineTerminator: "\n" }, "hello", "darwin")).toEqual([{ data: "hello\n" }]);
  });

  it("splits payload and submit only when the host opts into delayed delivery", () => {
    const policy = { bracketedPaste: true, lineTerminator: "\r", multilineStrategy: "paste-mode" as const };

    expect(formatCarrierResultReminderMessage(policy, "hello", "darwin")).toEqual([
      { data: "\x1b[200~hello\x1b[201~\r" },
    ]);
    expect(formatCarrierResultReminderMessage(policy, "hello", "darwin", { submitDelayMs: 250 })).toEqual([
      { data: "\x1b[200~hello\x1b[201~" },
      { data: "\r", submitDelayMs: 250 },
    ]);
  });







  it("shares one delayed writer so reminder and rename on the same session serialize", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const writer = createDelayedPtyWriter();
      const delayed = (text: string): PtyInputChunk[] => [{ data: text }, { data: "\r", submitDelayMs: 250 }];

      // 서로 다른 소스(리마인더/rename)라도 같은 세션 키를 공유하면 순차 제출된다.
      writer.enqueue("session-1", (data) => { writes.push(data); }, delayed("reminder"));
      writer.enqueue("session-1", (data) => { writes.push(data); }, delayed("/rename X"));

      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["reminder"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["reminder", "\r", "/rename X"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["reminder", "\r", "/rename X", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not serialize delayed submits across different session keys", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const writer = createDelayedPtyWriter();
      const delayed = (text: string): PtyInputChunk[] => [{ data: text }, { data: "\r", submitDelayMs: 250 }];

      writer.enqueue("a", (data) => { writes.push(data); }, delayed("A"));
      writer.enqueue("b", (data) => { writes.push(data); }, delayed("B"));

      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["A", "B"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["A", "B", "\r", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a queued message when a PTY write returns false or throws", async () => {
    vi.useFakeTimers();
    try {
      const writer = createDelayedPtyWriter();
      const writes: string[] = [];
      const chunks: PtyInputChunk[] = [{ data: "payload" }, { data: "\r", submitDelayMs: 250 }];

      writer.enqueue("false-session", (data) => {
        writes.push(data);
        return false;
      }, chunks);
      writer.enqueue("throw-session", (data) => {
        writes.push(data);
        throw new Error("closed");
      }, chunks);

      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toEqual(["payload", "payload"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending and queued writes for one session", async () => {
    vi.useFakeTimers();
    try {
      const writer = createDelayedPtyWriter();
      const writes: string[] = [];
      const delayed = (text: string): PtyInputChunk[] => [{ data: text }, { data: "\r", submitDelayMs: 250 }];

      writer.enqueue("session-1", (data) => { writes.push(data); }, delayed("A"));
      writer.enqueue("session-1", (data) => { writes.push(data); }, delayed("B"));
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["A"]);

      writer.cancel("session-1");
      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toEqual(["A"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a fresh enqueue after cancellation", async () => {
    vi.useFakeTimers();
    try {
      const writer = createDelayedPtyWriter();
      const writes: string[] = [];
      const delayed = (text: string): PtyInputChunk[] => [{ data: text }, { data: "\r", submitDelayMs: 250 }];

      writer.enqueue("session-1", (data) => { writes.push(data); }, delayed("stale"));
      await vi.advanceTimersByTimeAsync(0);
      writer.cancel("session-1");
      writer.enqueue("session-1", (data) => { writes.push(data); }, delayed("fresh"));

      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["stale", "fresh"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["stale", "fresh", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending writes across all sessions", async () => {
    vi.useFakeTimers();
    try {
      const writer = createDelayedPtyWriter();
      const writes: string[] = [];
      const delayed = (text: string): PtyInputChunk[] => [{ data: text }, { data: "\r", submitDelayMs: 250 }];

      writer.enqueue("a", (data) => { writes.push(data); }, delayed("A"));
      writer.enqueue("b", (data) => { writes.push(data); }, delayed("B"));
      await vi.advanceTimersByTimeAsync(0);
      writer.cancelAll();
      await vi.advanceTimersByTimeAsync(500);

      expect(writes).toEqual(["A", "B"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quietly drops when no sink resolves", () => {
    const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
    createCarrierResultReminderRouter({
      streamRegister(handler) {
        handlers.push(handler);
        return () => undefined;
      },
      resolveSink() {
        return undefined;
      },
    });

    expect(() => handlers[0]?.(finalizedEvent("done"))).not.toThrow();
  });
});

function createArraySink(writes: string[]): PtyWriteSink {
  return {
    write(data) {
      writes.push(data);
    },
  };
}

function finalizedEvent(systemReminder: string | undefined): CarrierJobStreamEvent {
  return {
    type: "job:finalized",
    jobId: "job-1",
    status: "done",
    finishedAt: 1,
    summary: "summary",
    ...(systemReminder === undefined ? {} : { systemReminder }),
  };
}

function trackStatusEvent(): CarrierJobStreamEvent {
  return {
    type: "track:status",
    jobId: "job-1",
    trackId: "track-1",
    status: "stream",
  };
}
