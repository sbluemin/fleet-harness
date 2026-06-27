import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ClientNotificationsCapability, ClientOperationStatusCapability, ClientOperationsCapability, OperationActivity } from "@fleet-console/sdk/plugin";

import { fetchAgentState, fetchJobs, fetchOperationsSnapshot, fetchSessions, fetchTenants } from "./api.js";
import { createSseFrameParser, interpretObserverFrame } from "./sse.js";
import { applyJobsSnapshot, applyObservedEvent, applySessionAttention, applySessionUpdate, applyTenantSnapshot, applyTruncation, hydrateAgentClis, hydrateSessions, setAgentState } from "./store.js";
import type { SessionInfo } from "./types.js";

interface AgentConnectionOptions {
  readonly operations: ClientOperationsCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly status: ClientOperationStatusCapability;
  readonly refreshOperations: () => void;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

export function startAgentConnection(options: AgentConnectionOptions): () => void {
  const abort = new AbortController();
  void runConnectionLoop(abort.signal, options);
  return () => abort.abort();
}

async function runConnectionLoop(signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  while (!signal.aborted) {
    setAgentState({ connection: "connecting" });
    try {
      await resyncSnapshots(signal, options);
      const response = await fetch("/plugins/terminal/agent/events", { signal });
      if (!response.ok || !response.body) throw new Error(`Agent stream failed: ${response.status}`);
      setAgentState({ connection: "live", connectionError: null });
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      await consumeStream(response.body.getReader(), signal, options);
      if (!signal.aborted) setAgentState({ connection: "connecting", connectionError: null });
    } catch (error) {
      if (signal.aborted) return;
      setAgentState({ connection: "connecting", connectionError: error instanceof Error ? error.message : String(error) });
    }
    if (signal.aborted) return;
    await delay(reconnectDelay, signal);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

async function consumeStream(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  const decoder = new TextDecoder();
  const parse = createSseFrameParser();
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) return;
    for (const frame of parse(decoder.decode(result.value, { stream: true }))) {
      const interpreted = interpretObserverFrame(frame);
      if (!interpreted) continue;
      if (interpreted.kind === "truncation" && interpreted.truncation) {
        applyTruncation(interpreted.tenantId, interpreted.tenantLabel, interpreted.truncation);
        continue;
      }
      if (interpreted.kind === "session" && interpreted.session) {
        applySessionUpdate(interpreted.session);
        options.status.set(interpreted.session.sessionId, sessionActivity(interpreted.session));
        continue;
      }
      if (interpreted.kind === "attention" && interpreted.session) {
        applySessionAttention(interpreted.session, interpreted.reason);
        if (interpreted.reason && interpreted.reason !== "idle_prompt") {
          options.notifications.emit({ kind: "agent.attention", operationId: interpreted.session.sessionId, message: "Agent is waiting for input" });
          options.status.set(interpreted.session.sessionId, "awaiting");
        }
        continue;
      }
      if (interpreted.event) {
        applyObservedEvent(interpreted.event, interpreted.tenantLabel);
      }
    }
  }
}

function sessionActivity(session: SessionInfo): OperationActivity {
  if (session.status === "dormant") return "dormant";
  if (session.turnState === "running") return "running";
  if (session.turnState === "ended") return "idle";
  return "idle";
}

async function resyncSnapshots(signal: AbortSignal, options: AgentConnectionOptions): Promise<void> {
  const [agentClis, sessions, tenants, jobs, operationsSnapshot] = await Promise.all([
    fetchAgentState(signal),
    fetchSessions(signal),
    fetchTenants(signal),
    fetchJobs(signal),
    fetchOperationsSnapshot(signal),
  ]);
  hydrateAgentClis(agentClis);
  hydrateSessions(sessions);
  for (const session of sessions) options.status.set(session.sessionId, sessionActivity(session));
  applyTenantSnapshot(tenants);
  applyJobsSnapshot(jobs);
  // resync 시 이전 agent.streaming orphan 패널을 조용히 제거한다(최선 노력, 실패 무시).
  pruneOrphanStreamingOperations(operationsSnapshot.operations, options);
}

function pruneOrphanStreamingOperations(operations: readonly OperationNode[], options: AgentConnectionOptions): void {
  for (const op of operations) {
    if (op.pluginId === "terminal" && op.type === "agent.streaming") {
      void options.operations.remove(op.id).catch(() => undefined);
    }
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}
