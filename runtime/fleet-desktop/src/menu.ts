import type { Menu, MenuItemConstructorOptions } from "electron";

import type { NativeUpdateActions } from "./update-controller.js";

export interface ApplicationMenuActions {
  readonly show: () => void;
  readonly quit: () => void;
  readonly diagnostics: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly actualSize: () => void;
  readonly reloadConsole: () => void;
  readonly consoleReady: () => boolean;
  readonly updates: NativeUpdateActions;
}

interface MenuBarHost {
  setMenu?(menu: Menu): void;
  setMenuBarVisibility?(visible: boolean): void;
}

export function installApplicationMenu(MenuCtor: typeof Menu, actions: ApplicationMenuActions, platform: NodeJS.Platform, window?: MenuBarHost): void {
  if (platform !== "darwin") {
    const menu = MenuCtor.buildFromTemplate([{
      label: "Fleet Console",
      submenu: nonDarwinConsoleActions(actions),
    }]);
    MenuCtor.setApplicationMenu(menu);
    window?.setMenu?.(menu);
    window?.setMenuBarVisibility?.(false);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        { label: "Show", click: actions.show },
        { type: "separator" },
        ...buildUpdateMenuItems(actions),
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

/**
 * 네이티브 메뉴는 창 안의 알림과 같은 상태를 말한다. 받아 둔 것이 없으면 내려받기를, 받아 두었으면
 * 재시작을 내준다 — 둘을 한 항목으로 합치면 누르는 사람이 무엇이 일어날지 모른 채 누른다.
 * 확인·내려받기는 창을 가리는 대화를 띄우지 않는다. 결과는 언제나 콘솔 화면이 말한다.
 */
export function buildUpdateMenuItems(actions: ApplicationMenuActions): MenuItemConstructorOptions[] {
  if (!actions.updates.enabled()) return [];
  const version = actions.updates.version();
  const stage = actions.updates.stage();
  if (stage === "downloading") return [{ label: "Downloading Update…", enabled: false }];
  if (stage === "ready" && version) return [{ label: `Restart to Update to ${version}`, click: actions.updates.restart }];
  if (stage === "available" && version) return [{ label: `Download Update ${version}…`, click: actions.updates.download }];
  return [{ label: "Check for Updates", click: actions.updates.check }];
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
