import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";

import { createShellUpdater } from "../src/shell-update.js";

function createFakeUpdater() {
  const emitter = new EventEmitter();
  const checkForUpdates = vi.fn(async () => ({ updateInfo: { version: "1.2.0" } }));
  const downloadUpdate = vi.fn(async () => { emitter.emit("update-downloaded", { version: "1.2.0" }); return []; });
  const quitAndInstall = vi.fn();
  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: console,
    forceDevUpdateConfig: false,
    updateConfigPath: null,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
  }) as unknown as AppUpdater;
  return { updater, checkForUpdates, downloadUpdate, quitAndInstall };
}

describe("shell updater restart ordering", () => {
  it("finishes prepareToQuit before calling quitAndInstall when ready", async () => {
    const { updater, quitAndInstall } = createFakeUpdater();
    const events: string[] = [];
    let finishPrepare!: () => void;
    let resolvePrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { resolvePrepareStarted = resolve; });
    quitAndInstall.mockImplementation(() => { events.push("quitAndInstall"); });

    const shellUpdater = createShellUpdater({
      updater,
      currentVersion: () => "1.1.0",
      publish: () => undefined,
      log: () => undefined,
      prepareToQuit: () => new Promise<void>((resolve) => {
        events.push("prepare:start");
        resolvePrepareStarted();
        finishPrepare = () => { events.push("prepare:end"); resolve(); };
      }),
    });

    await shellUpdater.check();
    await shellUpdater.download();
    expect(shellUpdater.snapshot().stage).toBe("ready");

    const pendingRestart = shellUpdater.restart();
    const duplicateRestart = shellUpdater.restart();
    await prepareStarted;
    expect(quitAndInstall).not.toHaveBeenCalled();

    finishPrepare();
    await Promise.all([pendingRestart, duplicateRestart]);
    expect(events).toEqual(["prepare:start", "prepare:end", "quitAndInstall"]);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("skips quitAndInstall if prepareToQuit fails and allows a retry", async () => {
    const { updater, quitAndInstall } = createFakeUpdater();
    const logs: string[] = [];
    let attempt = 0;
    const shellUpdater = createShellUpdater({
      updater,
      currentVersion: () => "1.1.0",
      publish: () => undefined,
      log: (message) => logs.push(message),
      prepareToQuit: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("sidecar_stop_failed");
      },
    });

    await shellUpdater.check();
    await shellUpdater.download();

    await shellUpdater.restart();
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("sidecar_stop_failed"))).toBe(true);

    await shellUpdater.restart();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
