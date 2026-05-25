import { createPresetStore } from "./store.js";
import type { FleetCliPreset, FleetPresetData, FleetPresetMutation, PresetService, PresetStore } from "./types.js";

interface CreatePresetServiceDeps {
  readonly store?: PresetStore;
  readonly dataDir?: string;
}

export function createPresetService(deps: CreatePresetServiceDeps = {}): PresetService {
  const store = deps.store ?? createPresetStore({ dataDir: deps.dataDir });

  return {
    load: () => store.load(),
    resolveCliPreset: (cliId) => store.load().byCli[cliId] ?? {},
    saveCliPreset: (cliId, values) => updatePreset(store, { cliId, values }),
    saveDefaultCliId: (cliId) => updatePreset(store, { defaultCliId: cliId ?? null }),
    resetCliPreset: (cliId) => updatePreset(store, { cliId, values: null }),
    update: (mutation) => updatePreset(store, mutation),
  };
}

function updatePreset(store: PresetStore, mutation: FleetPresetMutation): FleetPresetData {
  return store.update((current) => applyPresetMutation(current, mutation));
}

function applyPresetMutation(current: FleetPresetData, mutation: FleetPresetMutation): FleetPresetData {
  const byCli: Record<string, FleetCliPreset> = Object.create(null) as Record<string, FleetCliPreset>;
  for (const [cliId, preset] of Object.entries(current.byCli)) {
    if (isSafeDictionaryKey(cliId)) {
      byCli[cliId] = preset;
    }
  }
  if (mutation.cliId !== undefined) {
    if (!isSafeDictionaryKey(mutation.cliId)) {
      return { version: 1, ...(current.defaultCliId ? { defaultCliId: current.defaultCliId } : {}), byCli };
    }
    if (mutation.values === null) {
      delete byCli[mutation.cliId];
    } else if (mutation.values !== undefined) {
      byCli[mutation.cliId] = prunePreset(mutation.values);
    }
  }

  const nextDefaultCliId = mutation.defaultCliId === null
    ? undefined
    : mutation.defaultCliId ?? current.defaultCliId;
  return {
    version: 1,
    ...(nextDefaultCliId ? { defaultCliId: nextDefaultCliId } : {}),
    byCli,
  };
}

function prunePreset(preset: FleetCliPreset): FleetCliPreset {
  return {
    ...(preset.model !== undefined ? { model: preset.model } : {}),
    ...(preset.native !== undefined ? { native: preset.native } : {}),
    ...(preset.replaceSystemPrompt !== undefined ? { replaceSystemPrompt: preset.replaceSystemPrompt } : {}),
    ...(preset.enableMetaphor !== undefined ? { enableMetaphor: preset.enableMetaphor } : {}),
    ...(preset.cursorSync !== undefined ? { cursorSync: preset.cursorSync } : {}),
  };
}

function isSafeDictionaryKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}
