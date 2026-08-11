import type http from "node:http";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import { buildSystemFontsResponse, type SystemFontsService } from "./system-fonts.js";

export interface SystemFontsRouteDeps {
  readonly systemFonts: SystemFontsService;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

export interface SystemFontsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

const SYSTEM_FONTS_PATH = "/api/v1/settings/fonts/system";

export const SYSTEM_FONTS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: SYSTEM_FONTS_PATH,
    summary: "List sanitized system font families for built-in settings.",
    category: "Settings",
    gate: "loopback",
    transport: "http",
  },
];

export function createSystemFontsRouter(deps: SystemFontsRouteDeps): (context: SystemFontsRouteContext) => Promise<boolean> {
  return async function handleSystemFontsRoute(context: SystemFontsRouteContext): Promise<boolean> {
    if (context.pathname !== SYSTEM_FONTS_PATH) return false;
    if (context.req.method !== "GET") {
      deps.writeJson(context.res, 405, { error: "Method not allowed" });
      return true;
    }
    try {
      deps.writeJson(context.res, 200, buildSystemFontsResponse(await deps.systemFonts.getFonts()));
    } catch {
      deps.writeJson(context.res, 503, { error: "system_fonts_unavailable" });
    }
    return true;
  };
}
