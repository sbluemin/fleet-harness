import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, shell, Tray } from "electron";

import { createDesktopEnvironment, resolveDesktopUserDataDirectory } from "./environment.js";
import { createDesktopLifecycle } from "./app-lifecycle.js";
import { pushEntrySnapshot } from "./entry-page.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createLaunchController } from "./launch-controller.js";
import { createDesktopLogger } from "./logging.js";
import { installApplicationMenu } from "./menu.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { installConsole } from "./runtime/console-installer.js";
import { bootstrapNodeRuntime, type NodeRuntimeManifest } from "./runtime/node-bootstrap.js";
import { createRegistryChecker } from "./runtime/registry-check.js";
import { resolveRuntimePaths } from "./runtime/runtime-paths.js";
import { SidecarSupervisor } from "./sidecar-supervisor.js";
import { configureTray } from "./tray.js";
import { createUpdateController } from "./update-controller.js";
import { applyWindowPolicy, createSecureWindow } from "./window-policy.js";

const PACKAGE_NAME = "@dotobokuri/fleet-console";
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const desktopResources = resolveDesktopResourcePaths(isPackaged);

applyDesktopIdentity(app);
if (!isPackaged) app.setPath("userData", resolveDesktopUserDataDirectory(app.getPath("userData"), desktopResources.serviceRoot, false));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else void boot().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`Fleet Console bootstrap failed: ${message}\n`);
  app.exit(1);
});

const trayHolder: { current: Tray | null } = { current: null };

async function boot(): Promise<void> {
  await app.whenReady();
  applyDesktopDockIcon(app, desktopResources.iconPath);
  const runtimePaths = resolveRuntimePaths(os.homedir());
  const environment = createDesktopEnvironment(app.getPath("userData"), app.getVersion(), desktopResources.serviceRoot, isPackaged);
  const logger = createDesktopLogger(path.join(app.getPath("userData"), "logs"));
  const registry = createRegistryChecker({ packageName: PACKAGE_NAME, statePath: path.join(runtimePaths.root, "registry-state.json") });
  const supervisor = new SidecarSupervisor({
    ...(isPackaged ? { resolveRuntime: () => resolvePackagedRuntime(runtimePaths, registry) } : { nodePath: desktopResources.nodePath, cliPath: desktopResources.cliPath }),
    env: environment.serviceEnv,
    lockFile: path.join(environment.consoleDir, "console.lock"),
    ownerId: environment.ownerId,
    appVersion: app.getVersion(),
    log: logger,
  });
  let window: BrowserWindow | null = null;
  let policy: ReturnType<typeof applyWindowPolicy> | null = null;
  let refreshNativeUpdateActions: (() => void) | null = null;
  const lifecycle = createDesktopLifecycle(app, async () => {
    const launch = createLaunchController({
      createWindow: async () => {
        window = createSecureWindow(BrowserWindow, { iconPath: desktopResources.iconPath, platform: process.platform });
        policy = applyWindowPolicy(window.webContents, async (external) => shell.openExternal(external));
        await window.loadFile(desktopResources.entryPagePath);
        return window;
      },
      handoffOrigin: (origin) => policy?.activateConsoleOrigin(origin),
      pushEntry: pushEntrySnapshot,
      startOrAdopt: () => supervisor.startOrAdopt(),
    });
    return launch.start() as Promise<BrowserWindow>;
  }, () => supervisor.stop());
  const updates = createUpdateController({
    currentVersion: () => readInstalledVersion(runtimePaths.latest) ?? app.getVersion(),
    registry,
    showDialog: async (version) => {
      const options = { type: "info" as const, title: "Update available", message: `Fleet Console ${version} is ready to install.`, detail: "Takes a few seconds and restarts the console — running operations restore as dormant panels.", buttons: ["Update and Restart", "Later"], defaultId: 0, cancelId: 1, checkboxLabel: "Skip this version" };
      return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
    },
    prepareToQuit: () => lifecycle.prepareToQuit(),
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
    onStateChange: () => refreshNativeUpdateActions?.(),
  });
  const actions = { show: () => { void lifecycle.show(); }, quit: () => { void lifecycle.quit(); }, diagnostics: () => { void shell.openPath(path.join(app.getPath("userData"), "logs")); }, updates };
  if (process.platform !== "darwin") trayHolder.current = new Tray(desktopResources.iconPath);
  refreshNativeUpdateActions = () => {
    installApplicationMenu(Menu, actions, process.platform);
    if (trayHolder.current) configureTray(trayHolder.current, Menu, actions);
  };
  refreshNativeUpdateActions();
  await lifecycle.start();
  setInterval(() => { void updates.check(); }, 60 * 60 * 1_000);
}

async function resolvePackagedRuntime(runtimePaths: ReturnType<typeof resolveRuntimePaths>, registry: ReturnType<typeof createRegistryChecker>): Promise<{ nodePath: string; cliPath: string }> {
  // 번들 main.mjs는 dist에서 실행되고 copy-entry-assets가 manifest를 dist/build로 나른다 — dist 앵커가 dev/packaged 공통 경로다.
  const manifest = JSON.parse(fs.readFileSync(path.resolve(sourceDirectory, "build", "node-runtime.json"), "utf8")) as NodeRuntimeManifest;
  if (!fs.existsSync(runtimePaths.node)) await bootstrapNodeRuntime({ destination: runtimePaths.node, manifest, platform: process.platform, architecture: process.arch });
  const installedVersion = readInstalledVersion(runtimePaths.latest);
  const result = await registry.check(installedVersion ?? "");
  const version = result.latest ?? installedVersion;
  if (!version) throw new Error("console_runtime_unavailable");
  if (version !== installedVersion) await installConsole({ paths: runtimePaths, nodeRoot: runtimePaths.node, packageName: PACKAGE_NAME, version, platform: process.platform });
  return { nodePath: path.join(runtimePaths.node, process.platform === "win32" ? "node.exe" : "bin/node"), cliPath: path.join(runtimePaths.latest, "node_modules", "@dotobokuri", "fleet-console", "dist", "cli.mjs") };
}

function readInstalledVersion(latest: string): string | null {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(latest, "node_modules", "@dotobokuri", "fleet-console", "package.json"), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}
