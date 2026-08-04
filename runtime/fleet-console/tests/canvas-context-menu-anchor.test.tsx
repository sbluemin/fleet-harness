// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationCatalogPlugin } from "@fleet-console/sdk/operations";

import { CanvasContextMenu } from "../core/client/src/canvas/canvas-context-menu.js";
import {
  FEATURE_TOUR_BOUNDARY_ATTRIBUTE,
  FEATURE_TOUR_LAYER_ATTRIBUTE,
} from "../core/client/src/feature-tour-catalog.js";

let container: HTMLDivElement;
let root: Root;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
let tourLayer: HTMLDivElement | null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this.classList.contains("canvas-context-menu")) {
      return { ...originalGetBoundingClientRect.call(this), width: 288, height: 133 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  tourLayer = null;
});

afterEach(() => {
  act(() => root.unmount());
  tourLayer?.remove();
  container.remove();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

describe("CanvasContextMenu anchor placement", () => {
  it("keeps the menu at the cursor when there is enough room below", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 });

    const style = menuStyle();
    expect(style.left).toBe("520px");
    expect(style.top).toBe("156px");
    expect(style.getPropertyValue("--canvas-menu-max-height")).toBe("520px");
  });

  it("flips the menu above the cursor using its rendered height", () => {
    renderMenu({ x: 520, y: 756 }, { width: 1116, height: 856 });

    const style = menuStyle();
    expect(style.top).toBe("623px");
    expect(style.top).not.toBe("324px");
  });

  it("clamps the menu horizontally using its rendered width", () => {
    renderMenu({ x: 1000, y: 156 }, { width: 1116, height: 856 });

    expect(menuStyle().left).toBe("816px");
  });

  it("derives the menu max-height from a short viewport", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 400 });

    expect(menuStyle().getPropertyValue("--canvas-menu-max-height")).toBe("376px");
  });

  it("renders fixed at viewport coordinates when the fixed prop is set", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], vi.fn(), true);

    const style = menuStyle();
    expect(style.position).toBe("fixed");
    expect(style.left).toBe("520px");
    expect(style.top).toBe("156px");
  });
});

describe("CanvasContextMenu launch kind attribute", () => {
  it("tags each launch item with its kind id so selectors do not depend on the title", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude", type: "agent", title: "Claude Code (Classic)" },
          { id: "claude-gateway", type: "agent", title: "Claude (Gateway • Experimental)" },
        ],
      },
    ]);

    const gateway = document.querySelectorAll<HTMLButtonElement>('[data-operation-launch-kind="claude-gateway"]');
    expect(gateway).toHaveLength(1);
    expect(gateway[0]?.textContent).toContain("Claude (Gateway • Experimental)");
    expect(document.querySelector('[data-operation-launch-kind="claude"]')).not.toBeNull();
  });

  it("annotates the Claude launch kinds with a description and no extra decoration", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude-native", type: "agent", title: "Claude (Native)" },
          { id: "claude", type: "agent", title: "Claude (Classic)" },
          { id: "codex", type: "agent", title: "Codex" },
          { id: "claude-gateway", type: "agent", title: "Claude (Gateway • Experimental)" },
          { id: "shell", type: "shell", title: "Shell" },
        ],
      },
    ]);

    const descriptionOf = (kindId: string) =>
      document.querySelector(`[data-operation-launch-kind="${kindId}"] .operation-launch-menu-description`)?.textContent;

    expect(descriptionOf("claude-native")).toBe("Plain Claude Code, without the Admiral prompt");
    expect(descriptionOf("claude")).toContain("Admiral standing orders");
    expect(descriptionOf("claude-gateway")).toContain("models you enabled in Settings");
    // 설명은 Claude 세 갈래에만 붙는다 — 대비가 필요 없는 종류까지 늘리면 메뉴만 길어진다.
    expect(descriptionOf("codex")).toBeUndefined();
    expect(descriptionOf("shell")).toBeUndefined();

    // 신규·실험 여부는 라벨 괄호 안이 들고 있다 — 항목에 별도 표식을 덧붙이지 않는다.
    expect(document.querySelector(".operation-launch-menu-badge")).toBeNull();
    expect(document.querySelector('[data-operation-launch-kind="claude-gateway"]')?.textContent)
      .toContain("Claude (Gateway • Experimental)");
  });

  it("shows the disabled reason instead of the description when the CLI cannot launch", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [
      {
        id: "terminal",
        title: "Terminal",
        kinds: [
          { id: "claude-native", type: "agent", title: "Claude (Native)", disabled: true, disabledReason: "Not installed" },
        ],
      },
    ]);

    const item = document.querySelector('[data-operation-launch-kind="claude-native"]');
    expect(item?.querySelector(".operation-launch-menu-reason")?.textContent).toBe("Not installed");
    expect(item?.querySelector(".operation-launch-menu-description")).toBeNull();
  });

  it("marks the rendered menu box as the tour placement boundary", () => {
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 });

    const boundary = document.querySelector(`[${FEATURE_TOUR_BOUNDARY_ATTRIBUTE}]`);
    expect(boundary).toBe(document.querySelector(".canvas-context-menu"));
    expect(boundary).not.toBe(document.querySelector(".operation-launch-control"));
  });

  it("focuses the menu container and dismisses it with Escape", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], onClose);

    expect(document.activeElement).toBe(document.querySelector(".canvas-context-menu"));
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses the menu on the shared close signal emitted by cross-surface interactions", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], onClose);

    act(() => window.dispatchEvent(new Event("canvas-context-menu-close")));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not dismiss the menu before the feature tour card handles its click", () => {
    const onClose = vi.fn();
    renderMenu({ x: 520, y: 156 }, { width: 1116, height: 856 }, [], onClose);
    tourLayer = document.createElement("div");
    tourLayer.setAttribute(FEATURE_TOUR_LAYER_ATTRIBUTE, "");
    const tourButton = document.createElement("button");
    tourLayer.append(tourButton);
    document.body.append(tourLayer);

    act(() => tourButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();

    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function renderMenu(
  anchor: { readonly x: number; readonly y: number },
  viewportBounds: { readonly width: number; readonly height: number },
  catalog: readonly OperationCatalogPlugin[] = [],
  onClose = vi.fn(),
  fixed = false,
): void {
  act(() => root.render(
    <CanvasContextMenu
      anchor={anchor}
      viewportBounds={viewportBounds}
      fixed={fixed}
      catalog={catalog}
      canLaunch
      renderKindIcon={() => null}
      onLaunchKind={vi.fn()}
      onClose={onClose}
    />,
  ));
}

function menuStyle(): CSSStyleDeclaration {
  return document.querySelector<HTMLElement>(".operation-launch-control--canvas")!.style;
}
