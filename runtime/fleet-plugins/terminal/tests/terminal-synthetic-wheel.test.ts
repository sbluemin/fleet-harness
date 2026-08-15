// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  dispatchSyntheticTerminalWheel,
  resolveSyntheticWheelOrigin,
} from "../client/shared/terminal-synthetic-wheel.js";

describe("synthetic terminal wheel", () => {
  it("prefers the finger origin when both axes are finite", () => {
    expect(resolveSyntheticWheelOrigin(
      { clientX: 12, clientY: 40 },
      { left: 0, top: 0, width: 100, height: 80 },
    )).toEqual({ clientX: 12, clientY: 40 });
  });

  it("falls back to the target centre when the origin is missing or not finite", () => {
    expect(resolveSyntheticWheelOrigin(
      { clientX: Number.NaN, clientY: 10 },
      { left: 10, top: 20, width: 40, height: 30 },
    )).toEqual({ clientX: 30, clientY: 35 });
    expect(resolveSyntheticWheelOrigin(
      undefined,
      { left: 0, top: 0, width: 20, height: 10 },
    )).toEqual({ clientX: 10, clientY: 5 });
  });

  it("refuses to invent a coordinate when neither origin nor rect is usable", () => {
    expect(resolveSyntheticWheelOrigin({ clientX: Number.NaN, clientY: Number.NaN }, null)).toBeNull();
    expect(resolveSyntheticWheelOrigin(undefined, null)).toBeNull();
    expect(resolveSyntheticWheelOrigin(
      undefined,
      { left: Number.NaN, top: 0, width: 10, height: 10 },
    )).toBeNull();
  });

  it("dispatches a wheel whose client point is finite, never the default-empty constructor", () => {
    const target = document.createElement("div");
    document.body.append(target);
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ left: 8, top: 16, width: 40, height: 20, right: 48, bottom: 36, x: 8, y: 16, toJSON() { return {}; } }),
    });
    const seen: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => { seen.push(event); });

    expect(dispatchSyntheticTerminalWheel(target, 24, { clientX: 11, clientY: 19 })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.deltaY).toBe(24);
    expect(seen[0]!.deltaMode).toBe(0);
    expect(Number.isFinite(seen[0]!.clientX)).toBe(true);
    expect(Number.isFinite(seen[0]!.clientY)).toBe(true);
    expect(seen[0]!.clientX).toBe(11);
    expect(seen[0]!.clientY).toBe(19);
    expect(String(seen[0]!.clientX)).not.toBe("NaN");
    expect(String(seen[0]!.clientY)).not.toBe("NaN");
  });

  it("dispatches the rect centre when the origin is missing or one axis is not finite", () => {
    const target = document.createElement("div");
    document.body.append(target);
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 40, height: 30, right: 50, bottom: 50, x: 10, y: 20, toJSON() { return {}; } }),
    });
    const seen: WheelEvent[] = [];
    target.addEventListener("wheel", (event) => { seen.push(event); });

    expect(dispatchSyntheticTerminalWheel(target, 16)).toBe(true);
    expect(dispatchSyntheticTerminalWheel(target, 16, { clientX: Number.NaN, clientY: 10 })).toBe(true);
    expect(dispatchSyntheticTerminalWheel(target, 16, { clientX: Number.POSITIVE_INFINITY, clientY: 10 })).toBe(true);
    expect(seen).toHaveLength(3);
    for (const event of seen) {
      expect(event.clientX).toBe(30);
      expect(event.clientY).toBe(35);
      expect(String(event.clientX)).not.toBe("NaN");
      expect(String(event.clientY)).not.toBe("NaN");
    }
  });

  it("does not dispatch a zero, non-finite, or unlocated wheel", () => {
    const target = document.createElement("div");
    const seen: Event[] = [];
    target.addEventListener("wheel", (event) => { seen.push(event); });
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ left: Number.NaN, top: Number.NaN, width: Number.NaN, height: Number.NaN }),
    });

    expect(dispatchSyntheticTerminalWheel(target, 0, { clientX: 1, clientY: 1 })).toBe(false);
    expect(dispatchSyntheticTerminalWheel(target, Number.NaN, { clientX: 1, clientY: 1 })).toBe(false);
    expect(dispatchSyntheticTerminalWheel(target, 10)).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
