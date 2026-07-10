// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FloatingChromeHandles } from "../core/client/src/components/floating-chrome-handles.js";

type HandlesProps = ComponentProps<typeof FloatingChromeHandles>;

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

function mountHandles(props: Partial<HandlesProps>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (next: Partial<HandlesProps>) => {
    const merged: HandlesProps = {
      active: true,
      sidebarClosed: false,
      railClosed: false,
      pendingTarget: null,
      onRestoreSidebar: () => {},
      onRestoreRail: () => {},
      onFocusComplete: () => {},
      ...next,
    };
    act(() => root!.render(createElement(FloatingChromeHandles, merged)));
  };
  render(props);
  return { rerender: render };
}

function handle(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`missing handle: ${label}`);
  return found;
}

describe("FloatingChromeHandles", () => {
  it("renders corner handles only for closed chrome on the active view", () => {
    mountHandles({ sidebarClosed: true, railClosed: false });
    expect(document.querySelector('[aria-label="Expand sidebar"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Show Activity Rail"]')).toBeNull();
  });

  it("renders nothing when the view is inactive even if chrome is closed", () => {
    mountHandles({ active: false, sidebarClosed: true, railClosed: true });
    expect(document.querySelector(".float-handle")).toBeNull();
  });

  it("focuses the sidebar handle while closed and completes the pending transfer", () => {
    const onFocusComplete = vi.fn();
    mountHandles({ sidebarClosed: true, pendingTarget: "sidebar", onFocusComplete });
    expect(document.activeElement).toBe(handle("Expand sidebar"));
    expect(onFocusComplete).toHaveBeenCalledTimes(1);
  });

  it("hands focus to the reopened chrome controller instead of a vanished handle", () => {
    const controller = document.createElement("button");
    controller.className = "side-bar-collapse-btn";
    const host = document.createElement("div");
    host.className = "operations-side-bar";
    host.appendChild(controller);
    document.body.appendChild(host);

    const onFocusComplete = vi.fn();
    mountHandles({ sidebarClosed: false, pendingTarget: "sidebar", onFocusComplete });
    expect(document.activeElement).toBe(controller);
    expect(onFocusComplete).toHaveBeenCalledTimes(1);
  });

  it("hands focus to the controller after a real handle click reopens the chrome", () => {
    const controller = document.createElement("button");
    controller.className = "side-bar-collapse-btn";
    const host = document.createElement("div");
    host.className = "operations-side-bar";
    host.appendChild(controller);
    document.body.appendChild(host);

    // App 배선과 동일하게: 핸들 클릭 → 열림 + pending 설정 → 컨트롤러 포커스
    const onFocusComplete = vi.fn();
    const view = mountHandles({ sidebarClosed: true });
    act(() => handle("Expand sidebar").click());
    view.rerender({ sidebarClosed: false, pendingTarget: "sidebar", onFocusComplete });
    expect(document.activeElement).toBe(controller);
    expect(onFocusComplete).toHaveBeenCalledTimes(1);
  });

  it("completes a pending transfer immediately when the view goes inactive", () => {
    const onFocusComplete = vi.fn();
    mountHandles({ active: false, sidebarClosed: true, pendingTarget: "sidebar", onFocusComplete });
    expect(onFocusComplete).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".float-handle")).toBeNull();
  });

  it("falls back to the rail handle when the rail controller is absent", () => {
    const onFocusComplete = vi.fn();
    mountHandles({ railClosed: true, pendingTarget: "rail", onFocusComplete });
    expect(document.activeElement).toBe(handle("Show Activity Rail"));
    expect(onFocusComplete).toHaveBeenCalledTimes(1);
  });
});
