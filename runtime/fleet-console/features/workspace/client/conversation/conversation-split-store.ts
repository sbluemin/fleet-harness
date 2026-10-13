import { useSyncExternalStore } from "react";

import { closeGlobalBrowser } from "../../../browser/client/global-browser-store.js";

/**
 * 대화 중심 화면의 오른쪽 분할 칸에 Session 브라우저가 서 있는가 — 대화 열 오른쪽 칸은 브라우저 하나만 싣는다.
 * Fleet 브라우저(전역 시트)의 열림은 global-browser-store 가 갖고, 이 저장소는 Session 브라우저 쪽만 갖는다. 셋은 서로를 걷는다.
 * Session 브라우저는 둘 중 하나다: Operation 대화의 companion(OperationBrowserSplit), 또는 사령관 같은 플러그인 대화의 에이전트
 * 세션이 쓰는 브라우저(SessionBrowserSplit — 호스트가 owner 로 찾아 그린다).
 *
 * subjectId 는 가운데 칸에 선 대화(묶음의 뿌리), operationId 는 브라우저를 가진 Operation(구성원 본문을 고르면 그 구성원)이다.
 * 가운데 칸의 대상이 바뀌면 칸은 접힌다 — 다른 대화 옆에 앞 대화의 브라우저를 두지 않는다.
 */
export interface OperationBrowserSplit {
  readonly subjectId: string;
  readonly operationId: string;
}

/** 플러그인 대화의 Session 브라우저 — subjectKey 는 그 대화의 세션 scope(`<pluginId>:<scopeId>`), ownerId 는 서버가 내준 브라우저 owner 다. */
export interface SessionBrowserSplit {
  readonly subjectKey: string;
  readonly ownerId: string;
}

let split: OperationBrowserSplit | null = null;
let sessionSplit: SessionBrowserSplit | null = null;
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
  closeSessionBrowserSplit();
  if (split?.subjectId === next.subjectId && split.operationId === next.operationId) return;
  split = next;
  notify();
}

export function closeOperationBrowserSplit(): void {
  if (split === null) return;
  split = null;
  notify();
}

export function useSessionBrowserSplit(): SessionBrowserSplit | null {
  return useSyncExternalStore(subscribe, () => sessionSplit, () => null);
}

export function openSessionBrowserSplit(next: SessionBrowserSplit): void {
  closeGlobalBrowser();
  closeOperationBrowserSplit();
  if (sessionSplit?.subjectKey === next.subjectKey && sessionSplit.ownerId === next.ownerId) return;
  sessionSplit = next;
  notify();
}

export function closeSessionBrowserSplit(): void {
  if (sessionSplit === null) return;
  sessionSplit = null;
  notify();
}
