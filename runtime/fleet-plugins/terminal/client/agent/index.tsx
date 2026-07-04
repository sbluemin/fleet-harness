import { defineNotificationKind } from "@fleet-console/sdk/notifications/browser";
import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import { definePlugin, React, type PluginInstallContext } from "@fleet-console/sdk/plugin/browser";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { TerminalSurface } from "../shared/index.js";
import { CURATED_TERMINAL_FONTS, TERMINAL_FONT_SIZE_RANGE, curatedTerminalFontById, resolveTerminalFont } from "../shared/terminal-font.js";
import { useTerminalPrefs, setTerminalRenderer, setTerminalFont, setCustomTerminalFont, setTerminalFontSize } from "../shared/terminal-prefs-store.js";
import type { TerminalFontSettings, TerminalFontId, TerminalRenderer } from "../shared/types.js";

import { createAgentSession, fetchAgentCliState, resumeAgentSession, terminateAgentSession } from "./api.js";
import { startAgentConnection } from "./connection.js";
import { formatElapsedDuration, formatTokenEstimate, estimateJobTokens, resolveJobSignature, resolveCarrierCaptain } from "./helpers.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "./settings-store.js";
import { isTerminalJobStatus } from "./reduce.js";
import { applySessionUpdate, hydrateAgentClis, removeSession, selectSession, sessionJobs, useAgentState } from "./store.js";
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

interface TerminalFontCardProps {
  readonly active: boolean;
  readonly font: {
    readonly id: TerminalFontId;
    readonly name: string;
    readonly family: string;
    readonly meta: string;
  };
  readonly onSelect: () => void;
}

interface RendererOption {
  readonly id: TerminalRenderer;
  readonly label: string;
}

interface PinnedScrollLocal {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly pinned: boolean;
  readonly jumpToLatest: () => void;
}

const RENDERERS: readonly RendererOption[] = [
  { id: "webgl", label: "WebGL" },
  { id: "dom", label: "DOM" },
];

const AGENT_TICKET_PATH = "/plugins/terminal/agent/ticket";
const TERMINAL_WS_PATH = "/plugins/terminal/ws";
const DOCK_COLLAPSED_KEY = "fleet-plugin.terminal.stream-dock-collapsed";
const PIN_SLACK_PX = 56;

export const agentOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "agent",
  title: "Agent",
  subtitle: (operation) => readPayloadString(operation.payload, "cliLabel") ?? undefined,
  render: (context) => <AgentOperationView context={context} />,
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

// id에 ".end"를 포함시켜 core mapNotificationKind가 이 알림을 "ended"(turn 종료)로 분류하게 한다.
// (idle 전이 = 에이전트 턴 종료이므로 ALERTS에서 "Stood down"으로 표시되어야 한다.)
export const agentEndedNotification = defineNotificationKind({
  id: "agent.ended",
  title: "Agent turn ended",
});

export const agentPlugin = definePlugin({
  id: "terminal",
  operationKinds: [agentOperationKind],
  settingsSections: [agentSettingsSection],
  notificationKinds: [agentAttentionNotification, agentEndedNotification],
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

export const operationKinds = [agentOperationKind] as const;
export const plugins = [agentPlugin] as const;

function installAgentPlugin(ctx: PluginInstallContext): () => void {
  return startAgentConnection({
    operations: ctx.operations,
    notifications: ctx.notifications,
    status: ctx.status,
    refreshOperations: ctx.api.resync,
  });
}

// core를 import하지 않고 pin-to-bottom 패턴을 플러그인 로컬로 복제한다.
function usePinnedScrollLocal(resetKey: unknown, contentKey: unknown): PinnedScrollLocal {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const pinnedRef = React.useRef(true);
  const [pinned, setPinned] = React.useState(true);

  const updatePinned = React.useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      updatePinned(distance <= PIN_SLACK_PX);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [updatePinned]);

  React.useLayoutEffect(() => {
    updatePinned(true);
    const container = containerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [resetKey, updatePinned]);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !pinnedRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [contentKey]);

  const jumpToLatest = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    container.focus({ preventScroll: true });
    updatePinned(true);
  }, [updatePinned]);

  return { containerRef, pinned, jumpToLatest };
}

function useDockCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = React.useState(() => {
    try {
      return localStorage.getItem(DOCK_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  const setCollapsed = React.useCallback((next: boolean) => {
    try {
      if (next) {
        localStorage.setItem(DOCK_COLLAPSED_KEY, "true");
      } else {
        localStorage.removeItem(DOCK_COLLAPSED_KEY);
      }
    } catch {
      // localStorage 비가용 환경 무시
    }
    setCollapsedState(next);
  }, []);

  return [collapsed, setCollapsed];
}

function useElapsed(startedAt: number | undefined): string {
  const [now, setNow] = React.useState(Date.now);

  React.useEffect(() => {
    if (startedAt === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (startedAt === undefined) return "";
  return formatElapsedDuration(now - startedAt);
}

function AgentOperationView({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);
  const [modalOpen, setModalOpen] = React.useState(false);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const detailBtnRef = React.useRef<HTMLButtonElement | null>(null);

  const jobs = sessionJobs(session);
  const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));

  const closeModal = React.useCallback(() => {
    setModalOpen(false);
    detailBtnRef.current?.focus();
  }, []);

  // [M2] paint 전 동기 포커스 이동으로 순간 배경 포커스 잔류 방지
  React.useLayoutEffect(() => {
    if (modalOpen) {
      closeButtonRef.current?.focus();
    }
  }, [modalOpen]);

  // Escape 키로 모달 닫기 + focus trap — capture phase로 전역 단축키보다 먼저 처리한다.
  React.useEffect(() => {
    if (!modalOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeModal();
        return;
      }
      if (event.key === "Tab") {
        // [L3] querySelector 대신 overlayRef로 방어성 강화
        const overlay = overlayRef.current;
        if (!overlay) return;
        const focusable = Array.from(
          overlay.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled"));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [modalOpen, closeModal]);

  if (session.status === "dormant") {
    return (
      <button type="button" className="canvas-operation-dormant" onClick={() => { void resumeSession(session.sessionId); }}>
        <span className="canvas-operation-dormant-status">Dormant</span>
        <span className="canvas-operation-dormant-action">Resume</span>
      </button>
    );
  }

  return (
    <div className="agent-stream-host">
      <TerminalSurface
        operationId={session.sessionId}
        ticketPath={AGENT_TICKET_PATH}
        wsPath={TERMINAL_WS_PATH}
        active={context.active}
        zoom={context.zoom}
        theme={context.theme}
        onExit={() => removeSession(session.sessionId)}
      />
      {activeJobs.length > 0 ? (
        <StreamDock activeJobs={activeJobs} onOpenDetail={() => setModalOpen(true)} detailBtnRef={detailBtnRef} />
      ) : null}
      {modalOpen ? (
        <div ref={overlayRef} className="job-overlay" role="dialog" aria-modal="true" aria-label="Carrier stream details">
          <button type="button" className="job-overlay-scrim" aria-label="Close" tabIndex={-1} onClick={closeModal} />
          <div className="job-overlay-card">
            <button ref={closeButtonRef} type="button" className="job-overlay-close" aria-label="Close" onClick={closeModal}>×</button>
            <div className="job-overlay-body">
              {activeJobs.length === 0 ? (
                <p className="job-overlay-empty">No active streams.</p>
              ) : (
                activeJobs.map((job) => <JobDetailContent key={job.jobId} job={job} />)
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StreamDock({
  activeJobs,
  onOpenDetail,
  detailBtnRef,
}: {
  readonly activeJobs: readonly JobView[];
  readonly onOpenDetail: () => void;
  readonly detailBtnRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [collapsed, setCollapsed] = useDockCollapsed();
  const primaryJob = activeJobs[0];
  const elapsed = useElapsed(primaryJob?.startedAt);
  const totalTokens = activeJobs.reduce((sum, job) => sum + estimateJobTokens(job), 0);
  const tokenLabel = formatTokenEstimate(totalTokens);

  const sig = activeJobs.length === 1 && primaryJob ? resolveJobSignature(primaryJob) : undefined;
  const captain = activeJobs.length === 1 && primaryJob ? resolveCarrierCaptain(primaryJob.ownerCarrierId) : undefined;
  const jobLabel = activeJobs.length === 1 && primaryJob ? primaryJob.label : undefined;

  const carrierLabel = activeJobs.length > 1
    ? `${activeJobs.length} carriers`
    : (primaryJob?.ownerCarrierId ?? "Carrier");

  const tailText = getDockTailText(activeJobs);
  const contentKey = activeJobs.map((j) => `${j.jobId}:${j.lastEventId}`).join(",");
  const resetKey = `${!collapsed}:${activeJobs.map((j) => j.jobId).join(",")}`;
  const { containerRef, pinned, jumpToLatest } = usePinnedScrollLocal(resetKey, contentKey);

  return (
    <div className="job-dock" data-signature={sig}>
      <div className="job-dock-header">
        <span className="job-dock-dot" aria-hidden="true" />
        <span className="job-dock-carrier" data-captain={captain}>{carrierLabel}</span>
        <span className="job-dock-meta">
          {elapsed ? <span>{elapsed}</span> : null}
          {tokenLabel ? <span>{tokenLabel}</span> : null}
        </span>
        <button
          type="button"
          className="job-dock-grip"
          aria-label={collapsed ? "Expand stream dock" : "Collapse stream dock"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? "▲" : "▼"}
        </button>
        <button
          ref={detailBtnRef}
          type="button"
          className="job-dock-detail-btn"
          onClick={onOpenDetail}
        >
          Details
        </button>
      </div>
      {jobLabel ? <div className="job-dock-label" title={jobLabel}>{jobLabel}</div> : null}
      {collapsed ? (
        tailText ? <div className="job-dock-tail" aria-hidden="true">{tailText}</div> : null
      ) : null}
      <div className={`job-dock-body-wrap${collapsed ? " is-collapsed" : ""}`}>
        <div ref={containerRef} className="job-dock-body" tabIndex={-1}>
          {activeJobs.map((job) =>
            job.trackOrder.map((trackId) => {
              const track = job.tracks[trackId];
              return track ? <DockTrackRow key={`${job.jobId}:${trackId}`} track={track} /> : null;
            })
          )}
        </div>
        {!pinned ? (
          <button type="button" className="follow-button" onClick={jumpToLatest}>
            ↓ Follow
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DockTrackRow({ track }: { readonly track: TrackView }) {
  const isLive = trackCardModifier(track.status) === "track-card--live";
  const tailOutput = getLastLine(track.text);
  const tailThought = getLastLine(track.thought);
  return (
    <div className="job-dock-track">
      <div className="job-dock-track-head">
        <span className="job-dock-track-name">{track.displayName}</span>
        <span className={`job-dock-track-status${isLive ? " job-dock-track-status--live" : ""}`}>
          {track.status}
        </span>
      </div>
      {!tailOutput && tailThought ? (
        <div className="job-dock-track-thought" aria-label="Thinking">{tailThought}</div>
      ) : null}
      {tailOutput ? (
        <div className="job-dock-track-text">
          {tailOutput}
          {isLive ? <span className="job-dock-caret" aria-hidden="true" /> : null}
        </div>
      ) : null}
      {track.tools.length > 0 ? (
        <div className="job-dock-tools">
          {track.tools.map((tool) => {
            const isDone = tool.status === "completed" || tool.status === "failed" || tool.status === "error";
            const chipLive = isLive && !isDone;
            return (
              <span
                key={tool.id}
                className={`job-dock-tool-chip${chipLive ? " job-dock-tool-chip--live" : ""}`}
              >
                {tool.name ?? tool.id}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AgentCliSection() {
  const [clis, setClis] = React.useState<readonly AgentCliStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const { renderer: terminalRenderer, font: terminalFont } = useTerminalPrefs();

  React.useEffect(() => {
    const abort = new AbortController();
    void fetchAgentCliState(abort.signal)
      .then((next) => setClis(next.clis))
      .catch((err) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => abort.abort();
  }, []);

  // 카드 4개를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <SystemPromptSettingsBlock />
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
      <TerminalFontSettingsCard terminalFont={terminalFont} />
      <TerminalRendererCard terminalRenderer={terminalRenderer} />
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
            help="Append keeps the Agent CLI's built-in system prompt and layers Fleet doctrine on top. Replace swaps it entirely for Fleet doctrine. Affects Claude Code only; Codex always receives doctrine through its profile."
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

function JobDetailContent({ job }: { readonly job: JobView }) {
  return (
    <>
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
    </>
  );
}

function TrackCard({ track }: { readonly track: TrackView }) {
  const modifier = trackCardModifier(track.status);
  const isLive = modifier === "track-card--live";
  return (
    <article className={modifier ? `track-card ${modifier}` : "track-card"}>
      <header className="track-card-head">
        <span className="track-card-title">{track.displayName}</span>
        <span className="track-card-status">{track.status}</span>
      </header>
      {track.thought ? (
        <div className="track-card-thought" role="group" aria-label="Thinking">
          <span className="track-card-section-label" aria-hidden="true">thinking</span>
          <pre>{track.thought}</pre>
        </div>
      ) : null}
      {track.text ? (
        <div className="track-card-text" role="group" aria-label="Output">
          <span className="track-card-section-label track-card-section-label--output" aria-hidden="true">output</span>
          <pre>{track.text}{isLive ? <span className="track-card-caret" aria-hidden="true" /> : null}</pre>
        </div>
      ) : null}
      {track.error ? (
        <div className="track-card-error" role="group" aria-label="Error">{track.error}</div>
      ) : null}
      {track.tools.length > 0 ? (
        <ul className="track-card-tools">
          {track.tools.map((tool) => <li key={tool.id}>{tool.name ?? tool.id}</li>)}
        </ul>
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
    cwdLabel: context.operation.title || "Workspace",
    label: context.operation.title,
    cliId: readPayloadString(context.operation.payload, "cliId") ?? undefined,
    cliLabel: readPayloadString(context.operation.payload, "cliLabel") ?? undefined,
    status: "dormant",
    turnState: "none",
    createdAt: context.operation.ts.createdAt,
    theaterId: context.theaterId,
    tenantId: readPayloadString(context.operation.payload, "tenantId") ?? undefined,
    registrationId: readPayloadString(context.operation.payload, "registrationId") ?? undefined,
    resumeAvailable: true,
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

function getDockTailText(activeJobs: readonly JobView[]): string {
  // activeJobs는 newest-first(신규 잡이 앞에 prepend)이므로, 접힘 테일은 가장 최근 잡부터 훑어 최신 출력 1줄을 고른다.
  for (let jobIdx = 0; jobIdx < activeJobs.length; jobIdx++) {
    const job = activeJobs[jobIdx];
    if (!job) continue;
    for (let trackIdx = job.trackOrder.length - 1; trackIdx >= 0; trackIdx--) {
      const trackId = job.trackOrder[trackIdx];
      if (!trackId) continue;
      const track = job.tracks[trackId];
      if (!track) continue;
      const last = getLastLine(track.text) || getLastLine(track.thought);
      if (last) return last;
    }
  }
  return "";
}

function getLastLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

function TerminalFontSettingsCard({ terminalFont }: { readonly terminalFont: TerminalFontSettings }) {
  const resolution = resolveTerminalFont(terminalFont);
  const currentFontLabel = terminalFontLabel(terminalFont);
  return (
    <section className="global-settings-card" aria-label="Terminal Font">
      <div className="global-settings-row is-stack">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Terminal Font <span className="new-badge">New</span></p>
          <p className="global-settings-help" id="terminal-font-help">Typeface and size for every terminal panel — agent-cli and shell alike. Applies live to all open terminals; remembered on this browser.</p>
        </div>

        <div className="font-control" aria-describedby="terminal-font-help">
          <div className="current-readout" aria-live="polite">
            <span className="cr-label">Currently</span>
            <span className="cr-value">{currentFontLabel}</span>
            <span className="cr-sep">·</span>
            <span className="cr-value">{terminalFont.size}px</span>
            <span className="cr-sep">·</span>
            <span className={`cr-value ${resolution.status === "fallback" ? "is-fallback" : "is-ok"}`}>{resolution.status}</span>
          </div>

          <div className="font-cards" role="group" aria-label="Terminal font family">
            {CURATED_TERMINAL_FONTS.map((font) => (
              <TerminalFontCard
                key={font.id}
                font={font}
                active={terminalFont.source === "curated" && terminalFont.id === font.id}
                onSelect={() => setTerminalFont(font.id)}
              />
            ))}
            <button
              type="button"
              aria-pressed={terminalFont.source === "custom"}
              className={`font-card ${terminalFont.source === "custom" ? "is-active" : ""}`}
              onClick={() => {
                if (terminalFont.source !== "custom") setCustomTerminalFont("");
              }}
            >
              <span className="fc-name">Custom…<span className="fc-check" aria-hidden="true">✓</span></span>
              <span className="fc-sample is-custom" aria-hidden="true">type a font</span>
              <span className="fc-meta">your installed face</span>
              <span className="fc-bundled fc-addon">local OS font</span>
            </button>
          </div>

          <div className={`custom-reveal ${terminalFont.source === "custom" ? "is-open" : ""}`}>
            <div className="font-field-wrap">
              <label className="font-field">
                <span className="field-icon" aria-hidden="true">Aa</span>
                <input
                  type="text"
                  spellCheck={false}
                  value={terminalFont.customName}
                  placeholder="e.g. MesloLGS NF, Fira Code, IBM Plex Mono"
                  aria-label="Custom terminal font family"
                  onChange={(event) => setCustomTerminalFont(event.currentTarget.value)}
                />
              </label>
              <div className={`resolve-chip ${resolution.status === "fallback" ? "is-fallback" : "is-ok"}`} aria-live="polite">
                <span className="rc-dot" aria-hidden="true" />
                <span>{terminalFontResolveText(terminalFont)}</span>
              </div>
            </div>
          </div>

          <div className="size-row">
            <div className="size-stepper" role="group" aria-label="Font size">
              <button
                type="button"
                aria-label="Decrease terminal font size"
                disabled={terminalFont.size <= TERMINAL_FONT_SIZE_RANGE.min}
                onClick={() => setTerminalFontSize(terminalFont.size - 1)}
              >
                −
              </button>
              <span className="size-val">{terminalFont.size}<span> px</span></span>
              <button
                type="button"
                aria-label="Increase terminal font size"
                disabled={terminalFont.size >= TERMINAL_FONT_SIZE_RANGE.max}
                onClick={() => setTerminalFontSize(terminalFont.size + 1)}
              >
                +
              </button>
            </div>
            <span className="size-label">Cell size — rescales every panel; zoom stays relative</span>
          </div>
        </div>
      </div>

      <p className="global-settings-foot">Appearance preferences apply immediately and are stored per browser, separate from session settings.</p>
    </section>
  );
}

function TerminalRendererCard({ terminalRenderer }: { readonly terminalRenderer: TerminalRenderer }) {
  return (
    <section className="global-settings-card" aria-label="Terminal Renderer">
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Terminal Renderer</p>
          <p className="global-settings-help">WebGL paints the terminal on the GPU for sharper, faster output; DOM is a compatibility fallback. Switching applies to the live terminal instantly without dropping the session.</p>
        </div>
        <div className="segmented" role="group" aria-label="Terminal renderer">
          {RENDERERS.map((renderer) => {
            const isActive = renderer.id === terminalRenderer;
            return (
              <button
                key={renderer.id}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                onClick={() => setTerminalRenderer(renderer.id)}
              >
                {renderer.label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TerminalFontCard({ active, font, onSelect }: TerminalFontCardProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`font-card ${active ? "is-active" : ""}`}
      onClick={onSelect}
    >
      <span className="fc-name">{font.name}<span className="fc-check" aria-hidden="true">✓</span></span>
      <span className="fc-sample" style={{ fontFamily: font.family }} aria-hidden="true">Ag 0O ─┼ =&gt;</span>
      <span className="fc-meta">{font.meta}</span>
      <span className="fc-bundled">self-hosted</span>
    </button>
  );
}

function terminalFontLabel(font: TerminalFontSettings): string {
  if (font.source === "custom") return font.customName || `${curatedTerminalFontById(null).name} (default)`;
  return curatedTerminalFontById(font.id).name;
}

function terminalFontResolveText(font: TerminalFontSettings): string {
  if (!font.customName) return `Empty — using default ${curatedTerminalFontById(null).name}`;
  const resolution = resolveTerminalFont(font);
  return resolution.status === "resolved"
    ? `"${font.customName}" resolves on this machine`
    : `"${font.customName}" not found — falls back to ${resolution.fallbackName}`;
}

function trackCardModifier(status: string): string {
  if (status === "stream" || status === "live" || status === "running" || status === "active") {
    return "track-card--live";
  }
  if (status === "error") return "track-card--bad";
  if (status === "done" || status === "aborted") return "track-card--idle";
  return "";
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

export { formatElapsedDuration, formatTokenEstimate, estimateJobTokens, resolveJobSignature, resolveCarrierCaptain } from "./helpers.js";
