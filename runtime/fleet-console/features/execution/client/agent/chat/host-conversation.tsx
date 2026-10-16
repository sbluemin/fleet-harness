import { useEffect, useMemo, useState } from "react";
import type { HostSurfaceContext } from "@fleet-console/sdk/host-context";
import type { ConversationParticipant } from "@fleet-console/sdk/conversation";
import { createConversationStream } from "@fleet-console/sdk/conversation";
import { HostMessageComposer } from "@fleet-console/sdk/composer";
import { sessionRuntime } from "@fleet-console/sdk/operations/activity";
import { fetchSessions, messageAgentSession } from "../api.js";
import { getT } from "../i18n/index.js";
import { createChatSocketSession } from "./chat-store.js";
import { readChatJournalEvent, type AgentChatJournalEvent } from "./chat-events.js";
import { composeGroupTimeline, EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationJournal } from "./group-timeline.js";
import { fetchConversationSnapshot } from "./conversation-history.js";

/** 그룹 대화와 같은 저널 reducer·말풍선을 쓰되, 연결/초안은 주입한 host scope에만 속한다. */
export function HostAgentConversation({ context, title, readOnlyLabel, uploadUnsupported }: {
  readonly context: HostSurfaceContext; readonly title: string; readonly readOnlyLabel: string; readonly uploadUnsupported: string;
}) {
  const operationId = context.selection.operationId;
  const [journal, setJournal] = useState<ConversationJournal>(EMPTY_CONVERSATION_JOURNAL);
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<ConversationParticipant["activity"]>("unknown");
  const working = activity === "running";
  const [error, setError] = useState<string | null>(null);
  const t = getT(context.language);
  useEffect(() => {
    if (!operationId) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([context.transport.scope.signal, abort.signal]);
    let session: ReturnType<typeof createChatSocketSession> | null = null;
    let staging = EMPTY_CONVERSATION_JOURNAL;
    let socketVersion = 0;
    let generation: string | null = null;
    let cursor = 0;
    let ready = false;
    let pending: AgentChatJournalEvent[] = [];
    let pendingBytes = 0;
    let overflow = false;
    let syncAttempts = 0;
    let inFlight = false;
    let observedSession: string | undefined;
    let observed = false;
    setJournal(staging); setLoading(true);
    const stream = createConversationStream<AgentChatJournalEvent>({
      delta: (row) => row.event.kind === "text-delta" ? { key: operationId, text: row.event.text } : null,
      withText: (row, text) => ({ ...row, event: { kind: "text-delta", text } }),
      apply: (rows) => { if (signal.aborted) return; for (const row of rows) staging = reduceConversationJournal(staging, row, operationId); setJournal(staging); },
    });
    const stopSocket = () => {
      stream.flush();
      socketVersion += 1; ready = false; pending = []; pendingBytes = 0; generation = null; cursor = 0;
      const previous = session; session = null; previous?.dispose();
    };
    const fail = (cause: unknown) => {
      if (signal.aborted) return;
      stopSocket();
      if (cause instanceof Error && cause.message === "conversation_generation_changed") { staging = EMPTY_CONVERSATION_JOURNAL; setJournal(staging); }
      setError(cause instanceof Error ? cause.message : "chat_history_unavailable"); setLoading(false);
    };
    const accept = (row: AgentChatJournalEvent) => {
      if (row.generation !== generation) throw new Error("conversation_generation_changed");
      // 접속 합성 경계의 seq는 실제 사건과 같거나 분수다. 원장의 cursor를 전진시키지 않는다.
      if (row.event.kind === "replay-start" || row.event.kind === "replay-end" || row.event.kind === "snapshot-end") return;
      if (row.seq <= cursor) return;
      cursor = row.seq;
      stream.push(row);
    };
    const syncSnapshot = async () => {
      const version = ++socketVersion;
      stream.flush(); ready = false; pending = []; pendingBytes = 0; overflow = false;
      try {
        if (++syncAttempts > 3) throw new Error("conversation_catchup_overflow");
        const snapshot = await fetchConversationSnapshot(operationId, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), context.transport);
        if (signal.aborted || version !== socketVersion) return;
        if (!snapshot?.live) throw new Error("conversation_snapshot_required");
        // 버퍼 상한 전에 도착한 사건은 다음 요청보다 앞선다. 새 snapshot을 읽어야만 그 사건을 포함했다고 할 수 있다.
        if (overflow) { void syncSnapshot(); return; }
        // HTTP 원장을 통째로 채택한다. 서로 다른 transcript/WS seq를 합치거나 본문으로 추측하지 않는다.
        staging = snapshot.journal; generation = snapshot.live.generation; cursor = snapshot.live.cursor;
        ready = true;
        for (const row of pending) accept(row);
        pending = []; pendingBytes = 0; syncAttempts = 0;
        setJournal(staging); setLoading(false); setError(null);
      } catch (cause) {
        if (signal.aborted || version !== socketVersion) return;
        fail(cause);
      }
    };
    const refresh = async () => {
      if (signal.aborted || inFlight) return;
      inFlight = true;
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
        const sessions = await fetchSessions(requestSignal, context.transport);
        if (signal.aborted) return;
        const selected = sessions.find((item) => item.sessionId === operationId);
        if (observed && observedSession !== selected?.generation) {
          stream.flush(); stopSocket(); staging = EMPTY_CONVERSATION_JOURNAL; setJournal(staging);
        }
        observed = true; observedSession = selected?.generation;
        const runtime = selected ? sessionRuntime(selected) : null;
        setActivity(runtime ? runtime.lifecycle === "dormant" ? "ended" : runtime.activity : "unknown");
        if (!selected?.chatActive || !context.canWrite()) stopSocket();
        if (!session) {
          const history = await fetchConversationSnapshot(operationId, requestSignal, context.transport);
          if (signal.aborted) return;
          staging = history?.journal ?? EMPTY_CONVERSATION_JOURNAL;
          setJournal(staging); setLoading(false); setError(null);
        }
        if (selected?.chatActive && context.canWrite() && !session) {
          session = createChatSocketSession({ operationId, transport: context.transport, canWrite: context.canWrite,
            onConnection: (connection) => { if (signal.aborted) return; if (connection === "open") { syncAttempts = 0; void syncSnapshot(); } if (connection === "lost") { socketVersion += 1; ready = false; pending = []; pendingBytes = 0; setError("remote_host_unavailable"); } },
            onEvent: (raw) => {
              if (signal.aborted) return;
              const row = readChatJournalEvent(raw);
              if (!row) return;
              try {
                if (ready) accept(row);
                else {
                  if (overflow) return;
                  pendingBytes += raw.length;
                  if (pending.length >= 2_048 || pendingBytes > 512 * 1024) { overflow = true; pending = []; pendingBytes = 0; return; }
                  pending.push(row);
                }
              } catch (cause) { fail(cause); }
            },
          });
          session.start();
        }
      } catch (cause) { if (!signal.aborted) { setError(cause instanceof Error ? cause.message : "chat_history_unavailable"); setLoading(false); } }
      finally { inFlight = false; }
    };
    void refresh();
    const offChanged = context.events.subscribe("operation:changed", () => { void refresh(); });
    const offSession = context.events.subscribe("session:updated", () => { void refresh(); });
    const offAttention = context.events.subscribe("session:attention", () => { void refresh(); });
    const offReconnect = context.events.onReconnect?.(() => { void refresh(); });
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => { abort.abort(); stopSocket(); stream.dispose(); offChanged(); offSession(); offAttention(); offReconnect?.(); clearInterval(poll); };
  }, [context, operationId]);
  const participants = useMemo<readonly ConversationParticipant[]>(() => operationId ? [{ speaker: { kind: "commander", operationId, name: title }, activity }] : [], [operationId, title, activity]);
  const snapshot = useMemo(() => composeGroupTimeline({ rootOperationId: operationId, participants, journals: new Map(operationId ? [[operationId, journal]] : []), loading }), [operationId, participants, journal, loading]);
  const Conversation = context.chat.Conversation;
  return <div className="agent-chat-panel" data-host-key={context.selection.hostKey}>
    {error ? <p role="alert">{error}</p> : null}
    <Conversation entries={snapshot.entries} participants={participants} working={snapshot.working} language={context.language} loading={loading} truncated={snapshot.truncated} theaterId={context.selection.theaterId ?? undefined}
      composer={<HostMessageComposer context={context} label={t("terminal.chat.composerInputAria")} placeholder={t("terminal.chat.composerPlaceholder")} sendLabel={t("terminal.chat.composerSend")} readOnlyLabel={readOnlyLabel} uploadUnsupported={uploadUnsupported}
        send={async (text) => { if (!operationId || !context.canWrite()) throw new Error("read_only"); await messageAgentSession(operationId, text, undefined, context.transport.scope.signal, context.transport); }} />} />
  </div>;
}
