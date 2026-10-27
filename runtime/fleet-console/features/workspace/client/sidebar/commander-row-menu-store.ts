import { useSyncExternalStore } from "react";

import type { SideBarRowItem } from "./side-bar-cluster-row.js";

/** 사이드바 목록·채팅 안 목록·고스트 얼굴이 같은 지휘관 행 메뉴를 연다. */
export interface CommanderRowMenuRequest {
  readonly item: SideBarRowItem;
  readonly anchor: DOMRect;
  readonly returnFocus: HTMLElement | null;
}

let request: CommanderRowMenuRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openCommanderRowMenu(next: CommanderRowMenuRequest): void {
  request = next;
  emit();
}

export function closeCommanderRowMenu(): void {
  if (request === null) return;
  request = null;
  emit();
}

export function commanderRowMenuIsOpen(): boolean {
  return request !== null;
}

export function useCommanderRowMenuRequest(): CommanderRowMenuRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request,
    () => null,
  );
}
