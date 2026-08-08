// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuickLaunchEffortMenu } from "../core/client/src/components/quick-launch-effort-menu.js";

let container: HTMLDivElement;
let anchor: HTMLButtonElement;
let root: Root;
let anchorRect: DOMRect;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  anchorRect = rect({ left: 100, top: 80, width: 264, height: 32 });
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    if (this === anchor) return anchorRect;
    if (this.classList.contains("quick-launch-effort-menu")) return rect({ width: 148, height: 72 });
    return originalGetBoundingClientRect.call(this);
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  container = document.createElement("div");
  anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelector(".quick-launch-effort-menu")?.remove();
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

describe("Quick Launch effort submenu layout", () => {
  it("portals the submenu outside the model list and opens to the right when it fits", () => {
    renderMenu();

    const menu = effortMenu();
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.left).toBe("370px");
    expect(menu.style.top).toBe("80px");
    expect(menu.classList.contains("is-left")).toBe(false);
  });

  it("flips left only when the right side exceeds the viewport margin", () => {
    anchorRect = rect({ left: 620, top: 80, width: 264, height: 32 });
    renderMenu();

    const menu = effortMenu();
    expect(menu.style.left).toBe("466px");
    expect(menu.classList.contains("is-left")).toBe(true);
  });

  it("keeps the model popover at the compact 264px width", () => {
    const css = readFileSync(resolve(process.cwd(), "core/client/src/styles/components.css"), "utf8");
    expect(css).toMatch(/\.quick-launch-pop--model\s*\{\s*width:\s*264px;/u);
  });
});

function renderMenu(): void {
  act(() => root.render(
    <QuickLaunchEffortMenu
      anchor={anchor}
      menuRef={createRef<HTMLDivElement>()}
      open
      onCancelClose={() => {}}
      onScheduleClose={() => {}}
      onClose={() => {}}
      onReturnFocus={() => {}}
    >
      <button type="button" className="quick-launch-effort-item">HIGH</button>
    </QuickLaunchEffortMenu>,
  ));
}

function effortMenu(): HTMLElement {
  const menu = document.querySelector<HTMLElement>(".quick-launch-effort-menu");
  if (!menu) throw new Error("Expected effort menu");
  return menu;
}

function rect({ left = 0, top = 0, width = 0, height = 0 }: {
  readonly left?: number;
  readonly top?: number;
  readonly width?: number;
  readonly height?: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}
