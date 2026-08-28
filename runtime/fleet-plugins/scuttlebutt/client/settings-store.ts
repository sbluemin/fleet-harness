import type { ClientSettingsCapability } from "@fleet-console/sdk/plugin";

import { DEFAULT_BIRD_WIDTH, clampBirdWidth } from "./roaming.js";

export type ScuttlebuttAideId = "tori" | "bori" | "dori";

export interface AideStayPut {
  readonly enabled: boolean;
  readonly nx: number | null;
  readonly ny: number | null;
}

export type StayPutMap = Record<ScuttlebuttAideId, AideStayPut>;
/** 부관별 렌더 폭(px). 범위와 격자는 roaming.ts 가 소유한다. */
export type SizeMap = Record<ScuttlebuttAideId, number>;

export interface ScuttlebuttSettings {
  readonly tori: boolean;
  readonly bori: boolean;
  readonly dori: boolean;
  readonly departureBell: boolean;
  readonly stayPut: StayPutMap;
  readonly sizes: SizeMap;
}

const IDLE_STAY_PUT: AideStayPut = Object.freeze({ enabled: false, nx: null, ny: null });
const DEFAULT_STAY_PUT: StayPutMap = Object.freeze({
  tori: IDLE_STAY_PUT,
  bori: IDLE_STAY_PUT,
  dori: IDLE_STAY_PUT,
});
const DEFAULT_SIZES: SizeMap = Object.freeze({
  tori: DEFAULT_BIRD_WIDTH,
  bori: DEFAULT_BIRD_WIDTH,
  dori: DEFAULT_BIRD_WIDTH,
});

// 실험 기능이라 아무것도 켜지 않은 채로 출발한다 — 상주하는 마스코트는 스스로 골라 들이는 것이다.
const DEFAULT_SETTINGS: ScuttlebuttSettings = {
  tori: false,
  bori: false,
  dori: false,
  departureBell: true,
  stayPut: DEFAULT_STAY_PUT,
  sizes: DEFAULT_SIZES,
};

let settings = DEFAULT_SETTINGS;
/**
 * 서버가 마지막으로 받아들인 값. 저장이 실패했을 때 돌아갈 곳은 "쓰기 직전 스냅숏"이 아니라
 * 이것이다 — 미리보기는 큐 밖에서 화면 상태를 미리 바꿔 두므로 그 스냅숏에는 아직 저장된 적
 * 없는 값이 섞여 있고, 쓰기가 겹치면 그 오염이 서로의 롤백을 덮어쓴다.
 */
let persisted = DEFAULT_SETTINGS;
let capability: ClientSettingsCapability | null = null;
const listeners = new Set<() => void>();

export function connectScuttlebuttSettings(nextCapability: ClientSettingsCapability): () => void {
  capability = nextCapability;
  void nextCapability.read("scuttlebutt").then((value) => {
    if (capability !== nextCapability) return;
    settings = persisted = parseSettings(value);
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

/**
 * 쓰기는 한 줄로 세운다. 저장은 문서를 통째로 덮는 PUT이고 실패하면 직전 스냅숏으로 되돌리는데,
 * 두 쓰기가 겹치면 각자 자기 시점의 `previous`를 들고 있다가 나중 것이 먼저 끝난 뒤 앞선 것이
 * 실패하면 이미 반영된 값까지 함께 되돌린다. 스테퍼를 연달아 누르는 조작이 실제로 그 경합을
 * 만든다 — 직렬화하면 `previous`가 항상 자기 차례 직전의 상태라 롤백이 자기 몫만 되돌린다.
 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 패치를 함수로 받을 수 있다. 중첩된 맵(stayPut·sizes) 한 칸만 바꾸는 쓰기는 나머지 칸을 함께
 * 실어 보내야 하는데, 그 값을 큐에 서기 **전에** 읽으면 앞선 쓰기가 바꾼 다른 부관의 값을 옛
 * 것으로 되돌린다. 함수로 주면 자기 차례가 왔을 때의 상태에서 패치를 만든다.
 */
export async function writeScuttlebuttSettings(
  patch: Partial<ScuttlebuttSettings> | ((current: ScuttlebuttSettings) => Partial<ScuttlebuttSettings>),
): Promise<void> {
  const run = writeChain.then(async () => {
    settings = { ...settings, ...(typeof patch === "function" ? patch(settings) : patch) };
    emit();
    const attempted = settings;
    try {
      await capability?.write("scuttlebutt", { ...attempted });
      persisted = attempted;
    } catch (error) {
      settings = persisted;
      emit();
      throw error;
    }
  });
  // 앞선 쓰기가 실패해도 체인은 이어져야 다음 조작이 막히지 않는다.
  writeChain = run.catch(() => undefined);
  return run;
}

export async function writeAideStayPut(
  admiral: ScuttlebuttAideId,
  next: AideStayPut,
): Promise<void> {
  await writeScuttlebuttSettings((current) => ({
    stayPut: { ...current.stayPut, [admiral]: next },
  }));
}

function parseSettings(value: Record<string, unknown> | null): ScuttlebuttSettings {
  if (!value) return DEFAULT_SETTINGS;
  return {
    tori: typeof value.tori === "boolean" ? value.tori : false,
    bori: typeof value.bori === "boolean" ? value.bori : false,
    dori: typeof value.dori === "boolean" ? value.dori : false,
    departureBell: typeof value.departureBell === "boolean" ? value.departureBell : true,
    stayPut: parseStayPutMap(value.stayPut),
    sizes: parseSizeMap(value.sizes),
  };
}

/**
 * 크기는 저장된 뒤에도 계약 범위 안이라는 보장이 없다 — 범위를 넓혔다 좁힌 판본, 손으로 고친
 * settings.json, 다른 기기에서 온 값이 모두 여기로 온다. 화면을 덮는 부관이나 잡을 수 없는
 * 부관은 설정에 복구 수단이 없으면 되돌릴 길이 없으므로, 읽는 자리에서 부관마다 따로 되돌린다.
 */
function parseSizeMap(value: unknown): SizeMap {
  if (!value || typeof value !== "object") return DEFAULT_SIZES;
  const rec = value as Record<string, unknown>;
  return {
    tori: clampBirdWidth(rec.tori),
    bori: clampBirdWidth(rec.bori),
    dori: clampBirdWidth(rec.dori),
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

/**
 * 끌리는 동안의 크기를 메모리에만 얹는다. 크기는 화면으로 고르는 값이라 손을 뗀 뒤에야 보이면
 * 고를 수가 없다 — 설정 화면 위에도 부관은 떠 있으므로 슬라이더를 끄는 동안 그 자리에서 바로
 * 커지고 작아져야 한다. 저장은 하지 않는다: 그건 commit(writeAideSize)의 몫이다.
 */
export function previewAideSize(admiral: ScuttlebuttAideId, width: number): void {
  settings = { ...settings, sizes: { ...settings.sizes, [admiral]: clampBirdWidth(width) } };
  emit();
}

export async function writeAideSize(admiral: ScuttlebuttAideId, width: number): Promise<void> {
  await writeScuttlebuttSettings((current) => ({
    sizes: { ...current.sizes, [admiral]: clampBirdWidth(width) },
  }));
}

function parseFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function emit(): void {
  for (const listener of listeners) listener();
}
