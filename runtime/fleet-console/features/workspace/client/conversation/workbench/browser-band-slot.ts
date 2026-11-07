import { useSyncExternalStore } from "react";

/**
 * 맨 위 줄의 브라우저 자리 두 곳 — 둘 다 맨 위 줄(.conversation-band) 안에 선다.
 * - 닫기 자리: 머리 줄 도구모음이 지구본 바로 앞에 빈 자리 하나를 세우고, 작업대의 브라우저 칸이 자기 닫기를 그 자리로 portal 한다.
 *   도구모음은 지금 눌러서 브라우저를 닫을 수 있는 지구본이 있는지도 함께 알린다. 없으면(그 대화가 지구본을 세우지 않거나, 브라우저를
 *   못 써서 지구본이 꺼졌으면) 칸이 이 자리에 닫기 단추를 세운다. 도구모음은 한 번에 하나라 이 자리도 하나다.
 * - 주소줄 자리: 맨 위 줄의 지구본 왼쪽 빈 영역 전체(대화 칸 위 포함) — 브라우저 칸이 자기 주소줄을 그 자리의 칸 왼쪽 가장자리부터 portal 한다.
 *   이 자리는 맨 위 줄이 세우므로 대화를 바꿔도 남는다.
 * 브라우저 칸은 머리 없이 대화와 같은 면에 서고, 탭은 이 줄이 아니라 브라우저 본문 왼쪽의 세로 레일이 가진다.
 */

type Listener = () => void;

let slot: HTMLElement | null = null;
let navSlot: HTMLElement | null = null;
let globe = false;
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
  globe = false;
  notify();
}

/** 맨 위 줄이 주소줄 자리 요소를 건넨다. */
export function setBrowserNavSlot(element: HTMLElement): void {
  if (navSlot === element) return;
  navSlot = element;
  notify();
}

/** 맨 위 줄이 떠난다 — 그 요소가 지금 자리일 때만 비운다. */
export function releaseBrowserNavSlot(element: HTMLElement): void {
  if (navSlot !== element) return;
  navSlot = null;
  notify();
}

/** 도구모음에 눌리는 지구본이 있는가. */
export function setBrowserBandGlobe(next: boolean): void {
  if (globe === next) return;
  globe = next;
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBrowserBandSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

export function useBrowserNavSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => navSlot, () => null);
}

export function useBrowserBandGlobe(): boolean {
  return useSyncExternalStore(subscribe, () => globe, () => false);
}
