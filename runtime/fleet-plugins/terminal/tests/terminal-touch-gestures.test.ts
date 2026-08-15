// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { clampFontScale, createTerminalTouchGestures, touchDistance } from "../client/shared/terminal-touch-gestures.js";

function touchEvent(type: string, points: readonly { x: number; y: number }[]): TouchEvent {
  const touches = points.map(({ x, y }) => ({ clientX: x, clientY: y }));
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent & { touches: unknown };
  Object.defineProperty(event, "touches", { value: touches });
  return event;
}

function host() {
  const container = document.createElement("div");
  document.body.append(container);
  const scrollByPixels = vi.fn();
  const onFontScale = vi.fn();
  let scale = 1;
  const gestures = createTerminalTouchGestures(container, { scrollByPixels }, {
    onFontScale: (next) => { scale = next; onFontScale(next); },
    readFontScale: () => scale,
  });
  return { container, scrollByPixels, onFontScale, gestures, currentScale: () => scale };
}

describe("terminal touch gestures", () => {
  it("clamps the font scale into the usable band", () => {
    expect(clampFontScale(1.5)).toBe(1.5);
    expect(clampFontScale(9)).toBe(2.2);
    expect(clampFontScale(0.01)).toBe(0.6);
    expect(clampFontScale(Number.NaN)).toBe(1);
  });

  it("measures the distance between two touches", () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
  });

  it("leaves a tap alone and pans only past the threshold", () => {
    const { container, scrollByPixels, gestures } = host();
    container.dispatchEvent(touchEvent("touchstart", [{ x: 10, y: 100 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 10, y: 104 }]));
    expect(scrollByPixels).not.toHaveBeenCalled();

    container.dispatchEvent(touchEvent("touchmove", [{ x: 10, y: 120 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 10, y: 150 }]));
    // Dragging down reaches older output, the direction a wheel scrolls back.
    expect(scrollByPixels).toHaveBeenCalledWith(-30, { clientX: 10, clientY: 150 });
    gestures.dispose();
  });

  it("scrolls toward newer output when the finger moves up", () => {
    const { container, scrollByPixels, gestures } = host();
    container.dispatchEvent(touchEvent("touchstart", [{ x: 10, y: 200 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 10, y: 180 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 10, y: 160 }]));
    expect(scrollByPixels).toHaveBeenCalledWith(20, { clientX: 10, clientY: 160 });
    gestures.dispose();
  });

  it("scales the font from the pinch it started at and composes across pinches", () => {
    const { container, onFontScale, gestures, currentScale } = host();
    container.dispatchEvent(touchEvent("touchstart", [{ x: 0, y: 0 }, { x: 0, y: 100 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 0, y: 0 }, { x: 0, y: 150 }]));
    expect(onFontScale).toHaveBeenLastCalledWith(1.5);

    container.dispatchEvent(touchEvent("touchend", []));
    container.dispatchEvent(touchEvent("touchstart", [{ x: 0, y: 0 }, { x: 0, y: 100 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 0, y: 0 }, { x: 0, y: 120 }]));
    expect(currentScale()).toBeCloseTo(1.8, 5);
    gestures.dispose();
  });

  it("ignores a pinch that has not moved past the threshold", () => {
    const { container, onFontScale, gestures } = host();
    container.dispatchEvent(touchEvent("touchstart", [{ x: 0, y: 0 }, { x: 0, y: 100 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 0, y: 0 }, { x: 0, y: 102 }]));
    expect(onFontScale).not.toHaveBeenCalled();
    gestures.dispose();
  });

  it("stops reacting after dispose", () => {
    const { container, scrollByPixels, gestures } = host();
    gestures.dispose();
    container.dispatchEvent(touchEvent("touchstart", [{ x: 10, y: 100 }]));
    container.dispatchEvent(touchEvent("touchmove", [{ x: 10, y: 160 }]));
    expect(scrollByPixels).not.toHaveBeenCalled();
  });
});
