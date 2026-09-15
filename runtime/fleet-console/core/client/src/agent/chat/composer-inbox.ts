/**
 * 채팅 컴포저 수신함 — 다른 패널(Operation Browser)이 "이 Operation 의 입력창에 이 이미지를 붙여넣어 달라"고
 * 맡기는 자리. 컴포저는 마운트되어 있으면 즉시 꺼내 붙여넣기와 같은 길(업로드 → 칩)로 세우고, 접혀 있으면
 * 다음 마운트에서 꺼낸다. 보내는 일은 하지 않는다 — 발사는 언제나 사람의 Enter 다.
 */

export interface ComposerInboxEntry {
  readonly files: readonly File[];
}

const pending = new Map<string, ComposerInboxEntry[]>();
const listeners = new Map<string, Set<() => void>>();

export function pushComposerInbox(operationId: string, entry: ComposerInboxEntry): void {
  const queue = pending.get(operationId) ?? [];
  queue.push(entry);
  pending.set(operationId, queue);
  for (const listener of listeners.get(operationId) ?? []) listener();
}

export function drainComposerInbox(operationId: string): ComposerInboxEntry[] {
  const queue = pending.get(operationId) ?? [];
  pending.delete(operationId);
  return queue;
}

export function subscribeComposerInbox(operationId: string, listener: () => void): () => void {
  const set = listeners.get(operationId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(operationId, set);
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(operationId); };
}
