import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

export type ScuttlebuttAideId = "tori" | "bori" | "dori";

export interface AideStayPut {
  readonly enabled: boolean;
  readonly nx: number | null;
  readonly ny: number | null;
}

export type StayPutMap = Record<ScuttlebuttAideId, AideStayPut>;

export interface ScuttlebuttSettings {
  readonly tori: boolean;
  readonly bori: boolean;
  readonly dori: boolean;
  readonly departureBell: boolean;
  readonly stayPut: StayPutMap;
}

const IDLE_STAY_PUT: AideStayPut = Object.freeze({ enabled: false, nx: null, ny: null });
const DEFAULT_STAY_PUT: StayPutMap = Object.freeze({
  tori: IDLE_STAY_PUT,
  bori: IDLE_STAY_PUT,
  dori: IDLE_STAY_PUT,
});

// 실험 기능이라 아무것도 켜지 않은 채로 출발한다 — 상주하는 마스코트는 스스로 골라 들이는 것이다.
const DEFAULT_SETTINGS: ScuttlebuttSettings = {
  tori: false,
  bori: false,
  dori: false,
  departureBell: true,
  stayPut: DEFAULT_STAY_PUT,
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

export async function writeAideStayPut(
  admiral: ScuttlebuttAideId,
  next: AideStayPut,
): Promise<void> {
  const current = getScuttlebuttSettings();
  await writeScuttlebuttSettings({
    stayPut: { ...current.stayPut, [admiral]: next },
  });
}

function parseSettings(value: Record<string, unknown> | null): ScuttlebuttSettings {
  if (!value) return DEFAULT_SETTINGS;
  return {
    tori: typeof value.tori === "boolean" ? value.tori : false,
    bori: typeof value.bori === "boolean" ? value.bori : false,
    dori: typeof value.dori === "boolean" ? value.dori : false,
    departureBell: typeof value.departureBell === "boolean" ? value.departureBell : true,
    stayPut: parseStayPutMap(value.stayPut),
  };
}

function parseStayPutMap(value: unknown): StayPutMap {
  if (!value || typeof value !== "object") return DEFAULT_STAY_PUT;
  const rec = value as Record<string, unknown>;
  return {
    tori: parseAideStayPut(rec.tori),
    bori: parseAideStayPut(rec.bori),
    dori: parseAideStayPut(rec.dori),
  };
}

function parseAideStayPut(value: unknown): AideStayPut {
  if (value === true) return { enabled: true, nx: null, ny: null };
  if (value === false || value == null || typeof value !== "object") return IDLE_STAY_PUT;
  const rec = value as Record<string, unknown>;
  const enabled = rec.enabled === true;
  const nx = parseFraction(rec.nx);
  const ny = parseFraction(rec.ny);
  if (nx == null || ny == null) return { enabled, nx: null, ny: null };
  return { enabled, nx, ny };
}

function parseFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function emit(): void {
  for (const listener of listeners) listener();
}
