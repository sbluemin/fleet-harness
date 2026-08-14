// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationFrame } from "../core/client/src/canvas/operation-frame.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("OperationFrame identity rename", () => {
  it.each(["Enter", "F2"])("begins rename with %s", (key) => {
    const onRename = vi.fn();
    const trigger = renderInactiveFrame(onRename);

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

    expect(identityInput()).not.toBeNull();
    expect(document.activeElement).toBe(identityInput());
  });

  it("does not begin rename with Space", () => {
    const onRename = vi.fn();
    const trigger = renderInactiveFrame(onRename);

    act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
    expect(identityInput()).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it.each(["Escape", "Enter", "blur"])("returns focus to the identity trigger after %s completes rename", (completion) => {
    const onRename = vi.fn();
    const trigger = renderInactiveFrame(onRename);
    beginRename(trigger);
    const input = identityInput()!;

    act(() => {
      if (completion === "blur") input.blur();
      else input.dispatchEvent(new KeyboardEvent("keydown", { key: completion, bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(identityTrigger());
    expect(onRename).toHaveBeenCalledTimes(completion === "Escape" ? 0 : 1);
  });

  it("commits active-panel rename and returns focus to its identity trigger", () => {
    const onRename = vi.fn();
    renderFrame(onRename, true);
    beginRename(identityTrigger());
    const input = identityInput()!;

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(identityTrigger());
  });

  it("places inactive identity before its beacon and preserves the full-title tooltip", () => {
    renderFrame(vi.fn(), false);
    const titlebar = document.querySelector(".canvas-operation-titlebar")!;
    const children = Array.from(titlebar.children);

    expect(children[0]?.className).toBe("canvas-operation-identity-name");
    expect(children[1]?.className).toBe("canvas-operation-beacon-button");
    expect(children[2]?.className).toBe("canvas-operation-window-controls");
    expect(document.querySelectorAll(".canvas-operation-window-controls .canvas-operation-icon-button")).toHaveLength(3);
    expect(identityTrigger().title).toBe("A deliberately long Operation title — Drag to move. Double-click, Enter, or F2 to rename");
  });

  it.each(["double-click", "Enter", "F2"])("renders active identity and begins rename with %s", (action) => {
    const onRename = vi.fn();
    renderFrame(onRename, true);
    const trigger = identityTrigger();

    act(() => {
      if (action === "double-click") {
        const titlebar = document.querySelector(".canvas-operation-titlebar")!;
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10, button: 0 }));
        titlebar.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, clientX: 10, clientY: 10, button: 0 }));
        trigger.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        return;
      }
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true }));
    });

    expect(identityInput()).not.toBeNull();
    expect(document.activeElement).toBe(identityInput());
    expect(onRename).not.toHaveBeenCalled();
  });

  it("does not capture the pointer on a stationary title click so dblclick stays on the button", () => {
    const onRename = vi.fn();
    renderFrame(onRename, true);
    const trigger = identityTrigger();
    const titlebar = document.querySelector(".canvas-operation-titlebar") as HTMLElement;
    titlebar.setPointerCapture = vi.fn();
    const capture = titlebar.setPointerCapture as ReturnType<typeof vi.fn>;

    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 7, clientX: 12, clientY: 12, button: 0 }));
      titlebar.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 7, clientX: 12, clientY: 12, button: 0 }));
    });

    expect(capture).not.toHaveBeenCalled();
    expect(identityInput()).toBeNull();
  });

  it("marks the frame with is-top-edge when the canvas would clip the attached caption", () => {
    renderFrame(vi.fn(), false, true);
    expect(document.querySelector(".canvas-operation")!.className).toContain("is-top-edge");
  });

  it("keeps active identity in the name → beacon → controls order", () => {
    renderFrame(vi.fn(), true);
    const children = Array.from(document.querySelector(".canvas-operation-titlebar")!.children);

    expect(identityInput()).toBeNull();
    expect(identityTrigger()).not.toBeNull();
    expect(children[0]?.className).toBe("canvas-operation-identity-name");
    expect(children[1]?.className).toBe("canvas-operation-beacon-button");
    expect(children[2]?.className).toBe("canvas-operation-window-controls");
  });

  it.each(["double-click", "Enter", "F2"])("keeps inactive identity mounted when %s begins rename", (action) => {
    const onActivate = vi.fn();
    act(() => root!.render(createElement(ActivationRaceFrame, { onActivate })));
    const trigger = identityTrigger();

    act(() => {
      if (action === "double-click") {
        trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        return;
      }
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true }));
    });

    if (action === "double-click") {
      // 제목은 캡션 드래그 면이라 pointerdown이 창을 활성화한다. 이름 변경은 더블클릭이 연다.
      expect(onActivate).toHaveBeenCalled();
    } else {
      expect(onActivate).not.toHaveBeenCalled();
      expect(document.querySelector(".canvas-operation")?.classList.contains("is-active")).toBe(false);
    }
    expect(identityInput()).not.toBeNull();
  });
});

function ActivationRaceFrame({ onActivate }: { readonly onActivate: () => void }) {
  const [active, setActive] = useState(false);
  return createElement(OperationFrame, {
    operation: {
      id: "operation-activation-race",
      theaterId: "theater-identity",
      type: "shell",
      pluginId: "terminal",
      title: "A deliberately long Operation title",
      payload: {},
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    },
    active,
    unseen: false,
    glanceHud: {
      index: "01",
      hints: [
        { key: "↑", messageKey: "canvas.glance.maximize" },
        { key: "↓", messageKey: "canvas.glance.minimize" },
      ],
    },
    geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
    zoom: 1,
    onActivate: () => {
      onActivate();
      setActive(true);
    },
    onClose: () => {},
    onMinimize: () => {},
    onMaximize: () => {},
    onRename: () => {},
    onSetAccent: () => {},
    onGeometryChange: () => {},
    onGeometryCommit: () => {},
    children: createElement("div"),
  });
}

function renderInactiveFrame(onRename: (title: string) => void): HTMLButtonElement {
  renderFrame(onRename, false);
  return identityTrigger();
}

function renderFrame(onRename: (title: string) => void, active: boolean, topEdge = false): void {
  act(() => root!.render(createElement(OperationFrame, {
    topEdge,
    operation: {
      id: "operation-identity",
      theaterId: "theater-identity",
      type: "shell",
      pluginId: "terminal",
      title: "A deliberately long Operation title",
      payload: {},
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    },
    active,
    unseen: false,
    glanceHud: {
      index: "01",
      hints: [
        { key: "↑", messageKey: "canvas.glance.maximize" },
        { key: "↓", messageKey: "canvas.glance.minimize" },
      ],
    },
    geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
    zoom: 1,
    onActivate: () => {},
    onClose: () => {},
    onMinimize: () => {},
    onMaximize: () => {},
    onRename,
    onSetAccent: () => {},
    onGeometryChange: () => {},
    onGeometryCommit: () => {},
    children: createElement("div"),
  })));
}

function beginRename(trigger: HTMLButtonElement): void {
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}

function identityTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(".canvas-operation-identity-name");
  if (trigger === null) throw new Error("Missing identity trigger");
  return trigger;
}

function identityInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".canvas-operation-identity-input");
}
