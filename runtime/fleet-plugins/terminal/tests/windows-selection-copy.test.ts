import { describe, expect, it, vi } from "vitest";

import {
  createWindowsSelectionCopyHandler,
  type WindowsSelectionCopyKeyEvent,
} from "../client/shared/windows-selection-copy.js";

function makeKey(overrides: Partial<WindowsSelectionCopyKeyEvent> = {}): WindowsSelectionCopyKeyEvent {
  return {
    altKey: false,
    ctrlKey: true,
    key: "C",
    metaKey: false,
    shiftKey: true,
    type: "keydown",
    ...overrides,
  };
}

function createHandler({
  platform = "Win32",
  selection = "selected terminal text",
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
}: {
  platform?: string;
  selection?: string;
  writeText?: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
} = {}) {
  return {
    handler: createWindowsSelectionCopyHandler({
      getPlatform: () => platform,
      getSelection: () => selection,
      writeText,
    }),
    writeText,
  };
}

describe("createWindowsSelectionCopyHandler", () => {
  it("copies selected xterm text for Windows Ctrl+Shift+C and consumes the event", () => {
    const { handler, writeText } = createHandler();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    expect(handler.handleKeyEvent(makeKey({ preventDefault, stopPropagation }))).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("selected terminal text");
  });

  it("consumes Windows Ctrl+Shift+C without copying when there is no selection", () => {
    const { handler, writeText } = createHandler({ selection: "" });

    expect(handler.handleKeyEvent(makeKey())).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies only on keydown, without a keyup duplicate", () => {
    const { handler, writeText } = createHandler();

    expect(handler.handleKeyEvent(makeKey())).toBe(false);
    expect(handler.handleKeyEvent(makeKey({ type: "keyup" }))).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("consumes a repeated shortcut keydown without copying again", () => {
    const { handler, writeText } = createHandler();

    handler.handleKeyEvent(makeKey());
    expect(handler.handleKeyEvent(makeKey({ repeat: true }))).toBe(false);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("passes through the shortcut on non-Windows platforms", () => {
    const { handler, writeText } = createHandler({ platform: "MacIntel" });

    expect(handler.handleKeyEvent(makeKey())).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("passes macOS Cmd+C through unchanged", () => {
    const { handler, writeText } = createHandler({ platform: "MacIntel" });

    expect(handler.handleKeyEvent(makeKey({ ctrlKey: false, key: "c", metaKey: true, shiftKey: false }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    { altKey: true },
    { metaKey: true },
    { shiftKey: false },
    { ctrlKey: false },
    { key: "V", code: "KeyV" },
  ])("passes through modifier or key mismatches: %o", (overrides) => {
    const { handler, writeText } = createHandler();

    expect(handler.handleKeyEvent(makeKey(overrides))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("passes ordinary Ctrl+C through to the PTY", () => {
    const { handler, writeText } = createHandler();

    expect(handler.handleKeyEvent(makeKey({ key: "c", shiftKey: false }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("handles clipboard rejection without leaking it", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error("denied"));
    const { handler } = createHandler({ writeText });

    expect(handler.handleKeyEvent(makeKey())).toBe(false);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledOnce();
  });
});
