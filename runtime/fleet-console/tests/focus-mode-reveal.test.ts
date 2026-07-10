// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FocusModeReveal } from "../core/client/src/components/focus-mode-reveal.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

beforeEach(() => {
  document.body.replaceChildren();
  originalRequestAnimationFrame = window.requestAnimationFrame;
  originalCancelAnimationFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  window.cancelAnimationFrame = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.requestAnimationFrame = originalRequestAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
});

function mountReveal() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(FocusModeReveal, { onExit: () => {} })));
}

describe("FocusModeReveal focus controller", () => {
  it("focuses the reveal on entry and restores a still-connected trigger on exit", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    mountReveal();
    expect(document.activeElement?.className).toBe("focus-mode-reveal");

    act(() => root!.unmount());
    expect(document.activeElement).toBe(trigger);
  });

  it("falls back to a stable control when the entry trigger unmounted before reveal mounted", () => {
    // 실제 경로: context-menu item이 mode 전환과 함께 unmount → activeElement가 body로 떨어진 뒤 reveal mount.
    const menuItem = document.createElement("button");
    document.body.appendChild(menuItem);
    menuItem.focus();
    menuItem.remove();
    expect(document.activeElement).toBe(document.body);

    const fallback = document.createElement("button");
    fallback.className = "side-bar-collapse-btn";
    const host = document.createElement("div");
    host.className = "operations-side-bar";
    host.appendChild(fallback);
    document.body.appendChild(host);

    mountReveal();
    expect(document.activeElement?.className).toBe("focus-mode-reveal");
    act(() => root!.unmount());
    expect(document.activeElement).toBe(fallback);
  });

  it("uses the route fallback when sidebar controls are gone after a route exit", () => {
    mountReveal();
    const back = document.createElement("a");
    back.className = "page-back-link";
    back.href = "#";
    document.body.appendChild(back);
    act(() => root!.unmount());
    expect(document.activeElement).toBe(back);
  });
});
