import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, Notification, screen, session, shell, Tray, WebContentsView } from "electron";

import { createDesktopLifecycle } from "./app-lifecycle.js";
import { showBootFailureAndExit } from "./boot-failure.js";
import { isConsoleConflict, showConsoleConflictAndQuit } from "./console-conflict.js";
import { createConsoleControls } from "./console-controls.js";
import { handOffWindowToConsole } from "./console-handoff.js";
import { createHydratedDesktopEnvironment, resolveDesktopUserDataDirectory } from "./environment.js";
import { pushEntrySnapshot } from "./entry-page.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createLaunchController, type RuntimeEntryState } from "./launch-controller.js";
import { createDesktopNotifier } from "./desktop-notices.js";
import { createHostPickerView } from "./host-picker-view.js";
import { isRemoteConsoleOrigin } from "./console-origin.js";
import { installRemoteCertificatePins } from "./remote-access.js";
import { consoleTarget, createRemoteBridge, type RemoteBridge } from "./remote-bridge.js";
import { findAccessLinkArgument, FLEET_PROTOCOL, isFleetProtocolLink } from "./fleet-protocol.js";
import { createDesktopLogger, describeError, type DesktopLogger } from "./logging.js";
import { createDesktopThemeSynchronizer } from "./desktop-theme-sync.js";
import { createDesktopUpdateSynchronizer } from "./desktop-update-sync.js";
import { createDesktopFullscreenSynchronizer } from "./desktop-fullscreen-sync.js";
import { installApplicationMenu } from "./menu.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { createConsoleInstallerDependencies, installConsole, reconcileConsoleInstallations, repairConsoleNativeExecutables } from "./runtime/console-installer.js";
import { bootstrapNodeRuntime, isManagedNodeRuntimeValid, reconcileNodeRuntime, satisfiesNodeEngine, type NodeRuntimeManifest } from "./runtime/node-bootstrap.js";
import { createRegistryChecker } from "./runtime/registry-check.js";
import { resolveRuntimePaths } from "./runtime/runtime-paths.js";
import { SidecarSupervisor, type SidecarRuntime } from "./sidecar-supervisor.js";
import { configureTray, createDesktopTray, shouldConfigureTray } from "./tray.js";
import { createNoopUpdateController, createUpdateController, resolveActiveWindow, showWindowsHiddenUpdateDialog } from "./update-controller.js";
import { createTitleBarOverlayRefresher, type TitleBarOverlayRefresher } from "./title-bar-overlay-refresh.js";
import { applyWindowPolicy, confinePickerNavigation, createSecureWindow, INITIAL_WINDOWS_TITLE_BAR_OVERLAY } from "./window-policy.js";
import { createZoomState } from "./zoom-state.js";

type RuntimeProgress = (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>;

const PACKAGE_NAME = "@dotobokuri/fleet-console";
// Console 계약의 경로 리터럴 — 다른 동기화기와 같은 방식으로 여기서 선언한다(Console 내부를 import하지 않는다).
const DESKTOP_SHELL_PATH = "/api/v1/desktop/shell";
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const desktopResources = resolveDesktopResourcePaths(isPackaged);

applyDesktopIdentity(app);
if (!isPackaged) app.setPath("userData", resolveDesktopUserDataDirectory(app.getPath("userData"), desktopResources.serviceRoot, false));
app.setAsDefaultProtocolClient(FLEET_PROTOCOL);
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
  // 로그만 남기고 조용히 사라지면 Finder로 연 사용자에게는 앱이 그냥 뜨지 않은 것이다.
  showBootFailureAndExit(error, {
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
    exit: (code) => app.exit(code),
    logDirectory: readBootLogDirectory(),
  });
});

const trayHolder: { current: Tray | null } = { current: null };
let bootLogger: DesktopLogger | null = null;

// macOS는 앱이 준비되기 전에도 open-url을 던진다. boot()가 끝나기 전에 도착한 링크를 잃지
// 않도록 여기서 먼저 받아 두고, 배관이 서면 그때 흘려보낸다.
const pendingAccessLinks: string[] = [];
let deliverAccessLink: ((link: string) => void) | null = null;

function receiveAccessLink(link: string | null): void {
  if (link === null) return;
  if (deliverAccessLink) deliverAccessLink(link);
  else pendingAccessLinks.push(link);
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAccessLink(isFleetProtocolLink(url) ? url : null);
});
app.on("second-instance", (_event, argv) => receiveAccessLink(findAccessLinkArgument(argv)));

async function boot(): Promise<void> {
  await app.whenReady();
  applyDesktopDockIcon(app, desktopResources.iconPath);
  const runtimePaths = resolveRuntimePaths(os.homedir());
  const environment = await createHydratedDesktopEnvironment(app.getPath("userData"), app.getVersion(), desktopResources.serviceRoot, isPackaged);
  const logger = createDesktopLogger(path.join(app.getPath("userData"), "logs"));
  bootLogger = logger;
  const registry = createRegistryChecker({ packageName: PACKAGE_NAME, statePath: path.join(runtimePaths.root, "registry-state.json") });
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
  let localConsoleOrigin: string | null = null;
  // 원격 콘솔은 자체서명 인증서 뒤에서 세션을 요구한다. Node의 fetch는 둘 다 갖지 못하므로
  // 그 origin으로 가는 메인 프로세스 요청은 창이 쓰는 바로 그 세션을 타야 한다.
  const consoleSession = session.defaultSession;
  const remotePins = installRemoteCertificatePins(consoleSession, (message) => logger.error(message));
  const consoleFetch: typeof fetch = (input, init) => {
    // 동기화기는 문자열 URL만 넘긴다. Request가 오면 조용히 다른 경로로 보내지 않고 기존 경로를 쓴다.
    if (typeof input !== "string" && !(input instanceof URL)) return globalThis.fetch(input, init);
    const url = typeof input === "string" ? input : input.href;
    return isRemoteConsoleOrigin(new URL(url).origin) ? consoleSession.fetch(url, init) : globalThis.fetch(url, init);
  };
  let overlayRefresher: TitleBarOverlayRefresher | null = null;
  const themeSynchronizer = process.platform === "win32"
    ? createDesktopThemeSynchronizer({
      fetch: consoleFetch,
      applyTheme: (snapshot) => {
        if (!window || window.isDestroyed()) return;
        // 리프레셔가 현재 모니터 배율 보정을 소유한다 — 창이 아직 없으면 적용할 곳도 없다.
        overlayRefresher?.applyOverlay(snapshot.titleBarOverlay);
      },
    })
    : null;
  /**
   * 테마 오버레이와 달리 이 구독은 플랫폼을 가리지 않는다 — 콘솔이 스스로 갈아 끼울 수 없는
   * 설치 레이아웃은 어느 OS에서나 셸이 수행해야 한다. updates는 아래에서 만들어지므로
   * 여기서는 그때 채워질 자리만 잡는다.
   */
  let applyDelegatedUpdate: ((version: string) => void) | null = null;
  const updateSynchronizer = createDesktopUpdateSynchronizer({
    fetch: consoleFetch,
    applyUpdate: (version) => applyDelegatedUpdate?.(version),
  });
  let fullscreenSynchronizer: ReturnType<typeof createDesktopFullscreenSynchronizer> | null = null;
  let refreshNativeUpdateActions: (() => void) | null = null;
  const zoomState = createZoomState(path.join(app.getPath("userData"), "desktop-state.json"));
  const controls = createConsoleControls({ zoomState, refreshNativeActions: () => refreshNativeUpdateActions?.() });
  /**
   * 다른 콘솔로 건너가는 화면은 Console 안에 있다. Desktop이 남기는 것은 인증서 한 겹뿐이라,
   * 이 다리는 메뉴에도 트레이에도 나타나지 않는다.
   */
  const notifier = createDesktopNotifier(Notification, { showMessageBox: (options) => dialog.showMessageBox(options) });
  /**
   * 창이 어느 콘솔에 있든 "이 셸이 띄운 콘솔이 어디인가"는 알려 준다. 집이 아닌 콘솔이 서빙한
   * 화면은 자기가 떠나온 곳을 알 수 없으므로 — 원격이든 이 기계의 다른 콘솔이든 — 이것이 없으면
   * 돌아갈 길이 사라진다. 이 값이 창보다 먼저 도착해야 하는 이유는 console-handoff.ts에 있다.
   */
  const publishShellHome = async (origin: string): Promise<void> => {
    const home = localConsoleOrigin;
    if (!home) return;
    try {
      const response = await consoleFetch(`${origin}${DESKTOP_SHELL_PATH}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ homeOrigin: home }),
      });
      // 경로가 어긋나면 404가 조용히 돌아온다 — 돌아갈 줄이 사라진 이유를 로그에서 찾을 수 있어야 한다.
      if (!response.ok) logger.error(`shell home publish rejected status=${response.status}`);
    } catch (error) {
      logger.error(`shell home publish failed: ${describeError(error)}`);
    }
  };
  const bridge: RemoteBridge = createRemoteBridge({
    pins: remotePins,
    policy: () => policy,
    sessionFetch: (input, init) => consoleSession.fetch(input, init),
    localOrigin: () => localConsoleOrigin,
    deviceName: os.hostname().replace(/\.local$/iu, ""),
    loadConsole: (url) => handOffWindowToConsole({
      publishShellHome,
      loadUrl: async (target) => { await window?.loadURL(target); },
      synchronizeTheme: async (origin) => { await Promise.all([themeSynchronizer?.start(origin), updateSynchronizer.start(origin)]); },
      synchronizeFullscreen: (origin) => fullscreenSynchronizer?.activate(origin),
    }, url),
    openPicker: (url) => picker.open(url),
    closePicker: () => picker.close(),
    notify: (notice) => notifier.show(notice),
    log: (message) => logger.error(message),
  });
  /**
   * 집의 목록을 지금 보고 있는 콘솔 위에 펼치는 덮개. 화면은 집이 그리고, Desktop은 그 렌더러를
   * 얹었다 걷는 일만 한다 — 어느 콘솔을 고를지도, 그 이름도 여기서 정하지 않는다.
   */
  const picker = createHostPickerView({
    createView: () => {
      const view = new WebContentsView({
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      });
      // 덮개는 아래 콘솔 위에 합성된다 — 목록을 보는 동안에도 어느 콘솔에 서 있었는지가 남아야 한다.
      view.setBackgroundColor("#00000000");
      return view;
    },
    window: () => window,
    confine: (contents) => confinePickerNavigation(contents, localConsoleOrigin ?? "", (url) => consoleTarget(url, localConsoleOrigin) !== null),
    attachBridge: (contents) => bridge.attachPicker(contents),
    log: (message) => logger.error(message),
  });
  const lifecycle = createDesktopLifecycle(app, async () => {
    const launch = createLaunchController({
      createWindow: async () => {
        const createdWindow = createSecureWindow(BrowserWindow, { iconPath: desktopResources.iconPath, platform: process.platform });
        window = createdWindow;
        fullscreenSynchronizer = createDesktopFullscreenSynchronizer(createdWindow, { fetch: consoleFetch });
        overlayRefresher = process.platform === "win32"
          ? createTitleBarOverlayRefresher(createdWindow, {
            screen,
            initialOverlay: INITIAL_WINDOWS_TITLE_BAR_OVERLAY,
            getZoomFactor: () => createdWindow.webContents.getZoomFactor(),
          })
          : null;
        createdWindow.once("closed", () => {
          themeSynchronizer?.stop();
          updateSynchronizer.stop();
          fullscreenSynchronizer?.stop();
          fullscreenSynchronizer = null;
          overlayRefresher?.stop();
          overlayRefresher = null;
          picker.close();
        });
        controls.attachWindow(createdWindow);
        lifecycle.attachWindow(createdWindow);
        policy = applyWindowPolicy(createdWindow.webContents, async (external) => shell.openExternal(external));
        bridge.attach(createdWindow.webContents);
        // 창이 어디로 옮겨 가든 덮개는 따라가지 않는다 — 새 콘솔 위에 남은 옛 목록은 거짓말이다.
        createdWindow.webContents.on("did-navigate", () => picker.close());
        createdWindow.webContents.on("zoom-changed", (_event, zoomDirection) => {
          controls.zoomChanged(createdWindow.webContents, zoomDirection);
          overlayRefresher?.refresh();
        });
        // 시작 시 복원되는 줌은 이벤트를 내지 않는다 — 로드가 끝난 자리에서 보정 높이를 재확인한다.
        createdWindow.webContents.on("did-finish-load", () => overlayRefresher?.refresh());
        // 스냅·최대화 전환(Win+Shift+화살표 등)은 moved 없이 모니터를 건널 수 있다 — 게이트가
        // no-op이므로 상태 전환마다 배율 정합을 재확인해도 비용이 없다.
        createdWindow.on("maximize", () => overlayRefresher?.refresh());
        createdWindow.on("unmaximize", () => overlayRefresher?.refresh());
        createdWindow.on("restore", () => overlayRefresher?.refresh());
        refreshNativeUpdateActions?.();
        await createdWindow.loadFile(desktopResources.entryPagePath);
        return createdWindow;
      },
      dev: !isPackaged,
      handoffOrigin: (origin) => {
        localConsoleOrigin = origin;
        policy?.activateConsoleOrigin(origin);
        controls.handoffStarted();
        void publishShellHome(origin);
      },
      synchronizeTheme: async (origin) => { await Promise.all([themeSynchronizer?.start(origin), updateSynchronizer.start(origin)]); },
      synchronizeFullscreen: (origin) => fullscreenSynchronizer?.activate(origin),
      onConsoleLoaded: () => controls.onConsoleLoaded(),
      onFirstRunFailure: async () => showFirstRunFailure(),
      onWindowReady: (push) => { pushRuntimeProgress = push; },
      pushEntry: pushEntrySnapshot,
      startOrAdopt: () => supervisor.startOrAdopt(),
    });
    return launch.start() as Promise<BrowserWindow>;
  }, async () => { bridge.dispose(); await supervisor.stop(); });
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
  applyDelegatedUpdate = (version) => { void updates.applyRequested(version); };
  const actions = {
    show: () => { void lifecycle.show(); },
    quit: () => { void lifecycle.quit(); },
    diagnostics: () => { void shell.openPath(path.join(app.getPath("userData"), "logs")); },
    zoomIn: () => { controls.zoomIn(); overlayRefresher?.refresh(); },
    zoomOut: () => { controls.zoomOut(); overlayRefresher?.refresh(); },
    actualSize: () => { controls.actualSize(); overlayRefresher?.refresh(); },
    reloadConsole: () => controls.reloadConsole(),
    consoleReady: () => controls.consoleReady(),
    updates,
  };
  trayHolder.current = createDesktopTray(process.platform, Tray, desktopResources, actions);
  refreshNativeUpdateActions = () => {
    installApplicationMenu(Menu, actions, process.platform, window ?? undefined);
    // macOS에서는 context menu가 좌클릭을 가로채므로, 클릭으로 창을 표시하는 트레이에 메뉴를 절대 붙이지 않는다.
    if (shouldConfigureTray(process.platform) && trayHolder.current) configureTray(trayHolder.current, Menu, actions);
  };
  refreshNativeUpdateActions();
  await lifecycle.start();
  // 링크는 창을 하나 더 만들지 않는다 — 이미 떠 있는 Console에 넘겨 목록에 들이게 할 뿐이다.
  deliverAccessLink = (link) => {
    void lifecycle.show()
      .then(() => bridge.receiveLink(link))
      .catch((error: unknown) => bridge.report(error));
  };
  for (const link of pendingAccessLinks.splice(0)) deliverAccessLink(link);
  receiveAccessLink(findAccessLinkArgument(process.argv));
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
  const activeWindow = resolveActiveWindow(window);
  const options = { type: "info" as const, title: "Update available", message: `Fleet Console ${version} is ready to install.`, detail: "Takes a few seconds and restarts the console — running operations restore as dormant panels.", buttons: ["Update and Restart", "Later"], defaultId: 0, cancelId: 1, checkboxLabel: "Skip this version" };
  const show = async (): Promise<{ response: number; checkboxChecked: boolean }> => {
    markPrompted();
    return activeWindow ? dialog.showMessageBox(activeWindow, options) : dialog.showMessageBox(options);
  };
  // Windows 실기는 darwin에서 [Unverified]다. 숨은 트레이 창은 balloon 클릭 뒤에만 모달을 연다.
  return process.platform === "win32" ? showWindowsHiddenUpdateDialog(activeWindow, trayHolder.current, version, show) : show();
}

function readBootLogDirectory(): string | null {
  try {
    return path.join(app.getPath("userData"), "logs");
  } catch {
    return null;
  }
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
