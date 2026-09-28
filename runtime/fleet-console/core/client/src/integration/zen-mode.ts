import { useSyncExternalStore } from "react";

// Zen은 현재 창의 표시 오버라이드다. 크롬 선호와 작업 수명은 건드리지 않는다.
// Zen 안에서도 좌측 사이드바를 잠깐 드러낼 수 있다(reveal). 드러냄은 Zen 한 회에 묶인
// 비영속 상태라 진입·종료 때 모두 걷힌다 — 다음 Zen은 다시 크롬 없이 시작한다.
// 오른쪽에는 드러낼 사이드바가 없다 — 도구는 모드와 무관하게 도구모음 하나에 선다.
export interface ZenModeState {
  readonly active: boolean;
  readonly sideBarRevealed: boolean;
}

/**
 * 호스트 전환은 다른 origin으로의 문서 이동이라 이 모듈의 상태가 따라가지 못한다. 떠나는 화면이 모드를
 * 쿼리로 실어 보내고, 새 문서는 첫 렌더 전에 읽어 Zen으로 시작한 뒤 주소에서 지운다. 값은 화면 모드뿐이다.
 */
export const ZEN_MODE_PARAM = "mode";
const ZEN_MODE_VALUE = "zen";

/** 전환 목적지 URL에 지금 모드를 싣는다. 일반 모드면 아무것도 싣지 않는다. */
export function carryZenMode(url: URL, zen: boolean = state.active): URL {
  if (zen) url.searchParams.set(ZEN_MODE_PARAM, ZEN_MODE_VALUE);
  return url;
}

export function carriesZenMode(search: string): boolean {
  return new URLSearchParams(search).get(ZEN_MODE_PARAM) === ZEN_MODE_VALUE;
}

/** 새 문서가 실려 온 모드를 주소에서 지운다 — 새로 고침이 모드를 다시 켜지 않게. */
export function consumeInitialZenModeParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ZEN_MODE_PARAM)) return;
  url.searchParams.delete(ZEN_MODE_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

let state: ZenModeState = { active: typeof window !== "undefined" && carriesZenMode(window.location.search), sideBarRevealed: false };
const listeners = new Set<() => void>();
let transitionActive = false;

/** 크롬 장면 동안 안내를 미루는 조합 신호. 기능은 Zen DOM 속성을 직접 찾지 않는다. */
export function setZenTransitionActive(active: boolean): void {
  if (transitionActive === active) return;
  transitionActive = active;
  for (const listener of listeners) listener();
}
export function useZenTransitionActive(): boolean {
  return useSyncExternalStore(subscribeZenMode, () => transitionActive, () => false);
}

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
export interface ZenTransitionActions {
  readonly onLayout?: () => void;
  readonly onComplete?: () => void;
}
export type ZenTransitionRunner = (next: boolean, actions?: ZenTransitionActions) => boolean;

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

export function requestZenMode(next: boolean, actions?: ZenTransitionActions): void {
  if (state.active === next) return;
  if (transitionRunner?.(next, actions)) return;
  setZenMode(next);
  actions?.onLayout?.();
  actions?.onComplete?.();
}

export function toggleZenMode(): void {
  requestZenMode(!state.active);
}

export function setZenSideBarRevealed(revealed: boolean): void {
  if (!state.active || state.sideBarRevealed === revealed) return;
  emit({ ...state, sideBarRevealed: revealed });
}

export function subscribeZenMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useZenMode(): boolean {
  return useSyncExternalStore(subscribeZenMode, isZenMode, () => false);
}

const INACTIVE: ZenModeState = { active: false, sideBarRevealed: false };

export function useZenModeState(): ZenModeState {
  return useSyncExternalStore(subscribeZenMode, getZenModeState, () => INACTIVE);
}
