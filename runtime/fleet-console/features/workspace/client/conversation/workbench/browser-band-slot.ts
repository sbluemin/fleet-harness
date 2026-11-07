import { useSyncExternalStore } from "react";

/**
 * 맨 위 줄의 브라우저 자리 — 머리 줄 도구모음이 지구본 바로 앞에 빈 자리 하나를 세우고, 작업대의 브라우저 칸이 자기 탭 줄을
 * 그 자리로 portal 한다. 브라우저 칸은 머리 없이 대화와 같은 면에 서고, 탭 줄은 지구본 옆에서 이어진다.
 *
 * 자리는 한 번에 하나다 — 가운데 칸은 도구모음을 하나만 세운다.
 */

type Listener = () => void;

let slot: HTMLElement | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 도구모음이 자리 요소를 건넨다. */
export function setBrowserBandSlot(element: HTMLElement): void {
  if (slot === element) return;
  slot = element;
  notify();
}

/** 도구모음이 떠난다 — 그 요소가 지금 자리일 때만 비운다(새 도구모음이 먼저 자리를 잡았을 수 있다). */
export function releaseBrowserBandSlot(element: HTMLElement): void {
  if (slot !== element) return;
  slot = null;
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBrowserBandSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
