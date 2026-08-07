// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFullscreenCommandBand } from "../core/client/src/components/use-fullscreen-command-band.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "../core/client/src/desktop-fullscreen.js";
import { getCommandBandDocked, setCommandBandDocked } from "../core/client/src/fullscreen-band-store.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let mediaQuery: TestMediaQuery;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  mediaQuery = new TestMediaQuery(false);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mediaQuery));
  resetDesktopFullscreenSnapshot();
  localStorage.clear();
  setCommandBandDocked(false);
  delete document.documentElement.dataset.desktopShell;
  document.body.replaceChildren();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetDesktopFullscreenSnapshot();
  setCommandBandDocked(false);
  localStorage.clear();
  delete document.documentElement.dataset.desktopShell;
});

describe("useFullscreenCommandBand", () => {
  it("honors the initial display-mode media-query state and hides after the initial reveal", () => {
    mediaQuery.setMatches(true);
    renderProbe();

    expect(attribute(band(), "data-fullscreen")).toBe("true");
    expect(attribute(band(), "data-visible")).toBe("true");
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");
    expect(attribute(band(), "aria-hidden")).toBe("true");
    expect(band().hasAttribute("inert")).toBe(true);
  });

  it("restores synchronously on fullscreen exit and clears the pending initial hide", () => {
    renderProbe();
    act(() => mediaQuery.setMatches(true));
    expect(attribute(band(), "data-fullscreen")).toBe("true");
    act(() => mediaQuery.setMatches(false));

    expect(attribute(band(), "data-fullscreen")).toBe("false");
    expect(attribute(band(), "data-visible")).toBe("true");
    expect(band().hasAttribute("aria-hidden")).toBe(false);
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");
  });

  it("uses native fullscreen only for an explicitly marked Desktop shell", () => {
    renderProbe();
    act(() => applyDesktopFullscreenSnapshot({ fullscreen: true }));
    expect(attribute(band(), "data-fullscreen")).toBe("false");

    document.documentElement.dataset.desktopShell = "true";
    act(() => applyDesktopFullscreenSnapshot({ fullscreen: false }));
    act(() => applyDesktopFullscreenSnapshot({ fullscreen: true }));
    expect(attribute(band(), "data-fullscreen")).toBe("true");
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");

    act(() => applyDesktopFullscreenSnapshot({ fullscreen: false }));
    expect(attribute(band(), "data-fullscreen")).toBe("false");
    expect(attribute(band(), "data-visible")).toBe("true");
  });

  it("reveals on edge focus, retains focus safely, and hides 480ms after focus leaves", () => {
    mediaQuery.setMatches(true);
    renderProbe();
    act(() => vi.advanceTimersByTime(480));

    act(() => edge().focus());
    expect(attribute(band(), "data-visible")).toBe("true");
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");

    act(() => firstControl().focus());
    expect(document.activeElement).toBe(firstControl());
    act(() => outside().focus());
    act(() => vi.advanceTimersByTime(479));
    expect(attribute(band(), "data-visible")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(attribute(band(), "data-visible")).toBe("false");
  });

  it("keeps the band visible while docked and returns to auto-hide when undocked", () => {
    mediaQuery.setMatches(true);
    renderProbe();
    act(() => vi.advanceTimersByTime(480));

    act(() => edge().dispatchEvent(new Event("pointerover", { bubbles: true })));
    expect(attribute(band(), "data-visible")).toBe("true");
    act(() => dockToggle().click());
    expect(attribute(dockToggle(), "aria-pressed")).toBe("true");
    expect(attribute(band(), "data-docked")).toBe("true");
    act(() => edge().dispatchEvent(new Event("pointerout", { bubbles: true })));
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");

    act(() => dockToggle().click());
    expect(attribute(dockToggle(), "aria-pressed")).toBe("false");
    expect(attribute(band(), "data-docked")).toBe("false");
    // 도킹 해제는 즉시 증발시키지 않고 이탈과 같은 유예를 준다.
    expect(attribute(band(), "data-visible")).toBe("true");
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");
  });

  it("remembers the docked choice across a remount", () => {
    mediaQuery.setMatches(true);
    renderProbe();
    act(() => vi.advanceTimersByTime(480));
    act(() => dockToggle().click());
    expect(getCommandBandDocked()).toBe(true);
    expect(localStorage.getItem("fleet-console.fullscreen-band.docked")).toBe("1");

    act(() => root!.unmount());
    root = createRoot(container!);
    renderProbe();

    expect(attribute(band(), "data-docked")).toBe("true");
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");
  });

  it("reveals only after sustained upward intent below the instant edge, and never while dragging", () => {
    mediaQuery.setMatches(true);
    renderProbe();
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");

    // 레인 밖(>=32px)은 아무리 올라가도 발화하지 않는다.
    act(() => movePointer(200));
    act(() => movePointer(120));
    act(() => vi.advanceTimersByTime(120));
    expect(attribute(band(), "data-visible")).toBe("false");

    // 레인 안이라도 버튼을 누른 채 올라오는 것은 캔버스 패닝이다.
    act(() => movePointer(20, 1));
    act(() => vi.advanceTimersByTime(120));
    expect(attribute(band(), "data-visible")).toBe("false");

    // 아래로 꺾으면 dwell이 취소된다.
    act(() => movePointer(20));
    act(() => vi.advanceTimersByTime(60));
    act(() => movePointer(28));
    act(() => vi.advanceTimersByTime(120));
    expect(attribute(band(), "data-visible")).toBe("false");

    // 유지된 상승 의도만 120ms 뒤에 발화한다.
    act(() => movePointer(24));
    act(() => vi.advanceTimersByTime(119));
    expect(attribute(band(), "data-visible")).toBe("false");
    act(() => vi.advanceTimersByTime(1));
    expect(attribute(band(), "data-visible")).toBe("true");

    // 의도로 내려온 밴드도 스스로 물러난다 — 포인터가 밴드 밖에 있는 채로 발화하므로
    // 진입/이탈 쌍이 생기지 않고, 유예를 걸어 두지 않으면 영영 숨지 않는다.
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");
  });

  it("does not observe pointer intent while docked", () => {
    mediaQuery.setMatches(true);
    const addSpy = vi.spyOn(window, "addEventListener");
    setCommandBandDocked(true);
    renderProbe();

    expect(addSpy.mock.calls.some(([type]) => type === "pointermove")).toBe(false);
    expect(attribute(band(), "data-docked")).toBe("true");
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");
  });

  it("does not hide while the interaction guard reports focus or pointer containment", () => {
    mediaQuery.setMatches(true);
    let canHide = false;
    act(() => root!.render(createElement(FullscreenBandProbe, { canHide: () => canHide } as never)));

    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");

    canHide = true;
    act(() => edge().dispatchEvent(new Event("pointerout", { bubbles: true })));
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");
  });

  it("cleans media listeners and timers across StrictMode remounts", () => {
    mediaQuery.setMatches(true);
    act(() => root!.render(createElement(StrictMode, null, createElement(FullscreenBandProbe))));

    expect(mediaQuery.added).toBe(2);
    expect(mediaQuery.removed).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(mediaQuery.removed).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function renderProbe(): void {
  act(() => root!.render(createElement(FullscreenBandProbe)));
}

function movePointer(clientY: number, buttons = 0): void {
  window.dispatchEvent(new MouseEvent("pointermove", { clientY, buttons }));
}

function FullscreenBandProbe(props?: { readonly canHide?: () => boolean }) {
  const canHide = props?.canHide;
  const fullscreen = useFullscreenCommandBand(canHide);
  const hidden = fullscreen.isFullscreen && !fullscreen.isVisible;
  return createElement(
    "div",
    null,
    createElement("button", {
      "data-edge": "true",
      onFocus: fullscreen.reveal,
      onPointerEnter: fullscreen.reveal,
      onPointerLeave: fullscreen.hideAfterLeave,
    }),
    createElement(
      "header",
      {
        "data-band": "true",
        "data-fullscreen": String(fullscreen.isFullscreen),
        "data-visible": String(fullscreen.isVisible),
        "data-docked": String(fullscreen.isDocked),
        "aria-hidden": hidden || undefined,
        inert: hidden || undefined,
        onFocus: fullscreen.reveal,
        onBlur: fullscreen.hideAfterLeave,
      },
      createElement("button", { "data-first-control": "true" }),
      createElement("button", { "data-dock-toggle": "true", "aria-pressed": fullscreen.isDocked, onClick: fullscreen.toggleDock }),
    ),
    createElement("button", { "data-outside": "true" }),
  );
}

function band(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-band]")!;
}

function edge(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("[data-edge]")!;
}

function firstControl(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("[data-first-control]")!;
}

function dockToggle(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("[data-dock-toggle]")!;
}

function outside(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("[data-outside]")!;
}

function attribute(element: Element, name: string): string | null {
  return element.getAttribute(name);
}

class TestMediaQuery {
  matches: boolean;
  added = 0;
  removed = 0;
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== "change" || typeof listener !== "function") return;
    this.added += 1;
    this.listeners.add(listener as (event: MediaQueryListEvent) => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== "change" || typeof listener !== "function") return;
    this.removed += 1;
    this.listeners.delete(listener as (event: MediaQueryListEvent) => void);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    const event = { matches, media: "(display-mode: fullscreen)" } as MediaQueryListEvent;
    for (const listener of this.listeners) listener(event);
  }
}
