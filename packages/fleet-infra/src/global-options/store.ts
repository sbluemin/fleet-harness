import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
import { createDurableJsonStore } from "../fs-store/json-store.js";
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

  const data: GlobalOptionsData = {
    version: GLOBAL_OPTIONS_VERSION,
    ...(typeof value.replaceSystemPrompt === "boolean" ? { replaceSystemPrompt: value.replaceSystemPrompt } : {}),
    ...(typeof value.enableMetaphor === "boolean" ? { enableMetaphor: value.enableMetaphor } : {}),
  };
  const allowedKeys = new Set(["version", "replaceSystemPrompt", "enableMetaphor"]);
  const changed = Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    ("replaceSystemPrompt" in value && typeof value.replaceSystemPrompt !== "boolean") ||
    ("enableMetaphor" in value && typeof value.enableMetaphor !== "boolean");

  return { data, changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
