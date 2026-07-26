import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

export interface ScuttlebuttSettings {
  readonly enabled: boolean;
  readonly tori: boolean;
  readonly bori: boolean;
  readonly dori: boolean;
}

const DEFAULT_SETTINGS: ScuttlebuttSettings = {
  enabled: true,
  tori: true,
  bori: true,
  dori: true,
};

let settings = DEFAULT_SETTINGS;
let capability: ClientSettingsCapability | null = null;
const listeners = new Set<() => void>();

export function connectScuttlebuttSettings(nextCapability: ClientSettingsCapability): () => void {
  capability = nextCapability;
  void nextCapability.read("scuttlebutt").then((value) => {
    if (capability !== nextCapability) return;
    settings = parseSettings(value);
    emit();
  }).catch(() => undefined);
  return () => {
    if (capability === nextCapability) capability = null;
  };
}

export function getScuttlebuttSettings(): ScuttlebuttSettings {
  return settings;
}

export function subscribeScuttlebuttSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function writeScuttlebuttSettings(patch: Partial<ScuttlebuttSettings>): Promise<void> {
  const previous = settings;
  settings = { ...settings, ...patch };
  emit();
  try {
    await capability?.write("scuttlebutt", { ...settings });
  } catch (error) {
    settings = previous;
    emit();
    throw error;
  }
}

function parseSettings(value: Record<string, unknown> | null): ScuttlebuttSettings {
  if (!value) return DEFAULT_SETTINGS;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    tori: typeof value.tori === "boolean" ? value.tori : true,
    bori: typeof value.bori === "boolean" ? value.bori : true,
    dori: typeof value.dori === "boolean" ? value.dori : true,
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}
