import { FontPicker, type FontPickerInstalledFont, type FontPickerSelection } from "@fleet-console/font-picker/browser";
import "@fleet-console/font-picker/styles.css";
import { fetchSystemFonts } from "@fleet-console/font-picker/system-fonts";
import { defineNotificationKind } from "@fleet-console/sdk/notifications/browser";
import { defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import { definePlugin, React } from "@fleet-console/sdk/plugin/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import { launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";
import {
  CaptionActionButton,
  CaptionAnalystGlyph,
  CaptionChatGlyph,
  CaptionReadingWidthGlyph,
  CaptionTerminalGlyph,
} from "@fleet-console/sdk/components/caption-actions";
import { SettingsScope, defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import type { OperationRenderContext, PluginInstallContext } from "@fleet-console/sdk/plugin";
import { TerminalSurface } from "../shared/index.js";
import { CURATED_TERMINAL_FONTS, DEFAULT_TERMINAL_FONT, TERMINAL_FONT_SIZE_RANGE } from "../shared/terminal-preferences.js";
import { getTerminalPrefsSnapshot, useTerminalPrefs, nextChatReadingWidth, setChatReadingWidth, setInstalledTerminalFont, setTerminalRenderer, setTerminalInactiveFlush, setTerminalFont, setTerminalFontSize, useChatReadingWidth } from "../shared/terminal-preferences.js";
import type { ChatReadingWidth, TerminalFontId, TerminalFontSettings, TerminalInactiveFlush, TerminalRenderer } from "../shared/terminal-preferences.js";
import { AnalystCaption, AnalystChatPanel } from "./analysis-chat-panel.js";
import { fetchAnalysisReady } from "./analysis-api.js";
import {
  ANALYST_CHAT_COMPANION_ID,
  ANALYST_COMPANION_IDS,
  closeAnalystCompanionPanels,
  isCompanionPanelVisible,
} from "./analysis-visibility.js";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { currentTerminalLocale, getT, useTerminalLocale, type TerminalMessageKey } from "../i18n/index.js";
import { disposeAnalysisStore, useAnalysisStore } from "./analysis-store.js";
import { disposeViewSwitch, setChatPromptOpen, setTerminalHandoff, useViewSwitchState } from "./view-switch-store.js";
import "./analysis.css";
import "./agent-cli.css";

import { AgentApiError, convertAgentSessionToChat, createAgentSession, discardLaunchAttachment, exitAgentChat, fetchAgentCliDiagnostics, fetchAgentCliState, messageAgentSession, resumeAgentSession, setAgentCliPath, terminateAgentSession, uploadLaunchAttachment } from "./api.js";
import { AgentChatView, READING_WIDTH_LABEL_KEY } from "./chat/chat-view.js";
import { startAgentConnection } from "./connection.js";
import { loadModelAuth, signInModel, signOutModel, useModelAuthStore } from "./model-auth.js";
import type { ModelAuthProviderState } from "./model-auth.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "./settings.js";
import type { AiGatewayCapabilityClass, AiGatewayCatalogModel, AiGatewayCatalogProvider, AiGatewayProviderId, AiGatewaySettings, CompactCeiling } from "./settings.js";
import { StreamedMarkdown } from "./streamed-markdown.js";
import { applySessionUpdate, getAgentState, hydrateAgentClis, removeSession, selectSession, useAgentState } from "./store.js";
import type { AgentCliDiagnosticsEntry, AgentCliStatus, SessionInfo } from "./types.js";

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
// 절약 → 즉시 순서로 둔다 — 세그먼트를 오른쪽으로 갈수록 더 자주 그리는 축으로 읽게 한다.
const INACTIVE_FLUSH_IDS = ["saving", "balanced", "instant"] as const satisfies readonly TerminalInactiveFlush[];

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

// 상태줄 3행(cwd·모델·권한 모드) + 입력 컴포저 3행(테두리 2 + 프롬프트 1) + 사이 여백 1행.
const AGENT_PREVIEW_CHROME_ROWS = 7;

export const agentOperationKind = defineOperationKind({
  pluginId: "terminal",
  type: "agent",
  title: (locale) => getT(locale)("terminal.kind.agent"),
  subtitle: () => "Claude Code",
  render: (context) => <AgentOperationView context={context} />,
  // 분석가·뷰 전환·읽기 폭은 캡션 밴드가 진다 — 본문 위에 떠 있던 칩 줄이 하던 일이다.
  captionActions: (context) => <AgentCaptionActions context={context} />,
  // 에이전트 CLI TUI는 화면 바닥에 입력 컴포저와 상태줄(cwd·모델·권한 모드)을 고정으로 그린다 —
  // 실행 중에도 갱신되지 않으므로 호스트 프리뷰는 이 밴드를 프레임 밖으로 밀어낼 수 있다.
  // 밴드의 단위는 px가 아니라 행이다: 셀 높이가 글꼴 크기를 따르므로(TERMINAL_OPTIONS.lineHeight
  // = 1) 현재 글꼴 크기를 곱해 지원 범위(10~22px) 어디서도 같은 행 수가 잘리게 한다.
  // 순정 셸(shellOperationKind)은 바닥까지 출력이 흐르므로 이 값을 선언하지 않는다.
  previewBottomChrome: () => AGENT_PREVIEW_CHROME_ROWS * getTerminalPrefsSnapshot().font.size,
  canOpenCompanions: () => true,
  companions: [
    // 아티팩트는 Analyst 드로어 안의 모드다 — 컴패니언은 하나만 등록한다.
    // 캡션 밴드는 호스트가 이미 자리를 비워 둔다 — 채우지 않으면 빈 띠가 남고 위 모서리도 각진다.
    { id: ANALYST_CHAT_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.sessionAnalyst"), defaultHidden: true, shortcut: { code: "KeyA", label: "A", clusterIds: ANALYST_COMPANION_IDS }, caption: (context) => <AnalystCaption context={context} />, render: (context) => <AnalystChatPanel context={context} /> },
  ],
});

export const generalSettingsSection = defineSettingsSection({
  id: "general",
  title: (locale) => getT(locale)("terminal.settings.general"),
  group: "work",
  // 제목에 없는 이름으로도 닿아야 한다 — "dormant"를 찾는 사람은 그 설정이 여기 있다는 것을 모른다.
  keywords: ["terminal", "font", "typeface", "monospace", "dormant", "idle", "session", "timeout", "system prompt", "claude"],
  render: () => <GeneralSection />,
});

export const agentSettingsSection = defineSettingsSection({
  id: "agent-cli",
  title: (locale) => getT(locale)("terminal.settings.agentCli"),
  group: "work",
  keywords: ["gateway", "provider", "model", "api key", "cli", "path", "codex", "cursor", "opencode", "xai", "kimi"],
  render: () => <AgentCliSection />,
});

export const agentAttentionNotification = defineNotificationKind({
  id: "agent.attention",
  title: (locale) => getT(locale)("terminal.notifications.agentInputWaiting"),
});

// id에 ".end"를 포함시켜 core mapNotificationKind가 이 알림을 "ended"(turn 종료)로 분류하게 한다.
// (idle 전이는 에이전트 턴 종료이므로 ALERTS의 ended 상태로 분류해야 한다.)
const agentEndedNotification = defineNotificationKind({
  id: "agent.ended",
  title: (locale) => getT(locale)("terminal.notifications.agentTurnEnded"),
});

// resume 실패는 사용자의 다음 행동(Try again / Start fresh)이 필요한 이벤트다.
// ".end"/"done"을 id에 넣지 않아 core mapNotificationKind가 input-waiting으로 분류하게 둔다.
const agentResumeFailedNotification = defineNotificationKind({
  id: "agent.resume-failed",
  title: (locale) => getT(locale)("terminal.notifications.resumeFailed"),
});

function isLaunchOptionError(error: unknown): boolean {
  return error instanceof AgentApiError
    && (error.message === "gateway_model_not_enabled" || error.message === "invalid_effort");
}

function resumeFailureMessage(error: unknown, locale?: ConsoleLocale): string {
  return getT(locale)(isLaunchOptionError(error)
    ? "terminal.notifications.resumeLaunchOptionFailedMessage"
    : "terminal.notifications.resumeFailedMessage");
}

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
      disposeViewSwitch(operationId);
      removeSession(operationId);
    }
  },
  resumeOperation: async (operationId) => {
    // 팔레트·사이드바 등 프레임 밖 resume 진입점. 패널의 Start fresh 판정과 같은 근거를 쓴다 —
    // 재개 마커가 없으면 서버가 409 resume_unavailable 로 거절하므로 fresh 로 보낸다.
    try {
      await resumeSession(operationId, { fresh: await shouldResumeFresh(operationId) });
      installedNotifications?.dismiss(operationId);
    } catch (error) {
      installedNotifications?.emit({
        kind: agentResumeFailedNotification.id,
        operationId,
        message: resumeFailureMessage(error, currentTerminalLocale()),
      });
      throw error;
    }
  },
  // Quick Launch 멘션 전달. 실패 표현은 컴포저가 거절 코드로 소유하므로 여기서는 알림을 내지 않는다.
  messageableOperationTypes: ["agent"],
  messageOperation: async (operationId, text, attachmentIds) => {
    await messageAgentSession(operationId, text, attachmentIds);
  },
  // Quick Launch 이미지 첨부. 실패 표현은 컴포저가 거절 코드로 소유한다(messageOperation과 같은 계약).
  uploadLaunchAttachment: async (file) => uploadLaunchAttachment(file),
  discardLaunchAttachment: async (id) => discardLaunchAttachment(id),
  launch: async ({ theaterId, kind, variant, geometry }) => {
    // 첨부 id는 variant 문자열 계약(Record<string,string>)에 CSV로 실려 온다 — id는 서버가 만든
    // UUID라 쉼표를 품지 않는다.
    const attachmentIds = variant?.attachments?.split(",").filter((id) => id.length > 0);
    const session = await createAgentSession(theaterId, kind.id, {
      model: variant?.model,
      effort: variant?.effort,
      prompt: variant?.prompt,
      geometry,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      // 모르는 값은 실어 보내지 않는다 — 서버가 최종 판정자지만, 오타가 400으로 왕복하며
      // 초안을 잃게 하는 것보다 여기서 터미널로 접는 편이 낫다(기본이 곧 계약이다).
      ...(variant?.viewMode === "chat" ? { viewMode: "chat" as const } : {}),
    });
    applySessionUpdate(session);
    selectSession(session.sessionId);
    return { id: session.sessionId };
  },
  renderLaunchIcon: (kind) => {
    if (kind.id === "claude") return launchProviderGlyph("claude");
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
  // 이 플러그인은 런타임 축의 권위를 가진다 — 첫 스냅샷이 도착하기 전까지는 그 축을 신뢰할 수 없다고
  // 먼저 선언하고 시작한다.
  ctx.runtime.setHydration("pending");
  const disposeConnection = startAgentConnection({
    operations: ctx.operations,
    notifications: ctx.notifications,
    runtime: ctx.runtime,
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

function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
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
  for (const id of clusterIds) context.onSetCompanionPanelVisible(id, false);
  context.onRequestCompanions?.(false);
}

/** 터미널·채팅·휴면 뷰 공용의 Analyst 진입 칩 — 채팅 전환 칩과 같은 자리·같은 문법으로
    드로어를 여닫는다. 세로 ANALYZE/EXIT 핸들의 후계다. */
/**
 * 캡션 밴드의 동작 선반 — 분석가 · 뷰 전환 · 읽기 폭.
 *
 * 본문 위에 떠 있던 칩 줄이 하던 일을 그대로 진다. 자리를 옮기면서 이름표는 말풍선으로 물러나고
 * 마크만 남는다: 32px 밴드에서 세 개의 라벨은 이름이 설 자리를 먹는다.
 *
 * 이 컴포넌트는 본문과 다른 React 트리에 마운트된다(호스트가 캡션에 그린다). 그래서 상태는 전부
 * 모듈 저장소에서 읽는다 — 세션·분석가·읽기 폭 선호는 이미 그렇고, 전환의 진행/실패만 이번에
 * 저장소를 하나 얻었다(`view-switch-store`).
 */
function AgentCaptionActions({ context }: { readonly context: OperationRenderContext }) {
  const t = getT(context.language ?? "en");
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);
  const analysisReadiness = useAnalysisReady(context);
  const { state: analysisState } = useAnalysisStore(context);
  const readingWidth = useChatReadingWidth();
  const { terminalPending } = useViewSwitchState(context.operationId);
  const chatMode = context.operation.payload.chatMode === true;
  const analystOpen = isCompanionPanelVisible(context, ANALYST_CHAT_COMPANION_ID);
  const analystReady = analysisReadiness === "ready";

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

  // 투어 앵커는 사용자가 이 마운트에서 직접 채팅 뷰로 넘어온 뒤에만 선다 — 본문의 판정과 같다.
  const wasChatModeAtMountRef = React.useRef(chatMode);
  const chatOpenedHere = chatMode && !wasChatModeAtMountRef.current;

  const openTerminal = React.useCallback(async () => {
    setTerminalHandoff(context.operationId, { pending: true, error: "none" });
    try {
      await openTerminalForOperation(context);
    } catch (error) {
      // 왜 안 되는지가 다음 행동을 가른다 — 진행 중인 턴은 기다리면 풀리고, 그 밖의 실패는 아니다.
      setTerminalHandoff(context.operationId, {
        error: error instanceof AgentApiError && error.message === "chat_busy" ? "busy" : "failed",
      });
    } finally {
      setTerminalHandoff(context.operationId, { pending: false });
    }
  }, [context]);

  // 컴패니언을 열 수 없는 호스트에는 분석가 문을 세우지 않는다 — 모바일 레이아웃은 화면 전부를
  // 세션에 주고 이 콜백을 빼며, 그 부재가 곧 "여기엔 드로어가 없다"는 말이다.
  const analyst = context.onRequestCompanions === undefined ? null : (
    <CaptionActionButton
      actionId="analyst"
      label={analystReady ? t(analystOpen ? "terminal.analyst.exit" : "terminal.analyst.open") : t("terminal.analyst.sendMessageFirst")}
      pressed={analystOpen}
      disabled={!analystReady}
      busy={analysisState.busy}
      onClick={() => { if (analystReady) toggleCompanionPanel(context, ANALYST_CHAT_COMPANION_ID, ANALYST_COMPANION_IDS); }}
    >
      <CaptionAnalystGlyph />
    </CaptionActionButton>
  );

  // 전환은 목적지 하나로 말한다 — 채팅에서는 터미널 마크가, 터미널에서는 채팅 마크가 선다.
  // 휴면 세션에는 아직 떠날 자리가 없다(휴면 카드의 고스트가 그 전환을 진다).
  const canSwitch = chatMode || session.status !== "dormant";
  const viewSwitch = !canSwitch ? null : chatMode ? (
    <CaptionActionButton
      actionId="view-switch"
      label={terminalPending ? t("terminal.chat.openingTerminal") : t("terminal.chat.openTerminalAria")}
      disabled={terminalPending}
      pending={terminalPending}
      {...(chatOpenedHere ? { tourAnchor: "terminal" } : {})}
      onClick={() => { void openTerminal(); }}
    >
      <CaptionTerminalGlyph />
    </CaptionActionButton>
  ) : (
    <CaptionActionButton
      actionId="view-switch"
      label={t("terminal.chat.openAria")}
      onClick={() => { setChatPromptOpen(context.operationId, true); }}
    >
      <CaptionChatGlyph />
    </CaptionActionButton>
  );

  // 읽기 폭은 대화 면의 선호다 — 터미널 뷰에는 맞출 판면이 없으므로 서지 않는다.
  // 좁은 패널에서 물러나는 판정은 CSS(캡션 컨테이너 질의)가 진다: 폭을 아는 것은 밴드다.
  const readingWidthAction = !chatMode ? null : (
    <CaptionActionButton
      actionId="reading-width"
      label={t("terminal.chat.readingWidthAria", { current: t(READING_WIDTH_LABEL_KEY[readingWidth]) })}
      onClick={() => { setChatReadingWidth(nextChatReadingWidth(readingWidth)); }}
    >
      <CaptionReadingWidthGlyph preset={readingWidth} />
    </CaptionActionButton>
  );

  return (
    <>
      {analyst}
      {viewSwitch}
      {readingWidthAction}
    </>
  );
}

/** 채팅 → 터미널. 순서가 계약이다: chat 모드 마커를 걷은 뒤에만 resume이 PTY를 되살린다(서버 ticket 가드). */
async function openTerminalForOperation(context: OperationRenderContext): Promise<void> {
  await exitAgentChat(context.operationId);
  try {
    await resumeSession(context.operationId);
    context.notifications.dismiss(context.operationId);
  } catch (error) {
    context.notifications.emit({
      kind: agentResumeFailedNotification.id,
      operationId: context.operationId,
      message: resumeFailureMessage(error, context.language),
    });
    throw error;
  }
}

const SORTIE_RIBBON_INLINE_LIMIT = 2;

function AgentOperationView({ context }: { readonly context: OperationRenderContext }) {
  const state = useAgentState();
  const session = state.sessions[context.operationId] ?? sessionFromOperation(context);
  const chatMode = context.operation.payload.chatMode === true;
  const sessionStatus = session.status;
  const { chatPromptOpen } = useViewSwitchState(context.operationId);
  React.useEffect(() => {
    // 확인 오버레이는 라이브 터미널 분기 전용이다 — PTY 종료·채팅 전환으로 분기를 떠나면
    // 상태를 걷어 재개 시 낡은 다이얼로그가 되살아나지 않게 한다(이전 ChatModeEntry의
    // 언마운트-폐기와 등가).
    if (sessionStatus === "dormant" || chatMode) setChatPromptOpen(context.operationId, false);
  }, [context.operationId, sessionStatus, chatMode]);
  // 피처 투어 앵커는 이 마운트에서 사용자가 직접 채팅 뷰로 전환한 뒤에만 세운다 — chatMode는
  // payload에 영속되므로 마운트 시점부터 앵커를 세우면 리로드 직후 캔버스에서 투어가 먼저
  // 떠버린다. "직접 연 순간에만"은 quick-launch-pin 투어와 같은 판정이다.
  const wasChatModeAtMountRef = React.useRef(chatMode);
  const chatOpenedHere = chatMode && !wasChatModeAtMountRef.current;

  if (chatMode) {
    return (
      <div className="agent-stream-host">
        <AgentChatView context={context} tourAnchors={chatOpenedHere} />
      </div>
    );
  }

  if (session.status === "dormant") {
    return (
      <div className="agent-stream-host">
        <DormantOperationView context={context} session={session} />
        {session.resumeAvailable ? <DormantChatEntry context={context} /> : null}
      </div>
    );
  }

  return (
    <div className="agent-stream-host">
      {/* 전환을 누르는 곳은 캡션이고, 무엇이 끝나야 넘어갈 수 있는지 말하는 이 오버레이는 본문이다. */}
      {chatPromptOpen ? <ChatModeInterstitial context={context} onClose={() => setChatPromptOpen(context.operationId, false)} /> : null}
      <TerminalSurface
        operationId={session.sessionId}
        ticketPath={AGENT_TICKET_PATH}
        wsPath={TERMINAL_WS_PATH}
        active={context.active}
        keyboardFocusRequestId={context.keyboardFocusRequestId}
        zoom={context.zoom}
        theme={context.theme}
        locale={context.language}
        onStatusDetail={(detail) => context.statusDetail.set(context.operationId, detail)}
        onExit={() => removeSession(session.sessionId)}
      />
    </div>
  );
}

/**
 * 전환이 막힌 사유 → 문구 키. 서버가 사유를 못 실어 보냈으면 뭉뚱그린 문구로 내려간다 —
 * 모르는 사유를 아는 척 이름 붙이는 것보다 낫다.
 */
type ChatConvertBusyKey =
  | "terminal.chat.convertBusy"
  | "terminal.chat.convertBusyTurn"
  | "terminal.chat.convertBusyAwaiting"
  | "terminal.chat.convertBusyBackground"
  | "terminal.chat.convertBusyStarting";

function chatConvertBusyKey(reason: string | null): ChatConvertBusyKey {
  switch (reason) {
    case "turn": return "terminal.chat.convertBusyTurn";
    case "awaiting": return "terminal.chat.convertBusyAwaiting";
    case "background": return "terminal.chat.convertBusyBackground";
    case "starting": return "terminal.chat.convertBusyStarting";
    default: return "terminal.chat.convertBusy";
  }
}

/** Chat view 전환 확인 오버레이 — 칩은 뷰 칩 줄이 소유하고, 여기는 확인과 서버 전환만 진다. */
function ChatModeInterstitial({ context, onClose }: { readonly context: OperationRenderContext; readonly onClose: () => void }) {
  const t = getT(context.language ?? "en");
  const [state, setState] = React.useState<"idle" | "converting" | "busy" | "error">("idle");
  // 무엇이 끝나야 전환되는지 — 서버가 구분해 보내 준 사유. 알 수 없으면 뭉뚱그린 문구로 내려간다.
  const [busyReason, setBusyReason] = React.useState<string | null>(null);
  const titleId = `agent-chat-inter-${context.operationId}`;
  const convert = React.useCallback(async () => {
    setState("converting");
    try {
      await convertAgentSessionToChat(context.operationId);
      // payload.chatMode 반영이 뷰를 전환한다 — 여기서는 오버레이만 닫는다.
      onClose();
    } catch (error) {
      const busy = error instanceof AgentApiError && error.message === "chat_convert_busy";
      setBusyReason(busy && error instanceof AgentApiError ? error.reason ?? null : null);
      setState(busy ? "busy" : "error");
    }
  }, [context.operationId, onClose]);
  return (
    <div className="agent-chat-interstitial" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
          <div className="agent-chat-inter-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <h4 id={titleId}>{t("terminal.chat.confirmTitle")}</h4>
            <p>{t("terminal.chat.confirmBody")}</p>
            <p className="agent-chat-inter-fine">{t("terminal.chat.confirmFine")}</p>
            {state === "busy" ? (
              <p className="agent-chat-inter-error" role="alert">
                <span className="agent-chat-inter-error-mark" aria-hidden="true">⚠</span>
                <span>{t(chatConvertBusyKey(busyReason))}</span>
              </p>
            ) : null}
            {state === "error" ? (
              <p className="agent-chat-inter-error" role="alert">
                <span className="agent-chat-inter-error-mark" aria-hidden="true">✕</span>
                <span>{t("terminal.chat.convertFailed")}</span>
              </p>
            ) : null}
            <div className="agent-chat-inter-actions">
              <button type="button" className="agent-chat-inter-button" autoFocus onClick={onClose}>
                {t("terminal.chat.confirmKeep")}
              </button>
              <button
                type="button"
                className="agent-chat-inter-button agent-chat-inter-button--primary"
                disabled={state === "converting"}
                onClick={() => { void convert(); }}
              >
                {t("terminal.chat.confirmSwitch")}
              </button>
            </div>
          </div>
    </div>
  );
}

/** 휴면 카드 위의 chat 진입 고스트 — 죽일 PTY조차 없는 가장 안전한 전환 경로다. */
function DormantChatEntry({ context }: { readonly context: OperationRenderContext }) {
  const t = getT(context.language ?? "en");
  const [state, setState] = React.useState<"idle" | "working" | "error">("idle");
  return (
    <button
      type="button"
      className="agent-chat-dormant-open"
      disabled={state === "working"}
      aria-label={t("terminal.chat.dormantOpenAria")}
      onClick={() => {
        setState("working");
        void convertAgentSessionToChat(context.operationId)
          .catch(() => { setState("error"); })
          .then(() => { setState((current) => current === "error" ? current : "idle"); });
      }}
    >
      {state === "error" ? t("terminal.chat.convertFailed") : t("terminal.chat.dormantOpen")}
    </button>
  );
}

function GeneralSection() {
  const { renderer: terminalRenderer, inactiveFlush: terminalInactiveFlush, font: terminalFont } = useTerminalPrefs();

  // 카드를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <ClaudeCodeSystemPromptSettingsBlock />
      <IdleAgentSessionsSettingsBlock />
      <TerminalFontSettingsCard terminalFont={terminalFont} />
      <ChatReadingWidthSettingsCard />
      <TerminalDrawingCard terminalRenderer={terminalRenderer} terminalInactiveFlush={terminalInactiveFlush} />
    </>
  );
}

/**
 * Claude Code 자신의 시스템 프롬프트를 새 세션에 실을지 고르는 표면. Fleet은 자기 프롬프트를
 * 싣지 않으므로 이 스위치가 끄는 것은 Claude Code의 것 하나뿐이다.
 */
function ClaudeCodeSystemPromptSettingsBlock() {
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
    <section className="global-settings-card" aria-label={t("terminal.settings.claudeSystemPromptAria")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <>
          <div className="global-settings-row">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title" id="claude-code-system-prompt-label">
                {t("terminal.settings.claudeSystemPromptTitle")}
                <SettingsScope kind="sessions" label={t("terminal.settings.scopeSessions")} />
              </p>
              <p className="global-settings-help">{t("terminal.settings.claudeSystemPromptHelp")}</p>
            </div>
            <Select
              aria-labelledby="claude-code-system-prompt-label"
              value={state.claudeCodeSystemPrompt}
              disabled={saving}
              options={[
                { value: "on", label: t("terminal.settings.claudeSystemPromptOn") },
                { value: "off", label: t("terminal.settings.claudeSystemPromptOff") },
              ]}
              onChange={(value) => void setSystemPromptSettingsField(
                "claudeCodeSystemPrompt",
                value as "on" | "off",
              )}
            />
          </div>
          <p className="global-settings-foot">{t("terminal.settings.claudeSystemPromptFoot")}</p>
        </>
      ) : (
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      )}
    </section>
  );
}

/** 채팅 읽기 폭 — 채팅 판면의 폭 칩과 같은 선호를 읽고 쓰는 설정 표면. */
function ChatReadingWidthSettingsCard() {
  const t = getT(useTerminalLocale());
  const width = useChatReadingWidth();
  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.chatReadingWidthAria")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title" id="terminal-chat-reading-width-label">{t("terminal.settings.chatReadingWidthTitle")}</p>
          <p className="global-settings-help">{t("terminal.settings.chatReadingWidthHelp")}</p>
        </div>
        <Select
          aria-labelledby="terminal-chat-reading-width-label"
          value={width}
          options={[
            { value: "reading", label: t("terminal.chat.readingWidth.reading") },
            { value: "wide", label: t("terminal.chat.readingWidth.wide") },
            { value: "full", label: t("terminal.chat.readingWidth.full") },
          ]}
          onChange={(value) => { setChatReadingWidth(value as ChatReadingWidth); }}
        />
      </div>
    </section>
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
            <p className="global-settings-resp-title" id="idle-agent-sessions-label">
              {t("terminal.settings.idleAgent")}
              <SettingsScope kind="live" label={t("terminal.settings.scopeLive")} />
            </p>
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
      <AiGatewayCompactTimingCard />
      <AiGatewayDiagnosticsCard />
    </>
  );
}

const AI_GATEWAY_PROVIDER_LABEL_KEYS = {
  antigravity: "terminal.settings.aiGatewayProviderAntigravity",
  codex: "terminal.settings.aiGatewayProviderCodex",
  cursor: "terminal.settings.aiGatewayProviderCursor",
  kimi: "terminal.settings.aiGatewayProviderKimi",
  opencode: "terminal.settings.aiGatewayProviderOpencode",
  xai: "terminal.settings.aiGatewayProviderXai",
} as const;

const AI_GATEWAY_PROVIDER_SUB_KEYS = {
  antigravity: "terminal.settings.aiGatewaySubAntigravity",
  codex: "terminal.settings.aiGatewaySubCodex",
  cursor: "terminal.settings.aiGatewaySubCursor",
  kimi: "terminal.settings.aiGatewaySubKimi",
  opencode: "terminal.settings.aiGatewaySubOpencode",
  xai: "terminal.settings.aiGatewaySubXai",
} as const;

function formatAiGatewayContextWindow(contextWindow: number | null): string | null {
  if (contextWindow === null) return null;
  return contextWindow >= 1_000_000 ? "1M" : `${Math.round(contextWindow / 1000)}K`;
}

const COMPACT_CEILING_EARLY = 88;
const COMPACT_CEILING_LATE = 97;
const COMPACT_CEILING_CUSTOM_MIN = 70;
const COMPACT_CEILING_CUSTOM_MAX = 99;
const PROVIDER_COMPACT_RESERVE = 16_000;
const COMPACT_CROWD_RESERVE = 8_000;

function compactPolicyFromCeiling(ceiling: CompactCeiling | null): "auto" | "early" | "late" | "custom" {
  if (ceiling === null) return "auto";
  if (ceiling === "early") return "early";
  if (ceiling === "late") return "late";
  return "custom";
}

function compactPercent(ceiling: CompactCeiling | null): number | undefined {
  if (ceiling === "early") return COMPACT_CEILING_EARLY;
  if (ceiling === "late") return COMPACT_CEILING_LATE;
  if (typeof ceiling === "number") return ceiling;
  return undefined;
}

function compactAtTokens(window: number, ceiling: CompactCeiling | null): number {
  const percent = compactPercent(ceiling);
  if (percent === undefined) return window - PROVIDER_COMPACT_RESERVE;
  return Math.floor(window * percent / 100);
}

/** Map a 70–99 compact percent onto the custom track (left = 70, right = 99). */
export function compactTrackFillPercent(windowPercent: number): number {
  const clamped = Math.min(
    COMPACT_CEILING_CUSTOM_MAX,
    Math.max(COMPACT_CEILING_CUSTOM_MIN, windowPercent),
  );
  return (clamped - COMPACT_CEILING_CUSTOM_MIN)
    / (COMPACT_CEILING_CUSTOM_MAX - COMPACT_CEILING_CUSTOM_MIN)
    * 100;
}

export function compactPercentFromTrackRatio(ratio: number): number {
  const next = COMPACT_CEILING_CUSTOM_MIN
    + ratio * (COMPACT_CEILING_CUSTOM_MAX - COMPACT_CEILING_CUSTOM_MIN);
  return Math.min(
    COMPACT_CEILING_CUSTOM_MAX,
    Math.max(COMPACT_CEILING_CUSTOM_MIN, Math.round(next)),
  );
}

function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? String(m) : m.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  return `${Math.round(n / 1000)}K`;
}

function AiGatewayCompactTimingCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingField !== null;
  const [previewId, setPreviewId] = React.useState<string>("");
  const [dragPercent, setDragPercent] = React.useState<number | null>(null);
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);
  const dragPercentRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);

  if (!state) {
    return (
      <section className="global-settings-card" aria-label={t("terminal.settings.compactTiming")}>
        <p className="global-settings-resp-title">{t("terminal.settings.compactTiming")}</p>
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      </section>
    );
  }

  const ceiling = state.compactCeiling;
  const policy = compactPolicyFromCeiling(ceiling);
  const previewModels = state.aiGatewayCatalog.providers.flatMap((provider) => provider.models)
    .filter((model) => typeof model.contextWindow === "number" && model.contextWindow > 0);
  const preview = previewModels.find((model) => model.id === previewId) ?? previewModels[0];
  const previewWindow = preview?.contextWindow ?? 272_000;
  const liveCeiling: CompactCeiling | null = policy === "custom" && dragPercent !== null
    ? dragPercent
    : ceiling;
  const at = compactAtTokens(previewWindow, liveCeiling);
  const shownPercent = Math.round(at * 100 / previewWindow);
  const trackFill = compactTrackFillPercent(shownPercent);
  const crowded = at >= previewWindow - COMPACT_CROWD_RESERVE || shownPercent >= 99;
  const lateBeforeAuto = compactAtTokens(previewWindow, "late") < compactAtTokens(previewWindow, null)
    && (liveCeiling === "late" || (typeof liveCeiling === "number" && liveCeiling === COMPACT_CEILING_LATE));

  const savePolicy = (next: "auto" | "early" | "late" | "custom"): void => {
    if (next === "auto") {
      void setSystemPromptSettingsField("compactCeiling", null);
      return;
    }
    if (next === "early" || next === "late") {
      void setSystemPromptSettingsField("compactCeiling", next);
      return;
    }
    const seed = typeof ceiling === "number"
      ? ceiling
      : ceiling === "early"
        ? COMPACT_CEILING_EARLY
        : ceiling === "late"
          ? COMPACT_CEILING_LATE
          : 94;
    void setSystemPromptSettingsField("compactCeiling", seed);
  };

  const saveCustom = (percent: number): void => {
    const clamped = Math.min(COMPACT_CEILING_CUSTOM_MAX, Math.max(COMPACT_CEILING_CUSTOM_MIN, Math.round(percent)));
    void setSystemPromptSettingsField("compactCeiling", clamped);
  };

  const setCustomFromClientX = (clientX: number): void => {
    const bar = trackRef.current?.getBoundingClientRect();
    if (!bar || bar.width <= 0) return;
    const next = compactPercentFromTrackRatio((clientX - bar.left) / bar.width);
    dragPercentRef.current = next;
    setDragPercent(next);
  };

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.compactTiming")}>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title" id="compact-timing-label">{t("terminal.settings.compactTiming")}</p>
          <p className="global-settings-help">{t("terminal.settings.compactTimingHelp")}</p>
        </div>
        <div className="segmented" role="group" aria-labelledby="compact-timing-label">
          <button type="button" className={`segmented-option${policy === "auto" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("auto")}>
            {t("terminal.settings.compactTimingAuto")}
          </button>
          <button type="button" className={`segmented-option${policy === "early" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("early")}>
            {t("terminal.settings.compactTimingEarly")}
          </button>
          <button type="button" className={`segmented-option${policy === "late" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("late")}>
            {t("terminal.settings.compactTimingLate")}
          </button>
          <button type="button" className={`segmented-option${policy === "custom" ? " is-active" : ""}`} disabled={saving} onClick={() => savePolicy("custom")}>
            {t("terminal.settings.compactTimingCustom")}
          </button>
        </div>
      </div>
      {previewModels.length > 0 ? (
        <div className="compact-timing-preview">
          <label className="compact-timing-preview-label" htmlFor="compact-timing-preview">
            {t("terminal.settings.compactTimingPreview")}
          </label>
          <Select
            id="compact-timing-preview"
            value={preview?.id ?? ""}
            options={previewModels.map((model) => ({
              value: model.id,
              label: `${model.name} — ${formatAiGatewayContextWindow(model.contextWindow)}`,
            }))}
            onChange={(id) => setPreviewId(id)}
            disabled={saving}
          />
          <p className="global-settings-help">{t("terminal.settings.compactTimingPreviewHelp")}</p>
        </div>
      ) : null}
      <div className="compact-timing-track-wrap">
        <div
          ref={trackRef}
          className={`compact-timing-track${policy === "custom" && !saving ? " is-live" : ""}${crowded ? " is-warn" : ""}`}
          onPointerDown={(event) => {
            if (policy !== "custom" || saving) return;
            draggingRef.current = true;
            (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
            setCustomFromClientX(event.clientX);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            setCustomFromClientX(event.clientX);
          }}
          onPointerUp={() => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            const next = dragPercentRef.current;
            dragPercentRef.current = null;
            setDragPercent(null);
            if (next !== null) saveCustom(next);
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
            dragPercentRef.current = null;
            setDragPercent(null);
          }}
        >
          <div className="compact-timing-bar">
            <div className="compact-timing-fill" style={{ width: `${trackFill}%` }} />
          </div>
          <div className="compact-timing-thumb" style={{ left: `${trackFill}%` }} />
          <input
            className="compact-timing-sr"
            type="range"
            min={COMPACT_CEILING_CUSTOM_MIN}
            max={COMPACT_CEILING_CUSTOM_MAX}
            step={1}
            value={typeof liveCeiling === "number" ? liveCeiling : shownPercent}
            disabled={policy !== "custom" || saving}
            aria-label={t("terminal.settings.compactTimingCustomAria")}
            onChange={(event) => saveCustom(Number(event.target.value))}
          />
        </div>
        <div className="compact-timing-ticks">
          <span>70%</span>
          <span>{shownPercent}%</span>
          <span>{t("terminal.settings.compactTimingWindow")}</span>
        </div>
      </div>
      <div className="compact-timing-readout">
        <div className="compact-timing-stat">
          <span>{t("terminal.settings.compactTimingAt")}</span>
          <strong>{formatCompactTokens(at)}</strong>
        </div>
        <div className="compact-timing-stat">
          <span>{t("terminal.settings.compactTimingOfWindow")}</span>
          <strong>{shownPercent}%</strong>
        </div>
        <div className="compact-timing-stat">
          <span>{t("terminal.settings.compactTimingCatalog")}</span>
          <strong>{formatAiGatewayContextWindow(previewWindow)}</strong>
        </div>
      </div>
      <p className={`compact-timing-note${crowded || lateBeforeAuto ? " is-warn" : ""}`}>
        {crowded
          ? t("terminal.settings.compactTimingCrowd")
          : lateBeforeAuto
            ? t("terminal.settings.compactTimingLateBeforeAuto", {
              late: formatCompactTokens(at),
              auto: formatCompactTokens(compactAtTokens(previewWindow, null)),
            })
            : policy === "auto"
              ? t("terminal.settings.compactTimingAutoNote", {
                at: formatCompactTokens(at),
                window: formatAiGatewayContextWindow(previewWindow) ?? "",
              })
              : policy === "custom"
                ? t("terminal.settings.compactTimingCustomNote", { percent: String(typeof liveCeiling === "number" ? liveCeiling : shownPercent) })
                : t(policy === "early" ? "terminal.settings.compactTimingEarlyNote" : "terminal.settings.compactTimingLateNote")}
      </p>
      <p className="global-settings-foot">{t("terminal.settings.compactTimingFoot")}</p>
    </section>
  );
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
  const priority = (selection.providerPriority ?? []).filter(
    (id): id is AiGatewayProviderId => id in AI_GATEWAY_PROVIDER_LABEL_KEYS,
  );

  const save = (next: AiGatewaySettings): void => {
    const models = next.models ?? [];
    // 우선순위는 이 저장에 싣지 않는다 — 키 부재를 서버가 "보존"으로 읽으므로, 다른
    // 호스트가 그 사이 바꾼 소진 순서를 모델 편집이 스테일 스냅숏으로 덮지 않는다.
    // 우선순위를 싣는 유일한 경로는 칩 액션(savePriority)이다.
    const normalized = models.length === 0 ? null : { models };
    void setSystemPromptSettingsField("aiGateway", normalized);
  };

  const savePriority = (nextPriority: readonly AiGatewayProviderId[]): void => {
    // 전체-값 PUT 계약상 우선순위만 보내면 모델 선택이 지워진다 — 현재 스냅숏을 함께
    // 싣는다. 빈 배열은 명시 해제의 유일한 철자이고, 해제할 것도 없는 전량 공백만 null.
    const value: AiGatewaySettings = {
      ...(enabled.length > 0 ? { models: enabled } : {}),
      providerPriority: nextPriority,
    };
    const nothingElse = enabled.length === 0;
    const normalized = nothingElse && nextPriority.length === 0 && priority.length === 0 ? null : value;
    void setSystemPromptSettingsField("aiGateway", normalized);
  };

  const toggleProviderPriority = (id: AiGatewayProviderId): void => {
    const next = priority.includes(id)
      ? priority.filter((entry) => entry !== id)
      : [...priority, id];
    savePriority(next);
  };

  const addModel = (model: AiGatewayCatalogModel): void => {
    if (enabled.some((entry) => entry.id === model.id)) return;
    save({ ...selection, models: [...enabled, { id: model.id }] });
  };
  const removeModel = (id: string): void => {
    save(composeAiGatewayRemoval(selection, id));
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
        : {
          id: entry.id,
          ...(ordered.length === ladder.length ? {} : { efforts: ordered }),
          ...(entry.hostOnly === true ? { hostOnly: true } : {}),
        }),
    });
  };
  const setModelHostOnly = (model: AiGatewayCatalogModel, next: boolean): void => {
    save({
      ...selection,
      models: enabled.map((entry) => {
        if (entry.id !== model.id) return entry;
        const { hostOnly: _hostOnly, ...rest } = entry;
        return next ? { ...rest, hostOnly: true } : rest;
      }),
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
      ) : null}
      {state.aiGatewayCatalog.providers.map((provider) => (
        <AiGatewayProviderBlock
          key={provider.id}
          provider={provider}
          selection={selection}
          saving={saving}
          priorityRank={priority.indexOf(provider.id as AiGatewayProviderId)}
          onTogglePriority={toggleProviderPriority}
          onAdd={addModel}
          onRemove={removeModel}
          onSetEfforts={setModelEfforts}
          onSetHostOnly={setModelHostOnly}
        />
      ))}
      <p className="global-settings-foot">{t("terminal.settings.aiGatewayModelsFoot")}</p>
    </section>
  );
}

/**
 * 모델 제거 시 저장 본문. 제거되는 모델이 기본 모델이면 기본값도 함께 접되,
 * providerPriority 등 나머지 축은 그대로 실어 보낸다 — 이 카드의 저장은 항상
 * 우선순위 키를 에코하므로, 선택 스프레드를 빠뜨리면 제거 한 번이 해제로 둔갑한다.
 */
/**
 * 픽커가 기준 선택지로 내놓는 모델.
 *
 * `fast`는 `-fast` id 접미사로 추론되는데, 그 접미사가 언제나 변형 쌍을 뜻하지는 않는다.
 * `grok-composer-2.5-fast`는 카탈로그에 없는 `grok-composer-2.5`의 빠른 빌드가 아니라 그
 * 자체가 모델 이름이다. 플래그만 보고 걸러내면 픽커에서 사라지고 토글을 걸 기준 모델도 없어
 * 어디로도 선택할 수 없다. fast 모델은 자기가 지목하는 기준이 실제로 있을 때만 변형으로 남는다.
 */
export function selectAiGatewayBaseModels(
  models: readonly AiGatewayCatalogModel[],
): AiGatewayCatalogModel[] {
  return models.filter((model) => !model.fast
    || !models.some((candidate) => `${candidate.id}-fast` === model.id));
}

export function composeAiGatewayRemoval(selection: AiGatewaySettings, id: string): AiGatewaySettings {
  const { models, ...rest } = selection;
  return {
    ...rest,
    models: (models ?? []).filter((entry) => entry.id !== id),
  };
}

interface AiGatewayPriorityToggleProps {
  readonly provider: AiGatewayProviderId;
  /** 소진 순서에서의 0-기준 자리. 순서 밖이면 -1. */
  readonly rank: number;
  readonly saving: boolean;
  readonly onToggle: (id: AiGatewayProviderId) => void;
}

/**
 * 공급자 소진 순서 옵트인. 공급자를 고르는 자리는 그 공급자의 헤드 한 곳뿐이므로,
 * 토글은 이름 옆에 붙어 자기 공급자만 말하고 순위 숫자로 자리를 함께 드러낸다.
 * 순서는 상태가 아니라 사용자 선호라서 등급 배지와 같은 규율로 신호색·brass 없이
 * 잉크 농도와 숫자로만 말한다. 누르면 순서 끝에 추가/제거하는 문법은 그대로라
 * 드래그 프리미티브 없이 순서 전체를 다룬다.
 */
export function AiGatewayPriorityToggle({ provider, rank, saving, onToggle }: AiGatewayPriorityToggleProps) {
  const t = getT(useTerminalLocale());
  const ranked = rank >= 0;
  const providerLabel = t(AI_GATEWAY_PROVIDER_LABEL_KEYS[provider]);
  const tipId = `ai-gateway-priority-tip-${provider}`;
  return (
    <>
      <button
        type="button"
        className={`ai-gateway-priority-toggle${ranked ? " is-ranked" : ""}`}
        disabled={saving}
        aria-pressed={ranked}
        aria-label={ranked
          ? t("terminal.settings.aiGatewayPriorityRemoveAria", { provider: providerLabel, rank: rank + 1 })
          : t("terminal.settings.aiGatewayPriorityAddAria", { provider: providerLabel })}
        // 접근성 이름은 결과 행동만 말하므로, 소진 순서가 무엇인지는 말풍선이 설명으로 잇는다 —
        // 말풍선을 트리에서 감추면 스크린리더에는 설명 없는 "소진 순서"만 남는다.
        aria-describedby={tipId}
        onClick={() => onToggle(provider)}
      >
        {ranked ? <span className="ai-gateway-priority-rank" aria-hidden="true">{rank + 1}</span> : null}
        {t("terminal.settings.aiGatewayPriority")}
      </button>
      {/* 칩 줄이 사라지며 의미를 말하던 라벨·도움말도 사라지므로, hover·키보드 포커스에서
          한 줄 요약 말풍선이 그 자리를 진다. 버튼 밖 형제로 두는 것은 배치 문제다 —
          버튼 안에 두면 폭 기준이 버튼이라 좁은 화면에서 말풍선이 뷰포트를 넘는다. */}
      <span className="ai-gateway-priority-tip" id={tipId}>
        {t("terminal.settings.aiGatewayPriorityTip")}
      </span>
    </>
  );
}

interface AiGatewayProviderBlockProps {
  readonly provider: AiGatewayCatalogProvider;
  readonly selection: AiGatewaySettings;
  readonly saving: boolean;
  /** 소진 순서에서의 0-기준 자리. 순서 밖이면 -1. */
  readonly priorityRank: number;
  readonly onTogglePriority: (id: AiGatewayProviderId) => void;
  readonly onAdd: (model: AiGatewayCatalogModel) => void;
  readonly onRemove: (id: string) => void;
  readonly onSetEfforts: (model: AiGatewayCatalogModel, efforts: readonly string[]) => void;
  readonly onSetHostOnly: (model: AiGatewayCatalogModel, next: boolean) => void;
}

function AiGatewayProviderBlock({
  provider,
  selection,
  saving,
  priorityRank,
  onTogglePriority,
  onAdd,
  onRemove,
  onSetEfforts,
  onSetHostOnly,
}: AiGatewayProviderBlockProps) {
  const t = getT(useTerminalLocale());
  const baseModels = selectAiGatewayBaseModels(provider.models);
  const [draftBase, setDraftBase] = React.useState(baseModels[0]?.id ?? "");
  const [draftFast, setDraftFast] = React.useState(false);

  const enabledRows = (selection.models ?? []).flatMap((entry) => {
    const model = provider.models.find((candidate) => candidate.id === entry.id);
    return model === undefined ? [] : [{
      model,
      efforts: entry.efforts,
      hostOnly: entry.hostOnly === true,
    }];
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
        <span className="ai-gateway-provider-glyph" aria-hidden="true">{launchProviderGlyph(provider.id as AiGatewayProviderId)}</span>
        <span className="ai-gateway-provider-name">{providerLabel}</span>
        <AiGatewayPriorityToggle
          provider={provider.id as AiGatewayProviderId}
          rank={priorityRank}
          saving={saving}
          onToggle={onTogglePriority}
        />
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
          {enabledRows.map(({ model, efforts, hostOnly }) => (
            <AiGatewayModelRow
              key={model.id}
              model={model}
              exposedEfforts={efforts}
              hostOnly={hostOnly}
              saving={saving}
              onRemove={() => onRemove(model.id)}
              onSetEfforts={(next) => onSetEfforts(model, next)}
              onToggleHostOnly={() => onSetHostOnly(model, !hostOnly)}
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
      {provider.id === "xai" ? <AiGatewayXaiEndpointRow saving={saving} /> : null}
    </div>
  );
}

/**
 * Which endpoint xAI turns use. Every turn uses it — the two do not share a prompt cache, so
 * rerouting one mid-conversation would re-prefill the whole thing.
 *
 * It sits inside the provider block rather than in a card of its own because it is a property
 * of this provider's route, meaningless to a reader who has not enabled an xAI model.
 */
function AiGatewayXaiEndpointRow({ saving }: { readonly saving: boolean }) {
  const t = getT(useTerminalLocale());
  const state = useSystemPromptSettingsStore().state;
  if (!state) return null;
  const endpoint = state.xaiEndpoint;
  return (
    <div className="ai-gateway-composer">
      <span className="ai-gateway-field-label" id="xai-endpoint-label">{t("terminal.settings.xaiEndpoint")}</span>
      <div className="segmented" role="group" aria-labelledby="xai-endpoint-label">
        <button
          type="button"
          className={`segmented-option${endpoint === "cli-proxy" ? " is-active" : ""}`}
          disabled={saving}
          onClick={() => void setSystemPromptSettingsField("xaiEndpoint", "cli-proxy")}
        >
          {t("terminal.settings.xaiEndpointProxy")}
        </button>
        <button
          type="button"
          className={`segmented-option${endpoint === "direct" ? " is-active" : ""}`}
          disabled={saving}
          onClick={() => void setSystemPromptSettingsField("xaiEndpoint", "direct")}
        >
          {t("terminal.settings.xaiEndpointDirect")}
        </button>
      </div>
      <span className="ai-gateway-composer-note">{t("terminal.settings.xaiEndpointHelp")}</span>
    </div>
  );
}

interface AiGatewayModelRowProps {
  readonly model: AiGatewayCatalogModel;
  /** 부재 = 사다리 전체 노출. */
  readonly exposedEfforts?: readonly string[];
  readonly hostOnly: boolean;
  readonly saving: boolean;
  readonly onRemove: () => void;
  readonly onSetEfforts: (efforts: readonly string[]) => void;
  readonly onToggleHostOnly: () => void;
}

export function AiGatewayModelRow({
  model,
  exposedEfforts,
  hostOnly,
  saving,
  onRemove,
  onSetEfforts,
  onToggleHostOnly,
}: AiGatewayModelRowProps) {
  const t = getT(useTerminalLocale());

  return (
    <div className="ai-gateway-model-row">
      <span className="ai-gateway-model-text">
        <span className="ai-gateway-model-head">
          <span className="ai-gateway-model-name">{model.name}</span>
          <AiGatewayCapabilityBadge capabilityClass={model.capabilityClass} />
        </span>
        <span className="ai-gateway-model-id">{model.id}</span>
      </span>
      <AiGatewayModelChips
        model={model}
        exposedEfforts={exposedEfforts}
        hostOnly={hostOnly}
        saving={saving}
        onSetEfforts={onSetEfforts}
      />
      <button
        type="button"
        className={`ai-gateway-host-only ${hostOnly ? "is-on" : ""}`}
        aria-pressed={hostOnly}
        aria-label={t("terminal.settings.aiGatewayHostOnlyAria", { name: model.name })}
        disabled={saving}
        onClick={onToggleHostOnly}
      >
        {t("terminal.settings.aiGatewayHostOnly")}
      </button>
      {/* 인접 형제여야 hover·focus 선택자가 닿는다 — 사이에 무엇도 끼우지 말 것. */}
      <span className="ai-gateway-host-only-tip" role="tooltip">
        {t("terminal.settings.aiGatewayHostOnlyTip")}
      </span>
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
  );
}

/**
 * 강도 배지를 펼친 형태. 배지 하나가 노출 사다리 전체를 보여주고 그 자리에서 고르게 한다 —
 * 접기 뒤에 두면 어떤 단계가 살아 있는지가 한 번 더 펼쳐야 보이는 사실이 되고, 요약 숫자는
 * 어느 단계를 껐는지 말하지 못한다. 켜진 세그먼트는 위치 채널(brass)로만 말한다.
 */
function AiGatewayEffortBadge({
  model,
  exposed,
  hostOnly,
  saving,
  onSetEfforts,
}: {
  readonly model: AiGatewayCatalogModel;
  readonly exposed: readonly string[];
  readonly hostOnly: boolean;
  readonly saving: boolean;
  readonly onSetEfforts: (efforts: readonly string[]) => void;
}) {
  const t = getT(useTerminalLocale());
  const ladder = model.effort?.levels ?? [];
  return (
    <span
      className="ai-gateway-effort"
      role="group"
      aria-label={t("terminal.settings.aiGatewayLevelsAria", { name: model.name })}
      // 호스트 전용 모델의 정체성 수는 0이라, 켜진 단계를 세어 보여 주면 그 문장이 거짓이 된다.
      title={hostOnly
        ? t("terminal.settings.aiGatewayHostOnlyNote")
        : t("terminal.settings.aiGatewayIdentityCount", { count: exposed.length })}
    >
      <span className="ai-gateway-effort-label" aria-hidden="true">effort</span>
      {ladder.map((level) => {
        const isOn = exposed.includes(level);
        return (
          <button
            key={level}
            type="button"
            className={`ai-gateway-effort-level ${isOn ? "is-on" : ""}`}
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
    </span>
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
  hostOnly = false,
  saving = false,
  onSetEfforts,
}: {
  readonly model: AiGatewayCatalogModel;
  readonly exposedEfforts?: readonly string[];
  readonly hostOnly?: boolean;
  readonly saving?: boolean;
  /** 부재 = 아직 켜지 않은 모델의 미리보기라 고를 선택이 없다. */
  readonly onSetEfforts?: (efforts: readonly string[]) => void;
}) {
  const t = getT(useTerminalLocale());
  const contextLabel = formatAiGatewayContextWindow(model.contextWindow);
  const ladder = model.effort?.levels ?? [];
  const exposed = resolveExposedEfforts(ladder, exposedEfforts);
  return (
    <span className="ai-gateway-chips">
      {contextLabel ? <span className="ai-gateway-chip">{contextLabel}</span> : null}
      {ladder.length === 0 ? null : onSetEfforts === undefined ? (
        // 아직 켜지 않은 모델은 고를 선택이 없으므로 사다리의 양 끝만 속성으로 말한다.
        <span className="ai-gateway-chip">
          {`effort ${ladder[0]}–${ladder[ladder.length - 1]}`}
        </span>
      ) : (
        <AiGatewayEffortBadge model={model} exposed={exposed} hostOnly={hostOnly} saving={saving} onSetEfforts={onSetEfforts} />
      )}
      {model.fast ? <span className="ai-gateway-chip">{t("terminal.settings.aiGatewayFast")}</span> : null}
      {model.maxMode ? <span className="ai-gateway-chip is-strong">{t("terminal.settings.aiGatewayMaxMode")}</span> : null}
      {model.description ? <span className="ai-gateway-chip">{model.description}</span> : null}
    </span>
  );
}

/**
 * 등급마다 한 줄 설명. 라벨은 카탈로그 리터럴을 그대로 쓰고 이 문장만 번역한다 — 등급 이름을
 * 옮기면 배지와 호스트가 읽는 이름이 갈라져 같은 모델을 두 어휘로 말하게 된다.
 */
const AI_GATEWAY_CLASS_TOOLTIP_KEYS = {
  flagship: "terminal.settings.aiGatewayClassFlagshipTooltip",
  standard: "terminal.settings.aiGatewayClassStandardTooltip",
  light: "terminal.settings.aiGatewayClassLightTooltip",
  unclassed: "terminal.settings.aiGatewayClassUnclassedTooltip",
} as const;

/**
 * 등급은 로스터에서 유일한 품질 신호라서 속성 칩과 섞지 않고 모델 이름에 붙인다. 서열은
 * 신호색이 아니라 잉크 강도로만 말한다 — 등급은 상태가 아니라 프로바이더가 주장하는 속성이다.
 */
function AiGatewayCapabilityBadge({ capabilityClass }: { readonly capabilityClass: AiGatewayCapabilityClass | null }) {
  const t = getT(useTerminalLocale());
  // 카탈로그 검증이 라우팅 별칭에 등급을 금지하므로, 부재는 결측이 아니라 그 자체가 사실이다.
  const grade = capabilityClass ?? "unclassed";
  return (
    <span className={`ai-gateway-class-badge is-${grade}`} title={t(AI_GATEWAY_CLASS_TOOLTIP_KEYS[grade])}>
      {grade}
    </span>
  );
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

// 패널 DormantOperationView 의 freshOnly(!session.resumeAvailable) 와 같은 판정.
// 세션 스냅샷이 아직 없으면 호스트 DTO 의 파생 마커를 읽는다. 조회가 실패하면
// fresh 를 추측하지 않는다 — 재개 가능한 Claude 세션을 지울 수 있다.
async function shouldResumeFresh(operationId: string): Promise<boolean> {
  const session = getAgentState().sessions[operationId];
  if (session) return !session.resumeAvailable;
  try {
    const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`);
    if (!response.ok) return false;
    const payload = await response.json() as {
      readonly operation?: { readonly payload?: { readonly resumeAvailable?: unknown } };
    };
    return payload.operation?.payload?.resumeAvailable !== true;
  } catch {
    return false;
  }
}

// dormant 프레임의 resume 상태기계. 실패는 프레임 내 에러 카드(Try again / Start fresh)와
// Alerts 알림(agent.resume-failed) 두 경로로 표면화한다 — 어느 쪽도 침묵하지 않는다.
function DormantOperationView({ context, session }: { readonly context: OperationRenderContext; readonly session: SessionInfo }) {
  const t = getT(context.language ?? "en");
  const freshOnly = !session.resumeAvailable;
  const [resumeState, setResumeState] = React.useState<"idle" | "resuming" | "error" | "launch-option-error">("idle");
  const resume = React.useCallback(async (fresh: boolean) => {
    setResumeState("resuming");
    try {
      await resumeSession(session.sessionId, { fresh });
      // 성공 시 이전 실패 알림을 거둔다 — 두지 않으면 live 세션에 "Resume failed" 뱃지가 남는다.
      context.notifications.dismiss(session.sessionId);
    } catch (error) {
      setResumeState(isLaunchOptionError(error) ? "launch-option-error" : "error");
      context.notifications.emit({
        kind: agentResumeFailedNotification.id,
        operationId: session.sessionId,
        message: resumeFailureMessage(error, context.language),
      });
    }
  }, [context, session.sessionId, t]);

  if (resumeState === "error" || resumeState === "launch-option-error") {
    return (
      <div className="canvas-operation-dormant canvas-operation-dormant--error" role="alert">
        <span className="canvas-operation-dormant-status">{t("terminal.dormant.status")}</span>
        <p className="canvas-operation-dormant-error">
          {resumeState === "launch-option-error"
            ? t("terminal.dormant.resumeLaunchOptionFailedBody", { name: session.label || session.cwdLabel })
            : freshOnly
              ? t("terminal.dormant.startFreshFailedBody", { name: session.label || session.cwdLabel })
              : t("terminal.dormant.resumeFailedBody", { name: session.label || session.cwdLabel })}
        </p>
        <div className="canvas-operation-dormant-error-actions">
          {freshOnly ? (
            <button type="button" className="canvas-operation-dormant-action" onClick={() => { void resume(true); }}>
              {t("terminal.dormant.tryAgain")}
            </button>
          ) : (
            <button type="button" className="canvas-operation-dormant-action" onClick={() => { void resume(false); }}>
              {t("terminal.dormant.tryAgain")}
            </button>
          )}
          {resumeState === "launch-option-error" || freshOnly ? null : (
            <button type="button" className="canvas-operation-dormant-action canvas-operation-dormant-action--ghost" onClick={() => { void resume(true); }}>
              {t("terminal.dormant.startFresh")}
            </button>
          )}
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

function sessionFromOperation(context: OperationRenderContext): SessionInfo {
  return {
    sessionId: context.operation.id,
    terminalSessionId: context.operation.id,
    cwdLabel: context.operation.title || "Workspace",
    label: context.operation.title,
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
          <p className="global-settings-resp-title">
            {t("terminal.settings.terminalFont")}
            <SettingsScope kind="live" label={t("terminal.settings.scopeLive")} />
          </p>
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
    </section>
  );
}

// 렌더러와 갱신 주기는 같은 축이다 — 둘 다 이 브라우저가 터미널을 그리는 방식이고, 둘 다 브라우저
// 로컬에 남는다. 그래서 한 카드의 두 행으로 둔다(카드의 접근성 이름은 두 행을 아우른다).
function TerminalDrawingCard({ terminalRenderer, terminalInactiveFlush }: {
  readonly terminalRenderer: TerminalRenderer;
  readonly terminalInactiveFlush: TerminalInactiveFlush;
}) {
  const t = getT(useTerminalLocale());
  const rendererLabels = { webgl: t("terminal.settings.webgl"), dom: t("terminal.settings.dom") } as const;
  const inactiveFlushLabels = {
    saving: t("terminal.settings.inactiveFlushSaving"),
    balanced: t("terminal.settings.inactiveFlushBalanced"),
    instant: t("terminal.settings.inactiveFlushInstant"),
  } as const;
  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.terminalDrawingAria")}>
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
                {rendererLabels[rendererId]}
              </button>
            );
          })}
        </div>
      </div>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">{t("terminal.settings.inactiveFlush")}</p>
          <p className="global-settings-help">{t("terminal.settings.inactiveFlushHelp")}</p>
        </div>
        <div className="segmented" role="group" aria-label={t("terminal.settings.inactiveFlushAria")}>
          {INACTIVE_FLUSH_IDS.map((inactiveFlushId) => {
            const isActive = inactiveFlushId === terminalInactiveFlush;
            return (
              <button
                key={inactiveFlushId}
                type="button"
                aria-pressed={isActive}
                className={`segmented-option ${isActive ? "is-active" : ""}`}
                onClick={() => setTerminalInactiveFlush(inactiveFlushId)}
              >
                {inactiveFlushLabels[inactiveFlushId]}
              </button>
            );
          })}
        </div>
      </div>
      <p className="global-settings-foot">{t("terminal.settings.terminalDrawingFoot")}</p>
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
