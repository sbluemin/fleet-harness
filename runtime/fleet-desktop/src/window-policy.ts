import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";

export interface SecureWindowOptions {
  readonly iconPath: string;
  readonly platform?: NodeJS.Platform;
}

export interface WindowPolicy {
  activateConsoleOrigin(origin: string): void;
}

export const DESKTOP_WINDOW_TITLE = "Fleet Console";

const CANVAS_FAR_BACKGROUND_COLOR = "#010204";
const INITIAL_WINDOWS_TITLE_BAR_OVERLAY = { color: "#090f15", symbolColor: "#989fa6", height: 44 } as const;

export function createSecureWindow(BrowserWindowCtor: typeof BrowserWindow, options: SecureWindowOptions): BrowserWindow {
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false,
    title: DESKTOP_WINDOW_TITLE,
    icon: options.iconPath,
    backgroundColor: CANVAS_FAR_BACKGROUND_COLOR,
    minWidth: 900,
    minHeight: 560,
    // 신호등 좌표와 오버레이 높이(44)는 클라이언트 CSS의 --chrome-band-height: 44px 및 macOS 88px 인셋과 합의된 값이므로 변경 시 양쪽을 동기화한다.
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
  const openExternal = typeof originOrOpenExternal === "function" ? originOrOpenExternal : legacyOpenExternal;
  if (!openExternal) throw new Error("window_policy_open_external_required");
  contents.on("will-navigate", (event, url) => { if (!consoleOrigin || !isAllowedConsoleUrl(url, consoleOrigin)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (consoleOrigin && isHttpsUrl(url)) void openExternal(url);
    return { action: "deny" };
  });
  contents.session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(Boolean(consoleOrigin) && permission === "clipboard-sanitized-write" && hasExactOrigin(details.requestingUrl, consoleOrigin ?? "")));
  return { activateConsoleOrigin(origin: string): void {
    if (!isLoopbackOrigin(origin)) throw new Error("window_policy_console_origin_not_loopback");
    consoleOrigin = origin;
  } };
}

export function isAllowedConsoleUrl(url: string, origin: string): boolean { try { const parsed = new URL(url); return parsed.origin === origin && parsed.pathname.startsWith("/console/"); } catch { return false; } }
function isHttpsUrl(url: string): boolean { try { return new URL(url).protocol === "https:"; } catch { return false; } }
function hasExactOrigin(url: string, origin: string): boolean { try { return new URL(url).origin === origin; } catch { return false; } }
function isLoopbackOrigin(origin: string): boolean { try { const parsed = new URL(origin); return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"); } catch { return false; } }
