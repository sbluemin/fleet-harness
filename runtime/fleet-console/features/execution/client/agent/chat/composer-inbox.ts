/**
 * 채팅 컴포저 수신함 — 다른 패널(Operation Browser)이 "이 Operation 의 입력창에 이 이미지를 붙여넣어 달라"고
 * 맡기는 자리. 컴포저는 마운트되어 있으면 즉시 꺼내 붙여넣기와 같은 길(업로드 → 칩)로 세우고, 접혀 있으면
 * 다음 마운트에서 꺼낸다. 대화 중심 화면의 그룹 입력창처럼 그 Operation 의 입력을 대신 받는 입력창은 `claimComposerInbox`
 * 로 자리를 쥔다. 보내는 일은 하지 않는다 — 발사는 언제나 사람의 Enter 다.
 */

export interface ComposerInboxEntry {
  readonly files: readonly File[];
}

const pending = new Map<string, ComposerInboxEntry[]>();
const listeners = new Map<string, Set<() => void>>();
const claims = new Map<string, Array<(entry: ComposerInboxEntry) => void>>();

export function pushComposerInbox(operationId: string, entry: ComposerInboxEntry): void {
  // 이 Operation 의 입력창 자리를 다른 입력창이 쥐고 있으면(대화 중심 화면의 그룹 입력창) 그쪽이 받는다 — 주차된 원장 채팅의
  // 컴포저는 화면에 없으므로 거기에 쌓지 않는다.
  const stack = claims.get(operationId);
  const claim = stack?.[stack.length - 1];
  if (claim) { claim(entry); return; }
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

/**
 * 이 Operation 의 입력창 자리를 쥔다 — 쥔 동안 맡겨진 첨부는 줄을 서지 않고 곧장 `receive` 로 간다(나중에 쥔 쪽이 먼저다).
 * 쥘 때 이미 쌓여 있던 것도 꺼내 준다. 돌려준 함수로 놓는다.
 */
export function claimComposerInbox(operationId: string, receive: (entry: ComposerInboxEntry) => void): () => void {
  const stack = claims.get(operationId) ?? [];
  stack.push(receive);
  claims.set(operationId, stack);
  for (const entry of drainComposerInbox(operationId)) receive(entry);
  return () => {
    const index = stack.lastIndexOf(receive);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0 && claims.get(operationId) === stack) claims.delete(operationId);
  };
}
