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

// ── 칸의 폭 ──────────────────────────────────────────────────────────────────
// 사람이 경계를 끌어 고른 브라우저 칸 폭(px) — 세 브라우저(Fleet · Operation · 플러그인 세션)가 같은 값을 쓴다. 뷰어별 편의 상태라
// 이 브라우저의 localStorage 에만 둔다. null 은 「고른 적 없음」 — 칸이 남은 폭을 반씩 나눈다. 저장한 값은 그대로 두고 그리는 쪽이
// 창 폭에 맞춰 clamp 하므로, 창이 좁아졌다 다시 넓어지면 고른 폭으로 돌아온다.
const SPLIT_WIDTH_KEY = "fleet-console.conversation.splitWidth";
let splitWidth: number | null | undefined;

function readStoredSplitWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(SPLIT_WIDTH_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function currentSplitWidth(): number | null {
  if (splitWidth === undefined) splitWidth = typeof window === "undefined" ? null : readStoredSplitWidth();
  return splitWidth;
}

export function useConversationSplitWidth(): number | null {
  return useSyncExternalStore(subscribe, currentSplitWidth, () => null);
}

/** 칸 폭을 바꾼다. 끄는 동안에는 persist 없이 따라가고, 놓을 때(또는 키보드 한 걸음마다) 기억한다. null 은 기억을 지운다. */
export function setConversationSplitWidth(width: number | null, options: { readonly persist?: boolean } = {}): void {
  const next = width === null ? null : Math.round(width);
  if (next !== currentSplitWidth()) {
    splitWidth = next;
    notify();
  }
  if (!options.persist) return;
  try {
    if (next === null) window.localStorage.removeItem(SPLIT_WIDTH_KEY);
    else window.localStorage.setItem(SPLIT_WIDTH_KEY, String(next));
  } catch {
    // 기억하지 못해도 이번 화면의 폭은 선다.
  }
}
