import { describe, expect, it, vi } from "vitest";

import { createLaunchController } from "../src/launch-controller.js";

describe("launch controller", () => {
  it("shows entry before startOrAdopt and arms the exact loopback origin before handoff", async () => {
    const order: string[] = [];
    const contents = { executeJavaScript: vi.fn(async () => undefined) };
    const window = { webContents: contents, show: vi.fn(() => order.push("show")), loadURL: vi.fn(async () => { order.push("handoff"); }) };
    const controller = createLaunchController({ createWindow: vi.fn(async () => window), pushEntry: vi.fn(async () => { order.push("entry"); }), startOrAdopt: vi.fn(async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; }), handoffOrigin: vi.fn((origin) => { order.push(`origin=${origin}`); }) });
    await controller.start();
    expect(order).toEqual(["entry", "show", "start", "origin=http://127.0.0.1:4310", "entry", "handoff"]);
  });

  it("synchronizes the Console-owned title bar theme after origin activation and before handoff", async () => {
    const order: string[] = [];
    const window = { webContents: { executeJavaScript: vi.fn(async () => undefined) }, show: vi.fn(), loadURL: vi.fn(async () => { order.push("handoff"); }) };
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry: vi.fn(async () => undefined),
      startOrAdopt: vi.fn(async () => "http://127.0.0.1:4310/console/"),
      handoffOrigin: vi.fn(() => { order.push("origin"); }),
      synchronizeTheme: vi.fn(async () => { order.push("theme"); }),
    });

    await controller.start();

    expect(order).toEqual(["origin", "theme", "handoff"]);
  });

  it("wires runtime progress, first-run failure Retry, and same-window handoff through the production launch graph", async () => {
    const snapshots: string[] = [];
    let progress: ((state: "checking" | "node" | "installing" | "offline" | "firstfail" | "starting" | "dev", detail?: string, progress?: number) => Promise<void>) | undefined;
    const contents = { executeJavaScript: vi.fn(async () => undefined) };
    const window = { webContents: contents, show: vi.fn(), loadURL: vi.fn(async () => undefined) };
    let attempts = 0;
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry: vi.fn(async (_contents, snapshot) => { snapshots.push(snapshot.steps[0]?.name ?? ""); }),
      startOrAdopt: vi.fn(async () => {
        attempts += 1;
        await progress?.(attempts === 1 ? "node" : "installing", "Fleet Console 1.2.4", 50);
        if (attempts < 3) throw new Error("console_runtime_unavailable");
        return "http://127.0.0.1:4310/console/";
      }),
      handoffOrigin: vi.fn(),
      onFirstRunFailure: vi.fn(async () => true),
      onWindowReady: (push) => { progress = push; },
    });
    await controller.start();
    expect(attempts).toBe(3);
    expect(snapshots).toEqual(["Runtime ready", "Downloading Node runtime", "Installing Fleet Console", "Runtime ready", "Installing Fleet Console", "Runtime ready", "Runtime ready"]);
    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:4310/console/");
  });

  it("does not mislabel supervisor ownership failures as first-run procurement failures", async () => {
    const pushEntry = vi.fn(async () => undefined);
    const onFirstRunFailure = vi.fn(async () => true);
    const window = { webContents: { executeJavaScript: vi.fn(async () => undefined) }, show: vi.fn(), loadURL: vi.fn(async () => undefined) };
    const controller = createLaunchController({ createWindow: vi.fn(async () => window), pushEntry, startOrAdopt: vi.fn(async () => { throw new Error("cli_daemon_requires_confirmation"); }), handoffOrigin: vi.fn(), onFirstRunFailure });
    await expect(controller.start()).rejects.toThrow("cli_daemon_requires_confirmation");
    expect(onFirstRunFailure).not.toHaveBeenCalled();
    expect(pushEntry).toHaveBeenCalledTimes(1);
  });

  it("does not push or hand off a window destroyed while procurement was pending", async () => {
    let destroyed = false;
    const pushEntry = vi.fn(async () => undefined);
    const window = { isDestroyed: () => destroyed, webContents: { executeJavaScript: vi.fn(async () => undefined) }, show: vi.fn(), loadURL: vi.fn(async () => { throw new Error("destroyed window"); }) };
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry,
      startOrAdopt: vi.fn(async () => { destroyed = true; return "http://127.0.0.1:4310/console/"; }),
      handoffOrigin: vi.fn(),
    });
    await expect(controller.start()).resolves.toBe(window);
    expect(pushEntry).toHaveBeenCalledOnce();
    expect(window.loadURL).not.toHaveBeenCalled();
  });
});
