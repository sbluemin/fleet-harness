import type { ConversationParticipant, ConversationPreview, ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import type { ConversationJournal } from "../../../conversation-journal.js";
export { EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationJournal, type ConversationSnapshot } from "../../../conversation-journal.js";

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, 240);

/** 원장 줄과 표시 발화자가 같으면 확정 줄 객체를 재사용한다. 수명·연결 상태가 아닌 약한 투영 캐시다. */
const resolvedEntries = new WeakMap<GroupTimelineEntry, { readonly key: string; readonly entry: GroupTimelineEntry }>();
function resolvedEntry(item: GroupTimelineEntry, speakers: readonly ConversationSpeaker[], build: () => GroupTimelineEntry): GroupTimelineEntry {
  const key = JSON.stringify(speakers);
  const cached = resolvedEntries.get(item);
  if (cached?.key === key) return cached.entry;
  const entry = build();
  resolvedEntries.set(item, { key, entry });
  return entry;
}

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
      if (item.kind === "message") {
        const previous = entries.get(item.id);
        // 서버가 부여한 사람 발송 ID가 같을 때만 원본을 지휘관 사본보다 우선한다. 본문/시간으로 추측하지 않는다.
        if (previous?.kind !== "message" || previous.copied || !item.copied) {
          const speaker = resolve(item.speaker);
          const recipient = item.recipient ? resolve(item.recipient) : undefined;
          entries.set(item.id, resolvedEntry(item, recipient ? [speaker, recipient] : [speaker], () => ({ ...item, speaker, ...(recipient ? { recipient } : {}) })));
        }
        continue;
      }
      if (item.kind === "plugin-notice") {
        const recipient = resolve(item.recipient);
        entries.set(item.id, resolvedEntry(item, [recipient], () => ({ ...item, recipient })));
        continue;
      }
      if (item.kind !== "delegation") continue;
      const senderId = [...speakers.keys()].sort((a, b) => b.length - a.length).find((id) => item.id.startsWith(`delegation:${id}:`));
      const sender = senderId ? speakers.get(senderId)! : resolve(item.sender);
      const resolvedRecipients = item.recipients.map(resolve);
      const next = resolvedEntry(item, [sender, ...resolvedRecipients], () => ({ ...item, sender, recipients: resolvedRecipients })) as Extract<GroupTimelineEntry, { kind: "delegation" }>;
      const previous = entries.get(item.id);
      if (previous?.kind !== "delegation") { entries.set(item.id, next); continue; }
      const received = previous.received || next.received;
      // 수신 DTO가 있으면 모호한 런치 이름 힌트 대신 서버가 확정한 수신 Operation을 쓴다.
      const recipients = [...previous.recipients, ...next.recipients].filter((recipient) => !received || recipient.operationId);
      const unique = new Map(recipients.map((recipient) => [recipient.operationId ?? recipient.name, recipient]));
      const turn = previous.turn ?? next.turn;
      entries.set(item.id, { ...previous, sender, recipients: [...unique.values()], received,
        text: previous.text || next.text, result: previous.result || next.result, ...(turn ? { turn } : {}),
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
    decision, holds: input.board?.holds ?? [], preview, loading: input.loading ?? false, truncated, unavailableOperationIds: input.unavailableOperationIds ?? [] };
}
