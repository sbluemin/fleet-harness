// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasContextMenu } from "../core/client/src/canvas/canvas-context-menu.js";
import type { OperationCatalogPlugin } from "../sdk/operations/index.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CanvasContextMenu initial prompt launch", () => {
  it("shows an inline first-prompt step for a supported launch kind", () => {
    const onLaunchKind = vi.fn();
    const onClose = vi.fn();
    renderMenu(agentCatalog(), onLaunchKind, onClose);

    act(() => buttonNamed("Claude").click());

    expect(onLaunchKind).not.toHaveBeenCalled();
    expect(document.querySelector("label")?.textContent).toBe("First prompt (optional)");
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.placeholder).toBe("Type the first instruction for this session");
    expect(document.activeElement).toBe(textarea);
    expect(buttonNamed("Launch")).toBeDefined();
    expect(buttonNamed("Launch empty")).toBeDefined();
    expect(container.textContent).toContain("Enter to launch · Shift+Enter for a new line");

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("textarea")).toBeNull();
    expect(buttonNamed("Claude")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();

    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("launches an unsupported kind immediately without showing the prompt step", () => {
    const onLaunchKind = vi.fn();
    const shell = { id: "shell", type: "shell", title: "Shell" } as const;
    renderMenu([{ id: "terminal", title: "Terminal", kinds: [shell] }], onLaunchKind);

    act(() => buttonNamed("Shell").click());

    expect(onLaunchKind).toHaveBeenCalledWith("terminal", shell);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("trims and launches the prompt on Enter while preserving Shift+Enter for a new line", () => {
    const onLaunchKind = vi.fn();
    const catalog = agentCatalog();
    const kind = catalog[0]!.kinds[0]!;
    renderMenu(catalog, onLaunchKind);
    act(() => buttonNamed("Claude").click());
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;

    act(() => {
      setTextareaValue(textarea, "  Run the focused tests  ");
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(onLaunchKind).not.toHaveBeenCalled();

    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(onLaunchKind).toHaveBeenCalledWith("terminal", kind, "Run the focused tests");
  });

  it("traps Tab focus within the prompt textarea and launch actions", () => {
    renderMenu(agentCatalog(), vi.fn());
    act(() => buttonNamed("Claude").click());
    const promptStep = document.querySelector<HTMLElement>(".canvas-context-menu-prompt-step")!;
    const textarea = promptStep.querySelector<HTMLTextAreaElement>("textarea")!;
    const launch = buttonNamed("Launch");
    const launchEmpty = buttonNamed("Launch empty");

    expect([...promptStep.querySelectorAll<HTMLElement>("textarea, button")]).toEqual([textarea, launch, launchEmpty]);

    // jsdom은 기본 Tab 순차 이동을 수행하지 않으므로 양 끝의 trapFocus 경계 순환을 직접 단언한다.
    act(() => launchEmpty.focus());
    expect(dispatchTab(launchEmpty)).toBe(false);
    expect(document.activeElement).toBe(textarea);

    act(() => textarea.focus());
    expect(dispatchTab(textarea, true)).toBe(false);
    expect(document.activeElement).toBe(launchEmpty);
  });
});

function renderMenu(catalog: readonly OperationCatalogPlugin[], onLaunchKind: ReturnType<typeof vi.fn>, onClose = vi.fn()): void {
  act(() => root.render(
    <CanvasContextMenu
      anchor={{ x: 20, y: 20 }}
      catalog={catalog}
      canLaunch
      renderKindIcon={() => null}
      onLaunchKind={onLaunchKind}
      onClose={onClose}
    />,
  ));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchTab(element: HTMLElement, shiftKey = false): boolean {
  return element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name);
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function agentCatalog(): readonly OperationCatalogPlugin[] {
  return [{
    id: "terminal",
    title: "Terminal",
    kinds: [{ id: "claude", type: "agent", title: "Claude", supportsInitialPrompt: true }],
  }];
}
