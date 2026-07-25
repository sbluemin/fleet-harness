// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveUpdateApplyCopy, SideBarBrandFoot } from "../core/client/src/components/side-bar-brand-foot.js";
import { getT } from "../core/client/src/i18n/index.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  window.localStorage.setItem("fleet-console.github-stars", JSON.stringify({ count: 1, at: Date.now() }));
  originalRequestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.requestAnimationFrame = originalRequestAnimationFrame;
});

function mountFoot() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(MemoryRouter, null, createElement(SideBarBrandFoot))));
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("SideBarBrandFoot System Menu", () => {
  it("gives managed installation updates an actionable Desktop relaunch instruction instead of retry", () => {
    expect(resolveUpdateApplyCopy("blocked", "managed_runtime_update_requires_relaunch", "1.2.3", getT("en"))).toEqual({
      label: "Update and Restart",
      title: "This managed Console installation updates through Fleet Console Desktop. Use Desktop Update and Restart.",
      tone: "blocked",
      disabled: true,
    });
  });

  it("focuses the first System Menu item on open and cycles with arrow keys", () => {
    mountFoot();
    const trigger = document.querySelector<HTMLButtonElement>(".brand-foot-system-trigger")!;
    act(() => trigger.click());

    const items = menuItems();
    expect(items).toHaveLength(1);
    expect(document.activeElement).toBe(items[0]);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[0]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[0]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    mountFoot();
    const trigger = document.querySelector<HTMLButtonElement>(".brand-foot-system-trigger")!;
    act(() => trigger.click());
    expect(menuItems()).toHaveLength(1);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });

  it("shares Arrow/Home/End cycling with Help and includes GitHub links", () => {
    mountFoot();
    const trigger = document.querySelector<HTMLButtonElement>(".brand-foot-help-trigger")!;
    act(() => trigger.click());

    const items = menuItems();
    expect(items).toHaveLength(4);
    expect(document.activeElement).toBe(items[1]);
    expect(items[2]?.getAttribute("aria-label")).toBe("Open GitHub repository");
    expect(document.querySelector(".brand-foot-github-version")?.textContent).toMatch(/^v/);
    expect(document.querySelector(".brand-foot-menu-version")).toBeNull();

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[3]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[1]);
  });
});
