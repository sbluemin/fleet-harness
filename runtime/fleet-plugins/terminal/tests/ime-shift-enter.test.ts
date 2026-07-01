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

  it("Shift+Enter는 textarea 기본 개행을 막기 위해 preventDefault 호출", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    const preventDefault = vi.fn();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown", { preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("IME가 key 대신 code=Enter만 주는 Shift+Enter도 처리", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    const preventDefault = vi.fn();
    const result = handler.handleKeyEvent(makeKey("Process", true, "keydown", { code: "Enter", preventDefault }));
    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("IME가 keyCode=13만 주는 Shift+Enter도 처리", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    const preventDefault = vi.fn();
    const result = handler.handleKeyEvent(makeKey("Process", true, "keydown", { keyCode: 13, preventDefault }));
    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("keydown 뒤 keypress에서 Shift+Enter → LF 중복 전송 안 함, false 반환", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    const result = handler.handleKeyEvent(makeKey("Enter", true, "keypress"));
    expect(result).toBe(false);
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("keydown 없이 keypress만 오는 Shift+Enter → LF 전송", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    const result = handler.handleKeyEvent(makeKey("Enter", true, "keypress"));
    expect(result).toBe(false);
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("Shift 없는 Enter → 기본 동작 통과(true 반환)", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    const result = handler.handleKeyEvent(makeKey("Enter", false, "keydown"));
    expect(result).toBe(true);
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("다른 키는 true 반환하고 sendLF 미호출", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    expect(handler.handleKeyEvent(makeKey("a", false))).toBe(true);
    expect(handler.handleKeyEvent(makeKey("ArrowUp", true))).toBe(true);
    expect(sendLF).not.toHaveBeenCalled();
  });

  // ── IME composition 경로 ─────────────────────────────────────────────────────

  it("composition 중 Shift+Enter keydown → LF 즉시 전송 안 됨", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("event.isComposing만 true여도 Shift+Enter keydown → LF 즉시 전송 안 됨", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.handleKeyEvent(makeKey("Enter", true, "keydown", { isComposing: true }));
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("keyCode 229만 있는 IME Shift+Enter keydown → LF 즉시 전송 안 됨", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.handleKeyEvent(makeKey("Enter", true, "keydown", { keyCode: 229 }));
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("code=Enter + keyCode 229인 IME Shift+Enter keydown → LF 즉시 전송 안 됨", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.handleKeyEvent(makeKey("Process", true, "keydown", { code: "Enter", keyCode: 229 }));
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("keydown 없이 keypress만 오는 IME Shift+Enter → compositionend까지 LF 지연", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.handleKeyEvent(makeKey("Enter", true, "keypress", { isComposing: true }));
    expect(sendLF).not.toHaveBeenCalled();
    handler.onCompositionEnd();
    await vi.runAllTimersAsync();
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("which 229만 있는 IME Shift+Enter keydown → LF 즉시 전송 안 됨", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.handleKeyEvent(makeKey("Enter", true, "keydown", { which: 229 }));
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

  it("compositionend 직후 같은 tick의 Shift+Enter → 다음 tick에 LF 전송", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.onCompositionEnd();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(sendLF).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("compositionend 직후 LF 타이머 대기 중 추가 Shift+Enter → LF 중복 전송 안 함", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.onCompositionEnd();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(sendLF).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("composition 중 Shift+Enter 없이 compositionend → LF 전송 안 됨", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.onCompositionEnd();
    await vi.runAllTimersAsync();
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("compositionend 뒤 예약된 LF는 focusout cancel이 취소하지 않음", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.onCompositionEnd();
    handler.onCompositionCancel();
    await vi.runAllTimersAsync();
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("compositionend 뒤 예약된 LF는 focusout 직후 추가 Shift+Enter와 중복되지 않음", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.onCompositionEnd();
    handler.onCompositionCancel();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
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

  it("compositionend 후 isComposing이 false가 돼 이후 Shift+Enter는 즉시 LF", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.onCompositionEnd();
    await vi.runAllTimersAsync();
    // 이제 composition 해제 — 즉시 경로로 돌아와야 함
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  // ── dispose 경로 ─────────────────────────────────────────────────────────────

  it("pendingLF 대기 중 dispose → 타이머 취소되고 LF 전송 안 됨", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.onCompositionEnd();
    handler.dispose();
    await vi.runAllTimersAsync();
    expect(sendLF).not.toHaveBeenCalled();
  });

  it("pendingLF 대기 중 composition cancel → 이후 Shift+Enter는 즉시 LF", async () => {
    const handler = createImeShiftEnterHandler(sendLF);
    handler.onCompositionStart();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    handler.onCompositionCancel();
    await vi.runAllTimersAsync();
    expect(sendLF).not.toHaveBeenCalled();
    handler.handleKeyEvent(makeKey("Enter", true, "keydown"));
    expect(sendLF).toHaveBeenCalledTimes(1);
  });

  it("pendingLF 없는 상태의 dispose는 부작용 없음", () => {
    const handler = createImeShiftEnterHandler(sendLF);
    expect(() => handler.dispose()).not.toThrow();
    expect(sendLF).not.toHaveBeenCalled();
  });
});
