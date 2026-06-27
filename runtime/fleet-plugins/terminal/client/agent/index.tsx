import { defineNotificationKind } from "@fleet-console/sdk/notifications/browser";
import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import { definePlugin, React, type PluginInstallContext } from "@fleet-console/sdk/plugin/browser";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { TerminalSurface } from "../shared/index.js";

import { createAgentSession, fetchAgentCliState, resumeAgentSession, terminateAgentSession } from "./api.js";
import { startAgentConnection } from "./connection.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore } from "./model-auth-store.js";
import type { ModelAuthProviderState } from "./model-auth-api.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "./settings-store.js";
import { applySessionUpdate, hydrateAgentClis, removeSession, selectSession, useAgentState } from "./store.js";
import type { AgentCliStatus, JobView, SessionInfo, TrackView } from "./types.js";

interface SettingToggleRowProps {
  readonly title: string;
  readonly help: string;
  readonly onLabel: string;
  readonly offLabel: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

interface ProviderRowProps {
  readonly provider: ModelAuthProviderState;
  readonly busy: boolean;
}

const AGENT_TICKET_PATH = "/plugins/terminal/agent/ticket";
const TERMINAL_WS_PATH = "/plugins/terminal/ws";

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

  // 카드 3개를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <SystemPromptSettingsBlock />
      <ModelAuthBlock />
      <section className="global-settings-card" aria-label="Agent CLI Available">
        <div className="agent-cli-head">
          <p className="global-settings-resp-title">Agent CLI Available</p>
        </div>
        <p className="global-settings-help">Whether each Agent CLI is installed and discoverable on this machine's PATH, with its detected version. Carriers can only run on an Agent CLI shown as available here.</p>
        {error ? <p className="settings-error">{error}</p> : null}
        <div className="agent-cli-list">
          {clis.map((cli) => <AgentCliRow key={cli.id} cli={cli} />)}
        </div>
        <p className="global-settings-foot">Install or update a CLI, then reopen this page to re-check availability.</p>
      </section>
    </>
  );
}

function SystemPromptSettingsBlock() {
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card" aria-label="System Prompt">
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <>
          <SettingToggleRow
            title="System Prompt Injection"
            help="Append keeps the Agent CLI's built-in system prompt and layers Fleet doctrine on top. Replace swaps it entirely for Fleet doctrine. Affects Claude-family CLIs only; Codex always receives doctrine through its profile."
            onLabel="Replace"
            offLabel="Append"
            value={state.replaceSystemPrompt}
            disabled={saving}
            onToggle={() => void setSystemPromptSettingsField("replaceSystemPrompt", !state.replaceSystemPrompt)}
          />
          <SettingToggleRow
            title="Metaphor"
            help="Enabled layers the naval tone overlay — clipped reporting cadence and Fleet vocabulary — onto every session. Off keeps the Admiral persona without the tone."
            onLabel="Enabled"
            offLabel="Off"
            value={state.enableMetaphor}
            disabled={saving}
            onToggle={() => void setSystemPromptSettingsField("enableMetaphor", !state.enableMetaphor)}
          />
        </>
      ) : (
        <p className="global-settings-help">{settings.loading ? "Loading settings." : "Settings unavailable."}</p>
      )}
      <p className="global-settings-foot">Changes apply to newly launched sessions. Running sessions keep their current configuration until relaunched.</p>
    </section>
  );
}

function SettingToggleRow({ title, help, onLabel, offLabel, value, disabled, onToggle }: SettingToggleRowProps) {
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">{title}</p>
        <p className="global-settings-help">{help}</p>
      </div>
      <button
        type="button"
        className={`global-settings-toggle ${value ? "is-on" : ""}`}
        disabled={disabled}
        aria-pressed={value}
        onClick={onToggle}
      >
        <span>{value ? onLabel : offLabel}</span>
      </button>
    </div>
  );
}

function ModelAuthBlock() {
  const store = useModelAuthStore();

  React.useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card" aria-label="Model sign-in">
      <div className="model-auth-head">
        <p className="global-settings-resp-title">Model Sign-in</p>
        <p className="global-settings-help">
          Register a provider API key so carriers can run on that model. Keys are validated against the provider, stored
          locally, and never shown back in the browser.
        </p>
      </div>

      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">Loading sign-in state.</p> : null}

      {store.state?.providers.map((provider) => (
        <ProviderRow key={provider.cli} provider={provider} busy={store.busyCli === provider.cli} />
      ))}

      <p className="global-settings-foot">Sign-in changes apply to newly launched sessions. Running sessions keep their current credentials until relaunched.</p>
    </section>
  );
}

function ProviderRow({ provider, busy }: ProviderRowProps) {
  const [apiKey, setApiKey] = React.useState("");

  const handleSignIn = async () => {
    const ok = await signInModel(provider.cli, apiKey);
    if (ok) setApiKey("");
  };

  const handleSignOut = async () => {
    await signOutModel(provider.cli);
  };

  return (
    <div className="model-auth-row">
      <div className="model-auth-row-head">
        <span className="model-auth-name">{provider.displayName}</span>
        <span className={`model-auth-status ${provider.signedIn ? "is-on" : ""}`}>
          {provider.signedIn ? "Signed in" : "Not signed in"}
        </span>
      </div>

      {provider.signedIn ? (
        <div className="model-auth-actions">
          <button type="button" className="model-auth-button" disabled={busy} onClick={() => void handleSignOut()}>
            {busy ? "Working…" : "Sign out"}
          </button>
        </div>
      ) : (
        <form
          className="model-auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSignIn();
          }}
        >
          <input
            type="password"
            className="model-auth-input"
            placeholder="API key"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label={`${provider.displayName} API key`}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button type="submit" className="model-auth-button is-primary" disabled={busy || apiKey.trim().length === 0}>
            {busy ? "Verifying…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
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
