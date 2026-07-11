import { describe, expect, it, vi } from "vitest";

import { createUpdateController } from "../src/update-controller.js";

function updater() { return { autoDownload: true, on: vi.fn(), checkForUpdates: vi.fn(async () => undefined), quitAndInstall: vi.fn() }; }

describe("native update controller", () => {
  it("disables update activity for development builds", async () => {
    const native = updater();
    const controller = createUpdateController(native as never, false, vi.fn(), vi.fn());
    await controller.check();
    await controller.install();
    expect(native.autoDownload).toBe(false);
    expect(native.checkForUpdates).not.toHaveBeenCalled();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
  });

  it("stops the verified sidecar before installing a packaged update", async () => {
    const native = updater();
    const stop = vi.fn(async () => undefined);
    const controller = createUpdateController(native as never, true, stop, vi.fn());
    await controller.check();
    await controller.install();
    expect(native.checkForUpdates).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledBefore(native.quitAndInstall);
  });
});
