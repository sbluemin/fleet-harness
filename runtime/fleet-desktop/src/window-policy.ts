import { MACOS_TRAFFIC_LIGHTS } from "@fleet-console/protocol/desktop/chrome";
import type { BaseWindow, BaseWindowConstructorOptions, WebContents, WebContentsView } from "electron";

import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";
import { createDesktopShellWindow, createDesktopViewStack, type DesktopShellWindow } from "./shell-window.js";

export interface SecureWindowOptions {
  readonly iconPath: string;
  readonly platform?: NodeJS.Platform;
  /** 지난 실행에 기억해 둔 사용자 테마. 없으면 다크 기본값으로 뜬다. */
  readonly backgroundColor?: string;
  readonly titleBarOverlay?: { readonly color: string; readonly symbolColor: string; readonly height: number };
  /** 지난 실행에 기억해 둔 맨 위 줄 높이(chrome.band). 없으면 대화 중심 화면의 맨 위 줄 52px 이다. */
  readonly chromeBand?: number;
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

export interface WindowPolicyOptions {
  /**
   * 거부한 권한 이름을 단계·이름마다 한 번 알린다. Electron 타입에 없는 권한(local-fonts 등)이
   * 실제로 어떤 문자열로 도착하는지 확인하는 길이다. 이름만 넘기고 요청 내용은 넘기지 않는다.
   */
  readonly onPermissionDenied?: (permission: string, phase: "check" | "request") => void;
  /**
   * 승인된 원격 Console이 이 기기의 서체 목록을 청할 때 사용자에게 묻는다(부모 창 모달). true일 때만 허용한다.
   * 없으면 원격 요청은 묻지 않고 거부한다.
   */
  readonly confirmRemoteLocalFonts?: (origin: string) => Promise<boolean>;
}

/**
 * Console 계약의 쿼리 리터럴 — remote-bridge의 desktop-surface와 같은 방식으로 여기서 선언한다(Console 내부를
 * import하지 않는다). Electron의 권한 check는 허용·거부 둘뿐이라 Chromium이 local-fonts 요청 단계(프롬프트 자리)로
 * 넘어오지 않는다. 그래서 원격 화면은 이 항해로 셸에게 묻기를 청하고, 셸은 항해를 막은 채 확인창을 띄운다.
 */
const LOCAL_FONTS_SURFACE_PARAM = "desktop-surface";
const LOCAL_FONTS_SURFACE = "local-fonts";

export function localFontsConsentDialog(origin: string): { type: "question"; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean } {
  return {
    type: "question",
    title: "Fleet Console",
    message: "Allow this console to read the fonts installed on this computer?",
    detail: `${origin}\n\nThe console page, including any plugins it runs, will be able to read the list of fonts installed on this computer until Fleet Desktop quits.`,
    buttons: ["Don't Allow", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

const DESKTOP_WINDOW_TITLE = "Fleet Console";

/** 다크 테마의 `--canvas-sea-far`. 사용자 테마를 모를 때의 창 바탕이다. */
export const CANVAS_FAR_BACKGROUND_COLOR = "#010204";
/**
 * Console 맨 위 줄의 높이 — Console 이 테마 스냅샷 `chrome.band`·`titleBarOverlay.height` 로 보내는 값
 * (Console desktop-contract.ts `CONVERSATION_TOP_ROW`)과 같다. Desktop 은 Console 내부를 가져오지 않으므로 값을 맞춰 둔다.
 */
export const CONVERSATION_TOP_ROW = 52;

/**
 * Windows 캡션 버튼 스트립의 첫 모습 — Console 이 테마 스냅샷(titleBarOverlay)을 보내기 전까지만 선다. 값은 Console 이
 * 다크 테마에 보내는 대화 중심 화면 오버레이(desktop-contract.ts `DESKTOP_CONVERSATION_OVERLAYS.dark`)와 같아, 스냅샷이
 * 와도 높이·색이 튀지 않는다. 폭 138 DIP(46×3)는 Console 맨 위 줄이 비워 두는 자리다. 폭은 Chromium이 정하므로 여기서 지정하지도, 되읽지도 못한다.
 *
 * 그 폭을 클라이언트에 알려 주던 길은 WCO 기하 env(titlebar-area-*)였는데, Console이
 * BaseWindow의 내장 webContents가 아니라 자식 WebContentsView로 그려지면서 끊겼다
 * (createSecureShellWindow). env의 fallback은 값이 없다는 말을 0으로 바꿔 놓으므로 예약이
 * 조용히 사라진다 — 그래서 conversation.css가 이 138 DIP를 계약으로 함께 들고 큰 쪽을 쓴다.
 * 여기를 고치면 그쪽도 같이 고친다.
 */
export const INITIAL_WINDOWS_TITLE_BAR_OVERLAY = { color: "#121212", symbolColor: "#a7a7a7", height: CONVERSATION_TOP_ROW } as const;

/**
 * macOS 신호등의 자리는 Console 맨 위 줄과의 합의다 — 대화 중심 화면의 맨 위 줄(`--conversation-top-row: 52px`,
 * Console 이 테마 스냅샷 `chrome.band` 로 알린다)과 여기의 x·y가 한 좌표계를 나눠 갖는다.
 *
 * 그런데 신호등은 네이티브라 페이지 줌을 타지 않는다. 그 줄만 줌에 비례해 자라므로 y를
 * 생성 시점 상수로 굳히면 확대할수록 신호등이 줄 천장에 붙고(실측 131%에서 7px 위),
 * 축소하면 아래로 처진다. 세로는 줌이 바뀔 때마다 여기서 다시 계산해 신호등을 줄 한가운데로 옮긴다.
 *
 * x는 줌과 무관한 고정값이다 — 신호등 자체가 줌을 타지 않으니 창 모서리와의 거리도
 * 변할 이유가 없다. OS 실측 범위는 x 16–76 DIP(지름 14, 간격 9)이며, 좁은 열은 오른쪽에도 같은 여백을 둔다.
 */

/**
 * 맨 위 줄의 높이(`band`)는 Console 이 테마 스냅샷의 `chrome.band` 로 알린다 — 지금 Console 은 늘 대화 중심 화면의
 * 맨 위 줄 52px 을 보내므로, 스냅샷이 오기 전에도 같은 값에서 출발해 신호등이 튀지 않게 한다. 신호등은 그 줄의 세로 가운데에 선다.
 */
export function trafficLightPosition(zoomFactor: number, band: number = CONVERSATION_TOP_ROW): { x: number; y: number } {
  const factor = zoomFactor > 0 ? zoomFactor : 1;
  return { x: MACOS_TRAFFIC_LIGHTS.left, y: Math.max(0, Math.round((band * factor - MACOS_TRAFFIC_LIGHTS.height) / 2)) };
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
    // 두 플랫폼 모두 첫 기하는 Console 테마 스냅샷이 오면 그 값(chrome.band·titleBarOverlay)으로 바뀐다.
    ...(options.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLightPosition(1, options.chromeBand) } : {}),
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

export function applyWindowPolicy(contents: WebContents, openExternal: (url: string) => Promise<void>, options?: WindowPolicyOptions): WindowPolicy;
export function applyWindowPolicy(contents: WebContents, origin: string, openExternal: (url: string) => Promise<void>): WindowPolicy;
export function applyWindowPolicy(contents: WebContents, originOrOpenExternal: string | ((url: string) => Promise<void>), legacyOpenExternalOrOptions?: ((url: string) => Promise<void>) | WindowPolicyOptions): WindowPolicy {
  let consoleOrigin: string | undefined = typeof originOrOpenExternal === "string" ? originOrOpenExternal : undefined;
  let pendingConsoleOrigin: string | undefined;
  const openExternal = typeof originOrOpenExternal === "function" ? originOrOpenExternal : typeof legacyOpenExternalOrOptions === "function" ? legacyOpenExternalOrOptions : undefined;
  const options: WindowPolicyOptions = typeof legacyOpenExternalOrOptions === "object" ? legacyOpenExternalOrOptions : {};
  if (!openExternal) throw new Error("window_policy_open_external_required");
  const admittedRemoteOrigins = new Set<string>();
  // 원격 origin별 서체 목록 허용·거부. 이 실행 동안 메모리에만 둔다 — 거부도 기억해야 원격 페이지가 클릭 없이
  // 항해를 되풀이해 확인창을 거듭 띄우지 못한다.
  const remoteLocalFontsDecisions = new Map<string, boolean>();
  let localFontsConsentOpen = false;
  const askRemoteLocalFonts = (url: string, isMainFrame: boolean | undefined): boolean => {
    const origin = consoleOrigin;
    // 다른 origin을 향한 같은 모양의 URL은 신호가 아니다 — 기존 항해 규칙(remote bridge 포함)에 맡긴다.
    if (!origin || !hasExactOrigin(url, origin) || !isLocalFontsSurface(url)) return false;
    // 활성 Console 자신의 main frame이 낸 요청만, 승인된 원격 origin에서만, 아직 답이 없을 때만, 한 번에 하나만 묻는다.
    if (isMainFrame !== false && admittedRemoteOrigins.has(origin)
      && !remoteLocalFontsDecisions.has(origin) && !localFontsConsentOpen && options.confirmRemoteLocalFonts) {
      localFontsConsentOpen = true;
      void options.confirmRemoteLocalFonts(origin)
        .then((allowed) => { if (admittedRemoteOrigins.has(origin)) remoteLocalFontsDecisions.set(origin, allowed); }, () => undefined)
        .finally(() => { localFontsConsentOpen = false; });
    }
    return true;
  };
  contents.on("will-navigate", (event, url, _isInPlace?: boolean, isMainFrame?: boolean) => {
    // 셸에게 묻는 신호는 어디로도 항해하지 않는다 — 무시하는 경우에도 화면이 다시 읽히지 않게 막는다.
    if (askRemoteLocalFonts(url, isMainFrame)) {
      event.preventDefault();
      return;
    }
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
  // 이 기기의 서체 목록(queryLocalFonts)은 핑거프린팅 표면이다. 이 기기의 Console 화면에만 내준다 —
  // 원격 Console 페이지(같은 origin에 실린 외부 플러그인 포함)가 이 기기의 목록을 읽어 가지 못하게.
  // 원격은 사용자가 확인창에서 허용한 origin만, 이 실행 동안만 허용한다.
  const permitsLocalFonts = (permission: string, requestingUrl: string): boolean =>
    permission === "local-fonts" && Boolean(consoleOrigin && (isLoopbackConsoleOrigin(consoleOrigin) || remoteLocalFontsDecisions.get(consoleOrigin) === true))
    && isAllowedConsoleUrl(requestingUrl, consoleOrigin ?? "");
  const reportedDenials = new Set<string>();
  const deny = (permission: string, phase: "check" | "request"): false => {
    const key = `${phase}\u0000${permission}`;
    if (!reportedDenials.has(key)) {
      reportedDenials.add(key);
      options.onPermissionDenied?.(permission, phase);
    }
    return false;
  };
  // Chromium은 플랫폼별로 check에서 곧장 끝내기도, 거부된 check 뒤 request로 이어 가기도 한다.
  // 둘을 같은 exact-origin 판정에 묶어 Windows에서도 쓰기를 허용하되 권한 범위는 넓히지 않는다.
  contents.session.setPermissionCheckHandler((requestingContents, permission, requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl ?? requestingOrigin;
    return ((requestingContents === null || requestingContents === contents)
      && (permitsClipboardWrite(permission, requestingUrl)
        || (requestingContents === contents && permitsDisplayCapture(permission, requestingUrl))
        || (requestingContents === contents && details.isMainFrame && permitsLocalFonts(permission, requestingUrl))))
      || deny(permission, "check");
  });
  contents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed = permitsClipboardWrite(permission, details.requestingUrl)
      || (wc === contents && details.isMainFrame && permission === "media" && "mediaTypes" in details && details.mediaTypes?.length === 0
        && permitsDisplayCapture("display-capture", details.requestingUrl))
      || (wc === contents && details.isMainFrame && permitsLocalFonts(permission, details.requestingUrl));
    callback(allowed || deny(permission, "request"));
  });
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
      remoteLocalFontsDecisions.delete(origin);
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
function isLocalFontsSurface(url: string): boolean { try { const parsed = new URL(url); return parsed.pathname.startsWith("/console/") && parsed.searchParams.get(LOCAL_FONTS_SURFACE_PARAM) === LOCAL_FONTS_SURFACE; } catch { return false; } }
function hasExactOrigin(url: string, origin: string): boolean { try { return new URL(url).origin === origin; } catch { return false; } }
