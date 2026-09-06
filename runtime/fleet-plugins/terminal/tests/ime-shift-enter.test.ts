import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createImeShiftEnterHandler, type ImeShiftEnterKeyEvent } from "../client/shared/ime-shift-enter.js";

// KeyboardEvent의 Pick 서브셋을 만드는 헬퍼
function makeKey(
  key: string,
  shiftKey: boolean,
  type: "keydown" | "keypress" | "keyup" = "keydown",
  overrides: Partial<ImeShiftEnterKeyEvent> = {},
): ImeShiftEnterKeyEvent {
  return { key, shiftKey, type, ...overrides };
}

describe("createImeShiftEnterHandler", () => {
  let sendLF: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    sendLF = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 비-IME 경로 ──────────────────────────────────────────────────────────────

  it("composition 없는 상태에서 Shift+Enter keydown → 즉시 LF 전송", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    const result = handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(result).toBe(false);
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  // ── IME composition 경로 ─────────────────────────────────────────────────────

  it("composition 중 Shift+Enter keydown → LF 즉시 전송 안 됨", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("composition 중 Shift+Enter 후 compositionend → 다음 tick에 LF 전송", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.onCompositionEnd();
    // 아직 setTimeout(0) 이전 — LF 미전송
    expect(sendLF).not.toHaveBeenCalled();
    // 타이머 진행 후 전송
    await vi.runAllTimersAsync();
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("composition 중 Shift+Enter 여러 번 → LF는 compositionend 후 딱 한 번", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.onCompositionEnd();
    await vi.runAllTimersAsync();
    expect(sendLF).toHaveBeenCalledTimes(1);
  });
});
