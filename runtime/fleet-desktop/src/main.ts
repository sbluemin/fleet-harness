import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BaseWindow, dialog, Menu, nativeImage, Notification, screen, session, shell, Tray, WebContentsView, type Session } from "electron";

import { DESKTOP_BROWSER_CLEAR_PROFILE, DESKTOP_BROWSER_PROFILE_ID } from "@fleet-console/protocol/desktop";
import { readConsoleReleaseTagOverride } from "@fleet-console/protocol/release";

import { autoUpdater } from "electron-updater";

import { createDesktopLifecycle } from "./app-lifecycle.js";
import { terminateSessionHost } from "@fleet-console/lifecycle";
import { prepareDesktopSessionUpdate } from "./update-handoff.js";
import { describeConsoleUpdateFailure } from "@fleet-console/protocol/lifecycle";
import { isConsoleConflict, showBootFailureAndExit, showConsoleConflictAndQuit } from "./boot-dialogs.js";
import { createConsoleControls } from "./console-controls.js";
import { handOffWindowToConsole, republishShellHomeOnArrival, type ShellHomePublication } from "./console-handoff.js";
import { createHydratedDesktopEnvironment, resolveBrowserProfileRoot, resolveDesktopUserDataDirectory } from "./environment.js";
import { pushEntrySnapshot, type EntryPalette } from "./entry-page.js";
import { createQuitFarewell, farewellSnapshot } from "./quit-farewell.js";
import { measureBrandTarget } from "./brand-target.js";
import { applyDesktopDockIcon, applyDesktopIdentity } from "./identity.js";
import { createLaunchController, type RuntimeEntryState } from "./launch-controller.js";
import { createDesktopNotifier } from "./desktop-notices.js";
import { createHostPickerView } from "./host-picker-view.js";
import { createConsoleSectionController } from "./console-section-controller.js";
import { CONSOLE_DIRECTORY_CAPABILITY } from "@fleet-console/protocol/desktop/console-section";
import { findAccessLinkArgument, FLEET_PROTOCOL, isConsoleOrigin, isFleetProtocolLink, isRemoteConsoleOrigin } from "./console-links.js";
import { releaseFetchBody } from "./remote-access.js";
import { consoleTarget, createRemoteBridge, type RemoteBridge } from "./remote-bridge.js";
import { createShellNetwork } from "./shell-network.js";
import { createDesktopLogger, describeError, type DesktopLogger } from "./logging.js";
import { createDesktopThemeSynchronizer } from "./desktop-theme-sync.js";
import { createDesktopUpdateSynchronizer } from "./desktop-update-sync.js";
import { createDesktopWindowCommandSynchronizer, createFullscreenController, type FullscreenController } from "./desktop-window-command.js";
import { installApplicationMenu } from "./menu.js";
import { resolveDesktopResourcePaths } from "./resource-paths.js";
import { createConsoleInstallerDependencies, installConsole, reconcileConsoleInstallations, repairConsoleNativeExecutables } from "./runtime/console-installer.js";
import { bootstrapNodeRuntime, isManagedNodeRuntimeValid, reconcileNodeRuntime, satisfiesNodeEngine, type NodeRuntimeManifest } from "./runtime/node-bootstrap.js";
import { createReleaseChecker } from "./runtime/release-check.js";
import { resolveRuntimePaths } from "./runtime/runtime-paths.js";
import { SidecarSupervisor, type SidecarRuntime } from "./sidecar-supervisor.js";
import { configureTray, createDesktopTray, shouldConfigureTray } from "./tray.js";
import { createConsoleRelaunchController, createDisabledNativeUpdateActions, createNoopConsoleRelaunchController, type NativeUpdateActions } from "./update-controller.js";
import { createShellUpdateCommandSynchronizer, createShellUpdatePublisher, createShellUpdater, type ShellUpdater } from "./shell-update.js";
import { createTitleBarOverlayRefresher, type TitleBarOverlayRefresher } from "./title-bar-overlay-refresh.js";
import { installComputerCapture, openScreenRecordingSettings, requestAccessibilityPermission } from "./computer-capture.js";
import { createDesktopBrowserViews } from "./browser-views.js";
import { chromeImportSources, readChromeCookies, toElectronCookie } from "./chrome-cookies.js";
import type { DesktopShellWindow } from "./shell-window.js";
import { applyWindowPolicy, CANVAS_FAR_BACKGROUND_COLOR, localFontsConsentDialog, confinePickerNavigation, createSecureShellWindow, INITIAL_WINDOWS_TITLE_BAR_OVERLAY, CONVERSATION_TOP_ROW, trafficLightPosition } from "./window-policy.js";
import { createSwitchHold } from "./switch-hold.js";
import { createThemeMemory } from "./theme-memory.js";
import { createZoomState, zoomFactorForLevel } from "./zoom-state.js";

type RuntimeProgress = (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>;

const PACKAGE_NAME = "@dotobokuri/fleet-console";
// Console 계약의 경로 리터럴 — 다른 동기화기와 같은 방식으로 여기서 선언한다(Console 내부를 import하지 않는다).
const DESKTOP_SHELL_PATH = "/api/v1/desktop/shell";
/** 이 셸이 해석하는 Console 신호(window-policy의 local-fonts 항해). Console 계약의 리터럴을 여기서 선언한다. */
const DESKTOP_SHELL_CAPABILITIES = ["local-fonts", CONSOLE_DIRECTORY_CAPABILITY];
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
    return showConsoleConflictAndQuit(error, { showMessageBox: (options) => dialog.showMessageBox(options), quit: () => app.quit(), logDirectory: readBootLogDirectory() });
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
  const releases = createReleaseChecker();
  let pushRuntimeProgress: RuntimeProgress | null = null;
  const initialServiceVersion = readInstalledVersion(isPackaged ? runtimePaths.latest : desktopResources.serviceRoot) ?? "";
  const supervisor = new SidecarSupervisor({
    ...(isPackaged
      ? { resolveRuntime: () => resolvePackagedRuntime(runtimePaths, releases, (state, detail, progress) => pushRuntimeProgress?.(state, detail, progress) ?? Promise.resolve(), logger) }
      : { nodePath: desktopResources.nodePath, cliPath: desktopResources.cliPath, serviceRoot: desktopResources.serviceRoot }),
    env: environment.serviceEnv,
    lockFile: path.join(environment.consoleDir, "console.lock"),
    ownerId: environment.ownerId,
    legacyLockCleanup: isPackaged,
    serviceVersion: initialServiceVersion,
    log: logger,
  });
  let window: DesktopShellWindow | null = null;
  let startupEntry: WebContentsView | null = null;
  const dismissStartupEntry = (): void => {
    const view = startupEntry;
    startupEntry = null;
    pushRuntimeProgress = null;
    if (!view) return;
    try { window?.stack.removeVeil(view); } catch { /* 창이 먼저 닫혔다. */ }
    try { view.webContents.close(); } catch { /* 이미 닫힌 렌더러. */ }
    try { window?.consoleContents.focus(); } catch { /* 닫힌 창. */ }
  };
  let policy: ReturnType<typeof applyWindowPolicy> | null = null;
  let localConsoleOrigin: string | null = null;
  // 창이 지금 보고 있는 콘솔. 셸 갱신 상태는 이 주소에 게시하고 명령도 이 주소에서 듣는다 —
  // 원격 콘솔을 보고 있어도 이 앱은 이 기계의 앱이므로, 그 화면에서도 같은 줄이 서야 한다.
  let servingConsoleOrigin: string | null = null;
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
  /**
   * 줌·모니터가 바뀌면 네이티브 크롬의 기하를 다시 맞춘다. Windows는 캡션 버튼 스트립의
   * 높이를, macOS는 신호등의 세로 자리를 — 둘 다 페이지 줌을 스스로 따라가지 못한다.
   * 한 창에서 둘 중 하나만 산다.
   */
  // 맨 위 줄 높이 — Console 이 테마 스냅샷의 chrome.band 로 알린다(대화 중심 화면의 52px). 신호등은 그 줄 가운데에 선다.
  let chromeBand: number | undefined;
  const placeTrafficLights = (): void => {
    if (process.platform !== "darwin" || !window || window.isDestroyed()) return;
    // 넘겨주기 중에는 창이 아직 진입 화면 배율이다 — 곧 적용될 저장 줌 자리에 미리 세워, 진입 마크가 Console 배율의
    // 맨 위 줄에 내려앉는 순간부터 Console 적재 뒤까지 신호등이 한 자리에 머문다.
    const pendingZoomLevel = controls.pendingZoomLevel();
    const zoomFactor = pendingZoomLevel === null ? window.consoleContents.getZoomFactor() : zoomFactorForLevel(pendingZoomLevel);
    window.setWindowButtonPosition(trafficLightPosition(zoomFactor, chromeBand));
  };
  const refreshNativeChrome = (): void => {
    overlayRefresher?.refresh();
    placeTrafficLights();
  };
  const entryLanguage = app.getLocale().toLowerCase().startsWith("ko") ? "ko" : "en";
  /**
   * 호스트를 갈아타는 동안 옛 화면을 붙잡아 두는 판. 진입 화면·종료 인사처럼 수동적인 로컬 뷰다 — 어디로도
   * 항해하지 않고 창도 열지 않으며, 원격 콘솔의 렌더러와는 아무것도 나누지 않는다.
   */
  const switchHold = createSwitchHold({
    shell: () => window,
    createView: () => {
      const view = new WebContentsView({
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
      });
      // 판은 Console 위에 합성된다 — 옛 화면 한 장이 차기 전에는 아래가 그대로 비친다.
      view.setBackgroundColor("#00000000");
      view.webContents.on("will-navigate", (event) => event.preventDefault());
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      return view;
    },
    pagePath: desktopResources.switchPagePath,
    lang: entryLanguage,
    scheme: () => entryPalette?.scheme ?? "dark",
    band: () => (chromeBand ?? CONVERSATION_TOP_ROW) * (window && !window.isDestroyed() ? window.consoleContents.getZoomFactor() : 1),
    log: (message) => logger.info(message),
  });
  /**
   * 사용자 테마는 Windows 제목 표시줄만의 일이 아니다 — 진입 화면·종료 인사·창 바탕도 따른다. 그래서
   * 구독은 모든 플랫폼에서 열고, 제목 표시줄 적용만 Windows 리프레셔(다른 OS에선 null)가 맡는다.
   */
  const themeMemory = createThemeMemory(path.join(app.getPath("userData"), "desktop-theme.json"));
  const rememberedTheme = themeMemory.load();
  chromeBand = rememberedTheme?.chrome?.band;
  let entryPalette: EntryPalette | undefined = rememberedTheme?.entry;
  let themeOrigin: string | null = null;
  const themeSynchronizer = createDesktopThemeSynchronizer({
    fetch: consoleFetch,
    applyTheme: (snapshot) => {
      // 이 필드를 싣지 않는 Console이면 무엇을 칠할지 모른다 — 창과 종료 인사 모두 기본 판으로 돌아간다.
      entryPalette = snapshot.entry;
      if (snapshot.entry && themeOrigin !== null && themeOrigin === localConsoleOrigin) themeMemory.save(snapshot);
      if (!window || window.isDestroyed()) return;
      const canvas = snapshot.entry?.canvas ?? CANVAS_FAR_BACKGROUND_COLOR;
      window.base.setBackgroundColor(canvas);
      window.consoleView.setBackgroundColor(canvas);
      // 판이 옛 화면을 쥐고 있는 동안 타이틀바·신호등은 그 화면에 맞춰 둔다 — 판이 흐려지는 순간 같이 바뀐다.
      switchHold.atReveal(() => {
        if (!window || window.isDestroyed()) return;
        // 리프레셔가 현재 모니터 배율 보정을 소유한다 — 창이 아직 없으면 적용할 곳도 없다.
        overlayRefresher?.applyOverlay(snapshot.titleBarOverlay);
        if (chromeBand !== snapshot.chrome?.band) {
          chromeBand = snapshot.chrome?.band;
          refreshNativeChrome();
        }
      });
    },
  });
  const synchronizeThemeAt = async (origin: string): Promise<void> => {
    themeOrigin = origin;
    await themeSynchronizer.start(origin);
  };
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
  /**
   * 셸 자신의 갱신 명령은 반대다 — 창이 어느 콘솔을 보고 있든 그 화면의 사용자가 이 기계의 앱을
   * 갱신하려는 것이므로, 원격 콘솔에서도 듣는다. 수행 대상은 언제나 이 앱 하나뿐이다.
   */
  let shellUpdater: ShellUpdater | null = null;
  const publishShellUpdate = createShellUpdatePublisher({
    fetch: consoleFetch,
    origin: () => servingConsoleOrigin,
    log: (message) => logger.error(message),
  });
  const shellUpdateCommands = createShellUpdateCommandSynchronizer({
    fetch: consoleFetch,
    perform: (command) => {
      if (command === "check") void shellUpdater?.check();
      else if (command === "download") void shellUpdater?.download();
      else shellUpdater?.restart();
    },
  });
  const subscribeShellUpdates = async (origin: string): Promise<void> => {
    servingConsoleOrigin = origin;
    await shellUpdateCommands.start(origin);
    // 새로 붙은 화면은 이 셸이 이미 아는 상태를 모른다 — 지금 값을 한 번 게시해 두 자리를 맞춘다.
    if (shellUpdater) publishShellUpdate(shellUpdater.snapshot());
  };
  /**
   * 창 조작 명령 — 콘솔이 이 창의 네이티브 전체화면을 켜고 끈다. 셸 갱신 명령처럼 창이 보고 있는
   * 콘솔에서 듣는다. 전체화면 진입·이탈은 OS가 이미 사용자에게 내준 조작이라 별도 확인을 두지 않는다.
   */
  let consoleFullscreen: FullscreenController | null = null;
  const windowCommands = createDesktopWindowCommandSynchronizer({
    fetch: consoleFetch,
    perform: (command) => {
      if (command === "request-accessibility-permission") {
        // Computer Use는 로컬 기계만 조작한다 — 원격 콘솔을 보고 있는 창은 이 기계의 권한 안내를 띄우지 않는다.
        if (policy?.currentConsoleOrigin() === localConsoleOrigin && localConsoleOrigin !== null) requestAccessibilityPermission((message) => logger.info(message));
        else logger.info("computer capture accessibility request ignored: remote console");
        return;
      }
      if (command === "open-screen-recording-settings") {
        // 화면 기록 설정만 연다. OS 권한 안내를 띄우지 않고, 원격 콘솔을 보고 있는 창은 이 기계의 설정을 열지 않는다.
        if (policy?.currentConsoleOrigin() === localConsoleOrigin && localConsoleOrigin !== null) openScreenRecordingSettings((message) => logger.info(message));
        else logger.info("computer capture screen recording settings ignored: remote console");
        return;
      }
      // 막 적재된 화면이 첫 목록을 칠했다 — 붙잡아 둔 옛 화면을 걷는다. 이 스트림이 듣는 콘솔의 알림만 온다.
      if (command === "console-ready") {
        if (windowCommandOrigin !== null) switchHold.ready(windowCommandOrigin);
        return;
      }
      consoleFullscreen?.perform(command);
    },
  });
  /** 창 명령을 듣고 있는 콘솔. */
  let windowCommandOrigin: string | null = null;
  /**
   * 넘겨주기 안에서는 같은 콘솔이면 다시 열지 않는다. 이 채널은 명령을 걸어 두지 않으므로, 적재 전에 열어 둔
   * 스트림을 적재 뒤에 다시 열면 그 틈에 도착한 ready를 잃는다. 기동·갱신 뒤 재연결(`restart`)은 예전처럼 다시 연다 —
   * 그사이 콘솔이 이 채널을 새로 갖게 됐을 수 있다.
   */
  const listenWindowCommands = async (origin: string, restart = false): Promise<void> => {
    if (!restart && windowCommandOrigin === origin) return;
    windowCommandOrigin = origin;
    await windowCommands.start(origin);
  };
  /**
   * Operation 브라우저의 네이티브 뷰. 창이 어느 콘솔에 있든 그 콘솔의 탭을 이 창에 그린다 — 원격 콘솔로 건너가면
   * 그 콘솔의 에이전트가 이 기계의 Chromium 을 움직인다. 브라우저는 Desktop 앱의 기능이고 원격에서도 같은 경험이어야
   * 한다는 제품 결정이다. 뷰는 세션 파티션에 격리되어 이 앱의 쿠키·로그인과 섞이지 않는다.
   */
  const browserViews = createDesktopBrowserViews({
    shell: () => window,
    // 항해는 에이전트도 수행한다 — 페이지 적재가 Console의 입력 포커스를 가져가면 안 된다.
    // 사람이 뷰를 직접 클릭해 포커스를 옮기는 경로는 그대로 둔다.
    // 영속 프로필이면 그 프로필의 디스크 세션에, 아니면 Operation 의 메모리 파티션에 뷰를 연다.
    createView: (partition, profile) => new WebContentsView({
      webPreferences: {
        ...(profile === null ? { partition } : { session: browserProfileSession(profile) }),
        focusOnNavigation: false, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false,
      },
    }),
    zoomFactor: () => window?.consoleContents.getZoomFactor() ?? 1,
    scaleFactor: () => { try { return window ? screen.getDisplayMatching(window.getBounds()).scaleFactor : 1; } catch { return 1; } },
    product: () => `Chrome/${process.versions.chrome}`,
    // 셸의 표기를 뺀 일반 Chrome UA — 페이지가 Electron 앱 안에 있다고 알 이유가 없다.
    userAgent: () => (window?.consoleContents.getUserAgent() ?? "").replace(/ (?:Electron|FleetConsole\w*|fleet-console\w*)\/\S+/gu, ""),
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
    // 크기 한도는 browser-views 가 디코드 전에 검사했다. 여기서는 필요한 사본만 만든다 — 전체면 자르지 않고, 같은 크기면
    // 늘이지 않고, 표면 밖이 없으면 캔버스를 만들지 않는다. 표면 밖 여백은 불투명 흰색이다.
    composeCapture: (png, { crop, place, size, format, quality }) => {
      let image = nativeImage.createFromBuffer(png);
      if (image.isEmpty()) throw new Error("browser_capture_invalid_image");
      const surface = image.getSize();
      if (crop.x !== 0 || crop.y !== 0 || crop.width !== surface.width || crop.height !== surface.height) image = image.crop(crop);
      if (crop.width !== place.width || crop.height !== place.height) image = image.resize({ width: place.width, height: place.height, quality: "best" });
      if (place.x !== 0 || place.y !== 0 || place.width !== size.width || place.height !== size.height) {
        const part = image.getSize();
        const bitmap = image.toBitmap();
        const row = place.width * 4;
        if (part.width !== place.width || part.height !== place.height || bitmap.length !== row * place.height) throw new Error("browser_capture_invalid_image");
        const canvas = Buffer.alloc(size.width * size.height * 4, 0xff);
        for (let y = 0; y < place.height; y += 1) bitmap.copy(canvas, ((place.y + y) * size.width + place.x) * 4, y * row, (y + 1) * row);
        image = nativeImage.createFromBitmap(canvas, { width: size.width, height: size.height });
      }
      return (format === "jpeg" ? image.toJPEG(quality) : image.toPNG()).toString("base64");
    },
  });
  const synchronizeBrowserViews = async (origin: string): Promise<void> => {
    try { await browserViews.start(origin); } catch (error) { logger.error(`browser views failed: ${describeError(error)}`); }
  };
  /**
   * 창이 서 있는 콘솔을 셸의 배관이 따라간다 — 테마, 감독하는 설치본의 갱신, 셸 갱신 명령, 창 명령, 브라우저 뷰.
   * `stillCurrent`가 거짓이 되면 멈춘다: 원격이 오류 문서에 착지해 집으로 되돌아가는 동안, 늦게 끝난 원격 쪽 동기화가
   * 집으로 옮겨 간 배관을 다시 원격으로 끌고 가지 않게 한다.
   */
  const followConsole = async (origin: string, stillCurrent: () => boolean = () => true, restart = false): Promise<void> => {
    if (!stillCurrent()) return;
    await synchronizeThemeAt(origin);
    if (!stillCurrent()) return;
    await subscribeSupervisedConsoleUpdates(origin);
    await subscribeShellUpdates(origin);
    await listenWindowCommands(origin, restart);
    if (!stillCurrent()) return;
    await synchronizeBrowserViews(origin);
  };
  /**
   * 적재 전에 창을 새 콘솔 쪽으로 미리 돌린다(console-handoff). 판이 옛 화면을 쥔 뒤라 이 변화는 그 아래에서 일어난다.
   * - 옛 콘솔의 네이티브 브라우저 뷰를 먼저 내린다 — 남겨 두면 새 콘솔이 그리는 동안 그 위에 옛 페이지가 떠 있다.
   * - 새 콘솔의 테마로 창 바탕을 칠하고(타이틀바·신호등은 판이 걷히는 순간), 그 콘솔의 ready를 듣기 시작한다.
   */
  const prepareConsoleSwitch = async (origin: string): Promise<void> => {
    browserViews.stop();
    await Promise.all([synchronizeThemeAt(origin), listenWindowCommands(origin)]);
  };
  /** 몇 번째 넘겨주기인가. 뒤에 온 넘겨주기가 있으면 앞선 것의 동기화와 되돌리기는 손을 떼야 한다. */
  let handoffGeneration = 0;
  let refreshNativeUpdateActions: (() => void) | null = null;
  const zoomState = createZoomState(path.join(app.getPath("userData"), "desktop-state.json"));
  const controls = createConsoleControls({ zoomState, refreshNativeActions: () => refreshNativeUpdateActions?.() });
  /**
   * 다른 콘솔로 건너가는 화면은 Console 안에 있다. Desktop이 남기는 것은 인증서 한 겹뿐이라,
   * 이 다리는 메뉴에도 트레이에도 나타나지 않는다.
   */
  const notifier = createDesktopNotifier<BaseWindow>({
    notification: Notification,
    dialog: {
      showSheet: (parent, options) => dialog.showMessageBox(parent, options),
      showDetached: (options) => dialog.showMessageBox(options),
    },
    parent: () => {
      const shown = window;
      if (!shown || shown.isDestroyed() || !shown.base.isVisible() || shown.base.isMinimized()) return null;
      return shown.base;
    },
    detachedDialogBlocks: process.platform === "darwin",
    log: (message) => logger.error(message),
  });
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
      // 본문을 들고 있으면 다음 게시가 방금 연 연결을 재사용하지 못한다.
      await releaseFetchBody(response);
      // 세션이 아직 없는 원격 콘솔은 401로 답한다 — 재기동 직후라면 화면이 곧 되살리므로 오류가 아니다.
      if (response.status === 401) return "unauthorized";
      // 경로가 어긋나면 404가 조용히 돌아온다 — 돌아갈 줄이 사라진 이유를 로그에서 찾을 수 있어야 한다.
      if (!response.ok) {
        logger.error(`shell home publish rejected status=${response.status}`);
        return "rejected";
      }
      // 버전과 능력은 그 위에 덧쓴다. 이 키를 모르는 옛 Console은 400으로 거절한다 — 능력을 빼고 버전만 다시
      // 보내고, 그것도 거절되면 이미 게시된 집이 그대로 선다.
      const capable = await put({ homeOrigin: home, version: app.getVersion(), capabilities: DESKTOP_SHELL_CAPABILITIES });
      await releaseFetchBody(capable);
      const versioned = capable.status === 400 ? await put({ homeOrigin: home, version: app.getVersion() }) : capable;
      if (versioned !== capable) await releaseFetchBody(versioned);
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
    // 지문 대조 뒤에 브리지가 부른다. 소켓 둘이면 조인 뒤 확인과 문서 적재가 새 연결을 덜 연다.
    preconnect: (origin) => { consoleSession.preconnect({ url: origin, numSockets: 2 }); },
    localOrigin: () => localConsoleOrigin,
    deviceName: os.hostname().replace(/\.local$/iu, ""),
    loadConsole: (url) => {
      const generation = ++handoffGeneration;
      const current = (): boolean => generation === handoffGeneration;
      return handOffWindowToConsole({
        publishShellHome: async (origin) => { await publishShellHome(origin); },
        holdScreen: () => switchHold.freeze(),
        prepare: (origin) => prepareConsoleSwitch(origin),
        loadUrl: async (target) => { await window?.loadURL(target); },
        // 적재가 실패했으면 창은 아직 옛 콘솔에 서 있다(정책은 확정 전) — 미리 돌린 배관을 그리로 되돌린다.
        restore: async () => {
          const at = policy?.currentConsoleOrigin() ?? null;
          if (at === null || !current()) return;
          await followConsole(at, current);
        },
        loaded: (origin) => { if (current()) switchHold.loaded(origin); },
        synchronizeTheme: (origin) => followConsole(origin, current),
      }, url);
    },
    hold: switchHold,
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
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
      });
      // 덮개는 아래 콘솔 위에 합성된다 — 목록을 보는 동안에도 어느 콘솔에 서 있었는지가 남아야 한다.
      view.setBackgroundColor("#00000000");
      return view;
    },
    shell: () => window,
    confine: (contents) => confinePickerNavigation(contents, localConsoleOrigin ?? "", (url) => consoleTarget(url, localConsoleOrigin) !== null),
    attachBridge: (contents) => { bridge.attachPicker(contents); consoleSection.observeHomeOverlay(contents); },
    log: (message) => logger.error(message),
  });
  const consoleSection = createConsoleSectionController({
    home: () => localConsoleOrigin,
    fetch: (url, init) => fetch(url, init),
    open: (origin) => bridge.open(origin),
    add: (url) => picker.open(url).catch((error) => bridge.report(error)),
    confirmForget: async (label) => {
      if (!window || window.isDestroyed()) return false;
      const korean = entryLanguage === "ko";
      return (await dialog.showMessageBox(window.base, {
        type: "warning",
        title: korean ? "저장한 콘솔 빼기" : "Forget saved console",
        message: korean ? `“${label}” 콘솔을 목록에서 뺄까요?` : `Forget “${label}” from this computer?`,
        detail: korean ? "다시 연결하려면 새 액세스 링크가 필요합니다." : "A new access link will be needed to connect again.",
        buttons: korean ? ["취소", "빼기"] : ["Cancel", "Forget"], defaultId: 0, cancelId: 0, noLink: true,
      })).response === 1;
    },
    report: (error) => bridge.report(error),
  });
  /** Console을 보여 주고 있는 창만 인사한다 — 진입 화면에서 떠날 때는 이미 그 화면이 떠 있다. */
  let consoleShown = false;
  const createEntryView = (): WebContentsView => {
    const view = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false },
    });
    // 시작·종료 판은 수동적이다. Console 위에 합성할 뿐 항해·팝업·브리지 통로는 없다.
    view.setBackgroundColor("#00000000");
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return view;
  };
  const farewell = createQuitFarewell({
    shell: () => consoleShown && window && !window.isDestroyed() ? window : null,
    createView: createEntryView,
    entryPagePath: desktopResources.entryPagePath,
    snapshot: (phase) => farewellSnapshot(entryLanguage, !isPackaged, phase, entryPalette),
    pushEntry: pushEntrySnapshot,
    log: (message) => logger.error(message),
  });
  const lifecycle = createDesktopLifecycle(app, async () => {
    const launch = createLaunchController({
      createWindow: async () => {
        const createdWindow = createSecureShellWindow(BaseWindow, WebContentsView, {
          iconPath: desktopResources.iconPath,
          platform: process.platform,
          ...(entryPalette ? { backgroundColor: entryPalette.canvas } : {}),
          ...(rememberedTheme ? { titleBarOverlay: rememberedTheme.titleBarOverlay } : {}),
          ...(chromeBand !== undefined ? { chromeBand } : {}),
        });
        window = createdWindow;
        consoleFullscreen = createFullscreenController(createdWindow.base);
        overlayRefresher = process.platform === "win32"
          ? createTitleBarOverlayRefresher(createdWindow.base, {
            screen,
            initialOverlay: rememberedTheme?.titleBarOverlay ?? INITIAL_WINDOWS_TITLE_BAR_OVERLAY,
            getZoomFactor: () => createdWindow.consoleContents.getZoomFactor(),
          })
          : null;
        createdWindow.base.once("closed", () => {
          themeSynchronizer.stop();
          updateSynchronizer.stop();
          browserViews.stop();
          consoleFullscreen?.stop();
          consoleFullscreen = null;
          windowCommands.stop();
          windowCommandOrigin = null;
          switchHold.release("window_closed");
          overlayRefresher?.stop();
          overlayRefresher = null;
          picker.close();
          consoleSection.close();
          // BaseWindow closed does not destroy child WebContentsView renderers — close explicitly.
          dismissStartupEntry();
          try {
            if (!createdWindow.consoleContents.isDestroyed()) createdWindow.consoleContents.close();
          } catch { /* already torn down */ }
          window = null;
          policy = null;
          consoleShown = false;
        });
        controls.attachWindow(createdWindow);
        lifecycle.attachWindow(createdWindow);
        policy = applyWindowPolicy(createdWindow.consoleContents, async (external) => shell.openExternal(external), {
          onPermissionDenied: (permission, phase) => logger.info(`window permission ${phase} denied permission=${permission}`),
          confirmRemoteLocalFonts: async (origin) => !createdWindow.isDestroyed()
            && (await dialog.showMessageBox(createdWindow.base, localFontsConsentDialog(origin))).response === 1,
        });
        installComputerCapture(createdWindow.consoleContents, () => policy?.currentConsoleOrigin() === localConsoleOrigin ? localConsoleOrigin : null, (message) => logger.info(message));
        consoleSection.attach(createdWindow.consoleContents);
        bridge.attach(createdWindow.consoleContents);
        // 붙잡아 둔 옛 화면 아래의 렌더러가 죽었다 — 판만 남기지 않는다.
        createdWindow.consoleContents.on("render-process-gone", () => switchHold.release("render_gone"));
        createdWindow.consoleContents.on("did-navigate", (_event, url) => {
          // 창이 어디로 옮겨 가든 덮개는 따라가지 않는다 — 새 콘솔 위에 남은 옛 목록은 거짓말이다.
          picker.close();
          // 셸이 넘긴 항해는 도착 전에 게시했다. 그 밖의 도착 — 새로고침, 재기동한 콘솔로 화면이 스스로
          // 되돌아온 경우 — 는 여기서 게시한다. 재기동한 콘솔은 앞선 게시를 잊었기 때문이다.
          let origin: string;
          try { origin = new URL(url).origin; } catch { return; }
          if (!isConsoleOrigin(origin) || policy?.currentConsoleOrigin() !== origin) return;
          controls.onConsoleCommitted(createdWindow.consoleContents);
          void republishShellHomeOnArrival({
            publish: publishShellHome,
            stillAt: (at) => !createdWindow.isDestroyed() && policy?.currentConsoleOrigin() === at,
          }, origin).then((outcome) => {
            if (outcome !== "accepted") logger.error(`shell home republish after arrival ended outcome=${outcome} origin=${origin}`);
          });
        });
        createdWindow.consoleContents.on("before-input-event", (event) => { if (startupEntry) event.preventDefault(); });
        createdWindow.consoleContents.on("zoom-changed", (_event, zoomDirection) => {
          controls.zoomChanged(createdWindow.consoleContents, zoomDirection);
          refreshNativeChrome();
          browserViews.refresh();
        });
        // 뷰의 자리는 패널이 CSS px 로 알린다 — 줌·창 크기가 바뀌면 같은 자리를 DIP 로 다시 놓는다.
        createdWindow.base.on("resize", () => {
          const bounds = createdWindow.stack.layoutConsole();
          startupEntry?.setBounds(bounds);
          browserViews.refresh();
        });
        // 시작 시 복원되는 줌은 이벤트를 내지 않는다 — 로드가 끝난 자리에서 네이티브 크롬의 기하를 재확인한다.
        createdWindow.consoleContents.on("did-finish-load", () => refreshNativeChrome());
        // 스냅·최대화 전환(Win+Shift+화살표 등)은 moved 없이 모니터를 건널 수 있다 — 게이트가
        // no-op이므로 상태 전환마다 배율 정합을 재확인해도 비용이 없다.
        createdWindow.base.on("maximize", () => refreshNativeChrome());
        createdWindow.base.on("unmaximize", () => refreshNativeChrome());
        createdWindow.base.on("restore", () => refreshNativeChrome());
        refreshNativeUpdateActions?.();
        startupEntry = createEntryView();
        startupEntry.setBounds(createdWindow.stack.layoutConsole());
        // attached/nonzero 뷰에서 먼저 적재해야 프레임이 멎지 않는다. 최상단 판이 아래 Console로의 입력을 막는다.
        createdWindow.stack.presentVeil(startupEntry);
        await startupEntry.webContents.loadFile(desktopResources.entryPagePath);
        startupEntry.webContents.focus();
        return createdWindow;
      },
      dev: !isPackaged,
      lang: entryLanguage,
      desktopVersion: app.getVersion(),
      consoleVersion: () => isPackaged ? readInstalledVersion(runtimePaths.latest) : null,
      palette: () => entryPalette,
      // 진입 화면은 제 배율(대개 1)로 그려지고 Console 배율은 넘겨받은 뒤에야 적용된다(controls.onConsoleLoaded) —
      // 그래서 넘겨받을 배율은 지금 창이 아니라 저장된 줌에서 읽는다.
      zoom: () => window && !window.isDestroyed()
        ? { page: startupEntry?.webContents.getZoomFactor() ?? window.consoleContents.getZoomFactor(), console: zoomFactorForLevel(zoomState.load()) }
        : undefined,
      entryContents: () => startupEntry?.webContents,
      brandTarget: async () => {
        if (!window || window.isDestroyed()) return undefined;
        startupEntry?.webContents.focus();
        const target = await measureBrandTarget(window.consoleContents);
        logger.info(`entry brand target ${target ? JSON.stringify(target) : "unavailable; using fallback"}`);
        return target;
      },
      dismissEntry: dismissStartupEntry,
      handoffOrigin: (origin) => {
        localConsoleOrigin = origin;
        policy?.activateConsoleOrigin(origin);
        controls.handoffStarted();
        placeTrafficLights();
        void publishShellHome(origin);
      },
      synchronizeTheme: (origin) => followConsole(origin, () => true, true),
      // 프로그램이 건 줌은 zoom-changed를 내지 않는다 — 저장 줌을 건 뒤 신호등을 실제 줌에 다시 맞춘다(Windows 오버레이는 손대지 않는다).
      onConsoleLoaded: () => { consoleShown = true; controls.onConsoleLoaded(); placeTrafficLights(); },
      onFirstRunFailure: async () => showFirstRunFailure(),
      onWindowReady: (push) => { pushRuntimeProgress = push; },
      pushEntry: pushEntrySnapshot,
      startOrAdopt: (report) => supervisor.startOrAdopt(report),
    });
    return launch.start() as Promise<DesktopShellWindow>;
  }, () => farewell.run(async () => { bridge.dispose(); await supervisor.stop(); await terminateSessionHost(environment.dataDir); }), async () => {
    await prepareDesktopSessionUpdate({ lockFile: path.join(environment.consoleDir, "console.lock"), ownerId: environment.ownerId, helperRoot: app.getPath("userData"), env: environment.serviceEnv });
    bridge.dispose();
  });
  const consoleRelaunch = isPackaged
    ? createConsoleRelaunchController({
      currentVersion: () => readInstalledVersion(runtimePaths.latest) ?? "",
      prepareToQuit: () => lifecycle.prepareToQuit(),
      prepareToUpdate: () => lifecycle.prepareToUpdate(),
      relaunch: () => app.relaunch(),
      quit: () => lifecycle.quitForUpdate(),
    })
    : createNoopConsoleRelaunchController();
  // 종료 준비가 실패하면 앱은 그대로 남고 다음 요청을 다시 받는다. 그 실패는 진단 기록에만 남긴다.
  applyDelegatedUpdate = (version) => {
    void consoleRelaunch.applyRequested(version).catch(async (error: unknown) => {
      logger.error(`console relaunch failed: ${describeError(error)}`);
      if (error instanceof Error && error.message === "session_business_pending") await dialog.showMessageBox({ type: "warning", title: "Fleet Console update postponed", message: describeConsoleUpdateFailure("session-business-pending"), buttons: ["OK"] });
    });
  };
  // 갱신기는 패키징된 앱에서만 산다. 개발 실행에서는 갱신 소스를 직접 지정했을 때만 깨어난다 —
  // 이 동선을 눈으로 확인하려면 어딘가에서 한 번은 실제로 밟아 봐야 하기 때문이다.
  const developmentConfigPath = isPackaged ? undefined : writeDevelopmentUpdateConfig(app.getPath("userData"), process.env.FLEET_DESKTOP_DEV_UPDATE_FEED, logger);
  shellUpdater = isPackaged || developmentConfigPath
    ? createShellUpdater({
      updater: autoUpdater,
      currentVersion: () => app.getVersion(),
      publish: (snapshot) => { publishShellUpdate(snapshot); refreshNativeUpdateActions?.(); },
      log: (message) => logger.error(message),
      ...(developmentConfigPath ? { developmentConfigPath } : {}),
    })
    : null;
  const updates: NativeUpdateActions = shellUpdater === null
    ? createDisabledNativeUpdateActions()
    : {
      enabled: () => true,
      stage: () => shellUpdater?.snapshot().stage ?? "idle",
      version: () => shellUpdater?.snapshot().version ?? null,
      check: () => { void shellUpdater?.check(); },
      download: () => { void shellUpdater?.download(); },
      restart: () => shellUpdater?.restart(),
    };
  const actions = {
    show: () => { void lifecycle.show(); },
    quit: () => { void lifecycle.quit(); },
    diagnostics: () => { void shell.openPath(path.join(app.getPath("userData"), "logs")); },
    // 줌이 바뀌면 떠 있는 호스트 목록을 걷는다 — 판을 매단 칩이 어디로 갔는지는 아래 콘솔만 안다.
    zoomIn: () => { picker.close(); controls.zoomIn(); refreshNativeChrome(); },
    zoomOut: () => { picker.close(); controls.zoomOut(); refreshNativeChrome(); },
    actualSize: () => { picker.close(); controls.actualSize(); refreshNativeChrome(); },
    reloadConsole: () => controls.reloadConsole(),
    consoleReady: () => controls.consoleReady(),
    updates,
  };
  trayHolder.current = createDesktopTray(process.platform, Tray, desktopResources, actions);
  refreshNativeUpdateActions = () => {
    installApplicationMenu(Menu, actions, process.platform, window && !window.isDestroyed() ? window.base : undefined);
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
  // 고정 주기 확인. 주기를 사용자가 바꾸는 설정은 두지 않는다 — 확인은 값싸고, 조절 가능한 주기는
  // "왜 아직 안 왔나"라는 질문만 하나 더 만든다. 지금 확인하고 싶은 사람에게는 화면의 직접 확인이 있다.
  if (shellUpdater) {
    void shellUpdater.check();
    setInterval(() => { void shellUpdater?.check(); }, 60 * 60 * 1_000);
  }
}

async function resolvePackagedRuntime(runtimePaths: ReturnType<typeof resolveRuntimePaths>, releases: ReturnType<typeof createReleaseChecker>, progress: RuntimeProgress, logger: DesktopLogger): Promise<SidecarRuntime> {
  try {
    await progress("checking");
    const manifest = JSON.parse(fs.readFileSync(path.resolve(sourceDirectory, "build", "node-runtime.json"), "utf8")) as NodeRuntimeManifest;
    const engine = readConsoleNodeEngine(runtimePaths.latest);
    if (!satisfiesNodeEngine(manifest.version, engine)) throw new Error("managed_node_engine_unsupported");
    // isValid 판정 전에 reconcile을 먼저 돌려, 교체 중 종료로 node가 사라지고 node.rollback만 남은 경우
    // 다운로드(오프라인 시 실패)로 가기 전에 유효한 이전 런타임을 복원한다(console latest.rollback과 대칭).
    await reconcileNodeRuntime(runtimePaths.node);
    if (!(await isManagedNodeRuntimeValid(runtimePaths.node, manifest, process.platform))) {
      await progress("node", undefined, 0);
      await bootstrapNodeRuntime({ destination: runtimePaths.node, manifest, platform: process.platform, architecture: process.arch });
    }
    await reconcileConsoleInstallations(runtimePaths, createInstallerFileSystem());
    const installedVersion = readInstalledVersion(runtimePaths.latest);
    if (installedVersion) await repairConsoleNativeExecutables(runtimePaths.latest, process.platform, process.arch, createInstallerFileSystem());
    const result = await releases.check(installedVersion ?? "");
    const version = result.release?.version ?? installedVersion;
    if (!version) throw new Error("console_runtime_unavailable");
    if (result.release) {
      await progress("installing", `Fleet Console ${version}`, 0);
      try {
        await installConsole({ paths: runtimePaths, nodeRoot: runtimePaths.node, packageName: PACKAGE_NAME, release: result.release, allowExperimentVersion: readConsoleReleaseTagOverride(process.env).kind === "tag", nodeRuntimeVersion: manifest.version, platform: process.platform });
      } catch (error) {
        if (!installedVersion) throw error;
        await progress("offline", "install-failed");
      }
    } else if (!installedVersion) {
      throw new Error("console_runtime_unavailable");
    } else if (result.unavailable) {
      await progress("offline", "unreachable");
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

/**
 * 개발 실행의 갱신 설정. 체크아웃 안이 아니라 이 실행의 userData에 쓴다 — 저장소에 남는 파일이
 * 되어서는 안 되고, 데이터 디렉터리를 갈아 끼우면 이 설정도 함께 갈린다.
 */
function writeDevelopmentUpdateConfig(userDataDirectory: string, feedUrl: string | undefined, logger: DesktopLogger): string | undefined {
  if (!feedUrl) return undefined;
  try {
    const configPath = path.join(userDataDirectory, "dev-app-update.yml");
    fs.writeFileSync(configPath, `provider: generic\nurl: ${feedUrl}\n`, { mode: 0o600 });
    return configPath;
  } catch (error) {
    logger.error(`development update config unavailable: ${describeError(error)}`);
    return undefined;
  }
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
