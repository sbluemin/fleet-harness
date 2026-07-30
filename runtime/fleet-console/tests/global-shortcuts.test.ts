// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { installConsoleGlobalShortcuts } from "../core/client/src/global-shortcuts.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Console global shortcuts", () => {
  it("restores Meta+K only after the blocking dialog is removed", () => {
    const toggleOperationSearch = vi.fn();
    const cleanup = installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => false,
      setSideBarCollapsed: vi.fn(),
      openOperationSearch: vi.fn(),
      toggleOperationSearch,
      toggleRailChrome: vi.fn(),
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    dialog.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));

    expect(toggleOperationSearch).toHaveBeenCalledOnce();
    cleanup();
  });

  it("runs Undo only while a grace window exists and ignores editable or xterm focus", () => {
    const undoLastClose = vi.fn();
    let active = false;
    const cleanup = installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => false,
      setSideBarCollapsed: vi.fn(),
      openOperationSearch: vi.fn(),
      toggleOperationSearch: vi.fn(),
      toggleRailChrome: vi.fn(),
      canUndoLastClose: () => active,
      undoLastClose,
    });
    const dispatchUndo = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));

    dispatchUndo();
    active = true;
    dispatchUndo();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    dispatchUndo();
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    xterm.tabIndex = 0;
    document.body.append(xterm);
    xterm.focus();
    dispatchUndo();

    expect(undoLastClose).toHaveBeenCalledOnce();
    cleanup();
  });

  it("opens the command palette for Mod+P with optional Shift while rejecting Alt and modal-gated events", () => {
    const openOperationSearch = vi.fn();
    const cleanup = installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => false,
      setSideBarCollapsed: vi.fn(),
      openOperationSearch,
      toggleOperationSearch: vi.fn(),
      toggleRailChrome: vi.fn(),
    });
    const dispatch = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");
      window.dispatchEvent(event);
      return { event, stopImmediatePropagation };
    };

    const meta = dispatch({ key: "p", metaKey: true });
    const ctrlShift = dispatch({ key: "P", ctrlKey: true, shiftKey: true });
    const alt = dispatch({ key: "p", metaKey: true, altKey: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    const modalGated = dispatch({ key: "p", metaKey: true });

    expect(openOperationSearch).toHaveBeenCalledTimes(2);
    expect(meta.event.defaultPrevented).toBe(true);
    expect(meta.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(ctrlShift.event.defaultPrevented).toBe(true);
    expect(ctrlShift.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(alt.event.defaultPrevented).toBe(false);
    expect(alt.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(modalGated.event.defaultPrevented).toBe(false);
    expect(modalGated.stopImmediatePropagation).not.toHaveBeenCalled();
    cleanup();
  });
});
