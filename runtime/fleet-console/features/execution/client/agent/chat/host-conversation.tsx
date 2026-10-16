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
import { fetchConversationHistory } from "./conversation-history.js";

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
    const scope = context.transport.scope;
    const abort = new AbortController();
    const signal = AbortSignal.any([scope.signal, abort.signal]);
    let session: ReturnType<typeof createChatSocketSession> | null = null;
    let staging = EMPTY_CONVERSATION_JOURNAL;
    let revision = 0;
    let inFlight = false;
    const stream = createConversationStream<AgentChatJournalEvent>({
      delta: (row) => row.event.kind === "text-delta" ? { key: operationId, text: row.event.text } : null,
      withText: (row, text) => ({ ...row, event: { kind: "text-delta", text } }),
      apply: (rows) => { if (signal.aborted) return; for (const row of rows) staging = reduceConversationJournal(staging, row, operationId); setJournal(staging); },
    });
    const refresh = async () => {
      if (signal.aborted || inFlight) return;
      inFlight = true;
      const captured = revision;
      try {
        const sessions = await fetchSessions(signal, context.transport);
        if (signal.aborted) return;
        const selected = sessions.find((item) => item.sessionId === operationId);
        const runtime = selected ? sessionRuntime(selected) : null;
        setActivity(runtime ? runtime.lifecycle === "dormant" ? "ended" : runtime.activity : "unknown");
        if (!session) {
          const history = await fetchConversationHistory(operationId, signal, context.transport);
          if (signal.aborted) return;
          if (captured === revision && history) setJournal(history);
        }
        setLoading(false); setError(null);
        if (selected?.chatActive && context.canWrite() && !session) {
          session = createChatSocketSession({ operationId, transport: context.transport, canWrite: context.canWrite,
            onConnection: (connection) => { if (signal.aborted) return; if (connection === "open") { revision += 1; stream.flush(); staging = EMPTY_CONVERSATION_JOURNAL; } if (connection === "lost") setError("remote_host_unavailable"); },
            onEvent: (raw) => { if (signal.aborted) return; const row = readChatJournalEvent(raw); if (row) stream.push(row); },
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
    // 관찰자는 소켓 제어를 요청하지 않는다. 읽기 전용 기록만 제한된 주기로 갱신한다.
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => { abort.abort(); session?.dispose(); stream.dispose(); offChanged(); offSession(); offAttention(); offReconnect?.(); clearInterval(poll); };
  }, [context, operationId]);
  const participants = useMemo<readonly ConversationParticipant[]>(() => operationId ? [{ speaker: { kind: "commander", operationId, name: title }, activity }] : [], [operationId, title, activity]);
  const snapshot = useMemo(() => composeGroupTimeline({ rootOperationId: operationId, participants, journals: new Map(operationId ? [[operationId, journal]] : []), loading }), [operationId, participants, journal, loading]);
  const Conversation = context.chat.Conversation;
  return <div className="agent-chat-panel" data-host-key={context.selection.hostKey}>
    {error ? <p role="alert">{error}</p> : null}
    <Conversation entries={snapshot.entries} participants={participants} working={snapshot.working} language={context.language} loading={loading} theaterId={context.selection.theaterId ?? undefined}
      composer={<HostMessageComposer context={context} label={t("terminal.chat.composerInputAria")} placeholder={t("terminal.chat.composerPlaceholder")} sendLabel={t("terminal.chat.composerSend")} readOnlyLabel={readOnlyLabel} uploadUnsupported={uploadUnsupported}
        send={async (text) => { if (!operationId || !context.canWrite()) throw new Error("read_only"); await messageAgentSession(operationId, text, undefined, context.transport.scope.signal, context.transport); }} />} />
  </div>;
}
