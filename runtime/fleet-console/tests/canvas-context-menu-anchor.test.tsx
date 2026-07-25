// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasContextMenu } from "../core/client/src/canvas/canvas-context-menu.js";

let container: HTMLDivElement;
let root: Root;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

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
});

afterEach(() => {
  act(() => root.unmount());
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
});

function renderMenu(
  anchor: { readonly x: number; readonly y: number },
  viewportBounds: { readonly width: number; readonly height: number },
): void {
  act(() => root.render(
    <CanvasContextMenu
      anchor={anchor}
      viewportBounds={viewportBounds}
      catalog={[]}
      canLaunch
      renderKindIcon={() => null}
      onLaunchKind={vi.fn()}
      onClose={vi.fn()}
    />,
  ));
}

function menuStyle(): CSSStyleDeclaration {
  return document.querySelector<HTMLElement>(".operation-launch-control--canvas")!.style;
}
