import type { HostTransport } from "@fleet-console/sdk/host-context";
import { readChatJournalEvent } from "./chat-events.js";
import { EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationJournal } from "./group-timeline.js";

/** 로컬 그룹과 host-bound 대화가 같은 읽기 전용 기록 투영을 사용한다. 이 요청은 재개하지 않는다. */
export async function fetchConversationHistory(operationId: string, signal: AbortSignal, transport?: HostTransport): Promise<ConversationJournal | null> {
  const response = await (transport?.request ?? fetch)(`/api/v1/agent/sessions/${encodeURIComponent(operationId)}/chat-history`, { signal });
  if (!response.ok) return null;
  const payload = await response.json() as { readonly entries?: unknown; readonly truncated?: unknown };
  signal.throwIfAborted();
  transport?.scope.signal.throwIfAborted();
  if (!Array.isArray(payload.entries)) return null;
  let journal = EMPTY_CONVERSATION_JOURNAL;
  for (const entry of payload.entries) {
    const row = readChatJournalEvent(JSON.stringify(entry));
    if (row) journal = reduceConversationJournal(journal, row, operationId);
  }
  return payload.truncated === true ? { ...journal, truncated: true } : journal;
}
