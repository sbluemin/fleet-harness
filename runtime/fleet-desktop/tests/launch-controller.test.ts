import { describe, expect, it, vi } from "vitest";

import { createLaunchController } from "../src/launch-controller.js";

describe("launch controller", () => {
  it("shows entry before startOrAdopt and arms the exact loopback origin before handoff", async () => {
    const order: string[] = [];
    const contents = { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear: vi.fn(() => order.push("history-cleared")) } };
    const window = { webContents: contents, show: vi.fn(() => order.push("show")), loadURL: vi.fn(async () => { order.push("handoff"); }) };
    const controller = createLaunchController({ createWindow: vi.fn(async () => window), pushEntry: vi.fn(async () => { order.push("entry"); }), startOrAdopt: vi.fn(async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; }), handoffOrigin: vi.fn((origin) => { order.push(`origin=${origin}`); }), onConsoleLoaded: () => { order.push("console-loaded"); } });
    await controller.start();
    expect(order).toEqual(["entry", "show", "start", "origin=http://127.0.0.1:4310", "entry", "handoff", "history-cleared", "console-loaded"]);
  });

  it("clears the bootstrap entry from back history only after the Console handoff succeeds", async () => {
    const order: string[] = [];
    const history = ["file:///desktop/entry/index.html"];
    const contents = {
      executeJavaScript: vi.fn(async () => undefined),
      navigationHistory: { clear: vi.fn(() => {
        order.push("history-cleared");
        history.splice(0, history.length, "http://127.0.0.1:4310/console/");
      }) },
    };
    const window = {
      webContents: contents,
      show: vi.fn(),
      loadURL: vi.fn(async (url: string) => {
        order.push("handoff");
        history.push(url);
      }),
    };
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry: vi.fn(async () => undefined),
      startOrAdopt: vi.fn(async () => "http://127.0.0.1:4310/console/"),
      handoffOrigin: vi.fn(),
      onConsoleLoaded: () => order.push("console-loaded"),
    });

    await controller.start();

    expect(order).toEqual(["handoff", "history-cleared", "console-loaded"]);
    expect(contents.navigationHistory.clear).toHaveBeenCalledOnce();
    expect(history).toEqual(["http://127.0.0.1:4310/console/"]);
  });

  it("does not mislabel supervisor ownership failures as first-run procurement failures", async () => {
    const pushEntry = vi.fn(async () => undefined);
    const onFirstRunFailure = vi.fn(async () => true);
    const window = { webContents: { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear: vi.fn() } }, show: vi.fn(), loadURL: vi.fn(async () => undefined) };
    const controller = createLaunchController({ createWindow: vi.fn(async () => window), pushEntry, startOrAdopt: vi.fn(async () => { throw new Error("cli_daemon_requires_confirmation"); }), handoffOrigin: vi.fn(), onFirstRunFailure });
    await expect(controller.start()).rejects.toThrow("cli_daemon_requires_confirmation");
    expect(onFirstRunFailure).not.toHaveBeenCalled();
    expect(pushEntry).toHaveBeenCalledTimes(1);
  });

  it("does not push or hand off a window destroyed while procurement was pending", async () => {
    let destroyed = false;
    const pushEntry = vi.fn(async () => undefined);
    const window = { isDestroyed: () => destroyed, webContents: { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear: vi.fn() } }, show: vi.fn(), loadURL: vi.fn(async () => { throw new Error("destroyed window"); }) };
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
