import type http from "node:http";

import type { ApiCatalogEntry } from "./api-catalog.js";
import { DESKTOP_FULLSCREEN_PATH, isDesktopFullscreenSnapshot } from "./desktop-fullscreen.js";

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
