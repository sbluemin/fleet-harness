import * as fs from "node:fs";
import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
import { settingsRuntime } from "../settings/runtime.js";
import type { SettingsRuntime } from "../settings/runtime.js";
import type { CoreLogAPI, LogCategoryMeta, LogEntry, LogLevel, LogSettings } from "./types.js";
import { DEFAULT_LOG_CATEGORY, LOG_LEVEL_PRIORITY } from "./types.js";

export interface CoreLogSettingsPort {
  load<T = Record<string, unknown>>(sectionKey: string): T;
  save(sectionKey: string, data: unknown): void;
}

export interface CoreLogStore {
  setCoreLogSettingsPort(port: CoreLogSettingsPort | null): void;
  getLogAPI(): CoreLogAPI;
  initLogAPI(api: CoreLogAPI): void;
  loadSettings(): Required<LogSettings>;
  saveSettings(settings: Partial<LogSettings>): void;
  registerCategory(meta: LogCategoryMeta): void;
  getRegisteredCategories(): LogCategoryMeta[];
  isCategoryRegistered(id: string): boolean;
  appendLog(entry: LogEntry, settings: Required<LogSettings>): void;
  getRecentLogs(count?: number): LogEntry[];
  getLatestVisibleLog(minLevel: LogLevel): LogEntry | null;
  getLatestVisibleLogs(minLevel: LogLevel, count: number): LogEntry[];
  clearLogs(): void;
  clearFileLogs(): void;
}

export interface CoreLogStoreDeps {
  readonly settingsRuntime?: SettingsRuntime;
}

const SECTION_KEY = "core-log";
const LEGACY_SECTION_KEY = "core-debug-log";
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;
const SECURE_DIR_MODE = 0o700;
const RING_BUFFER_SIZE = 100;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const UNKNOWN_LOG_DATE = "unknown-date";
const DEFAULT_SETTINGS: Required<LogSettings> = {
  enabled: false,
  fileLog: true,
  footerDisplay: true,
  minLevel: "debug",
  disabledCategories: [],
};
const NOOP_LOG_API: CoreLogAPI = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  log() {},
  isEnabled: () => false,
  setEnabled() {},
  getRecentLogs: () => [],
  registerCategory() {},
  getRegisteredCategories: () => [],
};
const defaultCoreLogStore = createCoreLogStore();

export function createCoreLogStore(deps: CoreLogStoreDeps = {}): CoreLogStore {
  const ringBuffer: LogEntry[] = [];
  const categoryRegistry = new Map<string, LogCategoryMeta>();
  let settingsPort: CoreLogSettingsPort | null = null;
  let migrated = false;
  let logApi: CoreLogAPI = NOOP_LOG_API;

  function getSettingsPort(): CoreLogSettingsPort {
    const api = settingsPort ?? deps.settingsRuntime?.get() ?? settingsRuntime.get();
    if (!api) throw new Error("Settings API not available");
    return api;
  }

  function ensureMigrated(): void {
    if (migrated) return;

    try {
      const api = getSettingsPort();
      migrated = true;
      const newData = api.load<LogSettings>(SECTION_KEY);
      if (newData && Object.keys(newData).length > 0) return;

      const legacyData = api.load<LogSettings>(LEGACY_SECTION_KEY);
      if (legacyData && Object.keys(legacyData).length > 0) {
        api.save(SECTION_KEY, legacyData);
        api.save(LEGACY_SECTION_KEY, {});
      }
    } catch {
      // 마이그레이션 실패 시 무시
    }
  }

  function isCategoryRegistered(id: string): boolean {
    return categoryRegistry.has(id);
  }

  categoryRegistry.set(DEFAULT_LOG_CATEGORY, {
    id: DEFAULT_LOG_CATEGORY,
    label: "General",
    description: "기본 로그 카테고리",
  });

  return {
    setCoreLogSettingsPort(port) {
      settingsPort = port;
      migrated = false;
    },
    getLogAPI() {
      return logApi;
    },
    initLogAPI(api) {
      logApi = api;
    },
    loadSettings() {
      try {
        ensureMigrated();
        const raw = getSettingsPort().load<LogSettings>(SECTION_KEY);
        return { ...DEFAULT_SETTINGS, ...raw };
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },
    saveSettings(settings) {
      ensureMigrated();
      const current = this.loadSettings();
      const merged = { ...current, ...settings };
      getSettingsPort().save(SECTION_KEY, merged);
    },
    registerCategory(meta) {
      categoryRegistry.set(meta.id, meta);
    },
    getRegisteredCategories() {
      return Array.from(categoryRegistry.values());
    },
    isCategoryRegistered,
    appendLog(entry, settings) {
      if (!isCategoryRegistered(entry.category)) return;
      if (settings.disabledCategories.includes(entry.category)) return;

      if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[settings.minLevel]) {
        return;
      }

      ringBuffer.push(entry);
      if (ringBuffer.length > RING_BUFFER_SIZE) {
        ringBuffer.shift();
      }

      if (settings.fileLog) {
        writeToFile(entry);
      }
    },
    getRecentLogs(count = 10) {
      const start = Math.max(0, ringBuffer.length - count);
      return ringBuffer.slice(start);
    },
    getLatestVisibleLog(minLevel) {
      const threshold = LOG_LEVEL_PRIORITY[minLevel];
      for (let i = ringBuffer.length - 1; i >= 0; i--) {
        if (
          !ringBuffer[i]!.hideFromFooter &&
          LOG_LEVEL_PRIORITY[ringBuffer[i]!.level] >= threshold
        ) {
          return ringBuffer[i]!;
        }
      }
      return null;
    },
    getLatestVisibleLogs(minLevel, count) {
      const threshold = LOG_LEVEL_PRIORITY[minLevel];
      const result: LogEntry[] = [];
      for (let i = ringBuffer.length - 1; i >= 0 && result.length < count; i--) {
        if (
          !ringBuffer[i]!.hideFromFooter &&
          LOG_LEVEL_PRIORITY[ringBuffer[i]!.level] >= threshold
        ) {
          result.push(ringBuffer[i]!);
        }
      }
      return result.reverse();
    },
    clearLogs() {
      ringBuffer.length = 0;
    },
    clearFileLogs,
  };
}

export function setCoreLogSettingsPort(port: CoreLogSettingsPort | null): void {
  defaultCoreLogStore.setCoreLogSettingsPort(port);
}

export function getLogAPI(): CoreLogAPI {
  return defaultCoreLogStore.getLogAPI();
}

export function initLogAPI(api: CoreLogAPI): void {
  defaultCoreLogStore.initLogAPI(api);
}

export function loadSettings(): Required<LogSettings> {
  return defaultCoreLogStore.loadSettings();
}

export function saveSettings(settings: Partial<LogSettings>): void {
  defaultCoreLogStore.saveSettings(settings);
}

export function registerCategory(meta: LogCategoryMeta): void {
  defaultCoreLogStore.registerCategory(meta);
}

export function getRegisteredCategories(): LogCategoryMeta[] {
  return defaultCoreLogStore.getRegisteredCategories();
}

export function isCategoryRegistered(id: string): boolean {
  return defaultCoreLogStore.isCategoryRegistered(id);
}

export function appendLog(entry: LogEntry, settings: Required<LogSettings>): void {
  defaultCoreLogStore.appendLog(entry, settings);
}

export function getRecentLogs(count: number = 10): LogEntry[] {
  return defaultCoreLogStore.getRecentLogs(count);
}

export function getLatestVisibleLog(minLevel: LogLevel): LogEntry | null {
  return defaultCoreLogStore.getLatestVisibleLog(minLevel);
}

export function getLatestVisibleLogs(minLevel: LogLevel, count: number): LogEntry[] {
  return defaultCoreLogStore.getLatestVisibleLogs(minLevel, count);
}

export function clearLogs(): void {
  defaultCoreLogStore.clearLogs();
}

export function clearFileLogs(): void {
  try {
    if (!isSafeDirectory(getLogsDir())) return;
    const files = fs.readdirSync(getLogsDir());
    for (const file of files) {
      if (file.endsWith(".log")) {
        const filePath = path.join(getLogsDir(), file);
        const stat = safeLstat(filePath);
        if (stat?.isFile() && !stat.isSymbolicLink()) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch {
    // 파일 삭제 실패 시 무시
  }
}

function writeToFile(entry: LogEntry): void {
  try {
    const fleetDataDir = getFleetDataDir();
    ensureSafeDirectory(fleetDataDir);
    ensureSafeDirectory(path.join(fleetDataDir, "logs"));

    const date = getSafeLogDate(entry.timestamp);
    const category = sanitizeCategory(entry.category);
    const filePath = path.join(fleetDataDir, "logs", `${category}-${date}.log`);
    const stat = safeLstat(filePath);
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) return;
    const time = entry.timestamp.slice(11, 23);
    const line = `[${time}] [${entry.level.toUpperCase().padEnd(5)}] [${entry.source}] ${entry.message}\n`;
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      NOFOLLOW_FLAG |
      NONBLOCK_FLAG;
    const fd = fs.openSync(filePath, flags, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) return;
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 파일 쓰기 실패 시 무시 — 로거가 크래시를 유발해서는 안 된다
  }
}

function sanitizeCategory(raw: string): string {
  if (raw.length === 0 || raw.startsWith(".")) {
    return "general";
  }

  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  if (sanitized.length === 0 || sanitized.startsWith(".")) {
    return "general";
  }
  return sanitized;
}

function ensureSafeDirectory(dirPath: string): void {
  const stat = safeLstat(dirPath);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe Fleet log directory: ${dirPath}`);
    }
    fs.chmodSync(dirPath, SECURE_DIR_MODE);
    return;
  }
  fs.mkdirSync(dirPath, { mode: SECURE_DIR_MODE, recursive: true });
  const created = safeLstat(dirPath);
  if (!created?.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Unsafe Fleet log directory: ${dirPath}`);
  }
  fs.chmodSync(dirPath, SECURE_DIR_MODE);
}

function isSafeDirectory(dirPath: string): boolean {
  const stat = safeLstat(dirPath);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function safeLstat(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function getSafeLogDate(timestamp: string): string {
  const match = ISO_DATE_PATTERN.exec(timestamp);
  return match ? match[0].slice(0, 10) : UNKNOWN_LOG_DATE;
}

function getLogsDir(): string {
  return path.join(getFleetDataDir(), "logs");
}
