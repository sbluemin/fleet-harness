import type { ConversationSpeaker, GroupTimelineEntry } from "@fleet-console/sdk/conversation";
import type { AgentChatJournalEvent } from "./host/agent/chat-events.js";

// 표시용 첨부는 서버의 좌표뿐 아니라 기존 클라이언트의 검증된 reference 표현도 받는다.
type Dispatch = Extract<AgentChatJournalEvent["event"], { kind: "dispatch" | "turn-inject" }>;
type JournalRow = Omit<AgentChatJournalEvent, "event"> & { readonly event: Exclude<AgentChatJournalEvent["event"], Dispatch> | (Omit<Dispatch, "attachments"> & { readonly attachments?: Extract<GroupTimelineEntry, { kind: "message" }>["attachments"] }) };

const ENTRY_CAP = 600;
const TEXT_CAP = 60_000;
export interface ConversationJournal {
  readonly entries: readonly GroupTimelineEntry[];
  readonly draftId: string | null;
  readonly truncated: boolean;
  readonly turn?: string | null;
}
export interface ConversationSnapshot {
  /** 제품 ChatSession의 임의 수명 식별자. provider session identity가 아니다. */
  readonly generation: string;
  /** 이 journal에 실제 반영한 서버 push/pushEphemeral의 마지막 좌표. */
  readonly cursor: number;
  readonly journal: ConversationJournal;
}
export const EMPTY_CONVERSATION_JOURNAL: ConversationJournal = { entries: [], draftId: null, truncated: false, turn: null };
const operationSpeaker = (id: string): ConversationSpeaker => ({ kind: "operation", operationId: id, name: id });
const unquote = (text: string): string => text.split("\n").map((line) => line.replace(/^>\s?/, "")).join("\n").trim();
const atOf = (entry: JournalRow): number | null => {
  const event = entry.event;
  return entry.at ?? ("at" in event && typeof event.at === "number" ? event.at : null);
};

/** 가려진 공개 Chat 사건만 읽는다. 브라우저와 서버 snapshot이 공유하는 순수 투영이다. */
export function reduceConversationJournal(state: ConversationJournal, row: JournalRow, operationId: string): ConversationJournal {
  const event = row.event;
  if (event.kind === "cleared") return EMPTY_CONVERSATION_JOURNAL;
  let entries = [...state.entries];
  let draftId = state.draftId;
  let turn = state.turn ?? null;
  const id = `message:${operationId}:${row.seq}`;
  const turnOf = () => turn ?? (turn = `turn:${operationId}:${row.seq}`);
  const at = atOf(row);
  const speaker = operationSpeaker(operationId);
  switch (event.kind) {
    case "dispatch":
    case "turn-inject": {
      if (event.kind === "dispatch") turn = `turn:${operationId}:${row.seq}`;
      const origin = event.by;
      if (origin?.kind === "plugin" && !origin.humanInput) {
        entries.push({ kind: "plugin-notice", id, at, operationId, pluginId: origin.pluginId, recipient: speaker, text: event.text,
          ...(event.format === "markdown" ? { format: "markdown" as const } : {}) });
        break;
      }
      const human = origin?.kind === "plugin" ? origin.humanInput : undefined;
      const via = human?.act;
      const by: ConversationSpeaker = human?.author === "commodore" ? { kind: "commodore", name: "Commodore" }
        : origin?.kind === "operation" ? { kind: "operation", operationId: origin.operationId, name: origin.title }
          : { kind: "human", name: "Human" };
      const text = via ? unquote(event.text) : event.text;
      const recipient = human?.targetOperationId ? operationSpeaker(human.targetOperationId) : via ? speaker : undefined;
      entries.push({ kind: "message", id: human ? `human:${human.id}` : id, at, operationId, speaker: by, text,
        ...((event.format || by.kind !== "human") && !via ? { format: "markdown" as const } : {}),
        ...(event.attachments?.length ? { attachments: event.attachments } : {}), streaming: false,
        ...(recipient ? { recipient } : {}), ...(human?.copy ? { copied: true } : {}), ...(via ? { via } : {}) });
      break;
    }
    case "text-delta": {
      const existing = draftId ? entries.find((entry) => entry.id === draftId) : undefined;
      if (existing?.kind === "message") entries = entries.map((entry) => entry === existing ? { ...existing, text: (existing.text + event.text).slice(0, TEXT_CAP) } : entry);
      else {
        draftId = id;
        entries.push({ kind: "message", id, at, operationId, speaker, text: event.text.slice(0, TEXT_CAP), format: "markdown", streaming: true, turn: turnOf() });
      }
      break;
    }
    case "text": {
      // 완성 글은 델타의 자리와 좌표를 보존한다.
      const draft = draftId ? entries.find((entry) => entry.id === draftId) : undefined;
      if (draft?.kind === "message") entries = entries.map((entry) => entry === draft ? { ...draft, text: event.text, streaming: false } : entry);
      else entries.push({ kind: "message", id, at, operationId, speaker, text: event.text, format: "markdown", streaming: false, turn: turnOf() });
      draftId = null;
      break;
    }
    case "tool": {
      if (event.name !== "SendMessage" || !event.id) return state;
      const message = event.toolDetail?.sections.find((section) => section.kind === "message")?.text ?? "";
      const split = message.indexOf("\n");
      const hasRecipient = message.startsWith("→ ");
      const recipient = hasRecipient ? message.slice(2, split < 0 ? undefined : split) : "";
      entries.push({ kind: "delegation", id: `delegation:${operationId}:${event.id}`, at, sender: speaker,
        recipients: recipient ? [{ kind: "operation", name: recipient }] : [], text: hasRecipient ? (split < 0 ? "" : message.slice(split + 1)) : message,
        result: "", received: false, turn: turnOf() });
      break;
    }
    case "tool-result": {
      const target = `delegation:${operationId}:${event.id}`;
      const result = event.toolDetail?.sections.filter((section) => section.kind === "result").map((section) => section.text).join("\n") || event.summary;
      entries = entries.map((entry) => entry.kind === "delegation" && entry.id === target ? { ...entry, result, ok: event.ok,
        ...(event.recipientOperationId ? { recipients: [operationSpeaker(event.recipientOperationId)] } : {}) } : entry);
      break;
    }
    case "received":
      entries.push({ kind: "delegation", id: `delegation:${event.id}`, at, sender: { kind: "operation", name: event.from, ...(event.senderOperationId ? { operationId: event.senderOperationId } : {}) }, recipients: [speaker], text: event.text, result: "", received: true });
      break;
    case "turn-start":
      if (turn !== null) return state;
      turn = `turn:${operationId}:${row.seq}`;
      break;
    case "turn-end":
      entries = entries.map((entry) => entry.kind === "message" && entry.streaming ? { ...entry, streaming: false } : entry);
      draftId = null;
      turn = null;
      break;
    default: return state;
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unique = [...byId.values()];
  return { entries: unique.slice(-ENTRY_CAP), draftId, truncated: state.truncated || unique.length > ENTRY_CAP, turn };
}
