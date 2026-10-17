import type { ConversationParticipant, ConversationPreview, ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import { isPersonQueueEntry, type AgentChatJournalEvent, type AgentChatQueueEntry } from "./chat-events.js";

const ENTRY_CAP = 600;
const TEXT_CAP = 60_000;
export interface ConversationJournal {
  readonly entries: readonly GroupTimelineEntry[];
  readonly draftId: string | null;
  readonly truncated: boolean;
  /** 지금 열린 턴의 좌표 — 지시(dispatch)나 턴 시작이 열고 턴 끝이 닫는다. 말과 전언이 이 값을 `turn` 으로 단다. */
  readonly turn?: string | null;
  /**
   * 아직 시작하지 않은 예약의 전량. 서버 큐와 같은 REPLACE 이고 라이브 전용이라 재생·이력에는 없다.
   * 화면은 여기서 사람의 말만 대기 말풍선으로 세우고, 처리가 시작되거나 취소되면 이 목록에서 빠진다.
   */
  readonly queue: readonly AgentChatQueueEntry[];
  /** 그 스냅샷이 도착한 시각. 대기 말의 자리다. 모르면 null. */
  readonly queueAt: number | null;
}
export const EMPTY_CONVERSATION_JOURNAL: ConversationJournal = { entries: [], draftId: null, truncated: false, turn: null, queue: [], queueAt: null };
const operationSpeaker = (id: string): ConversationSpeaker => ({ kind: "operation", operationId: id, name: id });
/** 「> 」 인용 한 겹을 걷는다 — 플러그인이 덧붙인 말을 지시 아래 인용으로 실어 보낸 모양이다. */
const unquote = (text: string): string => text.split("\n").map((line) => line.replace(/^>\s?/, "")).join("\n").trim();
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
  let turn = state.turn ?? null;
  const id = `message:${operationId}:${row.seq}`;
  // 턴 좌표는 그 턴을 연 사건의 seq 다. 여는 사건 없이 말이 먼저 오면(중간부터 읽은 기록) 그 말이 턴을 연다.
  const turnOf = () => turn ?? (turn = `turn:${operationId}:${row.seq}`);
  const at = atOf(row);
  const speaker = operationSpeaker(operationId);
  switch (event.kind) {
    case "dispatch":
    case "turn-inject": {
      // 지시는 새 턴을 연다. 도는 턴에 끼워 넣은 말(turn-inject)은 그 턴 안이다.
      if (event.kind === "dispatch") turn = `turn:${operationId}:${row.seq}`;
      const origin = event.by;
      // 사람·사령관의 말 없이 플러그인이 혼자 보낸 지시는 발화자가 아니라 출처다 — 말풍선이 아닌 가운데 알림 줄로 선다.
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
      // 보드 행위에 덧붙인 말은 프롬프트 속 인용 그대로 표시 문면이 된다 — 다시 연 뒤에도 같은 구간이 서도록 인용은 호스트에 두고 여기서 걷는다.
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
      // 완성 글이 델타를 대체한다. 같은 내용의 두 말풍선을 세우지 않는다. 초안이 있으면 그 자리(id·시각)를 그대로 쓴다 —
      // 새 id·완료 시각으로 다시 넣으면 말풍선이 다시 그려지고, 병렬로 말하는 중이면 다른 발화자의 말 아래로 자리를 옮긴다.
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
      // 지시가 이미 연 턴이면 그 턴이 이어진다. 다른 세션의 말이 깨운 턴은 여기서 열린다.
      if (turn !== null) return state;
      turn = `turn:${operationId}:${row.seq}`;
      break;
    case "turn-end":
      entries = entries.map((entry) => entry.kind === "message" && entry.streaming ? { ...entry, streaming: false } : entry);
      draftId = null;
      turn = null;
      break;
    case "queue":
      // 예약 전량 교체. 저널 줄은 건드리지 않는다 — 대기 말은 이 스냅샷에서만 서고, 확정 말과 섞어 세지 않는다.
      return { ...state, queue: event.entries, queueAt: at };
    default: return state;
  }
  // 수신/재생의 동일 좌표는 한 번만 세운다. 결과 갱신은 기존 자리를 유지한다.
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unique = [...byId.values()];
  return { entries: unique.slice(-ENTRY_CAP), draftId, truncated: state.truncated || unique.length > ENTRY_CAP, turn, queue: state.queue, queueAt: state.queueAt };
}

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, 240);

/**
 * 큐 스냅샷의 사람 말을 대기 말풍선으로. 배열이 같을 때는 같은 객체를 돌려준다 — 다른 참여자의
 * 델타가 도착할 때마다 대기 말을 다시 만들면 그 말풍선이 매번 다시 그려진다.
 */
const pendingPrompts = new WeakMap<readonly AgentChatQueueEntry[], readonly GroupTimelineEntry[]>();
function queuedPrompts(operationId: string, journal: ConversationJournal): readonly GroupTimelineEntry[] {
  const cached = pendingPrompts.get(journal.queue);
  if (cached) return cached;
  const base = journal.queueAt;
  const built: GroupTimelineEntry[] = [];
  journal.queue.forEach((entry, index) => {
    if (!isPersonQueueEntry(entry)) return;
    const human = entry.by?.kind === "plugin" ? entry.by.humanInput : undefined;
    const recipient = human?.targetOperationId ? operationSpeaker(human.targetOperationId) : undefined;
    built.push({
      kind: "message",
      // 사람이 보드로 보낸 말은 확정 말과 같은 id 다. 처리가 시작되면 그 말이 이 자리를 그대로 잇고, 둘은 동시에 서지 않는다.
      id: human ? `human:${human.id}` : `pending:${operationId}:${entry.id}`,
      at: base === null ? null : base + index,
      operationId,
      speaker: { kind: "human", name: "Human" },
      text: entry.text,
      streaming: false,
      pending: true,
      ...(recipient ? { recipient } : {}),
      ...(human?.copy ? { copied: true } : {}),
      ...(human?.act ? { via: human.act } : {}),
    });
  });
  pendingPrompts.set(journal.queue, built);
  return built;
}

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
  const waiting: GroupTimelineEntry[] = [];
  let truncated = input.board?.truncated === true;
  for (const [operationId, journal] of input.journals) {
    if (!speakers.has(operationId)) continue;
    truncated ||= journal.truncated;
    waiting.push(...queuedPrompts(operationId, journal));
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
  // 대기 말은 확정 말 뒤에 얹는다. 같은 사람 발송 id 의 확정 말이 이미 있으면 그 말이 이긴다(중복으로 세우지 않는다).
  // 사본보다 원본을 남긴다 — 구성원에게 보낸 말의 지휘관 알림이 원본 말풍선을 가리지 않게.
  for (const item of waiting) {
    if (item.kind !== "message") continue;
    const previous = entries.get(item.id);
    if (previous?.kind === "message" && !previous.pending) continue;
    if (previous?.kind === "message" && previous.pending && !previous.copied && item.copied) continue;
    const speaker = resolve(item.speaker);
    const recipient = item.recipient ? resolve(item.recipient) : undefined;
    entries.set(item.id, resolvedEntry(item, recipient ? [speaker, recipient] : [speaker], () => ({ ...item, speaker, ...(recipient ? { recipient } : {}) })));
  }
  for (const item of input.board?.events ?? []) entries.set(item.id, item);
  // 시각을 모르는 대기 말은 대화 맨 아래에 선다. 지난 말 사이로 올라가면 "이미 처리된 말"로 읽힌다.
  const orderKey = (entry: GroupTimelineEntry): number => entry.kind === "message" && entry.pending && entry.at === null ? Number.MAX_SAFE_INTEGER : (entry.at ?? -Infinity);
  const ordered = [...entries.values()].sort((a, b) => orderKey(a) - orderKey(b) || a.id.localeCompare(b.id));
  const decision = input.board?.decision ?? null;
  const last = ordered.findLast((entry) => entry.kind === "message" && oneLine(entry.text));
  const preview: ConversationPreview | null = decision
    ? { kind: "decision", text: oneLine(decision.title), at: decision.createdAt }
    : last?.kind === "message" ? { kind: "message", text: oneLine(last.text), at: last.at, speaker: last.speaker } : null;
  return { rootOperationId: input.rootOperationId, entries: ordered, participants: input.participants,
    working: input.participants.filter((participant) => participant.activity === "running").map((participant) => participant.speaker),
    decision, holds: input.board?.holds ?? [], preview, loading: input.loading ?? false, truncated, unavailableOperationIds: input.unavailableOperationIds ?? [] };
}
