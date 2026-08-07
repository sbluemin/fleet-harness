import { describe, expect, it, vi } from "vitest";

import {
  createDelayedPtyWriter,
  formatPtyMessage,
  sanitizePtyMessageText,
  type PtyInputChunk,
  type PtyWriteSink,
} from "../src/index.js";

describe("pty message writer", () => {
  it("removes terminal control chars while preserving input whitespace", () => {
    expect(sanitizePtyMessageText("a\x00b\tc\nd\re\x7Ff\x9Fg")).toBe("ab\tc\nd\refg");
  });

  it("removes bracketed paste end markers", () => {
    expect(sanitizePtyMessageText(`a\x1b[201~b\x9B201~c`)).toBe("abc");
  });

  it("returns formatter chunks in write order", () => {
    expect(formatPtyMessage({ bracketedPaste: true, lineTerminator: "\n" }, "hello", "darwin")).toEqual([
      { data: "\x1b[200~hello\x1b[201~\n" },
    ]);
    expect(formatPtyMessage({ multilineStrategy: "paste-mode" }, "a\nb", "darwin")).toEqual([
      { data: "\x1b[200~a\nb\x1b[201~\r" },
    ]);
    expect(formatPtyMessage({ lineTerminator: "\n" }, "hello", "darwin")).toEqual([{ data: "hello\n" }]);
  });

  it("splits payload and submit only when the host opts into delayed delivery", () => {
    const policy = { bracketedPaste: true, lineTerminator: "\r", multilineStrategy: "paste-mode" as const };

    expect(formatPtyMessage(policy, "hello", "darwin")).toEqual([
      { data: "\x1b[200~hello\x1b[201~\r" },
    ]);
    expect(formatPtyMessage(policy, "hello", "darwin", { submitDelayMs: 250 })).toEqual([
      { data: "\x1b[200~hello\x1b[201~" },
      { data: "\r", submitDelayMs: 250 },
    ]);
  });







  it("shares one delayed writer so two messages on the same session serialize", async () => {
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

});
