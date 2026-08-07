import type http from "node:http";

import type { ApiCatalogEntry } from "./api-catalog.js";
import type { ConsoleThemeId } from "./settings/settings-domain.js";

export const DESKTOP_FULLSCREEN_PATH = "/api/v1/desktop/fullscreen";
export const DESKTOP_FULLSCREEN_EVENT = "desktop:fullscreen";

export interface DesktopFullscreenSnapshot {
  readonly fullscreen: boolean;
}

export const desktopFullscreenSnapshot = (fullscreen: boolean): DesktopFullscreenSnapshot => ({ fullscreen });

export function isDesktopFullscreenSnapshot(value: unknown): value is DesktopFullscreenSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 1 && typeof entry.fullscreen === "boolean";
}

interface DesktopFullscreenRouteDeps {
  readonly getFullscreen: () => boolean;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly setFullscreen: (fullscreen: boolean) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
}

interface DesktopFullscreenRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export const DESKTOP_FULLSCREEN_API_CATALOG: readonly ApiCatalogEntry[] = [{
  method: "PUT",
  path: DESKTOP_FULLSCREEN_PATH,
  summary: "Update the ephemeral Desktop native fullscreen snapshot.",
  category: "Desktop",
  gate: "origin-strict",
}];

export function createDesktopFullscreenRouter(deps: DesktopFullscreenRouteDeps): (context: DesktopFullscreenRouteContext) => Promise<boolean> {
  return async ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_FULLSCREEN_PATH) return false;
    if (req.method !== "PUT") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await deps.readJsonBody<unknown>(req);
    if (!isDesktopFullscreenSnapshot(body)) {
      deps.writeJson(res, 400, { error: "invalid_desktop_fullscreen" });
      return true;
    }
    if (deps.getFullscreen() !== body.fullscreen) deps.setFullscreen(body.fullscreen);
    deps.writeNoContent(res);
    return true;
  };
}

export const DESKTOP_SHELL_PATH = "/api/v1/desktop/shell";

/**
 * 창을 들고 있는 셸이 자기에 대해 알려 주는 한 가지 사실: 이 앱이 처음 띄운 콘솔이 어디인가.
 *
 * 콘솔은 이것을 스스로 알 수 없다. 원격 콘솔이 서빙한 화면에서 "이 컴퓨터"로 돌아가려면
 * 그 화면은 자기가 아닌 다른 origin을 가리켜야 하는데, 그 주소를 아는 것은 셸뿐이다.
 * 브라우저 단독으로 열었을 때는 비어 있고, 그때는 돌아갈 곳도 없다.
 */
export interface DesktopShellSnapshot {
  readonly homeOrigin: string | null;
}

export const emptyDesktopShell = (): DesktopShellSnapshot => ({ homeOrigin: null });

export function isDesktopShellSnapshot(value: unknown): value is DesktopShellSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 1) return false;
  return entry.homeOrigin === null || (typeof entry.homeOrigin === "string" && isConsoleOriginShape(entry.homeOrigin));
}

/** 돌아갈 곳도 origin이어야 한다 — 경로가 섞이면 셸이 아무 데나 항해한다. */
function isConsoleOriginShape(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

interface DesktopShellRouteDeps {
  /** 요청자에 따라 답이 달라진다 — 이 값을 되돌려 받을 자격은 게시한 창에만 있다. */
  readonly getShell: (req: http.IncomingMessage) => DesktopShellSnapshot;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly setShell: (req: http.IncomingMessage, snapshot: DesktopShellSnapshot) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly writeNoContent: (res: http.ServerResponse) => void;
}

export const DESKTOP_SHELL_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: DESKTOP_SHELL_PATH,
    summary: "Read where the Desktop that published it can send this window home; every other viewer reads nothing.",
    category: "Desktop",
    gate: "loopback",
  },
  {
    method: "PUT",
    path: DESKTOP_SHELL_PATH,
    summary: "Publish the console the attached Desktop launched, so this window can go back to it.",
    category: "Desktop",
    gate: "origin-strict",
  },
];

export function createDesktopShellRouter(deps: DesktopShellRouteDeps): (context: DesktopFullscreenRouteContext) => Promise<boolean> {
  return async ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_SHELL_PATH) return false;
    if (req.method === "GET") {
      deps.writeJson(res, 200, deps.getShell(req));
      return true;
    }
    if (req.method !== "PUT") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = await deps.readJsonBody<unknown>(req);
    if (!isDesktopShellSnapshot(body)) {
      deps.writeJson(res, 400, { error: "invalid_desktop_shell" });
      return true;
    }
    deps.setShell(req, body);
    deps.writeNoContent(res);
    return true;
  };
}

export interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export interface DesktopThemeSnapshot {
  readonly theme: ConsoleThemeId;
  readonly titleBarOverlay: DesktopTitleBarOverlay;
}

export const DESKTOP_THEME_PATH = "/api/v1/desktop/theme";
export const DESKTOP_THEME_EVENTS_PATH = "/api/v1/desktop/theme/events";
export const DESKTOP_THEME_EVENT = "desktop:theme";

const DESKTOP_TITLE_BAR_OVERLAYS: Readonly<Record<ConsoleThemeId, DesktopThemeSnapshot["titleBarOverlay"]>> = {
  instrument: { color: "#03080e", symbolColor: "#989fa6", height: 43 },
  maritime: { color: "#041729", symbolColor: "#c8c4b7", height: 43 },
  carbon: { color: "#101215", symbolColor: "#bfc1c3", height: 43 },
  whites: { color: "#f1f0ec", symbolColor: "#424038", height: 43 },
};

export function desktopThemeSnapshot(theme: ConsoleThemeId): DesktopThemeSnapshot {
  return { theme, titleBarOverlay: { ...DESKTOP_TITLE_BAR_OVERLAYS[theme] } };
}

interface DesktopThemeRouteDeps {
  readonly getTheme: () => ConsoleThemeId;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly subscribe: (res: http.ServerResponse, snapshot: DesktopThemeSnapshot) => void;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface DesktopThemeRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

export const DESKTOP_THEME_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: DESKTOP_THEME_PATH,
    summary: "Get the Console-owned Desktop title bar theme.",
    category: "Desktop",
    gate: "origin-strict",
  },
  {
    method: "GET",
    path: DESKTOP_THEME_EVENTS_PATH,
    summary: "Stream server-confirmed Desktop title bar theme changes.",
    category: "Desktop",
    gate: "origin-strict",
  },
];

export function createDesktopThemeRouter(deps: DesktopThemeRouteDeps): (context: DesktopThemeRouteContext) => boolean {
  return ({ req, res, pathname }) => {
    if (pathname !== DESKTOP_THEME_PATH && pathname !== DESKTOP_THEME_EVENTS_PATH) return false;
    if (req.method !== "GET") {
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    if (!deps.isAuthorized(req)) {
      deps.writeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const snapshot = desktopThemeSnapshot(deps.getTheme());
    if (pathname === DESKTOP_THEME_PATH) {
      deps.writeJson(res, 200, snapshot);
      return true;
    }
    deps.subscribe(res, snapshot);
    return true;
  };
}
