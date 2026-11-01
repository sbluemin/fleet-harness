import { useSyncExternalStore } from "react";

/**
 * 설정 › 실험의 태스크포스 행을 가리키는 작은 신호.
 *
 * 태스크포스 소개 카드의 링크는 카드를 닫고 설정 표면을 연 뒤 이 행을 두 번 반짝인다.
 * 켜기는 사용자가 토글로 직접 한다. 숨은 교차 계층 조회 없이, 이 명시적 포트로만
 * 전달된다 — 소개 카드(호스트)가 요청하고 실험 섹션(행)이 소비한다.
 */

let highlightToken = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 행을 두 번 반짝이라고 요청한다 — 설정 표면이 열리는 앞뒤 어디서든 부를 수 있다. */
export function requestTaskforceRowHighlight(): void {
  highlightToken += 1;
  emit();
}

/** 대기 중인 요청을 꺼내 쓴다 — 같은 토큰을 두 번 쓰지 않으므로 0을 돌려주며 지운다. */
export function takeTaskforceRowHighlight(): number {
  const pending = highlightToken;
  if (pending !== 0) {
    highlightToken = 0;
    emit();
  }
  return pending;
}

/** 실험 섹션의 행이 읽는 요청 토큰 — 0이 아니면 반짝일 차례다. */
export function useTaskforceRowHighlight(): number {
  return useSyncExternalStore(subscribe, () => highlightToken, () => highlightToken);
}
