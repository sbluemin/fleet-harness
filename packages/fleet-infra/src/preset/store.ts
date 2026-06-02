import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
import { createDurableJsonStore } from "../fs-store/json-store.js";
import type { FleetCliPreset, FleetPresetData, FleetPresetValidationResult, PresetStore } from "./types.js";

interface CreatePresetStoreDeps {
  readonly dataDir?: string;
  readonly now?: () => number;
  readonly staleLockMs?: number;
  readonly timeoutMs?: number;
}

// preset 전용 상수
const PRESET_VERSION = 1;
const PRESET_FILE_NAME = "presets.json";
const LOCK_DIR_NAME = "presets.json.lock";
const LOCK_OWNER_FILE_NAME = "owner";
const TEMP_FILE_PREFIX = `.tmp-${PRESET_FILE_NAME}-`;

export function createPresetStore(deps: CreatePresetStoreDeps = {}): PresetStore {
  const dataDir = deps.dataDir ?? getFleetDataDir();
  const presetPath = path.join(dataDir, PRESET_FILE_NAME);
  const lockDir = path.join(dataDir, LOCK_DIR_NAME);

  const store = createDurableJsonStore<FleetPresetData>({
    filePath: presetPath,
    lockDir,
    lockOwnerFileName: LOCK_OWNER_FILE_NAME,
    sanitize: (value) => sanitizePresetData(value).data,
    sensitivity: "sensitive",
    timeoutMs: deps.timeoutMs,
    staleLockMs: deps.staleLockMs,
    tempCleanupPrefix: TEMP_FILE_PREFIX,
    now: deps.now,
  });

  return {
    path: presetPath,
    load: () => store.load(),
    save: (data) => store.save(sanitizePresetData(data).data),
    update: (mutate) => store.update((current) => sanitizePresetData(mutate(current)).data),
  };
}

export function createEmptyPresetData(): FleetPresetData {
  return { version: PRESET_VERSION, byCli: {} };
}

export function sanitizePresetData(value: unknown): FleetPresetValidationResult {
  if (!isRecord(value)) {
    return { data: createEmptyPresetData(), changed: true };
  }

  let changed = value.version !== PRESET_VERSION;
  const defaultCliId = typeof value.defaultCliId === "string" && value.defaultCliId.length > 0
    ? value.defaultCliId
    : undefined;
  if ("defaultCliId" in value && defaultCliId === undefined) {
    changed = true;
  }

  const byCli: Record<string, FleetCliPreset> = Object.create(null) as Record<string, FleetCliPreset>;
  if (isRecord(value.byCli)) {
    for (const [cliId, rawPreset] of Object.entries(value.byCli)) {
      if (!isSafeDictionaryKey(cliId)) {
        changed = true;
        continue;
      }
      const preset = sanitizeCliPreset(rawPreset);
      if (preset.changed) {
        changed = true;
      }
      if (Object.keys(preset.data).length > 0) {
        byCli[cliId] = preset.data;
      }
    }
  } else if ("byCli" in value) {
    changed = true;
  }

  return { data: { version: PRESET_VERSION, ...(defaultCliId ? { defaultCliId } : {}), byCli }, changed };
}

export function sanitizeCliPreset(value: unknown): { readonly data: FleetCliPreset; readonly changed: boolean } {
  if (!isRecord(value)) {
    return { data: {}, changed: true };
  }

  const data: FleetCliPreset = {
    ...(typeof value.model === "string" && value.model.length > 0 ? { model: value.model } : {}),
    ...(typeof value.native === "boolean" ? { native: value.native } : {}),
    ...(typeof value.replaceSystemPrompt === "boolean" ? { replaceSystemPrompt: value.replaceSystemPrompt } : {}),
    ...(typeof value.enableMetaphor === "boolean" ? { enableMetaphor: value.enableMetaphor } : {}),
    ...(typeof value.cursorSync === "boolean" ? { cursorSync: value.cursorSync } : {}),
  };
  const changed = Object.keys(value).some((key) => !(key in data)) ||
    ("model" in value && data.model === undefined) ||
    ("native" in value && data.native === undefined) ||
    ("replaceSystemPrompt" in value && data.replaceSystemPrompt === undefined) ||
    ("enableMetaphor" in value && data.enableMetaphor === undefined) ||
    ("cursorSync" in value && data.cursorSync === undefined);
  return { data, changed };
}

function isSafeDictionaryKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
