import { useSyncExternalStore } from "react";

import type { ClientTheaterInboxCapability, TheaterInboxAddress, TheaterInboxFocusRequest, TheaterInboxOpenRequest, TheaterInboxSnapshot } from "@fleet-console/sdk/theater-inbox";

/**
 * Theater Inbox 의 열린 상태 — Theater 하나, 주소 하나, 닫힐 때 포커스를 돌려줄 입구 하나.
 *
 * 시트는 활성 Theater 를 따라가지 않는다. 연 Theater 를 고정하고, 다른 Theater 의 입구가 열면 그 Theater 로 바뀐다.
 * 입구(사이드바 줄·메뉴)에서 연 경우만 opener 를 바꾸고, 시트 안 이동은 처음 입구를 지킨다.
 */
export interface TheaterInboxOpenState extends TheaterInboxSnapshot {
  readonly opener: HTMLElement | null;
  readonly focusRequest: TheaterInboxFocusRequest | null;
}

let state: TheaterInboxOpenState | null = null;
let snapshot: TheaterInboxSnapshot | null = null;
let focusNonce = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function sameAddress(left: TheaterInboxAddress, right: TheaterInboxAddress): boolean {
  return left.sectionId === right.sectionId && left.pageId === right.pageId;
}

export function openTheaterInbox(request: TheaterInboxOpenRequest): void {
  const address = { sectionId: request.sectionId, pageId: request.pageId };
  const focusRequest = { nonce: ++focusNonce, kind: request.focus ?? "default" } as const;
  const opener = request.returnFocus !== undefined ? request.returnFocus : state?.opener ?? null;
  const theaterChanged = state?.theaterId !== request.theaterId;
  state = { theaterId: request.theaterId, address, opener, focusRequest };
  if (theaterChanged || !snapshot || !sameAddress(snapshot.address, address)) snapshot = { theaterId: request.theaterId, address };
  emit();
}

/** 시트 안 목록에서 칸을 고른다 — 주소만 바꾸고 포커스 요청은 그대로 둔다(포커스는 목록에 남는다). */
export function selectTheaterInboxPage(address: TheaterInboxAddress): void {
  if (!state || sameAddress(state.address, address)) return;
  state = { ...state, address, focusRequest: null };
  snapshot = { theaterId: state.theaterId, address };
  emit();
}

export function closeTheaterInbox(): void {
  if (!state) return;
  state = null;
  snapshot = null;
  emit();
}

export function readTheaterInbox(): TheaterInboxSnapshot | null {
  return snapshot;
}

export function readTheaterInboxState(): TheaterInboxOpenState | null {
  return state;
}

export function subscribeTheaterInbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTheaterInboxState(): TheaterInboxOpenState | null {
  return useSyncExternalStore(subscribeTheaterInbox, readTheaterInboxState, readTheaterInboxState);
}

/** 플러그인과 호스트가 같은 시트를 쓰는 유일한 길. 모듈 상태를 플러그인 번들에 내보내지 않고 이 함수 객체로 주입한다. */
export const theaterInboxCapability: ClientTheaterInboxCapability = {
  open: openTheaterInbox,
  close: closeTheaterInbox,
  read: readTheaterInbox,
  subscribe: subscribeTheaterInbox,
};

/**
 * 닫을 때 입구가 사라졌으면 포커스를 돌려줄 자리 — Theater 마다 그 머리. 사이드바(workspace)가 명시적으로 등록하고 시트는 이것만
 * 읽는다. 머리가 접혀 기여 줄이 내려가도 등록은 남기고, 찾는 쪽이 아직 문서에 붙어 있는지 본다.
 */
const returnTargets = new Map<string, () => HTMLElement | null>();

export function registerTheaterInboxReturnTarget(theaterId: string, resolve: () => HTMLElement | null): void {
  returnTargets.set(theaterId, resolve);
}

export function theaterInboxReturnTarget(theaterId: string): HTMLElement | null {
  const target = returnTargets.get(theaterId)?.() ?? null;
  return target?.isConnected ? target : null;
}

/**
 * Inbox 「Theater 설정」 맨 아래의 「Theater 잊기…」가 부르는 길 — 사이드바 메뉴의 같은 항목과 같은 지연 삭제(되돌리기 토스트)다.
 * 그 동작의 주인(Operations 화면)이 등록하고, 없으면 시트는 줄을 세우지 않는다.
 */
let forgetTheater: ((theaterId: string) => void) | null = null;

export function registerTheaterInboxForget(handler: (theaterId: string) => void): () => void {
  forgetTheater = handler;
  emit();
  return () => {
    if (forgetTheater !== handler) return;
    forgetTheater = null;
    emit();
  };
}

export function readTheaterInboxForget(): ((theaterId: string) => void) | null {
  return forgetTheater;
}
