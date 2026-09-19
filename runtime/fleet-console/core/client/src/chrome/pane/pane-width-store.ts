import { useSyncExternalStore } from "react";

/**
 * 페인 열의 폭 — 표면이 소유한다.
 *
 * 페인은 자기 폭을 지시하지 못한다(계약). 그래서 분할선이 만든 폭은 서술자도 본문도 아닌
 * 여기에 산다. 키는 페인 id다: 같은 페인은 어느 Theater에서 열리든 같은 폭으로 선다 —
 * 사용자가 "파일 트리를 이 정도로" 정한 것은 문서가 아니라 그 열에 대한 결정이기 때문이다.
 */

const PREFS_PREFIX = "fleet-console.pane.width.";

type Listener = () => void;

const listeners = new Set<Listener>();
let widths: Readonly<Record<string, number>> = readStoredWidths();

function emit(next: Readonly<Record<string, number>>): void {
  widths = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): Readonly<Record<string, number>> {
  return widths;
}

export function getStoredPaneWidth(paneId: string): number | undefined {
  return widths[paneId];
}

/**
 * 폭을 기억한다. 드래그 중에도 매 프레임 부르므로 값이 같으면 아무것도 하지 않는다 —
 * 같은 값으로 emit하면 표면 전체가 프레임마다 다시 그려진다.
 */
export function setPaneWidth(paneId: string, width: number): void {
  const next = Math.max(0, Math.round(width));
  if (widths[paneId] === next) return;
  emit({ ...widths, [paneId]: next });
  try {
    localStorage.setItem(PREFS_PREFIX + paneId, String(next));
  } catch {
    // localStorage 접근 실패는 이번 세션 폭만 잃는다.
  }
}

export function clearPaneWidth(paneId: string): void {
  if (widths[paneId] === undefined) return;
  const next = { ...widths };
  delete next[paneId];
  emit(next);
  try {
    localStorage.removeItem(PREFS_PREFIX + paneId);
  } catch {
    // 무시
  }
}

export function usePaneWidths(): Readonly<Record<string, number>> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function readStoredWidths(): Readonly<Record<string, number>> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith(PREFS_PREFIX)) continue;
      const paneId = key.slice(PREFS_PREFIX.length);
      const value = Number(localStorage.getItem(key));
      if (paneId && Number.isFinite(value) && value > 0) result[paneId] = Math.round(value);
    }
  } catch {
    // localStorage를 못 읽으면 서술자 기본값으로 시작한다.
  }
  return result;
}

/** 테스트 전용 — 모듈 스코프 상태를 초기화한다. */
export function __resetPaneWidthsForTests(): void {
  widths = Object.create(null) as Record<string, number>;
}
