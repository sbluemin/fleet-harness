import { useSyncExternalStore } from "react";

// Zen은 현재 창의 표시 오버라이드다. 크롬 선호와 작업 수명은 건드리지 않는다.
let active = false;
const listeners = new Set<() => void>();

export function isZenMode(): boolean {
  return active;
}

export function setZenMode(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

export function toggleZenMode(): void {
  setZenMode(!active);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useZenMode(): boolean {
  return useSyncExternalStore(subscribe, isZenMode, () => false);
}
