// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SideBarBrandFoot } from "../core/client/src/components/side-bar-brand-foot.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

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

describe("SideBarBrandFoot drop-up", () => {
  it("focuses the first menu item on open and cycles with arrow keys", () => {
    mountFoot();
    const trigger = document.querySelector<HTMLButtonElement>(".brand-foot-more")!;
    act(() => trigger.click());

    const items = menuItems();
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(items[0]);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[1]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); });
    expect(document.activeElement).toBe(items[0]);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })); });
    expect(document.activeElement).toBe(items[1]);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    mountFoot();
    const trigger = document.querySelector<HTMLButtonElement>(".brand-foot-more")!;
    act(() => trigger.click());
    expect(menuItems()).toHaveLength(2);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  });
});
