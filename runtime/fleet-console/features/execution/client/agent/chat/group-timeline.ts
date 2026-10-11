import type { ConversationParticipant, ConversationPreview, ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import type { AgentChatJournalEvent } from "./chat-events.js";

const ENTRY_CAP = 600;
const TEXT_CAP = 60_000;
export interface ConversationJournal {
  readonly entries: readonly GroupTimelineEntry[];
  readonly draftId: string | null;
  readonly truncated: boolean;
}
export const EMPTY_CONVERSATION_JOURNAL: ConversationJournal = { entries: [], draftId: null, truncated: false };
const operationSpeaker = (id: string): ConversationSpeaker => ({ kind: "operation", operationId: id, name: id });
const atOf = (entry: AgentChatJournalEvent): number | null => {
  const event = entry.event;
  return entry.at ?? ("at" in event && typeof event.at === "number" ? event.at : null);
};

/** 가려진 공개 Chat 사건만 읽는다. received는 활동/턴을 열지 않고, 사고는 표시 원장에 들어오지 않는다. */
export function reduceConversationJournal(state: ConversationJournal, row: AgentChatJournalEvent, operationId: string): ConversationJournal {
  const event = row.event;
  if (event.kind === "cleared") return EMPTY_CONVERSATION_JOURNAL;
  let entries = [...state.entries];
  let draftId = state.draftId;
  const id = `message:${operationId}:${row.seq}`;
  const at = atOf(row);
  const speaker = operationSpeaker(operationId);
  switch (event.kind) {
    case "dispatch":
    case "turn-inject": {
      const by: ConversationSpeaker = event.by?.kind === "operation"
        ? { kind: "operation", operationId: event.by.operationId, name: event.by.title }
        : event.by ? { kind: "operation", name: event.by.pluginId } : { kind: "human", name: "Human" };
      entries.push({ kind: "message", id, at, operationId, speaker: by, text: event.text, ...(event.by ? { format: "markdown" as const } : {}), streaming: false });
      break;
    }
    case "text-delta": {
      const existing = draftId ? entries.find((entry) => entry.id === draftId) : undefined;
      if (existing?.kind === "message") entries = entries.map((entry) => entry === existing ? { ...existing, text: (existing.text + event.text).slice(0, TEXT_CAP) } : entry);
      else {
        draftId = id;
        entries.push({ kind: "message", id, at, operationId, speaker, text: event.text.slice(0, TEXT_CAP), format: "markdown", streaming: true });
      }
      break;
    }
    case "text":
      // 완성 글이 델타를 대체한다. 같은 내용의 두 말풍선을 세우지 않는다.
      if (draftId) entries = entries.filter((entry) => entry.id !== draftId);
      entries.push({ kind: "message", id, at, operationId, speaker, text: event.text, format: "markdown", streaming: false });
      draftId = null;
      break;
    case "tool": {
      if (event.name !== "SendMessage" || !event.id) return state;
      const message = event.toolDetail?.sections.find((section) => section.kind === "message")?.text ?? "";
      const split = message.indexOf("\n");
      const hasRecipient = message.startsWith("→ ");
      const recipient = hasRecipient ? message.slice(2, split < 0 ? undefined : split) : "";
      entries.push({ kind: "delegation", id: `delegation:${operationId}:${event.id}`, at, sender: speaker,
        recipients: recipient ? [{ kind: "operation", name: recipient }] : [], text: hasRecipient ? (split < 0 ? "" : message.slice(split + 1)) : message,
        result: "", received: false });
      break;
    }
    case "tool-result": {
      const target = `delegation:${operationId}:${event.id}`;
      const result = event.toolDetail?.sections.filter((section) => section.kind === "result").map((section) => section.text).join("\n") || event.summary;
      entries = entries.map((entry) => entry.kind === "delegation" && entry.id === target ? { ...entry, result, ok: event.ok } : entry);
      break;
    }
    case "received":
      entries.push({ kind: "delegation", id: `delegation:${event.id}`, at, sender: { kind: "operation", name: event.from }, recipients: [speaker], text: event.text, result: "", received: true });
      break;
    case "turn-end":
      entries = entries.map((entry) => entry.kind === "message" && entry.streaming ? { ...entry, streaming: false } : entry);
      draftId = null;
      break;
    default: return state;
  }
  // 수신/재생의 동일 좌표는 한 번만 세운다. 결과 갱신은 기존 자리를 유지한다.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unique = [...byId.values()];
  return { entries: unique.slice(-ENTRY_CAP), draftId, truncated: state.truncated || unique.length > ENTRY_CAP };
}

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, 240);

export function composeGroupTimeline(input: {
  readonly rootOperationId: string | null;
  readonly participants: readonly ConversationParticipant[];
  readonly journals: ReadonlyMap<string, ConversationJournal>;
  readonly board?: OperationClusterConversation;
  readonly loading?: boolean;
  readonly unavailableOperationIds?: readonly string[];
}): GroupTimelineSnapshot {
  const speakers = new Map(input.participants.flatMap(({ speaker }) => speaker.operationId ? [[speaker.operationId, speaker] as const] : []));
  const resolve = (speaker: ConversationSpeaker): ConversationSpeaker => speaker.kind === "human" || !speaker.operationId ? speaker : speakers.get(speaker.operationId) ?? speaker;
  const entries = new Map<string, GroupTimelineEntry>();
  let truncated = input.board?.truncated === true;
  for (const [operationId, journal] of input.journals) {
    if (!speakers.has(operationId)) continue;
    truncated ||= journal.truncated;
    for (const item of journal.entries) {
      if (item.kind === "message") { entries.set(item.id, { ...item, speaker: resolve(item.speaker) }); continue; }
      if (item.kind !== "delegation") continue;
      const senderId = [...speakers.keys()].sort((a, b) => b.length - a.length).find((id) => item.id.startsWith(`delegation:${id}:`));
      const sender = senderId ? speakers.get(senderId)! : resolve(item.sender);
      const next = { ...item, sender, recipients: item.recipients.map(resolve) };
      const previous = entries.get(item.id);
      if (previous?.kind !== "delegation") { entries.set(item.id, next); continue; }
      const received = previous.received || next.received;
      // 수신 DTO가 있으면 모호한 런치 이름 힌트 대신 서버가 확정한 수신 Operation을 쓴다.
      const recipients = [...previous.recipients, ...next.recipients].filter((recipient) => !received || recipient.operationId);
      const unique = new Map(recipients.map((recipient) => [recipient.operationId ?? recipient.name, recipient]));
      entries.set(item.id, { ...previous, sender, recipients: [...unique.values()], received,
        text: previous.text || next.text, result: previous.result || next.result,
        ...(previous.ok !== undefined || next.ok !== undefined ? { ok: previous.ok ?? next.ok } : {}),
        at: previous.at === null ? next.at : next.at === null ? previous.at : Math.min(previous.at, next.at) });
    }
  }
  for (const item of input.board?.events ?? []) entries.set(item.id, item);
  const ordered = [...entries.values()].sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity) || a.id.localeCompare(b.id));
  const decision = input.board?.decision ?? null;
  const last = ordered.findLast((entry) => entry.kind === "message" && oneLine(entry.text));
  const preview: ConversationPreview | null = decision
    ? { kind: "decision", text: oneLine(decision.title), at: decision.createdAt }
    : last?.kind === "message" ? { kind: "message", text: oneLine(last.text), at: last.at, speaker: last.speaker } : null;
  return { rootOperationId: input.rootOperationId, entries: ordered, participants: input.participants,
    working: input.participants.filter((participant) => participant.activity === "running").map((participant) => participant.speaker),
    decision, preview, loading: input.loading ?? false, truncated, unavailableOperationIds: input.unavailableOperationIds ?? [] };
}
