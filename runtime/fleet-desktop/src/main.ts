import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, Notification, shell, Tray } from "electron";
import { DESKTOP_PROTOCOL_VERSION } from "@fleet-console/desktop-protocol";

import { createDesktopLifecycle } from "./app-lifecycle.js";
import { isConsoleConflict, showConsoleConflictAndQuit } from "./console-conflict.js";
import { createConsoleControls } from "./console-controls.js";
import { createHydratedDesktopEnvironment, resolveDesktopUserDataDirectory } from "./environment.js";
import { pushEntrySnapshot } from "./entry-page.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createLaunchController, type RuntimeEntryState } from "./launch-controller.js";
import { createPairingNotifier } from "./pairing-notifications.js";
import { createPairingModal } from "./pairing-modal.js";
import { createRuntimePairing } from "./runtime-pairing.js";
import { createDesktopLogger, describeError, type DesktopLogger } from "./logging.js";
import { createDesktopThemeSynchronizer } from "./desktop-theme-sync.js";
import { createDesktopFullscreenSynchronizer } from "./desktop-fullscreen-sync.js";
import { installApplicationMenu } from "./menu.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { createConsoleInstallerDependencies, installConsole, reconcileConsoleInstallations, repairConsoleNativeExecutables } from "./runtime/console-installer.js";
import { bootstrapNodeRuntime, isManagedNodeRuntimeValid, reconcileNodeRuntime, satisfiesNodeEngine, type NodeRuntimeManifest } from "./runtime/node-bootstrap.js";
import { createRegistryChecker } from "./runtime/registry-check.js";
import { resolveRuntimePaths } from "./runtime/runtime-paths.js";
import { createRemoteLastTargetStore } from "./runtime/remote/last-target.js";
import { connectManagedRemote } from "./runtime/remote/orchestrator.js";
import { createOpenSshAdapter } from "./runtime/remote/ssh.js";
import { SidecarSupervisor, type SidecarRuntime } from "./sidecar-supervisor.js";
import { configureTray } from "./tray.js";
import { createNoopUpdateController, createUpdateController, showWindowsHiddenUpdateDialog } from "./update-controller.js";
import { applyWindowPolicy, createSecureWindow } from "./window-policy.js";
import { createZoomState } from "./zoom-state.js";

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
  if (isConsoleConflict(error)) {
    return showConsoleConflictAndQuit({ showMessageBox: (options) => dialog.showMessageBox(options), quit: () => app.quit() });
  }
  // 실제 원인(cause 체인·자식 프로세스 stderr 포함)을 로그 파일에 남긴다 — Finder/트레이 실행 시 stderr는
  // 어디에도 보이지 않으므로, 이 파일 로그가 개발 진단과 퍼블리싱된 앱의 사용자 이슈 수집의 SSoT다.
  logBootFailure(error);
  process.stderr.write(`Fleet Console bootstrap failed: ${describeError(error)}\n`);
  app.exit(1);
});

const trayHolder: { current: Tray | null } = { current: null };
let bootLogger: DesktopLogger | null = null;

async function boot(): Promise<void> {
  await app.whenReady();
  applyDesktopDockIcon(app, desktopResources.iconPath);
  const runtimePaths = resolveRuntimePaths(os.homedir());
  const environment = await createHydratedDesktopEnvironment(app.getPath("userData"), app.getVersion(), desktopResources.serviceRoot, isPackaged);
  const logger = createDesktopLogger(path.join(app.getPath("userData"), "logs"));
  bootLogger = logger;
  const registry = createRegistryChecker({ packageName: PACKAGE_NAME, statePath: path.join(runtimePaths.root, "registry-state.json") });
  const remoteManifest = JSON.parse(fs.readFileSync(path.resolve(sourceDirectory, "build", "node-runtime.json"), "utf8")) as NodeRuntimeManifest;
  const remoteLastTarget = createRemoteLastTargetStore(app.getPath("userData"));
  let pushRuntimeProgress: RuntimeProgress | null = null;
  const initialServiceVersion = readInstalledVersion(isPackaged ? runtimePaths.latest : desktopResources.serviceRoot) ?? "";
  const supervisor = new SidecarSupervisor({
    ...(isPackaged
      ? { resolveRuntime: () => resolvePackagedRuntime(runtimePaths, registry, (state, detail, progress) => pushRuntimeProgress?.(state, detail, progress) ?? Promise.resolve(), logger) }
      : { nodePath: desktopResources.nodePath, cliPath: desktopResources.cliPath, serviceRoot: desktopResources.serviceRoot }),
    env: environment.serviceEnv,
    lockFile: path.join(environment.consoleDir, "console.lock"),
    ownerId: environment.ownerId,
    serviceVersion: initialServiceVersion,
    log: logger,
  });
  let window: BrowserWindow | null = null;
  let policy: ReturnType<typeof applyWindowPolicy> | null = null;
  const themeSynchronizer = process.platform === "win32"
    ? createDesktopThemeSynchronizer({
      applyTheme: (snapshot) => {
        if (!window || window.isDestroyed()) return;
        window.setTitleBarOverlay(snapshot.titleBarOverlay);
      },
    })
    : null;
  let fullscreenSynchronizer: ReturnType<typeof createDesktopFullscreenSynchronizer> | null = null;
  let refreshNativeUpdateActions: (() => void) | null = null;
  const zoomState = createZoomState(path.join(app.getPath("userData"), "desktop-state.json"));
  const controls = createConsoleControls({ zoomState, refreshNativeActions: () => refreshNativeUpdateActions?.() });
  let pairing: ReturnType<typeof createRuntimePairing> | null = null;
  const lifecycle = createDesktopLifecycle(app, async () => {
    const launch = createLaunchController({
      createWindow: async () => {
        const createdWindow = createSecureWindow(BrowserWindow, { iconPath: desktopResources.iconPath, platform: process.platform });
        window = createdWindow;
        fullscreenSynchronizer = createDesktopFullscreenSynchronizer(createdWindow);
        createdWindow.once("closed", () => {
          themeSynchronizer?.stop();
          fullscreenSynchronizer?.stop();
          fullscreenSynchronizer = null;
        });
        controls.attachWindow(createdWindow);
        lifecycle.attachWindow(createdWindow);
        policy = applyWindowPolicy(createdWindow.webContents, async (external) => shell.openExternal(external));
        createdWindow.webContents.on("zoom-changed", (_event, zoomDirection) => controls.zoomChanged(createdWindow.webContents, zoomDirection));
        refreshNativeUpdateActions?.();
        await createdWindow.loadFile(desktopResources.entryPagePath);
        return createdWindow;
      },
      dev: !isPackaged,
      handoffOrigin: (origin) => {
        policy?.activateConsoleOrigin(origin);
        controls.handoffStarted();
      },
      synchronizeTheme: async (origin) => { await themeSynchronizer?.start(origin); },
      synchronizeFullscreen: (origin) => fullscreenSynchronizer?.activate(origin),
      onConsoleLoaded: () => controls.onConsoleLoaded(),
      onFirstRunFailure: async () => showFirstRunFailure(),
      onWindowReady: (push) => { pushRuntimeProgress = push; },
      pushEntry: pushEntrySnapshot,
      startOrAdopt: () => supervisor.startOrAdopt(),
    });
    return launch.start() as Promise<BrowserWindow>;
  }, async () => { await pairing?.dispose(); await supervisor.stop(); });
  pairing = createRuntimePairing({
    notifier: createPairingNotifier(Notification, { showMessageBox: (options) => dialog.showMessageBox(options) }),
    fullscreenSynchronizer: () => fullscreenSynchronizer,
    themeSynchronizer,
    modal: createPairingModal({ BrowserWindow, pairingPagePath: desktopResources.pairingPagePath }),
    lastTargetStore: remoteLastTarget,
    logger,
    connectRemote: async (target) => {
      const started = Date.now();
      const ssh = await createOpenSshAdapter();
      return connectManagedRemote(target.value, {
        ssh,
        manifest: remoteManifest,
        registry,
        owner: { id: environment.ownerId, version: app.getVersion() },
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        desktopVersion: app.getVersion(),
        consoleDirRel: ".fleet/console",
        onPhase: (phase) => logger.info(`managed SSH phase=${phase} elapsedMs=${Date.now() - started}`),
      });
    },
  });
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
  const actions = {
    show: () => { void lifecycle.show(); },
    quit: () => { void lifecycle.quit(); },
    diagnostics: () => { void shell.openPath(path.join(app.getPath("userData"), "logs")); },
    zoomIn: () => controls.zoomIn(),
    zoomOut: () => controls.zoomOut(),
    actualSize: () => controls.actualSize(),
    reloadConsole: () => controls.reloadConsole(),
    connectRuntime: () => {
      if (!controls.consoleReady()) return;
      void lifecycle.show().then((activeWindow) => {
        if (!policy || activeWindow.isDestroyed()) return;
        return pairing?.prompt(activeWindow, policy);
      });
    },
    consoleReady: () => controls.consoleReady(),
    updates,
  };
  if (process.platform !== "darwin") {
    trayHolder.current = new Tray(desktopResources.iconPath);
    trayHolder.current.on("click", actions.show);
  }
  refreshNativeUpdateActions = () => {
    installApplicationMenu(Menu, actions, process.platform, window ?? undefined);
    if (trayHolder.current) configureTray(trayHolder.current, Menu, actions);
  };
  refreshNativeUpdateActions();
  await lifecycle.start();
  if (isPackaged) setInterval(() => { void updates.check(false); }, 60 * 60 * 1_000);
}

async function resolvePackagedRuntime(runtimePaths: ReturnType<typeof resolveRuntimePaths>, registry: ReturnType<typeof createRegistryChecker>, progress: RuntimeProgress, logger: DesktopLogger): Promise<SidecarRuntime> {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(sourceDirectory, "build", "node-runtime.json"), "utf8")) as NodeRuntimeManifest;
    const engine = readConsoleNodeEngine(runtimePaths.latest);
    if (!satisfiesNodeEngine(manifest.version, engine)) throw new Error("managed_node_engine_unsupported");
    // isValid 판정 전에 reconcile을 먼저 돌려, 교체 중 종료로 node가 사라지고 node.rollback만 남은 경우
    // 다운로드(오프라인 시 실패)로 가기 전에 유효한 이전 런타임을 복원한다(console latest.rollback과 대칭).
    await reconcileNodeRuntime(runtimePaths.node);
    if (!(await isManagedNodeRuntimeValid(runtimePaths.node, manifest, process.platform))) {
      await progress("node", "checksum verified", 0);
      await bootstrapNodeRuntime({ destination: runtimePaths.node, manifest, platform: process.platform, architecture: process.arch });
    }
    await reconcileConsoleInstallations(runtimePaths, createInstallerFileSystem());
    const installedVersion = readInstalledVersion(runtimePaths.latest);
    if (installedVersion) await repairConsoleNativeExecutables(runtimePaths.latest, process.platform, process.arch, createInstallerFileSystem());
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
    // 실제 원인(cause 체인·npm lifecycle의 stderr 등)을 로그 파일에 남긴 뒤, 조달 불가를 상위로 알린다.
    // console_runtime_unavailable로 감쌀 때도 cause를 보존해 상위 핸들러/telemetry가 원인을 추적할 수 있게 한다.
    logger.error(`console runtime procurement failed: ${describeError(error)}`);
    if (!readInstalledVersion(runtimePaths.latest)) throw new Error("console_runtime_unavailable", { cause: error });
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

function logBootFailure(error: unknown): void {
  try {
    const logger = bootLogger ?? createDesktopLogger(path.join(app.getPath("userData"), "logs"));
    logger.error(`bootstrap failed: ${describeError(error)}`);
  } catch {
    // 로깅 자체의 실패가 종료 처리를 막아서는 안 되므로 무시한다.
  }
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
