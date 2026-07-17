import type { Menu, Tray } from "electron";

import type { DesktopResourcePaths } from "./resource-paths.js";
import type { UpdateController } from "./update-controller.js";

export interface TrayActions {
  readonly show: () => void;
  readonly quit: () => void;
  readonly diagnostics: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly actualSize: () => void;
  readonly reloadConsole: () => void;
  readonly connectRuntime: () => void;
  readonly backToLocal: () => void;
  readonly consoleReady: () => boolean;
  readonly isRemoteActive: () => boolean;
  readonly updates: UpdateController;
}

export interface TrayConstructor {
  new (image: string): Tray;
}

export function createDesktopTray(platform: NodeJS.Platform, TrayCtor: TrayConstructor, resources: DesktopResourcePaths, actions: TrayActions): Tray {
  const tray = new TrayCtor(platform === "darwin" ? resources.trayTemplateIconPath : resources.iconPath);
  tray.on("click", actions.show);
  return tray;
}

export function shouldConfigureTray(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

export function configureTray(tray: Tray, MenuCtor: typeof Menu, actions: TrayActions): void {
  tray.setContextMenu(MenuCtor.buildFromTemplate([
    { label: "Show Fleet Console", click: actions.show },
    { label: "Connect to Runtime…", enabled: actions.consoleReady(), click: () => { if (actions.consoleReady()) actions.connectRuntime(); } },
    { label: "Back to Local Runtime", enabled: canReturnToLocal(actions), click: () => { if (canReturnToLocal(actions)) actions.backToLocal(); } },
    { type: "separator" },
    consoleAction("Zoom In", "Ctrl+=", actions.zoomIn, actions),
    consoleAction("Zoom Out", "Ctrl+-", actions.zoomOut, actions),
    consoleAction("Actual Size", "Ctrl+0", actions.actualSize, actions),
    consoleAction("Reload Console", "Ctrl+R", actions.reloadConsole, actions),
    { type: "separator" },
    ...(actions.updates.enabled() ? [{ label: "Check for Updates", click: () => void actions.updates.check() }, ...(actions.updates.availableVersion() ? [{ label: `Update to ${actions.updates.availableVersion()}…`, sublabel: "restarts console", click: () => void actions.updates.install() }] : [])] : []),
    { type: "separator" },
    { label: "Diagnostics", click: actions.diagnostics },
    { type: "separator" },
    { label: "Quit", click: actions.quit },
  ]));
}

function canReturnToLocal(actions: TrayActions): boolean { return actions.consoleReady() && actions.isRemoteActive(); }

function consoleAction(label: string, accelerator: string, action: () => void, actions: TrayActions): { label: string; accelerator: string; enabled: boolean; click: () => void } {
  return {
    label,
    accelerator,
    enabled: actions.consoleReady(),
    click: () => { if (actions.consoleReady()) action(); },
  };
}
