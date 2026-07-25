import crypto from "node:crypto";

import {
  MAX_WORKSPACE_PRESET_NAME_LENGTH,
  type DurableWorkspacePreset,
  type WorkspacePresetLayout,
} from "../durable-state.js";

export interface WorkspacePresetStore {
  readonly list: (theaterId?: string) => readonly DurableWorkspacePreset[];
  readonly get: (theaterId: string, presetId: string) => DurableWorkspacePreset | null;
  readonly create: (theaterId: string, name: string, layout: WorkspacePresetLayout) => DurableWorkspacePreset;
  readonly rename: (theaterId: string, presetId: string, name: string) => DurableWorkspacePreset | null;
  readonly delete: (theaterId: string, presetId: string) => boolean;
  readonly deleteByTheater: (theaterId: string) => readonly DurableWorkspacePreset[];
  readonly replace: (presets: readonly DurableWorkspacePreset[]) => void;
}

export function createWorkspacePresetStore(deps: {
  readonly now?: () => number;
  readonly randomId?: () => string;
} = {}): WorkspacePresetStore {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? crypto.randomUUID;
  const presets = new Map<string, DurableWorkspacePreset>();

  function list(theaterId?: string): readonly DurableWorkspacePreset[] {
    return [...presets.values()]
      .filter((preset) => theaterId === undefined || preset.theaterId === theaterId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  function get(theaterId: string, presetId: string): DurableWorkspacePreset | null {
    const preset = presets.get(presetId);
    return preset?.theaterId === theaterId ? preset : null;
  }

  function create(theaterId: string, rawName: string, layout: WorkspacePresetLayout): DurableWorkspacePreset {
    const name = normalizeName(rawName);
    if (!name) throw new Error("invalid_workspace_preset_name");
    const timestamp = now();
    const preset: DurableWorkspacePreset = {
      id: randomId(),
      theaterId,
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
      layout: cloneLayout(layout),
    };
    presets.set(preset.id, preset);
    return preset;
  }

  function rename(theaterId: string, presetId: string, rawName: string): DurableWorkspacePreset | null {
    const existing = get(theaterId, presetId);
    if (!existing) return null;
    const name = normalizeName(rawName);
    if (!name) throw new Error("invalid_workspace_preset_name");
    const updated = { ...existing, name, updatedAt: now() };
    presets.set(updated.id, updated);
    return updated;
  }

  function deletePreset(theaterId: string, presetId: string): boolean {
    const existing = get(theaterId, presetId);
    return existing ? presets.delete(existing.id) : false;
  }

  function deleteByTheater(theaterId: string): readonly DurableWorkspacePreset[] {
    const deleted = list(theaterId);
    for (const preset of deleted) presets.delete(preset.id);
    return deleted;
  }

  function replace(nextPresets: readonly DurableWorkspacePreset[]): void {
    presets.clear();
    for (const preset of nextPresets) {
      if (!presets.has(preset.id)) presets.set(preset.id, clonePreset(preset));
    }
  }

  return { list, get, create, rename, delete: deletePreset, deleteByTheater, replace };
}

function normalizeName(value: string): string | null {
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_WORKSPACE_PRESET_NAME_LENGTH ? name : null;
}

function clonePreset(preset: DurableWorkspacePreset): DurableWorkspacePreset {
  return { ...preset, layout: cloneLayout(preset.layout) };
}

function cloneLayout(layout: WorkspacePresetLayout): WorkspacePresetLayout {
  return {
    viewport: { ...layout.viewport },
    operationGeometries: Object.fromEntries(
      Object.entries(layout.operationGeometries).map(([operationId, geometry]) => [operationId, { ...geometry }]),
    ),
    minimizedOperationIds: [...layout.minimizedOperationIds],
    rail: { ...layout.rail },
    sidebar: { ...layout.sidebar },
  };
}
