// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFullscreenCommandBand } from "../core/client/src/components/use-fullscreen-command-band.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "../core/client/src/desktop-fullscreen.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let mediaQuery: TestMediaQuery;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  mediaQuery = new TestMediaQuery(false);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mediaQuery));
  resetDesktopFullscreenSnapshot();
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

  it("reveals on pointer entry and honors the session-local pin", () => {
    mediaQuery.setMatches(true);
    renderProbe();
    act(() => vi.advanceTimersByTime(480));

    act(() => edge().dispatchEvent(new Event("pointerover", { bubbles: true })));
    expect(attribute(band(), "data-visible")).toBe("true");
    act(() => pin().click());
    expect(attribute(pin(), "aria-pressed")).toBe("true");
    act(() => edge().dispatchEvent(new Event("pointerout", { bubbles: true })));
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("true");

    act(() => pin().click());
    expect(attribute(pin(), "aria-pressed")).toBe("false");
    act(() => edge().dispatchEvent(new Event("pointerout", { bubbles: true })));
    act(() => vi.advanceTimersByTime(480));
    expect(attribute(band(), "data-visible")).toBe("false");
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
        "aria-hidden": hidden || undefined,
        inert: hidden || undefined,
        onFocus: fullscreen.reveal,
        onBlur: fullscreen.hideAfterLeave,
      },
      createElement("button", { "data-first-control": "true" }),
      createElement("button", { "data-pin": "true", "aria-pressed": fullscreen.isPinned, onClick: fullscreen.togglePin }),
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

function pin(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("[data-pin]")!;
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
