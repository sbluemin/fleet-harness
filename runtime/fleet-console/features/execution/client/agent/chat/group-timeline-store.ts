import type { ExecutionClientDeps } from "../../deps.js";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { createConversationStream } from "../../../shared/conversation/stream.js";
import { type ConversationParticipant, type ConversationPreview, type ConversationSpeaker, type GroupTimelineSnapshot, type ObjectiveClusterConversation } from "../../../shared/conversation/types.js";
import type { ObjectiveClusterSource } from "../../../../objectives/shared/objective-clusters.js";
import { getState, ownObjectiveRuntime, subscribe as subscribeConsole } from "../../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../../core/client/src/i18n/index.js";
import { getAgentState, subscribe as subscribeAgent } from "../store.js";
import { readChatJournalEvent } from "./chat-events.js";
import { createChatSocketSession } from "./chat-store.js";
import { composeGroupTimeline, EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationJournal } from "./group-timeline.js";
import { readFoldTurns, subscribeFoldTurns } from "./group/fold-turns.js";

const EMPTY_CLUSTERS: ReturnType<ObjectiveClusterSource["get"]> = [];
const emptyClusterSource: ObjectiveClusterSource = { get: () => EMPTY_CLUSTERS, subscribe: () => () => {} };
const GroupClusterContext = createContext<ObjectiveClusterSource>(emptyClusterSource);
/** 조합 루트가 기존 SDK 원천을 주입한다. 실행 기능은 플러그인 레지스트리를 읽지 않는다. */
export const GroupClusterProvider = GroupClusterContext.Provider;
export function useGroupClusters() {
  const source = useContext(GroupClusterContext);
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

/**
 * 같은 원천을 훅 밖의 소비자에게도 건넨다 — 대화 중심 화면의 본문 렌더러와 「구성원」 탭 등록은 렌더 함수·모듈 수준에서
 * 「이 Objective 이 목표 대화의 뿌리(지휘관)인가」를 고른다. 조합 루트가 Provider 에 넘기는 것과 같은 원천을 한 번 묶는다.
 */
let boundClusterSource: ObjectiveClusterSource = emptyClusterSource;
export function bindGroupClusterSource(source: ObjectiveClusterSource): void {
  boundClusterSource = source;
}
/** 목표 대화(보드)의 뿌리인가 — 구성원이 아직 없어도 지휘관이면 참이다. */
export function isGroupConversationRoot(objectiveId: string): boolean {
  return boundClusterSource.get().some((cluster) => cluster.conversation?.objectiveId === objectiveId);
}
export function subscribeGroupClusters(listener: () => void): () => void {
  return boundClusterSource.subscribe(listener);
}

/** 이 Objective 의 대화가 그룹 대화로 서는가 — 목표 대화의 뿌리이거나 구성원을 가진 루트다(데스크톱 가운데 칸과 같은 판정). */
export function hasGroupConversation(objectiveId: string): boolean {
  return isGroupConversationRoot(objectiveId) || getState().nestedObjectiveRecords.some((objectiveRecord) => objectiveRecord.parentObjectiveId === objectiveId);
}

/**
 * 턴 접기가 접을 구성원 말이 생길 수 있는가. `foldTimeline` 은 `speaker.kind === "member"` 인 말만 접으므로,
 * 하위 Objective(살아 있는 구성원)이나 명부의 구성원이 있을 때 참이다. 말이 아직 없어도 참이다 — 접기는 다음 구성원 말에 걸린다.
 * 제거된 구성원(`member-left`)의 지난 말도 타임라인에 남아 접히므로(`snapshot` 의 historical), 그런 구성원이 있어도 참이다 —
 * 마지막 구성원이 떠난 뒤에도 접힌 말을 펼칠 수 있어야 한다. 지휘관만 있는 대화는 거짓이다. 눌러도 접히는 말이 없다.
 */
export function conversationHasFoldableMembers(objectiveId: string): boolean {
  if (getState().nestedObjectiveRecords.some((objectiveRecord) => objectiveRecord.parentObjectiveId === objectiveId)) return true;
  const board = boundClusterSource.get().find((cluster) => cluster.conversation?.objectiveId === objectiveId)?.conversation;
  if ((board?.members ?? []).some((member) => member.kind === "member")) return true;
  return (board?.events ?? []).some((event) => event.kind === "member-left" && event.speaker.objectiveId !== undefined);
}

export function useConversationHasFoldableMembers(objectiveId: string): boolean {
  const read = () => conversationHasFoldableMembers(objectiveId);
  return useSyncExternalStore(subscribeGroupConversation, read, read);
}

function subscribeGroupConversation(listener: () => void): () => void {
  const disposeClusters = subscribeGroupClusters(listener);
  const disposeConsole = subscribeConsole(listener);
  return () => { disposeClusters(); disposeConsole(); };
}

export function useHasGroupConversation(objectiveId: string): boolean {
  const read = () => hasGroupConversation(objectiveId);
  return useSyncExternalStore(subscribeGroupConversation, read, read);
}

/**
 * 모바일 Objective 화면이 이 루트를 그룹 대화로 세우는가 — 「턴 접기」를 켰고, 살아 있는 채팅 루트이며, 그룹 대화가 서는 대화다.
 * 채팅 본문(`MobileGroupConversation` 을 고르는 자리)과 아래 소켓 수명이 같은 판정을 읽는다. 「지금 그 화면이 열려 있는가」는
 * 호스트가 실은 대화 주인(`conversation.subjectObjectiveId`)이 따로 말한다.
 */
export function showsMobileGroupConversation(objectiveId: string): boolean {
  if (!readFoldTurns() || getAgentState().sessions[objectiveId]?.chatActive !== true) return false;
  const objectiveRecord = getState().objectiveRecords.find((candidate) => candidate.id === objectiveId);
  return objectiveRecord?.chatMode === true && hasGroupConversation(objectiveId);
}

/**
 * `history`는 휴면 참여자의 저장된 지난 대화를 한 번 읽은 상태다(읽기 전용 투영, 재개 없음). live 소켓이 서면
 * 그 스냅숏이 통째로 갈아 끼운다.
 */
type Held = { root: string; generation: string | undefined; journal: ConversationJournal; staging: ConversationJournal; loading: boolean; available: boolean; socket?: ReturnType<typeof createChatSocketSession>; history: "idle" | "loading" | "done" | "failed"; historyAbort?: AbortController };
const held = new Map<string, Held>();
/** 지난 대화를 읽을 그룹 루트들. 그룹 화면이 실제로 그 루트를 볼 때만 들어온다 — 휴면 원장 전부를 미리 읽지 않는다. */
const demanded = new Set<string>();
let resync: (() => void) | null = null;
const HISTORY_PATH = (objectiveId: string) => `/api/v1/agent/sessions/${encodeURIComponent(objectiveId)}/chat-history`;

/** 서버가 트랜스크립트에서 투영한 지난 대화. 응답 줄은 소켓 저널과 같은 모양이라 같은 해석기를 지난다. */
async function fetchHistory(objectiveId: string, signal: AbortSignal): Promise<ConversationJournal | null> {
  const response = await fetch(HISTORY_PATH(objectiveId), { signal });
  if (!response.ok) return null;
  const payload = await response.json() as { readonly entries?: unknown; readonly truncated?: unknown };
  if (!Array.isArray(payload.entries)) return null;
  let journal = EMPTY_CONVERSATION_JOURNAL;
  for (const entry of payload.entries) {
    const row = readChatJournalEvent(JSON.stringify(entry));
    if (row) journal = reduceConversationJournal(journal, row, objectiveId);
  }
  return payload.truncated === true ? { ...journal, truncated: true } : journal;
}

function stopHistory(record: Held): void {
  record.historyAbort?.abort();
  record.historyAbort = undefined;
  if (record.history === "loading") { record.history = "idle"; record.loading = false; }
}
const listeners = new Set<() => void>();
let revision = 0;
const notify = () => { revision++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getRevision = () => revision;

/**
 * execution 설치 수명이 소유한다. UI 구독자 수·선택 그룹·패널 접힘은 연결 수명에 참여하지 않는다.
 * 소켓과 휴면 이력은 대화 중심 화면이 서 있을 때만 연다. 판정은 호스트가 주입한 `conversation.isActive()`이고,
 * 그 subscribe가 레이아웃을 깨운다. 능력이 없는 호스트는 대화 중심 화면으로 본다.
 * 대화 중심 화면이 아닌 호스트(모바일)는 「턴 접기」를 켠 그룹 루트를 실제로 열었을 때만 그 루트의 참여자 몫을 연다 — 열린 대화의
 * 주인은 호스트가 실은 `conversation.subjectObjectiveId()` 이고, 목록 홈에서는 null 이라 아무것도 열지 않는다.
 */
export function installGroupTimeline(ctx: {
  readonly experiments: Pick<ExecutionClientDeps["experiments"], "read" | "subscribe">;
  readonly conversation?: Pick<NonNullable<ExecutionClientDeps["conversation"]>, "isActive" | "subscribe" | "subjectObjectiveId">;
}): () => void {
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const state = getState();
    const all = [...state.objectiveRecords, ...state.nestedObjectiveRecords];
    const roots = new Set(state.objectiveRecords.map((objectiveRecord) => objectiveRecord.id));
    const ids = new Set(all.map((objectiveRecord) => objectiveRecord.id));
    const layout = ctx.conversation ? ctx.conversation.isActive() : true;
    const subject = layout ? null : ctx.conversation?.subjectObjectiveId?.() ?? null;
    const mobileRoot = subject !== null && showsMobileGroupConversation(subject) ? subject : null;
    const enabledFor = (rootId: string) => layout || rootId === mobileRoot;
    const sessions = getAgentState().sessions;
    const runtime = ownObjectiveRuntime();
    for (const [id, record] of held) {
      if (!roots.has(record.root)) { record.socket?.dispose(); stopHistory(record); held.delete(id); continue; }
      const enabled = enabledFor(record.root);
      if (!ids.has(id) || !enabled) stopHistory(record);
      if (!ids.has(id) || !enabled || sessions[id]?.chatActive !== true) {
        record.socket?.dispose(); record.socket = undefined; record.available = false;
        if (record.history !== "loading") record.loading = false;
      }
    }
    for (const objectiveRecord of all) {
      const session = sessions[objectiveRecord.id];
      let record = held.get(objectiveRecord.id);
      const root = objectiveRecord.parentObjectiveId ?? objectiveRecord.id;
      // 휴면에서 읽은 지난 대화는 새 세대의 live 스냅숏이 닿을 때까지 그대로 보인다(재개 순간 빈 화면으로 깜빡이지 않게).
      let carried: ConversationJournal | undefined;
      if (record && session?.generation !== record.generation && session?.chatActive === true) {
        record.socket?.dispose(); stopHistory(record);
        if (record.history === "done") carried = record.journal;
        held.delete(objectiveRecord.id); record = undefined;
      }
      if (!record) {
        record = { root, generation: session?.generation, journal: carried ?? EMPTY_CONVERSATION_JOURNAL, staging: EMPTY_CONVERSATION_JOURNAL, loading: false, available: false, history: "idle" };
        held.set(objectiveRecord.id, record);
      }
      record.root = root;
      const enabled = enabledFor(root);
      // 휴면 참여자: 저장된 트랜스크립트를 한 번 읽는다. ticket·재개·소켓 없이 파일 읽기 라우트만 부른다.
      // 이 페이지에서 이미 live로 읽은 원장이 있으면 그것을 보존한다.
      if (enabled && demanded.has(root) && runtime[objectiveRecord.id]?.lifecycle === "dormant" && !record.socket && record.history === "idle" && record.journal.entries.length === 0) {
        const pending = record;
        const abort = new AbortController();
        pending.history = "loading"; pending.historyAbort = abort; pending.loading = true;
        void fetchHistory(objectiveRecord.id, abort.signal).catch(() => null).then((journal) => {
          // 그새 live 소켓이 섰거나 토글이 꺼졌다면 abort가 이 응답을 버린다 — 늦은 이력이 live 스냅숏을 덮지 않는다.
          if (disposed || abort.signal.aborted || held.get(objectiveRecord.id) !== pending || pending.historyAbort !== abort) return;
          pending.historyAbort = undefined; pending.loading = false;
          if (journal) { pending.journal = journal; pending.history = "done"; } else pending.history = "failed";
          notify();
        });
      }
      if (!enabled || session?.chatActive !== true || objectiveRecord.chatMode !== true || record.socket) continue;
      stopHistory(record);
      const current = record;
      current.loading = true;
      const stream = createConversationStream<NonNullable<ReturnType<typeof readChatJournalEvent>>>({
        delta: (row) => row.event.kind === "text-delta" ? { key: objectiveRecord.id, text: row.event.text } : null,
        withText: (row, text) => ({ ...row, event: { kind: "text-delta", text } }),
        apply: (events) => {
          if (held.get(objectiveRecord.id) !== current) return;
          let changed = false;
          for (const row of events) {
            if (row.event.kind === "snapshot-end") { current.journal = current.staging; current.loading = false; changed = true; continue; }
            const before = current.staging;
            current.staging = reduceConversationJournal(current.staging, row, objectiveRecord.id);
            if (row.event.kind === "replay-start" && row.seq > 1) current.staging = { ...current.staging, truncated: true };
            if (!current.loading || row.event.kind === "cleared") {
              current.journal = current.staging;
              changed ||= before !== current.staging;
            }
          }
          if (changed && !disposed) notify();
        },
      });
      const socket = createChatSocketSession({
        objectiveId: objectiveRecord.id,
        onConnection: (connection) => {
          if (disposed || held.get(objectiveRecord.id) !== current) return;
          current.available = connection === "open";
          if (connection === "open") { stream.flush(); current.staging = EMPTY_CONVERSATION_JOURNAL; current.loading = true; }
          else if (connection === "lost") current.loading = false;
          notify();
        },
        onEvent: (raw) => {
          if (disposed || held.get(objectiveRecord.id) !== current) return;
          const row = readChatJournalEvent(raw);
          if (!row) return;
          stream.push(row);
        },
      });
      current.socket = { ...socket, dispose: () => { stream.dispose(); socket.dispose(); } };
      socket.start();
    }
    notify();
  };
  const cleanups = [subscribeConsole(sync), subscribeAgent(sync), subscribeFoldTurns(sync), subscribeGroupClusters(sync), ctx.conversation ? ctx.conversation.subscribe(sync) : ctx.experiments.subscribe(sync)];
  resync = sync;
  sync();
  return () => {
    disposed = true;
    for (const off of cleanups) off();
    for (const record of held.values()) { record.socket?.dispose(); stopHistory(record); }
    held.clear();
    // 수요는 화면이 페이지 수명 동안 건 것이다 — 레일 목록 변화로 설치가 다시 돌 때 비우면, 같은 루트를 보는 화면의
    // effect는 다시 돌지 않아 지난 대화를 다시 청하지 못한다. 다음 설치의 첫 sync가 이 수요를 그대로 이어받는다.
    if (resync === sync) resync = null;
    notify();
  };
}

function snapshot(rootObjectiveId: string | null, board: ObjectiveClusterConversation | undefined, commanderName: string): GroupTimelineSnapshot {
  const state = getState();
  const objectiveRecords = [...state.objectiveRecords, ...state.nestedObjectiveRecords];
  const root = objectiveRecords.find((objectiveRecord) => objectiveRecord.id === rootObjectiveId);
  const runtime = ownObjectiveRuntime();
  // 명부의 보드 사실(profile)은 참여자에만 싣는다 — 발화자는 말풍선·이음 줄마다 복사되므로 표식만 남긴다.
  const roster = (board?.members ?? []).map(({ profile, ...speaker }): Pick<ConversationParticipant, "speaker" | "profile"> => ({ speaker, ...(profile ? { profile } : {}) }));
  const byMember = new Map(roster.flatMap((member) => member.speaker.objectiveId ? [[member.speaker.objectiveId, member] as const] : []));
  const current = objectiveRecords.filter((objectiveRecord) => objectiveRecord.id === rootObjectiveId || objectiveRecord.parentObjectiveId === rootObjectiveId);
  const participants: ConversationParticipant[] = current.map((objectiveRecord) => {
    const listed = byMember.get(objectiveRecord.id);
    const speaker: ConversationSpeaker = listed?.speaker ?? { kind: objectiveRecord.id === rootObjectiveId ? (board ? "commander" : "objectiveRecord") : "member", name: objectiveRecord.id === rootObjectiveId && board ? commanderName : objectiveRecord.title, objectiveId: objectiveRecord.id };
    const profile = listed?.profile ?? (objectiveRecord.id === rootObjectiveId ? board?.commander : undefined);
    const observed = runtime[objectiveRecord.id];
    return { speaker, activity: observed?.lifecycle === "live" ? observed.activity : observed?.lifecycle === "dormant" ? "ended" : "unknown", ...(profile ? { profile } : {}) };
  });
  // 아직 기동하지 않은 명부도 표식은 보인다. 실행 상태를 꾸며내지 않는다.
  for (const member of roster) if (!participants.some(({ speaker }) => speaker.objectiveId === member.speaker.objectiveId)) participants.push({ ...member, activity: "unknown" });
  const journals = new Map<string, ConversationJournal>();
  const unavailable: string[] = [];
  let loading = false;
  for (const [index, participant] of participants.entries()) {
    const id = participant.speaker.objectiveId;
    if (!id) continue;
    const record = held.get(id);
    if (record?.root === rootObjectiveId) { journals.set(id, record.journal); loading ||= record.loading; }
    // 열린 턴은 원장만 안다 — 말이 아직 없는 새 턴도 턴 접기가 지난 턴의 답을 다시 접지 않도록 그대로 싣는다.
    const openTurn = record?.root === rootObjectiveId ? record.journal.turn : null;
    if (openTurn) participants[index] = { ...participant, turn: openTurn };
    // 휴면 참여자의 지난 대화를 읽었으면 읽을 수 있는 원장이다. 다시 live가 됐는데 소켓이 없으면(터미널 재개) 안내가 다시 선다.
    const readable = record?.available === true || (record?.history === "done" && runtime[id]?.lifecycle === "dormant");
    if (!readable) unavailable.push(id);
  }
  // 제거된 구성원의 이미 관측한 말은 부모가 살아 있는 동안 보존한다. 재로드 후 없는 원장은 복원했다고 주장하지 않는다.
  const historical: ConversationParticipant[] = [];
  for (const event of board?.events ?? []) if (event.kind === "member-left" && event.speaker.objectiveId && !participants.some(({ speaker }) => speaker.objectiveId === event.speaker.objectiveId)) {
    const record = held.get(event.speaker.objectiveId);
    if (record?.root === rootObjectiveId) journals.set(event.speaker.objectiveId, record.journal);
    historical.push({ speaker: event.speaker, activity: "ended" });
  }
  const composed = composeGroupTimeline({ rootObjectiveId, participants: [...participants, ...historical], journals, board, loading, unavailableObjectiveIds: unavailable });
  return { ...composed, participants, working: composed.working, ...(root || board ? {} : { loading: false }) };
}

export function useGroupTimeline(rootObjectiveId: string | null): GroupTimelineSnapshot {
  const t = useT();
  const tick = useSyncExternalStore(subscribe, getRevision, getRevision);
  const state = useConsoleState();
  const clusters = useGroupClusters();
  // 이 루트를 실제로 보는 화면만 휴면 참여자의 지난 대화를 청한다. 한 번 청한 루트는 페이지 수명 동안 남는다(일회성 읽기, 연결 아님).
  useEffect(() => {
    if (!rootObjectiveId || demanded.has(rootObjectiveId)) return;
    demanded.add(rootObjectiveId);
    resync?.();
  }, [rootObjectiveId]);
  return useMemo(() => snapshot(rootObjectiveId, clusters.find((cluster) => cluster.conversation?.objectiveId === rootObjectiveId)?.conversation, t("cluster.picker.coordinator")), [rootObjectiveId, clusters, state, tick, t]);
}

export function useConversationPreviews(): Readonly<Record<string, ConversationPreview>> {
  const t = useT();
  const tick = useSyncExternalStore(subscribe, getRevision, getRevision);
  const state = useConsoleState();
  const clusters = useGroupClusters();
  return useMemo(() => {
    const boards = new Map(clusters.flatMap((cluster) => cluster.conversation ? [[cluster.conversation.objectiveId, cluster.conversation] as const] : []));
    const ids = new Set([...state.objectiveRecords.map((objectiveRecord) => objectiveRecord.id), ...boards.keys()]);
    const previews: Record<string, ConversationPreview> = {};
    for (const id of ids) { const preview = snapshot(id, boards.get(id), t("cluster.picker.coordinator")).preview; if (preview) previews[id] = preview; }
    return previews;
  }, [state, clusters, tick, t]);
}
