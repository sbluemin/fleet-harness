// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeyboardShortcutsDialog, isKeyboardShortcutsModalOpen, shouldHandleOperationsKeyboardShortcut } from "../core/client/src/components/keyboard-shortcuts-dialog.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("KeyboardShortcutsDialog", () => {
  it("keeps Tab focus inside the modal", () => {
    act(() => root!.render(createElement(KeyboardShortcutsDialog, { onClose: vi.fn() })));
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close keyboard shortcuts"]')!;
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    close.focus();

    act(() => close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));

    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(outside);
  });

  it("blocks Alt+F formation handling while the modal is open", () => {
    act(() => root!.render(createElement(KeyboardShortcutsDialog, { onClose: vi.fn() })));

    expect(isKeyboardShortcutsModalOpen()).toBe(true);
    expect(shouldHandleOperationsKeyboardShortcut()).toBe(false);
  });
});
