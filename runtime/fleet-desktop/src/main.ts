import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, Menu, Notification, screen, session, shell, Tray, WebContentsView, type Session } from "electron";

import { DESKTOP_BROWSER_CLEAR_PROFILE, DESKTOP_BROWSER_PROFILE_ID } from "@fleet-console/protocol/desktop";

import { createDesktopLifecycle } from "./app-lifecycle.js";
import { isConsoleConflict, showBootFailureAndExit, showConsoleConflictAndQuit } from "./boot-dialogs.js";
import { createConsoleControls } from "./console-controls.js";
import { handOffWindowToConsole, republishShellHomeOnArrival, type ShellHomePublication } from "./console-handoff.js";
import { createHydratedDesktopEnvironment, resolveBrowserProfileRoot, resolveDesktopUserDataDirectory } from "./environment.js";
import { pushEntrySnapshot } from "./entry-page.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createLaunchController, type RuntimeEntryState } from "./launch-controller.js";
import { createDesktopNotifier } from "./desktop-notices.js";
import { createHostPickerView } from "./host-picker-view.js";
import { findAccessLinkArgument, FLEET_PROTOCOL, isConsoleOrigin, isFleetProtocolLink, isRemoteConsoleOrigin } from "./console-links.js";
import { consoleTarget, createRemoteBridge, type RemoteBridge } from "./remote-bridge.js";
import { createShellNetwork } from "./shell-network.js";
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
import { installComputerCapture } from "./computer-capture.js";
import { createDesktopBrowserViews } from "./browser-views.js";
import { chromeImportSources, readChromeCookies, toElectronCookie } from "./chrome-cookies.js";
import { applyWindowPolicy, confinePickerNavigation, createSecureWindow, INITIAL_WINDOWS_TITLE_BAR_OVERLAY } from "./window-policy.js";
import { createZoomState } from "./zoom-state.js";

type RuntimeProgress = (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>;

const PACKAGE_NAME = "@dotobokuri/fleet-console";
// Console 계약의 경로 리터럴 — 다른 동기화기와 같은 방식으로 여기서 선언한다(Console 내부를 import하지 않는다).
const DESKTOP_SHELL_PATH = "/api/v1/desktop/shell";
const DESKTOP_BROWSER_CHROME_PROFILES = "Fleet.chromeProfiles";
const DESKTOP_BROWSER_IMPORT_COOKIES = "Fleet.importChromeCookies";
/** 세션 파티션 이름은 콘솔이 짓는다 — 뷰와 같은 모양만 받아 임의 세션에 쿠키가 들어가지 않게 한다. */
const BROWSER_PARTITION = /^fleet-browser-[A-Za-z0-9._:-]{1,64}$/u;
/**
 * 영속 브라우저 프로필의 세션. 한 프로필은 앱 안에서 하나뿐이라 Operation 여럿이 같은 로그인을 함께 쓴다.
 *
 * 콘솔은 **id 만** 보내고 경로는 여기서 만든다 — 임의 경로가 셸로 흘러들 길을 두지 않는다.
 * `fromPartition` 이 아니라 `fromPath` 인 것이 요점이다: 파티션은 앱의 `userData` 아래에 묶이는데,
 * 그 기본값이 Windows 에서 Roaming 이라 브라우저 캐시가 로그온마다 동기화된다.
 */
const browserProfileSessions = new Map<string, Session>();
function browserProfileSession(profile: string): Session {
  if (!DESKTOP_BROWSER_PROFILE_ID.test(profile)) throw new Error("browser_profile_invalid");
  const cached = browserProfileSessions.get(profile);
  if (cached) return cached;
  const directory = path.join(resolveBrowserProfileRoot(), profile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = session.fromPath(directory);
  browserProfileSessions.set(profile, created);
  return created;
}
/** 쿠키가 들어갈 자리 — 영속 프로필이거나, 그 Operation 의 임시 파티션이거나. 둘 다 아니면 받지 않는다. */
function browserTargetSession(params: Record<string, unknown>): { readonly session: Session; readonly label: string } | null {
  const profile = typeof params.browserProfile === "string" ? params.browserProfile : null;
  if (profile !== null) return DESKTOP_BROWSER_PROFILE_ID.test(profile) ? { session: browserProfileSession(profile), label: `profile ${profile}` } : null;
  const partition = typeof params.partition === "string" && BROWSER_PARTITION.test(params.partition) ? params.partition : null;
  return partition === null ? null : { session: session.fromPartition(partition), label: partition };
}
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const desktopResources = resolveDesktopResourcePaths(isPackaged);

applyDesktopIdentity(app);
if (!isPackaged) app.setPath("userData", resolveDesktopUserDataDirectory(app.getPath("userData"), desktopResources.serviceRoot, false));
if (isPackaged) app.setAsDefaultProtocolClient(FLEET_PROTOCOL);
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
  // 원격 콘솔은 자체서명 인증서 뒤에서 세션을 요구한다. Node의 fetch는 둘 다 갖지 못하므로 그 origin으로 가는
  // 메인 프로세스 요청은 인증서 핀과 세션 쿠키를 갖춘 세션을 타야 한다 — 다만 창의 것이어서는 안 된다(shell-network.ts).
  const consoleSession = session.defaultSession;
  const shellNetwork = createShellNetwork({
    windowSession: consoleSession,
    // 이름 앞에 `persist:`를 두지 않아 메모리에만 산다 — 베껴 온 자격이 디스크에 두 번째 사본으로 남지 않는다.
    shellSession: session.fromPartition("fleet-shell"),
    isRemote: isRemoteConsoleOrigin,
    log: (message) => logger.error(message),
  });
  const remotePins = shellNetwork.pins;
  const consoleFetch = shellNetwork.fetch;
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
  /**
   * 이 구독은 **이 셸이 감독하는 설치본**에 대한 것이다. 창이 남의 콘솔을 보고 있다고 해서
   * 그 콘솔의 업데이트 요청을 이 기계가 수행해서는 안 된다 — 그러면 원격 호스트가 눌린
   * 업데이트에 이쪽 앱이 재시작되고, 정작 그 호스트는 갱신되지 않는다.
   */
  const subscribeSupervisedConsoleUpdates = async (origin: string): Promise<void> => {
    if (origin !== localConsoleOrigin) {
      updateSynchronizer.stop();
      return;
    }
    await updateSynchronizer.start(origin);
  };
  let fullscreenSynchronizer: ReturnType<typeof createDesktopFullscreenSynchronizer> | null = null;
  /**
   * Operation 브라우저의 네이티브 뷰. 창이 어느 콘솔에 있든 그 콘솔의 탭을 이 창에 그린다 — 원격 콘솔로 건너가면
   * 그 콘솔의 에이전트가 이 기계의 Chromium 을 움직인다. 브라우저는 Desktop 앱의 기능이고 원격에서도 같은 경험이어야
   * 한다는 제품 결정이다. 뷰는 세션 파티션에 격리되어 이 앱의 쿠키·로그인과 섞이지 않는다.
   */
  const browserViews = createDesktopBrowserViews({
    window: () => window,
    // 항해는 에이전트도 수행한다 — 페이지 적재가 Console의 입력 포커스를 가져가면 안 된다.
    // 사람이 뷰를 직접 클릭해 포커스를 옮기는 경로는 그대로 둔다.
    // 영속 프로필이면 그 프로필의 디스크 세션에, 아니면 Operation 의 메모리 파티션에 뷰를 연다.
    createView: (partition, profile) => new WebContentsView({
      webPreferences: {
        ...(profile === null ? { partition } : { session: browserProfileSession(profile) }),
        focusOnNavigation: false, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      },
    }),
    zoomFactor: () => window?.webContents.getZoomFactor() ?? 1,
    scaleFactor: () => { try { return window ? screen.getDisplayMatching(window.getBounds()).scaleFactor : 1; } catch { return 1; } },
    product: () => `Chrome/${process.versions.chrome}`,
    // 셸의 표기를 뺀 일반 Chrome UA — 페이지가 Electron 앱 안에 있다고 알 이유가 없다.
    userAgent: () => (window?.webContents.getUserAgent() ?? "").replace(/ (?:Electron|FleetConsole\w*|fleet-console\w*)\/\S+/gu, ""),
    fetch: consoleFetch,
    log: (message) => logger.info(message),
    /**
     * 창을 든 기계에서만 답할 수 있는 명령 — 이 기계의 Google Chrome 프로필과 그 쿠키. 뷰는 파티션에 격리되어
     * 있으므로 쿠키는 그 파티션의 세션에만 들어가고 창의 쿠키 저장소는 건드리지 않는다.
     */
    shellCommand: async (method, params) => {
      if (method === DESKTOP_BROWSER_CHROME_PROFILES) return chromeImportSources();
      if (method === DESKTOP_BROWSER_IMPORT_COOKIES) {
        const target = browserTargetSession(params);
        const profileId = typeof params.profileId === "string" ? params.profileId : null;
        if (!target || !profileId) throw new Error("chrome_import_invalid");
        const cookies = await readChromeCookies({ profileId, tempRoot: app.getPath("temp"), log: (message) => logger.info(message) });
        const jar = target.session.cookies;
        let imported = 0;
        for (const cookie of cookies) { try { await jar.set(toElectronCookie(cookie)); imported += 1; } catch { /* 이 쿠키는 못 넣는다 */ } }
        logger.info(`imported ${imported}/${cookies.length} cookies from Chrome profile ${profileId} into ${target.label}`);
        return { cookies: imported };
      }
      if (method === DESKTOP_BROWSER_CLEAR_PROFILE) {
        const profile = typeof params.browserProfile === "string" ? params.browserProfile : null;
        if (profile === null || !DESKTOP_BROWSER_PROFILE_ID.test(profile)) throw new Error("browser_profile_invalid");
        // 콘솔이 이 프로필의 뷰를 먼저 모두 닫고 부른다 — Windows 는 열려 있는 파일을 지우지 못한다.
        await browserProfileSession(profile).clearStorageData();
        logger.info(`cleared browser profile ${profile}`);
        return { cleared: true };
      }
      throw new Error("desktop_shell_unsupported");
    },
  });
  const synchronizeBrowserViews = async (origin: string): Promise<void> => {
    try { await browserViews.start(origin); } catch (error) { logger.error(`browser views failed: ${describeError(error)}`); }
  };
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
  const publishShellHome = async (origin: string): Promise<ShellHomePublication> => {
    const home = localConsoleOrigin;
    if (!home) return "rejected";
    try {
      const put = (body: Record<string, unknown>) => consoleFetch(`${origin}${DESKTOP_SHELL_PATH}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
      // 돌아갈 줄이 버전 표기보다 중요하다. 게시 전체는 창을 띄우는 마감(console-handoff.ts)과 경주하므로,
      // 어느 Console이든 받는 집만 적은 몸을 먼저 보내 마감이 이겨도 집은 남게 한다.
      const response = await put({ homeOrigin: home });
      // 세션이 아직 없는 원격 콘솔은 401로 답한다 — 재기동 직후라면 화면이 곧 되살리므로 오류가 아니다.
      if (response.status === 401) return "unauthorized";
      // 경로가 어긋나면 404가 조용히 돌아온다 — 돌아갈 줄이 사라진 이유를 로그에서 찾을 수 있어야 한다.
      if (!response.ok) {
        logger.error(`shell home publish rejected status=${response.status}`);
        return "rejected";
      }
      // 버전은 그 위에 덧쓴다. 이 키를 모르는 옛 Console은 400으로 거절하고, 그때는 이미 게시된 집이 그대로 선다.
      const versioned = await put({ homeOrigin: home, version: app.getVersion() });
      if (!versioned.ok && versioned.status !== 400) logger.error(`shell version publish rejected status=${versioned.status}`);
      return "accepted";
    } catch (error) {
      logger.error(`shell home publish failed: ${describeError(error)}`);
      return "failed";
    }
  };
  const bridge: RemoteBridge = createRemoteBridge({
    pins: remotePins,
    policy: () => policy,
    sessionFetch: (input, init) => consoleSession.fetch(input, init),
    localOrigin: () => localConsoleOrigin,
    deviceName: os.hostname().replace(/\.local$/iu, ""),
    loadConsole: (url) => handOffWindowToConsole({
      publishShellHome: async (origin) => { await publishShellHome(origin); },
      loadUrl: async (target) => { await window?.loadURL(target); },
      synchronizeTheme: async (origin) => { await themeSynchronizer?.start(origin); await subscribeSupervisedConsoleUpdates(origin); await synchronizeBrowserViews(origin); },
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
          browserViews.stop();
          fullscreenSynchronizer?.stop();
          fullscreenSynchronizer = null;
          overlayRefresher?.stop();
          overlayRefresher = null;
          picker.close();
        });
        controls.attachWindow(createdWindow);
        lifecycle.attachWindow(createdWindow);
        policy = applyWindowPolicy(createdWindow.webContents, async (external) => shell.openExternal(external));
        installComputerCapture(createdWindow.webContents, () => policy?.currentConsoleOrigin() === localConsoleOrigin ? localConsoleOrigin : null, (message) => logger.info(message));
        bridge.attach(createdWindow.webContents);
        createdWindow.webContents.on("did-navigate", (_event, url) => {
          // 창이 어디로 옮겨 가든 덮개는 따라가지 않는다 — 새 콘솔 위에 남은 옛 목록은 거짓말이다.
          picker.close();
          // 셸이 넘긴 항해는 도착 전에 게시했다. 그 밖의 도착 — 새로고침, 재기동한 콘솔로 화면이 스스로
          // 되돌아온 경우 — 는 여기서 게시한다. 재기동한 콘솔은 앞선 게시를 잊었기 때문이다.
          let origin: string;
          try { origin = new URL(url).origin; } catch { return; }
          if (!isConsoleOrigin(origin) || policy?.currentConsoleOrigin() !== origin) return;
          void republishShellHomeOnArrival({
            publish: publishShellHome,
            stillAt: (at) => !createdWindow.isDestroyed() && policy?.currentConsoleOrigin() === at,
          }, origin).then((outcome) => {
            if (outcome !== "accepted") logger.error(`shell home republish after arrival ended outcome=${outcome} origin=${origin}`);
          });
        });
        createdWindow.webContents.on("zoom-changed", (_event, zoomDirection) => {
          controls.zoomChanged(createdWindow.webContents, zoomDirection);
          overlayRefresher?.refresh();
          browserViews.refresh();
        });
        // 뷰의 자리는 패널이 CSS px 로 알린다 — 줌·창 크기가 바뀌면 같은 자리를 DIP 로 다시 놓는다.
        createdWindow.on("resize", () => browserViews.refresh());
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
      synchronizeTheme: async (origin) => { await themeSynchronizer?.start(origin); await subscribeSupervisedConsoleUpdates(origin); await synchronizeBrowserViews(origin); },
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
