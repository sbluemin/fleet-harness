import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRenderScheduler } from "../src/app.js";

const HIDDEN_CURSOR_FRAME = "\x1b[?25l";
const RENDER_THROTTLE_MS = 16;
const VISIBLE_CURSOR_FRAME = "\x1b[1;3H\x1b[?25h";

describe("app cursor policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps mode-toggle cursor suppression through exactly one flushed render", async () => {
    const renderedFrames: string[] = [];
    let cursorTarget: "visible" | undefined = "visible";
    let modeToggleSuppressed = false;
    const ui = {
      requestRender(_force = false, afterRender?: () => void): void {
        setTimeout(() => {
          renderedFrames.push(cursorTarget === undefined ? HIDDEN_CURSOR_FRAME : VISIBLE_CURSOR_FRAME);
          afterRender?.();
        }, RENDER_THROTTLE_MS);
      },
    };
    const syncCursorPolicy = () => {
      cursorTarget = modeToggleSuppressed ? undefined : "visible";
    };
    const scheduleRender = createRenderScheduler(ui, syncCursorPolicy);
    const onModeChange = () => {
      modeToggleSuppressed = true;
      cursorTarget = undefined;
      scheduleRender(() => {
        modeToggleSuppressed = false;
        syncCursorPolicy();
        ui.requestRender();
      });
    };

    onModeChange();
    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS);
    expect(renderedFrames).toEqual([]);

    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS);
    expect(renderedFrames).toEqual([HIDDEN_CURSOR_FRAME]);
    expect(modeToggleSuppressed).toBe(false);

    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS + 1);
    expect(renderedFrames).toEqual([HIDDEN_CURSOR_FRAME, VISIBLE_CURSOR_FRAME]);
  });
});
