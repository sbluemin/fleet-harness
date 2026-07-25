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
});
