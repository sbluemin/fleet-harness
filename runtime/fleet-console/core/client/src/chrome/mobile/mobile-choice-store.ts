import { useSyncExternalStore } from "react";

import type { MobileChoiceOption, MobileChoiceSpec } from "@fleet-console/sdk/settings/browser";

/**
 * 설정의 선택 팝업 상태(P-1). 한 번에 하나만 열린다 — 열린 동안 다시 열면 앞의 것을 바꾼다.
 * 호스트 안(코어 행)에서 부를 때는 옵션에 `previewSize`(그 배율로 라벨을 그리는 미리보기)를 더할 수 있다.
 */
export interface HostChoiceOption extends MobileChoiceOption {
  /** 라벨 글자 크기(px). 글자 크기 팝업이 각 행을 그 배율로 그려 미리보기를 겸한다. */
  readonly previewSize?: number;
}

export interface HostChoiceSpec extends Omit<MobileChoiceSpec, "options" | "onSelect"> {
  readonly options: readonly HostChoiceOption[];
  /** 거절(reject)되면 저장 실패로 보고 토스트를 띄운다 — 값은 호출한 쪽의 상태가 정본이라 그대로 되돌아간다. */
  readonly onSelect: (value: string) => void | Promise<unknown>;
}

export interface MobileChoiceState {
  readonly spec: HostChoiceSpec;
  /** 팝업을 연 요소 — 닫으면 초점이 그리로 돌아간다. */
  readonly opener: HTMLElement | null;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: MobileChoiceState | null = null;

function emit(): void { for (const listener of listeners) listener(); }
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isMobileChoiceOpen(): boolean { return current !== null; }

export function useMobileChoice(): MobileChoiceState | null {
  return useSyncExternalStore(subscribe, () => current);
}

export function openMobileChoice(spec: HostChoiceSpec | MobileChoiceSpec): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  current = { spec: spec as HostChoiceSpec, opener };
  emit();
}

export function closeMobileChoice(): void {
  if (current === null) return;
  const { opener } = current;
  current = null;
  emit();
  opener?.focus?.({ preventScroll: true });
}
