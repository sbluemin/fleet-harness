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

/** 다른 Theater의 도구로 착지할 때 문맥만 세운다 — Inbox 칸으로 포커스를 옮기지는 않는다. */
export function setTheaterInboxContext(context: TheaterInboxSnapshot): void {
  state = { ...context, opener: null, focusRequest: null };
  snapshot = context;
  emit();
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
