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

  it("uses a delayed bare submit for ConPTY paste bursts on Windows", () => {
    const policy = { bracketedPaste: true, conptyPasteBurst: true, lineTerminator: "\r", multilineStrategy: "paste-mode" as const };
    const text = "line 1\nline 2";

    expect(formatCarrierResultReminderMessage(policy, text, "win32")).toEqual([
      { data: text },
      { data: "\r", submitDelayMs: 250 },
    ]);
  });

  it("writes the ConPTY submit after its delay without blocking finalized events", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
      createCarrierResultReminderRouter({
        platform: "win32",
        streamRegister(handler) {
          handlers.push(handler);
          return () => undefined;
        },
        resolveSink: () => createArraySink(writes),
        resolvePolicy: () => ({ bracketedPaste: true, conptyPasteBurst: true, lineTerminator: "\r", multilineStrategy: "paste-mode" }),
      });

      handlers[0]?.(finalizedEvent("line 1\nline 2"));

      expect(writes).toEqual(["line 1\nline 2"]);
      vi.advanceTimersByTime(249);
      expect(writes).toEqual(["line 1\nline 2"]);
      vi.advanceTimersByTime(1);
      expect(writes).toEqual(["line 1\nline 2", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes delayed ConPTY submits per session so concurrent reminders do not interleave", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const handlers: Array<(event: CarrierJobStreamEvent) => void> = [];
      createCarrierResultReminderRouter({
        platform: "win32",
        streamRegister(handler) {
          handlers.push(handler);
          return () => undefined;
        },
        resolveSink: () => createArraySink(writes),
        resolvePolicy: () => ({ bracketedPaste: true, conptyPasteBurst: true, lineTerminator: "\r", multilineStrategy: "paste-mode" }),
        resolveSessionKey: () => "session-1",
      });

      // 같은 세션으로 두 리마인더가 지연 창 안에 연달아 도착.
      handlers[0]?.(finalizedEvent("A"));
      handlers[0]?.(finalizedEvent("B"));

      // A의 텍스트만 먼저 기록되고, B는 A의 제출(CR)이 끝날 때까지 대기한다.
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["A"]);

      // A의 CR이 flush된 뒤에야 B의 텍스트가 이어진다(인터리브 방지).
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["A", "\r", "B"]);

      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["A", "\r", "B", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one delayed writer so reminder and rename on the same session serialize", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const writer = createDelayedPtyWriter();
      const delayed = (text: string): PtyInputChunk[] => [{ data: text }, { data: "\r", submitDelayMs: 250 }];

      // 서로 다른 소스(리마인더/rename)라도 같은 세션 키를 공유하면 순차 제출된다.
      writer.enqueue("session-1", (data) => writes.push(data), delayed("reminder"));
      writer.enqueue("session-1", (data) => writes.push(data), delayed("/rename X"));

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

      writer.enqueue("a", (data) => writes.push(data), delayed("A"));
      writer.enqueue("b", (data) => writes.push(data), delayed("B"));

      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["A", "B"]);
      await vi.advanceTimersByTimeAsync(250);
      expect(writes).toEqual(["A", "B", "\r", "\r"]);
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
