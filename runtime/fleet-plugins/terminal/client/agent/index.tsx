import { defineNotificationKind } from "@fleet-console/sdk/notifications/browser";
import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import { definePlugin, React, type PluginInstallContext } from "@fleet-console/sdk/plugin/browser";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { TerminalSurface } from "../../client-shared/index.js";

import { createAgentSession, fetchAgentCliState, resumeAgentSession, terminateAgentSession } from "./api.js";
import { startAgentConnection } from "./connection.js";
import { applySessionUpdate, hydrateAgentClis, removeSession, selectSession, useAgentState } from "./store.js";
import type { AgentCliStatus, JobView, SessionInfo, TrackView } from "./types.js";

const AGENT_TICKET_PATH = "/plugins/terminal/agent/ticket";
const TERMINAL_WS_PATH = "/terminal/ws";

export const agentOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "agent",
  title: "Agent",
  subtitle: (operation) => readPayloadString(operation.payload, "cliLabel") ?? undefined,
  render: (context) => <AgentOperationView context={context} />,
});

export const agentStreamingOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "agent.streaming",
  title: "Agent Stream",
  subtitle: () => undefined,
  render: (context) => <AgentStreamingOperationView context={context} />,
});

export const agentSettingsSection = defineSettingsSection({
  id: "agent-cli",
  title: "Agent CLI",
  render: () => <AgentCliSection />,
});

export const agentAttentionNotification = defineNotificationKind({
  id: "agent.attention",
  title: "Agent input waiting",
});

export const agentPlugin = definePlugin({
  id: "terminal",
  operationKinds: [agentOperationKind, agentStreamingOperationKind],
  settingsSections: [agentSettingsSection],
  notificationKinds: [agentAttentionNotification],
  install: (ctx) => installAgentPlugin(ctx),
  closeOperation: async (operationId) => {
    try {
      await terminateAgentSession(operationId);
    } finally {
      removeSession(operationId);
    }
  },
  launch: async ({ theaterId, kind }) => {
    const session = await createAgentSession(theaterId, kind.id);
    applySessionUpdate(session);
    selectSession(session.sessionId);
    return { id: session.sessionId };
  },
  renderLaunchIcon: () => <AgentGlyph />,
});

export const operationKinds = [agentOperationKind, agentStreamingOperationKind] as const;
export const plugins = [agentPlugin] as const;

function installAgentPlugin(ctx: PluginInstallContext): () => void {
  return startAgentConnection({
    operations: ctx.operations,
    notifications: ctx.notifications,
    status: ctx.status,
    refreshOperations: ctx.api.resync,
  });
}

function AgentOperationView({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);

  return (
    <>
      {session.status === "dormant" ? (
        <button type="button" className="canvas-operation-dormant" onClick={() => { void resumeSession(session.sessionId); }}>
          <span className="canvas-operation-dormant-status">Dormant</span>
          <span className="canvas-operation-dormant-action">Resume</span>
        </button>
      ) : (
        <TerminalSurface
          operationId={session.sessionId}
          ticketPath={AGENT_TICKET_PATH}
          wsPath={TERMINAL_WS_PATH}
          active={context.active}
          zoom={context.zoom}
          theme={context.theme}
          renderer={context.terminalRenderer}
          terminalFont={context.terminalFont}
          onExit={() => removeSession(session.sessionId)}
        />
      )}
    </>
  );
}

function AgentStreamingOperationView({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const tenantId = readPayloadString(context.operation.payload, "tenantId");
  const jobId = readPayloadString(context.operation.payload, "jobId");
  const job = tenantId && jobId ? state.tenantJobs[tenantId]?.jobs[jobId] : null;
  return job ? <JobViewOperation job={job} /> : <p className="job-overlay-empty">Waiting for stream...</p>;
}

function AgentCliSection() {
  const state = useAgentState();
  const [clis, setClis] = React.useState<readonly AgentCliStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const abort = new AbortController();
    void fetchAgentCliState(abort.signal)
      .then((next) => setClis(next.clis))
      .catch((err) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => abort.abort();
  }, []);

  return (
    <section className="settings-section">
      <div className="agent-cli-head">
        <h2>Agent CLI</h2>
        <span className={`agent-cli-status ${state.connection === "live" ? "is-on" : ""}`}>{state.connection}</span>
      </div>
      {error ? <p className="settings-error">{error}</p> : null}
      <div className="agent-cli-list">
        {clis.map((cli) => <AgentCliRow key={cli.id} cli={cli} />)}
      </div>
    </section>
  );
}

function AgentCliRow({ cli }: { readonly cli: AgentCliStatus }) {
  return (
    <div className="agent-cli-row">
      <span className="agent-cli-name">{cli.displayName}</span>
      <span className="agent-cli-meta">
        {cli.available && cli.version ? <span className="agent-cli-version">{cli.version}</span> : null}
        <span className={`agent-cli-status ${cli.available ? "is-on" : ""}`}>{cli.available ? "Available" : "Missing"}</span>
      </span>
    </div>
  );
}

function JobViewOperation({ job }: { readonly job: JobView }) {
  return (
    <div className="job-overlay">
      <div className="job-overlay-head">
        <span className="job-overlay-kicker">{job.status}</span>
        <strong>{job.label ?? job.jobId}</strong>
      </div>
      <div className="job-overlay-tracks">
        {job.trackOrder.map((trackId) => {
          const track = job.tracks[trackId];
          return track ? <TrackCard key={track.trackId} track={track} /> : null;
        })}
      </div>
    </div>
  );
}

function TrackCard({ track }: { readonly track: TrackView }) {
  return (
    <article className="track-card">
      <header className="track-card-head">
        <span className="track-card-title">{track.displayName}</span>
        <span className="track-card-status">{track.status}</span>
      </header>
      {track.thought ? <pre className="track-card-thought">{track.thought}</pre> : null}
      {track.text ? <pre className="track-card-text">{track.text}</pre> : null}
      {track.tools.length > 0 ? (
        <ol className="track-card-tools">
          {track.tools.map((tool) => <li key={tool.id}>{tool.name ?? tool.id}</li>)}
        </ol>
      ) : null}
    </article>
  );
}

async function resumeSession(sessionId: string): Promise<void> {
  applySessionUpdate(await resumeAgentSession(sessionId));
  selectSession(sessionId);
}

function sessionFromOperation(context: OperationRenderContext): SessionInfo {
  return {
    sessionId: context.operation.id,
    terminalSessionId: context.operation.id,
    cwdLabel: readPayloadString(context.operation.payload, "cwdLabel") ?? "Workspace",
    sequence: readPayloadNumber(context.operation.payload, "sequence") ?? 0,
    label: context.operation.title,
    cliId: readPayloadString(context.operation.payload, "cliId") ?? undefined,
    cliLabel: readPayloadString(context.operation.payload, "cliLabel") ?? undefined,
    status: readPayloadString(context.operation.payload, "status") === "dormant" ? "dormant" : "registered",
    turnState: "none",
    createdAt: readPayloadNumber(context.operation.payload, "createdAt") ?? Date.now(),
    theaterId: context.theaterId,
    tenantId: readPayloadString(context.operation.payload, "tenantId") ?? undefined,
    registrationId: readPayloadString(context.operation.payload, "registrationId") ?? undefined,
    resumeAvailable: readPayloadString(context.operation.payload, "status") === "dormant",
  };
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function readPayloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function AgentGlyph() {
  // Agent CLI — 에이전트 플러그인이 자기 드롭다운 아이콘을 소유한다(호스트는 모른다).
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.6 12.6 5.2v5.6L8 13.4 3.4 10.8V5.2Z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
      <path d="M6.2 7.9h3.6M8 6.1v3.6" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  );
}
