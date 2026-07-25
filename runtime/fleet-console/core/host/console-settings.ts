import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/core-infra";

import { createConsoleDataPaths, type ConsoleDataPaths } from "./paths.js";

export type ConsoleThemeId = "instrument" | "maritime" | "carbon";
export type ConsoleUiFontId = "manrope" | "jetbrains-mono" | "source-code-pro";
export type UiFontSettings =
  | { readonly source: "builtin"; readonly id: ConsoleUiFontId; readonly size: number }
  | { readonly source: "system"; readonly familyName: string; readonly size: number };

export interface ConsoleGeneralSettings {
  readonly consolePortMode?: "dynamic" | "static";
  readonly consoleStaticPort?: number;
  readonly language?: "auto" | "en" | "ko";
  readonly reducePanelMotion?: boolean;
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
  const reducePanelMotion = typeof value.reducePanelMotion === "boolean"
    ? value.reducePanelMotion
    : undefined;
  const seenFeatureTours = sanitizeSeenFeatureTours(value.seenFeatureTours);
  const theme = value.theme === "instrument" || value.theme === "maritime" || value.theme === "carbon"
    ? value.theme
    : undefined;
  const uiFont = sanitizeUiFontSettings(value.uiFont);
  return {
    ...(consolePortMode !== undefined ? { consolePortMode } : {}),
    ...(consoleStaticPort !== undefined ? { consoleStaticPort } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(reducePanelMotion !== undefined ? { reducePanelMotion } : {}),
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
