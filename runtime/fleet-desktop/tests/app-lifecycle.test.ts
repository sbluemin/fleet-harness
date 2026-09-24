import { describe, expect, it, vi } from "vitest";

import { createDesktopLifecycle } from "../src/app-lifecycle.js";
import { createQuitFarewell } from "../src/quit-farewell.js";

describe("desktop lifecycle", () => {
  it("focuses the existing window for a second launch and only stops on explicit quit", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = { on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)), quit: vi.fn() };
    const window = { base: { on: vi.fn() }, isDestroyed: () => false, show: vi.fn(), focus: vi.fn() };
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
      const window = { base: { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }) }, isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
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
      const window = { base: { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }) }, isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
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
      const window = { base: { on: vi.fn((_event: string, listener: typeof close) => { close = listener; }) }, isDestroyed: () => false, show: vi.fn(), focus: vi.fn(), hide: vi.fn() };
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

  it("never lets the quit farewell hold up quit or outlive a failed quit", async () => {
    const shell = {
      isDestroyed: () => false,
      base: { on: vi.fn(), off: vi.fn(), isVisible: () => true, isMinimized: () => false, setOpacity: vi.fn() },
      stack: { layoutConsole: () => ({ x: 0, y: 0, width: 900, height: 600 }), presentVeil: vi.fn(), removeVeil: vi.fn() },
      consoleContents: { getZoomFactor: () => 1 },
      show: vi.fn(), focus: vi.fn(),
    };
    const never = () => new Promise<never>(() => undefined);
    const lifecycleWith = (farewell: { loadFile: () => Promise<void>; push: (phase: string) => Promise<void> }, stop: () => Promise<void>) => {
      const app = { on: vi.fn(), quit: vi.fn() };
      const view = { setBounds: vi.fn(), webContents: { loadFile: farewell.loadFile, setZoomFactor: vi.fn(), executeJavaScript: vi.fn(async () => false), close: vi.fn() } };
      const run = createQuitFarewell({
        shell: () => shell as never,
        createView: () => view as never,
        entryPagePath: "/entry/index.html",
        snapshot: (phase) => ({ platform: "darwin", lang: "en", dev: false, tagline: "", tone: "busy", title: "Quitting Fleet…", versions: "", farewell: phase }),
        pushEntry: async (_contents, snapshot) => farewell.push(snapshot.farewell ?? ""),
        // 실제 시간 순서만 남기고 줄인다 — 띄우기 제한(600ms)이 판을 얹는 짧은 대기들보다 늦게 끝난다.
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms >= 600 ? 5 : 0)),
      }).run;
      return { app, view, lifecycle: createDesktopLifecycle(app as never, async () => shell as never, () => run(stop)) };
    };

    // 판이 끝내 뜨지 않아도 Console은 멈추고 앱은 종료된다.
    const stuck = lifecycleWith({ loadFile: never, push: async () => undefined }, vi.fn(async () => undefined));
    await stuck.lifecycle.quit();
    expect(stuck.app.quit).toHaveBeenCalledOnce();

    // 판을 얹은 뒤 전환이 멈춘 채 정지가 실패해도, 판은 걷히고 Console이 다시 보인다.
    const failed = lifecycleWith({ loadFile: async () => undefined, push: (phase) => phase === "shown" ? never() : Promise.resolve() }, async () => { throw new Error("console_lock_process_unhealthy"); });
    await expect(failed.lifecycle.prepareToQuit()).rejects.toThrow("console_lock_process_unhealthy");
    expect(shell.stack.presentVeil).toHaveBeenCalledWith(failed.view);
    expect(shell.stack.removeVeil).toHaveBeenCalledWith(failed.view);
    expect(failed.app.quit).not.toHaveBeenCalled();
  });
});
