import * as path from "node:path";

import { getFleetDataDir } from "../paths.js";
import { createDurableJsonStore } from "../../fs-store/json-store.js";
import type { GlobalOptionsData, GlobalOptionsStore, GlobalOptionsValidationResult } from "./types.js";

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

export function createEmptyGlobalOptionsData(): GlobalOptionsData {
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
  const data: GlobalOptionsData = {
    version: GLOBAL_OPTIONS_VERSION,
    ...(typeof value.enableMetaphor === "boolean" ? { enableMetaphor: value.enableMetaphor } : {}),
    ...(agentIdleDormantMinutes !== undefined ? { agentIdleDormantMinutes } : {}),
  };
  const allowedKeys = new Set(["version", "enableMetaphor", "agentIdleDormantMinutes"]);
  const changed = Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    ("enableMetaphor" in value && typeof value.enableMetaphor !== "boolean") ||
    ("agentIdleDormantMinutes" in value && agentIdleDormantMinutes === undefined);

  return { data, changed };
}

function sanitizeAgentIdleDormantMinutes(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
