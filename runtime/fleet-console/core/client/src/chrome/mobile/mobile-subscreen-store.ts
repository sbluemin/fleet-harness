import { useSyncExternalStore, type ReactNode } from "react";

import type { MobileSubScreenSpec } from "@fleet-console/sdk/settings/browser";

/**
 * 설정 하위 화면 스택. 섹션 화면 위에 한 단씩 쌓이고, 위 막대의 ‹·뒤로가 맨 위를 걷는다.
 * `render`는 호스트가 그릴 때마다 다시 불린다 — 안의 스토어 훅이 값을 살려 둔다.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let stack: readonly MobileSubScreenSpec[] = [];

function emit(): void { for (const listener of listeners) listener(); }
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMobileSubScreens(): readonly MobileSubScreenSpec[] {
  return useSyncExternalStore(subscribe, () => stack);
}

export function openMobileSubScreen(spec: MobileSubScreenSpec): void {
  stack = [...stack, spec];
  emit();
}

export function popMobileSubScreen(): void {
  if (stack.length === 0) return;
  stack = stack.slice(0, -1);
  emit();
}

export function clearMobileSubScreens(): void {
  if (stack.length === 0) return;
  stack = [];
  emit();
}

export type { ReactNode };
