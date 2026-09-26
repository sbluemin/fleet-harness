import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createZenFullscreenController } from "../src/desktop-window-command.js";

type FullscreenEvent = "enter-full-screen" | "leave-full-screen";

/**
 * Electron's full-screen event order differs by platform: on Windows the event fires synchronously inside
 * setFullScreen *before* the window state changes; on macOS it fires after the animation, with the state
 * already changed. Zen must end up in the requested state under both, however quickly it is toggled.
 */
function fakeWindow(order: "windows" | "macos") {
  const listeners: Record<FullscreenEvent, Set<() => void>> = { "enter-full-screen": new Set(), "leave-full-screen": new Set() };
  let fullscreen = false;
  const emit = (event: FullscreenEvent) => { for (const listener of [...listeners[event]]) listener(); };
  return {
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setFullScreen: (flag: boolean) => {
      if (fullscreen === flag) return;
      const event: FullscreenEvent = flag ? "enter-full-screen" : "leave-full-screen";
      if (order === "windows") { emit(event); fullscreen = flag; return; }
      setTimeout(() => { fullscreen = flag; emit(event); }, 300);
    },
    on: (event: FullscreenEvent, listener: () => void) => listeners[event].add(listener),
    removeListener: (event: FullscreenEvent, listener: () => void) => listeners[event].delete(listener),
  };
}

describe("Zen fullscreen controller", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  for (const order of ["windows", "macos"] as const) {
    it(`follows the last Zen wish through rapid toggles (${order} event order)`, async () => {
      const window = fakeWindow(order);
      const controller = createZenFullscreenController(window);
      for (let index = 0; index < 7; index += 1) {
        controller.perform(index % 2 === 0 ? "enter-fullscreen" : "leave-fullscreen");
        await vi.advanceTimersByTimeAsync(60);
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(window.isFullScreen()).toBe(true);
      for (let round = 0; round < 3; round += 1) {
        controller.perform("leave-fullscreen");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(window.isFullScreen()).toBe(false);
        controller.perform("enter-fullscreen");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(window.isFullScreen()).toBe(true);
      }
      controller.stop();
    });
  }
});
