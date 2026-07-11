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

  it("attaches the non-macOS close guard before procurement resolves", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      let close: ((event: { preventDefault(): void }) => void) | undefined;
      const window = { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }), isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
      const lifecycle = createDesktopLifecycle({ on: vi.fn(), quit: vi.fn() } as never, async () => new Promise(() => undefined) as never, async () => undefined);
      lifecycle.attachWindow(window as never);
      const event = { preventDefault: vi.fn() };
      close?.(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(window.hide).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("allows close through once quit preparation has started", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      let close: ((event: { preventDefault(): void }) => void) | undefined;
      let finishStop: (() => void) | undefined;
      const window = { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }), isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
      const lifecycle = createDesktopLifecycle({ on: vi.fn(), quit: vi.fn() } as never, async () => window as never, () => new Promise<void>((resolve) => { finishStop = resolve; }));
      lifecycle.attachWindow(window as never);
      const preparation = lifecycle.prepareToQuit();
      const event = { preventDefault: vi.fn() };
      close?.(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(window.hide).not.toHaveBeenCalled();
      finishStop?.();
      await preparation;
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("keeps macOS close unguarded so the application lifecycle remains active", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      let close: ((event: { preventDefault(): void }) => void) | undefined;
      const window = { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }), isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
      const lifecycle = createDesktopLifecycle({ on: vi.fn(), quit: vi.fn() } as never, async () => window as never, async () => undefined);
      lifecycle.attachWindow(window as never);
      const event = { preventDefault: vi.fn() };
      close?.(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(window.hide).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
