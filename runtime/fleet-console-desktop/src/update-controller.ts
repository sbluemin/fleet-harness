import type { AppUpdater } from "electron-updater";

export interface UpdateController { check(): Promise<void>; install(): Promise<void>; }

export function createUpdateController(updater: AppUpdater, isPackaged: boolean, beforeInstall: () => Promise<void>, onError: (error: Error) => void): UpdateController {
  let checkedUpdate: ReturnType<AppUpdater["checkForUpdates"]> | null = null;
  updater.autoDownload = false;
  updater.on("error", (error) => onError(error));
  return {
    async check() {
      if (!isPackaged) return;
      checkedUpdate = updater.checkForUpdates();
      await checkedUpdate;
    },
    async install() {
      if (!isPackaged) return;
      const update = await (checkedUpdate ?? updater.checkForUpdates());
      checkedUpdate = null;
      if (update === null || update?.isUpdateAvailable === false) return;
      if (typeof updater.downloadUpdate === "function") await updater.downloadUpdate();
      await beforeInstall();
      updater.quitAndInstall();
    },
  };
}
