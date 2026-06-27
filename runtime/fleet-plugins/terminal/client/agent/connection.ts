import type { OperationNode } from "@fleet-console/sdk/operations";
import type { ClientNotificationsCapability, ClientOperationStatusCapability, ClientOperationsCapability, OperationActivity } from "@fleet-console/sdk/plugin";

import { fetchAgentState, fetchJobs, fetchOperationsSnapshot, fetchSessions, fetchTenants } from "./api.js";
import { isTerminalJobStatus } from "./reduce.js";
import { createSseFrameParser, interpretObserverFrame } from "./sse.js";
import { applyJobsSnapshot, applyObservedEvent, applySessionAttention, applySessionUpdate, applyTenantSnapshot, applyTruncation, findSessionIdForTenant, hydrateAgentClis, hydrateSessions, setAgentState } from "./store.js";
import type { SessionInfo, SnapshotJob, SnapshotTenantJobs } from "./types.js";

interface AgentConnectionOptions {
  readonly operations: ClientOperationsCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly status: ClientOperationStatusCapability;
  readonly refreshOperations: () => void;
}

interface AgentConnectionState {
  readonly streamingOperationsByJob: Map<string, string>;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
const STREAMING_OPERATION_PLUGIN_ID = "terminal";
const STREAMING_OPERATION_TYPE = "agent.streaming";

export function startAgentConnection(options: AgentConnectionOptions): () => void {
  const abort = new AbortController();
  const state: AgentConnectionState = { streamingOperationsByJob: new Map() };
  void runConnectionLoop(abort.signal, options, state);
  return () => abort.abort();
}

async function runConnectionLoop(signal: AbortSignal, options: AgentConnectionOptions, state: AgentConnectionState): Promise<void> {
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  while (!signal.aborted) {
    setAgentState({ connection: "connecting" });
    try {
      await resyncSnapshots(signal, options, state);
      const response = await fetch("/plugins/terminal/agent/events", { signal });
      if (!response.ok || !response.body) throw new Error(`Agent stream failed: ${response.status}`);
      setAgentState({ connection: "live", connectionError: null });
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      await consumeStream(response.body.getReader(), signal, options, state);
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

async function consumeStream(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, options: AgentConnectionOptions, state: AgentConnectionState): Promise<void> {
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
        const { job } = applyObservedEvent(interpreted.event, interpreted.tenantLabel);
        if (interpreted.event.type === "job:registered") {
          void ensureStreamingOperation(job.tenantId, job.jobId, job.label ?? job.jobId, state.streamingOperationsByJob, options);
        }
        if (interpreted.event.type === "job:finalized") {
          clearStreamingOperationStatus(job.tenantId, job.jobId, state.streamingOperationsByJob, options);
        }
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

async function ensureStreamingOperation(tenantId: string, jobId: string, title: string, streamingOperationsByJob: Map<string, string>, options: AgentConnectionOptions): Promise<void> {
  const key = streamingOperationKey(tenantId, jobId);
  if (streamingOperationsByJob.has(key)) return;
  const parentId = findSessionIdForTenant(tenantId);
  if (!parentId) return;
  try {
    const operation = await options.operations.createChild(parentId, {
      type: STREAMING_OPERATION_TYPE,
      pluginId: STREAMING_OPERATION_PLUGIN_ID,
      title,
      payload: { tenantId, jobId },
      geometry: null,
    });
    streamingOperationsByJob.set(key, operation.id);
    options.status.set(operation.id, "running");
    options.refreshOperations();
  } catch {
    streamingOperationsByJob.delete(key);
  }
}

async function resyncSnapshots(signal: AbortSignal, options: AgentConnectionOptions, state: AgentConnectionState): Promise<void> {
  const [agentClis, sessions, tenants, jobs, operations] = await Promise.all([
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
  restoreStreamingOperationStatuses(operations.operations, jobs, state.streamingOperationsByJob, options);
}

function restoreStreamingOperationStatuses(
  operations: readonly OperationNode[],
  jobs: readonly SnapshotTenantJobs[],
  streamingOperationsByJob: Map<string, string>,
  options: AgentConnectionOptions,
): void {
  const activeJobs = activeJobKeys(jobs);
  streamingOperationsByJob.clear();
  for (const operation of operations) {
    if (operation.pluginId !== STREAMING_OPERATION_PLUGIN_ID || operation.type !== STREAMING_OPERATION_TYPE) continue;
    const tenantId = readPayloadString(operation.payload, "tenantId");
    const jobId = readPayloadString(operation.payload, "jobId");
    if (!tenantId || !jobId) {
      options.status.clear(operation.id);
      continue;
    }
    const key = streamingOperationKey(tenantId, jobId);
    streamingOperationsByJob.set(key, operation.id);
    if (activeJobs.has(key)) {
      options.status.set(operation.id, "running");
    } else {
      options.status.clear(operation.id);
    }
  }
}

function activeJobKeys(tenants: readonly SnapshotTenantJobs[]): ReadonlySet<string> {
  const active = new Set<string>();
  for (const tenant of tenants) {
    for (const job of tenant.jobs) {
      if (!isTerminalSnapshotJob(job)) active.add(streamingOperationKey(tenant.tenantId, job.jobId));
    }
  }
  return active;
}

function clearStreamingOperationStatus(tenantId: string, jobId: string, streamingOperationsByJob: Map<string, string>, options: AgentConnectionOptions): void {
  const operationId = streamingOperationsByJob.get(streamingOperationKey(tenantId, jobId));
  if (operationId) options.status.clear(operationId);
}

function isTerminalSnapshotJob(job: SnapshotJob): boolean {
  if (isTerminalJobStatus(job.status)) return true;
  return job.events.some((event) => event.type === "job:finalized");
}

function streamingOperationKey(tenantId: string, jobId: string): string {
  return `${tenantId}:${jobId}`;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
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
