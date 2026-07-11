import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, shell, Tray } from "electron";

import { createDesktopLifecycle } from "./app-lifecycle.js";
import { createDesktopEnvironment, resolveDesktopUserDataDirectory } from "./environment.js";
import { pushEntrySnapshot } from "./entry-page.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createLaunchController, type RuntimeEntryState } from "./launch-controller.js";
import { createDesktopLogger } from "./logging.js";
import { installApplicationMenu } from "./menu.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { createConsoleInstallerDependencies, installConsole, reconcileConsoleInstallations } from "./runtime/console-installer.js";
import { bootstrapNodeRuntime, isManagedNodeRuntimeValid, reconcileNodeRuntime, satisfiesNodeEngine, type NodeRuntimeManifest } from "./runtime/node-bootstrap.js";
import { createRegistryChecker } from "./runtime/registry-check.js";
import { resolveRuntimePaths } from "./runtime/runtime-paths.js";
import { SidecarSupervisor, type SidecarRuntime } from "./sidecar-supervisor.js";
import { configureTray } from "./tray.js";
import { createNoopUpdateController, createUpdateController, showWindowsHiddenUpdateDialog } from "./update-controller.js";
import { applyWindowPolicy, createSecureWindow } from "./window-policy.js";

type RuntimeProgress = (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>;

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
  let pushRuntimeProgress: RuntimeProgress | null = null;
  const initialServiceVersion = readInstalledVersion(isPackaged ? runtimePaths.latest : desktopResources.serviceRoot) ?? "";
  const supervisor = new SidecarSupervisor({
    ...(isPackaged
      ? { resolveRuntime: () => resolvePackagedRuntime(runtimePaths, registry, (state, detail, progress) => pushRuntimeProgress?.(state, detail, progress) ?? Promise.resolve()) }
      : { nodePath: desktopResources.nodePath, cliPath: desktopResources.cliPath, serviceRoot: desktopResources.serviceRoot }),
    env: environment.serviceEnv,
    lockFile: path.join(environment.consoleDir, "console.lock"),
    ownerId: environment.ownerId,
    serviceVersion: initialServiceVersion,
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
      dev: !isPackaged,
      handoffOrigin: (origin) => policy?.activateConsoleOrigin(origin),
      onFirstRunFailure: async () => showFirstRunFailure(),
      onWindowReady: (push) => { pushRuntimeProgress = push; },
      pushEntry: pushEntrySnapshot,
      startOrAdopt: () => supervisor.startOrAdopt(),
    });
    return launch.start() as Promise<BrowserWindow>;
  }, () => supervisor.stop());
  const updates = isPackaged
    ? createUpdateController({
      currentVersion: () => readInstalledVersion(runtimePaths.latest) ?? "",
      registry,
      showDialog: async (version) => showUpdateDialog(window, version, () => registry.markPrompted?.(version)),
      prepareToQuit: () => lifecycle.prepareToQuit(),
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
      onStateChange: () => refreshNativeUpdateActions?.(),
    })
    : createNoopUpdateController();
  const actions = { show: () => { void lifecycle.show(); }, quit: () => { void lifecycle.quit(); }, diagnostics: () => { void shell.openPath(path.join(app.getPath("userData"), "logs")); }, updates };
  if (process.platform !== "darwin") trayHolder.current = new Tray(desktopResources.iconPath);
  refreshNativeUpdateActions = () => {
    installApplicationMenu(Menu, actions, process.platform);
    if (trayHolder.current) configureTray(trayHolder.current, Menu, actions);
  };
  refreshNativeUpdateActions();
  await lifecycle.start();
  if (isPackaged) setInterval(() => { void updates.check(false); }, 60 * 60 * 1_000);
}

async function resolvePackagedRuntime(runtimePaths: ReturnType<typeof resolveRuntimePaths>, registry: ReturnType<typeof createRegistryChecker>, progress: RuntimeProgress): Promise<SidecarRuntime> {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(sourceDirectory, "build", "node-runtime.json"), "utf8")) as NodeRuntimeManifest;
    const engine = readConsoleNodeEngine(runtimePaths.latest);
    if (!satisfiesNodeEngine(manifest.version, engine)) throw new Error("managed_node_engine_unsupported");
    if (await isManagedNodeRuntimeValid(runtimePaths.node, manifest, process.platform)) {
      await reconcileNodeRuntime(runtimePaths.node);
    } else {
      await progress("node", "checksum verified", 0);
      await bootstrapNodeRuntime({ destination: runtimePaths.node, manifest, platform: process.platform, architecture: process.arch });
    }
    await reconcileConsoleInstallations(runtimePaths, createInstallerFileSystem());
    const installedVersion = readInstalledVersion(runtimePaths.latest);
    const result = await registry.check(installedVersion ?? "");
    const version = result.latest ?? installedVersion;
    if (!version) throw new Error("console_runtime_unavailable");
    if (result.latest) {
      await progress("installing", `Fleet Console ${version}`, 0);
      try {
        await installConsole({ paths: runtimePaths, nodeRoot: runtimePaths.node, packageName: PACKAGE_NAME, version, nodeRuntimeVersion: manifest.version, platform: process.platform });
      } catch (error) {
        if (!installedVersion) throw error;
        await progress("offline", "update failed — installed latest");
      }
    } else if (!installedVersion) {
      throw new Error("console_runtime_unavailable");
    } else if (result.unavailable) {
      await progress("offline", "registry unreachable — installed latest");
    }
    const serviceVersion = readInstalledVersion(runtimePaths.latest);
    if (!serviceVersion) throw new Error("console_runtime_unavailable");
    if (!satisfiesNodeEngine(manifest.version, readConsoleNodeEngine(runtimePaths.latest))) throw new Error("managed_node_engine_unsupported");
    return { nodePath: path.join(runtimePaths.node, process.platform === "win32" ? "node.exe" : "bin/node"), cliPath: path.join(runtimePaths.latest, "dist", "cli.mjs"), serviceRoot: runtimePaths.latest, serviceVersion };
  } catch (error) {
    if (!readInstalledVersion(runtimePaths.latest)) throw new Error("console_runtime_unavailable");
    throw error;
  }
}

function createInstallerFileSystem(): Parameters<typeof reconcileConsoleInstallations>[1] {
  const dependencies = createConsoleInstallerDependencies();
  return dependencies.fileSystem;
}

async function showFirstRunFailure(): Promise<boolean> {
  const result = await dialog.showMessageBox({ type: "error", title: "Fleet Console setup failed", message: "Fleet Console could not be installed.", detail: "Check your connection and retry; nothing was left half-installed.", buttons: ["Retry", "Quit"], defaultId: 0, cancelId: 1 });
  if (result.response === 0) return true;
  app.quit();
  return false;
}

async function showUpdateDialog(window: BrowserWindow | null, version: string, markPrompted: () => void): Promise<{ response: number; checkboxChecked: boolean }> {
  const options = { type: "info" as const, title: "Update available", message: `Fleet Console ${version} is ready to install.`, detail: "Takes a few seconds and restarts the console — running operations restore as dormant panels.", buttons: ["Update and Restart", "Later"], defaultId: 0, cancelId: 1, checkboxLabel: "Skip this version" };
  const show = async (): Promise<{ response: number; checkboxChecked: boolean }> => {
    markPrompted();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };
  // Windows 실기는 darwin에서 [Unverified]다. 숨은 트레이 창은 balloon 클릭 뒤에만 모달을 연다.
  return process.platform === "win32" ? showWindowsHiddenUpdateDialog(window, trayHolder.current, version, show) : show();
}

function readInstalledVersion(root: string): string | null {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function readConsoleNodeEngine(root: string): string | null {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { engines?: { node?: unknown } };
    return typeof packageJson.engines?.node === "string" ? packageJson.engines.node : null;
  } catch {
    return null;
  }
}
