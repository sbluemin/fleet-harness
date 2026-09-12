// @vitest-environment jsdom

import { expect, it, vi } from "vitest";

import { installConsoleGlobalShortcuts } from "../core/client/src/global-shortcuts.js";

it("keeps Zen out of modal, composition, repeat, and AltGr input while allowing a terminal toggle", () => {
  const toggleZenMode = vi.fn();
  const dispose = installConsoleGlobalShortcuts({
    getSideBarCollapsed: () => false,
    setSideBarCollapsed: vi.fn(),
    openOperationSearch: vi.fn(),
    closeOperationSearch: vi.fn(),
    getOperationSearchMode: () => null,
    toggleQuickLaunch: vi.fn(),
    toggleRailChrome: vi.fn(),
    toggleZenMode,
  });
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const input = document.createElement("textarea");
  terminal.append(input);
  document.body.append(terminal);
  input.focus();
  const press = (overrides: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { code: "KeyZ", key: "z", ctrlKey: true, altKey: true, bubbles: true, cancelable: true, ...overrides });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    expect(press()).toBe(true);
    expect(toggleZenMode).toHaveBeenCalledTimes(1);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    expect(press()).toBe(false);
    modal.remove();
    expect(press({ isComposing: true })).toBe(false);
    expect(press({ repeat: true })).toBe(false);
    expect(press({ key: "ż" })).toBe(false);
    expect(press({ code: "Escape", key: "Escape", ctrlKey: false, altKey: false })).toBe(false);
    expect(toggleZenMode).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    terminal.remove();
    document.querySelector('[aria-modal="true"]')?.remove();
  }
});
