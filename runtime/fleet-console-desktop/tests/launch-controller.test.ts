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
        if (attempts === 1) throw new Error("console_runtime_unavailable");
        return "http://127.0.0.1:4310/console/";
      }),
      handoffOrigin: vi.fn(),
      onFirstRunFailure: vi.fn(async () => true),
      onWindowReady: (push) => { progress = push; },
    });
    await controller.start();
    expect(attempts).toBe(2);
    expect(snapshots).toEqual(["Runtime ready", "Downloading Node runtime", "Installing Fleet Console", "Runtime ready", "Runtime ready"]);
    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:4310/console/");
  });
});
