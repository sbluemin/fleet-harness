import { FontPicker, type FontPickerInstalledFont, type FontPickerSelection } from "@fleet-console/font-picker/browser";
import "@fleet-console/font-picker/styles.css";
import { fetchSystemFonts } from "@fleet-console/font-picker/system-fonts";
import { defineNotificationKind } from "@fleet-console/sdk/notifications/browser";
import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import { definePlugin, React } from "@fleet-console/sdk/plugin/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import { defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import type { OperationRenderContext, PluginInstallContext } from "@fleet-console/sdk/plugin";
import { TerminalSurface } from "../shared/index.js";
import { CURATED_TERMINAL_FONTS, DEFAULT_TERMINAL_FONT, TERMINAL_FONT_SIZE_RANGE } from "../shared/terminal-preferences.js";
import { getTerminalPrefsSnapshot, useTerminalPrefs, setInstalledTerminalFont, setTerminalRenderer, setTerminalFont, setTerminalFontSize } from "../shared/terminal-preferences.js";
import type { TerminalFontId, TerminalFontSettings, TerminalRenderer } from "../shared/terminal-preferences.js";
import { AnalystArtifactsPanel } from "./analysis-artifacts-panel.js";
import { AnalystChatPanel } from "./analysis-chat-panel.js";
import { fetchAnalysisReady } from "./analysis-api.js";
import {
  ANALYST_ARTIFACTS_COMPANION_ID,
  ANALYST_CHAT_COMPANION_ID,
  ANALYST_COMPANION_IDS,
  CARRIER_STREAMS_COMPANION_ID,
  closeAnalystCompanionPanels,
  countRemainingVisibleCompanionPanels,
  isCompanionPanelVisible,
  operationSupportsCarrierStreams,
} from "./analysis-visibility.js";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { currentTerminalLocale, getT, useTerminalLocale, type TerminalMessageKey } from "../i18n/index.js";
import { disposeAnalysisStore, rearmAnalysisArtifacts, useAnalysisStore } from "./analysis-store.js";
import "./analysis.css";
import "./agent-cli.css";

import { createAgentSession, fetchAgentCliDiagnostics, fetchAgentCliState, resumeAgentSession, setAgentCliPath, terminateAgentSession } from "./api.js";
import { startAgentConnection } from "./connection.js";
import { deriveTrackPhase, formatElapsedDuration, isTrackLive, mergeJobIds, resolveCarrierCaptain, resolveToolTone, type TrackPhase } from "./helpers.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore } from "./model-auth.js";
import type { ModelAuthProviderState } from "./model-auth.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "./settings.js";
import type { AiGatewayCatalogModel, AiGatewayCatalogProvider, AiGatewayProviderId, AiGatewaySettings } from "./settings.js";
import { isTerminalJobStatus } from "./reduce.js";
import { StreamedMarkdown } from "./streamed-markdown.js";
import { applySessionUpdate, hydrateAgentClis, removeSession, selectSession, sessionJobs, useAgentState } from "./store.js";
import type { AgentCliDiagnosticsEntry, AgentCliStatus, JobView, SessionInfo, TrackView } from "./types.js";

export { CARRIER_STREAMS_COMPANION_ID };

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

interface PinnedScrollLocal {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly contentRef: React.RefObject<HTMLDivElement | null>;
}

const RENDERER_IDS = ["webgl", "dom"] as const satisfies readonly TerminalRenderer[];

const AGENT_TICKET_PATH = "/plugins/terminal/agent/ticket";
const TERMINAL_WS_PATH = "/plugins/terminal/ws";
const PIN_SLACK_PX = 56;
const TERMINAL_FONT_PICKER_SIZE_RANGE = { ...TERMINAL_FONT_SIZE_RANGE, step: 1, defaultValue: 14 };
const FONT_META_KEYS = {
  cascadia: "terminal.settings.fontMetaCascadia",
  jetbrains: "terminal.settings.fontMetaJetbrains",
  "fira-code": "terminal.settings.fontMetaFiraCode",
  "source-code-pro": "terminal.settings.fontMetaSourceCodePro",
} as const satisfies Record<TerminalFontId, TerminalMessageKey>;
const ANALYSIS_READY_POLL_MS = 5_000;
type AnalysisReadiness = "unknown" | "ready" | "not-ready";

const TRACK_PHASE_COPY_KEYS = {
  live: "terminal.streams.status.live",
  done: "terminal.streams.status.done",
  error: "terminal.streams.status.error",
} as const;

function sortiePhaseText(phase: TrackPhase, t: ReturnType<typeof getT>): string {
  if (phase.kind === "tool" && phase.toolName) return t("terminal.sortie.phase.tool", { tool: phase.toolName });
  if (phase.kind === "writing") return t("terminal.sortie.phase.writing");
  if (phase.kind === "reasoning") return t("terminal.sortie.phase.reasoning");
  return t("terminal.sortie.phase.working");
}

// 상태줄 3행(cwd·모델·권한 모드) + 입력 컴포저 3행(테두리 2 + 프롬프트 1) + 사이 여백 1행.
const AGENT_PREVIEW_CHROME_ROWS = 7;

export const agentOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "agent",
  title: (locale) => getT(locale)("terminal.kind.agent"),
  subtitle: (operation) => readPayloadString(operation.payload, "cliLabel") ?? undefined,
  render: (context) => <AgentOperationView context={context} />,
  // 에이전트 CLI TUI는 화면 바닥에 입력 컴포저와 상태줄(cwd·모델·권한 모드)을 고정으로 그린다 —
  // 실행 중에도 갱신되지 않으므로 호스트 프리뷰는 이 밴드를 프레임 밖으로 밀어낼 수 있다.
  // 밴드의 단위는 px가 아니라 행이다: 셀 높이가 글꼴 크기를 따르므로(TERMINAL_OPTIONS.lineHeight
  // = 1) 현재 글꼴 크기를 곱해 지원 범위(10~22px) 어디서도 같은 행 수가 잘리게 한다.
  // 순정 셸(shellOperationKind)은 바닥까지 출력이 흐르므로 이 값을 선언하지 않는다.
  previewBottomChrome: () => AGENT_PREVIEW_CHROME_ROWS * getTerminalPrefsSnapshot().font.size,
  canOpenCompanions: () => true,
  companions: [
    { id: CARRIER_STREAMS_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.carrierStreams"), hideCaption: true, defaultHidden: true, available: operationSupportsCarrierStreams, shortcut: { code: "KeyC", label: "C" }, render: (context) => <CarrierStreamsPanel context={context} /> },
    { id: ANALYST_CHAT_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.sessionAnalyst"), hideCaption: true, defaultHidden: true, shortcut: { code: "KeyA", label: "A", clusterIds: ANALYST_COMPANION_IDS }, render: (context) => <AnalystChatPanel context={context} /> },
    { id: ANALYST_ARTIFACTS_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.artifacts"), hideCaption: true, defaultHidden: true, render: (context) => <AnalystArtifactsPanel context={context} /> },
  ],
});

export const generalSettingsSection = defineSettingsSection({
  id: "general",
  title: (locale) => getT(locale)("terminal.settings.general"),
  render: () => <GeneralSection />,
});

export const agentSettingsSection = defineSettingsSection({
  id: "agent-cli",
  title: (locale) => getT(locale)("terminal.settings.agentCli"),
  render: () => <AgentCliSection />,
});

export const agentAttentionNotification = defineNotificationKind({
  id: "agent.attention",
  title: (locale) => getT(locale)("terminal.notifications.agentInputWaiting"),
});

// id에 ".end"를 포함시켜 core mapNotificationKind가 이 알림을 "ended"(turn 종료)로 분류하게 한다.
// (idle 전이는 에이전트 턴 종료이므로 ALERTS의 ended 상태로 분류해야 한다.)
export const agentEndedNotification = defineNotificationKind({
  id: "agent.ended",
  title: (locale) => getT(locale)("terminal.notifications.agentTurnEnded"),
});

// resume 실패는 사용자의 다음 행동(Try again / Start fresh)이 필요한 이벤트다.
// ".end"/"done"을 id에 넣지 않아 core mapNotificationKind가 input-waiting으로 분류하게 둔다.
export const agentResumeFailedNotification = defineNotificationKind({
  id: "agent.resume-failed",
  title: (locale) => getT(locale)("terminal.notifications.resumeFailed"),
});

export const agentPlugin = definePlugin({
  id: "terminal",
  operationKinds: [agentOperationKind],
  settingsSections: [generalSettingsSection, agentSettingsSection],
  notificationKinds: [agentAttentionNotification, agentEndedNotification, agentResumeFailedNotification],
  install: (ctx) => installAgentPlugin(ctx),
  closeOperation: async (operationId) => {
    try {
      await terminateAgentSession(operationId);
    } finally {
      disposeAnalysisStore(operationId);
      removeSession(operationId);
    }
  },
  resumeOperation: async (operationId) => {
    // 팔레트 등 프레임 밖 resume 진입점. 실패 알림은 프레임 내 카드가 못 잡는 경로이므로 여기서도 emit한다.
    try {
      await resumeSession(operationId);
      installedNotifications?.dismiss(operationId);
    } catch (error) {
      installedNotifications?.emit({
        kind: agentResumeFailedNotification.id,
        operationId,
        message: getT(currentTerminalLocale())("terminal.notifications.resumeFailedMessage"),
      });
      throw error;
    }
  },
  launch: async ({ theaterId, kind }) => {
    const session = await createAgentSession(theaterId, kind.id);
    applySessionUpdate(session);
    selectSession(session.sessionId);
    return { id: session.sessionId };
  },
  renderLaunchIcon: (kind) => {
    if (kind.id === "claude" || kind.id === "claude-native" || kind.id === "claude-gateway") return <ClaudeGlyph />;
    return <AgentGlyph />;
  },
});

export const operationKinds = [agentOperationKind] as const;
export const plugins = [agentPlugin] as const;

// resumeOperation 훅은 install context를 받지 못하므로 notifications만 모듈 스코프로 캡처한다.
// (같은 프로세스 내 plugin 인스턴스는 하나라 core의 단일 install 계약과 충돌하지 않는다.)
let installedNotifications: PluginInstallContext["notifications"] | null = null;

function installAgentPlugin(ctx: PluginInstallContext): () => void {
  installedNotifications = ctx.notifications;
  const disposeConnection = startAgentConnection({
    operations: ctx.operations,
    notifications: ctx.notifications,
    status: ctx.status,
    refreshOperations: ctx.api.resync,
  });
  return () => {
    installedNotifications = null;
    disposeConnection();
  };
}

// core를 import하지 않고 pin-to-bottom 패턴을 플러그인 로컬로 복제한다.
function usePinnedScrollLocal(resetKey: unknown, contentKey: unknown): PinnedScrollLocal {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const pinnedRef = React.useRef(true);

  const updatePinned = React.useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
  }, []);

  // resetKey가 바뀌면 컬럼별 새 스크롤 컨테이너에 listener를 재부착한다.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      updatePinned(distance <= PIN_SLACK_PX);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [resetKey, updatePinned]);

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

  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const observer = new ResizeObserver(() => {
      // pinnedRef 직독 — 예약된 콜백이 렌더 시점 pinned를 읽으면 사용자의 unpin을 하단 재고정으로 되돌린다.
      if (pinnedRef.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [resetKey]);

  return { containerRef, contentRef };
}

function useElapsed(startedAt: number | undefined, finishedAt: number | undefined): string {
  const [now, setNow] = React.useState(Date.now);

  React.useEffect(() => {
    if (startedAt === undefined || finishedAt !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, finishedAt]);

  if (startedAt === undefined) return "";
  return formatElapsedDuration((finishedAt ?? now) - startedAt);
}

function useAnalysisReady(context: OperationRenderContext): AnalysisReadiness {
  const [result, setResult] = React.useState<{
    readonly operationId: string;
    readonly readiness: AnalysisReadiness;
  }>({ operationId: context.operationId, readiness: "unknown" });
  const readiness = result.operationId === context.operationId ? result.readiness : "unknown";

  React.useEffect(() => {
    let disposed = false;
    let requestPending = false;
    let interval: number | undefined;
    setResult({ operationId: context.operationId, readiness: "unknown" });
    const poll = async () => {
      if (requestPending) return;
      requestPending = true;
      const nextReady = await fetchAnalysisReady(context.api, context.operationId);
      requestPending = false;
      if (disposed) return;
      setResult({
        operationId: context.operationId,
        readiness: nextReady ? "ready" : "not-ready",
      });
      if (nextReady && interval !== undefined) window.clearInterval(interval);
    };
    void poll();
    interval = window.setInterval(() => { void poll(); }, ANALYSIS_READY_POLL_MS);
    return () => {
      disposed = true;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [context.api, context.operationId]);

  return readiness;
}

// 리본은 상태 표면이지 토글이 아니다 — 접근성 이름이 "열기"인 컨트롤이 닫으면 안 된다.
// 여닫는 것은 우측 STREAMS 핸들의 역할이고, 리본은 멱등하게 열기만 한다.
function openCompanionPanel(context: OperationRenderContext, companionId: string): void {
  if (!context.onSetCompanionPanelVisible) {
    context.onRequestCompanions?.(true);
    return;
  }
  if (isCompanionPanelVisible(context, companionId)) return;
  if (!context.companionsOpen) context.onRequestCompanions?.(true);
  context.onSetCompanionPanelVisible(companionId, true);
}

function toggleCompanionPanel(
  context: OperationRenderContext,
  companionId: string,
  clusterIds: readonly string[] = [companionId],
): void {
  if (!context.onSetCompanionPanelVisible) {
    context.onRequestCompanions?.(!context.companionsOpen);
    return;
  }
  const currentlyVisible = isCompanionPanelVisible(context, companionId);
  const nextVisible = !currentlyVisible;
  if (nextVisible) {
    if (!context.companionsOpen) context.onRequestCompanions?.(true);
    context.onSetCompanionPanelVisible(companionId, true);
    return;
  }
  // Artifacts는 Chat 안의 chip으로만 여닫히므로 Chat만 닫으면 닫을 수단이 사라진다.
  for (const id of clusterIds) context.onSetCompanionPanelVisible(id, false);
  const remainingVisibleCount = countRemainingVisibleCompanionPanels(context, clusterIds);
  if (remainingVisibleCount === 0) context.onRequestCompanions?.(false);
}

function SessionAnalystHandle({
  context,
  ready,
  working,
}: {
  readonly context: OperationRenderContext;
  readonly ready: boolean;
  readonly working: boolean;
}) {
  const open = isCompanionPanelVisible(context, ANALYST_CHAT_COMPANION_ID);
  const language = context.language ?? "en";
  const t = getT(language);
  return (
    <button
      type="button"
      className={`session-analyst-handle${ready ? "" : " is-waiting"}${working ? " is-live" : ""}`}
      aria-label={t(open ? "terminal.analyst.exit" : "terminal.analyst.open")}
      aria-pressed={open}
      aria-disabled={!ready}
      disabled={!ready}
      title={ready ? undefined : t("terminal.analyst.sendMessageFirst")}
      onClick={() => { if (ready) toggleCompanionPanel(context, ANALYST_CHAT_COMPANION_ID, ANALYST_COMPANION_IDS); }}
    >
      {working ? <span className="session-analyst-handle__live" aria-hidden="true" /> : null}
      <span className="session-analyst-handle__chev" aria-hidden="true">{open ? "«" : "»"}</span>
      <span className="session-analyst-handle__label">{t(open ? "terminal.handle.exit" : "terminal.handle.analyze")}</span>
    </button>
  );
}

function CarrierStreamsHandle({ context, live }: { readonly context: OperationRenderContext; readonly live: boolean }) {
  const open = isCompanionPanelVisible(context, CARRIER_STREAMS_COMPANION_ID);
  const language = context.language ?? "en";
  const t = getT(language);
  return (
    <button
      type="button"
      className={`session-analyst-handle session-analyst-handle--streams${live ? " is-live" : ""}`}
      aria-label={t(open ? "terminal.streams.exit" : "terminal.streams.open")}
      aria-pressed={open}
      onClick={() => toggleCompanionPanel(context, CARRIER_STREAMS_COMPANION_ID)}
    >
      {live ? <span className="session-analyst-handle__live" aria-hidden="true" /> : null}
      <span className="session-analyst-handle__chev" aria-hidden="true">{open ? "«" : "»"}</span>
      <span className="session-analyst-handle__label">{t(open ? "terminal.handle.exit" : "terminal.handle.streams")}</span>
    </button>
  );
}

const SORTIE_RIBBON_INLINE_LIMIT = 2;

function CarrierSortieRibbon({ context, jobs }: { readonly context: OperationRenderContext; readonly jobs: readonly JobView[] }) {
  const language = context.language ?? "en";
  const t = getT(language);
  const live = jobs.flatMap((job) => isTerminalJobStatus(job.status) ? [] : job.trackOrder.flatMap((trackId) => {
    const track = job.tracks[trackId];
    return track && isTrackLive(track.status) ? [{ job, track }] : [];
  }));
  if (live.length === 0) return null;
  const shown = live.slice(0, SORTIE_RIBBON_INLINE_LIMIT);
  const overflow = live.length - shown.length;
  // aria-label은 자식 텍스트를 덮으므로 화면에 보이는 함장·국면을 이름에 직접 실어야 한다.
  // 그러지 않으면 보조기기 사용자에게는 출격 수만 남고 리본의 본론이 통째로 사라진다.
  const roster = shown
    .map(({ job, track }) => `${track.displayName} ${sortiePhaseText(deriveTrackPhase(track, job.status), t)}`)
    .join(", ");
  const overflowSuffix = overflow > 0 ? `, ${t("terminal.sortie.more", { count: overflow })}` : "";

  return (
    <button
      type="button"
      className="carrier-sortie-ribbon"
      aria-label={`${t("terminal.sortie.open", { count: live.length })}: ${roster}${overflowSuffix}`}
      onClick={() => openCompanionPanel(context, CARRIER_STREAMS_COMPANION_ID)}
    >
      <span className="carrier-sortie-ribbon__scan" aria-hidden="true" />
      <span className="carrier-sortie-ribbon__count">{t("terminal.sortie.count", { count: live.length })}</span>
      <span className="carrier-sortie-ribbon__roster">
        {shown.map(({ job, track }) => {
          const captain = resolveCarrierCaptain(job.ownerCarrierId);
          return (
            <span className="carrier-sortie-ribbon__track" key={`${job.jobId}:${track.trackId}`} data-captain={captain}>
              <span className="carrier-sortie-ribbon__name" title={track.displayName}>{track.displayName}</span>
              <span className="carrier-sortie-ribbon__phase">{sortiePhaseText(deriveTrackPhase(track, job.status), t)}</span>
            </span>
          );
        })}
        {overflow > 0 ? <span className="carrier-sortie-ribbon__more">{t("terminal.sortie.more", { count: overflow })}</span> : null}
      </span>
      <span className="carrier-sortie-ribbon__chev" aria-hidden="true">»</span>
    </button>
  );
}

function AgentOperationView({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);
  const analysisReadiness = useAnalysisReady(context);
  const { state: analysisState } = useAnalysisStore(context);
  const jobs = sessionJobs(session);
  const liveTrackCount = countLiveTracks(jobs);
  const streamsSupported = operationSupportsCarrierStreams(context.operation);
  // 초기값 true: 닫힘 상태로 마운트해도 첫 effect가 re-arm한다(force-drop과 동시 언마운트로
  // EXIT 전이를 관찰하지 못한 경우 복구). Theater 복귀는 companionsOpen=true 마운트라 disarm이 보존된다.
  const previousCompanionsOpenRef = React.useRef(true);

  React.useEffect(() => {
    const companionsOpen = context.companionsOpen ?? false;
    const wasOpen = previousCompanionsOpenRef.current;
    previousCompanionsOpenRef.current = companionsOpen;
    if (wasOpen && !companionsOpen) rearmAnalysisArtifacts(context.operationId);
  }, [context.companionsOpen, context.operationId]);

  React.useEffect(() => {
    if (analysisReadiness !== "not-ready" || !context.companionsOpen || !context.onSetCompanionPanelVisible) return;
    // 단축키는 disabled 핸들 가드를 거치지 않으므로, 준비 전 진입이 빈 companion 배치를 남기지 않게 호스트 레이어까지 함께 정리한다.
    closeAnalystCompanionPanels(context);
  }, [
    analysisReadiness,
    context.companionsOpen,
    context.hiddenCompanionPanelIds,
    context.onRequestCompanions,
    context.onSetCompanionPanelVisible,
  ]);

  const handles = (
    <div className="session-analyst-handle-stack">
      {streamsSupported ? <CarrierStreamsHandle context={context} live={liveTrackCount > 0} /> : null}
      <SessionAnalystHandle context={context} ready={analysisReadiness === "ready"} working={analysisState.busy} />
    </div>
  );

  if (session.status === "dormant") {
    return (
      <div className="agent-stream-host">
        {handles}
        {session.resumeAvailable || isSupportedAgentOperationCliId(session.cliId)
          ? <DormantOperationView context={context} session={session} />
          : <div className="canvas-operation-dormant"><span className="canvas-operation-dormant-status">{getT(context.language ?? "en")("terminal.dormant.status")}</span></div>}
      </div>
    );
  }

  return (
    <div className="agent-stream-host">
      {handles}
      <TerminalSurface
        operationId={session.sessionId}
        ticketPath={AGENT_TICKET_PATH}
        wsPath={TERMINAL_WS_PATH}
        active={context.active}
        keyboardFocusRequestId={context.keyboardFocusRequestId}
        zoom={context.zoom}
        theme={context.theme}
        onStatusDetail={(detail) => context.statusDetail.set(context.operationId, detail)}
        onExit={() => removeSession(session.sessionId)}
      />
      {streamsSupported ? <CarrierSortieRibbon context={context} jobs={jobs} /> : null}
    </div>
  );
}

function CarrierStreamsPanel({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);
  const jobs = sessionJobs(session);
  const language = context.language ?? "en";
  const t = getT(language);
  const [expandedCompletedTrackIds, setExpandedCompletedTrackIds] = React.useState<readonly string[]>([]);
  // 스토어는 종결 잡을 세션 내내 보존한다 — 완료 트랙은 시한부 잔존이 아니라
  // 접힌 스트립으로 세션 끝까지 남아 클릭 전개(보존 기록 열람)를 보장한다.
  const tracks = jobs.flatMap((job) => job.trackOrder.flatMap((trackId) => {
    const track = job.tracks[trackId];
    return track ? [{ job, track }] : [];
  }));
  const liveTrackCount = countLiveTracks(jobs);

  return (
    <section className="carrier-streams" aria-label={t("terminal.companion.carrierStreams")}>
      <header className="session-analyst__panel-head carrier-streams__panel-head">
        <span className="session-analyst__panel-mark" aria-hidden="true">✳</span>
        <span className="session-analyst__panel-copy"><strong>{t("terminal.companion.carrierStreams")}</strong><small>{t("terminal.streams.subtitle")}</small></span>
        <span className={`carrier-streams__state${liveTrackCount > 0 ? " is-live" : ""}`}>
          <i aria-hidden="true" />{liveTrackCount > 0
            ? `${liveTrackCount} ${t("terminal.streams.status.live")}`
            : t("terminal.streams.status.idle")}
        </span>
      </header>
      {tracks.length === 0 ? (
        <div className="carrier-streams__empty">
          <strong>{t("terminal.streams.emptyTitle")}</strong>
          <span>{t("terminal.streams.emptyBody")}</span>
        </div>
      ) : (
        <div className="carrier-streams__board">
          {tracks.map(({ job, track }) => {
            const trackKey = `${job.jobId}:${track.trackId}`;
            const phase = deriveTrackPhase(track, job.status);
            const expanded = phase.tone !== "done" || expandedCompletedTrackIds.includes(trackKey);
            return (
              <CarrierStreamColumn
                key={trackKey}
                job={job}
                track={track}
                language={language}
                expanded={expanded}
                onToggleCompleted={() => {
                  setExpandedCompletedTrackIds((current) => expanded
                    ? current.filter((id) => id !== trackKey)
                    : mergeJobIds(current, [trackKey]));
                }}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function CarrierStreamColumn({
  job,
  track,
  language,
  expanded,
  onToggleCompleted,
}: {
  readonly job: JobView;
  readonly track: TrackView;
  readonly language: ConsoleLocale;
  readonly expanded: boolean;
  readonly onToggleCompleted: () => void;
}) {
  const t = getT(language);
  const phase = deriveTrackPhase(track, job.status);
  const captain = resolveCarrierCaptain(job.ownerCarrierId);
  const elapsed = useElapsed(track.startedAt ?? job.startedAt, track.finishedAt ?? job.finishedAt);
  const request = trackRequestText(job, track);
  const contentKey = `${track.lastEventId}:${track.text.length}:${track.tools.length}`;
  const scroll = usePinnedScrollLocal(`${job.jobId}:${track.trackId}:${expanded}`, contentKey);
  const completed = phase.tone === "done";
  const reasoning = phase.tone === "live" && track.thought.length > 0
    && (track.text.length === 0 || latestTrackEventType(job, track.trackId) === "track:thought");
  // 잡 레벨 오류/요약 폴백은 이 트랙의 phase가 error일 때만 — 혼합 결과 잡에서
  // 성공 트랙 컬럼이 잡 실패 문구를 떠안는 오표기를 막는다(트랙 자체 오류는 항상 표시).
  const error = track.error ?? (phase.tone === "error" ? job.error ?? job.summary : undefined);
  const phaseLabel = t(TRACK_PHASE_COPY_KEYS[phase.tone]);
  const latestTool = track.tools.length > 0 ? track.tools[track.tools.length - 1] : undefined;

  if (completed && !expanded) {
    return (
      <button
        type="button"
        className="carrier-stream-column carrier-stream-column--collapsed"
        data-captain={captain}
        aria-label={`${t("terminal.streams.expand")} · ${track.displayName}`}
        onClick={onToggleCompleted}
      >
        {captain ? <span className="carrier-stream-column__captain-dot" data-captain={captain} aria-hidden="true" /> : null}
        <strong>{track.displayName}</strong>
        <span className="carrier-stream-column__phase" data-tone="done">{t("terminal.streams.status.done")}</span>
        <time>{elapsed}</time>
      </button>
    );
  }

  return (
    <article className="carrier-stream-column" data-captain={captain} data-tone={phase.tone}>
      {phase.tone === "live" ? <span className="carrier-stream-column__scan" aria-hidden="true" /> : null}
      <header className="carrier-stream-column__head">
        {captain ? <span className="carrier-stream-column__captain-dot" data-captain={captain} aria-hidden="true" /> : null}
        <strong title={track.displayName}>{track.displayName}</strong>
        <span className="carrier-stream-column__phase" data-tone={phase.tone}>{phaseLabel}</span>
        {completed ? <button type="button" aria-label={`${t("terminal.streams.collapse")} · ${track.displayName}`} onClick={onToggleCompleted}>‹</button> : null}
      </header>
      <div ref={scroll.containerRef} className="carrier-stream-column__body" tabIndex={0}>
        <div ref={scroll.contentRef} className="carrier-stream-column__content">
          {request ? (
            <div className="carrier-stream-column__request" data-captain={captain}>
              <span className="carrier-stream-column__request-kicker">{t("terminal.streams.dispatchOrder")}</span>
              <p>{request}</p>
            </div>
          ) : null}
          {track.text ? (
            <div className="carrier-stream-column__answer">
              <span aria-hidden="true">✳</span>
              <StreamedMarkdown className="carrier-stream-column__markdown markdown-body" text={track.text} streaming={phase.tone === "live"} language={language} />
            </div>
          ) : null}
          {reasoning ? (
            <div className="carrier-stream-column__reasoning" aria-live="polite">
              <i aria-hidden="true" />
              <span>{t("terminal.streams.reasoning")}</span>
            </div>
          ) : null}
          {error ? <div className="carrier-stream-column__error" role="alert">{error}</div> : null}
          {latestTool ? (
            <div className="carrier-stream-column__activity" data-tone={phase.tone} aria-label={`${t("terminal.streams.activity")} · ${track.displayName}`}>
              {phase.tone === "live" ? <span className="carrier-stream-column__activity-scan" aria-hidden="true" /> : null}
              <div className="carrier-stream-column__activity-main">
                <span className="carrier-stream-column__activity-orbit" data-tone={resolveToolTone(latestTool.status)} aria-hidden="true" />
                <span className="carrier-stream-column__activity-copy">
                  <strong>{t("terminal.analyst.activity.usingTool", { title: latestTool.name ?? latestTool.id })}</strong>
                  {latestTool.status ? <small>{t("terminal.analyst.activity.toolStatus", { status: latestTool.status })}</small> : null}
                  <small>{t("terminal.analyst.lastConfirmedOnly")}</small>
                </span>
                <time>{elapsed}</time>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function countLiveTracks(jobs: readonly JobView[]): number {
  return jobs.reduce((count, job) => {
    if (isTerminalJobStatus(job.status)) return count;
    return count + job.trackOrder.reduce((trackCount, trackId) => {
      const track = job.tracks[trackId];
      return track && isTrackLive(track.status) ? trackCount + 1 : trackCount;
    }, 0);
  }, 0);
}

function trackRequestText(job: JobView, track: TrackView): string {
  if (job.request) {
    const blocks = job.request.blocks.filter((block) => block.present && block.body.trim()).map((block) => block.body.trim());
    if (job.request.additional.trim()) blocks.push(job.request.additional.trim());
    return blocks.join("\n\n");
  }
  return track.requestPreview?.trim() ?? "";
}

function latestTrackEventType(job: JobView, trackId: string): string | undefined {
  for (let index = job.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = job.recentEvents[index];
    if (event?.event.trackId === trackId) return event.type;
  }
  return undefined;
}

function GeneralSection() {
  const { renderer: terminalRenderer, font: terminalFont } = useTerminalPrefs();

  // 카드를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <SystemPromptSettingsBlock />
      <IdleAgentSessionsSettingsBlock />
      <TerminalFontSettingsCard terminalFont={terminalFont} />
      <TerminalRendererCard terminalRenderer={terminalRenderer} />
    </>
  );
}

const IDLE_AGENT_DORMANT_OPTIONS = [
  { value: "off", labelKey: "terminal.settings.idleAgentOff" },
  { value: "30", labelKey: "terminal.settings.idleAgent30m" },
  { value: "60", labelKey: "terminal.settings.idleAgent1h" },
  { value: "120", labelKey: "terminal.settings.idleAgent2h" },
  { value: "240", labelKey: "terminal.settings.idleAgent4h" },
] as const;

function IdleAgentSessionsSettingsBlock() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  const selectValue = state?.agentIdleDormantMinutes === null
    ? "off"
    : state?.agentIdleDormantMinutes !== undefined
      ? String(state.agentIdleDormantMinutes)
      : "60";
  const idleOptions = (() => {
    const options: Array<{ value: string; label: string }> = IDLE_AGENT_DORMANT_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    }));
    const minutes = state?.agentIdleDormantMinutes;
    if (minutes === null || minutes === undefined) return options;
    const value = String(minutes);
    if (options.some((option) => option.value === value)) return options;
    options.push({
      value,
      label: t(
        minutes === 1
          ? "terminal.settings.idleAgentMinutes_one"
          : "terminal.settings.idleAgentMinutes_other",
        { count: minutes },
      ),
    });
    return options;
  })();

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.idleAgent")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <div className="global-settings-row">
          <div className="global-settings-row-text">
            <p className="global-settings-resp-title" id="idle-agent-sessions-label">{t("terminal.settings.idleAgent")}</p>
            <p className="global-settings-help" id="idle-agent-sessions-help">
              {t("terminal.settings.idleAgentHelp")}
            </p>
          </div>
          <Select
            aria-labelledby="idle-agent-sessions-label"
            value={selectValue}
            disabled={saving}
            options={idleOptions}
            onChange={(raw) => {
              const next = raw === "off" ? null : Number(raw);
              void setSystemPromptSettingsField("agentIdleDormantMinutes", next);
            }}
          />
        </div>
      ) : (
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      )}
    </section>
  );
}

function AgentCliSection() {
  const t = getT(useTerminalLocale());
  const [clis, setClis] = React.useState<readonly AgentCliStatus[]>([]);
  const [diagnostics, setDiagnostics] = React.useState<readonly AgentCliDiagnosticsEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const [nextState, nextDiagnostics] = await Promise.all([
      fetchAgentCliState(signal),
      fetchAgentCliDiagnostics(signal),
    ]);
    setClis(nextState.clis);
    setDiagnostics(nextDiagnostics.entries);
    setError(null);
  }, []);

  React.useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal)
      .catch((err) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => abort.abort();
  }, [refresh]);

  // 카드를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <section className="global-settings-card" aria-label={t("terminal.settings.agentCliAvailable")}>
        <div className="agent-cli-head">
          <p className="global-settings-resp-title">{t("terminal.settings.agentCliAvailable")}</p>
        </div>
        <p className="global-settings-help">{t("terminal.settings.agentCliHelp")}</p>
        {error ? <p className="settings-error">{error}</p> : null}
        <div className="agent-cli-list">
          {clis.map((cli) => (
            <AgentCliRow
              key={cli.id}
              cli={cli}
              diagnostics={diagnostics.find((entry) => entry.cliCommand === cli.id)}
              onChanged={refresh}
            />
          ))}
        </div>
        <p className="global-settings-foot">{t("terminal.settings.agentCliFoot")}</p>
      </section>
      <ModelAuthBlock />
      <AiGatewayModelsCard />
      <AiGatewayDiagnosticsCard />
    </>
  );
}

const AI_GATEWAY_PROVIDER_LABEL_KEYS = {
  codex: "terminal.settings.aiGatewayProviderCodex",
  cursor: "terminal.settings.aiGatewayProviderCursor",
  kimi: "terminal.settings.aiGatewayProviderKimi",
  opencode: "terminal.settings.aiGatewayProviderOpencode",
} as const;

const AI_GATEWAY_PROVIDER_SUB_KEYS = {
  codex: "terminal.settings.aiGatewaySubCodex",
  cursor: "terminal.settings.aiGatewaySubCursor",
  kimi: "terminal.settings.aiGatewaySubKimi",
  opencode: "terminal.settings.aiGatewaySubOpencode",
} as const;

function formatAiGatewayContextWindow(contextWindow: number | null): string | null {
  if (contextWindow === null) return null;
  return contextWindow >= 1_000_000 ? "1M" : `${Math.round(contextWindow / 1000)}K`;
}

function AiGatewayDiagnosticsCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayDiagnostics")}>
        <p className="global-settings-resp-title">{t("terminal.settings.aiGatewayDiagnostics")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayDiagnostics")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayDiagnostics")}
        help={t("terminal.settings.aiGatewayDiagnosticsHelp")}
        onLabel={t("terminal.settings.enabled")}
        offLabel={t("terminal.settings.off")}
        value={state.cursorDiagnosticsEnabled}
        disabled={saving}
        onToggle={() => void setSystemPromptSettingsField(
          "cursorDiagnosticsEnabled",
          !state.cursorDiagnosticsEnabled,
        )}
      />
      <SettingToggleRow
        title={t("terminal.settings.aiGatewayWireLog")}
        help={t("terminal.settings.aiGatewayWireLogHelp")}
        onLabel={t("terminal.settings.enabled")}
        offLabel={t("terminal.settings.off")}
        value={state.wireLogEnabled}
        disabled={saving}
        onToggle={() => void setSystemPromptSettingsField("wireLogEnabled", !state.wireLogEnabled)}
      />
      <p className="global-settings-foot">{t("terminal.settings.aiGatewayDiagnosticsFoot")}</p>
    </section>
  );
}

function AiGatewayModelsCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayModels")}>
        <p className="global-settings-resp-title">{t("terminal.settings.aiGatewayModels")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  const selection = state.aiGateway ?? {};
  const enabled = selection.models ?? [];

  const save = (next: AiGatewaySettings): void => {
    const models = next.models ?? [];
    const normalized = models.length === 0 && next.defaultModel === undefined ? null : {
      ...(models.length > 0 ? { models } : {}),
      ...(next.defaultModel !== undefined ? { defaultModel: next.defaultModel } : {}),
    };
    void setSystemPromptSettingsField("aiGateway", normalized);
  };

  const addModel = (model: AiGatewayCatalogModel): void => {
    if (enabled.some((entry) => entry.id === model.id)) return;
    save({ ...selection, models: [...enabled, { id: model.id }] });
  };
  const removeModel = (id: string): void => {
    save({
      models: enabled.filter((entry) => entry.id !== id),
      ...(selection.defaultModel !== undefined && selection.defaultModel !== id
        ? { defaultModel: selection.defaultModel }
        : {}),
    });
  };
  const setDefaultModel = (id: string): void => {
    save({ ...selection, defaultModel: id });
  };
  // 사다리 전체는 부재로 접어 저장한다 — 저장형이 하나여야 "전체 노출"이 두 가지
  // 철자를 갖지 않는다. 마지막 한 단계는 UI가 끄지 못하게 막지만, 여기서도 지킨다.
  const setModelEfforts = (model: AiGatewayCatalogModel, efforts: readonly string[]): void => {
    const ladder = model.effort?.levels ?? [];
    const ordered = ladder.filter((level) => efforts.includes(level));
    if (ordered.length === 0) return;
    save({
      ...selection,
      models: enabled.map((entry) => entry.id !== model.id
        ? entry
        : { id: entry.id, ...(ordered.length === ladder.length ? {} : { efforts: ordered }) }),
    });
  };

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.aiGatewayModels")}>
      <div className="agent-cli-head">
        <p className="global-settings-resp-title">{t("terminal.settings.aiGatewayModels")}</p>
      </div>
      <p className="global-settings-help">{t("terminal.settings.aiGatewayModelsHelp")}</p>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {enabled.length === 0 ? (
        <p className="global-settings-help">{t("terminal.settings.aiGatewayAllExposed")}</p>
      ) : selection.defaultModel === undefined ? (
        <p className="global-settings-help">{t("terminal.settings.aiGatewayDefaultUnset")}</p>
      ) : null}
      {state.aiGatewayCatalog.providers.map((provider) => (
        <AiGatewayProviderBlock
          key={provider.id}
          provider={provider}
          selection={selection}
          saving={saving}
          onAdd={addModel}
          onRemove={removeModel}
          onSetDefault={setDefaultModel}
          onSetEfforts={setModelEfforts}
        />
      ))}
      <p className="global-settings-foot">{t("terminal.settings.aiGatewayModelsFoot")}</p>
    </section>
  );
}

interface AiGatewayProviderBlockProps {
  readonly provider: AiGatewayCatalogProvider;
  readonly selection: AiGatewaySettings;
  readonly saving: boolean;
  readonly onAdd: (model: AiGatewayCatalogModel) => void;
  readonly onRemove: (id: string) => void;
  readonly onSetDefault: (id: string) => void;
  readonly onSetEfforts: (model: AiGatewayCatalogModel, efforts: readonly string[]) => void;
}

function AiGatewayProviderBlock({ provider, selection, saving, onAdd, onRemove, onSetDefault, onSetEfforts }: AiGatewayProviderBlockProps) {
  const t = getT(useTerminalLocale());
  const baseModels = provider.models.filter((model) => !model.fast);
  const [draftBase, setDraftBase] = React.useState(baseModels[0]?.id ?? "");
  const [draftFast, setDraftFast] = React.useState(false);

  const enabledRows = (selection.models ?? []).flatMap((entry) => {
    const model = provider.models.find((candidate) => candidate.id === entry.id);
    return model === undefined ? [] : [{ model, efforts: entry.efforts }];
  });

  const draftBaseModel = provider.models.find((model) => model.id === draftBase) ?? baseModels[0];
  const hasFastPair = draftBaseModel !== undefined
    && provider.models.some((model) => model.id === `${draftBaseModel.id}-fast`);
  const draftModel = draftBaseModel === undefined
    ? undefined
    : draftFast && hasFastPair
      ? provider.models.find((model) => model.id === `${draftBaseModel.id}-fast`)
      : draftBaseModel;
  const draftEnabled = draftModel !== undefined && (selection.models ?? []).some((entry) => entry.id === draftModel.id);
  const providerLabel = t(AI_GATEWAY_PROVIDER_LABEL_KEYS[provider.id as AiGatewayProviderId]);

  return (
    <div className={`ai-gateway-provider is-${provider.id}`}>
      <div className="ai-gateway-provider-head">
        <span className="ai-gateway-provider-glyph" aria-hidden="true"><AiGatewayProviderGlyph provider={provider.id as AiGatewayProviderId} /></span>
        <span className="ai-gateway-provider-name">{providerLabel}</span>
        <span className="ai-gateway-provider-sub">
          {t(AI_GATEWAY_PROVIDER_SUB_KEYS[provider.id as AiGatewayProviderId])}
          {" · "}
          {t("terminal.settings.aiGatewayInCatalog", { count: provider.models.length })}
        </span>
      </div>
      {enabledRows.length === 0 ? (
        <p className="global-settings-help">{t("terminal.settings.aiGatewayNone")}</p>
      ) : (
        <div className="ai-gateway-rows">
          {enabledRows.map(({ model, efforts }) => (
            <AiGatewayModelRow
              key={model.id}
              model={model}
              exposedEfforts={efforts}
              isDefault={selection.defaultModel === model.id}
              saving={saving}
              onRemove={() => onRemove(model.id)}
              onSetDefault={() => onSetDefault(model.id)}
              onSetEfforts={(next) => onSetEfforts(model, next)}
            />
          ))}
        </div>
      )}
      <div className="ai-gateway-composer">
        <span className="ai-gateway-field-label">{t("terminal.settings.aiGatewayAddModel")}</span>
        <Select
          aria-label={t("terminal.settings.aiGatewayAddAria", { provider: providerLabel })}
          value={draftBaseModel?.id ?? ""}
          disabled={saving || baseModels.length === 0}
          options={baseModels.map((model) => ({ value: model.id, label: model.name }))}
          onChange={(value) => {
            setDraftBase(value);
            setDraftFast(false);
          }}
        />
        {hasFastPair ? (
          <button
            type="button"
            className={`ai-gateway-axis-toggle ${draftFast ? "is-on" : ""}`}
            aria-pressed={draftFast}
            disabled={saving}
            onClick={() => setDraftFast((fast) => !fast)}
          >
            {t("terminal.settings.aiGatewayFast")}
          </button>
        ) : null}
        {draftModel ? <AiGatewayModelChips model={draftModel} /> : null}
        {draftEnabled ? <span className="ai-gateway-composer-note">{t("terminal.settings.aiGatewayAlreadyEnabled")}</span> : null}
        <button
          type="button"
          className="ai-gateway-add-button"
          disabled={saving || draftModel === undefined || draftEnabled}
          onClick={() => { if (draftModel) onAdd(draftModel); }}
        >
          {t("terminal.settings.aiGatewayAddModel")}
        </button>
      </div>
    </div>
  );
}

interface AiGatewayModelRowProps {
  readonly model: AiGatewayCatalogModel;
  /** 부재 = 사다리 전체 노출. */
  readonly exposedEfforts?: readonly string[];
  readonly isDefault: boolean;
  readonly saving: boolean;
  readonly onRemove: () => void;
  readonly onSetDefault: () => void;
  readonly onSetEfforts: (efforts: readonly string[]) => void;
}

function AiGatewayModelRow({
  model,
  exposedEfforts,
  isDefault,
  saving,
  onRemove,
  onSetDefault,
  onSetEfforts,
}: AiGatewayModelRowProps) {
  const t = getT(useTerminalLocale());
  const [open, setOpen] = React.useState(false);
  const ladder = model.effort?.levels ?? [];
  const exposed = resolveExposedEfforts(ladder, exposedEfforts);

  return (
    <div className={`ai-gateway-model-entry ${open ? "is-open" : ""}`}>
      <div className="ai-gateway-model-row">
        <button
          type="button"
          className={`ai-gateway-default-star ${isDefault ? "is-on" : ""}`}
          aria-pressed={isDefault}
          aria-label={t("terminal.settings.aiGatewayDefaultAria", { name: model.name })}
          disabled={saving}
          onClick={onSetDefault}
        >
          ★
        </button>
        <span className="ai-gateway-model-text">
          <span className="ai-gateway-model-name">{model.name}</span>
          <span className="ai-gateway-model-id">{model.id}</span>
        </span>
        <AiGatewayModelChips model={model} exposedEfforts={exposedEfforts} />
        {ladder.length > 0 ? (
          <button
            type="button"
            className="ai-gateway-levels-toggle"
            aria-expanded={open}
            aria-label={t("terminal.settings.aiGatewayLevelsAria", { name: model.name })}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="ai-gateway-levels-caret" aria-hidden="true">▸</span>
            {t(open ? "terminal.settings.aiGatewayLevelsHide" : "terminal.settings.aiGatewayLevels")}
          </button>
        ) : null}
        <button
          type="button"
          className="ai-gateway-remove"
          aria-label={t("terminal.settings.aiGatewayRemoveAria", { name: model.name })}
          disabled={saving}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      {open && ladder.length > 0 ? (
        <div className="ai-gateway-levels">
          <div
            className="ai-gateway-level-group"
            role="group"
            aria-label={t("terminal.settings.aiGatewayLevelsAria", { name: model.name })}
          >
            {ladder.map((level) => {
              const isOn = exposed.includes(level);
              return (
                <button
                  key={level}
                  type="button"
                  className={`ai-gateway-level ${isOn ? "is-on" : ""}`}
                  aria-pressed={isOn}
                  // 마지막 한 단계는 끌 수 없다 — 정체성이 0개인 모델은 켜 둔 채로
                  // 쓸 수 없으므로, 그 상태는 아예 만들 수 없게 한다.
                  disabled={saving || (isOn && exposed.length === 1)}
                  onClick={() => onSetEfforts(isOn
                    ? exposed.filter((current) => current !== level)
                    : [...exposed, level])}
                >
                  {level}
                </button>
              );
            })}
          </div>
          <span className="ai-gateway-levels-note">
            {t("terminal.settings.aiGatewayIdentityCount", { count: exposed.length })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** 저장된 선택을 사다리에 대조한다. 부재이거나 겹치는 게 없으면 사다리 전체. */
function resolveExposedEfforts(
  ladder: readonly string[],
  exposedEfforts: readonly string[] | undefined,
): readonly string[] {
  if (!exposedEfforts || exposedEfforts.length === 0) return ladder;
  const narrowed = ladder.filter((level) => exposedEfforts.includes(level));
  return narrowed.length > 0 ? narrowed : ladder;
}

function AiGatewayModelChips({
  model,
  exposedEfforts,
}: {
  readonly model: AiGatewayCatalogModel;
  readonly exposedEfforts?: readonly string[];
}) {
  const t = getT(useTerminalLocale());
  const contextLabel = formatAiGatewayContextWindow(model.contextWindow);
  const ladder = model.effort?.levels ?? [];
  const exposed = resolveExposedEfforts(ladder, exposedEfforts);
  return (
    <span className="ai-gateway-chips">
      {contextLabel ? <span className="ai-gateway-chip">{contextLabel}</span> : null}
      {ladder.length > 0 ? (
        // 칩은 컨트롤이 아니라 속성이다. 좁힌 상태는 세는 값으로만 말하고,
        // 고르는 일은 아래 단계 목록이 맡는다.
        <span className={`ai-gateway-chip ${exposed.length < ladder.length ? "is-strong" : ""}`}>
          {exposed.length < ladder.length
            ? `effort ${exposed.length}/${ladder.length}`
            : `effort ${ladder[0]}–${ladder[ladder.length - 1]}`}
        </span>
      ) : null}
      {model.fast ? <span className="ai-gateway-chip">{t("terminal.settings.aiGatewayFast")}</span> : null}
      {model.maxMode ? <span className="ai-gateway-chip is-strong">{t("terminal.settings.aiGatewayMaxMode")}</span> : null}
      {model.description ? <span className="ai-gateway-chip">{model.description}</span> : null}
    </span>
  );
}

function AiGatewayProviderGlyph({ provider }: { readonly provider: AiGatewayProviderId }) {
  if (provider === "codex") return <CodexGlyph />;
  if (provider === "cursor") return <CursorGlyph />;
  if (provider === "opencode") return <OpencodeGlyph />;
  return <KimiGlyph />;
}

function ModelAuthBlock() {
  const t = getT(useTerminalLocale());
  const store = useModelAuthStore();

  React.useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card" aria-label={t("terminal.auth.modelSignInAria")}>
      <div className="model-auth-head">
        <p className="global-settings-resp-title">{t("terminal.auth.modelSignInTitle")}</p>
        <p className="global-settings-help">{t("terminal.auth.modelSignInHelp")}</p>
      </div>
      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">{t("terminal.auth.loadingSignIn")}</p> : null}
      {store.state?.providers.map((provider) => (
        <ProviderRow key={provider.provider} provider={provider} busy={store.busyProvider === provider.provider} />
      ))}
      <p className="global-settings-foot">{t("terminal.auth.signInFoot")}</p>
    </section>
  );
}

function ProviderRow({ provider, busy }: ProviderRowProps) {
  const t = getT(useTerminalLocale());
  const [apiKey, setApiKey] = React.useState("");

  const handleSignIn = async () => {
    const ok = await signInModel(provider.provider, apiKey);
    if (ok) setApiKey("");
  };

  return (
    <div className="model-auth-row">
      <div className="model-auth-row-head">
        <span className="model-auth-name">{provider.displayName}</span>
        <span className={`model-auth-status ${provider.signedIn ? "is-on" : ""}`}>
          {provider.signedIn ? t("terminal.auth.signedIn") : t("terminal.auth.notSignedIn")}
        </span>
      </div>
      {provider.signedIn ? (
        <div className="model-auth-actions">
          <button type="button" className="model-auth-button" disabled={busy} onClick={() => void signOutModel(provider.provider)}>
            {busy ? t("terminal.auth.working") : t("terminal.auth.signOut")}
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
            placeholder={t("terminal.auth.apiKey")}
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-label={t("terminal.auth.apiKeyAria", { name: provider.displayName })}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button type="submit" className="model-auth-button is-primary" disabled={busy || apiKey.trim().length === 0}>
            {busy ? t("terminal.auth.verifying") : t("terminal.auth.signIn")}
          </button>
        </form>
      )}
    </div>
  );
}

function SystemPromptSettingsBlock() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.systemPromptAria")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <>
          <SettingToggleRow
            title={t("terminal.settings.metaphor")}
            help={t("terminal.settings.metaphorHelp")}
            onLabel={t("terminal.settings.enabled")}
            offLabel={t("terminal.settings.off")}
            value={state.enableMetaphor}
            disabled={saving}
            onToggle={() => void setSystemPromptSettingsField("enableMetaphor", !state.enableMetaphor)}
          />
        </>
      ) : (
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      )}
      <p className="global-settings-foot">{t("terminal.settings.systemPromptFoot")}</p>
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

const AGENT_CLI_PATH_ERROR_KEYS = {
  path_not_absolute: "terminal.settings.agentCliErrorNotAbsolute",
  path_not_found: "terminal.settings.agentCliErrorNotFound",
  path_not_executable: "terminal.settings.agentCliErrorNotExecutable",
  path_not_file: "terminal.settings.agentCliErrorNotFile",
  probe_failed: "terminal.settings.agentCliErrorProbeFailed",
} as const satisfies Record<string, TerminalMessageKey>;

function AgentCliRow({
  cli,
  diagnostics,
  onChanged,
}: {
  readonly cli: AgentCliStatus;
  readonly diagnostics?: AgentCliDiagnosticsEntry;
  readonly onChanged: (signal?: AbortSignal) => Promise<void>;
}) {
  const t = getT(useTerminalLocale());
  const inputId = React.useId();
  const [editing, setEditing] = React.useState(false);
  const [pathValue, setPathValue] = React.useState(diagnostics?.configuredPath ?? "");
  const [busy, setBusy] = React.useState(false);
  const [pathError, setPathError] = React.useState<TerminalMessageKey | null>(null);
  const envManaged = diagnostics?.resolutionSource === "env";
  const userConfigured = diagnostics?.configuredPath !== null && diagnostics?.configuredPath !== undefined;
  const userInvalid = userConfigured && !envManaged && (!cli.available || diagnostics?.resolutionSource !== "user");

  React.useEffect(() => {
    if (!editing) setPathValue(diagnostics?.configuredPath ?? "");
  }, [diagnostics?.configuredPath, editing]);

  const savePath = async (nextPath: string | null) => {
    setBusy(true);
    setPathError(null);
    try {
      await setAgentCliPath(cli.id, nextPath);
      await onChanged();
      setEditing(false);
    } catch (error) {
      const key = error instanceof Error ? AGENT_CLI_PATH_ERROR_KEYS[error.message as keyof typeof AGENT_CLI_PATH_ERROR_KEYS] : undefined;
      setPathError(key ?? "terminal.settings.agentCliErrorProbeFailed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-cli-row">
      <div className="agent-cli-summary">
        <span className="agent-cli-name">{cli.displayName}</span>
        <span className="agent-cli-meta">
          {cli.available && cli.version ? <span className="agent-cli-version">{cli.version}</span> : null}
          <span className={`agent-cli-status ${cli.available ? "is-on" : ""}`}>{cli.available ? t("terminal.settings.available") : t("terminal.settings.missing")}</span>
        </span>
      </div>
      {envManaged ? (
        <div className="agent-cli-path-form">
          <span>{t("terminal.settings.agentCliSourceEnv")}</span>
          <label htmlFor={inputId}>{t("terminal.settings.agentCliPathLabel")}</label>
          <input
            id={inputId}
            className="agent-cli-path-input"
            value={diagnostics?.configuredPath ?? ""}
            placeholder={t("terminal.settings.agentCliPathPlaceholder")}
            disabled
            readOnly
          />
        </div>
      ) : null}
      {userConfigured && !envManaged ? (
        <div className="agent-cli-path-status">
          <span className="agent-cli-configured-path">{diagnostics.configuredPath}</span>
          <span className={userInvalid ? "agent-cli-path-invalid" : "agent-cli-path-source"}>
            {t(userInvalid ? "terminal.settings.agentCliPathInvalid" : "terminal.settings.agentCliSourceUser")}
          </span>
          <button type="button" className="agent-cli-path-button" disabled={busy} onClick={() => { void savePath(null); }}>
            {t("terminal.settings.agentCliPathClear")}
          </button>
        </div>
      ) : null}
      {!envManaged && editing ? (
        <form
          className="agent-cli-path-form"
          onSubmit={(event) => {
            event.preventDefault();
            void savePath(pathValue);
          }}
        >
          <label htmlFor={inputId}>{t("terminal.settings.agentCliPathLabel")}</label>
          <input
            id={inputId}
            className="agent-cli-path-input"
            value={pathValue}
            placeholder={t("terminal.settings.agentCliPathPlaceholder")}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPathValue(event.target.value)}
          />
          <div className="agent-cli-path-actions">
            <button type="submit" className="agent-cli-path-button is-primary" disabled={busy || pathValue.trim().length === 0}>
              {t("terminal.settings.agentCliPathConfirm")}
            </button>
            <button type="button" className="agent-cli-path-button" disabled={busy} onClick={() => { setEditing(false); setPathError(null); }}>
              {t("terminal.settings.agentCliPathCancel")}
            </button>
          </div>
        </form>
      ) : null}
      {!envManaged && !editing && !userConfigured && !cli.available ? (
        <button type="button" className="agent-cli-path-button" onClick={() => setEditing(true)}>
          {t("terminal.settings.agentCliSetPath")}
        </button>
      ) : null}
      {pathError ? <p className="agent-cli-path-error" role="alert">{t(pathError)}</p> : null}
      {diagnostics && diagnostics.searchedPathEntries.length > 0 ? (
        <details className="agent-cli-searched-paths">
          <summary>{t("terminal.settings.agentCliSearchedPaths")}</summary>
          <ul>
            {diagnostics.searchedPathEntries.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

async function resumeSession(sessionId: string, options?: { readonly fresh?: boolean }): Promise<void> {
  applySessionUpdate(await resumeAgentSession(sessionId, options));
  selectSession(sessionId);
}

// dormant 프레임의 resume 상태기계. 실패는 프레임 내 에러 카드(Try again / Start fresh)와
// Alerts 알림(agent.resume-failed) 두 경로로 표면화한다 — 어느 쪽도 침묵하지 않는다.
function DormantOperationView({ context, session }: { readonly context: OperationRenderContext; readonly session: SessionInfo }) {
  const t = getT(context.language ?? "en");
  const freshOnly = !session.resumeAvailable;
  const [resumeState, setResumeState] = React.useState<"idle" | "resuming" | "error">("idle");
  const resume = React.useCallback(async (fresh: boolean) => {
    setResumeState("resuming");
    try {
      await resumeSession(session.sessionId, { fresh });
      // 성공 시 이전 실패 알림을 거둔다 — 두지 않으면 live 세션에 "Resume failed" 뱃지가 남는다.
      context.notifications.dismiss(session.sessionId);
    } catch {
      setResumeState("error");
      context.notifications.emit({
        kind: agentResumeFailedNotification.id,
        operationId: session.sessionId,
        message: t("terminal.notifications.resumeFailedMessage"),
      });
    }
  }, [context, session.sessionId, t]);

  if (resumeState === "error") {
    return (
      <div className="canvas-operation-dormant canvas-operation-dormant--error" role="alert">
        <span className="canvas-operation-dormant-status">{t("terminal.dormant.status")}</span>
        <p className="canvas-operation-dormant-error">
          {freshOnly
            ? t("terminal.dormant.startFreshFailedBody", { name: session.label || session.cwdLabel })
            : t("terminal.dormant.resumeFailedBody", { name: session.label || session.cwdLabel })}
        </p>
        <div className="canvas-operation-dormant-error-actions">
          {freshOnly ? null : (
            <button type="button" className="canvas-operation-dormant-action" onClick={() => { void resume(false); }}>
              {t("terminal.dormant.tryAgain")}
            </button>
          )}
          <button type="button" className="canvas-operation-dormant-action canvas-operation-dormant-action--ghost" onClick={() => { void resume(true); }}>
            {freshOnly ? t("terminal.dormant.tryAgain") : t("terminal.dormant.startFresh")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="canvas-operation-dormant" disabled={resumeState === "resuming"} onClick={() => { void resume(freshOnly); }}>
      <span className="canvas-operation-dormant-status">{t("terminal.dormant.status")}</span>
      <span className={`canvas-operation-dormant-action${resumeState === "resuming" ? " canvas-operation-dormant-action--pending" : ""}`}>
        {resumeState === "resuming"
          ? t(freshOnly ? "terminal.dormant.startingFresh" : "terminal.dormant.resuming")
          : t(freshOnly ? "terminal.dormant.startFresh" : "terminal.dormant.resume")}
      </span>
    </button>
  );
}

function isSupportedAgentOperationCliId(value: string | undefined): boolean {
  return value === "claude" || value === "claude-native" || value === "claude-gateway";
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
    resumeAvailable: context.operation.payload.resumeAvailable === true,
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

function TerminalFontSettingsCard({ terminalFont }: { readonly terminalFont: TerminalFontSettings }) {
  const t = getT(useTerminalLocale());
  const [installedFonts, setInstalledFonts] = React.useState<readonly FontPickerInstalledFont[]>([]);
  const [isLoadingFonts, setIsLoadingFonts] = React.useState(true);
  const [fontLoadFailed, setFontLoadFailed] = React.useState(false);
  const selected = terminalFont.source === "curated" || !terminalFont.customName
    ? { source: "builtin" as const, id: terminalFont.source === "curated" ? terminalFont.id ?? DEFAULT_TERMINAL_FONT.id : DEFAULT_TERMINAL_FONT.id }
    : { source: "system" as const, familyName: terminalFont.customName };

  React.useEffect(() => {
    const controller = new AbortController();
    setIsLoadingFonts(true);
    setFontLoadFailed(false);
    void fetchSystemFonts({ signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setInstalledFonts(response.fonts.filter((font) => font.monospace).map((font) => ({ family: font.family, monospace: font.monospace })));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setInstalledFonts([]);
        setFontLoadFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingFonts(false);
      });
    return () => controller.abort();
  }, []);

  const handleSelectionChange = (next: FontPickerSelection) => {
    if (next.source === "system") {
      setInstalledTerminalFont(next.familyName);
      return;
    }
    const font = CURATED_TERMINAL_FONTS.find((candidate) => candidate.id === next.id);
    if (font) setTerminalFont(font.id);
  };

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.terminalFont")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">{t("terminal.settings.terminalFont")} <span className="new-badge">{t("terminal.settings.terminalFontNew")}</span></p>
          <p className="global-settings-help" id="terminal-font-help">{t("terminal.settings.terminalFontHelp")}</p>
        </div>
      </div>
      <div aria-describedby="terminal-font-help">
          <FontPicker
            builtIns={CURATED_TERMINAL_FONTS.map((font) => ({ id: font.id, label: font.name, family: font.family, aliases: [font.familyName], description: t(FONT_META_KEYS[font.id]) }))}
            installedFonts={installedFonts}
            selected={selected}
            selectedSystemFont={terminalFont.source === "custom" ? terminalFont.customName : null}
            fallbackStack={DEFAULT_TERMINAL_FONT.family}
            previewText={t("terminal.settings.terminalFontPreview")}
            size={terminalFont.size}
            sizeRange={TERMINAL_FONT_PICKER_SIZE_RANGE}
            loading={isLoadingFonts}
            error={fontLoadFailed ? t("terminal.settings.fontLoadError") : null}
            labels={{
              browserAria: t("terminal.settings.fontPicker.browserAria"),
              searchLabel: t("terminal.settings.fontPicker.searchLabel"),
              searchPlaceholder: t("terminal.settings.fontPicker.searchPlaceholder"),
              loading: t("terminal.settings.fontPicker.loading"),
              choicesAria: t("terminal.settings.fontPicker.choicesAria"),
              builtInGroup: t("terminal.settings.fontPicker.builtInGroup"),
              installedGroup: t("terminal.settings.fontPicker.installedGroup"),
              noMatch: t("terminal.settings.fontPicker.noMatch"),
              preview: t("terminal.settings.fontPicker.preview"),
              available: t("terminal.settings.fontPicker.available"),
              unavailable: t("terminal.settings.fontPicker.unavailable"),
              fontSizeAria: t("terminal.settings.fontPicker.fontSizeAria"),
              decreaseSizeAria: t("terminal.settings.fontPicker.decreaseSizeAria"),
              sizeValueAria: t("terminal.settings.fontPicker.sizeValueAria"),
              increaseSizeAria: t("terminal.settings.fontPicker.increaseSizeAria"),
              sizeSliderAria: t("terminal.settings.fontPicker.sizeSliderAria"),
              monospace: t("terminal.settings.fontPicker.monospace"),
              systemFont: t("terminal.settings.fontPicker.systemFont"),
              savedSystemFont: t("terminal.settings.fontPicker.savedSystemFont"),
            }}
            onSelectionChange={handleSelectionChange}
            onSizeCommit={setTerminalFontSize}
          />
      </div>
      <p className="global-settings-foot">{t("terminal.settings.terminalFontFoot")}</p>
    </section>
  );
}

function TerminalRendererCard({ terminalRenderer }: { readonly terminalRenderer: TerminalRenderer }) {
  const t = getT(useTerminalLocale());
  const labels = { webgl: t("terminal.settings.webgl"), dom: t("terminal.settings.dom") } as const;
  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.terminalRenderer")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">{t("terminal.settings.terminalRenderer")}</p>
          <p className="global-settings-help">{t("terminal.settings.terminalRendererHelp")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("terminal.settings.terminalRendererAria")}>
          {RENDERER_IDS.map((rendererId) => {
            const isActive = rendererId === terminalRenderer;
            return (
              <button
                key={rendererId}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                onClick={() => setTerminalRenderer(rendererId)}
              >
                {labels[rendererId]}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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

// AI Gateway provider glyphs. Cursor는 quota/ledger 플러그인이 미러링하는 공식 경로와 동일하고,
// Kimi는 kimi.com 아이콘 번들(statics.moonshot.cn/kimi-web-seo, "TabKimi_f") 출처다.
function CursorGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" fill="currentColor" />
    </svg>
  );
}

function KimiGlyph() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <path fillRule="evenodd" d="M525.019429 157.257143c-201.984 0-365.714286 163.730286-365.714286 365.714286 0 70.326857 19.858286 136.118857 54.345143 191.926857L174.811429 807.570286A58.514286 58.514286 0 0 0 228.790857 888.685714h296.228572c201.947429 0 365.714286-163.730286 365.714285-365.714285s-163.766857-365.714286-365.714285-365.714286z m138.422857 180.114286a45.458286 45.458286 0 0 1 51.2 38.875428l12.361143 90.441143a45.458286 45.458286 0 0 1-90.075429 12.324571l-12.361143-90.441142a45.458286 45.458286 0 0 1 38.875429-51.2z m-195.876572 24.137142a45.458286 45.458286 0 0 1 51.2 38.838858l12.361143 90.441142a45.458286 45.458286 0 1 1-90.038857 12.324572l-12.361143-90.441143a45.458286 45.458286 0 0 1 38.838857-51.2" fill="currentColor" />
    </svg>
  );
}

// OpenCode 공식 로고(anomalyco/opencode brand assets, opencode-logo-*-square.svg)를
// currentColor 2톤(프레임 + 내부 하단 블록)으로 옮긴 마크다.
function OpencodeGlyph() {
  return (
    <svg viewBox="0 0 240 300" aria-hidden="true">
      <path fillRule="evenodd" d="M240 0H0v300h240V0ZM180 60H60v180h120V60Z" fill="currentColor" />
      <path d="M60 120h120v120H60V120Z" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

export { formatElapsedDuration, resolveCarrierCaptain } from "./helpers.js";
