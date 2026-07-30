import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

export interface ScuttlebuttSettings {
  readonly tori: boolean;
  readonly bori: boolean;
  readonly dori: boolean;
  readonly departureBell: boolean;
}

// 실험 기능이라 아무것도 켜지 않은 채로 출발한다 — 상주하는 마스코트는 스스로 골라 들이는 것이다.
const DEFAULT_SETTINGS: ScuttlebuttSettings = {
  tori: false,
  bori: false,
  dori: false,
  departureBell: true,
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
    tori: typeof value.tori === "boolean" ? value.tori : false,
    bori: typeof value.bori === "boolean" ? value.bori : false,
    dori: typeof value.dori === "boolean" ? value.dori : false,
    departureBell: typeof value.departureBell === "boolean" ? value.departureBell : true,
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}
