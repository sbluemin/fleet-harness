import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";

import type { UpdateController } from "./update-controller.js";

export interface ApplicationMenuActions {
  readonly show: () => void;
  readonly quit: () => void;
  readonly diagnostics: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly actualSize: () => void;
  readonly reloadConsole: () => void;
  readonly consoleReady: () => boolean;
  readonly updates: UpdateController;
}

export function installApplicationMenu(MenuCtor: typeof Menu, actions: ApplicationMenuActions, platform: NodeJS.Platform, window?: BrowserWindow): void {
  if (platform !== "darwin") {
    const menu = MenuCtor.buildFromTemplate([{
      label: "Fleet Console",
      submenu: nonDarwinConsoleActions(actions),
    }]);
    MenuCtor.setApplicationMenu(menu);
    window?.setMenu(menu);
    window?.setMenuBarVisibility(false);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { label: "Show", click: actions.show },
        { type: "separator" },
        ...(actions.updates.enabled() ? [{ label: "Check for Updates", click: () => void actions.updates.check() }, ...(actions.updates.availableVersion() ? [{ label: `Update to ${actions.updates.availableVersion()}…`, sublabel: "restarts console", click: () => void actions.updates.install() }] : [])] : []),
        { type: "separator" },
        { label: "Diagnostics", click: actions.diagnostics },
        { role: "quit", click: actions.quit },
      ],
    },
    { role: "editMenu" },
    { label: "View", submenu: darwinConsoleActions(actions) },
  ];
  MenuCtor.setApplicationMenu(MenuCtor.buildFromTemplate(template));
}

function darwinConsoleActions(actions: ApplicationMenuActions): MenuItemConstructorOptions[] {
  return [
    consoleAction("Reload Console", "Command+R", actions.reloadConsole, actions),
    { type: "separator" },
    consoleAction("Zoom In", "Command+Plus", actions.zoomIn, actions),
    consoleAction("Zoom In", "Command+=", actions.zoomIn, actions, true),
    consoleAction("Zoom In", "Command+numadd", actions.zoomIn, actions, true),
    consoleAction("Zoom Out", "Command+-", actions.zoomOut, actions),
    consoleAction("Zoom Out", "Command+numsub", actions.zoomOut, actions, true),
    consoleAction("Actual Size", "Command+0", actions.actualSize, actions),
  ];
}

function nonDarwinConsoleActions(actions: ApplicationMenuActions): MenuItemConstructorOptions[] {
  return [
    consoleAction("Reload Console", "Ctrl+R", actions.reloadConsole, actions),
    consoleAction("Reload Console", "F5", actions.reloadConsole, actions),
    { type: "separator" },
    consoleAction("Zoom In", "Ctrl+=", actions.zoomIn, actions),
    consoleAction("Zoom In", "Ctrl+Shift+=", actions.zoomIn, actions),
    consoleAction("Zoom In", "Ctrl+numadd", actions.zoomIn, actions),
    consoleAction("Zoom Out", "Ctrl+-", actions.zoomOut, actions),
    consoleAction("Zoom Out", "Ctrl+numsub", actions.zoomOut, actions),
    consoleAction("Actual Size", "Ctrl+0", actions.actualSize, actions),
  ];
}

function consoleAction(label: string, accelerator: string, action: () => void, actions: ApplicationMenuActions, hidden = false): MenuItemConstructorOptions {
  const enabled = actions.consoleReady();
  return {
    label,
    accelerator,
    enabled,
    ...(hidden ? { visible: false } : {}),
    click: () => { if (actions.consoleReady()) action(); },
  };
}
