import type { Menu, MenuItemConstructorOptions } from "electron";

import type { UpdateController } from "./update-controller.js";

export interface ApplicationMenuActions {
  readonly show: () => void;
  readonly quit: () => void;
  readonly diagnostics: () => void;
  readonly updates: UpdateController;
}

export function installApplicationMenu(MenuCtor: typeof Menu, actions: ApplicationMenuActions, platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    MenuCtor.setApplicationMenu(null);
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
  ];
  MenuCtor.setApplicationMenu(MenuCtor.buildFromTemplate(template));
}
