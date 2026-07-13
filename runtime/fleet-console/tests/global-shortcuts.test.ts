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
});
