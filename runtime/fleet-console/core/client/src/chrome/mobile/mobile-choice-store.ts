import { useSyncExternalStore } from "react";

import type { MobileChoiceSpec } from "@fleet-console/sdk/settings/browser";

/**
 * 설정의 선택 팝업 상태. 한 번에 하나만 열린다 — 열린 동안 다시 열면 앞의 것을 바꾼다.
 * `anchor`는 연 컨트롤의 자리다 — 스펙이 주면 그것을, 아니면 지금 초점이 있는 요소를 쓴다.
 */
export interface MobileChoiceState {
  readonly spec: MobileChoiceSpec;
  readonly anchor: { readonly top: number; readonly bottom: number } | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: MobileChoiceState | null = null;

function emit(): void { for (const listener of listeners) listener(); }
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMobileChoice(): MobileChoiceState | null {
  return useSyncExternalStore(subscribe, () => current);
}

export function openMobileChoice(spec: MobileChoiceSpec): void {
  const opener = spec.anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement.getBoundingClientRect() : null);
  current = { spec, anchor: opener && opener.bottom - opener.top > 0 ? { top: opener.top, bottom: opener.bottom } : null };
  emit();
}

export function closeMobileChoice(): void {
  if (current === null) return;
  current = null;
  emit();
}
