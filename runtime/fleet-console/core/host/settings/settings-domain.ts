import type http from "node:http";
import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/core-infra";

import type { ApiCatalogEntry } from "../api-catalog.js";
import type { GlobalSettingsMutationResult, GlobalSettingsState } from "../console-contract-types.js";
import { createConsoleDataPaths, type ConsoleDataPaths } from "../paths.js";

export type ConsoleThemeId = "instrument" | "maritime" | "carbon" | "whites";
export type ConsoleUiFontId = "manrope" | "jetbrains-mono" | "source-code-pro";
export type UiFontSettings =
  | { readonly source: "builtin"; readonly id: ConsoleUiFontId; readonly size: number }
  | { readonly source: "system"; readonly familyName: string; readonly size: number };

export interface ConsoleGeneralSettings {
  readonly consolePortMode?: "dynamic" | "static";
  readonly consoleStaticPort?: number;
  readonly language?: "auto" | "en" | "ko";
  readonly seenFeatureTours?: readonly string[];
  readonly theme?: ConsoleThemeId;
  readonly uiFont?: UiFontSettings;
}

export interface ConsoleSettingsData {
  readonly version: 1;
  readonly general?: ConsoleGeneralSettings;
  readonly plugins?: Record<string, Record<string, unknown>>;
}

export interface CreateConsoleSettingsStoreDeps {
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<ConsoleSettingsData>) => DurableJsonStore<ConsoleSettingsData>;
  readonly now?: () => number;
}

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const UI_FONT_SIZE_RANGE = { min: 12, max: 18, step: 1 } as const;
export const DEFAULT_UI_FONT_SETTINGS: UiFontSettings = { source: "builtin", id: "manrope", size: 14 };

const SETTINGS_VERSION = 1;
const SETTINGS_LOCK_DIR_NAME = "settings.lock";
const SETTINGS_LOCK_OWNER_FILE_NAME = "owner.json";
const SETTINGS_TEMP_PREFIX = ".settings.";
const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;
const MAX_SEEN_FEATURE_TOURS = 64;
const MAX_FEATURE_TOUR_KEY_LENGTH = 64;

export function createConsoleSettingsStore(deps: CreateConsoleSettingsStoreDeps = {}): DurableJsonStore<ConsoleSettingsData> {
  const paths = deps.paths ?? createConsoleDataPaths();
  const createStore = deps.createStore ?? createDurableJsonStore;
  return createStore({
    filePath: paths.settingsFile,
    lockDir: path.join(paths.dir, SETTINGS_LOCK_DIR_NAME),
    lockOwnerFileName: SETTINGS_LOCK_OWNER_FILE_NAME,
    now: deps.now,
    sanitize: sanitizeConsoleSettingsData,
    sensitivity: "sensitive",
    tempCleanupPrefix: SETTINGS_TEMP_PREFIX,
  });
}

export function sanitizeConsoleSettingsData(value: unknown): ConsoleSettingsData {
  if (!isRecord(value)) return emptyConsoleSettingsData();
  if (value.version !== SETTINGS_VERSION) return emptyConsoleSettingsData();
  const general = readConsoleGeneralSettings(value.general);
  const plugins = readConsolePluginSettings(value.plugins);
  return {
    version: SETTINGS_VERSION,
    general: general ?? {},
    plugins: plugins ?? {},
  };
}

export function emptyConsoleSettingsData(): ConsoleSettingsData {
  return { version: 1, general: {}, plugins: {} };
}

export function sanitizeUiFontSettings(value: unknown): UiFontSettings | undefined {
  if (isConsoleUiFontId(value)) return { source: "builtin", id: value, size: DEFAULT_UI_FONT_SETTINGS.size };
  if (!isRecord(value) || !isValidUiFontSize(value.size)) return undefined;
  if (value.source === "builtin" && isConsoleUiFontId(value.id)) {
    return { source: "builtin", id: value.id, size: value.size };
  }
  if (value.source === "system" && typeof value.familyName === "string") {
    const familyName = sanitizeSystemFontFamily(value.familyName);
    return familyName ? { source: "system", familyName, size: value.size } : undefined;
  }
  return undefined;
}

export function sanitizeSeenFeatureTours(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length > MAX_FEATURE_TOUR_KEY_LENGTH) continue;
    seen.add(item);
    if (seen.size === MAX_SEEN_FEATURE_TOURS) break;
  }
  return [...seen];
}

export function isUiFontSettings(value: unknown): value is UiFontSettings {
  if (!isRecord(value) || !isValidUiFontSize(value.size)) return false;
  if (value.source === "builtin") return isConsoleUiFontId(value.id);
  return value.source === "system" && typeof value.familyName === "string" && value.familyName.length > 0 && value.familyName === sanitizeSystemFontFamily(value.familyName);
}

function readConsoleGeneralSettings(value: unknown): ConsoleGeneralSettings | null {
  if (!isRecord(value)) return null;
  const consolePortMode = value.consolePortMode === "dynamic" || value.consolePortMode === "static"
    ? value.consolePortMode
    : undefined;
  const consoleStaticPort = isValidConsoleStaticPort(value.consoleStaticPort)
    ? value.consoleStaticPort
    : undefined;
  const language = value.language === "auto" || value.language === "en" || value.language === "ko"
    ? value.language
    : undefined;
  const seenFeatureTours = sanitizeSeenFeatureTours(value.seenFeatureTours);
  // 퇴역 라이트 테마(daywatch/drydock) 저장값은 whites로 무손실 폴백한다 — 라이트 사용자가
  // 업그레이드 직후 다크 기본값으로 떨어지는 극성 반전을 막는다.
  const theme = value.theme === "instrument" || value.theme === "maritime" || value.theme === "carbon"
    || value.theme === "whites"
    ? value.theme
    : value.theme === "daywatch" || value.theme === "drydock"
      ? "whites"
      : undefined;
  const uiFont = sanitizeUiFontSettings(value.uiFont);
  return {
    ...(consolePortMode !== undefined ? { consolePortMode } : {}),
    ...(consoleStaticPort !== undefined ? { consoleStaticPort } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(seenFeatureTours !== undefined ? { seenFeatureTours } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(uiFont !== undefined ? { uiFont } : {}),
  };
}

function readConsolePluginSettings(value: unknown): Record<string, Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PLUGIN_ID_PATTERN.test(key)) continue;
    if (!isRecord(entry)) continue;
    result[key] = entry;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

function isConsoleUiFontId(value: unknown): value is ConsoleUiFontId {
  return value === "manrope" || value === "jetbrains-mono" || value === "source-code-pro";
}

function isValidUiFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= UI_FONT_SIZE_RANGE.min && value <= UI_FONT_SIZE_RANGE.max;
}

function sanitizeSystemFontFamily(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 128);
}

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
  readonly seenFeatureTours?: unknown;
  readonly theme?: unknown;
  readonly uiFont?: unknown;
}

const GLOBAL_SETTINGS_MIN_STATIC_PORT = 1024;
const GLOBAL_SETTINGS_MAX_STATIC_PORT = 65535;

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
  if (!isGlobalSettingsJsonRequest(req)) {
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
  if (body.consoleStaticPort !== undefined && body.consoleStaticPort !== null && !isValidGlobalStaticPortInput(body.consoleStaticPort)) {
    deps.writeJson(res, 400, { error: "invalid_console_static_port" });
    return;
  }
  if (body.language !== undefined && body.language !== "auto" && body.language !== "en" && body.language !== "ko") {
    deps.writeJson(res, 400, { error: "invalid_language" });
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
      ...(isValidGlobalStaticPortInput(body.consoleStaticPort) ? { consoleStaticPort: body.consoleStaticPort } : {}),
      ...(body.language === "auto" || body.language === "en" || body.language === "ko" ? { language: body.language } : {}),
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
    seenFeatureTours: general.seenFeatureTours ?? [],
    theme: general.theme ?? "instrument",
    uiFont: general.uiFont ?? DEFAULT_UI_FONT_SETTINGS,
  };
}

function isGlobalSettingsJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function isValidGlobalStaticPortInput(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= GLOBAL_SETTINGS_MIN_STATIC_PORT && value <= GLOBAL_SETTINGS_MAX_STATIC_PORT;
}

function isUiFontSettingsOrUndefined(value: unknown): boolean {
  return value === undefined || isUiFontSettings(value);
}

function isSeenFeatureToursInput(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => typeof item === "string" && item.length <= 64);
}

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
      if (!isPluginSettingsJsonRequest(req)) {
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


function isPluginSettingsJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
