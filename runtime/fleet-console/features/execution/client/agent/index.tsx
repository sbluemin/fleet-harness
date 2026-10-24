import type { ObjectiveKindDescriptor } from "../../shared/client-contract.js";
import { AGENT_OBJECTIVE_KIND } from "../../shared/objective-kind.js";
import type { ExecutionClientDeps } from "../deps.js";
import { OpenUINavigationContext } from "./openui-boundary.js";
import { MarkdownLinkBoundary } from "./markdown-link-boundary.js";
import { getGlobalSettingsStoreState, subscribe as subscribeGlobalSettings } from "../../../settings/client/global-settings-store.js";
import { useAgentTerminalFileLinks } from "./terminal-file-links.js";
import "@fleet-console/font-picker/styles.css";
import { CaptionActionButton, CaptionBrowserUseGlyph, CaptionChatGlyph, CaptionComputerUseGlyph, CaptionConsoleUseGlyph, CaptionTerminalGlyph } from "../../../workspace/client/components/caption-actions.js";
import { launchProviderGlyph } from "../../../ai-gateway/client/components/launch-provider-glyphs.js";
import type { ConsoleLocale } from "@fleet-console/i18n";
import { defineNotificationKind } from "../notifications.js";
import type { ClientFeatureDescriptor } from "../../../workspace/shared/feature-surfaces.js";
import type { ObjectiveMenuContext, ObjectiveRenderContext } from "../../shared/client-contract.js";
import * as React from "react";
import { SegmentedThumb } from "@fleet-console/ui/react";
import { Select } from "../../../settings/client/mobile-host.js";
import { SettingsCheckbox, SettingsGroup, SettingsHelpTip, SettingsItem, SettingsSegments, SettingsToggle, defineSettingsSection } from "../../../settings/client/preferences-context.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { subscribeConsoleChannel } from "../../../../core/client/src/integration/objective-records-sse.js";
import { focusObjective as focusConsoleObjective, requestObjectiveKeyboardFocus, themePolarity } from "../../../../core/client/src/integration/store.js";
import { useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { BrowserCaption, BrowserPanel } from "../../../browser/client/browser-panel.js";
import { ComputerScreenShare, useObjectiveUse } from "../../../computer-use/client/computer-screen-share.js";
import { gestureCallerLabel, getObjectiveWrap, subscribeConsoleUseGestures } from "../../../console-use/client/gestures.js";
import { TerminalSurface } from "../terminal/shared/index.js";
import { disposeObjectiveViewState, installObjectiveViewState } from "../objective-view-state.js";
import type { ChatReadingWidth, TerminalInactiveFlush, TerminalRenderer } from "../terminal/shared/terminal-preferences.js";
import { getTerminalPrefsSnapshot, setChatReadingWidth, setTerminalInactiveFlush, setTerminalRenderer, setTerminalCopyOnSelect, setTerminalScrollback, TERMINAL_SCROLLBACK_CHOICES, useChatReadingWidth, useTerminalPrefs } from "../terminal/shared/terminal-preferences.js";
import "./agent-cli.css";
import { BROWSER_COMPANION_ID, openBrowserCompanion } from "./browser-companion.js";
import { useObjectiveLinks } from "./objective-links.js";
import { UseRequestCards, setUseRequestApi } from "./use-request-card.js";
import { MobileGlyph, MobileSurfaceProvider, mobileObjectiveOf, useMobileMenuItems, useMobileSurface, type MobileMenuItemLike, type MobileObjectiveLike } from "./mobile-surface.js";
import { pushComposerInbox } from "./chat/composer-inbox.js";
import { OBJECTIVE_REVEAL_EVENT_CHANNEL, getObjectiveReveal, isObjectiveRevealEvent, readComputerUseEnabled, readConsoleUseEnabled, readInstalledExperiments, recordObjectiveReveal, setComputerUse, setConsoleUse, setInstalledExperiments, subscribeInstalledExperiments, subscribeObjectiveReveals, type ObjectiveReveal } from "./experiments-api.js";
import { currentTerminalLocale, getT, translateServerMessage, useTerminalLocale, type TerminalMessageKey } from "./i18n/index.js";
import { disposeViewSwitch, setChatPromptOpen, setTerminalHandoff, useViewSwitchState } from "./view-switch-store.js";


import { aiGatewaySettingsSection as agentSettingsSection } from "../../../ai-gateway/client/settings.js";
import { AgentApiError, confirmAgentSessionLinks, convertAgentSessionToChat, createAgentSession, discardLaunchAttachment, exitAgentChat, messageAgentSession, resumeAgentSession, terminateAgentSession, uploadLaunchAttachment } from "./api.js";
import { AgentChatView } from "./chat/chat-view.js";
import { HistoryFoldButton } from "./chat/composer.js";
import { installGroupTimeline, useGroupClusters, useConversationHasFoldableMembers, useHasGroupConversation } from "./chat/group-timeline-store.js";
import { installGroupConversationSurface, MobileGroupConversation } from "./chat/group/index.js";
import { setFoldTurns, useFoldTurns } from "./chat/group/fold-turns.js";
import { useCommanderLedgerFramed } from "./chat/group/commander-ledger.js";
import { getGroupT } from "./chat/group/group-chat-i18n.js";
import { startAgentConnection } from "./connection.js";
import { applySessionUpdate, getAgentState, removeSession, selectSession, useAgentState } from "./store.js";
import type { SessionInfo } from "./types.js";

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

const TRACK_PHASE_COPY_KEYS = {
  live: "terminal.streams.status.live",
  done: "terminal.streams.status.done",
  error: "terminal.streams.status.error",
} as const;

// 상태줄 3행(cwd·모델·권한 모드) + 입력 컴포저 3행(테두리 2 + 프롬프트 1) + 사이 여백 1행.
const AGENT_PREVIEW_CHROME_ROWS = 7;

export const agentObjectiveKind: ObjectiveKindDescriptor = ({
  ...AGENT_OBJECTIVE_KIND,
  title: (locale) => getT(locale)("terminal.kind.agent"),
  subtitle: () => "Claude Code",
  render: (context) => <AgentObjectiveView context={context} />,
  // 뷰 전환·읽기 폭은 캡션 밴드가 진다 — 본문 위에 떠 있던 칩 줄이 하던 일이다.
  // 대화 머리는 두 캡슐로 가른다: 전환은 보기 캡슐, 지구본은 도구 캡슐 맨 앞. 표식·말풍선은 동작 묶음에 남는다.
  captionActions: (context) => <AgentCaptionActions context={context} part="shelf" />,
  captionViewSwitch: (context) => <AgentCaptionActions context={context} part="view-switch" />,
  captionToolsLead: (context) => <AgentCaptionActions context={context} part="tools-lead" />,
  // 이 Objective에 **대한** 실험 스위치(관찰·콘솔 사용·컴퓨터 사용)는 캡션이 아니라 ··· 메뉴가 진다 —
  // 사이드바 우클릭도 같은 메뉴를 열므로 어디서 열든 같은 스위치를 본다.
  objectiveRecordMenu: (context) => <AgentObjectiveMenu context={context} />,
  // 켜진 스위치는 사이드바 칩에도 마크로 선다 — 목록에서 "이 세션은 콘솔을 잡고 있다"가 읽히게.
  objectiveRecordMarks: (context) => <AgentObjectiveMarks context={context} />,
  // 에이전트 CLI TUI는 화면 바닥에 입력 컴포저와 상태줄(cwd·모델·권한 모드)을 고정으로 그린다 —
  // 실행 중에도 갱신되지 않으므로 호스트 프리뷰는 이 밴드를 프레임 밖으로 밀어낼 수 있다.
  // 밴드의 단위는 px가 아니라 행이다: 셀 높이가 글꼴 크기를 따르므로(TERMINAL_OPTIONS.lineHeight
  // = 1) 현재 글꼴 크기를 곱해 지원 범위(10~22px) 어디서도 같은 행 수가 잘리게 한다.
  // 순정 셸(shellObjectiveKind)은 바닥까지 출력이 흐르므로 이 값을 선언하지 않는다.
  previewBottomChrome: () => AGENT_PREVIEW_CHROME_ROWS * getTerminalPrefsSnapshot().font.size,
  canOpenCompanions: () => true,
  companions: [
    // Objective Browser — 실험을 켠 Console에서만 선다. 허용은 패널 안에서 켤 수 있다.
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
      getT(locale)("terminal.settings.scrollback"),
      getT(locale)("terminal.settings.copyOnSelect"),
    ].join(" "),
    "terminal font typeface monospace renderer webgl canvas reading width cjk fallback korean japanese chinese hangul kana han glyph coverage",
    "터미널 글꼴 서체 고정폭 렌더러 읽기 폭 폴백 한글 일본어 중국어 가나 한자 글리프 커버리지",
  ],
  render: () => <GeneralSection />,
  // 폰의 설정 목록 보조 줄 — 터미널 글자 크기(터미널 전용 값이 없으면 코드 축을 따른다).
  mobile: {
    summary: (locale) => {
      const fonts = getGlobalSettingsStoreState().state?.fonts;
      if (!fonts) return null;
      return getT(locale)("terminal.settings.mobileSummary", { size: fonts.terminal?.size ?? fonts.code.size });
    },
    subscribe: subscribeGlobalSettings,
  },
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

export const agentExecution: ClientFeatureDescriptor = {
  id: null,
  objectiveRecordKinds: [agentObjectiveKind],
  settingsSections: [generalSettingsSection, agentSettingsSection],
  notificationKinds: [agentAttentionNotification, agentEndedNotification, agentResumeFailedNotification],
  closeObjective: async (objectiveId) => {
    try {
      await terminateAgentSession(objectiveId);
    } finally {
      disposeViewSwitch(objectiveId);
      disposeObjectiveViewState(objectiveId);
      removeSession(objectiveId);
    }
  },
  resumeObjective: async (objectiveId) => {
    // 팔레트·사이드바 등 프레임 밖 resume 진입점. 패널의 Start fresh 판정과 같은 근거를 쓴다 —
    // 재개 마커가 없으면 서버가 409 resume_unavailable 로 거절하므로 fresh 로 보낸다.
    try {
      await resumeSession(objectiveId, { fresh: await shouldResumeFresh(objectiveId) });
      installedNotifications?.dismiss(objectiveId);
    } catch (error) {
      installedNotifications?.emit({
        kind: agentResumeFailedNotification.id,
        objectiveId,
        message: resumeFailureMessage(error, currentTerminalLocale()),
      });
      throw error;
    }
  },
  // 새 세션 멘션 전달. 실패 표현은 컴포저가 거절 코드로 소유하므로 여기서는 알림을 내지 않는다.
  messageableObjectiveTypes: ["agent"],
  messageObjective: async (objectiveId, text, attachmentIds) => {
    await messageAgentSession(objectiveId, text, attachmentIds);
  },
  // 새 세션 이미지 첨부. 실패 표현은 컴포저가 거절 코드로 소유한다(messageObjective과 같은 계약).
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

/** 플러그인 소유 에이전트 기록의 채팅 렌더러 — 코어가 플러그인 install 컨텍스트의 `chat.Transcript` 로 넘긴다. */
export { AgentChatTranscript } from "./chat/chat-transcript.js";
/** 플러그인 소유 대화의 대화 화면 렌더러 — 코어가 플러그인 install 컨텍스트의 `chat.Conversation` 으로 넘긴다. */
export { AgentConversation } from "./chat/agent-conversation.js";
/** 플러그인이 사람에게 묻는 결정 카드 — 코어가 플러그인 install 컨텍스트의 `chat.DecisionCard` 로 넘긴다. 그룹 대화의 결정 카드와 같은 컴포넌트다. */
export { AgentDecisionCard } from "./chat/agent-decision-card.js";
/** 참여자의 원장 — 코어가 플러그인 install 컨텍스트의 `chat.Ledger` 로 넘긴다. 그룹 대화가 지휘관 원장을 여는 그 틀·본문·바닥 줄이다. */
export { AgentLedger } from "./chat/agent-ledger.js";
/** 컴포저 위쪽 호스트 요약 줄 — 코어가 플러그인 install 컨텍스트의 `chat.ComposerTopEntries` 로 넘긴다. */
export { ComposerTopEntries } from "./chat/composer-top-entries.js";

export const objectiveRecordKinds = [agentObjectiveKind] as const;

// resumeObjective 훅은 install context를 받지 못하므로 notifications만 모듈 스코프로 캡처한다.
// (같은 프로세스 내 plugin 인스턴스는 하나라 core의 단일 install 계약과 충돌하지 않는다.)
let installedNotifications: ExecutionClientDeps["notifications"] | null = null;

let installedApi: ExecutionClientDeps["api"] | null = null;
export function installAgentExecution(ctx: ExecutionClientDeps): () => void {
  installedNotifications = ctx.notifications;
  installedApi = ctx.api;
  setUseRequestApi(ctx.api);
  setInstalledExperiments(ctx.experiments);
  const disposeViewState = installObjectiveViewState(ctx.consoleState);
  const disposeGroupTimeline = installGroupTimeline(ctx);
  const disposeGroupConversation = installGroupConversationSurface();
  // Console Use 의 console_reveal — 에이전트가 "여기를 봐 달라"고 한 Objective 을 앞에 세우고 사유를 캡션 말풍선에 남긴다.
  // 사용자가 입력 중이면(활성 요소가 편집 가능) 포커스를 빼앗지 않고 말풍선만 띄운다.
  const disposeReveal = ctx.consoleEvents.subscribe(OBJECTIVE_REVEAL_EVENT_CHANNEL, (payload) => {
    if (!isObjectiveRevealEvent(payload)) return;
    recordObjectiveReveal(payload);
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    if (typing) return;
    focusConsoleObjective(payload.objectiveId);
    requestObjectiveKeyboardFocus(payload.objectiveId);
  });
  // 이 플러그인은 런타임 축의 권위를 가진다 — 첫 스냅샷이 도착하기 전까지는 그 축을 신뢰할 수 없다고
  // 먼저 선언하고 시작한다.
  ctx.runtime.setHydration("pending");
  // 서버 보관 종료 뒤에는 클라이언트 캐시만 해제한다. 늦은 stop 요청이 복원된 세션을 끊지 않는다.
  const disposeArchive = ctx.consoleEvents.subscribe("objective:cluster-changed", (payload) => {
    const ids = (payload as { removedIds?: unknown } | null)?.removedIds;
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === "string") {
      disposeViewSwitch(id);
      disposeObjectiveViewState(id);
      removeSession(id);
    }
  });
  const disposeConnection = startAgentConnection({
    objectiveRecords: ctx.objectiveRecords,
    notifications: ctx.notifications,
    runtime: ctx.runtime,
    refreshObjectiveRecords: ctx.api.resync,
  });
  return () => {
    installedNotifications = null;
    installedApi = null;
    setInstalledExperiments(null);
    disposeReveal();
    disposeConnection();
    disposeGroupConversation();
    disposeGroupTimeline();
    disposeArchive();
    disposeViewState();
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

function isCompanionPanelVisible(context: ObjectiveRenderContext, companionId: string): boolean {
  return Boolean(context.companionsOpen) && !(context.hiddenCompanionPanelIds ?? []).includes(companionId);
}

function toggleCompanionPanel(
  context: ObjectiveRenderContext,
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
  // 숨기기만 요청한다 — companion 배치를 걷는 판단은 호스트 몫이다. 여기서 함께 걷으면
  // 나란히 열어 둔 다른 패널까지 사라진다.
  for (const id of clusterIds) context.onSetCompanionPanelVisible(id, false);
}

/** 호스트가 그 companion 패널을 내주는가 — 목록을 주지 않은 호스트는 전부 내준다. 대화 중심 화면은 브라우저만 내준다. */
function offersCompanion(context: ObjectiveRenderContext, companionId: string): boolean {
  return context.companionPanelIds === undefined || context.companionPanelIds.includes(companionId);
}

/**
 * 모바일 Objective 화면에서는 셸이 막대를 그리고 보기 전환은 ⋮ 항목이 진다(AgentMobileMenu) — 캡션 선반을
 * 비워 막대 빈칸에 칩이 끼지 않게 한다. 창구의 유무는 한 마운트 동안 바뀌지 않지만, 훅 순서를 판정에
 * 걸지 않으려고 안쪽 컴포넌트로 가른다.
 */
/** 대화 머리가 요청하는 조각. shelf 는 표식·말풍선만, 전환과 지구본은 각 캡슐이 가져간다. */
type AgentCaptionPart = "shelf" | "view-switch" | "tools-lead";

function AgentCaptionActions({ context, part = "shelf" }: { readonly context: ObjectiveRenderContext; readonly part?: AgentCaptionPart }) {
  if (mobileObjectiveOf(context)) return null;
  return <AgentCaptionActionsBody context={context} part={part} />;
}

function AgentCaptionActionsBody({ context, part }: { readonly context: ObjectiveRenderContext; readonly part: AgentCaptionPart }) {
  const t = getT(context.language ?? "en");
  const state = useAgentState();
  const session = state.sessions[context.objectiveId] ?? sessionFromObjective(context);
  const { terminalPending } = useViewSwitchState(context.objectiveId);
  const chatMode = context.objectiveRecord.chatMode === true;
  const groupConversation = useHasGroupConversation(context.objectiveRecord.parentObjectiveId ?? context.objectiveId);
  // 투어 앵커는 사용자가 이 마운트에서 직접 채팅 뷰로 넘어온 뒤에만 선다 — 본문의 판정과 같다.
  const wasChatModeAtMountRef = React.useRef(chatMode);
  const chatOpenedHere = chatMode && !wasChatModeAtMountRef.current;

  const openTerminal = React.useCallback(async () => {
    setTerminalHandoff(context.objectiveId, { pending: true, error: "none" });
    try {
      await openTerminalForObjective(context);
    } catch {
      setTerminalHandoff(context.objectiveId, { error: "failed" });
    } finally {
      setTerminalHandoff(context.objectiveId, { pending: false });
    }
  }, [context]);

  // 브라우저 문 — 대화 중심 화면에서는 이 Session 의 브라우저를 바로 연다. 허용은 패널 안에서 켠다.
  // 자식 세션(목표 구성원)은 루트의 브라우저를 함께 쓴다 — 쓰는 중인지도 루트의 것을 읽는다.
  const using = useObjectiveUse(context.objectiveRecord.parentObjectiveId ?? context.objectiveId);
  const browserOpen = isCompanionPanelVisible(context, BROWSER_COMPANION_ID);
  // 에이전트가 브라우저를 쓰는 동안은 이 버튼이 곧 표식이다 — 별도 배지를 두지 않는다. 브라우저는 Desktop 앱의 것이라 문은 늘 서되,
  // 브라우저 탭·모바일로 연 화면이거나 다른 화면이 붙어 멈춘 동안은 닫힌 채로 서서 말풍선이 그 까닭을 말한다(투어도 그때는 이 문을 짚지 않는다).
  const engine = useBrowserEngine();
  const engineMissing = engine !== null && !engine.available;
  const browserLabel = engineMissing
    ? t(engine.reason === "shared" ? "terminal.browser.shared" : isDesktopShell() ? "terminal.browser.desktopMissing" : "terminal.browser.desktopOnly")
    : using.browser ? t("terminal.browser.agentUsing") : t(browserOpen ? "terminal.browser.exit" : "terminal.browser.open");
  const browser = context.onRequestCompanions === undefined || !offersCompanion(context, BROWSER_COMPANION_ID) ? null : (
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
      onClick={() => { setChatPromptOpen(context.objectiveId, true); }}
    >
      <CaptionChatGlyph />
    </CaptionActionButton>
  );

  // console_reveal·Console Use 시선의 말풍선 — 선반 끝에 폭 없는 앵커를 두어 ··· 버튼 왼쪽 아래에 선다.
  // 산 이벤트에만 뜬다(지난 사건은 다시 튀어나오지 않는다).
  const liveReveal = React.useSyncExternalStore(subscribeObjectiveReveals, () => getObjectiveReveal(context.objectiveId), () => null);
  // Console Use 시선 — 에이전트가 이 Objective 을 읽거나 만지면 같은 말풍선 자리에 "○○: 전사 읽음" 이 잠깐 선다.
  const liveGaze = React.useSyncExternalStore(subscribeConsoleUseGestures, () => getObjectiveWrap(context.objectiveId)?.gesture ?? null, () => null);
  const bubble = liveReveal || liveGaze
    ? <span className="session-watch-host">
        <RevealBubble context={context} reveal={liveReveal} />
        {liveGaze && !liveReveal ? <div className="session-watch-bubble is-gaze" role="status" aria-live="polite"><span className="session-watch-bubble__text"><span className="chat-by-agent">{gestureCallerLabel(liveGaze.caller)}</span> {liveGaze.summary}</span></div> : null}
      </span>
    : null;

  // 그룹 대화는 자기 구성원 턴 접기를 머리 슬롯에 싣는다. 1:1 채팅만 이전 문답 자동 접기를 보탠다.
  if (part === "view-switch") return <>{chatMode && !groupConversation ? <HistoryFoldButton language={context.language ?? "en"} caption /> : null}{viewSwitch}</>;
  if (part === "tools-lead") return browser;
  // 표식·말풍선이 없을 때는 빈 조각을 넘기지 않는다 — 머리 줄이 빈 캡슐을 세우지 않게.
  if (!using.console && !using.computer && bubble === null) return null;
  return (
    <>
      <span className="agent-objective-marks">
        <ObjectiveUseBadge active={using.console} kind="console" label={using.turnOnly.console ? t("terminal.experiments.useTurnOnly", { name: t("terminal.experiments.menuConsoleUse") }) : t("terminal.experiments.menuConsoleUse")} />
        <ObjectiveUseBadge active={using.computer} kind="computer" label={using.turnOnly.computer ? t("terminal.experiments.useTurnOnly", { name: t("terminal.experiments.menuComputerUse") }) : t("terminal.experiments.menuComputerUse")} />
      </span>
      {bubble}
    </>
  );
}

function ObjectiveUseBadge({ active, kind, label }: { active: boolean; kind: "console" | "computer" | "browser"; label: string }) {
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

/**
 * console_reveal 의 말풍선 — 캡션 동작 선반 끝(··· 버튼 왼쪽) 아래에 선다. 어떤 누름·입력이든 닫는다: 사유는
 * 알려야 하지만 화면을 차지해서는 안 된다. 산 사건에만 뜬다.
 */
function RevealBubble({ context, reveal }: { readonly context: ObjectiveRenderContext; readonly reveal: ObjectiveReveal | null }) {
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
async function openTerminalForObjective(context: ObjectiveRenderContext): Promise<void> {
  await exitAgentChat(context.objectiveId);
  try {
    await resumeSession(context.objectiveId);
    context.notifications.dismiss(context.objectiveId);
  } catch (error) {
    context.notifications.emit({
      kind: agentResumeFailedNotification.id,
      objectiveId: context.objectiveId,
      message: resumeFailureMessage(error, context.language),
    });
    throw error;
  }
}

/**
 * 터미널 표면의 PTY가 끝났다(4001). 그 표면이 붙어 있던 세대의 항목일 때만 지운다 — 항목이 이미 다른 세대를
 * 싣고 있으면 그 사이 새 PTY가 섰다는 뜻이고, 늦게 온 옛 종료가 방금 선 세션을 지우면 패널은 「종료됨」에
 * 멈춘다. 세대가 없는 항목(옛 서버)은 예전처럼 지운다.
 */
function removeExitedSession(sessionId: string, mountedGeneration: string | undefined): void {
  const current = getAgentState().sessions[sessionId];
  if (current?.generation !== undefined && current.generation !== mountedGeneration) return;
  removeSession(sessionId);
}

const SORTIE_RIBBON_INLINE_LIMIT = 2;

/**
 * 모바일 Objective 화면이면 본문 전체를 모바일 판정으로 감싸고(CSS는 `[data-mobile-surface]`만 읽는다)
 * ⋮ 항목을 셸에 올린다. 데스크톱은 감싸지 않아 DOM이 그대로다.
 */
function AgentObjectiveView({ context }: { readonly context: ObjectiveRenderContext }) {
  const mobile = mobileObjectiveOf(context);
  if (!mobile) return <AgentObjectiveBody context={context} />;
  return (
    <MobileSurfaceProvider mobile>
      <AgentMobileMenu context={context} mobile={mobile} />
      <div className="agent-mobile-surface" data-mobile-surface="">
        <AgentObjectiveBody context={context} />
      </div>
    </MobileSurfaceProvider>
  );
}

/**
 * 모바일 ⋮의 에이전트 항목(impl-spec S-08). 보기 전환은 지금 보기의 반대이고, 채팅→터미널은 바로, 터미널→채팅은
 * 확인 시트(S-14)를 거친다. 「컴퓨터 사용 계속 허용」은 이 Objective의 계속 허용 스위치이며, 설정에서 컴퓨터 사용
 * 실험이 꺼져 있으면 서지 않는다(D7). 캡션의 같은 동작과 같은 경로를 탄다.
 */
function AgentMobileMenu({ context, mobile }: { readonly context: ObjectiveRenderContext; readonly mobile: MobileObjectiveLike }) {
  const t = getT(context.language ?? "en");
  const state = useAgentState();
  const session = state.sessions[context.objectiveId] ?? sessionFromObjective(context);
  const chatMode = context.objectiveRecord.chatMode === true;
  const { terminalPending } = useViewSwitchState(context.objectiveId);
  const experiments = useExperimentsSnapshot();
  const computerUseEnabled = readComputerUseEnabled(context.objectiveRecord);
  const [usePending, setUsePending] = React.useState(false);
  const canSwitch = chatMode || session.status !== "dormant";
  // 「턴 접기」는 접힐 구성원 말이 있을 때만 — 데스크톱 머리 버튼과 같은 판정이다.
  const canFoldTurns = useConversationHasFoldableMembers(context.objectiveId) && chatMode;
  const foldTurns = useFoldTurns();

  const toTerminal = async () => {
    setTerminalHandoff(context.objectiveId, { pending: true, error: "none" });
    try {
      await openTerminalForObjective(context);
    } catch {
      setTerminalHandoff(context.objectiveId, { error: "failed" });
    } finally {
      setTerminalHandoff(context.objectiveId, { pending: false });
    }
  };
  const toChat = async () => {
    const confirmed = await mobile.confirm({
      title: t("terminal.mobile.toChatTitle"),
      body: t("terminal.mobile.toChatBody"),
      cancelLabel: t("terminal.chat.confirmKeep"),
      confirmLabel: t("terminal.mobile.toChatTitle"),
    });
    if (!confirmed) return;
    try {
      await convertAgentSessionToChat(context.objectiveId);
    } catch {
      // 무엇이 끝나야 넘어갈 수 있는지(바쁨 사유)는 본문의 전환 오버레이가 이미 말한다 — 거기서 다시 묻는다.
      setChatPromptOpen(context.objectiveId, true);
    }
  };
  const toggleComputerUse = () => {
    if (usePending || !installedApi) return;
    setUsePending(true);
    const api = installedApi;
    void setComputerUse(api, context.objectiveId, !computerUseEnabled, context.language ?? "en")
      .then(() => api.resync())
      .catch(() => undefined)
      .finally(() => setUsePending(false));
  };

  const items: MobileMenuItemLike[] = [];
  if (canSwitch) {
    items.push({
      id: "agent-view-switch",
      label: chatMode ? t(terminalPending ? "terminal.chat.openingTerminal" : "terminal.mobile.viewTerminal") : t("terminal.mobile.viewChat"),
      icon: <MobileGlyph name="swap" />,
      disabled: terminalPending,
      run: () => { void (chatMode ? toTerminal() : toChat()); },
    });
  }
  if (canFoldTurns) {
    items.push({
      id: "agent-fold-turns",
      label: getGroupT(context.language ?? "en")("group.fold.toggle"),
      icon: <MobileGlyph name="fold" />,
      checked: foldTurns,
      run: () => setFoldTurns(!foldTurns),
    });
  }
  if (experiments?.computerUse === true) {
    items.push({
      id: "agent-computer-use",
      label: t("terminal.mobile.keepComputerUse"),
      icon: <MobileGlyph name="check" />,
      checked: computerUseEnabled,
      disabled: usePending,
      run: toggleComputerUse,
    });
  }
  useMobileMenuItems(mobile, items, `${canSwitch}|${chatMode}|${terminalPending}|${canFoldTurns}|${foldTurns}|${experiments?.computerUse === true}|${computerUseEnabled}|${usePending}|${context.language}`);
  return null;
}

function AgentObjectiveBody({ context }: { readonly context: ObjectiveRenderContext }) {
  const t = getT(context.language ?? "en");
  const mobileSurface = useMobileSurface();
  // CLI 확인 줄은 입력 대기 신호(훅이 지는 축)가 선 동안만 — 터미널 출력을 해석해 추정하지 않는다.
  const awaitingInput = context.runtimeState?.lifecycle === "live" && context.runtimeState.activity === "awaiting";
  const state = useAgentState();
  const observed = state.sessions[context.objectiveId];
  const session = observed ?? sessionFromObjective(context);
  const chatMode = context.objectiveRecord.chatMode === true;
  const sessionStatus = session.status;
  const { chatPromptOpen } = useViewSwitchState(context.objectiveId);
  React.useEffect(() => {
    // 확인 오버레이는 라이브 터미널 분기 전용이다 — PTY 종료·채팅 전환으로 분기를 떠나면
    // 상태를 걷어 재개 시 낡은 다이얼로그가 되살아나지 않게 한다(이전 ChatModeEntry의
    // 언마운트-폐기와 등가).
    if (sessionStatus === "dormant" || chatMode) setChatPromptOpen(context.objectiveId, false);
  }, [context.objectiveId, sessionStatus, chatMode]);
  // 피처 투어 앵커는 이 마운트에서 사용자가 직접 채팅 뷰로 전환한 뒤에만 세운다 — chatMode는
  // payload에 영속되므로 마운트 시점부터 앵커를 세우면 리로드 직후 캔버스에서 투어가 먼저
  // 떠버린다. "직접 연 순간에만"이 이 투어의 판정이다.
  const wasChatModeAtMountRef = React.useRef(chatMode);
  const chatOpenedHere = chatMode && !wasChatModeAtMountRef.current;
  // 주소를 누르면 어디서 열지 먼저 묻는다 — CLI(터미널이 찾아낸 링크)와 채팅(마크다운 앵커)이 같은 카드를 쓴다.
  // 수식 없는 왼클릭은 3행 카드, 수정키·중간 클릭은 카드를 건너뛰어 곧장 연다.
  // shared 중에는 카드 없이 내 브라우저로 열고 처음 한 번 안내한다(채팅·CLI 공통). 가운데 칸의 그룹 대화도 같은 길을 쓴다(objective-links).
  const links = useObjectiveLinks({
    objectiveId: context.objectiveId,
    theaterId: context.objectiveRecord.theaterId,
    language: context.language,
    navigate: context.navigate,
    openCompanion: () => openBrowserCompanion(context),
  });
  const fileLinkFailure = links.fileLinkFailure;
  const terminalFileLinks = useAgentTerminalFileLinks(context.objectiveId, context.objectiveRecord.theaterId, context.navigate);
  // 모바일에서 「턴 접기」를 켠 그룹 루트는 1:1 원장 대신 그룹 대화를 세운다(데스크톱 가운데 칸과 같은 화면). 끄면 지금 그대로다.
  const groupConversation = useHasGroupConversation(context.objectiveId);
  const openUIOpen = useGroupClusters().find((cluster) => cluster.conversation?.objectiveId === context.objectiveId)?.conversation?.openUIOpen;
  const foldTurns = useFoldTurns();
  // 그룹 루트의 화면공유는 그룹채팅에 선다 — 이 본문이 지휘관 원장 틀 안에 선 동안에는 다시 그리지 않는다.
  const commanderLedger = useCommanderLedgerFramed(context.objectiveId);

  if (chatMode) {
    const chatView = (
      <OpenUINavigationContext.Provider value={openUIOpen ?? null}><AgentChatView context={context} tourAnchors={chatOpenedHere} fileLinkError={fileLinkFailure === null ? null
        : t(fileLinkFailure === "unsupported" ? "terminal.fileLink.unsupported" : "terminal.fileLink.failed")} /></OpenUINavigationContext.Provider>
    );
    return (
      <MarkdownLinkBoundary className="agent-stream-host" onClick={links.onLinkClick} onAuxClick={links.onLinkClick} fleetLink="self" openUIChoose={links.choose} {...links.fileLinks}>
        {mobileSurface && foldTurns && groupConversation && observed?.chatActive === true
          ? <MobileGroupConversation root={context.objectiveRecord} language={context.language ?? "en"}>{chatView}</MobileGroupConversation>
          : chatView}
        {commanderLedger ? null : <ComputerScreenShare objectiveId={context.objectiveId} />}
        {links.card}
      </MarkdownLinkBoundary>
    );
  }

  if (session.status === "dormant") {
    return (
      <div className="agent-stream-host">
        <DormantObjectiveView context={context} session={session} />
        {session.resumeAvailable ? <DormantChatEntry context={context} /> : null}
      </div>
    );
  }

  return (
    <div className="agent-stream-host">
      {/* 전환을 누르는 곳은 캡션이고, 무엇이 끝나야 넘어갈 수 있는지 말하는 이 오버레이는 본문이다. */}
      {chatPromptOpen ? <ChatModeInterstitial context={context} onClose={() => setChatPromptOpen(context.objectiveId, false)} /> : null}
      {/* 세대가 바뀌면(재기동) 표면을 새로 붙인다 — 같은 청크로 휴면과 새 기동이 함께 오면 휴면을 그리지 못한 채
          옛 표면이 남고, 그 연결은 옛 PTY의 종료(4001)로 재접속을 멈춘다. 새 표면이 새 티켓으로 새 PTY에 붙는다. */}
      <TerminalSurface
        key={session.generation}
        objectiveId={session.sessionId}
        ticketPath={AGENT_TICKET_PATH}
        wsPath={TERMINAL_WS_PATH}
        active={context.active}
        visible={context.bodyLive !== false}
        keyboardFocusRequestId={context.keyboardFocusRequestId}
        zoom={context.zoom}
        theme={context.theme}
        mobile={mobileSurface}
        awaitingConfirm={mobileSurface && awaitingInput}
        {...(mobileSurface ? { mobileDockTop: <UseRequestCards objectiveId={context.objectiveId} childSessionIds={context.objectiveRecord.sessions?.map((child) => child.id)} language={context.language} placement="terminal" /> } : {})}
        locale={context.language}
        onStatusDetail={(detail) => context.statusDetail.set(context.objectiveId, detail)}
        onOpenLink={links.choose}
        onOpenLinkDirect={links.openDirect}
        knownLinks={(text) => confirmAgentSessionLinks(session.sessionId, text)}
        fileLinks={terminalFileLinks}
        onExit={() => removeExitedSession(session.sessionId, session.generation)}
      />
      <ComputerScreenShare objectiveId={context.objectiveId} />
      {/* 모바일은 같은 카드를 터미널 독 맨 위(mobileDockTop)에 쌓는다 — 여기 떠 있으면 확인 줄을 덮는다. */}
      {mobileSurface ? null : <UseRequestCards objectiveId={context.objectiveId} childSessionIds={context.objectiveRecord.sessions?.map((child) => child.id)} language={context.language} placement="terminal" />}
      {links.card}
    </div>
  );
}

/**
 * Objective 메뉴의 실험 섹션 — 이 세션에 대한 사용 스위치. 설정에서 켠 실험만 행으로 서고, 켜져
 * 있는지는 Objective payload가 말한다(서버가 쓴다). 행은 한 줄이다 — 무엇을 허용하는지는 툴팁과
 * 접근성 라벨이 진다. 켜고 끄는 것은 재연결 없이 다음 도구 호출부터 듣는다.
 */
function AgentObjectiveMenu({ context }: { readonly context: ObjectiveMenuContext }) {
  const t = getT(context.language);
  const experiments = useExperimentsSnapshot();
  const payload = context.objectiveRecord;
  const [pending, setPending] = React.useState<"console" | "computer" | null>(null);
  // 자식 세션(목표 구성원)에는 사용 스위치가 없다 — 허용은 루트(지휘관)의 것이고 호스트도 자식 스위치를 거부한다.
  if (!experiments || !installedApi || context.objectiveRecord.parentObjectiveId) return null;
  const api = installedApi;
  const language = context.language;
  const toggle = (kind: "console" | "computer", next: boolean) => {
    setPending(kind);
    const request = kind === "console"
      ? setConsoleUse(api, context.objectiveRecord.id, next, language)
      : setComputerUse(api, context.objectiveRecord.id, next, language);
    void request.then(() => api.resync()).catch(() => undefined).finally(() => setPending(null));
  };
  const consoleUseEnabled = readConsoleUseEnabled(payload);
  const computerUseEnabled = readComputerUseEnabled(payload);
  const rows = [
    { id: "console-use" as const, kind: "console" as const, checked: consoleUseEnabled, glyph: <CaptionConsoleUseGlyph />, name: t("terminal.experiments.menuConsoleUse"), hint: t(consoleUseEnabled ? "terminal.experiments.menuConsoleUseOn" : "terminal.experiments.menuConsoleUseOff") },
    experiments.computerUse === true ? { id: "computer-use" as const, kind: "computer" as const, checked: computerUseEnabled, glyph: <CaptionComputerUseGlyph />, name: t("terminal.experiments.menuComputerUse"), hint: t(computerUseEnabled ? "terminal.experiments.menuComputerUseOn" : "terminal.experiments.menuComputerUseOff") } : null,
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
          aria-busy={pending === row.kind}
          aria-label={`${row.name} · ${row.hint}`}
          title={row.hint}
          disabled={pending !== null}
          data-objective-menu-item={row.id}
          onClick={() => toggle(row.kind, !row.checked)}
        >
          <span className="group-context-menu-item__glyph" aria-hidden="true">{row.glyph}</span>
          <span className="group-context-menu-item__name">{row.name}</span>
          <SwitchCheckMark />
        </button>
      ))}
    </>
  );
}

/** 사용 배지는 캡션과 같은 수명을 공유한다. */
function AgentObjectiveMarks({ context }: { readonly context: ObjectiveMenuContext }) {
  const t = getT(context.language);
  const using = useObjectiveUse(context.objectiveRecord.id);
  return (
    <span className="agent-objective-marks">
      <ObjectiveUseBadge active={using.console} kind="console" label={t("terminal.experiments.menuConsoleUse")} />
      <ObjectiveUseBadge active={using.computer} kind="computer" label={t("terminal.experiments.menuComputerUse")} />
      <ObjectiveUseBadge active={using.browser} kind="browser" label={t("terminal.browser.agentUsing")} />
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
function ChatModeInterstitial({ context, onClose }: { readonly context: ObjectiveRenderContext; readonly onClose: () => void }) {
  const t = getT(context.language ?? "en");
  const [state, setState] = React.useState<"idle" | "converting" | "busy" | "error">("idle");
  // 무엇이 끝나야 전환되는지 — 서버가 구분해 보내 준 사유. 알 수 없으면 뭉뚱그린 문구로 내려간다.
  const [busyReason, setBusyReason] = React.useState<string | null>(null);
  const titleId = `agent-chat-inter-${context.objectiveId}`;
  const convert = React.useCallback(async () => {
    setState("converting");
    try {
      await convertAgentSessionToChat(context.objectiveId);
      // payload.chatMode 반영이 뷰를 전환한다 — 여기서는 오버레이만 닫는다.
      onClose();
    } catch (error) {
      const busy = error instanceof AgentApiError && error.message === "chat_convert_busy";
      setBusyReason(busy && error instanceof AgentApiError ? error.reason ?? null : null);
      setState(busy ? "busy" : "error");
    }
  }, [context.objectiveId, onClose]);
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
function DormantChatEntry({ context }: { readonly context: ObjectiveRenderContext }) {
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
        void convertAgentSessionToChat(context.objectiveId)
          .catch(() => { setState("error"); })
          .then(() => { setState((current) => current === "error" ? current : "idle"); });
      }}
    >
      {state === "error" ? t("terminal.chat.convertFailed") : t("terminal.chat.dormantOpen")}
    </button>
  );
}

function GeneralSection() {
  const { renderer: terminalRenderer, inactiveFlush: terminalInactiveFlush } = useTerminalPrefs();

  // 카드를 Fragment로 직접 반환한다. 카드 간 간격은 호스트의 .global-settings-detail(그리드 gap)이
  // 제공하므로, 플러그인은 자체 래퍼로 감싸 그 간격을 가로채지 않는다(간격은 호스트 소관).
  return (
    <>
      <ChatReadingWidthSettingsCard />
      <TerminalDrawingCard terminalRenderer={terminalRenderer} terminalInactiveFlush={terminalInactiveFlush} />
      <TerminalBehaviorCard />
    </>
  );
}

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

/** 채팅 폭 — 컴포저의 폭 글리프와 같은 선호를 읽고 쓰는 설정 표면. */
function ChatReadingWidthSettingsCard() {
  const t = getT(useTerminalLocale());
  const width = useChatReadingWidth();
  return (
    <SettingsGroup ariaLabel={t("terminal.settings.chatReadingWidthAria")} title={t("terminal.settings.chatGroup")}>
      <SettingsItem
        label={t("terminal.settings.chatReadingWidthTitle")}
        labelId="terminal-chat-reading-width-label"
        helpTip={<SettingsHelp title={t("terminal.settings.chatReadingWidthTitle")}>{t("terminal.settings.chatReadingWidthHelp")}</SettingsHelp>}
      >
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
      </SettingsItem>
    </SettingsGroup>
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

async function resumeSession(sessionId: string, options?: { readonly fresh?: boolean }): Promise<void> {
  applySessionUpdate(await resumeAgentSession(sessionId, options));
  selectSession(sessionId);
}

// 패널 DormantObjectiveView 의 freshOnly(!session.resumeAvailable) 와 같은 판정.
// 세션 스냅샷이 아직 없으면 호스트 DTO 의 파생 마커를 읽는다. 조회가 실패하면
// fresh 를 추측하지 않는다 — 재개 가능한 Claude 세션을 지울 수 있다.
async function shouldResumeFresh(objectiveId: string): Promise<boolean> {
  const session = getAgentState().sessions[objectiveId];
  if (session) return !session.resumeAvailable;
  try {
    const response = await fetch(`/api/v1/objectives/records/${encodeURIComponent(objectiveId)}`);
    if (!response.ok) return false;
    const payload = await response.json() as {
      readonly objectiveRecord?: { readonly payload?: { readonly resumeAvailable?: unknown } };
    };
    return payload.objectiveRecord?.payload?.resumeAvailable !== true;
  } catch {
    return false;
  }
}

// dormant 프레임의 resume 상태기계. 실패는 프레임 내 에러 카드(Try again / Start fresh)와
// Alerts 알림(agent.resume-failed) 두 경로로 표면화한다 — 어느 쪽도 침묵하지 않는다.
function DormantObjectiveView({ context, session }: { readonly context: ObjectiveRenderContext; readonly session: SessionInfo }) {
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
        objectiveId: session.sessionId,
        message: resumeFailureMessage(error, context.language),
      });
    }
  }, [context, session.sessionId, t]);

  if (resumeState === "error" || resumeState === "launch-option-error") {
    return (
      <div className="objective-dormant objective-dormant--error" role="alert">
        <span className="objective-dormant-status">{t("terminal.dormant.status")}</span>
        <p className="objective-dormant-error">
          {resumeState === "launch-option-error"
            ? t("terminal.dormant.resumeLaunchOptionFailedBody", { name: session.label || session.cwdLabel })
            : freshOnly
              ? t("terminal.dormant.startFreshFailedBody", { name: session.label || session.cwdLabel })
              : t("terminal.dormant.resumeFailedBody", { name: session.label || session.cwdLabel })}
        </p>
        <div className="objective-dormant-error-actions">
          {freshOnly ? (
            <button type="button" className="objective-dormant-action" onClick={() => { void resume(true); }}>
              {t("terminal.dormant.tryAgain")}
            </button>
          ) : (
            <button type="button" className="objective-dormant-action" onClick={() => { void resume(false); }}>
              {t("terminal.dormant.tryAgain")}
            </button>
          )}
          {resumeState === "launch-option-error" || freshOnly ? null : (
            <button type="button" className="objective-dormant-action objective-dormant-action--ghost" onClick={() => { void resume(true); }}>
              {t("terminal.dormant.startFresh")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <button type="button" className="objective-dormant" disabled={resumeState === "resuming"} onClick={() => { void resume(freshOnly); }}>
      <span className="objective-dormant-status">{t("terminal.dormant.status")}</span>
      <span className={`objective-dormant-action${resumeState === "resuming" ? " objective-dormant-action--pending" : ""}`}>
        {resumeState === "resuming"
          ? t(freshOnly ? "terminal.dormant.startingFresh" : "terminal.dormant.resuming")
          : t(freshOnly ? "terminal.dormant.startFresh" : "terminal.dormant.resume")}
      </span>
    </button>
  );
}

function sessionFromObjective(context: ObjectiveRenderContext): SessionInfo {
  return {
    sessionId: context.objectiveRecord.id,
    terminalSessionId: context.objectiveRecord.id,
    cwdLabel: context.objectiveRecord.title || "Workspace",
    label: context.objectiveRecord.title,
    status: "dormant",
    turnState: "none",
    createdAt: context.objectiveRecord.ts.createdAt,
    theaterId: context.theaterId,
    tenantId: readPayloadString(context.objectiveRecord, "tenantId") ?? undefined,
    registrationId: readPayloadString(context.objectiveRecord, "registrationId") ?? undefined,
    resumeAvailable: context.objectiveRecord.resumeAvailable === true,
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
    <SettingsGroup ariaLabel={t("terminal.settings.terminalDrawingAria")} title={t("terminal.settings.terminalGroup")}>
      <SettingsItem
        label={t("terminal.settings.terminalRenderer")}
        helpTip={(
          <SettingsHelp title={t("terminal.settings.terminalRenderer")}>
            <p>{t("terminal.settings.terminalRendererHelp")}</p>
          </SettingsHelp>
        )}
      >
        <SettingsSegments
          ariaLabel={t("terminal.settings.terminalRendererAria")}
          value={terminalRenderer}
          options={RENDERER_IDS.map((rendererId) => ({ value: rendererId, label: rendererLabels[rendererId] }))}
          onChange={setTerminalRenderer}
        />
      </SettingsItem>
      <SettingsItem
        label={t("terminal.settings.inactiveFlush")}
        helpTip={(
          <SettingsHelp title={t("terminal.settings.inactiveFlush")}>
            <p>{t("terminal.settings.inactiveFlushHelp")}</p>
          </SettingsHelp>
        )}
      >
        <SettingsSegments
          ariaLabel={t("terminal.settings.inactiveFlushAria")}
          value={terminalInactiveFlush}
          options={INACTIVE_FLUSH_IDS.map((inactiveFlushId) => ({ value: inactiveFlushId, label: inactiveFlushLabels[inactiveFlushId] }))}
          onChange={setTerminalInactiveFlush}
        />
      </SettingsItem>
    </SettingsGroup>
  );
}

// 스크롤백과 선택 복사는 터미널이 출력을 **다루는** 방식이다 — 그리는 방식(위 카드)과 갈라 둔다.
// 둘 다 서버 영속이라 콘솔을 따라다니고, 바꾸면 열린 터미널에도 곧바로 적용된다.
function TerminalBehaviorCard() {
  const locale = useTerminalLocale();
  const t = getT(locale);
  const { scrollback, copyOnSelect } = useTerminalPrefs();
  const numberFormat = new Intl.NumberFormat(locale);
  return (
    <SettingsGroup ariaLabel={t("terminal.settings.terminalBehaviorAria")}>
      <SettingsItem
        label={t("terminal.settings.scrollback")}
        helpTip={(
          <SettingsHelp title={t("terminal.settings.scrollback")}>
            <p>{t("terminal.settings.scrollbackHelp")}</p>
          </SettingsHelp>
        )}
      >
        <SettingsSegments
          ariaLabel={t("terminal.settings.scrollbackAria")}
          value={scrollback}
          options={TERMINAL_SCROLLBACK_CHOICES.map((choice) => ({ value: choice, label: t("terminal.settings.scrollbackLines", { count: numberFormat.format(choice) }) }))}
          onChange={setTerminalScrollback}
        />
      </SettingsItem>
      <SettingsItem
        label={t("terminal.settings.copyOnSelect")}
        helpTip={(
          <SettingsHelp title={t("terminal.settings.copyOnSelect")}>
            <p>{t("terminal.settings.copyOnSelectHelp")}</p>
          </SettingsHelp>
        )}
      >
        <SettingsSegments
          toggle
          ariaLabel={t("terminal.settings.copyOnSelect")}
          value={copyOnSelect}
          options={([true, false] as const).map((value) => ({ value, label: t(value ? "terminal.settings.toggleOn" : "terminal.settings.toggleOff") }))}
          onChange={setTerminalCopyOnSelect}
        />
      </SettingsItem>
    </SettingsGroup>
  );
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
