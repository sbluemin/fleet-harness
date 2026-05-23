import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreSettingsAPI, SectionDisplayConfig } from "../src/settings/index.js";
import type { LogEntry } from "../src/log/types.js";
import { DEFAULT_LOG_CATEGORY } from "../src/log/types.js";

interface MemorySettingsAPI extends CoreSettingsAPI {
  readonly data: Record<string, unknown>;
}

type LogStoreModule = typeof import("../src/log/store.js");
type SettingsRuntimeModule = typeof import("../src/settings/runtime.js");
type LogStore = ReturnType<LogStoreModule["createCoreLogStore"]>;

const FILE_LOG_SETTINGS = {
  enabled: true,
  fileLog: true,
  footerDisplay: true,
  minLevel: "debug" as const,
  disabledCategories: [],
};

let testHomeDir = "";

beforeEach(() => {
  testHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-log-store-"));
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
      ...actual,
      homedir: () => testHomeDir,
    };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.resetModules();
  cleanupFileLogTestArtifacts();
});

describe("core log settings store", () => {
  it("saves through the runtime-owned settings service when no explicit port is set", async () => {
    const { settingsRuntime, store } = await loadLogStoreModules();
    const api = createMemorySettingsAPI();
    settingsRuntime.init(api);

    store.saveSettings({ enabled: true, minLevel: "warn" });

    expect(api.data["core-log"]).toMatchObject({
      enabled: true,
      minLevel: "warn",
      fileLog: true,
      footerDisplay: true,
      disabledCategories: [],
    });
    expect(store.loadSettings()).toMatchObject({
      enabled: true,
      minLevel: "warn",
    });
  });

  it("keeps legacy migration available after an early load without settings service", async () => {
    const { settingsRuntime, store } = await loadLogStoreModules();

    expect(store.loadSettings()).toMatchObject({ enabled: false });

    const api = createMemorySettingsAPI({
      "core-debug-log": {
        enabled: true,
        minLevel: "error",
      },
    });
    settingsRuntime.init(api);

    store.saveSettings({ footerDisplay: false });

    expect(api.data["core-log"]).toMatchObject({
      enabled: true,
      minLevel: "error",
      footerDisplay: false,
    });
    expect(api.data["core-debug-log"]).toEqual({});
  });

  it("keeps manipulated timestamp date segments inside the log directory", async () => {
    const { store } = await loadLogStoreModules();
    const { outsideLogFile, safeFallbackLogFile } = getFileLogTestPaths();
    const entry: LogEntry = {
      timestamp: "x/../../aa",
      level: "info",
      category: DEFAULT_LOG_CATEGORY,
      source: "test",
      message: "malicious timestamp",
    };

    store.appendLog(entry, FILE_LOG_SETTINGS);

    expect(fs.existsSync(outsideLogFile)).toBe(false);
    expect(fs.existsSync(safeFallbackLogFile)).toBe(true);
    expect(safeFallbackLogFile.startsWith(testHomeDir)).toBe(true);
  });

  it("does not append file logs through symlinked log files", async () => {
    const { store } = await loadLogStoreModules();
    const { logsDir, safeFallbackLogFile } = getFileLogTestPaths();
    const outsideFile = path.join(testHomeDir, "outside.log");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(outsideFile, "outside");
    fs.symlinkSync(outsideFile, safeFallbackLogFile);

    store.appendLog({
      timestamp: "invalid",
      level: "info",
      category: DEFAULT_LOG_CATEGORY,
      source: "test",
      message: "should not follow",
    }, FILE_LOG_SETTINGS);

    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    expect(fs.lstatSync(safeFallbackLogFile).isSymbolicLink()).toBe(true);
  });

  it("keeps Fleet log directories owner-only", async () => {
    const { store } = await loadLogStoreModules();
    const { logsDir } = getFileLogTestPaths();

    store.appendLog({
      timestamp: "invalid",
      level: "info",
      category: DEFAULT_LOG_CATEGORY,
      source: "test",
      message: "secure mode",
    }, FILE_LOG_SETTINGS);

    expect(fs.statSync(path.dirname(logsDir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logsDir).mode & 0o777).toBe(0o700);
  });
});

async function loadLogStoreModules(): Promise<{
  settingsRuntime: ReturnType<SettingsRuntimeModule["createSettingsRuntime"]>;
  store: LogStore;
}> {
  const [settingsRuntimeModule, storeModule] = await Promise.all([
    import("../src/settings/runtime.js"),
    import("../src/log/store.js"),
  ]);
  const settingsRuntime = settingsRuntimeModule.createSettingsRuntime();
  const store = storeModule.createCoreLogStore({ settingsRuntime });
  store.setCoreLogSettingsPort(null);
  return { settingsRuntime, store };
}

function createMemorySettingsAPI(initial: Record<string, unknown> = {}): MemorySettingsAPI {
  const data: Record<string, unknown> = { ...initial };
  const sections = new Map<string, SectionDisplayConfig>();
  return {
    data,
    load<T = Record<string, unknown>>(sectionKey: string): T {
      return (data[sectionKey] ?? {}) as T;
    },
    save(sectionKey: string, value: unknown): void {
      data[sectionKey] = value;
    },
    registerSection(config: SectionDisplayConfig): void {
      sections.set(config.key, config);
    },
    unregisterSection(sectionKey: string): void {
      sections.delete(sectionKey);
    },
    getSections(): SectionDisplayConfig[] {
      return Array.from(sections.values());
    },
  };
}

function cleanupFileLogTestArtifacts(): void {
  try {
    if (testHomeDir.length > 0) {
      fs.rmSync(testHomeDir, { force: true, recursive: true });
    }
  } catch {
    // 테스트 정리 실패 시 무시
  } finally {
    testHomeDir = "";
  }
}

function getFileLogTestPaths(): {
  logsDir: string;
  outsideLogFile: string;
  safeFallbackLogFile: string;
} {
  const fleetDataDir = path.join(testHomeDir, ".fleet");
  const logsDir = path.join(fleetDataDir, "logs");
  return {
    logsDir,
    outsideLogFile: path.join(fleetDataDir, "aa.log"),
    safeFallbackLogFile: path.join(logsDir, "general-unknown-date.log"),
  };
}
