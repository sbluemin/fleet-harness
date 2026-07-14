import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";

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
}

export const DESKTOP_WINDOW_TITLE = "Fleet Console";

const CANVAS_FAR_BACKGROUND_COLOR = "#010204";
const INITIAL_WINDOWS_TITLE_BAR_OVERLAY = { color: "#03080e", symbolColor: "#989fa6", height: 43 } as const;

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
  contents.session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(Boolean(consoleOrigin) && permission === "clipboard-sanitized-write" && hasExactOrigin(details.requestingUrl, consoleOrigin ?? "")));
  const validateOrigin = (origin: string): void => { if (!isLoopbackOrigin(origin)) throw new Error("window_policy_console_origin_not_loopback"); };
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
  };
}

export function isAllowedConsoleUrl(url: string, origin: string): boolean { try { const parsed = new URL(url); return parsed.origin === origin && parsed.pathname.startsWith("/console/"); } catch { return false; } }
function isHttpUrl(url: string): boolean { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } }
function hasExactOrigin(url: string, origin: string): boolean { try { return new URL(url).origin === origin; } catch { return false; } }
function isLoopbackOrigin(origin: string): boolean { try { const parsed = new URL(origin); return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]"); } catch { return false; } }
