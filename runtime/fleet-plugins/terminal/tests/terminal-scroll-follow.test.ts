import { describe, expect, it } from "vitest";

import {
  createTerminalScrollFollow,
  isTerminalViewportAtBottom,
  type TerminalViewportPosition,
} from "../client/shared/terminal-scroll-follow.js";

describe("terminal scroll follow", () => {
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
