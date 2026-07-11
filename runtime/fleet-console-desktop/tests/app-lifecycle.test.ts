import { describe, expect, it, vi } from "vitest";

import { createDesktopLifecycle } from "../src/app-lifecycle.js";

describe("desktop lifecycle", () => {
  it("focuses the existing window for a second launch and only stops on explicit quit", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = { on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)), quit: vi.fn() };
    const window = { on: vi.fn(), isDestroyed: () => false, show: vi.fn(), focus: vi.fn() };
    const stop = vi.fn(async () => undefined);
    const lifecycle = createDesktopLifecycle(app as never, async () => window as never, stop);

    await lifecycle.start();
    listeners.get("second-instance")?.();

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    await lifecycle.quit();
    expect(stop).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("hides a non-macOS close instead of creating another service lifecycle", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      let close: ((event: { preventDefault(): void }) => void) | undefined;
      const window = { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }), isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
      const lifecycle = createDesktopLifecycle({ on: vi.fn(), quit: vi.fn() } as never, async () => window as never, async () => undefined);
      await lifecycle.start();
      const event = { preventDefault: vi.fn() };
      close?.(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(window.hide).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
