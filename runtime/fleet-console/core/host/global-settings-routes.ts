import type http from "node:http";

import type { GlobalOptionsData, GlobalOptionsService } from "@dotobokuri/fleet-infra";

import type { ApiCatalogEntry } from "./api-catalog.js";
import type { GlobalSettingsMutationResult, GlobalSettingsState } from "./global-settings-types.js";

interface GlobalSettingsRouteDeps {
  readonly globalOptionsService: GlobalOptionsService;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface GlobalSettingsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface GlobalSettingsBody {
  readonly consolePortMode?: unknown;
  readonly consoleStaticPort?: unknown;
}

const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;

export const GLOBAL_SETTINGS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/api/v1/settings/global",
    summary: "Get the global console settings status.",
    category: "Settings",
    gate: "loopback",
  },
  {
    method: "PUT",
    path: "/api/v1/settings/global",
    summary: "Save the global console settings.",
    category: "Settings",
    gate: "terminal-origin",
  },
];

export function createGlobalSettingsRouter(deps: GlobalSettingsRouteDeps): (context: GlobalSettingsRouteContext) => Promise<boolean> {
  return async function handleGlobalSettingsRoute(context: GlobalSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/api/v1/settings/global") {
      if (req.method === "GET") {
        deps.writeJson(res, 200, buildGlobalSettingsState(deps.globalOptionsService));
        return true;
      }
      if (req.method === "PUT") {
        await mutateGlobalSettings(req, res, deps);
        return true;
      }
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    return false;
  };
}

export function buildGlobalSettingsState(service: GlobalOptionsService): GlobalSettingsState {
  return toGlobalSettingsState(service.load());
}

async function mutateGlobalSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GlobalSettingsRouteDeps,
): Promise<void> {
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!isJsonRequest(req)) {
    deps.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  const body = await deps.readJsonBody<GlobalSettingsBody>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    deps.writeJson(res, 400, { error: "invalid_json" });
    return;
  }
  if (body.consolePortMode !== undefined && body.consolePortMode !== "dynamic" && body.consolePortMode !== "static") {
    deps.writeJson(res, 400, { error: "invalid_console_port_mode" });
    return;
  }
  if (body.consoleStaticPort !== undefined && body.consoleStaticPort !== null && !isValidConsoleStaticPort(body.consoleStaticPort)) {
    deps.writeJson(res, 400, { error: "invalid_console_static_port" });
    return;
  }
  const updated = deps.globalOptionsService.update((current) => ({
    ...current,
    ...(body.consolePortMode === "dynamic" || body.consolePortMode === "static" ? { consolePortMode: body.consolePortMode } : {}),
    ...(isValidConsoleStaticPort(body.consoleStaticPort) ? { consoleStaticPort: body.consoleStaticPort } : {}),
  }));
  const response: GlobalSettingsMutationResult = { state: toGlobalSettingsState(updated) };
  deps.writeJson(res, 200, response);
}

function toGlobalSettingsState(data: GlobalOptionsData): GlobalSettingsState {
  return {
    consolePortMode: data.consolePortMode ?? "dynamic",
    consoleStaticPort: data.consoleStaticPort ?? null,
  };
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}
