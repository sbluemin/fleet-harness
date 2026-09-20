import { FontPicker, type FontPickerInstalledFont, type FontPickerSelection } from "@fleet-console/font-picker/browser";
import "@fleet-console/font-picker/styles.css";
import { fetchSystemFonts, type SystemFontRecord } from "@fleet-console/font-picker/system-fonts";
import {
CaptionActionButton,
CaptionAnalystGlyph,
CaptionBrowserUseGlyph,
CaptionChatGlyph,
CaptionComputerUseGlyph,
CaptionConsoleUseGlyph,
CaptionTerminalGlyph,
CaptionWatchGlyph,
} from "@fleet-console/sdk/components/caption-actions";
import { launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { defineNotificationKind } from "@fleet-console/sdk/notifications/browser";
import type { ClientExecutionProvider, OperationMenuContext, OperationRenderContext, PluginInstallContext } from "@fleet-console/sdk/plugin";
import { React, defineOperationKind } from "@fleet-console/sdk/plugin/browser";
import { SegmentedThumb, Select } from "@fleet-console/sdk/react/browser";
import { SettingsCheckbox, SettingsHelpTip, SettingsToggle, defineSettingsSection } from "@fleet-console/sdk/settings/browser";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../../core/client/src/integration/operations-sse.js";
import { focusOperation as focusConsoleOperation, requestOperationKeyboardFocus, themePolarity } from "../../../../core/client/src/integration/store.js";
import { fetchAnalysisCatalog, fetchAnalysisReady } from "../../../analyst/client/analysis-api.js";
import { AnalystChatPanel } from "../../../analyst/client/analysis-chat-panel.js";
import { disposeAnalysisStore, useAnalysisStore } from "../../../analyst/client/analysis-store.js";
import {
ANALYST_CHAT_COMPANION_ID,
ANALYST_COMPANION_IDS,
closeAnalystCompanionPanels,
isCompanionPanelVisible,
} from "../../../analyst/client/analysis-visibility.js";
import "../../../analyst/client/analysis.css";
import { useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { BrowserCaption, BrowserPanel } from "../../../browser/client/browser-panel.js";
import { ComputerScreenShare, useOperationUse } from "../../../computer-use/client/computer-screen-share.js";
import { gestureCallerLabel, getOperationWrap, readLaunchAttribution, subscribeConsoleUseGestures } from "../../../console-use/client/gestures.js";
import { fontCjkScripts, type CjkScript } from "../terminal/shared/cjk-coverage.js";
import { TerminalSurface } from "../terminal/shared/index.js";
import type { ChatReadingWidth, TerminalFontId, TerminalFontSettings, TerminalInactiveFlush, TerminalRenderer } from "../terminal/shared/terminal-preferences.js";
import { CURATED_TERMINAL_FONTS, DEFAULT_TERMINAL_FONT, TERMINAL_FONT_SIZE_RANGE, curatedTerminalFontFamily, defaultTerminalFontFamily, getTerminalPrefsSnapshot, setChatReadingWidth, setInstalledTerminalFont, setTerminalCjkFallbackFont, setTerminalFont, setTerminalFontSize, setTerminalInactiveFlush, setTerminalRenderer, terminalFontFallbackStack, useChatReadingWidth, useTerminalPrefs } from "../terminal/shared/terminal-preferences.js";
import "./agent-cli.css";
import { pushComposerInbox } from "./chat/composer-inbox.js";
import { OPERATION_REVEAL_EVENT_CHANNEL, SESSION_WATCH_EVENT_CHANNEL, getOperationReveal, getSessionWatchReview, isOperationRevealEvent, isSessionWatchAlert, isSessionWatchEvent, readComputerUseEnabled, readConsoleUseEnabled, readInstalledExperiments, readWatchEnabled, readWatchLast, recordOperationReveal, recordSessionWatchEvent, refineLaunchPrompt, setComputerUse, setConsoleUse, setInstalledExperiments, setSessionWatch, subscribeInstalledExperiments, subscribeOperationReveals, subscribeSessionWatchReviews, type OperationReveal, type SessionWatchReview } from "./experiments-api.js";
import { currentTerminalLocale, getT, useTerminalLocale, type TerminalMessageKey } from "./i18n/index.js";
import { disposeViewSwitch, setChatPromptOpen, setTerminalHandoff, useViewSwitchState } from "./view-switch-store.js";

const BROWSER_COMPANION_ID = "browser";

import { aiGatewaySettingsSection as agentSettingsSection } from "../../../ai-gateway/client/settings.js";
import { loadSystemPromptSettings, setSystemPromptSettingsField, useSystemPromptSettingsStore } from "../../../settings/client/execution-settings.js";
import { AgentApiError, convertAgentSessionToChat, createAgentSession, discardLaunchAttachment, exitAgentChat, fetchAgentCliDiagnostics, fetchAgentCliState, fetchClaudeBuiltInAgents, messageAgentSession, resumeAgentSession, setAgentCliPath, terminateAgentSession, uploadLaunchAttachment } from "./api.js";
import { AgentChatView } from "./chat/chat-view.js";
import { startAgentConnection } from "./connection.js";
import { applySessionUpdate, getAgentState, removeSession, selectSession, useAgentState } from "./store.js";
import type { AgentCliDiagnosticsEntry, AgentCliStatus, ClaudeBuiltInAgentsState, SessionInfo } from "./types.js";

interface SettingToggleRowProps {
  readonly title: string;
  readonly help: string;
  readonly value: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

interface PinnedScrollLocal {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly contentRef: React.RefObject<HTMLDivElement | null>;
}

const RENDERER_IDS = ["webgl", "dom"] as const satisfies readonly TerminalRenderer[];
// 절약 → 즉시 순서로 둔다 — 세그먼트를 오른쪽으로 갈수록 더 자주 그리는 축으로 읽게 한다.
const INACTIVE_FLUSH_IDS = ["saving", "balanced", "instant"] as const satisfies readonly TerminalInactiveFlush[];

const AGENT_TICKET_PATH = "/api/v1/agent/ticket";
const TERMINAL_WS_PATH = "/api/v1/terminal/ws";
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
  pluginId: null,
  type: "agent",
  title: (locale) => getT(locale)("terminal.kind.agent"),
  subtitle: () => "Claude Code",
  render: (context) => <AgentOperationView context={context} />,
  // 분석가·뷰 전환·읽기 폭은 캡션 밴드가 진다 — 본문 위에 떠 있던 칩 줄이 하던 일이다.
  captionActions: (context) => <AgentCaptionActions context={context} />,
  // 이 Operation에 **대한** 실험 스위치(관찰·콘솔 사용·컴퓨터 사용)는 캡션이 아니라 ··· 메뉴가 진다 —
  // 사이드바 우클릭·War Room 카드도 같은 메뉴를 열므로 어디서 열든 같은 스위치를 본다.
  operationMenu: (context) => <AgentOperationMenu context={context} />,
  // 켜진 스위치는 사이드바 칩에도 마크로 선다 — 목록에서 "이 세션은 콘솔을 잡고 있다"가 읽히게.
  operationMarks: (context) => <AgentOperationMarks context={context} />,
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
    { id: ANALYST_CHAT_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.sessionAnalyst"), defaultHidden: true, shortcut: { code: "KeyA", label: "A", clusterIds: ANALYST_COMPANION_IDS }, // 캡션 없는 companion — 정체·상태·모드 컨트롤은 본문의 발판 줄(컴포저 위)이 진다. 호스트는 캡션 높이를 본문에 돌려준다.
      hideCaption: true, render: (context) => <AnalystChatPanel context={context} /> },
    // Operation Browser — 실험을 켠 Console에서만 선다. 허용은 패널 안에서 켤 수 있다.
    { id: BROWSER_COMPANION_ID, title: (locale) => getT(locale)("terminal.companion.browser"), defaultHidden: true, shortcut: { code: "KeyB", label: "B" }, caption: (context) => <BrowserCaption context={context} services={browserServices} />, render: (context) => <BrowserPanel context={context} services={browserServices} /> },
  ],
});

export const generalSettingsSection = defineSettingsSection({
  id: "general",
  title: (locale) => getT(locale)("terminal.settings.general"),
  group: "work",
  // 이 섹션이 실제로 보여 주는 행 이름을 그대로 싣는다 — 화면에 있는 이름으로 못 찾는 검색은
  // "모든 설정 검색"이라는 약속을 지키지 못한다. 개념어는 그 뒤에 더한다.
  keywords: [
    (locale) => [
      getT(locale)("terminal.settings.terminalFont"),
      getT(locale)("terminal.settings.cjkFallback"),
      getT(locale)("terminal.settings.chatReadingWidthTitle"),
      getT(locale)("terminal.settings.terminalRenderer"),
      getT(locale)("terminal.settings.inactiveFlush"),
    ].join(" "),
    "terminal font typeface monospace renderer webgl canvas reading width cjk fallback korean japanese chinese hangul kana han glyph coverage",
    "터미널 글꼴 서체 고정폭 렌더러 읽기 폭 폴백 한글 일본어 중국어 가나 한자 글리프 커버리지",
  ],
  render: () => <GeneralSection />,
});

/**
 * 에이전트를 **어떻게 실행하는가**의 방. 터미널 섹션이 화면을 그리는 법을 말하는 것과 같은
 * 층에서, 이 섹션은 자식 프로세스의 정책을 말한다 — 승인 게이트, 시스템 프롬프트, 휴면,
 * 실행 파일. 하네스가 하나뿐인 지금도 카드를 하네스별로 세워 두는 이유는, 둘째 하네스가
 * 왔을 때 옮길 것이 없어야 하기 때문이다.
 */
export const harnessSettingsSection = defineSettingsSection({
  id: "harness",
  title: (locale) => getT(locale)("terminal.settings.harness"),
  group: "work",
  keywords: [
    (locale) => [
      getT(locale)("terminal.settings.harnessClaudeCode"),
      getT(locale)("terminal.settings.skipPermissionsTitle"),
      getT(locale)("terminal.settings.claudeSystemPromptTitle"),
      getT(locale)("terminal.settings.builtInAgentsTitle"),
      getT(locale)("terminal.settings.idleAgent"),
      getT(locale)("terminal.settings.agentCliAvailable"),
    ].join(" "),
    "harness permission permissions approval prompt bypass dangerously skip system prompt claude code dormant idle session timeout cli path executable subagent subagents agent explore plan general-purpose",
    "하네스 권한 승인 프롬프트 바이패스 건너뛰기 시스템 프롬프트 휴면 유휴 세션 시간 실행 파일 경로 서브에이전트 에이전트",
  ],
  render: () => <HarnessSection />,
});

export { aiGatewaySettingsSection as agentSettingsSection } from "../../../ai-gateway/client/settings.js";

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

// 세션 관찰(실험) 알림 — 개입하지 않는 조언이다. id에 end/done을 넣지 않아 입력 대기 층으로 분류된다.
const agentWatchNotification = defineNotificationKind({
  id: "agent.watch",
  title: (locale) => getT(locale)("terminal.experiments.watchNotification"),
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

export const agentExecution: ClientExecutionProvider = {
  id: null,
  operationKinds: [agentOperationKind],
  settingsSections: [generalSettingsSection, harnessSettingsSection, agentSettingsSection],
  notificationKinds: [agentAttentionNotification, agentEndedNotification, agentResumeFailedNotification, agentWatchNotification],
  install: (ctx) => installAgentExecution(ctx),
  // 실험: 프롬프트 다듬기 — 코어가 켜져 있을 때만 부른다. 서버가 꺼져 있다고 답하면 null로 조용히 물러난다.
  refinePrompt: (input) => refineLaunchPrompt(installedApi, input),
  promptRefineOperationTypes: ["agent"],
  // 실험: 모델 좌석 선택지 — 분석가 카탈로그가 곧 "이 호스트가 실행할 수 있는 모델"이다.
  experimentModelOptions: async () => {
    if (!installedApi) return [];
    const catalog = await fetchAnalysisCatalog(installedApi);
    return catalog.clis.flatMap((cli) => cli.models.map((model) => ({ id: model.id, label: model.label, effortLevels: model.effortLevels })));
  },
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
};

export const operationKinds = [agentOperationKind] as const;

// resumeOperation 훅은 install context를 받지 못하므로 notifications만 모듈 스코프로 캡처한다.
// (같은 프로세스 내 plugin 인스턴스는 하나라 core의 단일 install 계약과 충돌하지 않는다.)
let installedNotifications: PluginInstallContext["notifications"] | null = null;

let installedApi: PluginInstallContext["api"] | null = null;
function installAgentExecution(ctx: PluginInstallContext): () => void {
  installedNotifications = ctx.notifications;
  installedApi = ctx.api;
  setInstalledExperiments(ctx.experiments);
  // 세션 관찰 알림 — 서버가 코어 SSE에 실어 보낸 조언을 알림 층에 올린다. 관찰이 꺼진 Operation은
  // 서버가 애초에 검토하지 않으므로 여기서 거를 것이 없다.
  const disposeWatch = ctx.consoleEvents.subscribe(SESSION_WATCH_EVENT_CHANNEL, (payload) => {
    if (!isSessionWatchEvent(payload)) return;
    recordSessionWatchEvent(payload);
    if (!isSessionWatchAlert(payload)) return;
    ctx.notifications.emit({
      kind: agentWatchNotification.id,
      operationId: payload.operationId,
      message: payload.body ? `${payload.title} — ${payload.body}` : payload.title,
    });
  });
  // Console Use 의 console_reveal — 에이전트가 "여기를 봐 달라"고 한 Operation 을 앞에 세우고 사유를 캡션 말풍선에 남긴다.
  // 사용자가 입력 중이면(활성 요소가 편집 가능) 포커스를 빼앗지 않고 말풍선만 띄운다.
  const disposeReveal = ctx.consoleEvents.subscribe(OPERATION_REVEAL_EVENT_CHANNEL, (payload) => {
    if (!isOperationRevealEvent(payload)) return;
    recordOperationReveal(payload);
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    if (typing) return;
    focusConsoleOperation(payload.operationId);
    requestOperationKeyboardFocus(payload.operationId);
  });
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
    installedApi = null;
    setInstalledExperiments(null);
    disposeWatch();
    disposeReveal();
    disposeConnection();
  };
}

/** 실험 설정 구독 — 설정에서 껐다 켜는 즉시 캡션 버튼이 따라간다. */
function useExperimentsSnapshot() {
  return React.useSyncExternalStore(subscribeInstalledExperiments, readInstalledExperiments, () => null);
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
  const { terminalPending } = useViewSwitchState(context.operationId);
  const chatMode = context.operation.payload.chatMode === true;
  const analystOpen = isCompanionPanelVisible(context, ANALYST_CHAT_COMPANION_ID);
  const analystReady = analysisReadiness === "ready";

  React.useEffect(() => {
    if (analysisReadiness !== "not-ready" || !context.companionsOpen || !context.onSetCompanionPanelVisible) return;
    // 단축키는 disabled 핸들 가드를 거치지 않으므로, 준비 전 진입이 빈 companion 배치를 남기지 않게 호스트 레이어까지 함께 정리한다.
    // 다만 브라우저 companion이 열려 있으면 레이어는 그 패널의 것이다 — 분석가 패널만 접고 레이어는 둔다.
    if (isCompanionPanelVisible(context, BROWSER_COMPANION_ID)) {
      for (const id of ANALYST_COMPANION_IDS) if (isCompanionPanelVisible(context, id)) context.onSetCompanionPanelVisible(id, false);
      return;
    }
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
    } catch {
      setTerminalHandoff(context.operationId, { error: "failed" });
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

  // Operation Browser 문 — 실험이 켜진 Console에서만 선다. 허용은 패널 안에서 켠다.
  const using = useOperationUse(context.operationId);
  const browserOpen = isCompanionPanelVisible(context, BROWSER_COMPANION_ID);
  // 에이전트가 브라우저를 쓰는 동안은 이 버튼이 곧 표식이다 — 별도 배지를 두지 않는다. 브라우저는 Desktop 앱의 것이라 문은 늘 서되,
  // 브라우저 탭·모바일로 연 화면이거나 다른 화면이 붙어 멈춘 동안은 닫힌 채로 서서 말풍선이 그 까닭을 말한다(투어도 그때는 이 문을 짚지 않는다).
  const engine = useBrowserEngine();
  const engineMissing = engine !== null && !engine.available;
  const browserLabel = engineMissing
    ? t(engine.reason === "shared" ? "terminal.browser.shared" : isDesktopShell() ? "terminal.browser.desktopMissing" : "terminal.browser.desktopOnly")
    : using.browser ? t("terminal.browser.agentUsing") : t(browserOpen ? "terminal.browser.exit" : "terminal.browser.open");
  const browser = context.onRequestCompanions === undefined ? null : (
    <CaptionActionButton
      actionId="browser"
      label={browserLabel}
      pressed={browserOpen}
      disabled={engineMissing}
      agent={using.browser}
      {...(engineMissing ? {} : { tourAnchor: "browser" })}
      onClick={() => { toggleCompanionPanel(context, BROWSER_COMPANION_ID); }}
    >
      <CaptionBrowserUseGlyph />
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

  // 세션 관찰의 결과 말풍선 — 스위치는 ··· 메뉴로 갔지만 결과는 여전히 여기서 알린다. 선반 끝에
  // 폭 없는 앵커를 두어 ··· 버튼 왼쪽 아래에 선다. 산 이벤트에만 뜬다(지난 결과는 다시 튀어나오지 않는다).
  const experiments = useExperimentsSnapshot();
  const watchEnabled = readWatchEnabled(context.operation.payload);
  const liveReview = React.useSyncExternalStore(subscribeSessionWatchReviews, () => getSessionWatchReview(context.operationId), () => null);
  const liveReveal = React.useSyncExternalStore(subscribeOperationReveals, () => getOperationReveal(context.operationId), () => null);
  // Console Use 시선 — 에이전트가 이 Operation 을 읽거나 만지면 같은 말풍선 자리에 "○○: 전사 읽음" 이 잠깐 선다.
  const liveGaze = React.useSyncExternalStore(subscribeConsoleUseGestures, () => getOperationWrap(context.operationId)?.gesture ?? null, () => null);
  const launchedBy = readLaunchAttribution(context.operation.payload, context.operation.ts.createdAt);
  const watchBubble = (experiments?.sessionWatch === true && watchEnabled) || liveReveal || liveGaze
    ? <span className="session-watch-host" aria-hidden={liveReview === null && liveReveal === null && liveGaze === null ? true : undefined}>
        {experiments?.sessionWatch === true && watchEnabled ? <SessionWatchBubble context={context} review={liveReview} /> : null}
        <RevealBubble context={context} reveal={liveReveal} />
        {liveGaze && !liveReveal ? <div className="session-watch-bubble is-gaze" role="status" aria-live="polite"><span className="session-watch-bubble__text"><span className="chat-by-agent">{gestureCallerLabel(liveGaze.caller)}</span> {liveGaze.summary}</span></div> : null}
      </span>
    : null;
  const launchedByMark = launchedBy
    ? <span className="agent-launched-by chat-by-agent" title={t("terminal.experiments.launchedBy", { caller: gestureCallerLabel(launchedBy) })}>{t("terminal.experiments.launchedBy", { caller: gestureCallerLabel(launchedBy) })}</span>
    : null;

  return (
    <>
      <span className="agent-operation-marks">
        {launchedByMark}
        <OperationUseBadge active={using.console} kind="console" label={t("terminal.experiments.menuConsoleUse")} />
        <OperationUseBadge active={using.computer} kind="computer" label={t("terminal.experiments.menuComputerUse")} />
      </span>
      {analyst}
      {browser}
      {viewSwitch}
      {watchBubble}
    </>
  );
}

/**
 * 세션 관찰(실험)의 결과 말풍선 — 캡션 동작 선반 끝(··· 버튼 왼쪽) 아래에 선다. 검토가 시작되거나 끝날 때 뜨고,
 * 사용자가 무엇이든 누르거나 입력하면 사라진다: 결과는 알려야 하지만 화면을 차지해서는 안 된다.
 * 새 결과가 오면 다시 뜬다. 마지막 결과 자체는 ··· 메뉴의 관찰 행 툴팁과 칩 마크가 계속 갖고 있다.
 */
function OperationUseBadge({ active, kind, label }: { active: boolean; kind: "console" | "computer" | "browser"; label: string }) {
  const [present, setPresent] = React.useState(active);
  React.useEffect(() => {
    if (active) { setPresent(true); return; }
    const timer = setTimeout(() => setPresent(false), 180);
    return () => clearTimeout(timer);
  }, [active]);
  if (!present && !active) return null;
  return <span className={`agent-control-badge is-${kind}${active ? "" : " is-leaving"}`} role="img" aria-label={label} title={label}>
    {kind === "console" ? <CaptionConsoleUseGlyph /> : kind === "browser" ? <CaptionBrowserUseGlyph /> : <CaptionComputerUseGlyph />}
  </span>;
}

function SessionWatchBubble({ context, review }: { readonly context: OperationRenderContext; readonly review: SessionWatchReview | null }) {
  const t = getT(context.language ?? "en");
  const [visibleFor, setVisibleFor] = React.useState<number | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const key = review ? `${review.phase}:${review.at}` : null;
  const keyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (key === null || key === keyRef.current) return;
    keyRef.current = key;
    setVisibleFor(review?.at ?? null);
    setExpanded(false);
  }, [key, review]);
  React.useEffect(() => {
    if (visibleFor === null) return;
    // 이 말풍선 안의 클릭(자세히)은 닫지 않는다 — 그 밖의 어떤 누름·입력이든 닫는다.
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && bubbleRef.current?.contains(event.target)) return;
      setVisibleFor(null);
    };
    // 뜬 직후의 같은 프레임에 들어온 이벤트(검토를 시작시킨 Enter 등)가 곧바로 닫지 않게 한 박자 뒤에 듣는다.
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", dismiss, true);
      document.addEventListener("keydown", dismiss, true);
    }, 150);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
    };
  }, [visibleFor]);
  const bubbleRef = React.useRef<HTMLDivElement | null>(null);
  if (visibleFor === null || !review) return null;
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tone = review.phase === "alert" ? "is-alert" : review.phase === "failed" ? "is-failed" : review.phase === "started" ? "is-reviewing" : "";
  const summary = review.phase === "started"
    ? t("terminal.experiments.barReviewing")
    : review.phase === "alert"
      ? t("terminal.experiments.barAlert", { time: time(review.at), title: review.title ?? "" })
      : review.phase === "failed"
        ? t(review.reason === "transcript_missing" ? "terminal.experiments.barNoTranscript" : "terminal.experiments.barFailed", { time: time(review.at) })
        : t("terminal.experiments.barClear", { time: time(review.at) });
  return (
    <div ref={bubbleRef} className={`session-watch-bubble ${tone}`} role="status" aria-live="polite">
      <span className="session-watch-bubble__text">{summary}</span>
      {review.phase === "alert" && review.body ? (
        <>
          <button type="button" className="session-watch-bubble__toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {t(expanded ? "terminal.experiments.barLess" : "terminal.experiments.barMore")}
          </button>
          {expanded ? <p className="session-watch-bubble__body">{review.body}</p> : null}
        </>
      ) : null}
    </div>
  );
}



/**
 * console_reveal 의 말풍선 — 세션 관찰 말풍선과 같은 앵커·같은 닫힘 규칙(어떤 누름·입력이든 닫는다). 산 사건에만 뜬다.
 */
function RevealBubble({ context, reveal }: { readonly context: OperationRenderContext; readonly reveal: OperationReveal | null }) {
  const t = getT(context.language ?? "en");
  const [visibleFor, setVisibleFor] = React.useState<number | null>(null);
  const keyRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!reveal || reveal.at === keyRef.current) return;
    keyRef.current = reveal.at;
    setVisibleFor(reveal.at);
  }, [reveal]);
  React.useEffect(() => {
    if (visibleFor === null) return;
    const dismiss = () => setVisibleFor(null);
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", dismiss, true);
      document.addEventListener("keydown", dismiss, true);
    }, 150);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
    };
  }, [visibleFor]);
  if (visibleFor === null || !reveal) return null;
  return (
    <div className="session-watch-bubble is-reveal" role="status" aria-live="polite">
      <span className="session-watch-bubble__text">{t("terminal.experiments.revealBubble", { reason: reveal.reason })}</span>
    </div>
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
  const observed = state.sessions[context.operationId];
  const session = observed ?? sessionFromOperation(context);
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
    // 채팅에도 휴면이 있다 — 자식과 원장이 거둬진 자리에는 대화 대신 재개 카드가 선다.
    // 휴면은 **관측된** 사실일 때만 그린다: 아직 세션을 받지 못한 프레임의 '모름'을 휴면으로
    // 읽으면 방금 띄운 채팅이 한 프레임 동안 휴면 카드로 깜빡인다.
    if (observed && observed.status === "dormant" && observed.chatActive !== true) {
      return (
        <div className="agent-stream-host">
          <DormantChatView context={context} session={observed} />
        </div>
      );
    }
    return (
      <div className="agent-stream-host">
        <AgentChatView context={context} tourAnchors={chatOpenedHere} />
        <ComputerScreenShare operationId={context.operationId} />
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
      <ComputerScreenShare operationId={context.operationId} />
    </div>
  );
}

/**
 * Operation 메뉴의 실험 섹션 — 이 세션에 대한 스위치 세 개. 설정에서 켠 실험만 행으로 서고, 켜져
 * 있는지는 Operation payload가 말한다(서버가 쓴다). 행은 한 줄이다 — 지금 상태(관찰의 마지막 검토
 * 결과, 사용 계열이 무엇을 허용하는지)는 툴팁과 접근성 라벨이 진다. 켜고 끄는 것은 재연결 없이
 * 다음 도구 호출부터 듣는다.
 */
function AgentOperationMenu({ context }: { readonly context: OperationMenuContext }) {
  const t = getT(context.language);
  const experiments = useExperimentsSnapshot();
  const payload = context.operation.payload;
  const [pending, setPending] = React.useState<"watch" | "console" | "computer" | null>(null);
  const liveReview = React.useSyncExternalStore(subscribeSessionWatchReviews, () => getSessionWatchReview(context.operation.id), () => null);
  const review = liveReview ?? readWatchLast(payload);
  if (!experiments || !installedApi) return null;
  const api = installedApi;
  const language = context.language;
  const toggle = (kind: "watch" | "console" | "computer", next: boolean) => {
    setPending(kind);
    const request = kind === "watch"
      ? setSessionWatch(api, context.operation.id, next, language)
      : kind === "console"
        ? setConsoleUse(api, context.operation.id, next, language)
        : setComputerUse(api, context.operation.id, next, language);
    void request.then(() => api.resync()).catch(() => undefined).finally(() => setPending(null));
  };
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const watchEnabled = readWatchEnabled(payload);
  const watchHint = !watchEnabled
    ? t("terminal.experiments.menuWatchOff")
    : review === null
      ? t("terminal.experiments.barIdle")
      : review.phase === "started"
        ? t("terminal.experiments.barReviewing")
        : review.phase === "clear"
          ? t("terminal.experiments.barClear", { time: time(review.at) })
          : review.phase === "failed"
            ? t(review.reason === "transcript_missing" ? "terminal.experiments.barNoTranscript" : "terminal.experiments.barFailed", { time: time(review.at) })
            : t("terminal.experiments.barAlert", { time: time(review.at), title: review.title ?? "" });
  const consoleUseEnabled = readConsoleUseEnabled(payload);
  const computerUseEnabled = readComputerUseEnabled(payload);
  const rows = [
    experiments.sessionWatch === true ? { id: "session-watch" as const, kind: "watch" as const, checked: watchEnabled, glyph: <CaptionWatchGlyph />, name: t("terminal.experiments.menuWatch"), hint: watchHint, busy: watchEnabled && review?.phase === "started" } : null,
    experiments.consoleControl === true ? { id: "console-use" as const, kind: "console" as const, checked: consoleUseEnabled, glyph: <CaptionConsoleUseGlyph />, name: t("terminal.experiments.menuConsoleUse"), hint: t(consoleUseEnabled ? "terminal.experiments.menuConsoleUseOn" : "terminal.experiments.menuConsoleUseOff"), busy: false } : null,
    experiments.computerUse === true ? { id: "computer-use" as const, kind: "computer" as const, checked: computerUseEnabled, glyph: <CaptionComputerUseGlyph />, name: t("terminal.experiments.menuComputerUse"), hint: t(computerUseEnabled ? "terminal.experiments.menuComputerUseOn" : "terminal.experiments.menuComputerUseOff"), busy: false } : null,
  ].filter((row) => row !== null);
  if (rows.length === 0) return null;
  return (
    <>
      <div className="group-context-menu-section-label">{t("terminal.experiments.menuSection")}</div>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={`group-context-menu-item group-context-menu-item--switch${row.checked ? " is-selected" : ""}`}
          role="menuitemcheckbox"
          aria-checked={row.checked}
          aria-busy={row.busy || pending === row.kind}
          aria-label={`${row.name} · ${row.hint}`}
          title={row.hint}
          disabled={pending !== null}
          data-operation-menu-item={row.id}
          onClick={() => toggle(row.kind, !row.checked)}
        >
          <span className="group-context-menu-item__glyph" aria-hidden="true">{row.glyph}</span>
          <span className="group-context-menu-item__name">{row.name}</span>
          {row.busy ? <span className="group-context-menu-item__live" aria-hidden="true" /> : null}
          <SwitchCheckMark />
        </button>
      ))}
    </>
  );
}

/** 사용 배지는 캡션과 같은 수명을 공유하고, 세션 관찰 마크는 기존 정책을 유지한다. */
function AgentOperationMarks({ context }: { readonly context: OperationMenuContext }) {
  const t = getT(context.language);
  const experiments = useExperimentsSnapshot();
  const payload = context.operation.payload;
  const liveReview = React.useSyncExternalStore(subscribeSessionWatchReviews, () => getSessionWatchReview(context.operation.id), () => null);
  const review = liveReview ?? readWatchLast(payload);
  const using = useOperationUse(context.operation.id);
  const watch = experiments?.sessionWatch === true && readWatchEnabled(payload);
  return (
    <span className="agent-operation-marks">
      {watch ? <span className="side-bar-chip-marks"><span className={`side-bar-chip-mark${review?.phase === "started" ? " is-busy" : ""}`} role="img" aria-label={t("terminal.experiments.menuWatch")} title={t("terminal.experiments.menuWatch")} data-operation-mark="session-watch"><CaptionWatchGlyph /></span></span> : null}
      <OperationUseBadge active={using.console} kind="console" label={t("terminal.experiments.menuConsoleUse")} />
      <OperationUseBadge active={using.computer} kind="computer" label={t("terminal.experiments.menuComputerUse")} />
      <OperationUseBadge active={using.browser} kind="browser" label={t("terminal.browser.agentUsing")} />
    </span>
  );
}

function SwitchCheckMark() {
  return (
    <svg viewBox="0 0 12 12" className="group-context-menu-item__check" aria-hidden="true">
      <path d="M2 6l3 3 5-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 전환이 막힌 사유 → 문구 키. 서버가 사유를 못 실어 보냈으면 뭉뚱그린 문구로 내려간다 —
 * 모르는 사유를 아는 척 이름 붙이는 것보다 낫다.
 */
function chatConvertBusyKey(reason: string | null): "terminal.chat.convertBusy" | "terminal.chat.convertBusyStarting" {
  return reason === "starting" ? "terminal.chat.convertBusyStarting" : "terminal.chat.convertBusy";
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
      <TerminalFontSettingsCard terminalFont={terminalFont} />
      <ChatReadingWidthSettingsCard />
      <TerminalDrawingCard terminalRenderer={terminalRenderer} terminalInactiveFlush={terminalInactiveFlush} />
    </>
  );
}

/**
 * 하네스 방의 차례: 하네스별 정책 → 하네스 공통 → 설치.
 *
 * 정책이 먼저 서는 이유는 이 방을 여는 이유가 대개 그것이기 때문이고, 실행 파일 목록이
 * 마지막인 이유는 한 번 맞춰 놓으면 다시 볼 일이 거의 없기 때문이다. 휴면은 자식이 아니라
 * Console이 하는 일이라 하네스별 카드가 아니라 공통 카드에 눕는다.
 */
/** 이 플러그인 설정 표면의 '?' — 접근성 이름("{제목} 도움말")을 터미널 카탈로그에서 조립한다. */
function SettingsHelp({ title, id, children }: {
  readonly title: string;
  readonly id?: string;
  readonly children: React.ReactNode;
}) {
  const t = getT(useTerminalLocale());
  return (
    <SettingsHelpTip ariaLabel={t("terminal.settings.helpTipAria", { title })} id={id}>
      {children}
    </SettingsHelpTip>
  );
}

function useLoadSystemPromptSettings() {
  React.useEffect(() => {
    const controller = new AbortController();
    void loadSystemPromptSettings(controller.signal);
    return () => controller.abort();
  }, []);
}

function HarnessSection() {
  useLoadSystemPromptSettings();
  // 카드를 Fragment로 직접 반환한다 — 간격은 호스트의 .global-settings-detail이 진다.
  return (
    <>
      <ClaudeCodeHarnessCard />
      <AgentSessionsSettingsCard />
      <AgentCliAvailabilityCard />
    </>
  );
}

/**
 * 한 하네스의 실행 정책이 한 카드에 모인다 — 승인 게이트와 시스템 프롬프트는 둘 다
 * "이 자식을 어떻게 띄우는가"이고, 둘 다 새 세션부터 듣는다. 하네스가 늘면 이 카드가
 * 그 수만큼 서고, 방의 구조는 그대로다.
 */
function ClaudeCodeHarnessCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields;

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.harnessClaudeCode")}>
      {/* 카드 각주(실행 중인 세션의 정책 유지)는 카드 전체의 이야기라 카드 제목 팁이 진다. */}
      <h3 className="global-settings-card-title">
        {t("terminal.settings.harnessClaudeCode")}
        <SettingsHelp title={t("terminal.settings.harnessClaudeCode")}>{t("terminal.settings.harnessFoot")}</SettingsHelp>
      </h3>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <>
          {/* 행 제목이 컨트롤의 이름이 되도록 그룹으로 묶는다 — 토글 자신이 말하는 것은
              켬/끔뿐이라, 무엇을 켜는지는 이 연결이 없으면 화면 밖에서 사라진다. id는 제목
              글자만 감싼 span이 진다: 팁 버튼이 라벨 안에 서면 그 접근성 이름까지 그룹
              이름에 딸려 들어간다. */}
          <div className="global-settings-row" role="group" aria-labelledby="claude-code-skip-permissions-label">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                <span id="claude-code-skip-permissions-label">{t("terminal.settings.skipPermissionsTitle")}</span>
                <SettingsHelp title={t("terminal.settings.skipPermissionsTitle")}>
                  {t("terminal.settings.skipPermissionsHelp")}
                </SettingsHelp>
              </p>
              {/* 위험은 설명이 아니라 상태다 — 켜져 있는 동안 인라인에 남는다. */}
              {state.claudeCodeSkipPermissions ? (
                <p className="harness-hazard" role="note">{t("terminal.settings.skipPermissionsWarn")}</p>
              ) : null}
            </div>
            {/* 행 제목이 뜻을 말하므로 스위치 옆에 "켬/끔" 글자를 따로 세우지 않는다 — Settings의 다른 스위치와 같다. */}
            <SettingsToggle
              checked={state.claudeCodeSkipPermissions}
              disabled={saving.has("claudeCodeSkipPermissions")}
              ariaLabel={t("terminal.settings.skipPermissionsTitle")}
              onChange={(next) => void setSystemPromptSettingsField("claudeCodeSkipPermissions", next)}
            />
          </div>
          <div className="global-settings-row">
            <div className="global-settings-row-text">
              <p className="global-settings-resp-title">
                <span id="claude-code-system-prompt-label">{t("terminal.settings.claudeSystemPromptTitle")}</span>
                <SettingsHelp title={t("terminal.settings.claudeSystemPromptTitle")}>{t("terminal.settings.claudeSystemPromptHelp")}</SettingsHelp>
              </p>
            </div>
            <Select
              aria-labelledby="claude-code-system-prompt-label"
              value={state.claudeCodeSystemPrompt}
              disabled={saving.has("claudeCodeSystemPrompt")}
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
          <ClaudeBuiltInAgentsRows
            disabled={state.claudeCodeDisabledAgents}
            saving={saving.has("claudeCodeDisabledAgents")}
            onChange={(next) => void setSystemPromptSettingsField("claudeCodeDisabledAgents", next)}
          />
        </>
      ) : (
        <p className="global-settings-help">{settings.loading ? t("terminal.settings.loading") : t("terminal.settings.unavailable")}</p>
      )}
    </section>
  );
}

/**
 * Fleet이 아는 내장 서브에이전트의 역할과 설명 키. **이 표는 카탈로그가 아니다** — 목록 자체는
 * 설치된 Claude Code가 보고한 것이고, 여기 있는 것은 그 이름에 붙이는 주석뿐이다. CLI는 로스터에
 * 이름만 싣고(`system/init`의 `agents`) 설명을 주는 표면이 따로 없어서, 뜻은 Fleet이 진다.
 *
 * 그래서 표에 없는 이름도 화면에는 선다 — 업데이트가 새 이름을 들고 오면 설명 없이 "분류 없음"에
 * 서고, 사용자는 그것도 끌 수 있다. 표를 늘리는 일이 목록을 늘리는 일이 되어서는 안 된다.
 * (문구 근거: 설치본이 각 Agent 정의에 싣는 `whenToUse`. 실측 2.1.278.)
 */
const CLAUDE_BUILT_IN_AGENT_NOTES: Readonly<Record<string, { readonly role: "work" | "guide"; readonly descriptionKey: TerminalMessageKey }>> = {
  "claude": { role: "work", descriptionKey: "terminal.settings.builtInAgentClaude" },
  "general-purpose": { role: "work", descriptionKey: "terminal.settings.builtInAgentGeneralPurpose" },
  "Explore": { role: "work", descriptionKey: "terminal.settings.builtInAgentExplore" },
  "Plan": { role: "work", descriptionKey: "terminal.settings.builtInAgentPlan" },
  "fork": { role: "work", descriptionKey: "terminal.settings.builtInAgentFork" },
  "claude-code-guide": { role: "guide", descriptionKey: "terminal.settings.builtInAgentCodeGuide" },
  "statusline-setup": { role: "guide", descriptionKey: "terminal.settings.builtInAgentStatuslineSetup" },
};

/** 묶음은 화면 순서이기도 하다 — 매 세션 쓰이는 것이 먼저 서고, 모르는 이름이 끝에 남는다. */
const CLAUDE_BUILT_IN_AGENT_GROUPS = [
  { id: "work", titleKey: "terminal.settings.builtInAgentsGroupWork" },
  { id: "guide", titleKey: "terminal.settings.builtInAgentsGroupGuide" },
  { id: "other", titleKey: "terminal.settings.builtInAgentsGroupOther" },
] as const satisfies readonly { readonly id: string; readonly titleKey: TerminalMessageKey }[];

type ClaudeBuiltInAgentGroupId = (typeof CLAUDE_BUILT_IN_AGENT_GROUPS)[number]["id"];

function claudeBuiltInAgentGroup(name: string): ClaudeBuiltInAgentGroupId {
  return CLAUDE_BUILT_IN_AGENT_NOTES[name]?.role ?? "other";
}

/**
 * 내장 서브에이전트 선택. 컨트롤은 체크박스다 — 스위치가 아니다. 이 자리가 묻는 것은 "이 설정
 * 하나를 켜는가"가 아니라 "쓸 수 있는 것 중 무엇을 남기는가"이고, 같은 카드에 선 승인 게이트가
 * 스위치라서 목록에까지 스위치를 세우면 위험한 단일 설정과 목록 한 줄이 같은 무게로 읽힌다.
 *
 * 저장되는 것은 끈 이름뿐이므로 로스터에서 사라진 이름도 목록에 남는다 — 되돌릴 길이 없으면
 * 규칙만 살아남는다.
 */
function ClaudeBuiltInAgentsRows({ disabled, saving, onChange }: {
  readonly disabled: readonly string[];
  readonly saving: boolean;
  readonly onChange: (next: readonly string[]) => void;
}) {
  const t = getT(useTerminalLocale());
  const [roster, setRoster] = React.useState<ClaudeBuiltInAgentsState | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);

  const read = React.useCallback(async (signal?: AbortSignal, refresh = false) => {
    setReading(true);
    try {
      const next = await fetchClaudeBuiltInAgents(signal, { refresh });
      if (signal?.aborted) return;
      setRoster(next);
      setLoadError(null);
    } catch (error) {
      if (signal?.aborted) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setReading(false);
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);

  const disabledSet = new Set(disabled);
  // 현재 로스터에서 빠진 제외 항목도 사용자가 다시 허용할 수 있어야 한다.
  const agentNames = [...new Set([...(roster?.agents ?? []), ...disabled])];
  const select = (names: readonly string[], enabled: boolean) => {
    // 실행 조건이나 CLI 버전 때문에 로스터에서 빠진 Agent의 제외 설정도 유지한다.
    const next = disabled.filter((entry) => !names.includes(entry));
    if (!enabled) next.push(...names);
    onChange(next);
  };

  const groups = CLAUDE_BUILT_IN_AGENT_GROUPS
    .map((group) => ({ ...group, names: agentNames.filter((name) => claudeBuiltInAgentGroup(name) === group.id) }))
    .filter((group) => group.names.length > 0);

  let body: React.ReactNode;
  if (loadError) {
    body = <p className="global-settings-error" role="alert">{loadError}</p>;
  } else if (!roster) {
    body = <p className="global-settings-help">{t("terminal.settings.builtInAgentsLoading")}</p>;
  } else if (agentNames.length === 0) {
    body = (
      <p className="global-settings-help">
        {roster.available
          ? t("terminal.settings.builtInAgentsEmpty")
          : t(roster.error === "cli_not_found" ? "terminal.settings.builtInAgentsNotFound" : "terminal.settings.builtInAgentsFailed")}
      </p>
    );
  } else {
    body = (
      <>
        {/* 로스터를 못 읽어도 꺼 둔 이름은 남는다 — 규칙은 계속 실리는데 화면에서만 사라지면
            사용자는 자기가 건 제약을 되돌릴 수 없다. */}
        {roster.available ? null : (
          <p className="global-settings-help claude-agents-degraded" role="status">
            {t("terminal.settings.builtInAgentsDegraded")}
          </p>
        )}
        {groups.map((group) => {
          const enabledCount = group.names.filter((name) => !disabledSet.has(name)).length;
          const groupChecked = enabledCount === 0 ? false : enabledCount === group.names.length ? true : "mixed";
          return (
            <div className="claude-agent-group" key={group.id}>
              <SettingsCheckbox
                checked={groupChecked}
                label={t(group.titleKey)}
                // 혼합 상태에서 누르면 전부 끈다 — 일부만 골라진 묶음을 정리하는 쪽이 의도에 가깝다.
                onChange={(enabled) => select(group.names, enabled && groupChecked !== "mixed")}
              />
              <div className="claude-agent-list">
                {group.names.map((name) => {
                  const note = CLAUDE_BUILT_IN_AGENT_NOTES[name];
                  const missing = roster.available && !roster.agents.includes(name);
                  return (
                    <SettingsCheckbox
                      key={name}
                      checked={!disabledSet.has(name)}
                      label={name}
                      monoLabel
                      description={missing
                        ? t("terminal.settings.builtInAgentMissing")
                        : t(note?.descriptionKey ?? "terminal.settings.builtInAgentUnknown")}
                      onChange={(enabled) => select([name], enabled)}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div className="claude-agents" role="group" aria-labelledby="claude-code-built-in-agents-label">
      <div className="global-settings-row claude-agents-head">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            <span id="claude-code-built-in-agents-label">{t("terminal.settings.builtInAgentsTitle")}</span>
            <SettingsHelp title={t("terminal.settings.builtInAgentsTitle")}>{t("terminal.settings.builtInAgentsHelp")}</SettingsHelp>
          </p>
          {/* 꺼진 개수와 적용 시점은 누르는 자리에 선다 — 카드 제목 팁 안에만 있으면 화면 밖이다.
              저장 중에도 목록은 잠그지 않는다: 연달아 누르는 것이 이 컨트롤의 정상 사용이고,
              들어온 조작은 진행 중인 저장이 이어 보낸다. 그래서 진행은 비활성이 아니라 글로 말한다. */}
          <p className="global-settings-help claude-agents-version" aria-live="polite">
            {roster?.version ? `${t("terminal.settings.builtInAgentsVersion", { version: roster.version })} · ` : ""}
            {saving
              ? t("terminal.settings.builtInAgentsSaving")
              : t("terminal.settings.builtInAgentsSummary", {
                off: String(disabledSet.size),
                total: String(agentNames.length),
              })}
          </p>
        </div>
        <button
          type="button"
          className="agent-cli-path-button"
          disabled={reading}
          onClick={() => { void read(undefined, true); }}
        >
          {reading ? t("terminal.settings.builtInAgentsReading") : t("terminal.settings.builtInAgentsRefresh")}
        </button>
      </div>
      {body}
    </div>
  );
}

/** 채팅 폭 — 컴포저의 폭 글리프와 같은 선호를 읽고 쓰는 설정 표면. */
function ChatReadingWidthSettingsCard() {
  const t = getT(useTerminalLocale());
  const width = useChatReadingWidth();
  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.chatReadingWidthAria")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            <span id="terminal-chat-reading-width-label">{t("terminal.settings.chatReadingWidthTitle")}</span>
            <SettingsHelp title={t("terminal.settings.chatReadingWidthTitle")}>{t("terminal.settings.chatReadingWidthHelp")}</SettingsHelp>
          </p>
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

/**
 * 하네스 공통 카드. 휴면은 자식이 아니라 Console이 하는 일이라 어떤 하네스로 연 Operation
 * 이든 같은 규칙을 받는다 — 그래서 하네스별 카드가 아니라 이 자리에 눕는다.
 */
function AgentSessionsSettingsCard() {
  const t = getT(useTerminalLocale());
  const settings = useSystemPromptSettingsStore();
  const state = settings.state;
  const saving = settings.savingFields;

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
    <section className="global-settings-card" aria-label={t("terminal.settings.harnessAgentSessions")}>
      <h3 className="global-settings-card-title">{t("terminal.settings.harnessAgentSessions")}</h3>
      {settings.error ? <p className="global-settings-error" role="alert">{settings.error}</p> : null}
      {state ? (
        <div className="global-settings-row">
          <div className="global-settings-row-text">
            <p className="global-settings-resp-title">
              <span id="idle-agent-sessions-label">{t("terminal.settings.idleAgent")}</span>
              <SettingsHelp title={t("terminal.settings.idleAgent")} id="idle-agent-sessions-help">
                {t("terminal.settings.idleAgentHelp")}
              </SettingsHelp>
            </p>
          </div>
          <Select
            aria-labelledby="idle-agent-sessions-label"
            value={selectValue}
            disabled={saving.has("agentIdleDormantMinutes")}
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

function AgentCliAvailabilityCard() {
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

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.agentCliAvailable")}>
      <div className="agent-cli-head">
        <p className="global-settings-resp-title">
          {t("terminal.settings.agentCliAvailable")}
          <SettingsHelp title={t("terminal.settings.agentCliAvailable")}>
            <p>{t("terminal.settings.agentCliHelp")}</p>
          </SettingsHelp>
        </p>
      </div>
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
    </section>
  );
}

function SettingToggleRow({ title, help, value, disabled, onToggle }: SettingToggleRowProps) {
  return (
    <div className="global-settings-row">
      <div className="global-settings-row-text">
        <p className="global-settings-resp-title">
          {title}
          <SettingsHelp title={title}>
            {help}
          </SettingsHelp>
        </p>
      </div>
      {/* 켬/끔은 콘솔 전체에서 SDK 스위치 한 모양이다 — 예전의 "Off" 글자 버튼은 스타일 없는 세 번째 문법이었다. */}
      <SettingsToggle
        checked={value}
        disabled={disabled}
        ariaLabel={title}
        onChange={onToggle}
      />
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

/**
 * 휴면한 채팅의 프레임. 터미널 휴면 카드와 같은 자리·같은 옷을 입되, 여기에는 "새로 시작"이
 * 없다 — 채팅의 재개는 언제나 그 대화로 돌아가는 것이고, 어느 좌표에서 이어붙일지는 서버가
 * transcript로 판정한다.
 */
function DormantChatView({ context, session }: { readonly context: OperationRenderContext; readonly session: SessionInfo }) {
  const t = getT(context.language ?? "en");
  const [resumeState, setResumeState] = React.useState<"idle" | "resuming" | "error">("idle");
  const resume = React.useCallback(async () => {
    setResumeState("resuming");
    try {
      await resumeSession(session.sessionId, { fresh: false });
      context.notifications.dismiss(session.sessionId);
    } catch (error) {
      setResumeState("error");
      context.notifications.emit({
        kind: agentResumeFailedNotification.id,
        operationId: session.sessionId,
        message: resumeFailureMessage(error, context.language),
      });
    }
  }, [context, session.sessionId]);

  return (
    <button type="button" className="canvas-operation-dormant" disabled={resumeState === "resuming"} onClick={() => { void resume(); }}>
      <span className="canvas-operation-dormant-status">{t("terminal.chat.dormantStatus")}</span>
      <span className="canvas-operation-dormant-body">
        {resumeState === "error" ? t("terminal.chat.dormantResumeFailed") : t("terminal.chat.dormantBody")}
      </span>
      <span className={`canvas-operation-dormant-action${resumeState === "resuming" ? " canvas-operation-dormant-action--pending" : ""}`}>
        {resumeState === "resuming" ? t("terminal.chat.dormantResuming") : t(resumeState === "error" ? "terminal.dormant.tryAgain" : "terminal.chat.dormantResume")}
      </span>
    </button>
  );
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
  const [systemFonts, setSystemFonts] = React.useState<readonly SystemFontRecord[]>([]);
  const [isLoadingFonts, setIsLoadingFonts] = React.useState(true);
  const [fontLoadFailed, setFontLoadFailed] = React.useState(false);
  const [cjkCandidates, setCjkCandidates] = React.useState<readonly FontPickerInstalledFont[]>([]);
  const [isScanningCjk, setIsScanningCjk] = React.useState(true);
  const [primaryCjkScripts, setPrimaryCjkScripts] = React.useState<readonly CjkScript[] | null>(null);
  const installedFonts = React.useMemo(
    () => systemFonts.filter((font) => font.monospace).map((font) => ({ family: font.family, monospace: font.monospace })),
    [systemFonts],
  );
  const selected = terminalFont.source === "curated" || !terminalFont.customName
    ? { source: "builtin" as const, id: terminalFont.source === "curated" ? terminalFont.id ?? DEFAULT_TERMINAL_FONT.id : DEFAULT_TERMINAL_FONT.id }
    : { source: "system" as const, familyName: terminalFont.customName };
  const cjkSelected = terminalFont.cjkFallbackName
    ? { source: "system" as const, familyName: terminalFont.cjkFallbackName }
    : { source: "builtin" as const, id: CJK_FALLBACK_BUILT_IN_ID };

  React.useEffect(() => {
    const controller = new AbortController();
    setIsLoadingFonts(true);
    setFontLoadFailed(false);
    void fetchSystemFonts({ signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setSystemFonts(response.fonts);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setSystemFonts([]);
        setFontLoadFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingFonts(false);
      });
    return () => controller.abort();
  }, []);

  /* 설치 서체 전량을 훑어 CJK를 그릴 수 있는 것만 남긴다. 등폭 필터를 걸지 않는 이유는 폴백이 라틴을
     그리지 않기 때문이다 — 격자를 정하는 것은 앞선 주 서체이고, CJK 글리프는 어차피 두 칸을 쓴다.
     조각내어 양보하는 것은 서체가 수백 종인 기기에서 이 루프가 한 프레임을 통째로 잡아먹기 때문이다. */
  React.useEffect(() => {
    let cancelled = false;
    setIsScanningCjk(true);
    setCjkCandidates([]);
    if (!systemFonts.length) {
      setIsScanningCjk(false);
      return () => { cancelled = true; };
    }
    void (async () => {
      const found: FontPickerInstalledFont[] = [];
      for (let index = 0; index < systemFonts.length; index += CJK_SCAN_CHUNK_SIZE) {
        if (cancelled) return;
        for (const font of systemFonts.slice(index, index + CJK_SCAN_CHUNK_SIZE)) {
          const scripts = await fontCjkScripts(font.family);
          if (!scripts.length) continue;
          found.push({
            family: font.family,
            monospace: font.monospace,
            available: true,
            description: scripts.map((script) => t(CJK_SCRIPT_LABEL_KEYS[script])).join(" · "),
          });
        }
        await yieldToPaint();
      }
      if (cancelled) return;
      setCjkCandidates(found);
      setIsScanningCjk(false);
    })();
    return () => { cancelled = true; };
  }, [systemFonts, t]);

  /* 큐레이트 4종은 측정하지 않는다 — 넷 다 라틴 전용 등폭이라 CJK 글리프가 없는 것이 서체의 사실이다. */
  React.useEffect(() => {
    let cancelled = false;
    setPrimaryCjkScripts(null);
    const familyName = terminalFont.source === "custom" ? terminalFont.customName : "";
    if (!familyName) {
      setPrimaryCjkScripts([]);
      return () => { cancelled = true; };
    }
    void fontCjkScripts(familyName).then((scripts) => {
      if (!cancelled) setPrimaryCjkScripts(scripts);
    });
    return () => { cancelled = true; };
  }, [terminalFont.source, terminalFont.customName]);

  const handleSelectionChange = (next: FontPickerSelection) => {
    if (next.source === "system") {
      setInstalledTerminalFont(next.familyName);
      return;
    }
    const font = CURATED_TERMINAL_FONTS.find((candidate) => candidate.id === next.id);
    if (font) setTerminalFont(font.id);
  };

  const handleCjkSelectionChange = (next: FontPickerSelection) => {
    setTerminalCjkFallbackFont(next.source === "system" ? next.familyName : "");
  };

  const cjkPickerLabels = {
    browserAria: t("terminal.settings.cjkFallbackBrowserAria"),
    searchLabel: t("terminal.settings.cjkFallbackSearchLabel"),
    searchPlaceholder: t("terminal.settings.cjkFallbackSearchPlaceholder"),
    loading: t("terminal.settings.cjkFallbackScanning"),
    choicesAria: t("terminal.settings.cjkFallbackChoicesAria"),
    builtInGroup: t("terminal.settings.fontPicker.builtInGroup"),
    installedGroup: t("terminal.settings.cjkFallbackInstalledGroup"),
    noMatch: t("terminal.settings.cjkFallbackNoMatch"),
    preview: t("terminal.settings.fontPicker.preview"),
    available: t("terminal.settings.fontPicker.available"),
    unavailable: t("terminal.settings.fontPicker.unavailable"),
    monospace: t("terminal.settings.fontPicker.monospace"),
    systemFont: t("terminal.settings.fontPicker.systemFont"),
    savedSystemFont: t("terminal.settings.fontPicker.savedSystemFont"),
  };

  return (
    <section className="global-settings-card" aria-label={t("terminal.settings.terminalFont")}>
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("terminal.settings.terminalFont")}
            {/* 닫힌 팁도 DOM에 남으므로 아래 피커의 aria-describedby가 이 id를 계속 가리킨다. */}
            <SettingsHelp title={t("terminal.settings.terminalFont")} id="terminal-font-help">
              {t("terminal.settings.terminalFontHelp")}
            </SettingsHelp>
          </p>
        </div>
      </div>
      <div aria-describedby="terminal-font-help">
          <FontPicker
            builtIns={CURATED_TERMINAL_FONTS.map((font) => ({ id: font.id, label: font.name, family: curatedTerminalFontFamily(font.id, terminalFont.cjkFallbackName), aliases: [font.familyName], description: t(FONT_META_KEYS[font.id]) }))}
            installedFonts={installedFonts}
            selected={selected}
            selectedSystemFont={terminalFont.source === "custom" ? terminalFont.customName : null}
            fallbackStack={defaultTerminalFontFamily(terminalFont.cjkFallbackName)}
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
      <div className="global-settings-row">
        <div className="global-settings-row-text">
          <p className="global-settings-resp-title">
            {t("terminal.settings.cjkFallback")}
            <SettingsHelp title={t("terminal.settings.cjkFallback")} id="terminal-cjk-fallback-help">
              {t("terminal.settings.cjkFallbackHelp")}
            </SettingsHelp>
          </p>
          {/* 조건부로 나타나는 컨트롤 대신, 조건부인 것은 이 한 줄이다 — 선택지가 사라지면 정작
              필요할 때 찾을 수 없고, 판정이 틀리면 설정이 통째로 증발한다. 커버리지 판독은
              상태이므로 팁이 아니라 인라인에 남는다. */}
          {primaryCjkScripts === null ? null : (
            <p className="global-settings-help" role="status">
              {primaryCjkScripts.length ? t("terminal.settings.cjkPrimaryCovered") : t("terminal.settings.cjkPrimaryUncovered")}
            </p>
          )}
        </div>
      </div>
      <div aria-describedby="terminal-cjk-fallback-help">
          <FontPicker
            builtIns={[{ id: CJK_FALLBACK_BUILT_IN_ID, label: t("terminal.settings.cjkFallbackAuto"), family: terminalFontFallbackStack(""), description: t("terminal.settings.cjkFallbackAutoMeta") }]}
            installedFonts={cjkCandidates}
            selected={cjkSelected}
            selectedSystemFont={terminalFont.cjkFallbackName || null}
            fallbackStack={terminalFontFallbackStack(terminalFont.cjkFallbackName)}
            previewText={t("terminal.settings.cjkFallbackPreview")}
            loading={isLoadingFonts || isScanningCjk}
            error={fontLoadFailed ? t("terminal.settings.fontLoadError") : null}
            labels={cjkPickerLabels}
            onSelectionChange={handleCjkSelectionChange}
          />
      </div>
    </section>
  );
}

const CJK_FALLBACK_BUILT_IN_ID = "bundled";
const CJK_SCAN_CHUNK_SIZE = 24;
const CJK_SCRIPT_LABEL_KEYS: Readonly<Record<CjkScript, "terminal.settings.cjkScriptHangul" | "terminal.settings.cjkScriptKana" | "terminal.settings.cjkScriptHan">> = {
  hangul: "terminal.settings.cjkScriptHangul",
  kana: "terminal.settings.cjkScriptKana",
  han: "terminal.settings.cjkScriptHan",
};

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
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
          <p className="global-settings-resp-title">
            {t("terminal.settings.terminalRenderer")}
            <SettingsHelp title={t("terminal.settings.terminalRenderer")}>
              <p>{t("terminal.settings.terminalRendererHelp")}</p>
            </SettingsHelp>
          </p>
        </div>
        <div className="segmented" role="group" aria-label={t("terminal.settings.terminalRendererAria")}>
          <SegmentedThumb />
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
          <p className="global-settings-resp-title">
            {t("terminal.settings.inactiveFlush")}
            <SettingsHelp title={t("terminal.settings.inactiveFlush")}>
              <p>{t("terminal.settings.inactiveFlushHelp")}</p>
            </SettingsHelp>
          </p>
        </div>
        <div className="segmented" role="group" aria-label={t("terminal.settings.inactiveFlushAria")}>
          <SegmentedThumb />
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

const browserServices = { isDesktopShell, themePolarity, pushComposerInbox, subscribeConsoleChannel };
