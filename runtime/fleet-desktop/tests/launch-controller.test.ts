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

  it("does not clear history when the Console handoff fails", async () => {
    const clear = vi.fn();
    const window = {
      webContents: { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear } },
      show: vi.fn(),
      loadURL: vi.fn(async () => { throw new Error("console_load_failed"); }),
    };
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry: vi.fn(async () => undefined),
      startOrAdopt: vi.fn(async () => "http://127.0.0.1:4310/console/"),
      handoffOrigin: vi.fn(),
    });

    await expect(controller.start()).rejects.toThrow("console_load_failed");
    expect(clear).not.toHaveBeenCalled();
  });

  it("does not clear history if the window closes during the Console handoff", async () => {
    let destroyed = false;
    const clear = vi.fn();
    const onConsoleLoaded = vi.fn();
    const window = {
      isDestroyed: () => destroyed,
      webContents: { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear } },
      show: vi.fn(),
      loadURL: vi.fn(async () => { destroyed = true; }),
    };
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry: vi.fn(async () => undefined),
      startOrAdopt: vi.fn(async () => "http://127.0.0.1:4310/console/"),
      handoffOrigin: vi.fn(),
      onConsoleLoaded,
    });

    await controller.start();
    expect(clear).not.toHaveBeenCalled();
    expect(onConsoleLoaded).not.toHaveBeenCalled();
  });

  it("synchronizes the Console-owned title bar theme after origin activation and before handoff", async () => {
    const order: string[] = [];
    const window = { webContents: { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear: vi.fn() } }, show: vi.fn(), loadURL: vi.fn(async () => { order.push("handoff"); }) };
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

  it("activates native fullscreen publishing only after the Console handoff completes", async () => {
    const order: string[] = [];
    const window = { webContents: { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear: vi.fn(() => order.push("history")) } }, show: vi.fn(), loadURL: vi.fn(async () => { order.push("handoff"); }) };
    const controller = createLaunchController({
      createWindow: vi.fn(async () => window),
      pushEntry: vi.fn(async () => undefined),
      startOrAdopt: vi.fn(async () => "http://127.0.0.1:4310/console/"),
      handoffOrigin: vi.fn(() => order.push("origin")),
      synchronizeFullscreen: vi.fn(() => { order.push("fullscreen"); }),
    });

    await controller.start();
    expect(order).toEqual(["origin", "handoff", "history", "fullscreen"]);
  });

  it("wires runtime progress, first-run failure Retry, and same-window handoff through the production launch graph", async () => {
    const snapshots: string[] = [];
    let progress: ((state: "checking" | "node" | "installing" | "offline" | "firstfail" | "starting" | "dev", detail?: string, progress?: number) => Promise<void>) | undefined;
    const contents = { executeJavaScript: vi.fn(async () => undefined), navigationHistory: { clear: vi.fn() } };
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

describe("startup runtime choice", () => {
  it("asks before it procures anything and never remembers the answer", async () => {
    const order: string[] = [];
    const chooseRuntime = vi.fn(async () => { order.push("ask"); return { kind: "local" } as const; });
    const controller = createLaunchController({
      ...launchDefaults(order),
      chooseRuntime,
      startOrAdopt: async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; },
    });

    await controller.start();
    await controller.start();

    // 두 번째 실행도 묻는다 — 답을 기억하면 어제의 선택이 오늘 조용히 붙는다.
    expect(chooseRuntime).toHaveBeenCalledTimes(2);
    expect(order.indexOf("ask")).toBeLessThan(order.indexOf("start"));
  });

  it("hands the window to a chosen target without starting the managed runtime", async () => {
    const order: string[] = [];
    const connectTarget = vi.fn(async () => { order.push("connect"); return true; });
    const controller = createLaunchController({
      ...launchDefaults(order),
      chooseRuntime: async () => ({ kind: "target", value: "https://host:4310/join#t=a&f=b" }),
      connectTarget,
      startOrAdopt: async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; },
    });

    await controller.start();

    expect(connectTarget).toHaveBeenCalledWith("https://host:4310/join#t=a&f=b", expect.anything());
    expect(order).not.toContain("start");
  });

  it("asks again when the chosen target fails, because boot has no console to fall back to", async () => {
    const order: string[] = [];
    const choices = [{ kind: "target", value: "127.0.0.1:9" } as const, { kind: "local" } as const];
    const controller = createLaunchController({
      ...launchDefaults(order),
      chooseRuntime: async () => { order.push("ask"); return choices.shift()!; },
      connectTarget: async () => { order.push("failed"); return false; },
      startOrAdopt: async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; },
    });

    await controller.start();

    expect(order.filter((step) => step !== "show" && step !== "load")).toEqual(["ask", "failed", "ask", "start"]);
  });

  it("quits instead of falling back when the choice is cancelled", async () => {
    const order: string[] = [];
    const onStartupCancelled = vi.fn(() => order.push("quit"));
    const controller = createLaunchController({
      ...launchDefaults(order),
      chooseRuntime: async () => ({ kind: "cancelled" }),
      onStartupCancelled,
      startOrAdopt: async () => { order.push("start"); return "http://127.0.0.1:4310/console/"; },
    });

    await controller.start();

    expect(onStartupCancelled).toHaveBeenCalledOnce();
    expect(order).not.toContain("start");
  });
});

function launchDefaults(order: string[]) {
  return {
    createWindow: async () => ({
      isDestroyed: () => false,
      loadURL: async () => { order.push("load"); },
      show: () => order.push("show"),
      webContents: { executeJavaScript: async () => undefined, navigationHistory: { clear: () => undefined } },
    }),
    handoffOrigin: () => undefined,
    pushEntry: async () => undefined,
    startOrAdopt: async () => "http://127.0.0.1:4310/console/",
  };
}
