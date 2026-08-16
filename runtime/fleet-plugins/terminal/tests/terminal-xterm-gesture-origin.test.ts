// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { createXtermGestureOriginGuard } from "../client/shared/terminal-xterm-gesture-origin.js";

const GESTURE_CHANGE = "-xterm-gesturechange";

function screenWithRect(rect = { left: 10, top: 20, width: 80, height: 40 }): HTMLElement {
  const screen = document.createElement("div");
  Object.defineProperty(screen, "getBoundingClientRect", {
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON() { return {}; },
    }),
  });
  document.body.append(screen);
  return screen;
}

function gestureChange(point?: { readonly clientX: number; readonly clientY: number }): Event & {
  readonly clientX?: number;
  readonly clientY?: number;
} {
  const event = new CustomEvent(GESTURE_CHANGE, { bubbles: false, cancelable: true }) as Event & {
    readonly clientX?: number;
    readonly clientY?: number;
  };
  if (point) {
    Object.defineProperties(event, {
      clientX: { configurable: true, value: point.clientX },
      clientY: { configurable: true, value: point.clientY },
    });
  }
  return event;
}

describe("xterm gesture origin guard", () => {
  it("keeps the real finger point unchanged", () => {
    const screen = screenWithRect();
    const guard = createXtermGestureOriginGuard(screen);
    const seen: Array<{ x?: number; y?: number }> = [];
    screen.addEventListener(GESTURE_CHANGE, (rawEvent) => {
      const event = rawEvent as Event & { readonly clientX?: number; readonly clientY?: number };
      seen.push({ x: event.clientX, y: event.clientY });
    });

    screen.dispatchEvent(gestureChange({ clientX: 12, clientY: 34 }));

    expect(seen).toEqual([{ x: 12, y: 34 }]);
    guard.dispose();
  });

  it("carries the last finger point into xterm inertia events", () => {
    const screen = screenWithRect();
    const guard = createXtermGestureOriginGuard(screen);
    const seen: Array<{ x?: number; y?: number }> = [];
    screen.addEventListener(GESTURE_CHANGE, (rawEvent) => {
      const event = rawEvent as Event & { readonly clientX?: number; readonly clientY?: number };
      seen.push({ x: event.clientX, y: event.clientY });
    });

    screen.dispatchEvent(gestureChange({ clientX: 12, clientY: 34 }));
    const event = gestureChange();
    expect(screen.dispatchEvent(event)).toBe(true);

    expect(seen).toEqual([{ x: 12, y: 34 }, { x: 12, y: 34 }]);
    expect(Number.isFinite(event.clientX)).toBe(true);
    expect(Number.isFinite(event.clientY)).toBe(true);
    expect(String(event.clientX)).not.toBe("NaN");
    expect(String(event.clientY)).not.toBe("NaN");
    guard.dispose();
  });

  it("falls back to the screen centre before any finger point has been observed", () => {
    const screen = screenWithRect();
    const guard = createXtermGestureOriginGuard(screen);
    const seen: Array<{ x?: number; y?: number }> = [];
    screen.addEventListener(GESTURE_CHANGE, (rawEvent) => {
      const event = rawEvent as Event & { readonly clientX?: number; readonly clientY?: number };
      seen.push({ x: event.clientX, y: event.clientY });
    });

    screen.dispatchEvent(gestureChange());

    expect(seen).toEqual([{ x: 50, y: 40 }]);
    guard.dispose();
  });

  it("blocks a coordinate-less inertia event when the screen rect is unusable", () => {
    const screen = screenWithRect({ left: Number.NaN, top: 20, width: 80, height: 40 });
    const guard = createXtermGestureOriginGuard(screen);
    const downstream = vi.fn();
    screen.addEventListener(GESTURE_CHANGE, downstream);

    const event = gestureChange();
    expect(screen.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    guard.dispose();
  });

  it("stops guarding after disposal", () => {
    const screen = screenWithRect();
    const guard = createXtermGestureOriginGuard(screen);
    guard.dispose();
    const seen: Array<{ x?: number; y?: number }> = [];
    screen.addEventListener(GESTURE_CHANGE, (rawEvent) => {
      const event = rawEvent as Event & { readonly clientX?: number; readonly clientY?: number };
      seen.push({ x: event.clientX, y: event.clientY });
    });

    screen.dispatchEvent(gestureChange());

    expect(seen).toEqual([{ x: undefined, y: undefined }]);
  });
});
