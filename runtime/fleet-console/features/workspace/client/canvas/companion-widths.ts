import { useSyncExternalStore } from "react";

/**
 * Companion 배치의 슬롯 폭 — 등분 대신 사용자가 나눈 몫.
 *
 * 폭의 주인은 **패널 종류**다. 우측 레일이 "파일 트리를 이 정도로"를 도구별로 기억하는 것과 같은
 * 논리다: 사용자가 정한 것은 이 Operation의 사정이 아니라 그 패널에 대한 결정이다. 그래서 키는
 * Operation id가 아니라 슬롯 id이고, 어느 Operation에서 열든 같은 폭으로 선다.
 *
 * 저장하는 값은 픽셀이 아니라 **가중치**다. 픽셀을 기억하면 창을 줄였다 키울 때마다 비율이 무너진다.
 * 분할선은 끌던 순간의 픽셀을 그대로 가중치로 넣고, 렌더가 그때그때 정규화한다.
 */

/** Operation 본체가 차지하는 슬롯. companion id와 같은 이름공간에 살아야 가중치 배열이 한 벌로 선다. */
export const COMPANION_SESSION_SLOT_ID = "session";

/** 슬롯 사이 틈. 이 폭이 곧 분할선의 손잡이 폭이다. */
export const COMPANION_SLOT_GAP_PX = 8;

/**
 * 슬롯 하나가 내려가지 않는 바닥.
 *
 * 실측 근거: 1689px 창의 3분할(434px)에서 세션 터미널의 상태줄이 잘렸고 655px에서는 온전했다.
 * 434는 이미 잘린 지점이므로 바닥으로 쓸 수 없고, 잘리지 않은 655는 두 패널을 1280px 창에
 * 못 세운다. 320은 그 사이에서 "좁지만 읽을 수 있는" 폭이자 레일 하한(240)보다 넉넉한 값이다.
 */
export const COMPANION_MIN_SLOT_PX = 320;

/**
 * 바닥을 세울 자리가 없는 쌍에서 한 슬롯이 지키는 최소 몫.
 *
 * 좁은 배치에서 바닥을 "쌍의 절반"으로 낮추면 분할선의 허용 범위가 한 점으로 붙어 아예 움직이지
 * 않는다 — 1100px 창의 3분할(쌍 475px)에서 실측상 조작이 얼어붙고 첫 입력이 쌍을 등분으로
 * 튕겼다. 바닥이 물러날 때도 가운데 절반은 travel로 남겨야 조작이 살아 있다.
 */
export const COMPANION_CRAMPED_SLOT_RATIO = 0.25;

/** 키보드로 분할선을 미는 한 걸음. 확대 표면의 분할선과 같은 값이다. */
export const COMPANION_KEYBOARD_STEP_PX = 24;

const PREFS_PREFIX = "fleet-console.canvas.companionWidth.";

type Listener = () => void;

const listeners = new Set<Listener>();
let weights: Readonly<Record<string, number>> = readStoredWeights();

function emit(next: Readonly<Record<string, number>>): void {
  weights = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): Readonly<Record<string, number>> {
  return weights;
}

export function useCompanionSlotWeights(): Readonly<Record<string, number>> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 가중치를 놓는다. 드래그 중에는 포인터가 움직일 때마다 부르므로 값이 같으면 아무것도 하지 않는다 —
 * 같은 값으로 emit하면 프레임마다 캔버스 전체가 다시 그려진다.
 *
 * `persist`는 놓는 순간에만 참이다. 끌고 있는 동안 매 프레임 localStorage에 쓰면 디스크가 아니라
 * 메인 스레드가 값을 치른다.
 */
export function setCompanionSlotWeights(patch: Readonly<Record<string, number>>, persist = false): void {
  let changed = false;
  const next: Record<string, number> = { ...weights };
  for (const [slotId, value] of Object.entries(patch)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (next[slotId] === value) continue;
    next[slotId] = value;
    changed = true;
  }
  if (changed) emit(next);
  if (!persist) return;
  for (const slotId of Object.keys(patch)) {
    const value = next[slotId];
    if (value === undefined) continue;
    try {
      localStorage.setItem(PREFS_PREFIX + slotId, String(value));
    } catch {
      // localStorage 접근 실패는 이번 세션 폭만 잃는다.
    }
  }
}

/** 기억을 지우는 것이 곧 등분으로 되돌리는 것이다 — 기본 가중치는 모두 같기 때문이다. */
export function resetCompanionSlotWeights(slotIds: readonly string[]): void {
  const next: Record<string, number> = { ...weights };
  let changed = false;
  for (const slotId of slotIds) {
    if (slotId in next) {
      delete next[slotId];
      changed = true;
    }
    try {
      localStorage.removeItem(PREFS_PREFIX + slotId);
    } catch {
      // 무시
    }
  }
  if (changed) emit(next);
}

/**
 * 슬롯 목록에 실릴 가중치.
 *
 * 아직 기억이 없는 슬롯은 **이미 놓인 슬롯들의 평균**을 갖고 들어온다. 1을 주면 사용자가 넓혀 둔
 * 이웃 옆에서 새 패널만 실오라기로 서고, 패널을 하나 여는 일이 남의 폭을 뒤집는 일이 된다.
 */
export function companionSlotWeightsFor(
  slotIds: readonly string[],
  stored: Readonly<Record<string, number>>,
): readonly number[] {
  const raw = slotIds.map((slotId) => stored[slotId]);
  const known = raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const fallback = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : 1;
  return raw.map((value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback));
}

/**
 * 가중치를 실제 픽셀로 푼다.
 *
 * 최소폭은 희망이지 물리가 아니다. 모든 슬롯의 바닥을 합쳐도 아레나에 못 담기는 좁은 창에서 바닥을
 * 그대로 지키면 슬롯이 화면 밖으로 밀려난다. 그럴 때는 바닥도 비율을 지키며 함께 물러난다 —
 * 확대 표면의 fitMinimums와 같은 규칙이다.
 *
 * 자리가 있을 때는 그 양보를 하지 않는다. 바닥에 못 미치는 슬롯만 바닥에 고정하고 **남은 폭을
 * 나머지가 비율대로** 나눈다. 바닥까지 올린 뒤 전체를 함께 줄이면, 방금 올린 그 슬롯이 다시
 * 바닥 밑으로 내려가 약속한 하한이 자리가 충분한 창에서도 깨진다.
 */
export function resolveCompanionSlotWidths(arenaWidth: number, slotWeights: readonly number[]): readonly number[] {
  const count = slotWeights.length;
  if (count === 0) return [];
  const content = Math.max(0, arenaWidth - COMPANION_SLOT_GAP_PX * (count - 1));
  if (content <= 0) return slotWeights.map(() => 0);

  const safe = slotWeights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 1));
  const total = safe.reduce((sum, weight) => sum + weight, 0);
  if (content < COMPANION_MIN_SLOT_PX * count) {
    return safe.map((weight) => (content * weight) / total);
  }

  // 바닥에 고정할 슬롯을 굳힌다. 하나를 고정하면 남는 폭이 줄어 다음 슬롯이 바닥 밑으로
  // 내려갈 수 있으므로, 더 고정할 것이 없을 때까지 돈다.
  const pinned = safe.map(() => false);
  for (;;) {
    const freeWidth = content - pinned.filter(Boolean).length * COMPANION_MIN_SLOT_PX;
    const freeWeight = safe.reduce((sum, weight, index) => (pinned[index] ? sum : sum + weight), 0);
    let settled = true;
    for (let index = 0; index < count; index += 1) {
      if (pinned[index]) continue;
      if ((freeWidth * safe[index]!) / freeWeight < COMPANION_MIN_SLOT_PX) {
        pinned[index] = true;
        settled = false;
      }
    }
    if (settled) break;
  }

  const pinnedCount = pinned.filter(Boolean).length;
  if (pinnedCount === count) return safe.map(() => COMPANION_MIN_SLOT_PX);
  const freeWidth = content - pinnedCount * COMPANION_MIN_SLOT_PX;
  const freeWeight = safe.reduce((sum, weight, index) => (pinned[index] ? sum : sum + weight), 0);
  return safe.map((weight, index) => (pinned[index] ? COMPANION_MIN_SLOT_PX : (freeWidth * weight) / freeWeight));
}

function readStoredWeights(): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith(PREFS_PREFIX)) continue;
      const slotId = key.slice(PREFS_PREFIX.length);
      const value = Number(localStorage.getItem(key));
      if (slotId && Number.isFinite(value) && value > 0) result[slotId] = value;
    }
  } catch {
    // localStorage를 못 읽으면 등분으로 시작한다.
  }
  return result;
}
