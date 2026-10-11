import { useMemo, useSyncExternalStore } from "react";
import type { ConversationParticipant, ConversationPreview, ConversationSpeaker, GroupTimelineSnapshot, OperationClusterConversation } from "@fleet-console/sdk/conversation";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import { getState, ownOperationRuntime, subscribe as subscribeConsole } from "../../../../../core/client/src/integration/store.js";
import { useConsoleState } from "../../../../../core/client/src/hooks/use-store.js";
import { useOperationClusters } from "../../../../workspace/client/operation-clusters.js";
import { getAgentState, subscribe as subscribeAgent } from "../store.js";
import { readChatJournalEvent } from "./chat-events.js";
import { createChatSocketSession } from "./chat-store.js";
import { composeGroupTimeline, EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationJournal } from "./group-timeline.js";

type Held = { root: string; generation: string | undefined; journal: ConversationJournal; staging: ConversationJournal; loading: boolean; available: boolean; socket?: ReturnType<typeof createChatSocketSession> };
const held = new Map<string, Held>();
const listeners = new Set<() => void>();
let revision = 0;
const notify = () => { revision++; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getRevision = () => revision;

/** execution 설치 수명이 소유한다. UI 구독자 수·선택 그룹·패널 접힘은 연결 수명에 참여하지 않는다. */
export function installGroupTimeline(ctx: { readonly experiments: Pick<PluginInstallContext["experiments"], "read" | "subscribe"> }): () => void {
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const state = getState();
    const all = [...state.operations, ...state.nestedOperations].filter((operation) => operation.type === "agent" && operation.pluginId === null);
    const roots = new Set(state.operations.map((operation) => operation.id));
    const ids = new Set(all.map((operation) => operation.id));
    const enabled = ctx.experiments.read()?.conversationLayout === true;
    const sessions = getAgentState().sessions;
    for (const [id, record] of held) {
      if (!roots.has(record.root)) { record.socket?.dispose(); held.delete(id); continue; }
      if (!ids.has(id) || !enabled || sessions[id]?.chatActive !== true) {
        record.socket?.dispose(); record.socket = undefined; record.loading = false; record.available = false;
      }
    }
    for (const operation of all) {
      const session = sessions[operation.id];
      let record = held.get(operation.id);
      const root = operation.parentOperationId ?? operation.id;
      if (record && session?.generation !== record.generation && session?.chatActive === true) {
        record.socket?.dispose(); held.delete(operation.id); record = undefined;
      }
      if (!record) {
        record = { root, generation: session?.generation, journal: EMPTY_CONVERSATION_JOURNAL, staging: EMPTY_CONVERSATION_JOURNAL, loading: false, available: false };
        held.set(operation.id, record);
      }
      record.root = root;
      if (!enabled || session?.chatActive !== true || operation.payload.chatMode !== true || record.socket) continue;
      const current = record;
      current.loading = true;
      const socket = createChatSocketSession({
        operationId: operation.id,
        onConnection: (connection) => {
          if (disposed || held.get(operation.id) !== current) return;
          current.available = connection === "open";
          if (connection === "open") { current.staging = EMPTY_CONVERSATION_JOURNAL; current.loading = true; }
          else if (connection === "lost") current.loading = false;
          notify();
        },
        onEvent: (raw) => {
          if (disposed || held.get(operation.id) !== current) return;
          const row = readChatJournalEvent(raw);
          if (!row) return;
          if (row.event.kind === "snapshot-end") { current.journal = current.staging; current.loading = false; notify(); return; }
          current.staging = reduceConversationJournal(current.staging, row, operation.id);
          if (row.event.kind === "replay-start" && row.seq > 1) current.staging = { ...current.staging, truncated: true };
          if (!current.loading || row.event.kind === "cleared") { current.journal = current.staging; notify(); }
        },
      });
      current.socket = socket;
      socket.start();
    }
    notify();
  };
  const cleanups = [subscribeConsole(sync), subscribeAgent(sync), ctx.experiments.subscribe(sync)];
  sync();
  return () => {
    disposed = true;
    for (const off of cleanups) off();
    for (const record of held.values()) record.socket?.dispose();
    held.clear();
    notify();
  };
}

function snapshot(rootOperationId: string | null, board?: OperationClusterConversation): GroupTimelineSnapshot {
  const state = getState();
  const operations = [...state.operations, ...state.nestedOperations];
  const root = operations.find((operation) => operation.id === rootOperationId);
  const runtime = ownOperationRuntime();
  const byMember = new Map(board?.members.flatMap((member) => member.operationId ? [[member.operationId, member] as const] : []) ?? []);
  const current = operations.filter((operation) => operation.id === rootOperationId || operation.parentOperationId === rootOperationId);
  const participants: ConversationParticipant[] = current.map((operation) => {
    const speaker: ConversationSpeaker = byMember.get(operation.id) ?? { kind: operation.id === rootOperationId ? (board ? "commander" : "operation") : "member", name: operation.title, operationId: operation.id };
    const observed = runtime[operation.id];
    return { speaker, activity: observed?.lifecycle === "live" ? observed.activity : observed?.lifecycle === "dormant" ? "ended" : "unknown" };
  });
  // 아직 기동하지 않은 명부도 표식은 보인다. 실행 상태를 꾸며내지 않는다.
  for (const member of board?.members ?? []) if (!participants.some(({ speaker }) => speaker.operationId === member.operationId)) participants.push({ speaker: member, activity: "unknown" });
  const journals = new Map<string, ConversationJournal>();
  const unavailable: string[] = [];
  let loading = false;
  for (const participant of participants) {
    const id = participant.speaker.operationId;
    if (!id) continue;
    const record = held.get(id);
    if (record?.root === rootOperationId) { journals.set(id, record.journal); loading ||= record.loading; }
    if (!record?.available) unavailable.push(id);
  }
  // 제거된 구성원의 이미 관측한 말은 부모가 살아 있는 동안 보존한다. 재로드 후 없는 원장은 복원했다고 주장하지 않는다.
  const historical: ConversationParticipant[] = [];
  for (const event of board?.events ?? []) if (event.kind === "member-left" && event.speaker.operationId && !participants.some(({ speaker }) => speaker.operationId === event.speaker.operationId)) {
    const record = held.get(event.speaker.operationId);
    if (record?.root === rootOperationId) journals.set(event.speaker.operationId, record.journal);
    historical.push({ speaker: event.speaker, activity: "ended" });
  }
  const composed = composeGroupTimeline({ rootOperationId, participants: [...participants, ...historical], journals, board, loading, unavailableOperationIds: unavailable });
  return { ...composed, participants, working: composed.working, ...(root || board ? {} : { loading: false }) };
}

export function useGroupTimeline(rootOperationId: string | null): GroupTimelineSnapshot {
  const tick = useSyncExternalStore(subscribe, getRevision, getRevision);
  const state = useConsoleState();
  const clusters = useOperationClusters();
  return useMemo(() => snapshot(rootOperationId, clusters.find((cluster) => cluster.conversation?.operationId === rootOperationId)?.conversation), [rootOperationId, clusters, state, tick]);
}

export function useConversationPreviews(): Readonly<Record<string, ConversationPreview>> {
  const tick = useSyncExternalStore(subscribe, getRevision, getRevision);
  const state = useConsoleState();
  const clusters = useOperationClusters();
  return useMemo(() => {
    const boards = new Map(clusters.flatMap((cluster) => cluster.conversation ? [[cluster.conversation.operationId, cluster.conversation] as const] : []));
    const ids = new Set([...state.operations.filter((operation) => operation.type === "agent").map((operation) => operation.id), ...boards.keys()]);
    const previews: Record<string, ConversationPreview> = {};
    for (const id of ids) { const preview = snapshot(id, boards.get(id)).preview; if (preview) previews[id] = preview; }
    return previews;
  }, [state, clusters, tick]);
}
