// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptionActionButton, CaptionAnalystGlyph } from "../sdk/components/caption-actions.js";
import { OperationFrame } from "../core/client/src/canvas/operation-frame.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("OperationFrame caption action shelf", () => {
  // 자리는 프레임이 정한다: 이 Operation **안의** 동작이 먼저, 그 뒤로 메뉴와 창 컨트롤.
  it("seats the plugin shelf between the title and the menu button", () => {
    renderFrame({ onSelect: vi.fn() });
    const titlebar = document.querySelector(".canvas-operation-titlebar")!;
    const classes = Array.from(titlebar.children).map((child) => child.className);
    expect(classes).toEqual([
      "canvas-operation-identity-name",
      "canvas-operation-caption-actions",
      "fleet-caption-slot",
      "canvas-operation-window-controls",
    ]);
    expect(titlebar.querySelector(".canvas-operation-caption-actions .fleet-caption-action")).not.toBeNull();
  });

  // 카드 본문은 inert이고 승격 면이 클릭을 가로챈다 — 그 위의 캡션에만 동작 버튼이 살아 있으면
  // 카드가 조용히 다른 문법을 갖는다. 호스트가 아예 넘기지 않으므로 태어나지도 않는다.
  it("drops the shelf entirely on a War Room deck tile", () => {
    renderFrame({ onSelect: vi.fn(), captionActions: null });
    expect(document.querySelector(".canvas-operation-caption-actions")).toBeNull();
    expect(document.querySelector(".fleet-caption-action")).toBeNull();
  });

  // 캡션은 창을 끄는 면이다 — 버튼을 누르는 순간 패널이 따라오면 안 된다.
  it("keeps a shelf press from starting a panel drag", () => {
    const onSelect = vi.fn();
    const onGeometryChange = vi.fn();
    renderFrame({ onSelect, onGeometryChange });
    const button = document.querySelector<HTMLButtonElement>(".fleet-caption-action")!;

    act(() => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 90, clientY: 90 }));
    });
    act(() => button.click());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onGeometryChange).not.toHaveBeenCalled();
  });

  // 이름표는 말풍선이 진다 — 브라우저 기본 툴팁은 밴드마다 지연·모양이 다르고 접근 이름과 갈린다.
  it("names a mark-only button with one string in both the label and the bubble", () => {
    renderFrame({ onSelect: vi.fn() });
    const button = document.querySelector<HTMLButtonElement>(".fleet-caption-action")!;
    expect(button.getAttribute("aria-label")).toBe("Open Session Analyst");
    expect(button.hasAttribute("title")).toBe(false);
    const tip = button.parentElement?.querySelector(".fleet-caption-tip");
    expect(tip?.textContent).toBe("Open Session Analyst");
    expect(tip?.getAttribute("aria-hidden")).toBe("true");
  });
});

function renderFrame(options: {
  readonly onSelect: () => void;
  readonly captionActions?: ReactNode;
  readonly onGeometryChange?: (geometry: { x: number; y: number; width: number; height: number; zIndex: number }) => void;
}): void {
  const shelf = options.captionActions === undefined
    ? createElement(CaptionActionButton, {
      actionId: "analyst",
      label: "Open Session Analyst",
      onClick: options.onSelect,
    }, createElement(CaptionAnalystGlyph))
    : options.captionActions;
  act(() => root!.render(createElement(OperationFrame, {
    operation: {
      id: "operation-caption",
      theaterId: "theater-caption",
      type: "agent",
      pluginId: "terminal",
      title: "Caption shelf",
      payload: {},
      geometry: null,
      ts: { createdAt: 1, updatedAt: 1 },
    },
    active: false,
    unseen: false,
    glanceHud: { index: "01", hints: [] },
    geometry: { x: 0, y: 0, width: 640, height: 400, zIndex: 1 },
    zoom: 1,
    captionActions: shelf,
    onActivate: () => {},
    onClose: () => {},
    onMinimize: () => {},
    onMaximize: () => {},
    onRename: () => {},
    onOpenMenu: () => {},
    onGeometryChange: options.onGeometryChange ?? (() => {}),
    onGeometryCommit: () => {},
    children: createElement("div"),
  })));
}
