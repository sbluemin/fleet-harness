import type http from "node:http";

import {
  DESKTOP_THEME_EVENTS_PATH,
  DESKTOP_THEME_PATH,
  type ConsoleThemeId,
  type DesktopThemeSnapshot,
} from "@fleet-console/desktop-protocol";

import type { ApiCatalogEntry } from "./api-catalog.js";
import { desktopThemeSnapshot } from "./desktop-theme.js";

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
