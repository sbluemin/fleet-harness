import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, dialog, Menu, shell, Tray } from "electron";

import { createDesktopEnvironment, resolveDesktopUserDataDirectory } from "./environment.js";
import { createDesktopLifecycle } from "./app-lifecycle.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createDesktopLogger } from "./logging.js";
import { installApplicationMenu } from "./menu.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { SidecarSupervisor } from "./sidecar-supervisor.js";
import { configureTray } from "./tray.js";
import { createUpdateController } from "./update-controller.js";
import { applyWindowPolicy, createSecureWindow } from "./window-policy.js";

const isPackaged = app.isPackaged;
const desktopResources = resolveDesktopResourcePaths(isPackaged);
applyDesktopIdentity(app);
if (!isPackaged) {
  app.setPath("userData", resolveDesktopUserDataDirectory(app.getPath("userData"), desktopResources.serviceRoot, false));
}
const gotLock = app.requestSingleInstanceLock();
recordBootPhase(`single-instance=${gotLock}`);
if (!gotLock) app.quit();
else void boot().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  recordBootPhase(`failed=${message}`);
  process.stderr.write(`Fleet Console bootstrap failed: ${message}\n`);
  app.exit(1);
});

// Electron Tray는 JS 참조가 GC되면 아이콘이 파괴된다 — 프로세스 수명 동안 강참조를 유지한다.
const trayHolder: { current: Tray | null } = { current: null };

async function boot(): Promise<void> {
  recordBootPhase("waiting-for-ready");
  await app.whenReady();
  recordBootPhase("ready");
  applyDesktopDockIcon(app, desktopResources.iconPath);
  recordBootPhase("loading-updater");
  const updaterModule = await import("electron-updater");
  const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
  if (!autoUpdater) throw new Error("electron_updater_export_missing");
  recordBootPhase("updater-loaded");
  const resources = desktopResources;
  recordBootPhase(`resources=${resources.serviceRoot}`);
  const environment = createDesktopEnvironment(app.getPath("userData"), app.getVersion(), resources.serviceRoot, isPackaged);
  recordBootPhase(`environment=${environment.consoleDir}`);
  const logger = createDesktopLogger(path.join(app.getPath("userData"), "logs"));
  const supervisor = new SidecarSupervisor({ nodePath: resources.nodePath, cliPath: resources.cliPath, env: environment.serviceEnv, lockFile: path.join(environment.consoleDir, "console.lock"), ownerId: environment.ownerId, appVersion: app.getVersion(), log: logger });
  let window: BrowserWindow | null = null;
  const lifecycle = createDesktopLifecycle(app, async () => {
    const url = await supervisor.startOrAdopt();
    window = createSecureWindow(BrowserWindow, { iconPath: resources.iconPath, platform: process.platform });
    applyWindowPolicy(window.webContents, new URL(url).origin, async (external) => shell.openExternal(external));
    await window.loadURL(url);
    window.show();
    return window;
  }, () => supervisor.stop());
  const updates = createUpdateController(autoUpdater, isPackaged, () => lifecycle.prepareToQuit(), (error) => { logger.error(error.message); void dialog.showErrorBox("Fleet Console update", error.message); });
  const show = () => { void lifecycle.show(); };
  const quit = () => { void lifecycle.quit(); };
  const diagnostics = () => { void shell.openPath(path.join(app.getPath("userData"), "logs")); };
  installApplicationMenu(Menu, { show, quit, diagnostics, updates }, process.platform);
  if (process.platform !== "darwin") { trayHolder.current = new Tray(resources.iconPath); configureTray(trayHolder.current, Menu, { show, quit, diagnostics, updates }); }
  recordBootPhase("starting-lifecycle");
  await lifecycle.start();
  recordBootPhase("lifecycle-started");
}

function recordBootPhase(message: string): void {
  const consoleDirectory = process.env.FLEET_CONSOLE_DIR;
  if (!consoleDirectory) return;
  try {
    fs.mkdirSync(consoleDirectory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(consoleDirectory, "desktop-bootstrap.log"), `${new Date().toISOString()} ${message.replace(/[\r\n]/g, " ")}\n`, { mode: 0o600 });
  } catch {
    // Bootstrap diagnostics must never prevent the application from starting.
  }
}
