import type http from "node:http";

import type { DurableJsonStore } from "@dotobokuri/fleet-infra";

import type { ApiCatalogEntry } from "./api-catalog.js";
import type { ConsoleSettingsData } from "./console-settings.js";

interface PluginSettingsRouteDeps {
  readonly consoleSettingsStore: DurableJsonStore<ConsoleSettingsData>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface PluginSettingsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

const PLUGIN_SETTINGS_PREFIX = "/api/v1/settings/plugins/";
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_PLUGIN_SETTINGS_BYTES = 32 * 1024;

export const PLUGIN_SETTINGS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/api/v1/settings/plugins/:pluginId",
    summary: "Get the settings for a specific plugin.",
    category: "Settings",
    gate: "loopback",
  },
  {
    method: "PUT",
    path: "/api/v1/settings/plugins/:pluginId",
    summary: "Save the settings for a specific plugin.",
    category: "Settings",
    gate: "origin-write",
  },
];

export function createPluginSettingsRouter(deps: PluginSettingsRouteDeps): (context: PluginSettingsRouteContext) => Promise<boolean> {
  return async function handlePluginSettingsRoute(context: PluginSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (!pathname.startsWith(PLUGIN_SETTINGS_PREFIX)) return false;
    const rest = pathname.slice(PLUGIN_SETTINGS_PREFIX.length);
    if (rest.includes("/")) return false;
    let pluginId: string;
    try {
      pluginId = decodeURIComponent(rest);
    } catch {
      deps.writeJson(res, 400, { error: "invalid_plugin_id" });
      return true;
    }
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      deps.writeJson(res, 400, { error: "invalid_plugin_id" });
      return true;
    }
    if (req.method === "GET") {
      const data = deps.consoleSettingsStore.load();
      const value = data.plugins?.[pluginId] ?? null;
      deps.writeJson(res, 200, { value });
      return true;
    }
    if (req.method === "PUT") {
      if (!deps.isAuthorized(req)) {
        deps.writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      if (!isJsonRequest(req)) {
        deps.writeJson(res, 415, { error: "unsupported_media_type" });
        return true;
      }
      const body = await deps.readJsonBody<unknown>(req);
      if (!isRecord(body)) {
        deps.writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_PLUGIN_SETTINGS_BYTES) {
        deps.writeJson(res, 413, { error: "payload_too_large" });
        return true;
      }
      const updated = deps.consoleSettingsStore.update((current) => ({
        ...current,
        version: 1,
        plugins: { ...current.plugins, [pluginId]: body as Record<string, unknown> },
      }));
      deps.writeJson(res, 200, { value: updated.plugins?.[pluginId] ?? null });
      return true;
    }
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
