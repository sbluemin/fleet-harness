import { useSyncExternalStore } from "react";

import { closeGlobalBrowser } from "../../../browser/client/global-browser-store.js";

/**
 * 대화 중심 화면의 오른쪽 분할 칸에 Operation 브라우저가 서 있는가 — 대화 열 오른쪽 칸은 브라우저 하나만 싣는다.
 * Fleet 브라우저(전역 시트)의 열림은 global-browser-store 가 갖고, 이 저장소는 Operation 브라우저 쪽만 갖는다. 둘은 서로를 걷는다.
 *
 * subjectId 는 가운데 칸에 선 대화(묶음의 뿌리), operationId 는 브라우저를 가진 Operation(구성원 본문을 고르면 그 구성원)이다.
 * 가운데 칸의 대상이 바뀌면 칸은 접힌다 — 다른 대화 옆에 앞 대화의 브라우저를 두지 않는다.
 */
export interface OperationBrowserSplit {
  readonly subjectId: string;
  readonly operationId: string;
}

let split: OperationBrowserSplit | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOperationBrowserSplit(): OperationBrowserSplit | null {
  return useSyncExternalStore(subscribe, () => split, () => null);
}

export function openOperationBrowserSplit(next: OperationBrowserSplit): void {
  closeGlobalBrowser();
  if (split?.subjectId === next.subjectId && split.operationId === next.operationId) return;
  split = next;
  notify();
}

export function closeOperationBrowserSplit(): void {
  if (split === null) return;
  split = null;
  notify();
}
