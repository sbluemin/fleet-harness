import type { Menu, Tray } from "electron";

import type { UpdateController } from "./update-controller.js";

export interface TrayActions {
  readonly show: () => void;
  readonly quit: () => void;
  readonly diagnostics: () => void;
  readonly updates: UpdateController;
}

export function configureTray(tray: Tray, MenuCtor: typeof Menu, actions: TrayActions): void {
  tray.setContextMenu(MenuCtor.buildFromTemplate([
    { label: "Show Fleet Console", click: actions.show },
    { type: "separator" },
    { label: "Check for Updates", click: () => void actions.updates.check() },
    ...(actions.updates.availableVersion() ? [{ label: `Update to ${actions.updates.availableVersion()}…`, sublabel: "restarts console", click: () => void actions.updates.install() }] : []),
    { type: "separator" },
    { label: "Diagnostics", click: actions.diagnostics },
    { type: "separator" },
    { label: "Quit", click: actions.quit },
  ]));
  tray.on("click", actions.show);
}
