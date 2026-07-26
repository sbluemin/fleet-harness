import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

export interface ScuttlebuttSettings {
  readonly enabled: boolean;
  readonly cliId: string;
  readonly model: string;
  readonly effort: string | null;
}

const DEFAULT_SETTINGS: ScuttlebuttSettings = {
  enabled: true,
  cliId: "claude",
  model: "",
  effort: null,
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
    cliId: typeof value.cliId === "string" ? value.cliId : "claude",
    model: typeof value.model === "string" ? value.model : "",
    effort: typeof value.effort === "string" ? value.effort : null,
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}
