import { useSyncExternalStore } from "react";

// Zen은 현재 창의 표시 오버라이드다. 크롬 선호와 작업 수명은 건드리지 않는다.
// Zen 안에서도 좌측 사이드바를 잠깐 드러낼 수 있다(reveal). 드러냄은 Zen 한 회에 묶인
// 비영속 상태라 진입·종료 때 모두 걷힌다 — 다음 Zen은 다시 크롬 없이 시작한다.
// 오른쪽에는 드러낼 사이드바가 없다 — 도구는 모드와 무관하게 도구모음 하나에 선다.
export interface ZenModeState {
  readonly active: boolean;
  readonly sideBarRevealed: boolean;
}

let state: ZenModeState = { active: false, sideBarRevealed: false };
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
  emit({ active: next, sideBarRevealed: false });
}

/**
 * 사용자가 켜고 끄는 Zen은 전환 장면(커튼·앰블럼)을 거친다. 장면은 크롬이 소유하므로 여기서는
 * 연출기를 끼울 자리만 둔다 — 연출기가 요청을 맡으면(true) 레이아웃 전환 시점도 연출기가 정하고,
 * 없거나 맡지 않으면(동작 줄이기·측정 불가) 곧바로 바꾼다. 경로 이탈·모바일·설정 열기 같은
 * 강제 종료는 이 길을 타지 않고 setZenMode로 즉시 걷는다.
 */
export type ZenTransitionRunner = (next: boolean) => boolean;

let transitionRunner: ZenTransitionRunner | null = null;

export function setZenTransitionRunner(runner: ZenTransitionRunner): () => void {
  transitionRunner = runner;
  return () => {
    if (transitionRunner === runner) transitionRunner = null;
  };
}

/**
 * 창 단계 — 전환 장면이 커튼을 완전히 친 뒤 창을 바꾸고 기다리는 자리. Desktop은 여기서 네이티브 전체화면을
 * 켜고 끄며 셸의 완료 알림을 기다린다(desktop-fullscreen.ts). 창을 바꿀 셸이 없으면(브라우저) 곧바로 끝난다.
 */
export type ZenWindowStage = (next: boolean) => Promise<void>;

let windowStage: ZenWindowStage | null = null;

export function setZenWindowStage(stage: ZenWindowStage): () => void {
  windowStage = stage;
  return () => {
    if (windowStage === stage) windowStage = null;
  };
}

export function runZenWindowStage(next: boolean): Promise<void> {
  return windowStage?.(next) ?? Promise.resolve();
}

export function requestZenMode(next: boolean): void {
  if (state.active === next) return;
  if (transitionRunner?.(next)) return;
  setZenMode(next);
}

export function toggleZenMode(): void {
  requestZenMode(!state.active);
}

export function setZenSideBarRevealed(revealed: boolean): void {
  if (!state.active || state.sideBarRevealed === revealed) return;
  emit({ ...state, sideBarRevealed: revealed });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useZenMode(): boolean {
  return useSyncExternalStore(subscribe, isZenMode, () => false);
}

const INACTIVE: ZenModeState = { active: false, sideBarRevealed: false };

export function useZenModeState(): ZenModeState {
  return useSyncExternalStore(subscribe, getZenModeState, () => INACTIVE);
}
