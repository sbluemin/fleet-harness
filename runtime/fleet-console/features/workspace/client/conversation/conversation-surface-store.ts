import { useSyncExternalStore } from "react";

import { isConversationLayoutActive, subscribeConversationLayout } from "../../../settings/client/use-conversation-layout.js";

/**
 * 가운데 칸에 선 플러그인 대화(예: 사령관). 없으면 칸은 Operation 대화를 보인다. 호스트 번들 안의 상태이고, 플러그인은
 * SDK 능력(`ctx.conversation`)으로만 여닫는다. 대화 중심 화면이 꺼지면 걷힌다 — 다시 켰을 때 묵은 대화가 서지 않게.
 */
export interface ConversationSurfaceSelection {
  readonly surfaceId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** 같은 대화를 다시 열 때도 표면이 새 요청(예: 다른 턴 위치)을 알 수 있게 오른다. */
  readonly nonce: number;
}

let selection: ConversationSurfaceSelection | null = null;
let nonce = 0;
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
  if (!isConversationLayoutActive()) return false;
  nonce += 1;
  selection = { surfaceId, params, nonce };
  emit();
  return true;
}

export function closeConversationSurface(surfaceId?: string): void {
  if (selection === null || (surfaceId !== undefined && selection.surfaceId !== surfaceId)) return;
  selection = null;
  emit();
}

// 배치가 꺼지면 선 대화를 걷는다.
subscribeConversationLayout(() => {
  if (selection !== null && !isConversationLayoutActive()) {
    selection = null;
    emit();
  }
});
