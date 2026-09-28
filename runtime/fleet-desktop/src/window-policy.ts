import type { BaseWindow, BaseWindowConstructorOptions, WebContents, WebContentsView } from "electron";

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
  activateConsoleOrigin(origin: string): void;
  currentConsoleOrigin(): string | null;
  stageConsoleOrigin(origin: string): void;
  commitConsoleOrigin(): void;
  cancelPendingConsoleOrigin(): void;
  /**
   * 인증서 지문 대조를 통과한 원격 origin만 항해 대상 집합에 들어온다. 링크 문자열을
   * 손에 넣은 것만으로는 열리지 않는다 — 붙여넣기는 이 함수를 호출할 자격이 아니다.
   */
  admitRemoteConsoleOrigin(origin: string): void;
  withdrawRemoteConsoleOrigin(origin: string): void;
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

export function applyWindowPolicy(contents: WebContents, openExternal: (url: string) => Promise<void>): WindowPolicy;
export function applyWindowPolicy(contents: WebContents, origin: string, openExternal: (url: string) => Promise<void>): WindowPolicy;
export function applyWindowPolicy(contents: WebContents, originOrOpenExternal: string | ((url: string) => Promise<void>), legacyOpenExternal?: (url: string) => Promise<void>): WindowPolicy {
  let consoleOrigin: string | undefined = typeof originOrOpenExternal === "string" ? originOrOpenExternal : undefined;
  let pendingConsoleOrigin: string | undefined;
  const openExternal = typeof originOrOpenExternal === "function" ? originOrOpenExternal : legacyOpenExternal;
  if (!openExternal) throw new Error("window_policy_open_external_required");
  contents.on("will-navigate", (event, url) => {
    if (!consoleOrigin || (!isAllowedConsoleUrl(url, consoleOrigin) && (!pendingConsoleOrigin || !isAllowedConsoleUrl(url, pendingConsoleOrigin)))) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (consoleOrigin && isHttpUrl(url)) void openExternal(url);
    return { action: "deny" };
  });
  const permitsClipboardWrite = (permission: string, requestingUrl: string): boolean =>
    Boolean(consoleOrigin) && permission === "clipboard-sanitized-write" && hasExactOrigin(requestingUrl, consoleOrigin ?? "");
  const permitsDisplayCapture = (permission: string, requestingUrl: string): boolean =>
    permission === "display-capture" && Boolean(consoleOrigin && isLoopbackConsoleOrigin(consoleOrigin))
    && isAllowedConsoleUrl(requestingUrl, consoleOrigin ?? "");
  // Chromium은 플랫폼별로 check에서 곧장 끝내기도, 거부된 check 뒤 request로 이어 가기도 한다.
  // 둘을 같은 exact-origin 판정에 묶어 Windows에서도 쓰기를 허용하되 권한 범위는 넓히지 않는다.
  contents.session.setPermissionCheckHandler((requestingContents, permission, requestingOrigin, details) =>
    (requestingContents === null || requestingContents === contents)
    && (permitsClipboardWrite(permission, details.requestingUrl ?? requestingOrigin)
      || (requestingContents === contents && permitsDisplayCapture(permission, details.requestingUrl ?? requestingOrigin))));
  contents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(permitsClipboardWrite(permission, details.requestingUrl)
    || (wc === contents && details.isMainFrame && permission === "media" && "mediaTypes" in details && details.mediaTypes?.length === 0
      && permitsDisplayCapture("display-capture", details.requestingUrl))));
  const admittedRemoteOrigins = new Set<string>();
  const validateOrigin = (origin: string): void => {
    // 루프백은 언제나, 원격은 지문을 대조해 들인 뒤에만.
    if (!isLoopbackConsoleOrigin(origin) && !admittedRemoteOrigins.has(origin)) throw new Error("window_policy_console_origin_not_admitted");
  };
  return {
    activateConsoleOrigin(origin: string): void { validateOrigin(origin); consoleOrigin = origin; pendingConsoleOrigin = undefined; },
    currentConsoleOrigin(): string | null { return consoleOrigin ?? null; },
    stageConsoleOrigin(origin: string): void { validateOrigin(origin); pendingConsoleOrigin = origin; },
    commitConsoleOrigin(): void {
      if (!pendingConsoleOrigin) throw new Error("window_policy_pending_console_origin_required");
      consoleOrigin = pendingConsoleOrigin;
      pendingConsoleOrigin = undefined;
    },
    cancelPendingConsoleOrigin(): void { pendingConsoleOrigin = undefined; },
    admitRemoteConsoleOrigin(origin: string): void {
      if (!isRemoteConsoleOrigin(origin)) throw new Error("window_policy_remote_origin_invalid");
      admittedRemoteOrigins.add(origin);
    },
    withdrawRemoteConsoleOrigin(origin: string): void {
      admittedRemoteOrigins.delete(origin);
      // 철회된 origin이 아직 활성이면 창은 어디로도 항해할 수 없는 상태로 남는다. 그대로
      // 두면 다음 will-navigate가 통과하므로 활성 origin에서도 함께 걷어낸다.
      if (consoleOrigin === origin) consoleOrigin = undefined;
      if (pendingConsoleOrigin === origin) pendingConsoleOrigin = undefined;
    },
  };
}

/**
 * 집의 목록을 그리는 덮개 렌더러의 항해 울타리.
 *
 * `applyWindowPolicy`를 그대로 쓸 수는 없다. 그쪽은 세션 단위인 permission check/request handler를
 * 갈아 끼우는데, 이 뷰는 메인 창과 같은 defaultSession에 산다 — 덮개를 한 번 얹는 것만으로
 * 메인 창(원격 origin)의 클립보드 권한 판정이 집 origin 기준으로 바뀌고, 덮개를 걷어도
 * 그대로 남는다. 그래서 여기서는 세션에 손대지 않고 이 contents의 항해만 가둔다.
 *
 * 콘솔을 갈아타는 항해는 여기서 막지 않는다 — remote bridge가 같은 이벤트에서 가로채
 * 메인 창으로 보내는 것이 그 동선의 전부이기 때문이다.
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
