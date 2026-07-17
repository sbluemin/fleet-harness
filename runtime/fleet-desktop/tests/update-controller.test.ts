import { describe, expect, it, vi } from "vitest";

import { createNoopUpdateController, createUpdateController, resolveActiveWindow, showWindowsHiddenUpdateDialog } from "../src/update-controller.js";

function controller(result = { latest: "1.2.4", shouldNotify: true }, dialog = { response: 1, checkboxChecked: false }) {
  const registry = { check: vi.fn(async () => result), skip: vi.fn(async () => undefined), startPolling: vi.fn() };
  const prepareToQuit = vi.fn(async () => undefined);
  const relaunch = vi.fn();
  const quit = vi.fn();
  const updates = createUpdateController({ currentVersion: () => "1.2.3", registry, showDialog: vi.fn(async () => dialog), prepareToQuit, relaunch, quit });
  return { updates, registry, prepareToQuit, relaunch, quit };
}

describe("registry update controller", () => {
  it("drops a destroyed update-dialog parent window", () => {
    const destroyedWindow = { isDestroyed: () => true };
    const activeWindow = { isDestroyed: () => false };

    expect(resolveActiveWindow(destroyedWindow)).toBeNull();
    expect(resolveActiveWindow(activeWindow)).toBe(activeWindow);
  });

  it("shows the native prompt once, keeps a Later update available for menu and tray", async () => {
    const { updates } = controller();
    await updates.check();
    expect(updates.availableVersion()).toBe("1.2.4");
  });

  it("persists Skip this version and relaunches instead of updating in place", async () => {
    const { updates, registry, prepareToQuit, relaunch, quit } = controller({ latest: "1.2.4", shouldNotify: true }, { response: 0, checkboxChecked: true });
    await updates.check();
    expect(registry.skip).toHaveBeenCalledWith("1.2.4");
    expect(prepareToQuit).toHaveBeenCalledBefore(relaunch);
    expect(relaunch).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("bypasses every update action in development", async () => {
    const updates = createNoopUpdateController();
    await updates.check();
    await updates.install();
    expect(updates.availableVersion()).toBeNull();
    expect(updates.enabled()).toBe(false);
  });

  it("shows a Windows balloon before restoring a hidden window and opening its dialog", async () => {
    const order: string[] = [];
    let click: (() => void) | undefined;
    const tray = { displayBalloon: vi.fn(() => order.push("balloon")), once: vi.fn((_event: "balloon-click", callback: () => void) => { click = callback; }) };
    const window = { isVisible: () => false, show: vi.fn(() => order.push("show")) };
    const result = showWindowsHiddenUpdateDialog(window, tray, "1.2.4", vi.fn(async () => { order.push("dialog"); return { response: 1, checkboxChecked: false }; }));
    expect(order).toEqual(["balloon"]);
    click?.();
    await expect(result).resolves.toEqual({ response: 1, checkboxChecked: false });
    expect(order).toEqual(["balloon", "show", "dialog"]);
  });
});
