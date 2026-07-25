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
import { CURATED_TERMINAL_FONTS, DEFAULT_TERMINAL_FONT, TERMINAL_FONT_SIZE_RANGE } from "../shared/terminal-font.js";
import { useTerminalPrefs, setInstalledTerminalFont, setTerminalRenderer, setTerminalFont, setTerminalFontSize } from "../shared/terminal-prefs-store.js";
import type { TerminalFontSettings, TerminalRenderer } from "../shared/types.js";
import { AnalystArtifactsPanel } from "./analysis-artifacts-panel.js";
import { ANALYST_ARTIFACTS_COMPANION_ID, AnalystChatPanel } from "./analysis-chat-panel.js";
import { fetchAnalysisReady } from "./analysis-api.js";
import { analysisCopy } from "./analysis-i18n.js";
import { disposeAnalysisStore, rearmAnalysisArtifacts } from "./analysis-store.js";
import "./analysis.css";

import { fetchCarrierSettingsOptions } from "../carriers/api.js";
import type { CarrierSettingsCliOption } from "../../shared/carrier-settings-types.js";
import { createAgentSession, fetchAgentCliState, resumeAgentSession, terminateAgentSession } from "./api.js";
import { startAgentConnection } from "./connection.js";
import { deriveTrackPhase, describeToolTarget, formatElapsedDuration, formatTokenEstimate, estimateJobTokens, getDockTailText, isDockTrackLive, isTrackError, mergeDockJobs, mergeJobIds, pruneRetainedJobs, resolveDockRowStatusLabel, resolveJobSignature, resolveCarrierCaptain, resolveToolTone, retainCompletedJobs, selectJobsByIds } from "./helpers.js";
import type { RetainedJob } from "./helpers.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore } from "./model-auth-store.js";
import type { ModelAuthProviderState } from "./model-auth-api.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "./settings-store.js";
import { isTerminalJobStatus } from "./reduce.js";
import { RequestDetails } from "./request-details.js";
import { StreamedMarkdown } from "./streamed-markdown.js";
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

interface ProviderRowProps {
  readonly provider: ModelAuthProviderState;
  readonly busy: boolean;
}

interface RendererOption {
  readonly id: TerminalRenderer;
  readonly label: string;
}

interface DockRowProps {
  readonly track: TrackView;
  readonly job: JobView;
}

interface PinnedScrollLocal {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly contentRef: React.RefObject<HTMLDivElement | null>;
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
const DOCK_RETENTION_MS = 4_000;
const TERMINAL_FONT_PICKER_SIZE_RANGE = { ...TERMINAL_FONT_SIZE_RANGE, step: 1, defaultValue: 14 };
const TERMINAL_FONT_PREVIEW = "The quick brown fox jumps over 0123456789 — terminal output stays crisp.";
const ANALYSIS_READY_POLL_MS = 5_000;

export const agentOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "agent",
  title: "Agent",
  subtitle: (operation) => readPayloadString(operation.payload, "cliLabel") ?? undefined,
  render: (context) => <AgentOperationView context={context} />,
  canOpenCompanions: ({ api, operation }) => fetchAnalysisReady(api, operation.id),
  companions: [
    { id: "session-analyst-chat", title: "Session Analyst", hideCaption: true, render: (context) => <AnalystChatPanel context={context} /> },
    { id: ANALYST_ARTIFACTS_COMPANION_ID, title: "Artifacts", hideCaption: true, defaultHidden: true, render: (context) => <AnalystArtifactsPanel context={context} /> },
  ],
});

export const generalSettingsSection = defineSettingsSection({
  id: "general",
  title: "General",
  render: () => <GeneralSection />,
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
// (idle 전이는 에이전트 턴 종료이므로 ALERTS의 ended 상태로 분류해야 한다.)
export const agentEndedNotification = defineNotificationKind({
  id: "agent.ended",
  title: "Agent turn ended",
});

// resume 실패는 사용자의 다음 행동(Try again / Start fresh)이 필요한 이벤트다.
// ".end"/"done"을 id에 넣지 않아 core mapNotificationKind가 input-waiting으로 분류하게 둔다.
export const agentResumeFailedNotification = defineNotificationKind({
  id: "agent.resume-failed",
  title: "Resume failed",
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
        message: "Resume failed — the saved session has expired.",
      });
      throw error;
    }
  },
  launch: async ({ theaterId, kind, initialPrompt }) => {
    const session = await createAgentSession(theaterId, kind.id, initialPrompt);
    applySessionUpdate(session);
    selectSession(session.sessionId);
    return { id: session.sessionId };
  },
  renderLaunchIcon: (kind) => {
    if (kind.id === "claude-kimi") return <KimiGlyph />;
    if (kind.id === "claude") return <ClaudeGlyph />;
    if (kind.id === "codex") return <CodexGlyph />;
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
  const [pinned, setPinned] = React.useState(true);

  const updatePinned = React.useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  // resetKey 의존 필수: 모달처럼 컨테이너가 훅 마운트 이후에 나타나는 소비자는
  // 마운트 시점에 containerRef가 null이라, resetKey(오픈 상태 포함) 변화에 재부착해야 한다.
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

  const jumpToLatest = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    container.focus({ preventScroll: true });
    updatePinned(true);
  }, [updatePinned]);

  return { containerRef, contentRef, pinned, jumpToLatest };
}

function getTabbableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("button, summary, [href], input, select, textarea, [tabindex]"))
    .filter((element) => {
      if (element.tabIndex < 0 || element.hidden || element.closest("[hidden]") || element.matches(":disabled")) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    });
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

function useAnalysisReady(context: OperationRenderContext): boolean {
  const companionsOpen = context.companionsOpen ?? false;
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    if (companionsOpen || ready) return;
    let disposed = false;
    let requestPending = false;
    const poll = async () => {
      if (requestPending) return;
      requestPending = true;
      const nextReady = await fetchAnalysisReady(context.api, context.operationId);
      requestPending = false;
      if (!disposed && nextReady) setReady(true);
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, ANALYSIS_READY_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [companionsOpen, context.api, context.operationId, ready]);

  return companionsOpen || ready;
}

function SessionAnalystHandle({ context, ready }: { readonly context: OperationRenderContext; readonly ready: boolean }) {
  const companionsOpen = context.companionsOpen ?? false;
  const language = context.language ?? "en";
  return (
    <button
      type="button"
      className={`session-analyst-handle${ready ? "" : " is-waiting"}`}
      aria-label={analysisCopy(language, companionsOpen ? "Exit Session Analyst" : "Open Session Analyst")}
      aria-pressed={companionsOpen}
      aria-disabled={!ready}
      disabled={!ready}
      title={ready ? undefined : analysisCopy(language, "Send a message in this session first")}
      onClick={() => { if (ready) context.onRequestCompanions?.(!context.companionsOpen); }}
    ><span className="session-analyst-handle__chev" aria-hidden="true">{companionsOpen ? "«" : "»"}</span><span className="session-analyst-handle__label">{analysisCopy(language, companionsOpen ? "EXIT" : "ANALYZE")}</span></button>
  );
}

function AgentOperationView({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [detailTab, setDetailTab] = React.useState<"request" | "activity">("request");
  const [modalJobIds, setModalJobIds] = React.useState<readonly string[]>([]);
  const [retainedJobs, setRetainedJobs] = React.useState<readonly RetainedJob[]>([]);
  const detailTabsId = React.useId();
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const detailBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const previousActiveJobIdsRef = React.useRef<ReadonlySet<string>>(new Set());
  // 초기값 true: 닫힘 상태로 마운트해도 첫 effect가 re-arm한다(force-drop과 동시 언마운트로
  // EXIT 전이를 관찰하지 못한 경우 복구). Theater 복귀는 companionsOpen=true 마운트라 disarm이 보존된다.
  const previousCompanionsOpenRef = React.useRef(true);
  const analysisReady = useAnalysisReady(context);

  React.useEffect(() => {
    const companionsOpen = context.companionsOpen ?? false;
    const wasOpen = previousCompanionsOpenRef.current;
    previousCompanionsOpenRef.current = companionsOpen;
    if (wasOpen && !companionsOpen) rearmAnalysisArtifacts(context.operationId);
  }, [context.companionsOpen, context.operationId]);

  const jobs = sessionJobs(session);
  const activeJobs = jobs.filter((job) => !isTerminalJobStatus(job.status));
  const dockJobs = mergeDockJobs(activeJobs, jobs, retainedJobs);
  const modalJobs = selectJobsByIds(jobs, modalJobIds);
  // Activity 패널은 Request-first 모달을 연 뒤에야 ref를 가진다. 탭 전환도
  // scroll listener/바닥 reset의 mount lifecycle로 취급한다.
  const modalResetKey = `${modalOpen}:${detailTab}`;
  const modalContentKey = modalJobs.map((job) => `${job.jobId}:${job.lastEventId}`).join(",");
  const modalScroll = usePinnedScrollLocal(modalResetKey, modalContentKey);

  React.useLayoutEffect(() => {
    const previousActiveJobIds = previousActiveJobIdsRef.current;
    const completedJobIds = jobs
      .filter((job) => previousActiveJobIds.has(job.jobId) && isTerminalJobStatus(job.status))
      .map((job) => job.jobId);
    previousActiveJobIdsRef.current = new Set(activeJobs.map((job) => job.jobId));
    if (completedJobIds.length === 0) return;
    setRetainedJobs((current) => retainCompletedJobs(current, completedJobIds, Date.now() + DOCK_RETENTION_MS));
  }, [activeJobs, jobs]);

  React.useEffect(() => {
    if (retainedJobs.length === 0) return;
    const nextExpiry = Math.min(...retainedJobs.map((job) => job.expiresAt));
    const timeout = window.setTimeout(() => {
      setRetainedJobs((current) => pruneRetainedJobs(current, jobs, Date.now()));
    }, Math.max(0, nextExpiry - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [jobs, retainedJobs]);

  React.useEffect(() => {
    if (!modalOpen) return;
    setModalJobIds((current) => mergeJobIds(current, activeJobs.map((job) => job.jobId)));
  }, [activeJobs, modalOpen]);

  const closeModal = React.useCallback(() => {
    setModalOpen(false);
    setModalJobIds([]);
    detailBtnRef.current?.focus();
  }, []);

  const openModal = React.useCallback(() => {
    setModalJobIds(dockJobs.map((job) => job.jobId));
    setDetailTab("request");
    setModalOpen(true);
  }, [dockJobs]);

  const selectDetailTab = React.useCallback((tab: "request" | "activity") => {
    setDetailTab(tab);
  }, []);

  const handleDetailTabKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const tabs = ["request", "activity"] as const;
    const currentIndex = tabs.indexOf(detailTab);
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex + tabs.length - 1) % tabs.length;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setDetailTab(nextTab);
    document.getElementById(`${detailTabsId}-${nextTab}`)?.focus();
  }, [detailTab, detailTabsId]);

  // Details 클릭을 받는 canvas 핸들러가 모두 끝난 뒤 Close로 포커스를 회수한다.
  React.useLayoutEffect(() => {
    if (!modalOpen) return;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
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
        const overlay = overlayRef.current;
        if (!overlay) return;
        const focusable = getTabbableElements(overlay);
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
      <div className="agent-stream-host">
        <SessionAnalystHandle context={context} ready={analysisReady} />
        <DormantOperationView context={context} session={session} />
      </div>
    );
  }

  return (
    <div className="agent-stream-host">
      <SessionAnalystHandle context={context} ready={analysisReady} />
      <TerminalSurface
        operationId={session.sessionId}
        ticketPath={AGENT_TICKET_PATH}
        wsPath={TERMINAL_WS_PATH}
        active={context.active}
        keyboardFocusRequestId={context.keyboardFocusRequestId}
        zoom={context.zoom}
        theme={context.theme}
        onExit={() => removeSession(session.sessionId)}
      />
      {dockJobs.length > 0 ? (
        <StreamDock activeJobs={dockJobs} onOpenDetail={openModal} detailBtnRef={detailBtnRef} />
      ) : null}
      {modalOpen ? (
        <div ref={overlayRef} className="job-overlay" role="dialog" aria-modal="true" aria-label="Carrier stream details">
          <button type="button" className="job-overlay-scrim" aria-label="Close" tabIndex={-1} onClick={closeModal} />
          <div className="job-overlay-card">
            <button ref={closeButtonRef} type="button" className="job-overlay-close" aria-label="Close" onClick={closeModal}>×</button>
            <div className="job-overlay-tabs" role="tablist" aria-label="Carrier stream details">
              <button id={`${detailTabsId}-request`} type="button" role="tab" aria-selected={detailTab === "request"} aria-controls={`${detailTabsId}-request-panel`} tabIndex={detailTab === "request" ? 0 : -1} onClick={() => selectDetailTab("request")} onKeyDown={handleDetailTabKeyDown}>Request</button>
              <button id={`${detailTabsId}-activity`} type="button" role="tab" aria-selected={detailTab === "activity"} aria-controls={`${detailTabsId}-activity-panel`} tabIndex={detailTab === "activity" ? 0 : -1} onClick={() => selectDetailTab("activity")} onKeyDown={handleDetailTabKeyDown}>Activity</button>
            </div>
            <div id={`${detailTabsId}-request-panel`} className="job-overlay-body job-overlay-panel" role="tabpanel" aria-labelledby={`${detailTabsId}-request`} hidden={detailTab !== "request"} tabIndex={detailTab === "request" ? 0 : -1}>
              {modalJobs.length === 0 ? <p className="job-overlay-empty">No active streams.</p> : modalJobs.map((job) => <RequestDetails key={job.jobId} job={job} />)}
            </div>
            <div id={`${detailTabsId}-activity-panel`} ref={detailTab === "activity" ? modalScroll.containerRef : undefined} className="job-overlay-body job-overlay-panel" role="tabpanel" aria-labelledby={`${detailTabsId}-activity`} hidden={detailTab !== "activity"} tabIndex={detailTab === "activity" ? 0 : -1}>
              <div className="job-overlay-panel-content" ref={modalScroll.contentRef}>
                {modalJobs.length === 0 ? <p className="job-overlay-empty">No active streams.</p> : modalJobs.map((job) => <JobDetailContent key={job.jobId} job={job} />)}
              </div>
            </div>
            {detailTab === "activity" && !modalScroll.pinned ? (
              <button type="button" className="follow-button" onClick={modalScroll.jumpToLatest}>
                ↓ Follow
              </button>
            ) : null}
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
  const elapsed = useElapsed(primaryJob?.startedAt, primaryJob?.finishedAt);
  const totalTokens = activeJobs.reduce((sum, job) => sum + estimateJobTokens(job), 0);
  const tokenLabel = formatTokenEstimate(totalTokens);

  const jobLabel = activeJobs.length === 1 && primaryJob ? primaryJob.label : undefined;

  const carrierLabel = activeJobs.length > 1
    ? `${activeJobs.length} carriers`
    : (primaryJob?.ownerCarrierId ?? "Carrier");

  const tail = getDockTailText(activeJobs);
  const contentKey = activeJobs.map((j) => `${j.jobId}:${j.lastEventId}`).join(",");
  const resetKey = `${expanded}:${activeJobs.map((j) => j.jobId).join(",")}`;
  const { containerRef, pinned, jumpToLatest } = usePinnedScrollLocal(resetKey, contentKey);

  // 스트립 라인 라이브 캐럿: 비종결 잡의 라이브 트랙이 하나라도 있으면 표시(잔존 종결 잡 제외)
  const stripIsLive = activeJobs.some((job) =>
    job.trackOrder.some((id) => {
      const t = job.tracks[id];
      return t ? isDockTrackLive(job.status, t.status) : false;
    })
  );
  const hasActiveJob = activeJobs.some((job) => !isTerminalJobStatus(job.status));
  const hasError = activeJobs.some((job) =>
    job.status === "error" || job.trackOrder.some((trackId) => isTrackError(job.tracks[trackId]?.status ?? ""))
  );
  const dotClassName = hasActiveJob ? "job-dock-dot" : hasError ? "job-dock-dot job-dock-dot--error" : "job-dock-dot job-dock-dot--idle";
  const stripTone = hasError ? "is-error" : hasActiveJob ? "is-live" : "is-complete";
  const ownerCaptains = [...new Set(activeJobs.map((job) => resolveCarrierCaptain(job.ownerCarrierId)).filter((id): id is string => Boolean(id)))];
  const visibleCaptains = ownerCaptains.slice(0, 4);
  const hiddenCaptainCount = Math.max(0, ownerCaptains.length - visibleCaptains.length);
  const deckTracks = activeJobs.flatMap((job) => job.trackOrder.flatMap((trackId) => {
    const track = job.tracks[trackId];
    return track ? [{ job, track }] : [];
  }));
  const visibleDeckTracks = deckTracks.slice(0, 6);
  const hiddenTrackCount = Math.max(0, deckTracks.length - visibleDeckTracks.length);

  return (
    <div className="job-dock">
      <div className={`job-dock-strip ${stripTone}`}>
        <span className={dotClassName} aria-hidden="true" />
        <span className="job-dock-carrier" title={jobLabel}>
          {visibleCaptains.length > 0 ? (
            <span className="job-dock-captain-stack" aria-hidden="true">
              {visibleCaptains.map((captain) => <span key={captain} className="job-dock-captain-dot" data-captain={captain} />)}
            </span>
          ) : null}
          <span className="job-dock-captain-tag">{carrierLabel}</span>
          {hiddenCaptainCount > 0 ? <span className="job-dock-captain-tag">+{hiddenCaptainCount}</span> : null}
        </span>
        <span className="job-dock-seg" aria-hidden="true">
          {visibleDeckTracks.map(({ job, track }) => (
            <i key={`${job.jobId}:${track.trackId}`} data-tone={dockSegmentTone(track, job.status)} />
          ))}
          {hiddenTrackCount > 0 ? <span>+{hiddenTrackCount}</span> : null}
        </span>
        <span className="job-dock-strip-line" style={expanded ? { display: "none" } : undefined} aria-hidden="true">
          {tail.thinking ? <span className="thinking-chip">thinking…</span> : tail.text}
          {!expanded && stripIsLive && tail.text ? <span className="job-dock-caret" aria-hidden="true" /> : null}
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
          {activeJobs.map((job) => {
            return job.trackOrder.map((trackId) => {
              const track = job.tracks[trackId];
              return track ? (
                <DockRow
                  key={`${job.jobId}:${trackId}`}
                  track={track}
                  job={job}
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

function DockRow({ track, job }: DockRowProps) {
  const isLive = isDockTrackLive(job.status, track.status);
  const tailOutput = getLastLine(track.text);
  const displayLine = tailOutput;
  const showThinking = !displayLine && isLive && Boolean(track.thought);
  const captain = resolveCarrierCaptain(job.ownerCarrierId);
  const phase = deriveTrackPhase(track, job.status);
  const elapsed = useElapsed(track.startedAt ?? job.startedAt, track.finishedAt ?? job.finishedAt);

  return (
    <div className="job-dock-card" data-captain={captain} data-tone={phase.tone}>
      <span className="job-dock-card-who">
        {captain ? <span className="job-dock-captain-dot" data-captain={captain} aria-hidden="true" /> : null}
        <span className="job-dock-captain-tag">{track.displayName}</span>
      </span>
      <span className="job-dock-card-copy">
        <span className="job-dock-card-phase">{phase.label}</span>
        {displayLine ? <span className="job-dock-card-line">{displayLine}</span> : null}
        {showThinking ? <span className="thinking-chip">thinking…</span> : null}
      </span>
      <span className="job-dock-card-meta">{elapsed}</span>
      <span className="job-dock-card-bar" aria-hidden="true"><i /></span>
    </div>
  );
}

function GeneralSection() {
  const { renderer: terminalRenderer, font: terminalFont } = useTerminalPrefs();

  // 카드를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <SystemPromptSettingsBlock />
      <TerminalFontSettingsCard terminalFont={terminalFont} />
      <TerminalRendererCard terminalRenderer={terminalRenderer} />
    </>
  );
}

function AgentCliSection() {
  const [clis, setClis] = React.useState<readonly AgentCliStatus[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const settings = useSystemPromptSettingsStore();

  React.useEffect(() => {
    const abort = new AbortController();
    void fetchAgentCliState(abort.signal)
      .then((next) => setClis(next.clis))
      .catch((err) => {
        if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => abort.abort();
  }, []);

  // Codex launch mode 토글은 system prompt 설정(codexLaunchMode)에 의존하므로, Metaphor 카드가
  // General 섹션으로 분리된 지금은 이 섹션에서도 설정을 로드해야 토글이 채워진다.
  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  // 카드를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <section className="global-settings-card" aria-label="Agent CLI Available">
        <div className="agent-cli-head">
          <p className="global-settings-resp-title">Agent CLI Available</p>
        </div>
        <p className="global-settings-help">Whether each Agent CLI is installed and discoverable on this machine's PATH, with its detected version. Carriers can only run on an Agent CLI shown as available here.</p>
        {error ? <p className="settings-error">{error}</p> : null}
        <div className="agent-cli-list">
          {clis.map((cli) => (
            <AgentCliRow
              key={cli.id}
              cli={cli}
              codexLaunchMode={settings.state?.codexLaunchMode}
              disabled={settings.savingField !== null}
              onCodexLaunchModeChange={(mode) => void setSystemPromptSettingsField("codexLaunchMode", mode)}
            />
          ))}
        </div>
        {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
        <p className="global-settings-help">Codex launch mode controls the unified-agent carrier protocol for new Codex sessions; it does not affect the interactive Codex TUI in terminal panels.</p>
        <p className="global-settings-foot">Install or update a CLI, then reopen this page to re-check availability.</p>
      </section>
      <ModelAuthBlock />
    </>
  );
}

function ModelAuthBlock() {
  const store = useModelAuthStore();
  const settings = useSystemPromptSettingsStore();
  const [kimiOptions, setKimiOptions] = React.useState<CarrierSettingsCliOption | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadModelAuth(controller.signal);
    return () => controller.abort();
  }, []);

  // 프로바이더 기본 모델 카탈로그는 Carriers 섹션과 같은 options 엔드포인트에서 가져온다.
  React.useEffect(() => {
    const controller = new AbortController();
    void fetchCarrierSettingsOptions(controller.signal)
      .then((options) => setKimiOptions(options.cliTypes.find((cli) => cli.id === "claude-kimi") ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // 현재 저장값은 terminal settings 스토어의 kimiModel 필드에서 읽는다.
  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  const storedKimiModel = settings.state?.kimiModel ?? null;
  const selectedModelId = storedKimiModel?.model ?? kimiOptions?.defaultModel;
  const selectedModel = kimiOptions?.models.find((model) => model.modelId === selectedModelId);
  const selectedEffort = storedKimiModel?.effort ?? selectedModel?.effort?.default;
  const saving = settings.savingField !== null;

  const saveKimiModel = (model: string, effort?: string) => {
    void setSystemPromptSettingsField("kimiModel", effort ? { model, effort } : { model });
  };

  return (
    <section className="global-settings-card" aria-label="Model sign-in">
      <div className="model-auth-head">
        <p className="global-settings-resp-title">Settings for Kimi</p>
        <p className="global-settings-help">
          Register a Kimi API key to run carriers and terminal sessions through Claude Code against the Kimi endpoint.
          The key is validated and stored locally, and is never returned to the browser.
        </p>
      </div>
      {store.error ? <p className="global-settings-error" role="alert">{store.error}</p> : null}
      {store.loading && !store.state ? <p className="global-settings-help">Loading sign-in state.</p> : null}
      {store.state?.providers.map((provider) => (
        <ProviderRow key={provider.cli} provider={provider} busy={store.busyCli === provider.cli} />
      ))}
      {kimiOptions && selectedModelId ? (
        <div className="model-auth-row">
          <div className="terminal-carriers-runtime-row">
            <div className="terminal-carriers-field">
              <span className="terminal-carriers-label" id="kimi-default-model-label">Default model</span>
              <Select
                aria-labelledby="kimi-default-model-label"
                value={selectedModelId}
                disabled={saving || !settings.state}
                options={kimiOptions.models.map((model) => ({ value: model.modelId, label: model.name }))}
                onChange={(nextModelId) => {
                  const nextModel = kimiOptions.models.find((model) => model.modelId === nextModelId);
                  if (!nextModel) return;
                  saveKimiModel(nextModel.modelId, nextModel.effort ? (storedKimiModel?.effort ?? nextModel.effort.default) : undefined);
                }}
              />
            </div>
            {selectedModel?.effort ? (
              <div className="terminal-carriers-field">
                <span className="terminal-carriers-label" id="kimi-default-effort-label">Default effort</span>
                <Select
                  aria-labelledby="kimi-default-effort-label"
                  value={selectedEffort ?? selectedModel.effort.default}
                  disabled={saving || !settings.state}
                  options={selectedModel.effort.levels.map((level) => ({ value: level, label: level }))}
                  onChange={(effort) => saveKimiModel(selectedModel.modelId, effort)}
                />
              </div>
            ) : null}
          </div>
          <p className="global-settings-help">Used for Kimi sessions without an explicit carrier model. Applies to newly launched sessions.</p>
        </div>
      ) : null}
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
          <button type="button" className="model-auth-button" disabled={busy} onClick={() => void signOutModel(provider.cli)}>
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
            help="Adds concise Fleet wording to every session. Off uses the standard prompt."
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

function AgentCliRow({
  cli,
  codexLaunchMode,
  disabled,
  onCodexLaunchModeChange,
}: {
  readonly cli: AgentCliStatus;
  readonly codexLaunchMode: "acp" | "app-server" | undefined;
  readonly disabled: boolean;
  readonly onCodexLaunchModeChange: (mode: "acp" | "app-server") => void;
}) {
  return (
    <div className="agent-cli-row">
      <span className="agent-cli-name">{cli.displayName}</span>
      <span className="agent-cli-meta">
        {cli.id === "codex" && codexLaunchMode ? (
          <span className="segmented" role="group" aria-label="Codex launch mode">
            <button
              type="button"
              aria-pressed={codexLaunchMode === "acp"}
              className={`segmented-option ${codexLaunchMode === "acp" ? "is-active" : ""}`}
              disabled={disabled}
              onClick={() => onCodexLaunchModeChange("acp")}
            >
              ACP
            </button>
            <button
              type="button"
              aria-pressed={codexLaunchMode === "app-server"}
              className={`segmented-option ${codexLaunchMode === "app-server" ? "is-active" : ""}`}
              disabled={disabled}
              onClick={() => onCodexLaunchModeChange("app-server")}
            >
              App Server
            </button>
          </span>
        ) : null}
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
          return track ? <TrackCard key={track.trackId} track={track} jobStatus={job.status} /> : null;
        })}
      </div>
    </>
  );
}

function TrackCard({ track, jobStatus }: { readonly track: TrackView; readonly jobStatus: string }) {
  const modifier = trackCardModifier(track.status, jobStatus);
  const phase = deriveTrackPhase(track, jobStatus);
  // 칩 텍스트도 modifier와 같은 해석에서 파생 — 종결 잡의 미종결 트랙이 coral 카드에
  // raw "stream" 라벨을 다는 표기 분열을 막는다(라이브 트랙은 자기 상태 그대로).
  const statusLabel = resolveDockRowStatusLabel(track.status, jobStatus);
  return (
    <article className={modifier ? `track-card ${modifier}` : "track-card"}>
      <header className="track-card-head">
        <span className="track-card-title">{track.displayName}</span>
        <span className="track-card-status">{statusLabel}</span>
      </header>
      {track.thought ? (
        <details className="track-card-thinking">
          <summary>thinking · {track.thought.length} chars</summary>
          <div className="track-card-thought" role="group" aria-label="Thinking">
            <pre>{track.thought}</pre>
          </div>
        </details>
      ) : null}
      {track.text ? (
        <StreamedMarkdown className="track-card-output markdown-body" text={track.text} streaming={phase.tone === "live"} />
      ) : null}
      {track.error ? (
        <div className="track-card-error" role="group" aria-label="Error">{track.error}</div>
      ) : null}
      {track.tools.length > 0 ? (
        <div className="track-card-tools" role="list" aria-label="Tools">
          {track.tools.map((tool) => {
            const target = describeToolTarget(tool.input);
            const tone = `is-${resolveToolTone(tool.status)}`;
            return (
              <span key={tool.id} className={`track-card-tool-chip ${tone}`} role="listitem">
                <i aria-hidden="true" />
                <strong>{tool.name ?? tool.id}</strong>
                {target ? <span>{target}</span> : null}
              </span>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

async function resumeSession(sessionId: string, options?: { readonly fresh?: boolean }): Promise<void> {
  applySessionUpdate(await resumeAgentSession(sessionId, options));
  selectSession(sessionId);
}

// dormant 프레임의 resume 상태기계. 실패는 프레임 내 에러 카드(Try again / Start fresh)와
// Alerts 알림(agent.resume-failed) 두 경로로 표면화한다 — 어느 쪽도 침묵하지 않는다.
function DormantOperationView({ context, session }: { readonly context: OperationRenderContext; readonly session: SessionInfo }) {
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
        message: "Resume failed — the saved session has expired.",
      });
    }
  }, [context, session.sessionId]);

  if (resumeState === "error") {
    return (
      <div className="canvas-operation-dormant canvas-operation-dormant--error" role="alert">
        <span className="canvas-operation-dormant-status">Dormant</span>
        <p className="canvas-operation-dormant-error">
          Couldn’t resume this session. The saved session for “{session.label || session.cwdLabel}” has expired.
        </p>
        <div className="canvas-operation-dormant-error-actions">
          <button type="button" className="canvas-operation-dormant-action" onClick={() => { void resume(false); }}>
            Try again
          </button>
          <button type="button" className="canvas-operation-dormant-action canvas-operation-dormant-action--ghost" onClick={() => { void resume(true); }}>
            Start fresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="canvas-operation-dormant" disabled={resumeState === "resuming"} onClick={() => { void resume(false); }}>
      <span className="canvas-operation-dormant-status">Dormant</span>
      <span className={`canvas-operation-dormant-action${resumeState === "resuming" ? " canvas-operation-dormant-action--pending" : ""}`}>
        {resumeState === "resuming" ? "Resuming…" : "Resume"}
      </span>
    </button>
  );
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

function getLastLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

function dockSegmentTone(track: TrackView, jobStatus: string): "live" | "done" | "error" | undefined {
  const status = resolveDockRowStatusLabel(track.status, jobStatus);
  if (isTrackError(status) || status === "aborted") return "error";
  if (status === "done") return "done";
  return isDockTrackLive(jobStatus, track.status) ? "live" : undefined;
}

function TerminalFontSettingsCard({ terminalFont }: { readonly terminalFont: TerminalFontSettings }) {
  const [installedFonts, setInstalledFonts] = React.useState<readonly FontPickerInstalledFont[]>([]);
  const [isLoadingFonts, setIsLoadingFonts] = React.useState(true);
  const [fontLoadError, setFontLoadError] = React.useState<string | null>(null);
  const selected = terminalFont.source === "curated" || !terminalFont.customName
    ? { source: "builtin" as const, id: terminalFont.source === "curated" ? terminalFont.id ?? DEFAULT_TERMINAL_FONT.id : DEFAULT_TERMINAL_FONT.id }
    : { source: "system" as const, familyName: terminalFont.customName };

  React.useEffect(() => {
    const controller = new AbortController();
    setIsLoadingFonts(true);
    setFontLoadError(null);
    void fetchSystemFonts({ signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setInstalledFonts(response.fonts.filter((font) => font.monospace).map((font) => ({ family: font.family, monospace: font.monospace })));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setInstalledFonts([]);
        setFontLoadError("Installed system fonts are unavailable. Built-in fonts remain available.");
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
    <section className="global-settings-card" aria-label="Terminal Font">
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">Terminal Font <span className="new-badge">New</span></p>
          <p className="global-settings-help" id="terminal-font-help">Typeface and size for every terminal panel — agent-cli and shell alike. Applies live to all open terminals and persists on the Console server across browsers and restarts.</p>
        </div>
      </div>
      <div aria-describedby="terminal-font-help">
          <FontPicker
            builtIns={CURATED_TERMINAL_FONTS.map((font) => ({ id: font.id, label: font.name, family: font.family, aliases: [font.familyName], description: font.meta }))}
            installedFonts={installedFonts}
            selected={selected}
            selectedSystemFont={terminalFont.source === "custom" ? terminalFont.customName : null}
            fallbackStack={DEFAULT_TERMINAL_FONT.family}
            previewText={TERMINAL_FONT_PREVIEW}
            size={terminalFont.size}
            sizeRange={TERMINAL_FONT_PICKER_SIZE_RANGE}
            loading={isLoadingFonts}
            error={fontLoadError}
            onSelectionChange={handleSelectionChange}
            onSizeCommit={setTerminalFontSize}
          />
      </div>
      <p className="global-settings-foot">Font preferences apply immediately and are stored on the Console server, separate from session settings and shared across browsers after restart.</p>
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function trackCardModifier(trackStatus: string, jobStatus: string): string {
  // 라이브 판정은 isDockTrackLive 단일 소유 — 도크 행/스트립 캐럿과 판정이 갈라지지 않고,
  // 종결 잡의 미종결(stale) 트랙이 라이브로 표시되지 않게 위임한다.
  if (isDockTrackLive(jobStatus, trackStatus)) {
    return "track-card--live";
  }
  // 스타일 키는 도크 행 라벨과 같은 해석에서 파생한다 — track:finalized를 못 받은 트랙도
  // 종결 잡의 결과(error/done)로 표시가 폴백돼 라벨과 도색이 갈라지지 않는다.
  const resolved = resolveDockRowStatusLabel(trackStatus, jobStatus);
  if (isTrackError(resolved)) return "track-card--bad";
  if (resolved === "done" || resolved === "aborted") return "track-card--idle";
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

// Kimi(Moonshot AI) 공식 브라우저 탭/앱 심볼 — 두 눈이 음각으로 뚫린 말풍선 마크.
// 이전에는 claude-kimi가 ClaudeGlyph를 재사용해 Claude와 구분되지 않았다.
// 출처: kimi.com 아이콘 번들(statics.moonshot.cn/kimi-web-seo, "TabKimi_f").
function KimiGlyph() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <path fillRule="evenodd" d="M525.019429 157.257143c-201.984 0-365.714286 163.730286-365.714286 365.714286 0 70.326857 19.858286 136.118857 54.345143 191.926857L174.811429 807.570286A58.514286 58.514286 0 0 0 228.790857 888.685714h296.228572c201.947429 0 365.714286-163.730286 365.714285-365.714285s-163.766857-365.714286-365.714285-365.714286z m138.422857 180.114286a45.458286 45.458286 0 0 1 51.2 38.875428l12.361143 90.441143a45.458286 45.458286 0 0 1-90.075429 12.324571l-12.361143-90.441142a45.458286 45.458286 0 0 1 38.875429-51.2z m-195.876572 24.137142a45.458286 45.458286 0 0 1 51.2 38.838858l12.361143 90.441142a45.458286 45.458286 0 1 1-90.038857 12.324572l-12.361143-90.441143a45.458286 45.458286 0 0 1 38.838857-51.2" fill="currentColor" />
    </svg>
  );
}

export { formatElapsedDuration, formatTokenEstimate, estimateJobTokens, resolveJobSignature, resolveCarrierCaptain } from "./helpers.js";
