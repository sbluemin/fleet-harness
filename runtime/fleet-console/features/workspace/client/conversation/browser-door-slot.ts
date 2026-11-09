import * as React from "react";

/**
 * 플릿 브라우저 문(지구본)이 서는 자리 — 오른쪽 세부 정보 머리의 닫기 X 바로 왼쪽.
 * 머리가 서 있는 동안만 자리가 있고, 없으면(오른쪽 사이드바가 닫힘) 문은 대화 머리의 도구 묶음에 그대로 선다.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function publish(next: HTMLElement | null): void {
  if (slot === next) return;
  slot = next;
  for (const listener of listeners) listener();
}

export function setBrowserDoorSlot(element: HTMLElement): void { publish(element); }
export function releaseBrowserDoorSlot(element: HTMLElement): void { if (slot === element) publish(null); }

export function useBrowserDoorSlot(): HTMLElement | null {
  return React.useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => slot,
    () => null,
  );
}
