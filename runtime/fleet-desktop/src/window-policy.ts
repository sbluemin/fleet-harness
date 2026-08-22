import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";

import { isLoopbackConsoleOrigin, isRemoteConsoleOrigin } from "./console-links.js";

export interface SecureWindowOptions {
  readonly iconPath: string;
  readonly platform?: NodeJS.Platform;
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

const CANVAS_FAR_BACKGROUND_COLOR = "#010204";
export const INITIAL_WINDOWS_TITLE_BAR_OVERLAY = { color: "#03080e", symbolColor: "#989fa6", height: 43 } as const;

export function createSecureWindow(BrowserWindowCtor: typeof BrowserWindow, options: SecureWindowOptions): BrowserWindow {
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false,
    title: DESKTOP_WINDOW_TITLE,
    icon: options.iconPath,
    backgroundColor: CANVAS_FAR_BACKGROUND_COLOR,
    minWidth: 900,
    minHeight: 560,
    ...(options.platform !== "darwin" ? { autoHideMenuBar: false } : {}),
    // Windows 오버레이 43px + Command Band 하단 divider 1px가 클라이언트 --chrome-band-height: 44px를 채운다. macOS 88px 인셋과 함께 변경 시 양쪽을 동기화한다.
    ...(options.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } } : {}),
    ...(options.platform === "win32" ? { titleBarStyle: "hidden", titleBarOverlay: INITIAL_WINDOWS_TITLE_BAR_OVERLAY } : {}),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  };
  return new BrowserWindowCtor(windowOptions);
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
  // Chromium은 플랫폼별로 check에서 곧장 끝내기도, 거부된 check 뒤 request로 이어 가기도 한다.
  // 둘을 같은 exact-origin 판정에 묶어 Windows에서도 쓰기를 허용하되 권한 범위는 넓히지 않는다.
  contents.session.setPermissionCheckHandler((requestingContents, permission, requestingOrigin, details) =>
    (requestingContents === null || requestingContents === contents)
    && permitsClipboardWrite(permission, details.requestingUrl ?? requestingOrigin));
  contents.session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permitsClipboardWrite(permission, details.requestingUrl)));
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
