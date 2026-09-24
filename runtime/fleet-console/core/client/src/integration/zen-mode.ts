import { useSyncExternalStore } from "react";

// Zen은 현재 창의 표시 오버라이드다. 크롬 선호와 작업 수명은 건드리지 않는다.
// Zen 안에서도 좌우 사이드바를 잠깐 드러낼 수 있다(reveal). 드러냄은 Zen 한 회에 묶인
// 비영속 상태라 진입·종료 때 모두 걷힌다 — 다음 Zen은 다시 크롬 없이 시작한다.
export interface ZenModeState {
  readonly active: boolean;
  readonly sideBarRevealed: boolean;
  readonly railRevealed: boolean;
}

let state: ZenModeState = { active: false, sideBarRevealed: false, railRevealed: false };
const listeners = new Set<() => void>();

function emit(next: ZenModeState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function isZenMode(): boolean {
  return state.active;
}

export function getZenModeState(): ZenModeState {
  return state;
}

export function setZenMode(next: boolean): void {
  if (state.active === next) return;
  emit({ active: next, sideBarRevealed: false, railRevealed: false });
}

export function toggleZenMode(): void {
  setZenMode(!state.active);
}

export function setZenSideBarRevealed(revealed: boolean): void {
  if (!state.active || state.sideBarRevealed === revealed) return;
  emit({ ...state, sideBarRevealed: revealed });
}

export function setZenRailRevealed(revealed: boolean): void {
  if (!state.active || state.railRevealed === revealed) return;
  emit({ ...state, railRevealed: revealed });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useZenMode(): boolean {
  return useSyncExternalStore(subscribe, isZenMode, () => false);
}

const INACTIVE: ZenModeState = { active: false, sideBarRevealed: false, railRevealed: false };

export function useZenModeState(): ZenModeState {
  return useSyncExternalStore(subscribe, getZenModeState, () => INACTIVE);
}
