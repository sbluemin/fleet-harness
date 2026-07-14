import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalScrollGestureTracker,
  isTerminalScrollPointer,
  syncTerminalViewportBackground,
} from "../client/shared/terminal-surface.js";
import {
  createTerminalScrollFollow,
  isTerminalViewportAtBottom,
  type TerminalViewportPosition,
} from "../client/shared/terminal-scroll-follow.js";

describe("terminal scroll follow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tracks wheel, touch, and scrollbar gestures on xterm 6's scroll host", () => {
    const xterm6ScrollHost = new EventTarget();
    const xterm5Viewport = new EventTarget();
    const keyboardTarget = new EventTarget();
    const windowTarget = new EventTarget();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const records = vi.fn();
    vi.stubGlobal("window", Object.assign(windowTarget, {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (handle: number) => frames.delete(handle),
    }));
    const container = {
      querySelector: vi.fn((selector: string) => {
        if (selector === ".xterm-scrollable-element") return xterm6ScrollHost;
        if (selector === ".xterm-viewport") return xterm5Viewport;
        return null;
      }),
    } as unknown as HTMLElement;

    createTerminalScrollGestureTracker(container, keyboardTarget as unknown as HTMLElement, records);

    xterm6ScrollHost.dispatchEvent(new Event("wheel"));
    flushAnimationFrames(frames);
    expect(records).toHaveBeenCalledTimes(1);

    xterm6ScrollHost.dispatchEvent(new Event("touchstart"));
    xterm6ScrollHost.dispatchEvent(new Event("scroll"));
    xterm6ScrollHost.dispatchEvent(new Event("touchend"));
    flushAnimationFrames(frames);
    expect(records).toHaveBeenCalledTimes(2);

    const pointerDown = new Event("pointerdown");
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    xterm6ScrollHost.dispatchEvent(pointerDown);
    xterm6ScrollHost.dispatchEvent(new Event("scroll"));
    windowTarget.dispatchEvent(new Event("pointerup"));
    flushAnimationFrames(frames);
    expect(records).toHaveBeenCalledTimes(3);
    expect(container.querySelector).toHaveBeenCalledWith(".xterm-scrollable-element");
    expect(container.querySelector).not.toHaveBeenCalledWith(".xterm-viewport");
  });

  it("recognizes xterm 6's custom scrollbar descendants as pointer scrolling", () => {
    const scrollHost = new EventTarget() as unknown as HTMLElement;
    const scrollbar = {
      classList: { contains: (token: string) => token === "scrollbar" },
    } as unknown as EventTarget;
    const event = {
      pointerType: "mouse",
      target: new EventTarget(),
      composedPath: () => [scrollbar, scrollHost],
    } as unknown as PointerEvent;

    expect(isTerminalScrollPointer(event, scrollHost)).toBe(true);
  });

  it("fills xterm 6's unused viewport rows with the active terminal background", () => {
    const removeProperty = vi.fn();
    const viewport = { style: { backgroundColor: "", removeProperty } };
    const container = {
      querySelector: vi.fn(() => viewport),
    } as unknown as HTMLElement;

    syncTerminalViewportBackground(container, { background: "oklch(16.5% 0.016 245)" });
    expect(viewport.style.backgroundColor).toBe("oklch(16.5% 0.016 245)");

    syncTerminalViewportBackground(container, {});
    expect(removeProperty).toHaveBeenCalledWith("background-color");
  });

  it("recognizes the bottom in normal and alternate buffers through their public viewport positions", () => {
    expect(isTerminalViewportAtBottom({ baseY: 280, viewportY: 280 })).toBe(true);
    expect(isTerminalViewportAtBottom({ baseY: 280, viewportY: 278 })).toBe(false);
    expect(isTerminalViewportAtBottom({ baseY: 0, viewportY: 0 })).toBe(true);
  });

  it("only lets explicit user scroll gestures change follow intent", () => {
    const harness = createHarness({ baseY: 280, viewportY: 280 });
    harness.viewport = { baseY: 280, viewportY: 260 };
    harness.controller.recordUnclassifiedViewportChange();
    expect(harness.controller.isFollowing()).toBe(true);

    harness.controller.recordUserViewportChange();
    expect(harness.controller.isFollowing()).toBe(false);

    harness.viewport = { baseY: 280, viewportY: 280 };
    harness.controller.recordUserViewportChange();
    expect(harness.controller.isFollowing()).toBe(true);
  });

  it("keeps follow through an unclassified clamp before the debounced geometry fit", () => {
    const harness = createHarness({ baseY: 280, viewportY: 280 });

    // Exact regression ordering: dock removal clamps before ResizeObserver reaches fit().
    harness.viewport = { baseY: 280, viewportY: 278 };
    harness.controller.recordUnclassifiedViewportChange();
    expect(harness.controller.isFollowing()).toBe(true);

    harness.controller.preserveAfterGeometryChange(() => undefined);
    expect(harness.scrolls).toBe(1);
    harness.runFrame();
    expect(harness.scrolls).toBe(2);
  });

  it("pins a followed terminal through row shrink, row growth, and output parsing", () => {
    const harness = createHarness({ baseY: 280, viewportY: 280 });

    harness.controller.preserveAfterGeometryChange(() => {
      harness.viewport = { baseY: 282, viewportY: 282 };
      harness.controller.recordUnclassifiedViewportChange();
    });
    expect(harness.controller.isFollowing()).toBe(true);
    expect(harness.scrolls).toBe(1);

    harness.runFrame();
    expect(harness.scrolls).toBe(2);

    harness.controller.preserveAfterGeometryChange(() => {
      // A dock disappearing grows the viewport and can leave xterm two rows above baseY.
      harness.viewport = { baseY: 280, viewportY: 278 };
      harness.controller.recordUnclassifiedViewportChange();
    });
    expect(harness.controller.isFollowing()).toBe(true);
    expect(harness.scrolls).toBe(3);
    harness.runFrame();
    expect(harness.scrolls).toBe(4);

    harness.controller.restoreAfterOutputParsing();
    expect(harness.scrolls).toBe(5);
    harness.runFrame();
    expect(harness.scrolls).toBe(6);
  });

  it("restores a manual anchor after an unclassified clamp and row shrink", () => {
    const harness = createHarness({ baseY: 280, viewportY: 240 });
    harness.controller.recordUserViewportChange();

    // The browser clamps before the delayed fit; this must not replace the saved 40-row anchor.
    harness.viewport = { baseY: 280, viewportY: 280 };
    harness.controller.recordUnclassifiedViewportChange();
    harness.controller.preserveAfterGeometryChange(() => {
      harness.viewport = { baseY: 282, viewportY: 282 };
      harness.controller.recordUnclassifiedViewportChange();
    });
    expect(harness.scrolls).toBe(0);
    expect(harness.lines).toEqual([242]);
    harness.runFrame();

    expect(harness.controller.isFollowing()).toBe(false);
    expect(harness.scrolls).toBe(0);
    expect(harness.lines).toEqual([242, 242]);
  });

  it("restores a manual anchor after an unclassified clamp and row growth", () => {
    const harness = createHarness({ baseY: 282, viewportY: 242 });
    harness.controller.recordUserViewportChange();

    harness.viewport = { baseY: 282, viewportY: 282 };
    harness.controller.recordUnclassifiedViewportChange();
    harness.controller.preserveAfterGeometryChange(() => {
      harness.viewport = { baseY: 280, viewportY: 280 };
      harness.controller.recordUnclassifiedViewportChange();
    });
    expect(harness.scrolls).toBe(0);
    expect(harness.lines).toEqual([240]);
    harness.runFrame();

    expect(harness.lines).toEqual([240, 240]);
  });

  it("updates the manual anchor after parsed output without scrolling", () => {
    const harness = createHarness({ baseY: 280, viewportY: 240 });
    harness.controller.recordUserViewportChange();

    // Appended output leaves viewportY fixed but increases the bottom distance from 40 to 45.
    harness.viewport = { baseY: 285, viewportY: 240 };
    harness.controller.restoreAfterOutputParsing();
    expect(harness.scrolls).toBe(0);
    expect(harness.lines).toEqual([]);

    harness.controller.preserveAfterGeometryChange(() => {
      harness.viewport = { baseY: 280, viewportY: 280 };
    });
    expect(harness.lines).toEqual([235]);
    harness.runFrame();
    expect(harness.lines).toEqual([235, 235]);
  });

  it("resumes follow for every local input and for active-panel re-entry", () => {
    const harness = createHarness({ baseY: 280, viewportY: 260 });
    harness.controller.recordUserViewportChange();

    harness.controller.resumeFollowing();
    expect(harness.controller.isFollowing()).toBe(true);
    expect(harness.scrolls).toBe(1);
    harness.runFrame();
    expect(harness.scrolls).toBe(2);
  });
});

function flushAnimationFrames(frames: Map<number, FrameRequestCallback>): void {
  while (frames.size > 0) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }
}

function createHarness(initialViewport: TerminalViewportPosition) {
  let frame: FrameRequestCallback | null = null;
  const harness = {
    viewport: initialViewport,
    scrolls: 0,
    lines: [] as number[],
    controller: undefined as ReturnType<typeof createTerminalScrollFollow> | undefined,
    runFrame: () => {
      const callback = frame;
      frame = null;
      callback?.(0);
    },
  };
  harness.controller = createTerminalScrollFollow({
    getViewport: () => harness.viewport,
    scrollToBottom: () => { harness.scrolls += 1; },
    scrollToLine: (line) => { harness.lines.push(line); },
    requestFrame: (callback) => {
      frame = callback;
      return 1;
    },
    cancelFrame: () => { frame = null; },
  });
  return harness as typeof harness & { readonly controller: ReturnType<typeof createTerminalScrollFollow> };
}
