import { describe, expect, it, vi } from "vitest";

import { createDesktopLifecycle } from "../src/app-lifecycle.js";

describe("desktop window relaunch", () => {
  it("restores a minimized window when a second launch requests it", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = { on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)), quit: vi.fn() };
    const window = { on: vi.fn(), isDestroyed: () => false, isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    const lifecycle = createDesktopLifecycle(app as never, async () => window as never, async () => undefined);

    await lifecycle.start();
    listeners.get("second-instance")?.();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
