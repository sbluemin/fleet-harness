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

interface DockRowProps {
  readonly track: TrackView;
  readonly job: JobView;
  readonly multiJob: boolean;
  readonly singleTrack: boolean;
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
const DOCK_EXPANDED_KEY = "fleet-plugin.terminal.stream-dock-expanded";
// Signal Strip 개편 이전 접힘 키 — 신규 코드는 읽지 않으며 초기화 시 1회 제거만 한다.
const LEGACY_DOCK_COLLAPSED_KEY = "fleet-plugin.terminal.stream-dock-collapsed";
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
  renderLaunchIcon: (kind) => {
    if (kind.id === "claude") return <ClaudeGlyph />;
    if (kind.id === "codex") return <CodexGlyph />;
    return <AgentGlyph />;
  },
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

function useDockExpanded(): [boolean, (next: boolean) => void] {
  // 기본값 접힘(false). 펼치면 "true" 저장, 접으면 키 제거.
  const [expanded, setExpandedState] = React.useState(() => {
    try {
      localStorage.removeItem(LEGACY_DOCK_COLLAPSED_KEY);
      return localStorage.getItem(DOCK_EXPANDED_KEY) === "true";
    } catch {
      return false;
    }
  });

  const setExpanded = React.useCallback((next: boolean) => {
    try {
      if (next) {
        localStorage.setItem(DOCK_EXPANDED_KEY, "true");
      } else {
        localStorage.removeItem(DOCK_EXPANDED_KEY);
      }
    } catch {
      // localStorage 비가용 환경 무시
    }
    setExpandedState(next);
  }, []);

  return [expanded, setExpanded];
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
  const [expanded, setExpanded] = useDockExpanded();
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
  const resetKey = `${expanded}:${activeJobs.map((j) => j.jobId).join(",")}`;
  const { containerRef, pinned, jumpToLatest } = usePinnedScrollLocal(resetKey, contentKey);

  // 스트립 라인 라이브 캐럿: 활성 트랙 중 하나라도 라이브면 표시
  const stripIsLive = activeJobs.some((job) =>
    job.trackOrder.some((id) => {
      const t = job.tracks[id];
      return t ? isTrackLive(t.status) : false;
    })
  );

  return (
    <div className="job-dock" data-signature={sig}>
      <div className="job-dock-strip">
        <span className="job-dock-dot" aria-hidden="true" />
        <span className="job-dock-carrier" data-captain={captain} title={jobLabel}>{carrierLabel}</span>
        <span className="job-dock-strip-line" style={expanded ? { display: "none" } : undefined} aria-hidden="true">
          {tailText}
          {!expanded && stripIsLive && tailText ? <span className="job-dock-caret" aria-hidden="true" /> : null}
        </span>
        <span className="job-dock-meta">
          {elapsed ? <span>{elapsed}</span> : null}
          {tokenLabel ? <span>{tokenLabel}</span> : null}
        </span>
        <button
          type="button"
          className="job-dock-grip"
          aria-label={expanded ? "Collapse stream dock" : "Expand stream dock"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "▼" : "▲"}
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
      <div className={`job-dock-body-wrap${expanded ? "" : " is-collapsed"}`}>
        <div ref={containerRef} className="job-dock-body" tabIndex={-1}>
          {activeJobs.length === 1 && jobLabel ? (
            <div className="job-dock-row">
              <span className="job-dock-row-label">{jobLabel}</span>
            </div>
          ) : null}
          {activeJobs.map((job) => {
            const multiJob = activeJobs.length > 1;
            const singleTrack = !multiJob && job.trackOrder.length === 1;
            return job.trackOrder.map((trackId) => {
              const track = job.tracks[trackId];
              return track ? (
                <DockRow
                  key={`${job.jobId}:${trackId}`}
                  track={track}
                  job={job}
                  multiJob={multiJob}
                  singleTrack={singleTrack}
                />
              ) : null;
            });
          })}
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

function DockRow({ track, job, multiJob, singleTrack }: DockRowProps) {
  const isLive = isTrackLive(track.status);
  const tailOutput = getLastLine(track.text);
  const tailThought = getLastLine(track.thought);
  const displayLine = tailOutput || tailThought;
  const isThought = !tailOutput && Boolean(tailThought);
  const activeTool = isLive ? getActiveToolName(track) : undefined;

  // 멀티잡=캡틴색, 단일잡+멀티트랙=무채색, 단일잡+단일트랙=생략
  const showName = multiJob || !singleTrack;
  const nameCaptain = multiJob ? resolveCarrierCaptain(job.ownerCarrierId) : undefined;

  return (
    <div className="job-dock-row">
      {showName ? (
        <span className="job-dock-row-name" data-captain={nameCaptain}>{track.displayName}</span>
      ) : null}
      <span className={`job-dock-row-status${isLive ? " job-dock-row-status--live" : ""}`}>
        {track.status}{activeTool ? ` · ${activeTool}` : ""}
      </span>
      {displayLine ? (
        <span className={`job-dock-row-line${isThought ? " is-thought" : ""}`}>
          {displayLine}
          {isLive ? <span className="job-dock-caret" aria-hidden="true" /> : null}
        </span>
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

function isTrackLive(status: string): boolean {
  return status === "stream" || status === "live" || status === "running" || status === "active";
}

function getActiveToolName(track: TrackView): string | undefined {
  const tool = track.tools.find(
    (t) => t.status !== "completed" && t.status !== "failed" && t.status !== "error"
  );
  return tool ? (tool.name ?? tool.id) : undefined;
}

function getDockTailText(activeJobs: readonly JobView[]): string {
  // 모든 활성 트랙을 트랙별 lastEventId(전역 단조 증가) 최신순으로 정렬해, 가장 최근 활동 트랙의
  // latestLine(리듀서가 text/thought 델타 중 가장 최근 것으로 갱신)을 접힘 테일로 고른다.
  // 잡·트랙 삽입 순서나 text/thought 우선순위가 아니라 실제 이벤트 순서를 따른다.
  const tracks = activeJobs
    .flatMap((job) => job.trackOrder.map((trackId) => job.tracks[trackId]))
    .filter((track): track is TrackView => Boolean(track))
    .sort((a, b) => b.lastEventId - a.lastEventId);
  for (const track of tracks) {
    if (track.latestLine) return track.latestLine;
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
  // 라이브 판정은 isTrackLive 단일 소유 — 도크 행/스트립 캐럿과 판정이 갈라지지 않게 위임한다.
  if (isTrackLive(status)) {
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

function ClaudeGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="currentColor" />
    </svg>
  );
}

function CodexGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="currentColor" />
    </svg>
  );
}

export { formatElapsedDuration, formatTokenEstimate, estimateJobTokens, resolveJobSignature, resolveCarrierCaptain } from "./helpers.js";
