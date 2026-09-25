import { React } from "@fleet-console/sdk/plugin/browser";
import { UseRequestCards } from "../use-request-card.js";
import { createPortal } from "react-dom";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";
import { HistoryBand, useHistoryReveal } from "@fleet-console/sdk/components/history-band";

import { getT } from "../i18n/index.js";
import { useChatReadingWidth, nextChatReadingWidth, setChatReadingWidth, useTerminalFontFamily } from "../../terminal/shared/terminal-preferences.js";
import { CaptionReadingWidthGlyph } from "@fleet-console/sdk/components/caption-actions";
import { agentChatAttachmentPreviewUrl, readAgentChatJobDetail, sleepAgentChat, stopAgentChatJob } from "../api.js";
import { StreamedMarkdown } from "../streamed-markdown.js";
import { AgentGlyph } from "../agent-glyphs.js";
import { useAgentChatStream, type AgentChatViewState } from "./chat-store.js";
import {
  AGENT_CHAT_JOB_FAMILY,
  AGENT_CHAT_THINK_FAMILY,
  agentChatMcpCall,
  agentChatToolFamily,
  agentChatToolLabel,
  openAgentChatJobs,
  segmentAgentChatLedger,
  splitAgentChatTurn,
  type AgentChatAsk,
  type AgentChatAttachment,
  type AgentChatChange,
  type AgentChatContext,
  type AgentChatContextSlice,
  type AgentChatJob,
  type AgentChatJobDetail,
  type AgentChatJobKind,
  type AgentChatQuestion,
  type AgentChatLedgerPart,
  type AgentChatStepGroup,
  type AgentChatTurn,
  type AgentChatTurnItem,
  chatOriginLabel,
} from "./chat-events.js";
import { readAgentChatSessionCoordinates, type AgentChatSessionCoordinates } from "./session-coordinates.js";
import { AgentChatComposer, READING_WIDTH_LABEL_KEY, useDistinctChatWidths, type AgentChatQueueCancelOutcome } from "./composer.js";
import { useViewSwitchState } from "../view-switch-store.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

/**
 * Ctrl+C 무장이 서 있는 시간. 이 창을 넘기면 다음 Ctrl+C는 다시 첫 번째 누름이다. 안내를 읽고
 * 판단할 만큼은 되어야 하지만, 무장은 시간보다 **다음 행동**이 먼저 거둔다(아래 키 분기).
 */
const SLEEP_ARM_WINDOW_MS = 8_000;

/** 이것만 눌린 상태는 아직 조합 중이다 — Ctrl+C 무장을 거두지 않는다. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

/**
 * 이전 대화를 펼쳤을 때 위로 내미는 꼬리의 높이.
 *
 * 펼치기가 자리를 지키면 화면이 한 픽셀도 움직이지 않고, 그러면 눌렸는지 알 수 없다. 이 값만큼만
 * 덜 지켜서 직전 답의 마지막 줄이 현재 문답 위로 넘어오게 한다 — "위에 생겼다"를 말하는 최소치다.
 * 바닥을 따라가는 중에는 0이다: 그때 자리를 지킨다는 것은 바닥에 머무는 것이고, 꼬리를 내밀면
 * 팔로우가 곧바로 되돌려 깜빡임만 남는다.
 */
const HISTORY_PEEK_PX = 56;

/** 이 키가 제 것이 아님을 말하는 자리들 — 남의 입력창과 그 위에 선 면. */
const FOREIGN_KEY_SURFACES = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox'], dialog";

/**
 * 이 채팅 패널이 이 키를 자기 것으로 읽어도 되는가.
 *
 * 초점이 컴포저에 있을 때만 듣는 것으로는 부족하다 — 사람이 패널을 눌러 활성으로 만들었을 뿐
 * 초점은 본문이나 캔버스에 있는 것이 보통이고, 그때도 이 Operation이 키보드의 주인이다. 그래서
 * 문서에서 듣되 **남의 것**만 걸러낸다: 다른 Operation의 프레임 안, 그리고 어디에 있든 남의
 * 입력창·대화상자·메뉴. 이 패널 안에서 난 키는 컴포저를 포함해 언제나 이 패널의 것이다.
 */
function ownsChatKeyboardEvent(panel: HTMLElement | null, operationId: string, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return true;
  if (panel?.contains(target)) return true;
  const element = target instanceof Element ? target : target.parentElement;
  if (!element) return true;
  if (element.closest(FOREIGN_KEY_SURFACES)) return false;
  const frame = element.closest<HTMLElement>("[data-operation-id]");
  if (frame) return frame.dataset.operationId === operationId;
  return true;
}

/**
 * 지금 Ctrl+C가 복사해야 할 선택이 있는가.
 *
 * 입력 요소 안의 선택은 문서 선택에 나타나지 않으므로 두 축을 모두 본다 — 한쪽만 보면
 * 컴포저에 쓰던 문장을 복사하려던 손이 대화를 휴면으로 보낸다.
 */
function hasCopyableSelection(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const { selectionStart, selectionEnd } = active;
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) return true;
  }
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().trim().length > 0;
}

/**
 * Chat Mode의 Operation 본문 — 지휘 로그.
 *
 * 지시는 패널 하단의 귀속 컴포저에서 쓴다(sdk/composer 블록의 축약 조립 — 쉬는 한 줄로
 * 물러나 있다가 인터랙션에만 펼쳐진다). Quick Launch 멘션 전달은 여전히 살아 있는 별도
 * 경로다. 모델이 멈춰 서서 물으면 그 자리에 카드가 서고, 카드 안에서 답한다 — 카드의 입력은
 * 새 턴을 만들지 않고 지금 그 질문에만 살며, 답하면 사라진다.
 *
 * 턴의 표현 문법은 두 국면이다. 진행 중에는 **라이브 원장**이 선다 — 이 턴이 건드린 파일이
 * 맨 위에 스트립으로 서고, 그 아래로 스텝이 쌓이며, 각 스텝은 이름·좌표·결과를 차례로
 * 채워 간다. 지나간 스텝과 흘러나온 문장은 화면에서 사라지지 않는다. 끝나면 Answer 앞의
 * 전부가 `{duration} 동안 작업함` 한 줄로 접히고, 그 줄 오른쪽의 아이콘이 다시 편다.
 * 접힌 줄은 **그 턴의 결말**만 말한다 — 끝내 실패했는지, 사용자가 끊었는지, 아직 도는 잡이
 * 있는지. 도중에 넘어진 스텝은 결말이 아니라 과정이므로 그 수를 접힌 줄에 싣지 않고,
 * 펼침 안에서 ✕와 실패 사유로 온전히 선다.
 *
 * 구성원 모드 — 이 뷰는 채팅 표면(chatMode)에서만 서므로, `parentOperationId`가 있으면
 * Objectives 구성원이다. 그때는 입력 틀·예약 목록·이미지 투입구를 빼고 바닥 줄(좌표 ·
 * 선반 · 문맥 계기 · 중지 · 채팅 폭)만 남긴다. 터미널 표면의 구성원과 일반 Operation,
 * 휴면 카드(DormantChatView — index.tsx)는 이 분기를 타지 않는다.
 */
export function AgentChatView({
  context,
  tourAnchors,
}: {
  readonly context: OperationRenderContext;
  /** 사용자가 이 마운트에서 직접 채팅 뷰를 연 경우에만 true — 투어 앵커 렌더 여부를 결정한다. */
  readonly tourAnchors: boolean;
}) {
  const t = getT(context.language ?? "en");
  const state = useAgentChatStream(context.operationId, context.bodyLive !== false);
  // 채팅 폭 선호 — 콘솔 단위 사용자 선호(플러그인 설정 서버 영속)라 모든 채팅 패널이 함께 따른다.
  // 대화 컬럼과 입력창이 이 값 하나를 함께 따른다.
  const readingWidth = useChatReadingWidth();
  const terminalFontFamily = useTerminalFontFamily();
  // 구성원 모드 — 채팅으로 열린 Objectives 구성원(parentOperationId)뿐이다. 이 뷰 자체가
  // chatMode 분기에서만 마운트되므로 터미널(CLI) 구성원은 여기에 오지 않는다.
  const isMemberChat = typeof context.operation.parentOperationId === "string" && context.operation.parentOperationId.length > 0;
  // 현재 작업 여부의 권위는 호스트가 쥔 런타임 축 하나다 — 이 뷰가 따로 축을 주장하면 열려 있는
  // 동안만 정직해지고, 패널을 닫는 순간 사이드바가 다시 휴면으로 돌아간다. 축이 degraded면 호스트가
  // null 을 건네므로 진행 중이라고 주장하지 않는다(그 사실은 전역 배너가 말한다).
  const runtime = context.runtimeState;
  const working = runtime?.lifecycle === "live" && runtime.activity === "running";
  // 터미널로 넘어가는 문은 캡션에 서고, 그 시도가 왜 막혔는지는 이 면이 말한다 — 버튼과 문장이
  // 서로 다른 트리에 살므로 사실은 저장소를 거쳐 온다.
  const { terminalError } = useViewSwitchState(context.operationId);
  const [stopping, setStopping] = React.useState(false);
  const [stopFailed, setStopFailed] = React.useState(false);
  // Ctrl+C 한 번은 무장이고, 두 번째가 휴면이다 — CLI에서 같은 손가락이 하는 일을 이 표면에도
  // 둔다. 무장은 이 패널 안에서만 살고 잠시 뒤 스스로 풀린다.
  const [sleepArmed, setSleepArmed] = React.useState(false);
  const [sleepFailed, setSleepFailed] = React.useState(false);
  // 바닥을 따라가는 중인지 — 칩 가시성의 권위. ref 와 같은 값이지만, 스크롤이 바꾼 뒤에는
  // 그려져야 하므로 state 로도 둔다.
  const [following, setFollowing] = React.useState(true);
  // 자리를 세운 뒤 새로 열린 턴 수. 스트리밍 델타를 세면 답 한 건이 수십 건으로 부풀므로,
  // 사용자 지시와 그 응답을 함께 담는 턴의 탄생만 센다.
  const [unseenTurns, setUnseenTurns] = React.useState(0);
  const [answerAnnouncement, setAnswerAnnouncement] = React.useState("");
  // 두 번째 목적지는 대화 **위로** 떠오른다. 탭 교체는 대화를 통째로 숨겼고, 나란히 선 스플릿은
  // 열 때마다 로그의 절반을 가져갔다 — 시트는 대화의 아래쪽을 잠시 덮을 뿐 밀어내지 않고,
  // 접으면 로그와 컴포저는 처음 그 자리다. 여는 것이 레이아웃 사건이 아니어야 닫는 것도 가볍다.
  const [workOpen, setWorkOpen] = React.useState(false);
  // 로그는 마지막 문답만 보여 준다. 앞선 턴은 상단 밴드 뒤에 접혀 있고, 누르거나 맨 위에서
  // 위로 한 번 더 굴리면 펼쳐진다. 새 턴이 서면(팔로우 중일 때) 다시 접힌다.
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [openJobId, setOpenJobId] = React.useState<string | null>(null);
  /** 시트가 대화를 얼마나 덮는가. 이 패널이 사는 동안만 기억한다 — 영속 선호가 아니다. */
  const [workTall, setWorkTall] = React.useState(false);
  // 선반의 문. Esc로 접었을 때 초점이 돌아가는 자리다 — 문을 누르지 않고 닫았어도 다음 Tab이
  // 문 다음에서 이어져야 하고, 그 문은 언제나 같은 자리에 서 있다.
  const ledgeToggleRef = React.useRef<HTMLButtonElement>(null);
  const workSheetRef = React.useRef<HTMLElement>(null);
  /** 이 패널의 뿌리 — 어떤 키가 이 패널 안에서 났는지 가리는 좌표다. */
  const panelRef = React.useRef<HTMLElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  // 팔로우는 두 축이다. 바닥을 따라가는 중이면 스트림이 자랄 때마다 바닥으로 간다. 자리를
  // 세우면 그 자리의 scrollTop 을 지킨다 — 예전에 쓰던 "바닥까지의 거리"는 패널 리사이즈에만
  // 쓴다. 스트림 성장에 거리를 고정하면 읽던 줄이 밑으로 끌려간다.
  const nearBottomRef = React.useRef(true);
  const bottomDistanceRef = React.useRef<number | null>(null);
  // 프로그램적 복원이 낳은 scroll 이벤트는 사용자 의도가 아니다. 이것을 걸러내지 않으면 복원 자체가
  // 팔로우 상태를 뒤집어, 한 번 튄 스크롤이 영영 바닥으로 돌아오지 못한다.
  const suppressScrollRef = React.useRef(0);
  const previousTurnCountRef = React.useRef(state.turns.length);
  // 재접속 직전 서버 누적 좌표. 저널 상한으로 화면의 과거 턴이 잘려도 이 값은 역행하지 않는다.
  const snapshotTurnBaselineRef = React.useRef<number | null>(state.snapshotting ? state.observedTurns : null);
  const previousReadyAnswersRef = React.useRef(0);

  // 아직 아무 턴도 오가지 않은 세션. 재생 중이거나 연결 전에는 판단을 미룬다 — 그때의 "비어
  // 있음"은 아직 모른다는 뜻이고, 그것을 초대로 읽으면 과거가 있는 세션에도 초대가 잠깐 스친다.
  const awaitingFirstTurn = state.turns.length === 0 && !state.replaying && state.connection === "open";

  // 델타가 흐르는 동안에도 바닥 추적이 이어지도록 draft 길이를 스크롤 신호에 합산한다.
  const scrollSignal = state.turns.reduce(
    (count, turn) => count + turn.items.length + (turn.dispatch ? 1 : 0) + turn.draft.length,
    0,
  );
  const applyScrollTop = React.useCallback((next: number) => {
    const log = logRef.current;
    if (!log) return;
    // Work 탭이 서 있는 동안 로그는 숨어 있다(높이 0). 그 크기로 계산한 좌표를 쓰면 복귀했을 때
    // 맨 위를 가리키게 된다 — 크기를 잃은 순간의 값으로는 의도를 읽을 수 없다는, handleScroll과
    // 성장 효과가 이미 지키는 같은 규율을 유일한 쓰기 지점에서도 지킨다.
    if (log.clientHeight === 0) return;
    if (log.scrollTop === next) return;
    suppressScrollRef.current += 1;
    log.scrollTop = next;
    requestAnimationFrame(() => {
      suppressScrollRef.current = Math.max(0, suppressScrollRef.current - 1);
    });
  }, []);

  const restoreFollow = React.useCallback(() => {
    const log = logRef.current;
    if (!log || !nearBottomRef.current) return;
    applyScrollTop(log.scrollHeight);
  }, [applyScrollTop]);

  const restorePlace = React.useCallback(() => {
    const log = logRef.current;
    if (!log || nearBottomRef.current) return;
    applyScrollTop(Math.max(0, log.scrollHeight - log.clientHeight - (bottomDistanceRef.current ?? 0)));
  }, [applyScrollTop]);

  // 패널 리사이즈 전용 — 팔로우면 바닥, 언핀이면 기억해 둔 바닥 거리.
  const restoreAnchor = React.useCallback(() => {
    if (nearBottomRef.current) restoreFollow();
    else restorePlace();
  }, [restoreFollow, restorePlace]);

  // 스트림 성장은 팔로우일 때만 바닥으로 간다. 언핀이면 scrollTop 을 그대로 둔다.
  // 다만 그때의 바닥 거리를 갱신하지 않으면, 이후 리사이즈가 성장 전 거리로
  // restorePlace 를 돌려 읽던 줄을 꼬리 쪽으로 끌어올린다.
  React.useLayoutEffect(() => {
    restoreFollow();
    const log = logRef.current;
    if (!log || nearBottomRef.current || log.clientHeight === 0) return;
    bottomDistanceRef.current = Math.max(0, log.scrollHeight - log.scrollTop - log.clientHeight);
  }, [restoreFollow, scrollSignal, working, state.turns.length]);

  React.useEffect(() => {
    const previous = previousTurnCountRef.current;
    previousTurnCountRef.current = state.turns.length;
    if (state.snapshotting) {
      // open이 로그를 비우기 전의 수를 보존한다. snapshot 안에서 같은 턴을 복원한 것은 새 도착이 아니다.
      if (snapshotTurnBaselineRef.current === null) snapshotTurnBaselineRef.current = state.observedTurns;
      return;
    }
    const wasSnapshotting = snapshotTurnBaselineRef.current !== null;
    snapshotTurnBaselineRef.current = null;
    // 예약 목록은 여기서 내리지 않는다 — 서버가 시작과 동시에 큐 전량을 다시 보내고, 그것이 이 축의
    // 유일한 권위다. 끊긴 동안 예약이 실제로 시작했는지도 재접속 스냅숏이 그대로 말해 주므로,
    // 화면이 receipt를 세어 맞출 일 자체가 없다.
    //
    // 남는 것은 도착 신호뿐이다. snapshot 안의 증가는 이미 보던 턴의 복원이므로 세지 않고,
    // snapshot 밖에서 직접 열린 턴만 미확인으로 올린다.
    if (wasSnapshotting) return;
    const arrived = Math.max(0, state.turns.length - previous);
    if (arrived === 0) return;
    if (!nearBottomRef.current) {
      setUnseenTurns((current) => current + arrived);
      return;
    }
    // 새 문답이 서면 앞선 문답은 밴드 뒤로 물러나고 그 질문이 로그 상단에 앉는다 — 답은 그
    // 아래에서 자라고, 화면을 넘길 때만 팔로우가 바닥을 따른다.
    setHistoryOpen(false);
    requestAnimationFrame(() => applyScrollTop(0));
  }, [applyScrollTop, state.observedTurns, state.snapshotting, state.turns.length]);
  // 펼침과 접힘은 현재 문답 **위쪽**의 높이만 바꾼다. 그래서 바닥까지의 거리를 기억해 두면
  // 자리를 되찾을 수 있다 — 아래쪽은 한 줄도 달라지지 않기 때문이다.
  //
  // 삽입된 높이를 그대로 더하지 않는 이유가 있다. 스크롤이 맨 위가 아닌 자리에서는 브라우저의
  // 기본 앵커링이 이미 같은 보정을 하고 있어서, 높이 차를 한 번 더 더하면 두 배로 튄다. 바닥까지의
  // 거리로 목표 좌표를 새로 계산하면 누가 먼저 손을 댔든 결과가 같다.
  const historyAnchorRef = React.useRef<number | null>(null);
  const markHistoryAnchor = React.useCallback(() => {
    const log = logRef.current;
    if (!log || log.clientHeight === 0) return;
    historyAnchorRef.current = log.scrollHeight - log.scrollTop;
  }, []);
  const toggleHistory = React.useCallback(() => {
    markHistoryAnchor();
    setHistoryOpen((current) => !current);
  }, [markHistoryAnchor]);
  const revealHistory = React.useCallback(() => {
    markHistoryAnchor();
    setHistoryOpen(true);
  }, [markHistoryAnchor]);
  useHistoryReveal({ ref: logRef, armed: !historyOpen && state.turns.length > 1, onReveal: revealHistory });

  // 새 턴 도착이 밴드를 도로 접을 때는 좌표를 남기지 않는다 — 그 경로는 로그를 맨 위로 되돌리는
  // 것이 의도이고, 여기서 자리를 지키면 그 의도를 덮는다.
  React.useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    historyAnchorRef.current = null;
    const log = logRef.current;
    if (anchor === null || !log || log.clientHeight === 0) return;
    const peek = nearBottomRef.current ? 0 : HISTORY_PEEK_PX;
    applyScrollTop(Math.max(0, log.scrollHeight - anchor + (historyOpen ? -peek : peek)));
  }, [applyScrollTop, historyOpen]);

  React.useEffect(() => {
    const ready = state.turns.filter((turn) => turn.state !== "working" && turn.answer !== undefined).length;
    const previous = previousReadyAnswersRef.current;
    previousReadyAnswersRef.current = ready;
    // 리플레이된 과거 답변은 읽어 주지 않는다. live 턴 하나가 완료된 전이만 빈 live region의
    // 텍스트를 바꿔, 이미 채워진 status 노드를 삽입할 때 브라우저마다 달라지는 발화를 피한다.
    if (state.replaying || ready <= previous) return;
    setAnswerAnnouncement("");
    requestAnimationFrame(() => setAnswerAnnouncement(t("terminal.chat.answerReady")));
  }, [state.replaying, state.turns, t]);

  // War Room 스테이지 승격처럼 패널 크기가 바뀌는 순간에도 앵커를 지킨다. 이 복원이 없으면 로그는
  // 바뀐 높이 위에서 예전 scrollTop 을 그대로 들고 있게 되고, 접혀 있던 패널이 펼쳐지는 경우처럼
  // 높이가 0에서 자라면 그 값이 곧 맨 위다.
  React.useEffect(() => {
    const log = logRef.current;
    if (!log || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => restoreAnchor());
    observer.observe(log);
    return () => observer.disconnect();
  }, [restoreAnchor]);

  const handleScroll = React.useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    if (suppressScrollRef.current > 0) return;
    // 크기를 잃은 순간(패널이 접혔거나 아직 배치 전)의 값으로는 의도를 읽을 수 없다.
    if (log.clientHeight === 0) return;
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    const atBottom = distance < 80;
    nearBottomRef.current = atBottom;
    bottomDistanceRef.current = atBottom ? null : distance;
    setFollowing(atBottom);
    if (atBottom) setUnseenTurns(0);
  }, []);

  const handleFollow = React.useCallback(() => {
    nearBottomRef.current = true;
    bottomDistanceRef.current = null;
    setFollowing(true);
    setUnseenTurns(0);
    const log = logRef.current;
    if (log) applyScrollTop(log.scrollHeight);
  }, [applyScrollTop]);


  const timeFormat = React.useMemo(
    () => new Intl.DateTimeFormat(context.language === "ko" ? "ko" : "en", { hour: "2-digit", minute: "2-digit" }),
    [context.language],
  );

  // 이 세션의 실행 좌표. Operation payload에 실려 오므로 스트림과 무관하게 첫 프레임부터 서 있다.
  const coordinates = React.useMemo(
    () => readAgentChatSessionCoordinates(context.operation.payload),
    [context.operation.payload],
  );

  /** `/context`가 컴포저에서 문맥 계기를 여는 신호. 값이 바뀐 사실만 뜻이 있다. */
  const [meterOpenSignal, setMeterOpenSignal] = React.useState(0);

  const openJobs = openAgentChatJobs(state);
  // 원장의 도구 줄과 잡을 잇는 축. 잡을 낳은 스텝은 한 줄이 아니라 카드로 선다.
  const jobsByToolUse = React.useMemo(() => {
    const map = new Map<string, AgentChatJob>();
    for (const job of state.jobs) {
      if (job.toolUseId !== undefined) map.set(job.toolUseId, job);
    }
    return map;
  }, [state.jobs]);
  const selectedJob = openJobId === null ? null : state.jobs.find((job) => job.id === openJobId) ?? null;
  const language = context.language ?? "en";

  const showJob = React.useCallback((id: string) => {
    setOpenJobId(id);
    setWorkOpen(true);
  }, []);
  // 선반의 작업 상태가 여는 면 — 특정 잡을 고르지 않고 목록(작업 면)을 연다.
  const openWork = React.useCallback(() => {
    setOpenJobId(null);
    setWorkOpen(true);
  }, []);
  // 스트립과 작업 면을 잇는 좌표. 한 화면에 채팅 패널이 여럿 열릴 수 있으므로 마운트마다 고유해야 한다.
  const paneId = React.useId();
  // 잡을 한 번이라도 낳은 세션에만 문이 선다. 하나도 없으면 스트립도 작업 면도 크롬일 뿐이다.
  const hasJobs = state.jobs.length > 0;
  // 마지막 턴이 도는가 — 중지 버튼의 권위. 호스트 런타임 축은 백그라운드 대기까지 working으로
  // 읽으므로 여기서는 쓰지 않는다: 끊을 턴이 없는데 서 있는 중지 버튼은 눌러도 409를 받는다.
  const turnRunning = state.turns.at(-1)?.state === "working";

  React.useEffect(() => {
    if (state.connection === "open" || !turnRunning) setStopFailed(false);
  }, [state.connection, turnRunning]);

  const collapseWork = React.useCallback(() => {
    setWorkOpen(false);
    setOpenJobId(null);
  }, []);

  // 시트 안의 × 로 접는 길. 그 버튼은 눌리는 순간 사라지므로, Esc 와 같은 좌표(선반의 상태
  // 버튼)로 초점을 돌려주지 않으면 다음 Tab 이 패널 밖 body 에서 시작한다.
  const closeWork = React.useCallback(() => {
    collapseWork();
    ledgeToggleRef.current?.focus();
  }, [collapseWork]);

  const handleStop = React.useCallback(async (): Promise<boolean> => {
    setStopping(true);
    setStopFailed(false);
    try {
      await state.stopTurn();
      return true;
    } catch {
      // WebSocket이 끊긴 동안의 중지는 서버에 닿지 않는다. 턴이 닫히지 않은 채 버튼만 원래대로
      // 돌아가면 접수된 것처럼 읽히므로, 재연결 뒤 다시 누를 수 있게 초점 가까이에서 실패를 말한다.
      setStopFailed(true);
      return false;
    } finally {
      setStopping(false);
    }
  }, [state.stopTurn]);

  const handleCancelQueued = React.useCallback(async (queueId: string): Promise<AgentChatQueueCancelOutcome> => {
    try {
      await state.cancelQueued(queueId);
      return "canceled";
    } catch (error) {
      // 서버가 판정한 거절과 서버에 닿지도 못한 실패가 여기서 만난다. 둘을 합치면 연결이 끊긴
      // 사용자에게 "이미 시작됐으니 턴을 중지하라"고 말하게 되는데, 그 지시는 아직 큐에 남아 있을
      // 수 있다 — 도는 턴의 중지가 같은 자리에서 이미 둘을 갈라 말한다(stopFailed).
      //
      // 서버의 판정은 `queue_not_found` 하나뿐이다. 소켓 부재·조기 종료·ACK 시한(chat-store가 던지는
      // 코드들)은 판정이 아니라 판정의 부재이고, 알 수 없는 NACK도 그쪽에 둔다 — 시작했다고 단정할
      // 근거가 없는 실패를 시작으로 읽으면 사용자가 멈추지 않아도 될 턴을 멈춘다.
      return error instanceof Error && error.message === "queue_not_found" ? "started" : "unreachable";
    }
  }, [state.cancelQueued]);

  const toggleWork = React.useCallback(() => {
    if (workOpen) collapseWork();
    else openWork();
  }, [workOpen, collapseWork, openWork]);

  // 잡 원장이 시트 밑에서 비면(재접속이 리듀서를 되감고 저널에 잡이 남지 않은 경우) 선반도
  // 함께 물러난다. 문 없는 시트는 열린 채 굳으므로, 선반이 물러나는 순간 시트도 접는다.
  React.useEffect(() => {
    if (!hasJobs && workOpen) collapseWork();
  }, [hasJobs, workOpen, collapseWork]);

  // 열리거나 목록·상세가 갈아 끼워지면 보이는 내용의 첫 컨트롤로 초점을 보낸다. 시트는 DOM에서
  // 선반보다 앞에 있고, 뷰를 바꾼 버튼은 그 순간 사라진다 — 이 좌표를 듣지 않으면 Tab은 컴포저로
  // 건너뛰고 Esc도 패널 밖 body에서 시작한다. 접을 때는 언제나 선반의 상태 버튼으로 돌아간다.
  React.useEffect(() => {
    if (!workOpen) return;
    workSheetRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [workOpen, selectedJob?.id]);

  // 무장은 스스로 풀린다 — 몇 분 전에 한 번 눌러 둔 Ctrl+C가 지금의 복사 시도를 휴면으로
  // 바꾸면 안 된다.
  React.useEffect(() => {
    if (!sleepArmed) return;
    const timer = window.setTimeout(() => { setSleepArmed(false); }, SLEEP_ARM_WINDOW_MS);
    return () => { window.clearTimeout(timer); };
  }, [sleepArmed]);

  const sleepChat = React.useCallback(async () => {
    setSleepFailed(false);
    try {
      // 성공하면 세션 갱신이 도착해 이 패널 자리에 휴면 카드가 선다 — 여기서 화면을 바꾸지 않는다.
      await sleepAgentChat(context.operationId);
    } catch {
      setSleepFailed(true);
    }
  }, [context.operationId]);

  // Esc는 이 채팅 패널 안에서 생긴 키만 bubble 단계에서 듣는다. document에 걸면 다른 패널의
  // Esc까지 삼키고, capture 단계면 컴포저의 더 구체적인 덱 닫기보다 먼저 시트를 접는다. 자식이
  // 이미 소비한 Esc와 IME 조합 중 Esc는 그대로 두고, 남은 일반 Esc만 시트를 닫는다.
  const onPanelKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.key !== "Escape") return;
    // 무장을 풀 길은 Esc가 먼저다 — 작업 면이 열려 있어도, 지금 서 있는 안내부터 거둔다.
    if (sleepArmed) {
      event.preventDefault();
      event.stopPropagation();
      setSleepArmed(false);
      return;
    }
    if (workOpen) {
      event.preventDefault();
      event.stopPropagation();
      collapseWork();
      ledgeToggleRef.current?.focus();
      return;
    }
    // 구성원 Esc. 입력 틀과 그 프레임 리스너가 없는 구성원 모드에서 도는 턴을 끊는 자리다.
    // 섹션 버블 단계에서만 듣는 것은 그대로라 초점이 이 패널 안에 있을 때만 동작하고, 한 화면에
    // 열린 다른 패널의 턴은 건드리지 않는다. 문맥 계기 팝오버가 열려 있으면 그쪽이 capture 단계에서
    // 전파를 끊어 먼저 닫히므로 여기까지 닿지 않는다.
    if (!isMemberChat || !turnRunning || stopping) return;
    event.preventDefault();
    event.stopPropagation();
    void handleStop();
  }, [workOpen, collapseWork, sleepArmed, isMemberChat, turnRunning, stopping, handleStop]);

  /**
   * Ctrl+C 제스처. 듣는 자리는 문서이고, 듣는 조건은 **이 Operation이 활성일 때**다 — 사람이
   * 패널을 눌러 활성으로 만들었다면 초점이 컴포저에 있든 본문에 있든 이 패널이 키보드의 주인이다.
   * 남의 프레임·입력창·대화상자에서 난 키는 ownsChatKeyboardEvent가 걸러낸다.
   */
  React.useEffect(() => {
    if (!context.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key !== "c" || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        // 다른 키를 눌렀다면 사용자는 이미 다음 일을 하고 있다 — 무장은 그 순간 풀린다. 수식키만
        // 누른 상태는 아직 Ctrl+C를 조합하는 중이므로 그대로 둔다.
        if (!MODIFIER_KEYS.has(event.key)) setSleepArmed(false);
        return;
      }
      // 두 번 눌러야 확정되며, 길게 누른 반복 입력으로는 확정되지 않는다 — 무장과 확정이 한 번의
      // 누름으로 이어지면 안전장치가 아니다. 선택이 서 있으면 복사가 이긴다(Windows·Linux의 복사 키).
      if (event.repeat || hasCopyableSelection()) return;
      if (!ownsChatKeyboardEvent(panelRef.current, context.operationId, event.target)) return;
      event.preventDefault();
      setSleepArmed((armed) => {
        if (armed) {
          void sleepChat();
          return false;
        }
        setSleepFailed(false);
        return true;
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, [context.active, context.operationId, sleepChat]);

  // 활성에서 물러나면 무장도 함께 거둔다 — 다른 패널을 보다 돌아온 사람에게 예전 무장이 남아
  // 있으면, 첫 Ctrl+C가 안내 없이 곧바로 휴면으로 간다.
  React.useEffect(() => {
    if (!context.active) setSleepArmed(false);
  }, [context.active]);

  // 시트가 덮지 않은 대화 위를 누르면 시트가 물러난다 — 콘솔의 팝오버와 같은 문법이다. 원장의
  // 잡 앵커는 예외다: 그것은 시트를 여는 문이라, 누르는 순간 닫히면 문이 스스로를 지운다.
  const onLogPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!workOpen) return;
    if ((event.target as Element).closest(".agent-chat-job-anchor")) return;
    collapseWork();
  }, [workOpen, collapseWork]);

  // 좌표·선반·문맥 계기 — 컴포저와 구성원 바닥 줄이 같은 것을 그린다. 어느 쪽이든 사실 표시에
  // 불과하므로 같은 노드를 나눠 쓴다.
  const coordinateNode = <SessionCoordinate coordinates={coordinates} t={t} />;
  const ledgeNode = hasJobs ? (compact: boolean) => (
    <WorkLedge
      jobs={state.jobs}
      openJobs={openJobs}
      open={workOpen}
      controlsId={`${paneId}-work`}
      language={language}
      compact={compact}
      toggleRef={ledgeToggleRef}
      onToggle={toggleWork}
    />
  ) : undefined;
  const meterNode = <ContextMeterChip context={state.context} working={turnRunning} language={language} openSignal={meterOpenSignal} />;

  return (
    <section
      ref={panelRef}
      className="agent-chat"
      data-reading-width={readingWidth}
      /* 터미널 글꼴을 Chat 로컬 토큰으로만 흘린다 — 전역 --font-mono를 덮으면 Codex·파일 탐색기·
         마크다운 코드까지 따라 바뀐다. 이 토큰의 소비처는 chat.css 하나다. */
      /* 구성원 모드에서만 초점을 받을 수 있다 — tabIndex=-1이라 패널 안을 누르면 브라우저가
         초점을 준다. Tab 순서에는 들지 않는다. 일반 모드에는 속성을 두지 않는다. */
      {...(isMemberChat ? { tabIndex: -1 } : {})}
      style={{ "--agent-chat-font": terminalFontFamily } as React.CSSProperties}
      aria-label={t("terminal.chat.aria")}
      onKeyDown={onPanelKeyDown}
    >
      <span className="agent-chat-sr-only" role="status" aria-atomic="true">{answerAnnouncement}</span>
      {/* 대화 면 하나다. 백그라운드 작업은 옆 컬럼도 아래 서랍도 아니라, 컴포저 위 선반에서
          대화 위로 떠오르는 시트다 — 열어도 로그와 컴포저는 한 픽셀도 움직이지 않는다. */}
      <div className="agent-chat-pane">
        {/* 로그와 그 위에 떠 있는 크롬(Follow·잡 스트립·중지)의 좌표계. 컴포저가 pane 하단에
            in-flow로 서면서, pane에 앵커하던 부유물이 컴포저 위에 얹히지 않도록 부유물의
            containing block을 로그 영역으로 좁힌다 — 컴포저 높이가 얼마가 되든 부유물은
            언제나 그 위에 선다. */}
        <div className="agent-chat-body">
        {/* data-chat-tour는 코어 feature-tour 카탈로그가 짚는 크로스 번들 앵커 계약이다 —
            사용자가 직접 전환해 들어온 마운트에서만 세워, 리로드로 복원된 채팅 패널이
            콘솔 로드 화면에서 투어를 발화시키지 않게 한다. */}
        <div
          className={`agent-chat-log${awaitingFirstTurn ? " is-inviting" : ""}${workOpen ? " is-shaded" : ""}`}
          ref={logRef}
          role="log"
          aria-label={t("terminal.chat.aria")}
          aria-live="off"
          onScroll={handleScroll}
          onPointerDown={onLogPointerDown}
          {...(tourAnchors ? { "data-chat-tour": "log" } : {})}
        >
      {/* 아직 아무 말도 오가지 않은 패널이 지는 초대. 빈 로그를 그대로 두면 96%가 빈 면이라
          "아직 아무것도 없는 제품"으로 읽힌다 — 이 한 덩어리가 그 자리를 지고, 바로 아래
          가운데에 선 컴포저가 다음 행동을 말한다. 첫 턴이 오면 함께 사라진다. */}
      {awaitingFirstTurn ? (
        isMemberChat ? (
          <>
            <div className="agent-chat-member-spring-top" aria-hidden="true" />
            <div className="agent-chat-hero is-member">
              <span className="agent-chat-hero-sigil" aria-hidden="true">✳</span>
              <h2 className="agent-chat-hero-title">{t("terminal.chat.memberHeroTitle")}</h2>
              <p className="agent-chat-hero-body">{t("terminal.chat.memberHeroBody")}</p>
            </div>
            <div className="agent-chat-member-spring-bottom" aria-hidden="true" />
          </>
        ) : (
          <div className="agent-chat-hero">
            <span className="agent-chat-hero-sigil" aria-hidden="true">✳</span>
            <h2 className="agent-chat-hero-title">{t("terminal.chat.heroTitle")}</h2>
            <p className="agent-chat-hero-body">{t("terminal.chat.heroBody")}</p>
          </div>
        )
      ) : null}
      {/* 시드를 못 세운 세션은 스트림이 오류 하나를 쓰고 닫는다 — 그 뒤로 아무 이벤트도 오지
          않으므로, 이 분기가 없으면 패널은 "연결하는 중…"에 영원히 머문다. 고착된 스피너는
          상태가 아니다: 무엇이 없고 어디로 가야 하는지 말하고, 위 터미널 전환 칩이 그 출구다. */}
      {state.errorCode === "chat_transcript_missing"
        ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.transcriptMissing")}</div>
        : state.connection === "connecting" && state.turns.length === 0
          ? <div className="agent-chat-sys">{t("terminal.chat.connecting")}</div>
          : null}
      {/* 재생 자체는 소리 없이 콘텐츠만 되쓴다 — 같은 세션의 지난 턴은 표면(CLI/Chat)을 오가도
          사용자 자기 대화이므로, 그것을 "이전 턴 재생됨"으로 알리면 없던 이전 세션을 가리키는
          오독이 된다. 새 도착 오알림을 막는 replay-start/replay-end 경계는 그대로 남는다. */}
      {state.errorCode === "chat_replay_unavailable"
        ? <div className="agent-chat-sys agent-chat-sys--warn">{t("terminal.chat.replayUnavailable")}</div>
        : null}
      {/* 마지막 턴만 선다. 앞선 턴은 밴드 뒤에 접힌 채 마운트를 유지한다 — 펼치면 문서 순서
          그대로 위에 서고, 접힘은 렌더가 아니라 표시만 거둔다(빠른 Shell 연속성 같은 턴 내부
          상태가 접힘으로 사라지지 않게).

          펼친 높이는 전부 현재 문답 **위**에 생기므로 스크롤은 그만큼 따라가야 한다. 그러지 않으면
          같은 좌표가 세션의 첫 질문을 가리키게 되어, 보던 자리를 잃는다. 위 레이아웃 효과가 바닥
          까지의 거리로 그 자리를 지킨다. */}
      <HistoryBand
        count={state.turns.length - 1}
        open={historyOpen}
        onToggle={toggleHistory}
        label={t(historyOpen ? "terminal.chat.historyBandOpen" : "terminal.chat.historyBand", { count: state.turns.length - 1 })}
      />
      <div className="agent-chat-history" hidden={!historyOpen}>
        {state.turns.slice(0, -1).map((turn, index) => (
          <ChatTurn
            key={index}
            operationId={context.operationId}
            turn={turn}
            nextContextBefore={state.turns[index + 1]?.contextBefore}
            language={language}
            timeFormat={timeFormat}
            streaming={false}
            jobsByToolUse={jobsByToolUse}
            onOpenJob={showJob}
            onAnswer={state.answerAsk}
          />
        ))}
      </div>
      {state.turns.length > 0 ? (
        <ChatTurn
          key={state.turns.length - 1}
          operationId={context.operationId}
          turn={state.turns[state.turns.length - 1]!}
          nextContextBefore={undefined}
          language={language}
          timeFormat={timeFormat}
          streaming={state.turns[state.turns.length - 1]!.state === "working"}
          jobsByToolUse={jobsByToolUse}
          onOpenJob={showJob}
          onAnswer={state.answerAsk}
        />
      ) : null}
      {state.errorCode === "chat_turn_failed"
        ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.turnFailed")}</div>
        : null}
      {stopFailed
        ? <div className="agent-chat-sys agent-chat-sys--error" role="alert">{t("terminal.chat.stopFailed")}</div>
        : null}
      {sleepFailed
        ? <div className="agent-chat-sys agent-chat-sys--error" role="alert">{t("terminal.chat.sleepFailed")}</div>
        : null}
      {state.connection === "lost"
        ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.connectionLost")}</div>
        : null}
      {terminalError !== "none"
        ? (
          <div className="agent-chat-sys agent-chat-sys--error" role="alert">
            <span aria-hidden="true">✕</span>{" "}
            {t("terminal.chat.openTerminalFailed")}
          </div>
        )
        : null}
        </div>

        {/* 자리를 세운 동안만 로그 하단 중앙에 선다. 라벨은 Follow — Analyst FOLLOW UP 과
            다른 물건이고, 안 읽은 수는 Wave 2. 회신 말풍선은 우하단을 지킨다.
            떠 있는 컨트롤은 전부 대화 면 안에 산다 — 패널 전체에 걸어 두면 작업 면이 열린
            순간 그 위로 넘어가, 도구 표를 회신 버튼이 덮는다. */}
        {/* Ctrl+C 한 번이 세우는 안내. 모달이 아니다 — 초점을 가져가면 두 번째 누름이 이 패널
            밖에서 일어나고, 그러면 확정할 손가락이 갈 곳을 잃는다. */}
        {sleepArmed ? (
          <div className="agent-chat-sleep-hint" role="status">
            <span className="agent-chat-sleep-hint-line">{t(turnRunning ? "terminal.chat.sleepHintRunning" : "terminal.chat.sleepHint")}</span>
            <span className="agent-chat-sleep-hint-fine">{t("terminal.chat.sleepHintFine")}</span>
          </div>
        ) : null}

        {!following ? (
          <button
            type="button"
            className="agent-chat-follow"
            aria-label={unseenTurns > 0 ? t("terminal.chat.followUnreadAria", { count: unseenTurns }) : t("terminal.chat.followAria")}
            onClick={handleFollow}
          >
            {unseenTurns > 0 ? t("terminal.chat.followUnread", { count: unseenTurns }) : t("terminal.chat.follow")}
          </button>
        ) : null}

        {/* 백그라운드 작업의 시트. 로그의 좌표계(이 body) 안에서 바닥에 붙어 대화의 아래쪽을
            덮는다 — 선반 바로 위에서 자라므로 문과 내용이 한 이음새다. Follow 칩보다 위층이라
            열린 동안 그 칩은 시트 뒤로 들어간다. */}
        {workOpen ? (
          <WorkSheet
            id={`${paneId}-work`}
            sheetRef={workSheetRef}
            jobs={state.jobs}
            job={selectedJob}
            operationId={context.operationId}
            language={language}
            tall={workTall}
            onToggleTall={() => setWorkTall((value) => !value)}
            onClose={closeWork}
            onOpen={setOpenJobId}
            onBack={() => setOpenJobId(null)}
          />
        ) : null}
        {/* 패널 안 허용 요청 — 대화 면 바닥, 컴포저 바로 위에 선다. 초점은 가져가지 않는다. */}
        <UseRequestCards operationId={context.operationId} language={language} placement="chat" />
        </div>

        {/* 이 패널에 귀속된 축약 컴포저 — 읽던 자리에서 바로, 언제나 서 있다. 말풍선 문
            (Quick Launch로 가는 회신 버튼)은 이 컴포저가 대체했다 — Quick Launch 멘션
            전달은 여전히 살아 있는 별도 경로다.

            선반은 잡이 하나라도 태어난 세션에서만 넘긴다 — 컴포저 표시줄의 가운데 칸이 그
            자리이고, 아무것도 없으면 그 칸은 비어 좌표와 폭 글리프가 예전처럼 양 끝을 지킨다.

            구성원 모드에서는 이 자리 대신 바닥 줄(MemberChatFooter)이 선다 — 입력 틀·예약
            목록·이미지 투입구는 없고, 좌표 · 선반 · 문맥 계기 · 중지 · 채팅 폭만 남는다. */}
        {isMemberChat ? (
          <MemberChatFooter
            coordinate={coordinateNode}
            ledge={ledgeNode}
            meter={meterNode}
            language={language}
            turnRunning={turnRunning}
            stopping={stopping}
            onStop={handleStop}
          />
        ) : (
          <AgentChatComposer
            context={context}
            coordinate={coordinateNode}
            ledge={ledgeNode}
            meter={meterNode}
            coordinates={coordinates}
            onOpenContextMeter={() => setMeterOpenSignal((signal) => signal + 1)}
            catalogEpoch={state.catalogEpoch}
            tourAnchor={tourAnchors}
            turnRunning={turnRunning}
            stopping={stopping}
            queue={state.queue}
            onStop={handleStop}
            onCancelQueued={handleCancelQueued}
          />
        )}

        {/* 첫 턴 전 컴포저를 가운데로 올려 두는 받침. 첫 턴이 오면 flex-grow가 0으로 줄며
            컴포저가 하단으로 내려앉는다 — 움직이는 것은 컴포저 하나이고, 컴포저 자신은 언제나
            in-flow라 대화의 마지막 줄을 덮지 않는다. 높이를 직접 애니메이션하지 않는 이유는
            패널 높이가 사용자 손에 달려 있어서다: 비율로 두면 어떤 높이에서도 같은 자리다.
            구성원 모드에서는 히어로가 위 1 : 아래 1.38 받침으로 같은 자리를 지키므로 이 받침은
            서지 않는다 — 첫 메시지가 오면 제자리에서 대화로 바뀐다(내려앉는 움직임 없음). */}
        <div className={isMemberChat || !awaitingFirstTurn ? "agent-chat-settle" : "agent-chat-settle is-inviting"} aria-hidden="true" />
      </div>
    </section>
  );
}

/**
 * 이 세션의 실행 좌표를 상시로 말하는 각인.
 *
 * 여러 채팅 패널이 한 화면에 서면, 무거운 지시를 어디로 던질지는 좌표가 정한다 — 그래서 이 표식은
 * 대화 안이 아니라 컴포저 툴 행 맨 앞, 패널을 훑는 눈이 먼저 닿는 자리에 선다. 최근 백그라운드
 * 작업 글리프처럼 별도 배지를 두르지 않고 프레임에 직접 놓여, 컴포저를 여러 상자로 쪼개지 않는다.
 * 평상시에는 중립이라 대화를 이기지 않고, 신호(상태) 채널도 쓰지 않는다. 색을 얻는 것은 강도뿐이며,
 * 그 어휘는 런치 트랙의 것을 그대로 쓴다.
 *
 * 컨트롤이 아니라 사실이므로 버튼이 아니다. 누를 수 있게 그리면 "여기서 바꿀 수 있다"는
 * 거짓 약속이 된다 — 좌표를 바꾸는 길은 새 세션을 여는 것뿐이다.
 */
function SessionCoordinate({
  coordinates,
  t,
}: {
  readonly coordinates: AgentChatSessionCoordinates;
  readonly t: ReturnType<typeof getT>;
}) {
  const model = coordinates.model ?? t("terminal.chat.coordDefaultModel");
  const effort = coordinates.effort ?? t("terminal.chat.coordAutoEffort");
  return (
    // 이름을 지는 역할이 필요하다 — 일반 span의 aria-label은 지원 대상이 아니라 무시될 수 있고,
    // 그러면 남는 것은 "Opus · ULTRACODE"라는 조각뿐이다. 상태 아이콘이 쓰는 것과 같은 role로
    // 이 복합 표식 전체가 한 문장으로 읽히게 한다.
    <span
      className={`agent-chat-coord${coordinates.ultracode ? " is-ultracode" : ""}`}
      role="img"
      aria-label={t("terminal.chat.coordAria", { model, effort })}
      {...(coordinates.title ? { title: coordinates.title } : {})}
    >
      {/* 이름만으로는 같은 자리에 선 두 모델이 어디서 온 것인지 말하지 못한다 — 공급자 글리프가
          그 축을 진다(런치 메뉴·분석가 칩과 같은 표식). 공급자를 읽지 못한 세션은 중립 마름모로
          돌아가고, ultracode는 그 자리에 자기 별을 세운다. */}
      {coordinates.provider !== null && !coordinates.ultracode ? (
        <span className="agent-chat-coord-glyph" aria-hidden="true" data-provider={coordinates.provider}>
          {launchProviderGlyph(coordinates.provider)}
        </span>
      ) : (
        <span className="agent-chat-coord-mark" aria-hidden="true">{coordinates.ultracode ? "✦" : "◇"}</span>
      )}
      <span className="agent-chat-coord-model">{model}</span>
      <span className="agent-chat-coord-sep" aria-hidden="true">·</span>
      <span className="agent-chat-coord-effort" data-effort-level={coordinates.effortLevel}>{effort}</span>
    </span>
  );
}

/**
 * 구성원 바닥 줄 — 입력 틀이 빠진 자리에 남는 한 줄이다. 순서는 좌표 · 선반 ·
 * [문맥 계기][중지][채팅 폭 글리프]. 컴포저 표시줄과 같은 세 칸 그리드와 같은 글리프
 * 규격을 쓰므로(CSS 클래스 공유), 두 표면이 같은 과녁과 같은 리듬을 지킨다.
 *
 * 함께 빠지는 것: 입력 틀, 예약 목록(예약할 입력이 없다), 이미지 투입구. 허용 요청 카드와
 * 작업 시트·선반은 이 줄 밖에 살아 있다.
 */
function MemberChatFooter({
  coordinate,
  ledge,
  meter,
  language,
  turnRunning,
  stopping,
  onStop,
}: {
  readonly coordinate: React.ReactNode;
  readonly ledge: ((compact: boolean) => React.ReactNode) | undefined;
  readonly meter: React.ReactNode;
  readonly language: "en" | "ko";
  readonly turnRunning: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<boolean>;
}) {
  const t = getT(language);
  const footRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <div className="agent-chat-member-foot" ref={footRef}>
      <div className="agent-chat-composer-meta">
        {coordinate}
        {ledge !== undefined ? ledge(false) : <span className="agent-chat-composer-gap" aria-hidden="true" />}
        <span className="agent-chat-member-tools">
          {meter}
          {/* 멈추기는 쓰기가 아니다 — 구성원 턴이 엉뚱한 방향으로 갈 때 이 패널에서 바로
              끊는다. 도는 동안에만 서고, 끝나면 물러난다. 같은 일을 Esc도 함께 진다(패널
              리스너). */}
          {turnRunning ? (
            <button
              type="button"
              className="agent-chat-composer-stop"
              disabled={stopping}
              onClick={() => { void onStop(); }}
              aria-label={t("terminal.chat.stopAria")}
              title={t("terminal.chat.stopTitle")}
            >
              <span className="agent-chat-composer-stop-mark" aria-hidden="true" />
            </button>
          ) : null}
          <MemberWidthButton hostRef={footRef} language={language} />
        </span>
      </div>
    </div>
  );
}

/**
 * 채팅 폭 글리프 — 컴포저 표시줄의 그것과 같은 순환을 바닥 줄에서 잇는다. 읽는 폭과 쓰는 폭을
 * 함께 지는 하나의 문이라 입력 틀이 없어도 남는다. 같은 폭으로 접힌 단은 건너뛰고, 전부 접히면
 * 물러나 선다(컴포저와 같은 계약).
 */
function MemberWidthButton({
  hostRef,
  language,
}: {
  readonly hostRef: React.RefObject<HTMLDivElement | null>;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const readingWidth = useChatReadingWidth();
  const widthChoices = useDistinctChatWidths(hostRef);
  const widthCollapsed = widthChoices.length < 2;
  return (
    <button
      type="button"
      className="agent-chat-composer-width"
      onClick={() => {
        if (widthCollapsed) return;
        setChatReadingWidth(nextChatReadingWidth(readingWidth, widthChoices));
      }}
      aria-disabled={widthCollapsed || undefined}
      aria-label={widthCollapsed
        ? t("terminal.chat.widthSame")
        : t("terminal.chat.widthCycleAria", { current: t(READING_WIDTH_LABEL_KEY[readingWidth]) })}
      title={widthCollapsed
        ? t("terminal.chat.widthSame")
        : t("terminal.chat.widthCycleAria", { current: t(READING_WIDTH_LABEL_KEY[readingWidth]) })}
    >
      <CaptionReadingWidthGlyph preset={readingWidth} />
    </button>
  );
}

/** 토큰 수를 계기와 같은 자로 접는다 — 두 표면이 다른 자를 쓰면 같은 압축이 다른 크기로 읽힌다. */
function formatCompactTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

/**
 * 정비 명령 한 줄. 원장에서 유일하게 턴이 아닌 항목이다.
 *
 * 계기가 채우는 것은 **되찾은 문맥**이다. 진척률이 아닌 이유는 그 값이 존재하지 않기 때문이다 —
 * 자식은 압축 중이라는 사실만 말하고 얼마나 남았는지는 말하지 않는다(실측). 그래서 도는 동안은
 * 끝을 모른다는 뜻의 왕복 띠이고, 끝난 뒤에야 실제 비율이 선다. 지어낸 퍼센트를 그리면 그 숫자가
 * 처음 몇 초 동안 유일하게 확신에 찬 거짓말이 된다.
 */
/**
 * 보낸 이미지 — 말풍선 머리에 컴포저 칩과 같은 문법으로 선다.
 *
 * 브라우저가 쥔 것은 미리보기 좌표뿐이고 호스트 경로는 서버에 남는다. 바이트가 이미 회수됐으면
 * (세션이 닫혔거나 지난 프로세스의 재생이면) 자리만 남긴다 — 첨부가 있었다는 사실은 깨진 이미지
 * 아이콘이 아니라 말로 말한다.
 */
function ChatDispatchAttachments({
  attachments,
  language,
}: {
  readonly attachments: readonly AgentChatAttachment[];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const [opened, setOpened] = React.useState<string | null>(null);
  // 404는 "없는 첨부"가 아니라 "거둬진 첨부"다 — 같은 자리에 lapsed와 같은 말을 세운다.
  const [lapsed, setLapsed] = React.useState<readonly string[]>([]);
  const live = attachments.filter((attachment): attachment is { readonly id: string } => (
    "id" in attachment && !lapsed.includes(attachment.id)
  ));
  const lapsedCount = attachments.length - live.length;
  return (
    <div className="agent-chat-dispatch-attachments">
      {live.map((attachment, index) => (
        <button
          key={attachment.id}
          type="button"
          className="agent-chat-dispatch-attachment"
          aria-label={t("terminal.chat.attachmentOpen", { index: String(index + 1) })}
          title={t("terminal.chat.attachmentOpen", { index: String(index + 1) })}
          onClick={() => setOpened(attachment.id)}
        >
          <img
            src={agentChatAttachmentPreviewUrl(attachment.id)}
            alt={t("terminal.chat.attachmentAlt", { index: String(index + 1) })}
            onError={() => setLapsed((current) => (current.includes(attachment.id) ? current : [...current, attachment.id]))}
          />
        </button>
      ))}
      {lapsedCount > 0 ? (
        <span className="agent-chat-dispatch-attachment-lapsed">
          <span className="agent-chat-dispatch-attachment-lapsed-box" aria-hidden="true" />
          {t("terminal.chat.attachmentLapsed", { count: String(lapsedCount) })}
        </span>
      ) : null}
      {opened !== null ? (
        <ChatAttachmentViewer
          id={opened}
          index={live.findIndex((attachment) => attachment.id === opened) + 1}
          language={language}
          onClose={() => setOpened(null)}
          onLapsed={() => {
            setLapsed((current) => (current.includes(opened) ? current : [...current, opened]));
            setOpened(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** 첨부 한 장을 크게 본다. 부유 모달의 공용 문법(스크림·Esc·바깥 클릭)을 그대로 쓴다. */
function ChatAttachmentViewer({
  id,
  index,
  language,
  onClose,
  onLapsed,
}: {
  readonly id: string;
  readonly index: number;
  readonly language: "en" | "ko";
  readonly onClose: () => void;
  readonly onLapsed: () => void;
}) {
  const t = getT(language);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  // 포커스는 열릴 때 닫기로 가고 닫히면 부른 자리로 돌아간다 — 키보드 사용자가 원장의 제자리를
  // 잃지 않게 하는 최소 계약이다.
  React.useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => returnTo?.focus();
  }, []);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 같은 키가 패널의 다른 닫힘(작업 시트)까지 함께 닫지 않게 여기서 멈춘다.
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return createPortal(
    <div className="agent-chat-attachment-scrim" role="dialog" aria-modal="true" aria-label={t("terminal.chat.attachmentAlt", { index: String(index) })} onMouseDown={onClose}>
      <div className="agent-chat-attachment-frame" onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeRef} type="button" className="agent-chat-attachment-close" onClick={onClose} aria-label={t("terminal.chat.attachmentClose")}>✕</button>
        <img src={agentChatAttachmentPreviewUrl(id)} alt={t("terminal.chat.attachmentAlt", { index: String(index) })} onError={onLapsed} />
      </div>
    </div>,
    document.body,
  );
}

function ChatCommandRow({
  command,
  state,
  language,
}: {
  readonly command: NonNullable<AgentChatTurn["command"]>;
  readonly state: AgentChatTurn["state"];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const running = state === "working";
  const failed = state === "error";
  const compact = command.compact;
  // 되찾은 비율은 자식이 잰 두 수에서만 나온다. `after`가 없으면 비율도 없다 — 그때는 계기를
  // 세우지 않고 앞의 크기만 말한다.
  const reclaimed = compact?.after === undefined
    ? null
    : Math.max(0, Math.min(100, Math.round(((compact.before - compact.after) / Math.max(1, compact.before)) * 100)));
  const gauge = running || reclaimed !== null;
  const detail = running
    ? command.phase === "compacting"
      ? t("terminal.chat.commandCompacting")
      : t("terminal.chat.commandRunning")
    : compact
      ? compact.after === undefined
        ? t("terminal.chat.commandCompactedFrom", { before: formatCompactTokens(compact.before) })
        : t("terminal.chat.commandCompacted", {
          before: formatCompactTokens(compact.before),
          after: formatCompactTokens(compact.after),
          percent: String(reclaimed),
        })
      : command.summary ?? (failed ? t("terminal.chat.commandFailed") : t("terminal.chat.commandDone"));
  return (
    <p
      className={`agent-chat-command-row${running ? " is-running" : ""}${failed ? " is-failed" : ""}`}
      {...(running ? { role: "status" } : {})}
    >
      <span className="agent-chat-command-dot" aria-hidden="true" />
      <span className="agent-chat-command-name">/{command.name}</span>
      <span className="agent-chat-command-detail">{detail}</span>
      {gauge ? (
        <span
          className="agent-chat-command-gauge"
          role="progressbar"
          aria-label={t("terminal.chat.commandGaugeLabel")}
          // 도는 동안은 `aria-valuenow`를 싣지 않는다 — 없는 값을 실으면 보조기술이 그것을
          // 진척률로 읽어 주고, 그 낭독은 화면보다 더 확신에 차 있다.
          {...(reclaimed === null ? {} : { "aria-valuenow": reclaimed, "aria-valuemin": 0, "aria-valuemax": 100 })}
        >
          <span
            className="agent-chat-command-gauge-fill"
            style={reclaimed === null ? undefined : { "--agent-chat-gauge-fill": `${reclaimed}%` } as React.CSSProperties}
          />
        </span>
      ) : null}
      {compact?.durationMs !== undefined ? (
        <span className="agent-chat-command-elapsed">{(compact.durationMs / 1000).toFixed(1)}s</span>
      ) : null}
    </p>
  );
}

function ChatTurn({
  operationId,
  turn,
  nextContextBefore,
  language,
  timeFormat,
  streaming,
  jobsByToolUse,
  onOpenJob,
  onAnswer,
}: {
  readonly operationId: string;
  readonly turn: AgentChatTurn;
  /** 바로 다음 턴이 시작될 때의 문맥 총량. 이 턴이 더한 몫은 그것과의 차이다. */
  readonly nextContextBefore: number | undefined;
  readonly language: "en" | "ko";
  readonly timeFormat: Intl.DateTimeFormat;
  readonly streaming: boolean;
  readonly jobsByToolUse: ReadonlyMap<string, AgentChatJob>;
  readonly onOpenJob: (id: string) => void;
  readonly onAnswer: AgentChatViewState["answerAsk"];
}) {
  const t = getT(language);
  const view = splitAgentChatTurn(turn);
  const working = turn.state === "working";
  const continuityItem = useFastShellContinuity(turn);
  const holdingContinuity = continuityItem !== null;
  // 이 턴이 낳은 잡 중 아직 도는 것. 접힘 줄이 이 수를 말하지 않으면, 접힘이 "다 끝났다"를
  // 뜻하게 되고 그것이 이 표면을 만든 이유인 거짓말이다.
  const stillRunning = turn.items.reduce((count, item) => {
    const job = item.id !== undefined ? jobsByToolUse.get(item.id) : undefined;
    return count + (job?.open === true ? 1 : 0);
  }, 0);
  // 이 턴이 더한 몫은 **다음 턴이 시작될 때** 비로소 알 수 있다(자식은 턴 중에 답하지 않는다).
  // 그래서 마지막 턴에는 증가분이 서지 않고, 다음 지시를 보내면 그때 채워진다 — 어느 한쪽이
  // 없는데 값을 지어내면 "이 턴이 이만큼 먹었다"는 이 줄의 유일한 주장이 거짓이 된다.
  const contextGrew = turn.contextBefore !== undefined && nextContextBefore !== undefined
    ? nextContextBefore - turn.contextBefore
    : undefined;
  // 완료된 생각 흔적은 원장에 보이지 않으므로, 그것만 남은 턴에 빈 작업 접힘과 Answer 이음매를
  // 세우지 않는다. 라이브 "생각 중…"은 working 경로가 별도로 그린다.
  const hasSettledWork = !working && (view.ledger.some((item) => item.type !== "thought") || view.changes.length > 0);
  // 정비 명령은 대화가 아니다. 말풍선도 턴 노드도 경과 시계도 세우지 않는다 — 그 문법 전체가
  // "모델이 생각하고 있다"를 말하는데, 이 동작들은 세션 상태를 즉시 바꾸고 둘은 모델을 아예
  // 부르지 않는다. 한 줄이 지시와 진행과 결말을 함께 진다.
  if (turn.command) return <ChatCommandRow command={turn.command} state={turn.state} language={language} />;
  return (
    <>
      {turn.dispatch ? (
        <div className="agent-chat-dispatch">
          <div className="agent-chat-dispatch-meta">
            {/* "Quick Launch로 전달" 배지는 퇴역했다 — 패널 컴포저가 주 경로가 되면서 들어온 문이
                더는 특기 사항이 아니고, 경로를 가르는 origin 와이어는 배지 하나 값이 아니다. */}
            {turn.dispatch.by ? <span className="chat-by-agent">{chatOriginLabel(turn.dispatch.by)}</span> : null}
            {turn.dispatch.at !== undefined ? <span>{timeFormat.format(new Date(turn.dispatch.at))}</span> : null}
          </div>
          <div className={`agent-chat-dispatch-bubble${turn.dispatch.format === "markdown" ? " is-markdown" : ""}`}>
            {turn.dispatch.attachments && turn.dispatch.attachments.length > 0
              ? <ChatDispatchAttachments attachments={turn.dispatch.attachments} language={language} />
              : null}
            {/* 플러그인·Console Use 저자가 준 문면은 마크다운일 수 있다 — 자식에게 간 프롬프트와 별개인, 사람이 읽을 요약. */}
            {turn.dispatch.text
              ? turn.dispatch.format === "markdown"
                ? <StreamedMarkdown text={turn.dispatch.text} streaming={false} className="agent-chat-dispatch-md" language={language} />
                : <span className="agent-chat-dispatch-text">{turn.dispatch.text}</span>
              : null}
          </div>
        </div>
      ) : null}
      {turn.items.length > 0 || working || view.answer !== null ? (
        <div className={`agent-chat-turn is-${turn.state}`}>
          <div className="agent-chat-turn-body">
            {/* 모델·강도는 상단 세션 바가 이미 말한다 — 진행 중 헤드는 턴의 시간축만 맡는다.
                완료 턴에는 따로 두지 않는다: 접힘 줄이 같은 시간을 말하므로 두 줄이 겹친다. */}
            {working ? (
              <div className="agent-chat-turn-head">
                <TurnElapsedLabel turn={turn} language={language} />
              </div>
            ) : null}
            {working ? (
              <>
                <ChangeStrip changes={view.changes} language={language} />
                {/* 아무 스텝도 돌지 않고 글자도 흐르지 않는 구간이 실제로 길다(실측 34초) —
                    모델이 다음 도구 호출을 짓는 동안이다. 그 사이 원장이 비면 패널은 멈춘 것처럼
                    읽히므로, 라이브 줄의 꼬리가 "생각 중…"을 말한다(내용은 싣지 않는다). 별도의
                    행이나 상자가 아니다: 상자는 동사·대상·결과를 담는 그릇이고 생각에는 둘 다 없다. */}
                <Ledger
                  operationId={operationId}
                  items={view.ledger}
                  language={language}
                  jobsByToolUse={jobsByToolUse}
                  onOpenJob={onOpenJob}
                  onAnswer={onAnswer}
                  working
                  continuityItem={continuityItem}
                  pending={view.streamingText === null
                    && continuityItem === null
                    && !view.ledger.some((item) => item.state === "running")
                    // 답을 기다리는 동안에는 아무도 생각하지 않는다 — 카드 아래에서 링이 계속 돌면
                    // 화면이 두 사실을 동시에 말하고, 사용자는 자기 차례인지 알 수 없다.
                    && !view.awaiting}
                />
              </>
            ) : holdingContinuity ? (
              // 빠른 Shell이 턴과 함께 닫혀도 라이브 줄을 새 접힘으로 바꾸지 않는다. 같은 줄이 같은
              // 자리에서 완료로 변한 뒤 물러난다 — 명령과 Answer는 이미 도착했고, 늦추는 것은 이
              // 시각 개체 하나뿐이다.
              <Ledger
                operationId={operationId}
                items={view.ledger}
                language={language}
                jobsByToolUse={jobsByToolUse}
                onOpenJob={onOpenJob}
                onAnswer={onAnswer}
                continuityItem={continuityItem}
              />
            ) : hasSettledWork ? (
              <WorkFold
                durationMs={turn.durationMs}
                running={stillRunning}
                error={turn.state === "error"}
                stopped={turn.state === "stopped"}
                contextGrew={contextGrew}
                language={language}
                leadsToAnswer={view.answer !== null}
              >
                <ChangeStrip changes={view.changes} language={language} />
                <Ledger operationId={operationId} items={view.ledger} language={language} jobsByToolUse={jobsByToolUse} onOpenJob={onOpenJob} onAnswer={onAnswer} />
              </WorkFold>
            ) : null}
            {/* 중지된 턴에서 흐르던 글도 여기 선다 — Answer가 아니므로 그 이름표를 달지 않고,
                접힘에 넣지도 않는다. 방금 멈춘 사람이 가장 먼저 보려는 것이 그 글이다. */}
            {view.streamingText !== null ? (
              <StreamedMarkdown
                className="agent-chat-stream markdown-body"
                text={view.streamingText}
                streaming={working && streaming}
                language={language}
              />
            ) : null}
            {!working && view.answer !== null ? (
              <div className={`agent-chat-answer${hasSettledWork ? " has-seam" : ""}`}>
                {hasSettledWork
                  ? <span className="agent-chat-sr-only">{t("terminal.chat.answerLabel")}</span>
                  : <div className="agent-chat-answer-kicker">{t("terminal.chat.answerLabel")}</div>}
                <StreamedMarkdown
                  className="agent-chat-answer-body markdown-body"
                  text={view.answer}
                  streaming={false}
                  language={language}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 진행 중 턴 헤드의 라이브 티커 — 시각 전용이라 라이브 리전이 아니다(매초 재낭독 방지).
 *  집계 줄과 같은 명도 물결을 진다: 둘 다 "이 턴이 아직 살아 있다"를 말하므로 같은 어휘다. */
function TurnElapsedLabel({
  turn,
  language,
}: {
  readonly turn: AgentChatTurn;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const elapsedMs = useTurnElapsedMs(turn.startedAt, turn.state === "working");
  return (
    // 물결을 지지 않는다 — "이 턴이 아직 살아 있다"는 원장의 라이브 줄 하나가 말하고, 이 자리는
    // 시간축만 맡는다. 같은 사실을 두 자리가 동시에 말하면 은은함이 아니라 소음이다.
    <span className="agent-chat-turn-clock" aria-hidden="true">
      {t("terminal.chat.turnWorking", { elapsed: formatElapsed(elapsedMs) })}
    </span>
  );
}

/**
 * 이 턴이 건드린 파일 — 원장 맨 위에 선다. 도구의 나열보다 먼저 읽히는 것은 "무엇이 남았는가"다.
 * 줄 수는 쓰기 도구의 입력에서 서버가 접어 보낸 값이고, 파일 본문은 스트림에 실리지 않는다.
 */
function ChangeStrip({
  changes,
  language,
}: {
  readonly changes: readonly AgentChatChange[];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  if (changes.length === 0) return null;
  return (
    <div className="agent-chat-changes" aria-label={t("terminal.chat.changesAria")}>
      {changes.map((change) => (
        <span key={change.file} className="agent-chat-change">
          <span className="agent-chat-change-file">{change.file}</span>
          {change.added > 0 ? <span className="agent-chat-change-add">+{change.added}</span> : null}
          {change.removed > 0 ? <span className="agent-chat-change-del">−{change.removed}</span> : null}
        </span>
      ))}
    </div>
  );
}

/**
 * 라이브 원장 — 스텝과 문장이 도착한 순서 그대로 쌓인다. 진행 중인 스텝 하나만 링을 돌리고,
 * 끝난 스텝은 자리에 남아 결과를 단다. 여기서 사라지는 것은 없다.
 */
function Ledger({
  operationId,
  items,
  language,
  jobsByToolUse,
  onOpenJob,
  onAnswer,
  working = false,
  pending = false,
  continuityItem = null,
}: {
  readonly operationId: string;
  readonly items: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
  readonly jobsByToolUse: ReadonlyMap<string, AgentChatJob>;
  readonly onOpenJob: (id: string) => void;
  readonly onAnswer: AgentChatViewState["answerAsk"];
  /** 진행 중인 턴인가 — 마지막 구간을 열어 둘지, 전부 접을지를 가른다. */
  readonly working?: boolean;
  /** 라이브 줄의 꼬리에 "생각 중…"을 붙인다 — 도구도 글자도 없는 구간의 유일한 신호다. */
  readonly pending?: boolean;
  readonly continuityItem?: AgentChatTurnItem | null;
}) {
  const t = getT(language);
  const hasJob = React.useCallback(
    (item: AgentChatTurnItem) => item.id !== undefined && jobsByToolUse.has(item.id),
    [jobsByToolUse],
  );
  // continuityItem은 마지막 Shell 하나다. 앞서 끝난 작업은 그대로 남기고, 그 항목만 평소 집계에서
  // 빼 같은 자리에 전용 상태 행으로 세운다 — 원장 전체가 700ms 동안 사라지면 연속성이 아니다.
  const ledgerItems = continuityItem !== null ? items.slice(0, -1) : items;
  const segments = segmentAgentChatLedger(ledgerItems, hasJob);
  if (segments.length === 0 && !pending && continuityItem === null) return null;
  return (
    <div className={`agent-chat-ledger${continuityItem !== null ? " is-continuity" : ""}`}>
      {segments.map((segment, index) => {
        // 도는 턴의 마지막 구간만 라이브다 — 그 구간의 꼬리 한 줄이 "지금 무엇을 하는가"를 진다.
        const live = working && index === segments.length - 1;
        const hoisted = live ? runningTails(segment.parts) : new Set<AgentChatLedgerPart>();
        const tails = segment.parts.flatMap((part) => (hoisted.has(part) && part.kind === "step" ? [part.item] : []));
        const parts = hoisted.size > 0 ? segment.parts.filter((part) => !hoisted.has(part)) : segment.parts;
        // 꼬리를 떼고 남은 마지막 조각이 집계라면 그 집계가 곧 라이브 줄이고, 꼬리는 그 줄의
        // 끝에 붙는다. 집계가 아니면(잡 앵커·확인되지 않은 스텝, 또는 구간이 도구로 시작한 경우)
        // 아래에서 그 줄을 따로 세운다 — 어느 쪽이든 도는 스텝은 자기 행을 갖지 않는다.
        const liveTallyAt = live && parts.at(-1)?.kind === "tally" ? parts.length - 1 : -1;
        return (
          <div className="agent-chat-segment" key={index}>
            {segment.note !== undefined ? (
              <StreamedMarkdown
                className="agent-chat-ledger-note markdown-body"
                text={segment.note}
                streaming={false}
                language={language}
              />
            ) : null}
            {parts.map((part, at) => {
              if (part.kind === "tally") {
                return (
                  <Tally
                    key={at}
                    groups={part.groups}
                    folded={part.folded}
                    language={language}
                    jobsByToolUse={jobsByToolUse}
                    onOpenJob={onOpenJob}
                    {...(at === liveTallyAt ? { live: true, tails, thinking: pending } : {})}
                  />
                );
              }
              if (part.item.type === "inject") {
                return <InjectLine key={at} item={part.item} language={language} />;
              }
              return part.item.type === "ask" && part.item.ask
                ? <AskCard key={`ask-${part.item.ask.id}`} ask={part.item.ask} language={language} onAnswer={onAnswer} />
                : <Step key={at} item={part.item} language={language} live={live} />;
            })}
            {live && liveTallyAt < 0 && (tails.length > 0 || pending)
              ? <Tally groups={[]} folded={[]} language={language} live tails={tails} thinking={pending} />
              : null}
          </div>
        );
      })}
      {continuityItem !== null ? <ContinuityTally item={continuityItem} language={language} /> : null}
      {/* 첫 도구가 나가기 전의 첫 공백 — 세울 구간이 없으므로 빈 집계에 꼬리만 단다. */}
      {pending && segments.length === 0
        ? <Tally groups={[]} folded={[]} language={language} live tails={[]} thinking />
        : null}
    </div>
  );
}

/**
 * 도는 턴이 도중에 집어간 사용자의 말 한 줄.
 *
 * 턴을 여는 말풍선과 같은 모양을 쓰지 않는다 — 그 모양은 "여기서 턴이 시작했다"는 뜻이고,
 * 이 말은 이미 돌던 턴이 읽은 것이다. 원장 폭에 맞춰 서되 캡션 하나가 그 차이를 말한다.
 *
 * 색은 중립이다. 신호 채널(aurora·coral)은 상태를 말하는 자리이고, 사용자가 말을 보탠 것은
 * 상태가 아니다 — 그 자리를 빌리면 이 줄이 경보로 읽힌다.
 */
function InjectLine({
  item,
  language,
}: {
  readonly item: AgentChatTurnItem;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  return (
    <div className="agent-chat-turn-inject">
      <span className="agent-chat-turn-inject-caption">{t("terminal.chat.injectCaption")}</span>
      {item.format === "markdown"
        ? <StreamedMarkdown text={item.text ?? ""} streaming={false} className="agent-chat-turn-inject-body agent-chat-dispatch-md" language={language} />
        : <div className="agent-chat-turn-inject-body">{item.text ?? ""}</div>}
    </div>
  );
}

/**
 * 구간의 꼬리에서 라이브 줄로 걷어 올릴 진행 중 스텝 조각들.
 *
 * 하나만 걷으면 안 된다. 한 assistant 메시지가 tool_use 블록을 여럿 실으면(병렬 배치) 그
 * 스텝들은 다음 메시지가 결과를 실어 올 때까지 **동시에** running으로 남고, 걷히지 않은 것이
 * 그대로 전폭 행으로 선다 — 배치가 클수록 한 줄 원장이 무너진다.
 *
 * 잡 앵커에서 멈추지도 않는다. 같은 배치가 백그라운드 잡을 함께 낳으면 그 호출만 앵커가 되어
 * 도는 스텝 사이에 끼는데, 거기서 멈추면 앞의 스텝이 자기 행을 되찾는다. 앵커는 태어난 자리를
 * 지키는 물건이므로 걷지 않고 지나가기만 한다 — 그래서 반환은 위치가 아니라 조각의 집합이다.
 */
const FAST_SHELL_PERCEPTION_MS = 480;
const FAST_SHELL_COMPLETION_MS = 220;

/**
 * 빠른 Shell의 마지막 상태를 잠시 같은 자리에 붙든다. 서버 상태와 Answer는 그대로 앞서가고,
 * 여기서 늦추는 것은 live Tally 하나뿐이다. 시작·결과 시각이 없는 재생 턴이나 다른 도구에는
 * 개입하지 않아 과거 로그를 다시 열 때마다 애니메이션이 되살아나지 않는다.
 */
function useFastShellContinuity(turn: AgentChatTurn): AgentChatTurnItem | null {
  // 원장의 시간은 꼬리에서 앞으로 흐르지 않는다. 마지막 항목이 다른 활동이면 앞의 빠른 Shell을
  // 아래로 옮겨 다시 살리지 않는다 — 이음매는 오직 지금 화면에서 바뀌는 마지막 개체의 것이다.
  const tail = turn.items.at(-1);
  const candidate = tail?.type === "tool"
    && agentChatToolFamily(tail.name) === "run"
    && tail.startedAt !== undefined
    && (tail.state === "running" || (
      tail.settledAt !== undefined
      && tail.settledAt - tail.startedAt < FAST_SHELL_PERCEPTION_MS
    ))
    ? tail
    : undefined;
  const perceptionAt = candidate?.startedAt !== undefined ? candidate.startedAt + FAST_SHELL_PERCEPTION_MS : 0;
  const deadline = perceptionAt + FAST_SHELL_COMPLETION_MS;
  const [, rerender] = React.useState(0);
  const now = Date.now();
  React.useEffect(() => {
    if (candidate === undefined || candidate.state === "running" || now >= deadline) return;
    const next = now < perceptionAt ? perceptionAt : deadline;
    const timer = window.setTimeout(() => rerender((value) => value + 1), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [candidate?.id, candidate?.state, deadline, now < perceptionAt]);
  if (candidate === undefined) return null;
  if (candidate.state === "running") return candidate;
  if (now >= deadline) return null;
  // 결과가 먼저 돌아와도 480ms까지는 running 모습 그대로다. 그 뒤 같은 줄이 완료형으로 변한다.
  return now < perceptionAt ? { ...candidate, state: "running" } : candidate;
}

/** 같은 live Tally가 결과를 받은 뒤 완료형으로 변한 모습. 새 행이나 toast를 만들지 않는다. */
function ContinuityTally({
  item,
  language,
}: {
  readonly item: AgentChatTurnItem;
  readonly language: "en" | "ko";
}) {
  const running = item.state === "running";
  const failed = item.state === "fail";
  const elapsed = item.startedAt !== undefined && item.settledAt !== undefined
    ? formatDuration(Math.max(0, item.settledAt - item.startedAt))
    : null;
  const verb = running ? runningVerb(item.name ?? "", language) : pastVerb(item.name ?? "", language);
  return (
    <div className={`agent-chat-tally is-continuity is-${item.state ?? "done"}`} role="status" aria-atomic="true">
      {running
        ? <span className="agent-chat-step-orbit" aria-hidden="true" />
        : <span className="agent-chat-continuity-mark" aria-hidden="true">{failed ? "✕" : "✓"}</span>}
      <span className={`agent-chat-tally-text${running ? " agent-chat-live-text" : ""}`}>
        <span className="agent-chat-tally-clause">
          <span className="agent-chat-tally-glyph" aria-hidden="true"><AgentGlyph name="run" /></span>
          <span>{`${verb}${item.detail ? ` ${item.detail}` : ""}`}</span>
        </span>
      </span>
      {!running && elapsed !== null ? <span className="agent-chat-continuity-elapsed">{elapsed}</span> : null}
    </div>
  );
}

function runningTails(parts: readonly AgentChatLedgerPart[]): ReadonlySet<AgentChatLedgerPart> {
  const hoisted = new Set<AgentChatLedgerPart>();
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    const part = parts[at];
    if (part === undefined) break;
    if (part.kind !== "step") break;
    if (part.item.type === "ask" || part.item.state !== "running") break;
    hoisted.add(part);
  }
  return hoisted;
}

/**
 * 끝난 스텝의 한 줄 집계 — "파일 2개 읽음 · 셸 1회 실행". 도구를 하나하나 세우면 긴 턴이
 * 읽히지 않으므로 결과가 온 스텝은 여기로 접히고, 예외(진행 중·확인되지 않음)만 자기 줄을 지킨다.
 *
 * 접힌 것은 감춘 것이 아니라 접은 것이다 — 줄 자체가 열쇠다. 누르면 그 집계가 세고 있던 스텝이
 * 순서대로 펼쳐진다. 그래서 이 줄은 눌린다는 사실을 스스로 말해야 한다: 꺾쇠 하나와 hover에서
 * 밝아지는 잉크.
 */
function Tally({
  groups,
  folded,
  language,
  jobsByToolUse,
  onOpenJob,
  live = false,
  tails = [],
  thinking = false,
}: {
  readonly groups: readonly AgentChatStepGroup[];
  readonly folded: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
  /** 접힌 것 중 잡을 낳은 호출을 되찾는 표. 없으면 잡 절은 수만 말하고 펼침은 스텝만 세운다. */
  readonly jobsByToolUse?: ReadonlyMap<string, AgentChatJob>;
  readonly onOpenJob?: (id: string) => void;
  /** 도는 턴의 꼬리 집계인가 — 링과 물결을 얻고, 펼침 안에 진행 중 스텝까지 함께 든다. */
  readonly live?: boolean;
  /** 지금 도는 스텝들. 이 줄의 꼬리로 붙어 "무엇을 하는 중인지"를 말한다(병렬 배치는 여럿이다). */
  readonly tails?: readonly AgentChatTurnItem[];
  /** 도는 것이 없는 공백 — 꼬리가 "생각 중…"을 말한다. 링과 물결은 이때도 산다. */
  readonly thinking?: boolean;
}) {
  const t = getT(language);
  // 셀 것도 도는 것도 없으면 줄이 아니다. 도는 것만 있는 구간(도구로 시작한 구간)에서는 집계가
  // 비어도 이 줄이 서야 한다 — 그러지 않으면 그 스텝들이 다시 자기 행을 갖는다. 생각 중인
  // 공백도 같다: 셀 것이 없어도 살아 있다는 한 줄은 서야 한다.
  const alive = live && (tails.length > 0 || thinking);
  if (groups.length === 0 && tails.length === 0 && !alive) return null;
  // 이 집계가 삼킨 잡들. 절은 수만 말하지만 그 수 안의 **예외**는 절이 함께 말해야 한다 —
  // 도는 잡과 실패한 잡을 "작업 4건"에 섞어 넣으면, 접기로 줄인 소음이 감춘 사실이 된다.
  const foldedJobs = jobsByToolUse === undefined
    ? []
    : folded.flatMap((item) => {
      const job = item.id !== undefined ? jobsByToolUse.get(item.id) : undefined;
      return job !== undefined ? [job] : [];
    });
  const jobsRunning = foldedJobs.filter((job) => job.open).length;
  const jobsFailed = foldedJobs.filter((job) => !job.open && job.status === "failed").length;
  const clauses = groups.map((group, index) => (
    <React.Fragment key={`${group.family}-${group.name ?? ""}`}>
      {index > 0 ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span> : null}
      <span className={`agent-chat-tally-clause${group.family === AGENT_CHAT_JOB_FAMILY ? " is-jobs" : ""}`}>
        {/* 잡 절은 도구 계열이 아니라 "배경으로 넘긴 일"이므로 계열 알파벳에 자기 글자가 없다.
            위임 글자를 빌린다 — 원장의 위임 절과 작업 면의 위임 카드가 이미 쓰는 그 글자이고,
            잡 절이 말하는 것도 같은 몸짓이다(여기서 넘겼고, 저기서 돈다). */}
        <span className="agent-chat-tally-glyph" aria-hidden="true">
          <AgentGlyph name={group.family === AGENT_CHAT_JOB_FAMILY ? "delegate" : group.family} />
        </span>
        {/* 알려진 계열은 문구 하나로 끝나지만, 어떤 계열은 주어를 따로 진다 — `other`는 도구
            이름이, `mcp`는 서버가 그 주어다. 주어를 가진 절은 그것을 그려야 한다: 문구만 남기면
            "2회"처럼 무엇을 두 번 했는지가 사라진다. 이름은 한 단 밝은 잉크를 쓴다 — 접히지 않은
            스텝 줄의 동사가 이미 그 잉크를 쓰므로, 이것은 두 줄을 같은 문법으로 되돌리는 것이다. */}
        {group.name !== undefined
          ? <span className="agent-chat-tally-name">{group.name}</span>
          : null}
        <span>{groupLabel(group, t)}</span>
        {/* 예외만 덧붙는다. 전부 완료한 절은 수 하나로 끝나는 것이 이 접기의 요점이다. */}
        {group.family === AGENT_CHAT_JOB_FAMILY && jobsRunning > 0 ? (
          <span className="agent-chat-tally-jobs-open">{t("terminal.chat.groupJobRunning", { count: jobsRunning })}</span>
        ) : null}
        {group.family === AGENT_CHAT_JOB_FAMILY && jobsFailed > 0 ? (
          <span className="agent-chat-tally-jobs-fail">{t("terminal.chat.groupJobFailed", { count: jobsFailed })}</span>
        ) : null}
      </span>
    </React.Fragment>
  ));
  // 라이브 줄은 자기가 살아 있다고 스스로 말해야 한다. 예전에는 최근 여덟 줄이 흘러가는 것
  // 자체가 그 증거였는데, 그 증거가 읽는 자리의 절반을 먹었다 — 이제 링과 좌→우 물결, 그리고
  // 지금 도는 도구의 이름 하나가 같은 말을 한 줄로 한다.
  // 도는 스텝은 전부 이 줄의 꼬리가 된다 — 병렬 배치의 N개도 행이 아니라 절이다.
  // 살아 있는 줄은 턴에 하나뿐이다. 링과 물결은 꼬리가 실제로 무엇인가를 말할 때만 산다 —
  // 도는 도구든 생각이든. 글자가 흐르는 동안은 꼬리가 비고, 그때 생명은 글 끝의 캐럿이 진다.
  // 예전에는 도는 턴의 마지막 구간이라는 이유만으로 링이 돌아, 아무것도 안 도는 줄 아래에
  // 생각 상자가 링을 하나 더 달고 섰다(실측: 링 2개, 애니메이션 6개가 동시에).
  const running = live ? tails : [];
  const body = [...folded, ...running];
  const line = (
    <>
      {alive ? <span className="agent-chat-step-orbit" aria-hidden="true" /> : null}
      <span className={alive ? "agent-chat-tally-text agent-chat-live-text" : "agent-chat-tally-text"}>
        {clauses}
        {alive ? (
          // 라이브 리전은 이 묶음 하나다 — 절마다 걸면 배치 하나가 N번 낭독된다.
          <span className="agent-chat-tally-running" role="status">
            {running.map((item, index) => (
              <React.Fragment key={index}>
                {index > 0 || clauses.length > 0
                  ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span>
                  : null}
                <span className="agent-chat-tally-clause">
                  <span className="agent-chat-tally-glyph" aria-hidden="true"><AgentGlyph name={agentChatToolFamily(item.name)} /></span>
                  <span>{`${runningVerb(item.name ?? "", language)}${item.detail !== undefined && item.detail.length > 0 ? ` ${item.detail}` : ""}`}</span>
                </span>
              </React.Fragment>
            ))}
            {thinking && running.length === 0 ? (
              <>
                {clauses.length > 0 ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span> : null}
                <span className="agent-chat-tally-clause">
                  <span className="agent-chat-tally-glyph" aria-hidden="true"><AgentGlyph name={AGENT_CHAT_THINK_FAMILY} /></span>
                  <span className="agent-chat-thinking-label">
                    <span>{t("terminal.chat.stepThinking")}</span>
                    <span className="agent-chat-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
                  </span>
                </span>
              </>
            ) : null}
          </span>
        ) : null}
      </span>
    </>
  );
  // 펼칠 것이 없으면 눌리는 척하지 않는다 — 열쇠 없는 자물쇠는 어포던스가 아니라 거짓말이다.
  if (body.length === 0) return <div className={`agent-chat-tally${alive ? " is-live" : ""}`}>{line}</div>;
  return (
    <details className="agent-chat-tally-fold">
      <summary className={`agent-chat-tally${alive ? " is-live" : ""}`} aria-label={t("terminal.chat.tallyAria")}>
        {line}
        <span className="agent-chat-tally-chev" aria-hidden="true">⌄</span>
      </summary>
      {/* 펼침은 줄기 하나다. 예전에는 스텝마다 자기 테두리와 면을 든 상자가 섰고, 여덟 개가
          이어지면 원장 안에서 가장 시끄러운 덩어리가 됐다(실측 33px/행). 지금은 헤어라인 한 겹이
          위에서 아래로 흐르고 잎마다 짧은 가지가 붙는다 — 계열은 가지로 가르지 않는다: 그렇게 하면
          "무엇 다음에 무엇"이 사라지고, 도구 호출을 되짚는 사람이 묻는 것의 절반이 그 순서다.
          계열은 잎이 자기 글자로 말한다. */}
      <div className="agent-chat-tally-body">
        {body.map((item, index) => {
          const job = item.id !== undefined ? jobsByToolUse?.get(item.id) : undefined;
          // 잡을 낳은 호출은 잎 자리에서도 스텝이 아니라 문이다 — 절이 삼킨 그 잡으로 가는 길은
          // 이 펼침 안에만 남아 있다.
          return job !== undefined && onOpenJob !== undefined
            ? <JobAnchor key={index} job={job} language={language} onOpenJob={onOpenJob} />
            : <Step key={index} item={item} language={language} folded />;
        })}
      </div>
    </details>
  );
}

/**
 * 집계를 펼쳤을 때 잡이 서는 한 줄 — 그 잡으로 가는 문.
 *
 * 예전에는 여기에 카드가 섰고, 그 뒤로는 원장 본문에 앵커 한 줄이 섰다. 지금은 그 줄이 집계
 * 절로 접히고 이 문은 펼침 안에 산다: 결말 칩의 목록이 되던 꼬리가 절 하나로 줄고, 특정 잡을
 * 찾는 사람은 한 번 더 펼친다. 몸은 여전히 작업 면의 것이다.
 */
function JobAnchor({
  job,
  language,
  onOpenJob,
}: {
  readonly job: AgentChatJob;
  readonly language: "en" | "ko";
  readonly onOpenJob: (id: string) => void;
}) {
  const t = getT(language);
  return (
    <button
      type="button"
      className={`agent-chat-job-anchor ${jobStateClass(job)}`}
      aria-label={t("terminal.chat.workOpenAria")}
      onClick={() => onOpenJob(job.id)}
    >
      {job.open
        ? <span className="agent-chat-step-orbit" aria-hidden="true" />
        : <span className="agent-chat-job-mark" aria-hidden="true">{job.status === "failed" ? "✕" : job.status === "completed" ? "✓" : "·"}</span>}
      <span className="agent-chat-job-glyph" aria-hidden="true"><JobGlyph kind={job.kind} /></span>
      {/* 카드가 제목 자리에 쓰던 값 그대로다. subagent_type(`who`)만 남기면 위임 여러 건이
          "general-purpose"로 똑같아져, 어느 것이 무엇인지 열어 봐야만 알 수 있다 —
          `who`는 카드에서도 제목이 아니라 메타 줄의 값이었고, 그 줄은 작업 면이 진다. */}
      <span className="agent-chat-job-title">{job.title}</span>
      <span className="agent-chat-job-outcome">{jobOutcome(job, language)}</span>
      <span className="agent-chat-job-chev" aria-hidden="true">›</span>
    </button>
  );
}

/** 도는 것이 없을 때 스트립·머리가 다는 라벨. 복수형은 관례대로 호출부가 고른다. */
function settledLabel(count: number, t: ReturnType<typeof getT>): string {
  return count === 1
    ? t("terminal.chat.stripSettled_one", { count })
    : t("terminal.chat.stripSettled_other", { count });
}

/** 복수형은 이 저장소 관례대로 호출부가 고른다(`_one`/`_other`). */
function groupLabel(group: AgentChatStepGroup, t: ReturnType<typeof getT>): string {
  const plural = group.count === 1 ? "one" : "other";
  const key = `terminal.chat.group.${group.family}_${plural}` as Parameters<typeof t>[0];
  return t(key, { count: group.count, ...(group.name !== undefined ? { name: group.name } : {}) });
}

/**
 * 모델이 멈춰 서서 물은 자리.
 *
 * 이 카드의 입력은 대화 입력창이 아니다 — 새 턴을 만들지 않고, 지금 이 질문에만 살며, 답하면
 * 사라진다. 지시를 보내는 경로는 그대로 Quick Launch 하나다.
 *
 * 대기에는 만료가 없다(제품 결정). 그래서 나가는 문이 언제나 하나 있어야 한다: 질문에는
 * "답하지 않기", 계획에는 "수정 요청". 후자는 되돌림이 아니라 되묻기라, 모델이 계획을 고쳐 다시 낸다.
 */
function AskCard({
  ask,
  language,
  onAnswer,
}: {
  readonly ask: AgentChatAsk;
  readonly language: "en" | "ko";
  readonly onAnswer: AgentChatViewState["answerAsk"];
}) {
  const t = getT(language);
  const [picks, setPicks] = React.useState<readonly (readonly string[])[]>(() => ask.questions.map(() => []));
  const [free, setFree] = React.useState<readonly string[]>(() => ask.questions.map(() => ""));
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  if (ask.outcome !== undefined) return <AskSettled ask={ask} language={language} />;

  const send = async (body: Parameters<AgentChatViewState["answerAsk"]>[0]): Promise<void> => {
    setPending(true);
    setFailed(false);
    try {
      await onAnswer(body);
    } catch {
      // 카드는 자리에 남는다 — 실패로 카드를 걷으면 대기는 계속되는데 답할 방법이 사라진다.
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  if (ask.form === "plan") {
    return (
      <div className="agent-chat-ask is-plan">
        <div className="agent-chat-ask-head">
          <span className="agent-chat-ask-badge">
            <span className="agent-chat-ask-dot" aria-hidden="true" />
            {t("terminal.chat.ask.planBadge")}
          </span>
        </div>
        <StreamedMarkdown
          className="agent-chat-ask-plan markdown-body"
          text={ask.plan ?? ""}
          streaming={false}
          language={language}
        />
        <div className="agent-chat-ask-free">
          <input
            className="agent-chat-ask-input"
            type="text"
            value={note}
            disabled={pending}
            placeholder={t("terminal.chat.ask.revisePlaceholder")}
            aria-label={t("terminal.chat.ask.reviseAria")}
            onChange={(event) => { setNote(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || note.trim().length === 0) return;
              event.preventDefault();
              void send({ askId: ask.id, message: note.trim() });
            }}
          />
          <button
            type="button"
            className="agent-chat-ask-send is-quiet"
            disabled={pending || note.trim().length === 0}
            onClick={() => { void send({ askId: ask.id, message: note.trim() }); }}
          >
            {t("terminal.chat.ask.revise")}
          </button>
        </div>
        <div className="agent-chat-ask-foot">
          {/* 승인은 "본 것에 동의한다"는 뜻이다. 계획이 잘려 보여 주지 못한 단계가 있으면 그 문을
              열지 않는다 — 앞부분만 보고 누른 승인이 전문을 통과시키기 때문이다. 대신 수정 요청은
              열려 있어, 더 짧은 계획을 받아 볼 수 있다. */}
          <button
            type="button"
            className="agent-chat-ask-send"
            disabled={pending || ask.truncated === true}
            onClick={() => { void send({ askId: ask.id, approve: true }); }}
          >
            {t("terminal.chat.ask.approve")}
          </button>
          <span className="agent-chat-ask-hint">
            {ask.truncated === true ? t("terminal.chat.ask.planTruncated") : t("terminal.chat.ask.approveHint")}
          </span>
        </div>
        {failed ? <div className="agent-chat-ask-error">{t("terminal.chat.ask.failed")}</div> : null}
      </div>
    );
  }

  const values = ask.questions.map((question, index) => {
    const typed = (free[index] ?? "").trim();
    if (typed.length > 0) return typed;
    return (picks[index] ?? []).join(", ");
  });
  const complete = values.every((value) => value.length > 0);
  // 다중 선택은 값이 생긴 뒤에도 더 고를 수 있어야 하므로 자동 전송에서 뺀다.
  const autoSend = !ask.questions.some((question) => question.multiSelect);

  const submit = (next: readonly string[]): void => {
    void send({ askId: ask.id, answers: [...next] });
  };

  const choose = (index: number, label: string, multi: boolean): void => {
    const current = picks[index] ?? [];
    const nextPicks = picks.map((entry, at) => {
      if (at !== index) return entry;
      if (!multi) return [label];
      return current.includes(label) ? current.filter((value) => value !== label) : [...current, label];
    });
    setPicks(nextPicks);
    if (!autoSend) return;
    const nextValues = ask.questions.map((question, at) => {
      const typed = (free[at] ?? "").trim();
      if (typed.length > 0) return typed;
      return (nextPicks[at] ?? []).join(", ");
    });
    if (nextValues.every((value) => value.length > 0)) submit(nextValues);
  };

  return (
    <div className="agent-chat-ask">
      {ask.questions.map((question, index) => (
        <AskQuestion
          key={index}
          question={question}
          index={index}
          total={ask.questions.length}
          picks={picks[index] ?? []}
          free={free[index] ?? ""}
          disabled={pending}
          language={language}
          onChoose={(label) => { choose(index, label, question.multiSelect); }}
          onType={(value) => { setFree(free.map((entry, at) => (at === index ? value : entry))); }}
        />
      ))}
      <div className="agent-chat-ask-foot">
        <button
          type="button"
          className="agent-chat-ask-mini"
          disabled={pending}
          onClick={() => { void send({ askId: ask.id }); }}
        >
          {t("terminal.chat.ask.dismiss")}
        </button>
        {!autoSend || values.some((value, index) => (free[index] ?? "").trim().length > 0) ? (
          <button
            type="button"
            className="agent-chat-ask-send"
            disabled={pending || !complete}
            onClick={() => { submit(values); }}
          >
            {t("terminal.chat.ask.send")}
          </button>
        ) : null}
        <span className="agent-chat-ask-hint">{t("terminal.chat.ask.hint")}</span>
      </div>
      {failed ? <div className="agent-chat-ask-error">{t("terminal.chat.ask.failed")}</div> : null}
    </div>
  );
}

function AskQuestion({
  question,
  index,
  total,
  picks,
  free,
  disabled,
  language,
  onChoose,
  onType,
}: {
  readonly question: AgentChatQuestion;
  readonly index: number;
  readonly total: number;
  readonly picks: readonly string[];
  readonly free: string;
  readonly disabled: boolean;
  readonly language: "en" | "ko";
  readonly onChoose: (label: string) => void;
  readonly onType: (value: string) => void;
}) {
  const t = getT(language);
  return (
    <div className="agent-chat-ask-question">
      <div className="agent-chat-ask-head">
        <span className="agent-chat-ask-badge">
          <span className="agent-chat-ask-dot" aria-hidden="true" />
          {question.header}
        </span>
        {total > 1 ? (
          <span className="agent-chat-ask-counter">{t("terminal.chat.ask.counter", { index: index + 1, total })}</span>
        ) : null}
      </div>
      <p className="agent-chat-ask-text">{question.question}</p>
      <div className="agent-chat-ask-options">
        {question.options.map((option) => {
          const chosen = picks.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              className="agent-chat-ask-option"
              disabled={disabled}
              // 단일 선택도 고른 상태를 말해야 한다. 질문이 둘 이상이면 전부 채워야 전송되므로,
              // 그 사이 고른 답이 화면에도 스크린 리더에도 남지 않으면 무엇을 골랐는지 잃는다.
              aria-pressed={chosen}
              onClick={() => { onChoose(option.label); }}
            >
              <span className="agent-chat-ask-option-label">{option.label}</span>
              {option.description ? <span className="agent-chat-ask-option-desc">{option.description}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="agent-chat-ask-free">
        <input
          className="agent-chat-ask-input"
          type="text"
          value={free}
          disabled={disabled}
          placeholder={t("terminal.chat.ask.freePlaceholder")}
          aria-label={t("terminal.chat.ask.freeAria")}
          onChange={(event) => { onType(event.target.value); }}
        />
      </div>
    </div>
  );
}

/** 답한 뒤의 한 줄 — 스텝 문법에 합류한다. 무엇으로 갈렸는지가 이 턴의 증거로 남는다. */
function AskSettled({
  ask,
  language,
}: {
  readonly ask: AgentChatAsk;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const settled = ask.outcome === "answered" || ask.outcome === "approved";
  const rows = ask.answers && ask.answers.length > 0
    ? ask.answers
    : [{
      header: ask.form === "plan" ? t("terminal.chat.ask.planBadge") : t("terminal.chat.ask.questionBadge"),
      value: t(`terminal.chat.ask.outcome.${ask.outcome ?? "dismissed"}` as Parameters<typeof t>[0]),
    }];
  return (
    <>
      {rows.map((row, index) => (
        <div key={index} className={`agent-chat-ask-settled${settled ? "" : " is-open"}`}>
          <span className="agent-chat-ask-settled-mark" aria-hidden="true">{settled ? "✓" : "✕"}</span>
          <span className="agent-chat-ask-settled-head">{row.header}</span>
          <span aria-hidden="true">→</span>
          <span className="agent-chat-ask-settled-value">{row.value}</span>
          {ask.by ? <span className="chat-by-agent">{chatOriginLabel(ask.by)}</span> : null}
        </div>
      ))}
    </>
  );
}

/** 스텝 한 줄 — 동사·좌표·결과. 진행 중인 줄만 라이브 리전으로 읽힌다. */
function Step({
  item,
  language,
  live = false,
  folded = false,
}: {
  readonly item: AgentChatTurnItem;
  readonly language: "en" | "ko";
  /** 도는 턴의 꼬리에 홀로 선 줄인가 — 집계가 없는 구간에서는 이 줄이 라이브 줄을 진다. */
  readonly live?: boolean;
  /**
   * 집계를 펼친 줄기 위의 잎인가. 잎은 상자를 벗고 계열 글자를 하나 더 든다 — 줄기가 계열로
   * 갈리지 않으므로(시간순을 지키려고) 무슨 계열인지는 잎 자신이 말해야 한다. 원장 본문에
   * 홀로 서는 스텝은 예외라 상자를 그대로 두고, 그 상자가 곧 "이건 접히지 않았다"는 표시다.
   */
  readonly folded?: boolean;
}) {
  const t = getT(language);
  const running = item.state === "running";
  const failed = item.state === "fail";
  // 결과를 못 받고 닫힌 스텝은 성공도 실패도 아니다 — 시제도 체크 표시도 붙이지 않는다.
  // 과거형 동사와 ✓, 그리고 입력에서 뽑은 +N은 셋 다 "그 일이 일어났다"는 주장이고,
  // 우리가 아는 것은 호출이 나갔다는 사실뿐이다.
  const unconfirmed = item.state === "done";
  const name = item.name ?? "";
  // 확인되지 않은 스텝은 시제를 얻지 못하므로 이름이 곧 동사 자리다 — 그 이름도 줄에 세우는
  // 표시형(MCP는 서버 접두를 벗은 도구 이름)을 쓴다.
  const verb = running ? runningVerb(name, language) : unconfirmed ? agentChatToolLabel(name) : pastVerb(name, language);
  // 결과 칩은 변경 장부가 있으면 줄 수를, 없으면 도구가 돌려준 한 줄 요약을 보인다.
  // 실패는 언제나 요약이 이긴다 — 무엇이 잘못됐는지가 얼마나 썼는지보다 먼저다.
  const outcome = failed
    ? item.result ?? t("terminal.chat.stepFailed")
    : unconfirmed
      ? t("terminal.chat.stepUnconfirmed")
      : item.change && (item.change.added > 0 || item.change.removed > 0)
        ? formatChange(item.change)
        : item.result ?? null;
  return (
    <div className={`agent-chat-step is-${item.state ?? "done"}${folded ? " is-leaf" : ""}`}>
      {running
        // 상세 본문은 기록이다 — 라이브 상태와 애니메이션은 요약 줄 하나가 지고, 펼친 본문은
        // 지금 하는 도구의 G2 글리프만 정적으로 보여 준다. 닫힌 details 안에서 링을 계속 돌리면
        // 화면에는 안 보여도 브라우저가 영원히 애니메이션을 합성한다.
        ? <span className="agent-chat-step-mark is-running" aria-hidden="true"><AgentGlyph name={agentChatToolFamily(name)} /></span>
        : <span className="agent-chat-step-mark" aria-hidden="true">{failed ? "✕" : unconfirmed ? "·" : "✓"}</span>}
      {/* 잎의 계열 글자. 도는 줄은 이미 마크 자리에 같은 글자를 들고 있으므로 두 번 세우지 않는다. */}
      {folded && !running ? (
        <span className="agent-chat-step-family" aria-hidden="true"><AgentGlyph name={agentChatToolFamily(name)} /></span>
      ) : null}
      <span
        className={`agent-chat-step-verb${live && running ? " agent-chat-live-text" : ""}`}
        {...(running ? { role: "status" } : {})}
      >
        {verb}
      </span>
      {item.detail ? <span className="agent-chat-step-object">{item.detail}</span> : null}
      {item.outside ? (
        <span className="agent-chat-step-outside" title={t("terminal.chat.outsideTheaterTitle")}>
          {t("terminal.chat.outsideTheater")}
        </span>
      ) : null}
      {outcome ? (
        <span className={`agent-chat-step-out${failed ? " is-error" : ""}${unconfirmed ? " is-unknown" : ""}`}>
          {outcome}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 끝난 턴의 과정 접힘 — 요약 줄이 곧 턴의 소요 시간이고, 펼치기 아이콘은 문구 오른쪽에 선다.
 * 스텝 수는 세지 않는다: 몇 번 도구를 불렀는지는 접어 둔 사람이 궁금해할 값이 아니다.
 * 실패한 스텝 수도 세지 않는다 — 도중에 넘어졌어도 턴이 끝까지 걸어왔다면 그 넘어짐은 결말이
 * 아니라 과정이고, 과정은 펼침 안에 산다(스텝마다 ✕와 실패 사유가 그대로 선다). 요약이 말하는
 * 것은 **턴의 결말**뿐이다: 끝내 실패했거나(턴 실패), 사용자가 끊었거나(중지됨), 아직 도는 잡.
 */
function WorkFold({
  durationMs,
  running,
  error,
  stopped,
  contextGrew,
  language,
  leadsToAnswer,
  children,
}: {
  readonly durationMs: number | undefined;
  /** 이 턴이 낳은 잡 중 아직 도는 것의 수. 접힘이 이것을 삼키면 접힘이 곧 거짓말이 된다. */
  readonly running: number;
  /** 턴 자체가 실패로 닫혔는가. 스텝 하나가 넘어진 것과 다르다 — 이쪽은 결말이다. */
  readonly error: boolean;
  /** 사용자가 끊은 턴. 실패와 같은 잉크를 쓰지 않는다 — 고칠 것이 없는 결말이다. */
  readonly stopped: boolean;
  /** 이 턴이 문맥 창에 더한 토큰. 앞 턴의 좌표가 없으면 undefined이고, 그때는 서지 않는다. */
  readonly contextGrew: number | undefined;
  readonly language: "en" | "ko";
  /** 확정 응답이 바로 뒤에 서는가 — 그때만 접힘과 Answer를 한 완료 경계로 잇는다. */
  readonly leadsToAnswer: boolean;
  readonly children: React.ReactNode;
}) {
  const t = getT(language);
  const label = durationMs !== undefined
    ? t("terminal.chat.workedFor", { duration: formatDuration(durationMs) })
    : t("terminal.chat.workedLabel");
  return (
    <details className={`agent-chat-fold${leadsToAnswer ? " leads-to-answer" : ""}`} {...(running > 0 ? { open: true } : {})}>
      <summary>
        {leadsToAnswer ? (
          <span className={`agent-chat-completion-node${running > 0 ? " is-running" : error ? " is-error" : stopped ? " is-stopped" : ""}`} aria-hidden="true" />
        ) : null}
        <span className="agent-chat-fold-label">{label}</span>
        {running > 0 ? <span className="agent-chat-fold-running">{t("terminal.chat.foldRunning", { count: running })}</span> : null}
        {stopped ? <span className="agent-chat-fold-stopped">{t("terminal.chat.foldTurnStopped")}</span> : null}
        {error ? <span className="agent-chat-fold-failed">{t("terminal.chat.foldTurnFailed")}</span> : null}
        {/* 이 턴이 문맥에 더한 몫. 총량은 위 칩이 말하고, 이 줄은 그 총량이 어디서 왔는지만 말한다.
            줄어든 턴(압축이 끼어든 경우)도 그대로 부호를 지고 선다 — 압축은 사건이지 오류가 아니다. */}
        {contextGrew !== undefined && contextGrew !== 0 ? (
          <span className="agent-chat-fold-context">
            {contextGrew > 0 ? "+" : "−"}{formatTokens(Math.abs(contextGrew))}
          </span>
        ) : null}
        <span className="agent-chat-fold-chev" aria-hidden="true">⌄</span>
        {leadsToAnswer ? (
          <>
            <span className="agent-chat-completion-rule" aria-hidden="true" />
            <span className="agent-chat-completion-answer" aria-hidden="true">{t("terminal.chat.answerLabel")}</span>
          </>
        ) : null}
      </summary>
      <div className="agent-chat-fold-body">{children}</div>
      {leadsToAnswer ? (
        <div className="agent-chat-completion-handoff" aria-hidden="true">
          <span className="agent-chat-completion-rule" />
          <span className="agent-chat-completion-answer">{t("terminal.chat.answerLabel")}</span>
        </div>
      ) : null}
    </details>
  );
}

// ── 백그라운드 잡 표면 ────────────────────────────────────────────────────────

/**
 * 종류는 상태가 아니다 — 글리프와 모노 라벨이 가르고, 색은 쓰지 않는다. 신호 토큰은 상태만
 * 나르고 식별 색조는 마크로만 칠한다는 Console 채널 규칙이 여기서도 그대로 선다.
 * 글리프는 원장의 계열 알파벳과 같은 글자다 — 위임 잡은 위임 절과, 셸 잡은 셸 절과 같은 표식을 쓴다.
 */
/**
 * 시트를 접는 ×. 공유 AgentGlyph 표에는 닫기가 없고, 이 한 자리를 위해 그 표를 늘리면 도구
 * 계열 어휘에 창 컨트롤이 섞인다 — 획은 여기서 진다.
 */
function CloseGlyph() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function JobGlyph({ kind }: { readonly kind: AgentChatJobKind }) {
  return <AgentGlyph name={kind === "agent" ? "delegate" : kind === "shell" ? "run" : kind === "workflow" ? "workflow" : "other"} />;
}

function jobKindLabel(kind: AgentChatJobKind, language: "en" | "ko"): string {
  return getT(language)(`terminal.chat.jobKind.${kind}` as Parameters<ReturnType<typeof getT>>[0]);
}

/**
 * 결말 한 줄. 열려 있으면 실행 중, 닫혔는데 결말 보고가 없으면 **미상**이다 — 그 자리에
 * 완료를 적는 것이 이 표면 전체가 고치려는 거짓말이다.
 */
function jobOutcome(job: AgentChatJob, language: "en" | "ko"): string {
  const t = getT(language);
  if (job.open) return t("terminal.chat.jobOpen");
  if (job.status === "completed") return t("terminal.chat.jobCompleted");
  if (job.status === "failed") return t("terminal.chat.jobFailed");
  if (job.status === "stopped") return t("terminal.chat.jobStopped");
  return t("terminal.chat.jobUnknown");
}

function jobStateClass(job: AgentChatJob): string {
  if (job.open) return "is-open";
  if (job.status === "completed") return "is-done";
  if (job.status === "failed") return "is-fail";
  if (job.status === "stopped") return "is-stopped";
  return "is-unknown";
}

function jobMetaParts(job: AgentChatJob, language: "en" | "ko"): readonly string[] {
  const t = getT(language);
  const parts: string[] = [jobKindLabel(job.kind, language)];
  if (job.who !== undefined) parts.push(job.who);
  if (job.tokens !== undefined && job.tokens > 0) parts.push(t("terminal.chat.jobTokens", { count: formatCount(job.tokens) }));
  if (job.tools !== undefined && job.tools > 0) parts.push(t("terminal.chat.jobTools", { count: job.tools }));
  if (job.durationMs !== undefined && job.durationMs > 0) parts.push(formatDuration(job.durationMs));
  return parts;
}

/**
 * 작업 면의 잡 한 줄. 누르면 그 잡의 상세로 간다.
 *
 * 예전에는 카드였다 — 테두리를 두르고 제목 줄과 메타 줄을 따로 든 57px짜리 상자였고, 열일곱
 * 건이면 목록이 1,097px이라 62%짜리 시트에 여덟 건이 채 서지 못했다(실측). 카드의 둘째 줄이
 * 들던 값(종류·누구·토큰·도구·소요)은 이 줄의 꼬리로 옮겨 오른쪽에 정렬된다: 같은 사실이
 * 한 줄에 들어가고, 테두리 열일곱 겹이 헤어라인 한 겹으로 준다.
 *
 * 도는 잡만 둘째 줄을 지킨다 — "지금 무엇을"은 열지 않고도 답이 나와야 하는 질문이고, 그 답을
 * 꼬리에 밀어 넣으면 제목과 같은 폭을 다툰다.
 */
function JobRow({
  job,
  language,
  onOpen,
}: {
  readonly job: AgentChatJob;
  readonly language: "en" | "ko";
  readonly onOpen: (id: string) => void;
}) {
  const t = getT(language);
  const now = job.open && (job.lastTool !== undefined || job.note !== undefined);
  return (
    <button
      type="button"
      className={`agent-chat-job-row ${jobStateClass(job)}${now ? " has-now" : ""}`}
      aria-label={t("terminal.chat.workOpenAria")}
      onClick={() => onOpen(job.id)}
    >
      <span className="agent-chat-job-line">
        {job.open
          ? <span className="agent-chat-step-orbit" aria-hidden="true" />
          : <span className="agent-chat-job-mark" aria-hidden="true">{job.status === "failed" ? "✕" : job.status === "completed" ? "✓" : "·"}</span>}
        <span className="agent-chat-job-glyph" aria-hidden="true"><JobGlyph kind={job.kind} /></span>
        <span className="agent-chat-job-title">{job.title}</span>
        <span className="agent-chat-job-tail">
          {/* 종류는 가지 머리가 이미 말했으므로 꼬리에서 뺀다 — 같은 사실을 한 줄 안에서 두 번
              읽게 하지 않는다. 남는 것은 그 잡만 아는 값이다. */}
          {jobMetaParts(job, language).slice(1).map((part, index) => (
            <React.Fragment key={index}>
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <span>{part}</span>
            </React.Fragment>
          ))}
          {job.kind === "workflow" && job.stages.length > 0 ? <StageDots stages={job.stages} /> : null}
          <span className="agent-chat-job-outcome">{jobOutcome(job, language)}</span>
          <span className="agent-chat-job-chev" aria-hidden="true">›</span>
        </span>
      </span>
      {now ? (
        <span className="agent-chat-job-now">
          <span className="agent-chat-step-orbit" aria-hidden="true" />
          <span className="agent-chat-job-now-verb">
            {job.lastTool !== undefined ? runningVerb(job.lastTool, language) : job.note}
          </span>
          {job.lastTool !== undefined && job.note !== undefined ? (
            <span className="agent-chat-job-now-note">{job.note}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** 작업 면에서 끝난 잡이 갈리는 가지의 순서. 목록에 없는 종류는 가지를 세우지 않는다. */
const JOB_KIND_ORDER: readonly AgentChatJobKind[] = ["agent", "shell", "workflow", "other"];

/**
 * 끝난 잡을 종류로 가르는 가지들.
 *
 * 가지 머리는 접힌 채로도 자기 안의 실패 수를 말한다 — 그러지 않으면 접기가 손댈 것을 감춘다.
 * 가지 안의 순서는 도착한 순서 그대로이고, 가지 **사이**의 시간 순서는 이 갈래가 잃는 것이다
 * (그 대가로 "무슨 종류의 일이 얼마나 돌았나"가 한눈에 온다).
 */
function SettledBranches({
  jobs,
  language,
  onOpen,
}: {
  readonly jobs: readonly AgentChatJob[];
  readonly language: "en" | "ko";
  readonly onOpen: (id: string) => void;
}) {
  const t = getT(language);
  // 접힘은 세션 안에서만 산다 — 시트 높이와 같은 급의 값이라 다음 Operation까지 따라가면
  // 그쪽에서 처음 여는 사람이 남의 접힘을 물려받는다.
  const [closed, setClosed] = React.useState<ReadonlySet<AgentChatJobKind>>(() => new Set());
  const branches = JOB_KIND_ORDER.flatMap((kind) => {
    const list = jobs.filter((entry) => entry.kind === kind);
    return list.length > 0 ? [{ kind, list }] : [];
  });
  // 가지가 하나뿐이면 머리를 세우지 않는다. 한 종류만 돈 턴에서 그 머리는 목록을 한 줄 밀어낼
  // 뿐 아무것도 가르지 않는다.
  if (branches.length <= 1) {
    return <>{jobs.map((entry) => <JobRow key={entry.id} job={entry} language={language} onOpen={onOpen} />)}</>;
  }
  return (
    <>
      {branches.map(({ kind, list }) => {
        const open = !closed.has(kind);
        const failed = list.filter((entry) => entry.status === "failed").length;
        return (
          <div className="agent-chat-work-branch" key={kind} data-open={open}>
            <button
              type="button"
              className="agent-chat-work-branch-head"
              aria-expanded={open}
              onClick={() => setClosed((current) => {
                const next = new Set(current);
                if (!next.delete(kind)) next.add(kind);
                return next;
              })}
            >
              <span className="agent-chat-job-glyph" aria-hidden="true"><JobGlyph kind={kind} /></span>
              <span className="agent-chat-work-branch-name">
                {t("terminal.chat.workBranch", { kind: jobKindLabel(kind, language), count: list.length })}
              </span>
              {failed > 0 ? (
                <span className="agent-chat-work-branch-fail">{t("terminal.chat.groupJobFailed", { count: failed })}</span>
              ) : null}
              <span className="agent-chat-work-branch-chev" aria-hidden="true">⌄</span>
            </button>
            <div className="agent-chat-work-branch-kids" hidden={!open}>
              {list.map((entry) => <JobRow key={entry.id} job={entry} language={language} onOpen={onOpen} />)}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** 워크플로 카드의 단계 점 — 몇 개가 끝났는지가 한눈에 읽힌다. */
function StageDots({ stages }: { readonly stages: readonly AgentChatJob["stages"][number][] }) {
  return (
    <span className="agent-chat-job-dots" aria-hidden="true">
      {stages.map((stage, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span className="agent-chat-job-dot-gap" /> : null}
          {stage.agents.map((agent, at) => (
            <span key={at} className={`agent-chat-job-dot${agent.state === "done" ? " is-done" : agent.state === "running" ? " is-live" : ""}`} />
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * 선반 — 컴포저 **표시줄 안**에 서는 한 덩어리. 잡이 하나라도 있으면 스피너와 상태 문구가
 * 버튼으로 시트를 연다. 따로 붙인 보기/접기 동사는 상태를 두 번 읽게 하므로 두지 않고, 같은
 * 상태를 다시 누르면 시트가 접힌다.
 *
 * 예전에는 표시줄 위에 자기 행(32px + 헤어라인)을 따로 세웠다. 그 행과 표시줄은 같은 말
 * ("이 세션의 지금")을 두 줄에 나눠 했고, 표시줄의 가운데는 좌표와 폭 글리프 사이에서 비어
 * 있었다 — 잡이 하나라도 태어나면 대화가 33px을 영구히 내주는 값이었다. 지금은 그 빈 칸이
 * 이 자리다: 좌표와 폭 글리프는 자기 끝을 지키고 선반이 남는 폭을 가운데에서 쓴다.
 *
 * 색 규칙은 스트립 시절 그대로다: 도는 개수는 aurora(상태), 정착만 남은 개수는 중립 잉크.
 * brass는 버튼 전체의 hover/focus 예고에만 쓴다.
 */
function WorkLedge({
  jobs,
  openJobs,
  open,
  controlsId,
  language,
  compact,
  toggleRef,
  onToggle,
}: {
  readonly jobs: readonly AgentChatJob[];
  readonly openJobs: readonly AgentChatJob[];
  readonly open: boolean;
  readonly controlsId: string;
  readonly language: "en" | "ko";
  /**
   * 같은 줄에 오류 알림이 서 있는가. 알림은 좌표 자리를 빌리면서 이 줄의 폭을 대부분 가져가므로,
   * 그때 선반은 이름을 내려놓고 개수만 남는다 — 사라지지는 않는다: 도는 잡이 있다는 사실과
   * 시트로 가는 문은 알림보다 오래 산다.
   */
  readonly compact: boolean;
  readonly toggleRef: React.RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
}) {
  const t = getT(language);
  const running = openJobs.length > 0;
  return (
    <div className={`agent-chat-ledge${running ? "" : " is-rest"}${compact ? " is-compact" : ""}`}>
      <button
        type="button"
        ref={toggleRef}
        className="agent-chat-ledge-toggle"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={onToggle}
      >
        {running
          ? <span className="agent-chat-strip-orbit" aria-hidden="true" />
          : <span className="agent-chat-strip-dot" aria-hidden="true" />}
        <span className="agent-chat-strip-count">
          {running ? t("terminal.chat.stripRunning", { count: openJobs.length }) : settledLabel(jobs.length, t)}
        </span>
        {/* 도는 것이 있으면 그 이름을 잇는다 — 개수만으로는 무엇이 도는지 모른다. 정착만 남았을
            때는 개수가 곧 내용이다. 알림이 이 줄을 쓰는 동안에는 이름이 물러난다. */}
        {running && !compact ? <span className="agent-chat-ledge-name">· {openJobs[0]?.title}</span> : null}
      </button>
    </div>
  );
}

/**
 * 시트 — 잡 목록과 잡 하나의 상세. 둘은 같은 자리에서 갈아 끼워진다.
 *
 * 대화 옆 컬럼도 아래 서랍도 아니다. 선반 바로 위에서 대화의 아래쪽을 덮으며 떠오르고, 접으면
 * 로그와 컴포저는 처음 그 자리다.
 *
 * 면은 채팅 패널과 같은 것을 칠한다. 유리 채널(`--glass-tint-strong`)을 쓰던 시절, instrument에서
 * 그 합성값이 카드 면과 대비 1.00으로 겹쳐 카드가 헤어라인만 남기고 사라졌다(실측). 층은 재료가
 * 아니라 위쪽 헤어라인과 그림자가 진다.
 *
 * 접는 문은 머리줄 오른쪽 끝의 × 버튼이다. Esc와 대화 클릭, 선반 재클릭도 그대로 접는다 — 문이
 * 생겼다고 이미 있던 길을 닫지 않는다.
 */
function WorkSheet({
  id,
  sheetRef,
  jobs,
  job,
  operationId,
  language,
  tall,
  onToggleTall,
  onClose,
  onOpen,
  onBack,
}: {
  readonly id: string;
  readonly sheetRef: React.RefObject<HTMLElement | null>;
  readonly jobs: readonly AgentChatJob[];
  readonly job: AgentChatJob | null;
  readonly operationId: string;
  readonly language: "en" | "ko";
  readonly tall: boolean;
  readonly onToggleTall: () => void;
  readonly onClose: () => void;
  readonly onOpen: (id: string) => void;
  readonly onBack: () => void;
}) {
  const t = getT(language);
  const open = jobs.filter((entry) => entry.open);
  const settled = jobs.filter((entry) => !entry.open);
  return (
    <section
      ref={sheetRef}
      className={`agent-chat-sheet${tall ? " is-tall" : ""}`}
      id={id}
      aria-label={t("terminal.chat.workAria")}
    >
      <div className="agent-chat-sheet-head">
        <span>{t("terminal.chat.workAria")}</span>
        {/* 200스텝짜리 발자국에 62%는 좁다. 높이는 세션 안에서만 기억한다 — 한 번 키운 높이가
            다음 Operation까지 따라가면, 그쪽 잡 둘을 보려고 대화를 82% 덮게 된다. */}
        <button type="button" className="agent-chat-sheet-grow" onClick={onToggleTall}>
          {tall ? t("terminal.chat.sheetShrink") : t("terminal.chat.sheetGrow")}
        </button>
        <button
          type="button"
          className="agent-chat-sheet-close"
          aria-label={t("terminal.chat.sheetClose")}
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="agent-chat-work-body">
        {job !== null ? (
          <JobDetail job={job} operationId={operationId} language={language} onBack={onBack} />
        ) : jobs.length === 0 ? (
          <div className="agent-chat-work-empty">{t("terminal.chat.workEmpty")}</div>
        ) : (
          <>
            {open.length > 0 ? (
              <>
                <div className="agent-chat-work-sec">{t("terminal.chat.workRunning")} {open.length}</div>
                {open.map((entry) => <JobRow key={entry.id} job={entry} language={language} onOpen={onOpen} />)}
              </>
            ) : null}
            {settled.length > 0 ? (
              <>
                {/* 라벨은 "끝남"이다. 이 구역이 세는 것은 `!open`이라 실패·중단·결과 미상이 함께
                    들어 있는데, 예전 라벨("완료")은 그 셋을 완료라고 불렀다 — 열여섯 건 중 둘이
                    실패인 목록 위에 "완료 16"이 서 있었다(실측). */}
                <div className="agent-chat-work-sec">{t("terminal.chat.workEnded")} {settled.length}</div>
                <SettledBranches jobs={settled} language={language} onOpen={onOpen} />
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * 잡 하나의 실제 내용. 종류마다 어휘가 다르므로 본문도 다르다 — 워크플로는 단계 트리,
 * 나머지는 그 작업이 돌려준 보고.
 */
function JobDetail({
  job,
  operationId,
  language,
  onBack,
}: {
  readonly job: AgentChatJob;
  readonly operationId: string;
  readonly language: "en" | "ko";
  readonly onBack: () => void;
}) {
  const t = getT(language);
  const detail = useAgentChatJobDetail(operationId, job);
  const stop = useAgentChatJobStop(operationId, job);
  return (
    <>
      <div className="agent-chat-detail-head">
        <button type="button" className="agent-chat-detail-back" aria-label={t("terminal.chat.workBackAria")} onClick={onBack}>
          ‹ {t("terminal.chat.workBack")}
        </button>
        <span className="agent-chat-job-glyph" aria-hidden="true"><JobGlyph kind={job.kind} /></span>
        <span className="agent-chat-detail-title">{job.title}</span>
        {/* 제목과 결말 사이의 신축 자리. 이것이 없으면 긴 제목이 머리줄을 밀어 '중단'이 다음
            줄로 내려가고, 되돌릴 수 없는 문이 예상 못한 자리에 선다. */}
        <span className="agent-chat-detail-gap" aria-hidden="true" />
        <span className={`agent-chat-job-outcome ${jobStateClass(job)}`}>{jobOutcome(job, language)}</span>
        {/* 도는 잡에만 선다. 끝난 잡 위의 중단 버튼은 누를 수 없는 문이고, 그 자리에 있는 것만으로
            결말이 아직 열려 있다고 말한다. */}
        {job.open ? (
          <button
            type="button"
            className="agent-chat-detail-stop"
            aria-label={t("terminal.chat.jobStopAria")}
            disabled={stop.state === "stopping"}
            onClick={stop.request}
          >
            {stop.state === "stopping" ? t("terminal.chat.jobStopping") : t("terminal.chat.jobStop")}
          </button>
        ) : null}
      </div>
      {stop.state === "failed" ? <div className="agent-chat-detail-stop-error">{t("terminal.chat.jobStopFailed")}</div> : null}
      <div className="agent-chat-detail-meta">{jobMetaParts(job, language).join(" · ")}</div>
      <JobIdentity detail={detail} language={language} />
      <div className="agent-chat-detail-body">
        {job.kind === "workflow" ? (
          job.stages.length > 0
            ? job.stages.map((stage, index) => <Stage key={index} stage={stage} language={language} />)
            // 단계 트리는 전선에서만 관측되는 값이라 없을 수 있다. 없으면 그 사실을 말한다 —
            // 빈 트리는 "단계가 없다"로 읽히고, 도는 스피너는 영영 돌기 때문이다.
            : <div className="agent-chat-work-empty">{t("terminal.chat.stagesUnavailable")}</div>
        ) : null}
        {job.summary !== undefined ? (
          <>
            <div className="agent-chat-kicker">{t("terminal.chat.jobReport")}</div>
            {/* 보고는 에이전트가 쓴 마크다운이다 — Answer와 같은 공유 컴포넌트로 렌더한다.
                원문을 그대로 세우면 제목·목록·코드 블록이 전부 기호로 남는다. */}
            <StreamedMarkdown
              className="agent-chat-detail-report markdown-body"
              text={job.summary}
              streaming={false}
              language={language}
            />
          </>
        ) : job.kind !== "workflow" && !job.open ? (
          <div className="agent-chat-work-empty">{t("terminal.chat.jobNoReport")}</div>
        ) : null}
        {job.open && job.note !== undefined ? <p className="agent-chat-detail-note">{job.note}</p> : null}
        <JobExtra detail={detail} job={job} language={language} />
      </div>
    </>
  );
}

/**
 * 보고 아래에 붙는 것 — 서브에이전트의 도구 발자국, 또는 셸 출력의 꼬리.
 *
 * 이 두 가지가 답하는 질문은 보고가 답하지 못하는 질문이다. 보고는 그 작업이 **말하기로 고른**
 * 문장이고, 발자국은 실제로 **한 일**이다. 셸은 아예 보고랄 것이 없다 — 출력이 곧 산출물이다.
 */
function JobExtra({
  detail,
  job,
  language,
}: {
  readonly detail: { readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null };
  readonly job: AgentChatJob;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  // 발자국을 남기지 않는 종류(other)가 도는 동안에도 본문은 비어 있지 않아야 한다. 빈 화면은
  // "기록이 없다"로 읽히는데, 사실은 "이 종류엔 원래 없다"이다.
  if (detail.state === "idle") {
    return job.open && job.kind !== "workflow"
      ? <div className="agent-chat-work-empty">{t("terminal.chat.jobWorking")}</div>
      : null;
  }
  if (detail.state === "loading") {
    return <div className="agent-chat-detail-loading">{t("terminal.chat.jobDetailLoading")}</div>;
  }
  const value = detail.value;
  // 못 읽었다는 것과 비어 있다는 것은 다르다. 전자는 좌표를 못 찾았거나 아직 안 쓰인 것이고,
  // 후자는 그 작업이 정말 아무 도구도 쓰지 않은 것이다 — 둘을 한 문장으로 뭉치면 거짓이 된다.
  // 도는 중에는 셋째가 있다: 아직 첫 줄이 쓰이지 않은 것. 그것을 "기록 없음"으로 적으면 방금
  // 시작한 작업이 실패한 것처럼 읽힌다.
  if (value === null) {
    return (
      <div className="agent-chat-work-empty">
        {job.open
          ? t(job.kind === "shell" ? "terminal.chat.jobOutputPending" : "terminal.chat.jobTrailPending")
          : t("terminal.chat.jobDetailUnavailable")}
      </div>
    );
  }
  if (value.kind === "shell") {
    return (
      <>
        <div className="agent-chat-kicker">{t("terminal.chat.jobOutput")}</div>
        {value.truncated ? <div className="agent-chat-detail-cut">{t("terminal.chat.jobOutputCut")}</div> : null}
        <pre className="agent-chat-detail-tail">{value.tail}</pre>
      </>
    );
  }
  if (value.steps.length === 0) {
    return (
      <>
        <div className="agent-chat-kicker">{t("terminal.chat.jobTrail")}</div>
        <div className="agent-chat-work-empty">
          {t(job.open ? "terminal.chat.jobTrailPending" : "terminal.chat.jobTrailEmpty")}
        </div>
      </>
    );
  }
  // 도는 동안의 개수는 최종값이 아니다 — "지금까지"라고 말해야 다음 응답이 늘린 숫자가 정정이
  // 아니라 진행으로 읽힌다.
  const count = job.open
    ? t("terminal.chat.jobTrailLive", { count: value.steps.length })
    : String(value.steps.length);
  const last = value.steps.length - 1;
  return (
    <>
      <div className="agent-chat-kicker">{t("terminal.chat.jobTrail")} {count}</div>
      {value.truncated ? <div className="agent-chat-detail-cut">{t("terminal.chat.jobTrailCut")}</div> : null}
      <div className="agent-chat-trail">
        {value.steps.map((step, index) => {
          // 결말 없는 마지막 줄은 지금 도는 그 도구다. 끝난 스텝과 같은 ✓를 달면 화면이 아직
          // 오지 않은 결과를 성공으로 적는다.
          const live = job.open && index === last && step.outcome === undefined && step.failed !== true;
          return (
            // 원장의 스텝과 같은 클래스를 쓴다 — 서브에이전트가 한 일이 이 세션이 한 일과 같은
            // 문법으로 읽혀야, 중첩된 것이 새 화면이 아니라 같은 화면의 한 겹으로 보인다.
            <div key={index} className={`agent-chat-step is-${step.failed === true ? "fail" : "ok"}${live ? " is-live" : ""}`}>
              {live
                ? <span className="agent-chat-step-orbit" aria-hidden="true" />
                : <span className="agent-chat-step-mark" aria-hidden="true">{step.failed === true ? "✕" : "✓"}</span>}
              <span className="agent-chat-step-verb">{step.name}</span>
              {step.detail !== undefined ? <span className="agent-chat-step-object">{step.detail}</span> : null}
              {step.outcome !== undefined ? (
                <span className={`agent-chat-step-out${step.failed === true ? " is-error" : ""}`}>{step.outcome}</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * 서브에이전트의 신원 한 줄 — 누가 이 일을 했는가.
 *
 * 스트립의 `who`는 종류만 말한다. 모델과 중첩 깊이는 전사록 옆 메타에만 있고, 어느 모델이
 * 돌았는지는 Fleet에서 잡을 여는 가장 흔한 이유다.
 */
function JobIdentity({
  detail,
  language,
}: {
  readonly detail: { readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null };
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const value = detail.value;
  if (value === null || value.kind !== "agent" || value.identity === undefined) return null;
  const identity = value.identity;
  const fields: readonly (readonly [string, string])[] = [
    ...(identity.agentType !== undefined ? [[t("terminal.chat.jobIdentityAgent"), identity.agentType] as const] : []),
    ...(identity.model !== undefined ? [[t("terminal.chat.jobIdentityModel"), modelLabel(identity.model)] as const] : []),
    ...(identity.depth !== undefined ? [[t("terminal.chat.jobIdentityDepth"), String(identity.depth)] as const] : []),
  ];
  if (fields.length === 0) return null;
  return (
    <div className="agent-chat-detail-identity">
      {fields.map(([label, shown]) => (
        <span key={label} className="agent-chat-identity-field">
          <span className="agent-chat-identity-key">{label}</span>
          <span className="agent-chat-identity-value" title={shown}>{shown}</span>
        </span>
      ))}
    </div>
  );
}

/** 도는 잡의 상세를 다시 묻는 간격. 전사록은 append되므로 다시 읽는 것이 곧 따라가는 것이다. */
const JOB_DETAIL_POLL_MS = 2_000;

/**
 * 잡 상세를 읽는다 — 끝난 잡은 한 번, 도는 잡은 결말을 볼 때까지 되풀이해서.
 *
 * 워크플로는 요청하지 않는다: 단계 트리가 이미 맥박으로 흐르고 그것이 곧 상세다.
 *
 * 도는 잡을 묻는 것이 이 훅의 요점이다. 서브에이전트 전사록과 셸 출력 파일은 **작업이 도는 동안
 * 계속 append 된다**(실측: 실행 중 세션의 전사록이 6.5MB·897줄까지 자라며 갱신). 끝난 뒤에만
 * 물으면 도구를 172회 쓴 작업이 그동안 본문 0줄로 서 있게 된다. 반쪽을 보여 주는 것은 문제가
 * 아니다 — 화면이 "지금까지"라고 말하고 다음 응답이 이어 그리기 때문이다.
 *
 * "닫혔다"와 "결말이 보고됐다"는 여전히 같은 순간이 아니다. 백그라운드 셸은 `task_updated`가
 * `killed`로 먼저 닫고, 출력 파일의 좌표는 뒤따르는 `task_notification`이 들고 온다(실측 순서이며
 * 매퍼에도 그렇게 적혀 있다). 그래서 결말 보고가 **도착한 횟수**(`job.ends`)를 계속 의존성에 둔다 —
 * 폴링이 닫히는 순간에 맞춰 멈추더라도, 뒤늦게 온 좌표가 마지막 한 번을 다시 부른다.
 */
function useAgentChatJobDetail(
  operationId: string,
  job: AgentChatJob,
): { readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null } {
  const wanted = job.kind === "agent" || job.kind === "shell";
  const [result, setResult] = React.useState<{ readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null }>(
    { state: "idle", value: null },
  );
  React.useEffect(() => {
    if (!wanted) {
      setResult({ state: "idle", value: null });
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // 첫 응답까지만 loading이다. 되풀이하는 동안 loading으로 되돌리면 2초마다 발자국이 사라졌다
    // 다시 서고, 읽던 자리가 그때마다 날아간다.
    setResult((prev) => (prev.state === "idle" ? { state: "loading", value: null } : prev));
    const read = (): void => {
      void readAgentChatJobDetail(operationId, job.id, controller.signal)
        .then((value) => {
          if (!live) return;
          // 도는 중의 null은 "없다"가 아니라 "아직"이다 — 이미 그린 발자국을 그것으로 지우지 않는다.
          setResult((prev) => (value === null && job.open && prev.value !== null ? prev : { state: "ready", value }));
        })
        .catch(() => { if (live) setResult((prev) => (prev.state === "ready" ? prev : { state: "ready", value: null })); })
        .finally(() => { if (live && job.open) timer = setTimeout(read, JOB_DETAIL_POLL_MS); });
    };
    read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    };
  }, [operationId, job.id, wanted, job.open, job.ends]);
  return result;
}

/**
 * 잡 하나를 멈추는 자리.
 *
 * 성공을 낙관적으로 그리지 않는다 — 요청이 닿았다는 것과 그 작업이 실제로 끝났다는 것은 다르고,
 * 후자는 자식이 보내는 결말 알림만 말할 수 있다. 그래서 이 훅은 요청 중과 실패만 안다.
 * 잡이 닫히면 카드가 스스로 결말을 그리므로, `job.open`이 꺼지는 것이 곧 성공 표시다.
 */
function useAgentChatJobStop(
  operationId: string,
  job: AgentChatJob,
): { readonly state: "idle" | "stopping" | "failed"; readonly request: () => void } {
  const [state, setState] = React.useState<"idle" | "stopping" | "failed">("idle");
  // 다른 잡으로 옮겨 가면 앞 잡의 실패 표시를 들고 가지 않는다.
  React.useEffect(() => {
    setState("idle");
  }, [job.id]);
  const request = React.useCallback(() => {
    setState("stopping");
    void stopAgentChatJob(operationId, job.id)
      .then(() => setState("idle"))
      .catch(() => setState("failed"));
  }, [operationId, job.id]);
  return { state, request };
}

/** 워크플로 한 단계 — 에이전트별로 어떤 신원이 얼마를 썼는지가 이 표의 요점이다. */
function Stage({
  stage,
  language,
}: {
  readonly stage: AgentChatJob["stages"][number];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const done = stage.agents.filter((agent) => agent.state === "done").length;
  return (
    <div className="agent-chat-stage">
      <div className="agent-chat-stage-head">
        <span>{stage.title}</span>
        <span className="agent-chat-stage-count">{done}/{stage.agents.length}</span>
      </div>
      <div className="agent-chat-stage-rows" role="table">
        <div className="agent-chat-stage-row is-head" role="row">
          <span role="columnheader" />
          <span role="columnheader">{t("terminal.chat.stageAgent")}</span>
          <span role="columnheader">{t("terminal.chat.stageModel")}</span>
          <span role="columnheader" className="is-num">{t("terminal.chat.stageTokens")}</span>
          <span role="columnheader" className="is-num">{t("terminal.chat.stageTools")}</span>
          <span role="columnheader" className="is-num">{t("terminal.chat.stageTime")}</span>
        </div>
        {stage.agents.map((agent, index) => (
          <div className={`agent-chat-stage-row${agent.state === "done" ? "" : " is-pending"}`} role="row" key={index}>
            <span role="cell" className="is-mark" aria-hidden="true">
              {agent.state === "done" ? "✓" : agent.state === "running" ? "◐" : "·"}
            </span>
            <span role="cell" className="is-name" title={agent.result ?? agent.label}>{agent.label}</span>
            <span role="cell" className="is-model" title={agent.model}>{agent.model !== undefined ? modelLabel(agent.model) : "—"}</span>
            <span role="cell" className="is-num">{agent.tokens !== undefined ? formatCount(agent.tokens) : "—"}</span>
            <span role="cell" className="is-num">{agent.tools !== undefined ? agent.tools : "—"}</span>
            <span role="cell" className="is-num">{agent.durationMs !== undefined ? formatDuration(agent.durationMs) : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 게이트웨이 신원의 표시형. `claude-gateway--`는 이 모델이 어디로 실려 갔는지를 말할 뿐
 * 어느 모델인지는 말하지 않는데, 모든 행의 앞자리를 같은 문자열로 채워 정작 다른 부분이
 * 먼저 말줄임에 잘린다. 원본은 셀의 `title`이 계속 진다.
 */
const GATEWAY_MODEL_PREFIX = "claude-gateway--";

function modelLabel(model: string): string {
  return model.startsWith(GATEWAY_MODEL_PREFIX) ? model.slice(GATEWAY_MODEL_PREFIX.length) : model;
}

/** 토큰 수는 자릿수가 커서 그대로 쓰면 표가 흔들린다 — 천 단위로 접는다. */
function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 동사는 계열이 정한다 — 집계 줄과 스텝 줄이 같은 어휘를 쓰도록 한 축에서 온다. */
function runningVerb(name: string, language: "en" | "ko"): string {
  const t = getT(language);
  const family = agentChatToolFamily(name);
  // 도는 MCP 호출은 집계 줄의 꼬리에 절로 붙는다. 그 자리에는 절을 감싼 서버가 없으므로
  // 서버와 도구를 함께 말해야 무엇을 쓰는 중인지가 남는다.
  const call = family === "mcp" ? agentChatMcpCall(name) : undefined;
  if (call !== undefined) return t("terminal.chat.activityUsingMcp", { server: call.server, tool: call.tool });
  return family === "other"
    ? t("terminal.chat.activityUsing", { name })
    : t(`terminal.chat.verb.${family}.now` as Parameters<typeof t>[0]);
}

function pastVerb(name: string, language: "en" | "ko"): string {
  const t = getT(language);
  const family = agentChatToolFamily(name);
  if (family === "other" || family === "mcp") return agentChatToolLabel(name);
  return t(`terminal.chat.verb.${family}.past` as Parameters<typeof t>[0]);
}

function formatChange(change: AgentChatChange): string {
  const parts: string[] = [];
  if (change.added > 0) parts.push(`+${change.added}`);
  if (change.removed > 0) parts.push(`−${change.removed}`);
  return parts.join(" ");
}

function useTurnElapsedMs(startedAt: number | undefined, working: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!working || startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [working, startedAt]);
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

// ── 문맥 창 ──────────────────────────────────────────────────────────────────

/**
 * 토큰 수를 사람이 읽는 크기로. 정확한 자릿수가 아니라 **규모**를 읽히는 것이 이 표면의 일이라
 * 천 단위에서 접는다 — 69,432를 그대로 두면 옆의 백분율보다 먼저 눈에 들어온다.
 */
function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  // 백만은 "1000k"가 아니라 "1M"이다. 게이트웨이 모델의 실제 창이 이 자리에 실리면서 분모가
  // 백만대에 닿았고, 같은 값을 설정 화면은 이미 M으로 적는다 — 한 제품이 같은 수를 두 단위로
  // 적으면 사용자가 두 번 읽어야 한다.
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return millions < 10 ? `${trimTrailingZero(millions.toFixed(1))}M` : `${Math.round(millions)}M`;
  }
  const thousands = tokens / 1_000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

function trimTrailingZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * 화면이 총량으로 읽어야 하는 수.
 *
 * 라이브 값이 있으면 그것이다 — 측정된 총량은 마지막 스냅숏 시점의 것이고, 라이브는 마지막 모델
 * 호출 시점의 것이므로 언제나 같거나 더 새롭다. 둘은 같은 자로 잰 같은 계열이다(실측).
 */
function contextOccupied(context: AgentChatContext): number {
  return context.liveTotal ?? context.total;
}

/**
 * 미터가 어느 계단에 서는지. quota 레일이 쓰는 세 단계를 그대로 물려받는다 — 같은 제품 안에서
 * 같은 모양의 미터가 다른 임계로 물들면 사용자가 색을 두 번 배워야 한다.
 *
 * 자동 압축이 켜져 있으면 임계선이 곧 위험선이다. 꺼져 있으면 창을 다 쓰는 것 자체가 한계이므로
 * 고정 비율로 돌아간다.
 */
function contextTone(context: AgentChatContext): "" | " is-warn" | " is-critical" {
  const ratio = contextOccupied(context) / context.max;
  const limit = context.compactAt !== undefined ? context.compactAt / context.max : 1;
  if (ratio >= limit * 0.97) return " is-critical";
  if (ratio >= limit * 0.75) return " is-warn";
  return "";
}

/**
 * 문맥 미터 칩과 그 내역.
 *
 * 총량은 턴이 도는 동안 모델 호출마다 갱신된다 — SDK가 흘리는 `message_delta` usage가 자식이 세는
 * 값과 같은 수이기 때문이다(실측 5건 일대일). 내역은 그보다 늦다: 카테고리 분해는 control 채널만
 * 알고 그 왕복이 30초쯤 걸리므로, 팝오버의 총량과 내역 합이 벌어질 수 있고 그 차이는 "이 턴" 행이
 * 드러낸다. 감추면 사용자가 방금 붙인 큰 파일을 공짜로 읽는다.
 */
function ContextMeterChip({
  context,
  working,
  language,
  openSignal,
}: {
  readonly context: AgentChatContext | null;
  /** 턴이 도는 중인가. 라이브 값이 아직 없을 때만 낡음을 주장할 근거가 된다. */
  readonly working: boolean;
  readonly language: "en" | "ko";
  /**
   * 밖에서 이 팝오버를 열어 달라는 요청. **값이 바뀌었다는 사실만** 신호이고 크기는 뜻이 없다 —
   * 열림/닫힘을 밖으로 끌어올리면 칩이 자기 바깥 클릭·Esc를 스스로 닫지 못하게 된다.
   */
  readonly openSignal: number;
}) {
  const t = getT(language);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const seenSignal = React.useRef(openSignal);

  React.useEffect(() => {
    if (openSignal === seenSignal.current) return;
    seenSignal.current = openSignal;
    setOpen(true);
  }, [openSignal]);

  // 열려 있는 동안에만 문서에 손을 댄다. 채팅 패널은 한 화면에 여럿 살 수 있어, 닫힌 칩까지
  // 리스너를 걸면 패널 수만큼 같은 핸들러가 매 클릭을 받는다.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // 한 턴도 끝나지 않았으면 말할 수 있는 것이 없다. 0%짜리 미터는 빈 사실이 아니라 틀린 사실이다.
  if (!context) return null;

  const occupied = contextOccupied(context);
  // 화면에서는 원호가 말하고, 숫자는 이름표(aria)와 툴팁이 진다 — 글리프 하나가 스크린리더에게
  // 아무 값도 말하지 않으면 그 사용자에게는 계기가 사라진 것과 같다.
  const percent = Math.round((occupied / context.max) * 100);
  const summary = `${formatTokens(occupied)} / ${formatTokens(context.max)}`;
  // 낡음을 주장할 수 있는 구간은 하나뿐이다: 턴이 시작됐고 아직 첫 delta가 오지 않은 사이.
  // 그 뒤로는 값이 실시간이므로 흐리게 그리면 사실이 아니다.
  const stale = working && context.liveTotal === undefined;
  return (
    <div className={`agent-chat-ctx${contextTone(context)}`} ref={wrapRef}>
      <button
        type="button"
        className={`agent-chat-ctx-chip${stale ? " is-stale" : ""}`}
        aria-expanded={open}
        aria-label={t("terminal.chat.contextAria", { percent: String(percent), summary })}
        title={t("terminal.chat.contextAt", { summary })}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {/* 숫자는 이 자리를 떠나 팝오버로 간다 — 바에서는 첨부와 같은 글리프 하나로 서고,
            채움이 곧 규모다. 정확한 값이 필요한 순간은 누르는 순간이고, 그때 내역이 함께 온다.
            원호를 그대로 글리프로 쓰는 이유는 그것이 유일하게 잃지 않는 신호이기 때문이다:
            무채색 계기 아이콘으로 바꾸면 바에서 압력을 읽을 길이 사라진다. */}
        <ContextArc ratio={occupied / context.max} />
      </button>
      {open ? <ContextBreakdown context={context} language={language} /> : null}
    </div>
  );
}

/** 칩 안의 작은 원호. 숫자 옆에서 규모를 한눈에 세우는 몫이라 눈금도 라벨도 갖지 않는다. */
function ContextArc({ ratio }: { readonly ratio: number }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, ratio)) * circumference;
  return (
    <svg className="agent-chat-ctx-arc" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="agent-chat-ctx-arc-track" cx="8" cy="8" r={radius} />
      <circle
        className="agent-chat-ctx-arc-fill"
        cx="8"
        cy="8"
        r={radius}
        strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`}
      />
    </svg>
  );
}

/**
 * 무엇이 창을 먹고 있는지.
 *
 * 카테고리를 색으로 가르지 않는 이유는 Console 채널 규칙이다 — 색은 상태만 나른다. 여기서는
 * 명도 계단이 순서를 지고, 그 순서는 큰 것부터다. SDK가 제 팔레트를 함께 보내지만 그것은 CLI의
 * 것이지 이 제품의 것이 아니다.
 */
function ContextBreakdown({
  context,
  language,
}: {
  readonly context: AgentChatContext;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const rows = [...context.slices].sort((left, right) => right.tokens - left.tokens);
  const reserved = context.reserved ?? 0;
  const occupied = contextOccupied(context);
  // 내역은 마지막 측정의 것이고 총량은 그보다 새롭다. 그 차이는 아직 분해를 모르는 몫이므로
  // 한 행으로 세운다 — 빼고 그리면 행 합과 총량이 어긋난 팝오버가 되고, 총량에 녹이면 사용자가
  // 측정된 내역과 아직 모르는 몫을 구분할 수 없다.
  const measured = rows.reduce((sum, slice) => sum + slice.tokens, 0);
  const pending = Math.max(0, occupied - measured);
  // 남은 자리는 창에서 쓴 몫과 예약분을 뺀 나머지다. 예약분을 빼지 않으면 실제로 쓸 수 없는
  // 자리를 여유로 세어, 압축이 시작될 때 사용자가 아직 여유가 있다고 읽는다.
  const free = Math.max(0, context.max - occupied - reserved);
  const percent = Math.round((occupied / context.max) * 100);
  return (
    <div className="agent-chat-ctx-pop" role="dialog" aria-label={t("terminal.chat.contextTitle")}>
      <div className="agent-chat-ctx-pop-head">
        <span className="agent-chat-ctx-pop-title">{t("terminal.chat.contextTitle")}</span>
        <span className="agent-chat-ctx-pop-total">
          {formatTokens(occupied)} / {formatTokens(context.max)} · {percent}%
        </span>
      </div>
      <div className="agent-chat-ctx-stack">
        {rows.map((slice, index) => (
          <i
            key={slice.name}
            // 명도 계단은 순서를 나르는 인덱스다 — 여섯 칸을 넘어가면 더 어두워지지 않고 멈춘다.
            style={{
              width: `${(slice.tokens / context.max) * 100}%`,
              "--agent-chat-ctx-step": String(Math.min(index, 5)),
            } as React.CSSProperties}
          />
        ))}
        {pending > 0 ? (
          <i
            className="is-pending"
            style={{ width: `${(pending / context.max) * 100}%` }}
          />
        ) : null}
      </div>
      <ul className="agent-chat-ctx-rows">
        {rows.map((slice, index) => (
          <li key={slice.name}>
            <span
              className="agent-chat-ctx-swatch"
              style={{ "--agent-chat-ctx-step": String(Math.min(index, 5)) } as React.CSSProperties}
              aria-hidden="true"
            />
            <span className="agent-chat-ctx-name">{slice.name}</span>
            <span className="agent-chat-ctx-tokens">{formatTokens(slice.tokens)}</span>
            <span className="agent-chat-ctx-share">{((slice.tokens / context.max) * 100).toFixed(1)}%</span>
          </li>
        ))}
        {pending > 0 ? (
          <li>
            <span className="agent-chat-ctx-swatch is-pending" aria-hidden="true" />
            <span className="agent-chat-ctx-name">{t("terminal.chat.contextPending")}</span>
            <span className="agent-chat-ctx-tokens">{formatTokens(pending)}</span>
            <span className="agent-chat-ctx-share">{((pending / context.max) * 100).toFixed(1)}%</span>
          </li>
        ) : null}
        {reserved > 0 ? (
          <li className="agent-chat-ctx-free">
            <span className="agent-chat-ctx-swatch is-free" aria-hidden="true" />
            <span className="agent-chat-ctx-name">{t("terminal.chat.contextReserved")}</span>
            <span className="agent-chat-ctx-tokens">{formatTokens(reserved)}</span>
            <span className="agent-chat-ctx-share">{((reserved / context.max) * 100).toFixed(1)}%</span>
          </li>
        ) : null}
        <li className="agent-chat-ctx-free">
          <span className="agent-chat-ctx-swatch is-free" aria-hidden="true" />
          <span className="agent-chat-ctx-name">{t("terminal.chat.contextFree")}</span>
          <span className="agent-chat-ctx-tokens">{formatTokens(free)}</span>
          <span className="agent-chat-ctx-share">{((free / context.max) * 100).toFixed(1)}%</span>
        </li>
      </ul>
      <ContextDetail label={t("terminal.chat.contextMemoryFiles")} rows={context.memoryFiles} />
      <ContextDetail label={t("terminal.chat.contextMcpTools")} rows={context.mcpTools} />
      <p className="agent-chat-ctx-foot">{t("terminal.chat.contextAge")}</p>
    </div>
  );
}

/** 카테고리 하나를 이루는 항목들. 접혀 있고, 실을 것이 없으면 아예 서지 않는다. */
function ContextDetail({
  label,
  rows,
}: {
  readonly label: string;
  readonly rows: readonly AgentChatContextSlice[];
}) {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  // 아직 문맥에 실리지 않은 항목은 0토큰으로 온다(실측: MCP 도구 14개, 합계 0). 그 줄은 창을
  // 나눠 갖는 몫이 아니라 목록일 뿐이라, 문맥 내역에 자리를 차지할 이유가 없다.
  if (rows.length === 0 || total === 0) return null;
  const sorted = [...rows].sort((left, right) => right.tokens - left.tokens);
  return (
    <details className="agent-chat-ctx-detail">
      <summary>
        <span className="agent-chat-ctx-name">{label}</span>
        <span className="agent-chat-ctx-tokens">{formatTokens(total)}</span>
        <span className="agent-chat-ctx-count">{sorted.length}</span>
      </summary>
      <ul className="agent-chat-ctx-rows">
        {sorted.map((row) => (
          <li key={row.name}>
            <span className="agent-chat-ctx-name" title={row.name}>{row.name}</span>
            <span className="agent-chat-ctx-tokens">{formatTokens(row.tokens)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
