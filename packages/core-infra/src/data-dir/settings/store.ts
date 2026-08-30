import * as path from "node:path";

import { getFleetDataDir } from "../paths.js";
import { createDurableJsonStore } from "../../fs-store/json-store.js";

export type ClaudeCodeSystemPromptMode = "on" | "off";

export interface GlobalOptionsData {
  readonly version: 1;
  /** Idle agent auto-DORMANT threshold in minutes. `null` disables; key absent means server default. */
  readonly agentIdleDormantMinutes?: number | null;
  /**
   * Claude Code's own base system prompt for new gateway sessions. Key absent means `on`,
   * which is what a launch without any prompt flag already does.
   */
  readonly claudeCodeSystemPrompt?: ClaudeCodeSystemPromptMode;
  /**
   * Whether Fleet launches Claude Code with its permission gate skipped. Key absent means
   * `false`: the child boots on its own default and asks before each tool. Turning this on is
   * an explicit user choice and only the surfaces that can actually show a prompt carry it —
   * the terminal and the `fleet` launcher. Chat keeps bypass regardless, because that surface
   * has no permission gate of its own to honour the choice with.
   */
  readonly claudeCodeSkipPermissions?: boolean;
}

export interface GlobalOptionsValidationResult {
  readonly data: GlobalOptionsData;
  readonly changed: boolean;
}

export interface GlobalOptionsStore {
  readonly path: string;
  readonly load: () => GlobalOptionsData;
  readonly save: (data: GlobalOptionsData) => void;
  readonly update: (mutate: (current: GlobalOptionsData) => GlobalOptionsData) => GlobalOptionsData;
}

export interface GlobalOptionsService {
  readonly load: () => GlobalOptionsData;
  readonly save: (data: GlobalOptionsData) => GlobalOptionsData;
  readonly update: (mutate: (current: GlobalOptionsData) => GlobalOptionsData) => GlobalOptionsData;
}

interface CreateGlobalOptionsStoreDeps {
  readonly dataDir?: string;
  readonly now?: () => number;
  readonly staleLockMs?: number;
  readonly timeoutMs?: number;
}

const GLOBAL_OPTIONS_VERSION = 1;
const GLOBAL_OPTIONS_FILE_NAME = "settings.json";
const LOCK_DIR_NAME = "settings.json.lock";
const LOCK_OWNER_FILE_NAME = "owner";
const TEMP_FILE_PREFIX = `.tmp-${GLOBAL_OPTIONS_FILE_NAME}-`;

interface CreateGlobalOptionsServiceDeps {
  readonly store?: GlobalOptionsStore;
  readonly dataDir?: string;
}

export function createGlobalOptionsService(deps: CreateGlobalOptionsServiceDeps = {}): GlobalOptionsService {
  const store = deps.store ?? createGlobalOptionsStore({ dataDir: deps.dataDir });

  return {
    load: () => store.load(),
    save: (data) => {
      store.save(data);
      return store.load();
    },
    update: (mutate) => updateGlobalOptions(store, mutate),
  };
}

function updateGlobalOptions(
  store: GlobalOptionsStore,
  mutate: (current: GlobalOptionsData) => GlobalOptionsData,
): GlobalOptionsData {
  return store.update(mutate);
}

export function createGlobalOptionsStore(deps: CreateGlobalOptionsStoreDeps = {}): GlobalOptionsStore {
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const optionsPath = path.join(dataDir, GLOBAL_OPTIONS_FILE_NAME);
  const lockDir = path.join(dataDir, LOCK_DIR_NAME);

  const store = createDurableJsonStore<GlobalOptionsData>({
    filePath: optionsPath,
    lockDir,
    lockOwnerFileName: LOCK_OWNER_FILE_NAME,
    sanitize: (value) => sanitizeGlobalOptionsData(value).data,
    sensitivity: "sensitive",
    timeoutMs: deps.timeoutMs,
    staleLockMs: deps.staleLockMs,
    tempCleanupPrefix: TEMP_FILE_PREFIX,
    now: deps.now,
  });

  return {
    path: optionsPath,
    load: () => store.load(),
    save: (data) => store.save(sanitizeGlobalOptionsData(data).data),
    update: (mutate) => store.update((current) => sanitizeGlobalOptionsData(mutate(current)).data),
  };
}

// 내부 구현용 심볼 — `./data-dir/settings` 서브패스의 공개 표면에 올리지 않는다.
function createEmptyGlobalOptionsData(): GlobalOptionsData {
  return {
    version: GLOBAL_OPTIONS_VERSION,
  };
}

export function sanitizeGlobalOptionsData(value: unknown): GlobalOptionsValidationResult {
  if (!isRecord(value)) {
    return { data: createEmptyGlobalOptionsData(), changed: true };
  }

  if (value.version !== GLOBAL_OPTIONS_VERSION) {
    return { data: createEmptyGlobalOptionsData(), changed: true };
  }

  const agentIdleDormantMinutes = sanitizeAgentIdleDormantMinutes(value.agentIdleDormantMinutes);
  const claudeCodeSystemPrompt = sanitizeClaudeCodeSystemPrompt(value.claudeCodeSystemPrompt);
  const claudeCodeSkipPermissions = sanitizeClaudeCodeSkipPermissions(value.claudeCodeSkipPermissions);
  const data: GlobalOptionsData = {
    version: GLOBAL_OPTIONS_VERSION,
    ...(agentIdleDormantMinutes !== undefined ? { agentIdleDormantMinutes } : {}),
    ...(claudeCodeSystemPrompt !== undefined ? { claudeCodeSystemPrompt } : {}),
    ...(claudeCodeSkipPermissions !== undefined ? { claudeCodeSkipPermissions } : {}),
  };
  const allowedKeys = new Set([
    "version",
    "agentIdleDormantMinutes",
    "claudeCodeSystemPrompt",
    "claudeCodeSkipPermissions",
  ]);
  const changed = Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    ("agentIdleDormantMinutes" in value && agentIdleDormantMinutes === undefined) ||
    ("claudeCodeSystemPrompt" in value && claudeCodeSystemPrompt === undefined) ||
    ("claudeCodeSkipPermissions" in value && claudeCodeSkipPermissions === undefined);

  return { data, changed };
}

function sanitizeAgentIdleDormantMinutes(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) return value;
  return undefined;
}

function sanitizeClaudeCodeSystemPrompt(value: unknown): ClaudeCodeSystemPromptMode | undefined {
  return value === "on" || value === "off" ? value : undefined;
}

/**
 * Only a real boolean survives. A truthy string from a hand-edited file must not read as
 * consent to skip the permission gate, so anything else drops the key back to the default.
 */
function sanitizeClaudeCodeSkipPermissions(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
