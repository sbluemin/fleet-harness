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
