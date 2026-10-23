import { useSyncExternalStore } from "react";

import { getViewModeSnapshot, subscribeViewMode } from "../../../../core/client/src/integration/view-mode-store.js";

/**
 * 가운데 칸에 선 플러그인 대화(예: 사령관). 없으면 칸은 Objective 대화를 보인다. 호스트 번들 안의 상태이고, 플러그인은
 * SDK 능력(`ctx.conversation`)으로만 여닫는다. 모바일로 바뀌면 걷힌다 — 데스크톱으로 돌아왔을 때 묵은 대화가 서지 않게.
 */
export interface ConversationSurfaceSelection {
  readonly surfaceId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** 같은 대화를 다시 열 때도 표면이 새 요청(예: 다른 턴 위치)을 알 수 있게 오른다. */
  readonly nonce: number;
}

let selection: ConversationSurfaceSelection | null = null;
let nonce = 0;
let layoutPort: { readonly onLeaveDesktop: (surface: ConversationSurfaceSelection) => void } | null = null;

/** 레지스트리와 활성 패널을 아는 호스트 합성이 배치 전환을 잇는다. 표면 저장소는 플러그인 구현을 조회하지 않는다. */
export function bindConversationSurfaceLayout(port: NonNullable<typeof layoutPort>): void {
  layoutPort = port;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeConversationSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getConversationSurface(): ConversationSurfaceSelection | null {
  return selection;
}

export function useConversationSurface(): ConversationSurfaceSelection | null {
  return useSyncExternalStore(subscribeConversationSurface, getConversationSurface, () => null);
}

export function openConversationSurface(surfaceId: string, params: Readonly<Record<string, unknown>> = {}): boolean {
  if (getViewModeSnapshot().effective !== "desktop") return false;
  nonce += 1;
  selection = { surfaceId, params, nonce };
  watchLayout();
  emit();
  return true;
}

export function closeConversationSurface(surfaceId?: string): void {
  if (selection === null || (surfaceId !== undefined && selection.surfaceId !== surfaceId)) return;
  clear();
}

function clear(): void {
  selection = null;
  disposeLayoutWatch?.();
  disposeLayoutWatch = null;
  emit();
}

// 모바일로 바뀌면 선 대화를 걷는다. 대화가 서 있는 동안만 지켜본다 — 모듈을 읽는 것만으로 설정 저장소를 구독하지 않는다.
let disposeLayoutWatch: (() => void) | null = null;

function watchLayout(): void {
  if (disposeLayoutWatch) return;
  disposeLayoutWatch = subscribeViewMode(() => {
    if (selection === null || getViewModeSnapshot().effective === "desktop") return;
    try { layoutPort?.onLeaveDesktop(selection); }
    catch { /* 플러그인 착지가 실패해도 데스크톱 표면은 걷는다. */ }
    clear();
  });
}
