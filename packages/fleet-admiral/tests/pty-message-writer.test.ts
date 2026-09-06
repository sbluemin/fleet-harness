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

});
