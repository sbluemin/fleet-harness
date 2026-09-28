import type { BaseWindow, BaseWindowConstructorOptions, Session, WebContents, WebContentsView } from "electron";

import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import { createDesktopShellWindow, createDesktopViewStack, type DesktopShellWindow } from "./shell-window.js";

export interface SecureWindowOptions {
  readonly iconPath: string;
  readonly platform?: NodeJS.Platform;
  /** 지난 실행에 기억해 둔 사용자 테마. 없으면 Instrument 기본값으로 뜬다. */
  readonly backgroundColor?: string;
  readonly titleBarOverlay?: { readonly color: string; readonly symbolColor: string; readonly height: number };
}

export interface WindowPolicy {
  /** 이 셸이 띄운 콘솔 — 로컬 뷰가 머무는 origin. */
  activateConsoleOrigin(origin: string): void;
  localConsoleOrigin(): string | null;
  /** 데이터 뷰가 싣고 있는 콘솔. 확정 전까지는 옛 값 그대로다. */
  dataConsoleOrigin(): string | null;
  stageDataOrigin(origin: string): void;
  commitDataOrigin(): void;
  cancelPendingDataOrigin(): void;
  /** 로컬로 돌아오면 데이터 뷰는 어떤 콘솔로도 항해하지 못한다. */
  clearDataOrigin(): void;
  /**
   * 인증서 지문 대조를 통과한 원격 origin만 항해 대상 집합에 들어온다. 링크 문자열을
   * 손에 넣은 것만으로는 열리지 않는다 — 붙여넣기는 이 함수를 호출할 자격이 아니다.
   */
  admitRemoteConsoleOrigin(origin: string): void;
  withdrawRemoteConsoleOrigin(origin: string): void;
  /** 로컬 뷰의 항해 울타리와 창 열기. 바깥 http 링크는 OS 브라우저로 넘긴다. */
  confineLocalView(contents: Pick<WebContents, "on" | "setWindowOpenHandler">): void;
  /** 데이터 뷰의 항해 울타리. 남의 콘솔이 서빙한 화면이므로 어떤 창도, 어떤 OS 핸들러도 열지 않는다. */
  confineDataView(contents: Pick<WebContents, "on" | "setWindowOpenHandler">): void;
}

const DESKTOP_WINDOW_TITLE = "Fleet Console";

/** Instrument의 `--canvas-sea-far`. 사용자 테마를 모를 때의 창 바탕이다. */
export const CANVAS_FAR_BACKGROUND_COLOR = "#010204";
/**
 * Windows 캡션 버튼 스트립도 Command Band와의 합의다 — 높이 35px + 밴드 하단 divider 1px가
 * 클라이언트 `--chrome-band-height: 36px`를 채우고, 폭 138 DIP(46×3)는 우측 클러스터가 비워
 * 두는 자리다. 폭은 Chromium이 정하므로 여기서 지정하지도, 되읽지도 못한다.
 *
 * 그 폭을 클라이언트에 알려 주던 길은 WCO 기하 env(titlebar-area-*)였는데, Console이
 * BaseWindow의 내장 webContents가 아니라 자식 WebContentsView로 그려지면서 끊겼다
 * (createSecureShellWindow). env의 fallback은 값이 없다는 말을 0으로 바꿔 놓으므로 예약이
 * 조용히 사라진다 — 그래서 layout.css가 이 138 DIP를 계약으로 함께 들고 큰 쪽을 쓴다.
 * 여기를 고치면 그쪽도 같이 고친다.
 */
export const INITIAL_WINDOWS_TITLE_BAR_OVERLAY = { color: "#03080e", symbolColor: "#989fa6", height: 35 } as const;

/**
 * macOS 신호등의 자리는 Command Band와의 합의다 — 클라이언트 `--chrome-band-height: 36px`,
 * 좌측 클러스터가 비워 두는 76px, 그리고 여기의 x·y가 한 좌표계를 나눠 갖는다.
 *
 * 그런데 신호등은 네이티브라 페이지 줌을 타지 않는다. 밴드만 줌에 비례해 자라므로 y를
 * 생성 시점 상수로 굳히면 확대할수록 신호등이 밴드 천장에 붙고(실측 131%에서 7px 위),
 * 축소하면 아래로 처진다. 가로는 클라이언트가 예약 폭을 DIP로 되돌려 맡고, 세로는 줌이
 * 바뀔 때마다 여기서 다시 계산해 신호등을 밴드 한가운데로 옮긴다.
 *
 * x는 줌과 무관한 고정값이다 — 신호등 자체가 줌을 타지 않으니 창 모서리와의 거리도
 * 변할 이유가 없고, 클라이언트의 예약 폭이 이 x에서 출발한 76px을 그대로 비워 둔다.
 */
const TRAFFIC_LIGHT_INSET_X = 16;
const TRAFFIC_LIGHT_HEIGHT = 14;
const COMMAND_BAND_HEIGHT = 36;

export function trafficLightPosition(zoomFactor: number): { x: number; y: number } {
  const factor = zoomFactor > 0 ? zoomFactor : 1;
  return { x: TRAFFIC_LIGHT_INSET_X, y: Math.max(0, Math.round((COMMAND_BAND_HEIGHT * factor - TRAFFIC_LIGHT_HEIGHT) / 2)) };
}

const SECURE_RENDERER_PREFERENCES = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } as const;

function secureShellWindowOptions(options: SecureWindowOptions): BaseWindowConstructorOptions {
  return {
    show: false,
    title: DESKTOP_WINDOW_TITLE,
    icon: options.iconPath,
    backgroundColor: options.backgroundColor ?? CANVAS_FAR_BACKGROUND_COLOR,
    minWidth: 900,
    minHeight: 560,
    // Windows 오버레이 35px + Command Band 하단 divider 1px가 클라이언트 --chrome-band-height: 36px를 채운다. macOS 신호등 계약과 함께 변경 시 양쪽을 동기화한다.
    ...(options.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLightPosition(1) } : {}),
    ...(options.platform === "win32" ? { titleBarStyle: "hidden", titleBarOverlay: options.titleBarOverlay ?? INITIAL_WINDOWS_TITLE_BAR_OVERLAY } : {}),
  };
}

/**
 * BaseWindow + 명시적 Console WebContentsView.
 * BrowserWindow 의 webContents 는 다른 View 로 adopt 할 수 없으므로 Console 은 처음부터 View 로 만든다.
 */
export function createSecureShellWindow(
  BaseWindowCtor: typeof BaseWindow,
  WebContentsViewCtor: typeof WebContentsView,
  options: SecureWindowOptions,
): DesktopShellWindow {
  const base = new BaseWindowCtor(secureShellWindowOptions(options));
  const consoleView = new WebContentsViewCtor({
    webPreferences: { ...SECURE_RENDERER_PREFERENCES, backgroundThrottling: false },
  });
  consoleView.setBackgroundColor(options.backgroundColor ?? CANVAS_FAR_BACKGROUND_COLOR);
  const stack = createDesktopViewStack(base, consoleView);
  return createDesktopShellWindow(base, consoleView, stack);
}

export function createWindowPolicy(openExternal: (url: string) => Promise<void>): WindowPolicy {
  let localOrigin: string | undefined;
  let dataOrigin: string | undefined;
  let pendingDataOrigin: string | undefined;
  const admittedRemoteOrigins = new Set<string>();
  const validateOrigin = (origin: string): void => {
    // 루프백은 언제나, 원격은 지문을 대조해 들인 뒤에만.
    if (!isLoopbackConsoleOrigin(origin) && !admittedRemoteOrigins.has(origin)) throw new Error("window_policy_console_origin_not_admitted");
  };
  return {
    activateConsoleOrigin(origin: string): void {
      if (!isLoopbackConsoleOrigin(origin)) throw new Error("window_policy_console_origin_not_admitted");
      localOrigin = origin;
    },
    localConsoleOrigin: () => localOrigin ?? null,
    dataConsoleOrigin: () => dataOrigin ?? null,
    stageDataOrigin(origin: string): void { validateOrigin(origin); pendingDataOrigin = origin; },
    commitDataOrigin(): void {
      if (!pendingDataOrigin) throw new Error("window_policy_pending_console_origin_required");
      dataOrigin = pendingDataOrigin;
      pendingDataOrigin = undefined;
    },
    cancelPendingDataOrigin(): void { pendingDataOrigin = undefined; },
    clearDataOrigin(): void { dataOrigin = undefined; pendingDataOrigin = undefined; },
    admitRemoteConsoleOrigin(origin: string): void {
      if (!isRemoteConsoleOrigin(origin)) throw new Error("window_policy_remote_origin_invalid");
      admittedRemoteOrigins.add(origin);
    },
    withdrawRemoteConsoleOrigin(origin: string): void {
      admittedRemoteOrigins.delete(origin);
      // 철회된 origin이 아직 활성이면 데이터 뷰는 그 origin 안에서 계속 움직일 수 있다. 활성에서도 걷어낸다.
      if (dataOrigin === origin) dataOrigin = undefined;
      if (pendingDataOrigin === origin) pendingDataOrigin = undefined;
    },
    confineLocalView(contents): void {
      contents.on("will-navigate", (event, url) => {
        if (!localOrigin || !isAllowedConsoleUrl(url, localOrigin)) event.preventDefault();
      });
      contents.setWindowOpenHandler(({ url }) => {
        if (localOrigin && isHttpUrl(url)) void openExternal(url);
        return { action: "deny" };
      });
    },
    confineDataView(contents): void {
      contents.on("will-navigate", (event, url) => {
        const allowed = (dataOrigin !== undefined && isAllowedConsoleUrl(url, dataOrigin))
          || (pendingDataOrigin !== undefined && isAllowedConsoleUrl(url, pendingDataOrigin));
        if (!allowed) event.preventDefault();
      });
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
    },
  };
}

/** 지금 권한을 가진 콘솔 뷰 하나. 전환 중에는 누구도 갖지 않는다. */
export interface SurfaceAuthority {
  readonly contents: WebContents;
  readonly origin: string;
  readonly surface: "local" | "data";
}

/**
 * 세션 단위 권한 판정은 여기 하나뿐이다. 로컬 뷰·데이터 뷰·덮개가 모두 defaultSession을 나누므로, 뷰마다
 * 핸들러를 갈아 끼우면 마지막에 설치한 뷰의 판정이 다른 뷰에도 적용된다. 판정은 요청한 contents·frame과
 * 지금 권한을 가진 뷰 하나(`authority`)로 한다 — 뒤에 세워 둔 뷰는 아무것도 물려받지 않는다.
 *
 * - 클립보드 쓰기: 권한을 가진 뷰의 main frame, 그 콘솔의 정확한 origin에서만. 원격 콘솔의 기존 기능이라 원격 뷰도 받는다.
 * - 화면 캡처: 로컬 뷰가 권한을 가진 동안, 그 main frame의 로컬 `/console/`에서만.
 */
export function installPermissionDispatcher(
  session: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  authority: () => SurfaceAuthority | null,
): void {
  const permitsClipboardWrite = (requester: WebContents | null, requestingUrl: string, isMainFrame: boolean | undefined): boolean => {
    const holder = authority();
    return holder !== null && isMainFrame !== false && (requester === null || requester === holder.contents) && hasExactOrigin(requestingUrl, holder.origin);
  };
  const permitsDisplayCapture = (requester: WebContents | null, requestingUrl: string, isMainFrame: boolean | undefined): boolean => {
    const holder = authority();
    return holder !== null && holder.surface === "local" && requester === holder.contents && isMainFrame !== false
      && isLoopbackConsoleOrigin(holder.origin) && isAllowedConsoleUrl(requestingUrl, holder.origin);
  };
  // Chromium은 플랫폼별로 check에서 곧장 끝내기도, 거부된 check 뒤 request로 이어 가기도 한다.
  // 둘을 같은 판정에 묶어 Windows에서도 쓰기를 허용하되 권한 범위는 넓히지 않는다.
  session.setPermissionCheckHandler((requestingContents, permission, requestingOrigin, details) => {
    const url = details.requestingUrl ?? requestingOrigin;
    if (permission === "clipboard-sanitized-write") return permitsClipboardWrite(requestingContents, url, details.isMainFrame);
    // Electron의 타입 목록에는 없지만 Chromium은 화면 캡처 check를 이 이름으로 묻는다.
    return (permission as string) === "display-capture" && permitsDisplayCapture(requestingContents, url, details.isMainFrame);
  });
  session.setPermissionRequestHandler((requester, permission, callback, details) => {
    if (permission === "clipboard-sanitized-write") { callback(permitsClipboardWrite(requester, details.requestingUrl, details.isMainFrame)); return; }
    callback(permission === "media" && "mediaTypes" in details && details.mediaTypes?.length === 0
      && permitsDisplayCapture(requester, details.requestingUrl, details.isMainFrame));
  });
}

/**
 * 집의 목록을 그리는 덮개 렌더러의 항해 울타리.
 *
 * 이 뷰는 콘솔 뷰들과 같은 defaultSession에 살지만 세션에는 손대지 않는다 — 권한 판정은
 * `installPermissionDispatcher` 하나가 맡고, 덮개는 권한을 가진 뷰가 아니므로 무엇도 받지 않는다.
 *
 * 콘솔을 갈아타는 항해는 여기서 막지 않는다 — remote bridge가 같은 이벤트에서 가로채
 * 신뢰할 수 있는 선택인지 확인한 뒤 전환으로 넘기는 것이 그 동선의 전부이기 때문이다.
 */
export function confinePickerNavigation(
  contents: Pick<WebContents, "on" | "setWindowOpenHandler">,
  origin: string,
  isConsoleSwitch: (url: string) => boolean,
): void {
  contents.on("will-navigate", (event, url) => {
    if (isAllowedConsoleUrl(url, origin) || isConsoleSwitch(url)) return;
    event.preventDefault();
  });
  // 덮개에서 새 창은 열리지 않는다. 바깥으로 나가는 링크는 메인 창의 몫이다.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function isAllowedConsoleUrl(url: string, origin: string): boolean { try { const parsed = new URL(url); return parsed.origin === origin && parsed.pathname.startsWith("/console/"); } catch { return false; } }
function isHttpUrl(url: string): boolean { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } }
function hasExactOrigin(url: string, origin: string): boolean { try { return new URL(url).origin === origin; } catch { return false; } }
