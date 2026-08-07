// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { installConsoleGlobalShortcuts, resolvePanelShortcutOutcome } from "../core/client/src/global-shortcuts.js";

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
      toggleQuickLaunch: vi.fn(),
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
      toggleQuickLaunch: vi.fn(),
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
      toggleQuickLaunch: vi.fn(),
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

  // 사이드바·Activity Rail 단축키가 조작할 표면이 없는 곳에서도 발화하면, 아무 변화 없이 영속 상태만
  // 바뀌어 나중에 누른 적 없는 접힘으로 나타난다. 표면 가용성이 결과를 결정한다.
  it("resolves the panel shortcut outcome from surface availability, not from the key alone", () => {
    expect(resolvePanelShortcutOutcome({ panelSurfacesReachable: true, operationsViewVisible: true })).toBe("apply");
    expect(resolvePanelShortcutOutcome({ panelSurfacesReachable: true, operationsViewVisible: false })).toBe("reveal");
    // 모바일 셸에는 두 표면이 아예 없다 — 경로가 /operations여도 발화하지 않는다.
    expect(resolvePanelShortcutOutcome({ panelSurfacesReachable: false, operationsViewVisible: true })).toBe("suppress");
    expect(resolvePanelShortcutOutcome({ panelSurfacesReachable: false, operationsViewVisible: false })).toBe("suppress");
  });
});

describe("Quick Launch shortcut", () => {
  it("opens on Mod+J even while a terminal textarea holds focus", () => {
    const toggleQuickLaunch = vi.fn();
    const cleanup = installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => false,
      setSideBarCollapsed: vi.fn(),
      openOperationSearch: vi.fn(),
      toggleOperationSearch: vi.fn(),
      toggleQuickLaunch,
      toggleRailChrome: vi.fn(),
    });
    // Mod+K/Mod+P와 같은 정책: 터미널을 보고 있다가 떠오른 지시를 그 자리에서 띄운다.
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helper = document.createElement("textarea");
    xterm.append(helper);
    document.body.append(xterm);
    helper.focus();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true, cancelable: true }));

    expect(toggleQuickLaunch).toHaveBeenCalledOnce();
    cleanup();
  });

  it("stays closed behind a blocking dialog and ignores Alt+Mod+J", () => {
    const toggleQuickLaunch = vi.fn();
    const cleanup = installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => false,
      setSideBarCollapsed: vi.fn(),
      openOperationSearch: vi.fn(),
      toggleOperationSearch: vi.fn(),
      toggleQuickLaunch,
      toggleRailChrome: vi.fn(),
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true, cancelable: true }));
    expect(toggleQuickLaunch).not.toHaveBeenCalled();

    dialog.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, altKey: true, bubbles: true, cancelable: true }));
    expect(toggleQuickLaunch).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true, cancelable: true }));
    expect(toggleQuickLaunch).toHaveBeenCalledOnce();
    cleanup();
  });
});
