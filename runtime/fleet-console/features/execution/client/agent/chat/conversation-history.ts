import type { HostTransport } from "@fleet-console/sdk/host-context";
import { readChatJournalEvent } from "./chat-events.js";
import { EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationJournal, type ConversationSnapshot } from "../../../conversation-journal.js";

export interface ConversationHistory {
  readonly journal: ConversationJournal;
  /** null인 휴면 transcript의 재번호 seq는 WS cursor와 비교하지 않는다. */
  readonly live: ConversationSnapshot | null;
}

/** 읽기는 세션을 만들거나 재개하지 않는다. 활성 원장의 cursor만 WS와 같은 축이다. */
export async function fetchConversationSnapshot(operationId: string, signal: AbortSignal, transport?: HostTransport): Promise<ConversationHistory | null> {
  const response = await (transport?.request ?? fetch)(`/api/v1/agent/sessions/${encodeURIComponent(operationId)}/chat-history`, { signal });
  if (!response.ok) return null;
  const payload = await response.json() as { readonly entries?: unknown; readonly truncated?: unknown; readonly conversation?: ConversationSnapshot };
  signal.throwIfAborted();
  transport?.scope.signal.throwIfAborted();
  const live = payload.conversation;
  if (live !== undefined) {
    if (!live || typeof live.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(live.generation) || !Number.isSafeInteger(live.cursor) || live.cursor < 0
      || !live.journal || !Array.isArray(live.journal.entries) || live.journal.entries.length > 600 || typeof live.journal.truncated !== "boolean") throw new Error("invalid_conversation_snapshot");
    return { journal: live.journal, live };
  }
  if (!Array.isArray(payload.entries)) return null;
  let journal = EMPTY_CONVERSATION_JOURNAL;
  for (const entry of payload.entries) {
    const row = readChatJournalEvent(JSON.stringify(entry));
    if (row) journal = reduceConversationJournal(journal, row, operationId);
  }
  return { journal: payload.truncated === true ? { ...journal, truncated: true } : journal, live: null };
}

/** 기존 로컬 그룹 소비자는 좌표 메타데이터 없이 같은 표시 원장을 읽는다. */
export async function fetchConversationHistory(operationId: string, signal: AbortSignal, transport?: HostTransport): Promise<ConversationJournal | null> {
  return (await fetchConversationSnapshot(operationId, signal, transport))?.journal ?? null;
}
