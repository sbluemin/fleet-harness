import type http from "node:http";

import type { DurableJsonStore } from "@dotobokuri/core-infra";

import type { ApiCatalogEntry } from "./api-catalog.js";
import { DEFAULT_UI_FONT_SETTINGS, isUiFontSettings, sanitizeSeenFeatureTours, type ConsoleSettingsData, type ConsoleThemeId } from "./console-settings.js";
import type { GlobalSettingsMutationResult, GlobalSettingsState } from "./global-settings-types.js";

interface GlobalSettingsRouteDeps {
  readonly consoleSettingsStore: DurableJsonStore<ConsoleSettingsData>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly onThemeChanged?: (theme: ConsoleThemeId) => void;
}

interface GlobalSettingsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface GlobalSettingsBody {
  readonly consolePortMode?: unknown;
  readonly consoleStaticPort?: unknown;
  readonly language?: unknown;
  readonly reducePanelMotion?: boolean;
  readonly seenFeatureTours?: unknown;
  readonly theme?: unknown;
  readonly uiFont?: unknown;
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
    gate: "origin-write",
  },
];

export function createGlobalSettingsRouter(deps: GlobalSettingsRouteDeps): (context: GlobalSettingsRouteContext) => Promise<boolean> {
  return async function handleGlobalSettingsRoute(context: GlobalSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/api/v1/settings/global") {
      if (req.method === "GET") {
        deps.writeJson(res, 200, buildGlobalSettingsState(deps.consoleSettingsStore));
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

export function buildGlobalSettingsState(store: DurableJsonStore<ConsoleSettingsData>): GlobalSettingsState {
  return toGlobalSettingsState(store.load());
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
  if (body.language !== undefined && body.language !== "auto" && body.language !== "en" && body.language !== "ko") {
    deps.writeJson(res, 400, { error: "invalid_language" });
    return;
  }
  if (body.reducePanelMotion !== undefined && typeof body.reducePanelMotion !== "boolean") {
    deps.writeJson(res, 400, { error: "invalid_reduce_panel_motion" });
    return;
  }
  if (body.seenFeatureTours !== undefined && !isSeenFeatureToursInput(body.seenFeatureTours)) {
    deps.writeJson(res, 400, { error: "invalid_seen_feature_tours" });
    return;
  }
  if (
    body.theme !== undefined
    && body.theme !== "instrument" && body.theme !== "maritime" && body.theme !== "carbon"
    && body.theme !== "whites"
  ) {
    deps.writeJson(res, 400, { error: "invalid_theme" });
    return;
  }
  if (!isUiFontSettingsOrUndefined(body.uiFont)) {
    deps.writeJson(res, 400, { error: "invalid_ui_font" });
    return;
  }
  const theme = body.theme === "instrument" || body.theme === "maritime" || body.theme === "carbon"
    || body.theme === "whites"
    ? body.theme
    : undefined;
  const updated = deps.consoleSettingsStore.update((current) => ({
    ...current,
    version: 1,
    general: {
      ...current.general,
      ...(body.consolePortMode === "dynamic" || body.consolePortMode === "static" ? { consolePortMode: body.consolePortMode } : {}),
      ...(isValidConsoleStaticPort(body.consoleStaticPort) ? { consoleStaticPort: body.consoleStaticPort } : {}),
      ...(body.language === "auto" || body.language === "en" || body.language === "ko" ? { language: body.language } : {}),
      ...(typeof body.reducePanelMotion === "boolean" ? { reducePanelMotion: body.reducePanelMotion } : {}),
      ...(body.seenFeatureTours !== undefined ? { seenFeatureTours: sanitizeSeenFeatureTours(body.seenFeatureTours) ?? [] } : {}),
      ...(theme !== undefined ? { theme } : {}),
      ...(isUiFontSettings(body.uiFont) ? { uiFont: body.uiFont } : {}),
    },
    plugins: current.plugins,
  }));
  if (theme !== undefined) deps.onThemeChanged?.(theme);
  const response: GlobalSettingsMutationResult = { state: toGlobalSettingsState(updated) };
  deps.writeJson(res, 200, response);
}

function toGlobalSettingsState(data: ConsoleSettingsData): GlobalSettingsState {
  const general = data.general ?? {};
  return {
    consolePortMode: general.consolePortMode ?? "dynamic",
    consoleStaticPort: general.consoleStaticPort ?? null,
    language: general.language ?? "auto",
    reducePanelMotion: general.reducePanelMotion ?? false,
    seenFeatureTours: general.seenFeatureTours ?? [],
    theme: general.theme ?? "instrument",
    uiFont: general.uiFont ?? DEFAULT_UI_FONT_SETTINGS,
  };
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

function isUiFontSettingsOrUndefined(value: unknown): boolean {
  return value === undefined || isUiFontSettings(value);
}

function isSeenFeatureToursInput(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => typeof item === "string" && item.length <= 64);
}
