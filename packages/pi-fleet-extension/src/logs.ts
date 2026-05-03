import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { CoreLogAPI, LogCategoryMeta, LogEntry, LogLevel, LogOptions } from "@sbluemin/fleet-core/services/log";
import {
  appendLog,
  clearFileLogs,
  clearLogs,
  DEFAULT_LOG_CATEGORY,
  getLatestVisibleLogs,
  getRecentLogs,
  getRegisteredCategories,
  initLogAPI,
  loadSettings,
  registerCategory,
  saveSettings,
} from "@sbluemin/fleet-core/services/log";
import { getSettingsService } from "@sbluemin/fleet-core/services/settings";

interface LogFooterBridge {
  lines: string[] | null;
  requestRender: (() => void) | null;
}

const FOOTER_MAX_LINES = 5;
const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "dim",
  info: "accent",
  warn: "warning",
  error: "error",
};
const logFooterBridge: LogFooterBridge = { lines: null, requestRender: null };
const logApi = createAPI();

initLogAPI(logApi);

export function getLogFooterBridge(): LogFooterBridge {
  return logFooterBridge;
}

export function registerLog(ctx: ExtensionAPI): void {
  registerLogSettingsSection();
  registerLogLifecycle(ctx);
  registerLogCommands(ctx);
}

function createAPI(): CoreLogAPI {
  const api: CoreLogAPI = {
    debug(source, message, options) {
      api.log("debug", source, message, options);
    },
    info(source, message, options) {
      api.log("info", source, message, options);
    },
    warn(source, message, options) {
      api.log("warn", source, message, options);
    },
    error(source, message, options) {
      api.log("error", source, message, options);
    },
    log(level, source, message, options?: LogOptions) {
      const settings = loadSettings();
      if (!settings.enabled) return;

      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        category: options?.category ?? DEFAULT_LOG_CATEGORY,
        source,
        message,
        hideFromFooter: options?.hideFromFooter === true,
      };

      appendLog(entry, settings);
      if (settings.footerDisplay) {
        updateFooterBridge();
      }
    },
    isEnabled() {
      return loadSettings().enabled;
    },
    setEnabled(enabled) {
      saveSettings({ enabled });
      if (enabled) {
        const settings = loadSettings();
        if (settings.footerDisplay) {
          updateFooterBridge();
        }
      } else {
        clearFooterBridge();
      }
    },
    getRecentLogs(count) {
      return getRecentLogs(count);
    },
    registerCategory(meta: LogCategoryMeta) {
      registerCategory(meta);
    },
    getRegisteredCategories() {
      return getRegisteredCategories();
    },
  };
  return api;
}

function registerLogSettingsSection(): void {
  const settingsApi = getSettingsService();
  settingsApi?.registerSection({
    key: "core-log",
    displayName: "Log",
    getDisplayFields() {
      const settings = loadSettings();
      return [
        { label: "Enabled", value: settings.enabled ? "ON" : "OFF", color: settings.enabled ? "accent" : "dim" },
        { label: "File Log", value: settings.fileLog ? "ON" : "OFF", color: settings.fileLog ? "accent" : "dim" },
        { label: "Footer", value: settings.footerDisplay ? "ON" : "OFF", color: settings.footerDisplay ? "accent" : "dim" },
        { label: "Min Level", value: settings.minLevel, color: LOG_LEVEL_COLORS[settings.minLevel] },
      ];
    },
  });
}

function registerLogLifecycle(ctx: ExtensionAPI): void {
  ctx.on("session_start", async () => {
    clearFooterBridge();

    const settings = loadSettings();
    if (settings.enabled && settings.footerDisplay) {
      updateFooterBridge();
    }
  });
}

function registerLogCommands(ctx: ExtensionAPI): void {
  ctx.registerCommand("fleet:log:toggle", {
    description: "로그 on/off 토글",
    handler: async (_args, commandCtx) => {
      const settings = loadSettings();
      const newEnabled = !settings.enabled;
      saveSettings({ enabled: newEnabled });

      if (newEnabled && settings.footerDisplay) {
        updateFooterBridge();
      } else if (!newEnabled) {
        clearFooterBridge();
      }

      commandCtx.ui.notify(`로그: ${newEnabled ? "ON" : "OFF"}`, "info");
    },
  });

  ctx.registerCommand("fleet:log:settings", {
    description: "로그 상세 설정",
    handler: async (_args, commandCtx) => {
      const current = loadSettings();
      const options = [
        `파일 로그: ${current.fileLog ? "ON" : "OFF"}`,
        `Footer 표시: ${current.footerDisplay ? "ON" : "OFF"}`,
        `최소 레벨: ${current.minLevel}`,
        "카테고리 관리",
        "화면 로그 초기화 (파일 로그 유지)",
      ];

      const choice = await commandCtx.ui.select("로그 설정:", options);
      if (choice === undefined) {
        commandCtx.ui.notify("설정이 취소되었습니다.", "warning");
        return;
      }

      if (choice.startsWith("파일 로그")) {
        saveSettings({ fileLog: !current.fileLog });
        commandCtx.ui.notify(`파일 로그: ${!current.fileLog ? "ON" : "OFF"}`, "info");
      } else if (choice.startsWith("Footer 표시")) {
        const newFooter = !current.footerDisplay;
        saveSettings({ footerDisplay: newFooter });
        if (!newFooter) {
          clearFooterBridge();
        } else if (current.enabled) {
          updateFooterBridge();
        }
        commandCtx.ui.notify(`Footer 표시: ${newFooter ? "ON" : "OFF"}`, "info");
      } else if (choice.startsWith("최소 레벨")) {
        const levels: LogLevel[] = ["debug", "info", "warn", "error"];
        const levelChoice = await commandCtx.ui.select(
          "최소 로그 레벨:",
          levels.map((level) => `${level}${level === current.minLevel ? " [current]" : ""}`),
        );
        if (levelChoice === undefined) {
          commandCtx.ui.notify("설정이 취소되었습니다.", "warning");
          return;
        }
        const selected = levelChoice.split(" ")[0] as LogLevel;
        saveSettings({ minLevel: selected });
        if (current.enabled && current.footerDisplay) {
          updateFooterBridge();
        }
        commandCtx.ui.notify(`최소 레벨: ${selected}`, "info");
      } else if (choice.startsWith("카테고리 관리")) {
        await toggleLogCategory(commandCtx);
      } else if (choice.startsWith("화면 로그 초기화")) {
        clearLogs();
        clearFooterBridge();
        commandCtx.ui.notify("화면 로그가 초기화되었습니다 (파일 로그는 유지).", "info");
      }
    },
  });

  ctx.registerCommand("fleet:log:clear", {
    description: "로그 전체 삭제 (메모리 + 파일)",
    handler: async (_args, commandCtx) => {
      clearLogs();
      clearFileLogs();
      clearFooterBridge();
      commandCtx.ui.notify("모든 로그가 삭제되었습니다 (메모리 + 파일).", "info");
    },
  });

  ctx.registerCommand("fleet:log:category", {
    description: "로그 카테고리 활성/비활성 토글",
    handler: async (_args, commandCtx) => {
      await toggleLogCategory(commandCtx);
    },
  });
}

function getBridge(): LogFooterBridge {
  return getLogFooterBridge();
}

function updateFooterBridge(): void {
  const settings = loadSettings();
  const entries = getLatestVisibleLogs(settings.minLevel, FOOTER_MAX_LINES);
  if (entries.length === 0) {
    clearFooterBridge();
    return;
  }

  const lines = entries.map((entry) => {
    const time = entry.timestamp.slice(11, 19);
    const levelTag = entry.level.toUpperCase().padEnd(5);
    return `[${time}] ${levelTag} [${entry.source}] ${entry.message}`;
  });

  const bridge = getBridge();
  bridge.lines = lines;
  bridge.requestRender?.();
}

function clearFooterBridge(): void {
  const bridge = getBridge();
  bridge.lines = null;
  bridge.requestRender?.();
}

async function toggleLogCategory(commandCtx: any): Promise<void> {
  const categories = getRegisteredCategories();
  if (categories.length === 0) {
    commandCtx.ui.notify("등록된 로그 카테고리가 없습니다.", "warning");
    return;
  }

  const current = loadSettings();
  const disabled = new Set(current.disabledCategories);
  const options = categories.map((meta) => {
    const enabled = !disabled.has(meta.id);
    const summary = meta.description ? ` — ${meta.description}` : "";
    return `[${enabled ? "ON" : "OFF"}] ${meta.label} (${meta.id})${summary}`;
  });

  const choice = await commandCtx.ui.select("로그 카테고리 토글:", options);
  if (choice === undefined) {
    commandCtx.ui.notify("설정이 취소되었습니다.", "warning");
    return;
  }

  const index = options.indexOf(choice);
  const meta = categories[index];
  if (!meta) {
    commandCtx.ui.notify("선택한 카테고리를 찾을 수 없습니다.", "error");
    return;
  }

  if (disabled.has(meta.id)) {
    disabled.delete(meta.id);
  } else {
    disabled.add(meta.id);
  }

  saveSettings({ disabledCategories: Array.from(disabled) });
  if (current.enabled && current.footerDisplay) {
    updateFooterBridge();
  }
  commandCtx.ui.notify(`카테고리 ${meta.label}: ${disabled.has(meta.id) ? "OFF" : "ON"}`, "info");
}
