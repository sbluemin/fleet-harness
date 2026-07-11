import { describe, expect, it, vi } from "vitest";

import { createUpdateController } from "../src/update-controller.js";

function controller(result = { latest: "1.2.4", shouldNotify: true }, dialog = { response: 1, checkboxChecked: false }) {
  const registry = { check: vi.fn(async () => result), skip: vi.fn(async () => undefined), startPolling: vi.fn() };
  const prepareToQuit = vi.fn(async () => undefined);
  const relaunch = vi.fn();
  const quit = vi.fn();
  const updates = createUpdateController({ currentVersion: () => "1.2.3", registry, showDialog: vi.fn(async () => dialog), prepareToQuit, relaunch, quit });
  return { updates, registry, prepareToQuit, relaunch, quit };
}

describe("registry update controller", () => {
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
});
