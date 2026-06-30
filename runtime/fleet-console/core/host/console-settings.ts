import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/fleet-infra";

import { createConsoleDataPaths, type ConsoleDataPaths } from "./paths.js";

export type ConsoleThemeId = "maritime" | "carbon";

export interface ConsoleGeneralSettings {
  readonly consolePortMode?: "dynamic" | "static";
  readonly consoleStaticPort?: number;
  readonly theme?: ConsoleThemeId;
}

export interface ConsoleSettingsData {
  readonly version: 1;
  readonly general?: ConsoleGeneralSettings;
}

export interface CreateConsoleSettingsStoreDeps {
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<ConsoleSettingsData>) => DurableJsonStore<ConsoleSettingsData>;
  readonly now?: () => number;
}

const SETTINGS_VERSION = 1;
const SETTINGS_LOCK_DIR_NAME = "settings.lock";
const SETTINGS_LOCK_OWNER_FILE_NAME = "owner.json";
const SETTINGS_TEMP_PREFIX = ".settings.";
const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;

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
  return {
    version: SETTINGS_VERSION,
    general: general ?? {},
  };
}

export function emptyConsoleSettingsData(): ConsoleSettingsData {
  return { version: 1, general: {} };
}

function readConsoleGeneralSettings(value: unknown): ConsoleGeneralSettings | null {
  if (!isRecord(value)) return null;
  const consolePortMode = value.consolePortMode === "dynamic" || value.consolePortMode === "static"
    ? value.consolePortMode
    : undefined;
  const consoleStaticPort = isValidConsoleStaticPort(value.consoleStaticPort)
    ? value.consoleStaticPort
    : undefined;
  const theme = value.theme === "maritime" || value.theme === "carbon"
    ? value.theme
    : undefined;
  return {
    ...(consolePortMode !== undefined ? { consolePortMode } : {}),
    ...(consoleStaticPort !== undefined ? { consoleStaticPort } : {}),
    ...(theme !== undefined ? { theme } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}
