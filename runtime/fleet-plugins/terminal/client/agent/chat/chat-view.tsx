import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";

import { getT, type TerminalMessageKey } from "../../i18n/index.js";
import { useChatReadingWidth, useTerminalFontFamily, type ChatReadingWidth } from "../../shared/terminal-preferences.js";
import { readAgentChatJobDetail, stopAgentChatJob } from "../api.js";
import { StreamedMarkdown } from "../streamed-markdown.js";
import { useAgentChatStream, type AgentChatViewState } from "./chat-store.js";
import {
  agentChatToolFamily,
  openAgentChatJobs,
  segmentAgentChatLedger,
  splitAgentChatTurn,
  type AgentChatAsk,
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
} from "./chat-events.js";
import { readAgentChatSessionCoordinates, type AgentChatSessionCoordinates } from "./session-coordinates.js";
import { AgentChatComposer, type AgentChatQueueCancelOutcome } from "./composer.js";
import { useViewSwitchState } from "../view-switch-store.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

// 캡션 버튼과 설정 Select가 같은 이름을 쓴다 — 한 선호의 두 표면이 다른 어휘를 갖지 않게 한다.
export const READING_WIDTH_LABEL_KEY = {
  reading: "terminal.chat.readingWidth.reading",
  wide: "terminal.chat.readingWidth.wide",
  full: "terminal.chat.readingWidth.full",
} as const satisfies Record<ChatReadingWidth, TerminalMessageKey>;

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
  // 읽기 폭 선호 — 콘솔 단위 사용자 선호(플러그인 설정 서버 영속)라 모든 채팅 패널이 함께 따른다.
  const readingWidth = useChatReadingWidth();
  const terminalFontFamily = useTerminalFontFamily();
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
  // 바닥을 따라가는 중인지 — 칩 가시성의 권위. ref 와 같은 값이지만, 스크롤이 바꾼 뒤에는
  // 그려져야 하므로 state 로도 둔다.
  const [following, setFollowing] = React.useState(true);
  // 자리를 세운 뒤 새로 열린 턴 수. 스트리밍 델타를 세면 답 한 건이 수십 건으로 부풀므로,
  // 사용자 지시와 그 응답을 함께 담는 턴의 탄생만 센다.
  const [unseenTurns, setUnseenTurns] = React.useState(0);
  const [answerAnnouncement, setAnswerAnnouncement] = React.useState("");
  // 두 번째 목적지는 **나란히** 선다. 탭 교체는 대화를 통째로 숨겼는데, 백그라운드 작업은
  // 대화를 대신하는 것이 아니라 대화 옆에서 동시에 도는 것이다 — 동시에 일어나는 두 가지 앞에서
  // 하나를 고르라고 요구하면, 무엇이 도는지 보려고 무엇을 물었는지를 잃는다.
  const [workOpen, setWorkOpen] = React.useState(false);
  const [workStacked, setWorkStacked] = React.useState(false);
  const [openJobId, setOpenJobId] = React.useState<string | null>(null);
  // 작업 면이 차지하는 비율. 마운트 안에서만 산다 — 패널마다 알맞은 비율이 다르고, 세션을
  // 넘겨 기억할 만큼 무거운 결정이 아니다.
  const [workRatio, setWorkRatio] = React.useState(0.42);
  const splitRef = React.useRef<HTMLDivElement>(null);
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
    if (!nearBottomRef.current) setUnseenTurns((current) => current + arrived);
  }, [state.observedTurns, state.snapshotting, state.turns.length]);

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

  React.useEffect(() => {
    const split = splitRef.current;
    if (!split || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWorkStacked(split.getBoundingClientRect().width <= 719));
    observer.observe(split);
    setWorkStacked(split.getBoundingClientRect().width <= 719);
    return () => observer.disconnect();
  }, []);

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
  // 컴포저의 백그라운드 작업 글리프가 여는 문 — 특정 잡을 고르지 않고 목록(작업 면)을 연다.
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

  const setBoundedWorkRatio = React.useCallback((next: number) => {
    setWorkRatio(Math.min(0.78, Math.max(0.18, next)));
  }, []);

  const onGripKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const split = splitRef.current;
    if (!split) return;
    const backward = workStacked ? "ArrowUp" : "ArrowLeft";
    const forward = workStacked ? "ArrowDown" : "ArrowRight";
    if (event.key === "Home") {
      event.preventDefault();
      setBoundedWorkRatio(0.18);
    } else if (event.key === "End") {
      event.preventDefault();
      setBoundedWorkRatio(0.78);
    } else if (event.key === backward) {
      event.preventDefault();
      setWorkRatio((current) => Math.min(0.78, current + 0.04));
    } else if (event.key === forward) {
      event.preventDefault();
      setWorkRatio((current) => Math.max(0.18, current - 0.04));
    }
  }, [setBoundedWorkRatio, workStacked]);

  // 손잡이 드래그. 가로(오른쪽 컬럼)와 세로(아래 서랍)가 같은 상태를 쓰고 축만 다르다 —
  // 좁은 패널에서 컬럼이 서랍으로 접히는 것이 별개의 기능이 아니라 같은 면의 다른 방향이기 때문이다.
  const onGripDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const split = splitRef.current;
    if (!split) return;
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const column = getComputedStyle(split).flexDirection !== "column";
    const move = (moved: PointerEvent): void => {
      const box = split.getBoundingClientRect();
      const raw = column
        ? (box.right - moved.clientX) / box.width
        : (box.bottom - moved.clientY) / box.height;
      // 어느 쪽도 0으로 눌리지 않는다 — 사라진 면은 접힌 것과 구별되지 않는데, 접는 문은 따로 있다.
      setBoundedWorkRatio(raw);
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }, [setBoundedWorkRatio]);

  return (
    <section
      className="agent-chat"
      data-reading-width={readingWidth}
      /* 터미널 글꼴을 Chat 로컬 토큰으로만 흘린다 — 전역 --font-mono를 덮으면 Codex·파일 탐색기·
         마크다운 코드까지 따라 바뀐다. 이 토큰의 소비처는 chat.css 하나다. */
      style={{ "--agent-chat-font": terminalFontFamily } as React.CSSProperties}
      aria-label={t("terminal.chat.aria")}
    >
      {/* 대화 면과 작업 면이 나란히 산다. 넓은 패널에서는 작업 면이 오른쪽 컬럼이고, 좁아지면
          같은 면이 아래 서랍으로 접힌다 — 별개의 기능이 아니라 한 면의 두 방향이며, 그 전환은
          뷰포트가 아니라 이 패널의 폭이 정한다(패널은 덱 안에서 얼마든지 좁아진다). */}
      <span className="agent-chat-sr-only" role="status" aria-atomic="true">{answerAnnouncement}</span>
      <div
        className={`agent-chat-split${workOpen ? " is-open" : ""}`}
        ref={splitRef}
        style={workOpen ? ({ "--agent-chat-work": `${Math.round(workRatio * 1000) / 10}%` } as React.CSSProperties) : undefined}
      >
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
            className={`agent-chat-log${awaitingFirstTurn ? " is-inviting" : ""}`}
            ref={logRef}
            role="log"
            aria-label={t("terminal.chat.aria")}
            aria-live="off"
            onScroll={handleScroll}
            {...(tourAnchors ? { "data-chat-tour": "log" } : {})}
          >
        {/* 아직 아무 말도 오가지 않은 패널이 지는 초대. 빈 로그를 그대로 두면 96%가 빈 면이라
            "아직 아무것도 없는 제품"으로 읽힌다 — 이 한 덩어리가 그 자리를 지고, 바로 아래
            가운데에 선 컴포저가 다음 행동을 말한다. 첫 턴이 오면 함께 사라진다. */}
        {awaitingFirstTurn ? (
          <div className="agent-chat-hero">
            <span className="agent-chat-hero-sigil" aria-hidden="true">✳</span>
            <h2 className="agent-chat-hero-title">{t("terminal.chat.heroTitle")}</h2>
            <p className="agent-chat-hero-body">{t("terminal.chat.heroBody")}</p>
          </div>
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
        {state.turns.map((turn, index) => (
          <ChatTurn
            key={index}
            operationId={context.operationId}
            turn={turn}
            nextContextBefore={state.turns[index + 1]?.contextBefore}
            language={language}
            timeFormat={timeFormat}
            streaming={index === state.turns.length - 1 && turn.state === "working"}
            jobsByToolUse={jobsByToolUse}
            onOpenJob={showJob}
            onAnswer={state.answerAsk}
          />
        ))}
        {state.errorCode === "chat_turn_failed"
          ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.turnFailed")}</div>
          : null}
        {stopFailed
          ? <div className="agent-chat-sys agent-chat-sys--error" role="alert">{t("terminal.chat.stopFailed")}</div>
          : null}
        {state.connection === "lost"
          ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.connectionLost")}</div>
          : null}
        {terminalError !== "none"
          ? (
            <div className="agent-chat-sys agent-chat-sys--error" role="alert">
              <span aria-hidden="true">{terminalError === "busy" ? "⚠" : "✕"}</span>{" "}
              {t(terminalError === "busy" ? "terminal.chat.openTerminalBusy" : "terminal.chat.openTerminalFailed")}
            </div>
          )
          : null}
          </div>

          {/* 자리를 세운 동안만 로그 하단 중앙에 선다. 라벨은 Follow — Analyst FOLLOW UP 과
              다른 물건이고, 안 읽은 수는 Wave 2. 회신 말풍선은 우하단을 지킨다.
              떠 있는 컨트롤은 전부 대화 면 안에 산다 — 패널 전체에 걸어 두면 작업 면이 열린
              순간 그 위로 넘어가, 도구 표를 회신 버튼이 덮는다. */}
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

          {/* 백그라운드 작업 표시는 이제 로그 위에 떠 있지 않다 — 컴포저 툴 행의 글리프
              (attach 왼쪽)로 옮겨 가, 로그와 컴포저의 이음새에 걸터앉던 부유 크롬의 소속
              모호함을 없앴다. 상태·문은 아래 AgentChatComposer의 work prop이 진다. */}

          </div>

          {/* 이 패널에 귀속된 축약 컴포저 — 읽던 자리에서 바로, 언제나 서 있다. 말풍선 문
              (Quick Launch로 가는 회신 버튼)은 이 컴포저가 대체했다 — Quick Launch 멘션
              전달은 여전히 살아 있는 별도 경로다. */}
          <AgentChatComposer
            context={context}
            coordinate={<SessionCoordinate coordinates={coordinates} t={t} />}
            meter={<ContextMeterChip context={state.context} working={turnRunning} language={language} openSignal={meterOpenSignal} />}
            coordinates={coordinates}
            onOpenContextMeter={() => setMeterOpenSignal((signal) => signal + 1)}
            tourAnchor={tourAnchors}
            turnRunning={turnRunning}
            stopping={stopping}
            queue={state.queue}
            work={{
              running: openJobs.length,
              hasJobs,
              open: workOpen,
              controlsId: `${paneId}-work`,
              onOpen: openWork,
            }}
            onStop={handleStop}
            onCancelQueued={handleCancelQueued}
          />

          {/* 첫 턴 전 컴포저를 가운데로 올려 두는 받침. 첫 턴이 오면 flex-grow가 0으로 줄며
              컴포저가 하단으로 내려앉는다 — 움직이는 것은 컴포저 하나이고, 컴포저 자신은 언제나
              in-flow라 대화의 마지막 줄을 덮지 않는다. 높이를 직접 애니메이션하지 않는 이유는
              패널 높이가 사용자 손에 달려 있어서다: 비율로 두면 어떤 높이에서도 같은 자리다. */}
          <div className={`agent-chat-settle${awaitingFirstTurn ? " is-inviting" : ""}`} aria-hidden="true" />
        </div>

        {workOpen ? (
          <>
            {/* 두 면의 비율을 손으로 정한다. 방향은 CSS가 정하고 이 손잡이는 그 방향을 읽어
                따른다 — 컬럼과 서랍이 서로 다른 컨트롤을 갖지 않게. */}
            <div
              className="agent-chat-grip"
              role="separator"
              tabIndex={0}
              aria-orientation={workStacked ? "horizontal" : "vertical"}
              aria-label={t("terminal.chat.gripAria")}
              aria-valuemin={18}
              aria-valuemax={78}
              aria-valuenow={Math.round(workRatio * 100)}
              aria-valuetext={t("terminal.chat.gripValue", { percent: Math.round(workRatio * 100) })}
              onKeyDown={onGripKeyDown}
              onPointerDown={onGripDown}
            />
            <WorkPanel
              id={`${paneId}-work`}
              jobs={state.jobs}
              job={selectedJob}
              openJobs={openJobs}
              operationId={context.operationId}
              language={language}
              onOpen={setOpenJobId}
              onBack={() => setOpenJobId(null)}
              onCollapse={collapseWork}
            />
          </>
        ) : null}
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
  const hasSettledWork = !working && (view.ledger.length > 0 || view.changes.length > 0);
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
            {turn.dispatch.at !== undefined ? <span>{timeFormat.format(new Date(turn.dispatch.at))}</span> : null}
          </div>
          <div className="agent-chat-dispatch-bubble">{turn.dispatch.text}</div>
        </div>
      ) : null}
      {turn.items.length > 0 || working || view.answer !== null ? (
        <div className={`agent-chat-turn is-${turn.state}`}>
          <div className="agent-chat-turn-spine" aria-hidden="true"><span className="agent-chat-turn-node" /></div>
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
                    읽히므로, 원장 꼬리에 살아 있다는 사실 하나를 남긴다(내용은 싣지 않는다). */}
                <Ledger
                  operationId={operationId}
                  items={view.ledger}
                  language={language}
                  jobsByToolUse={jobsByToolUse}
                  onOpenJob={onOpenJob}
                  onAnswer={onAnswer}
                  working
                  pending={view.streamingText === null
                    && !view.ledger.some((item) => item.state === "running")
                    // 답을 기다리는 동안에는 아무도 생각하지 않는다 — 카드 아래에서 링이 계속 돌면
                    // 화면이 두 사실을 동시에 말하고, 사용자는 자기 차례인지 알 수 없다.
                    && !view.awaiting}
                />
              </>
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
    <span className="agent-chat-live-text" aria-hidden="true">
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
}: {
  readonly operationId: string;
  readonly items: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
  readonly jobsByToolUse: ReadonlyMap<string, AgentChatJob>;
  readonly onOpenJob: (id: string) => void;
  readonly onAnswer: AgentChatViewState["answerAsk"];
  /** 진행 중인 턴인가 — 마지막 구간을 열어 둘지, 전부 접을지를 가른다. */
  readonly working?: boolean;
  /** 원장 꼬리에 "아직 살아 있다" 한 줄을 세운다 — 도구도 글자도 없는 구간의 유일한 신호다. */
  readonly pending?: boolean;
}) {
  const t = getT(language);
  const hasJob = React.useCallback(
    (item: AgentChatTurnItem) => item.id !== undefined && jobsByToolUse.has(item.id),
    [jobsByToolUse],
  );
  const segments = segmentAgentChatLedger(items, hasJob);
  if (segments.length === 0 && !pending) return null;
  return (
    <div className="agent-chat-ledger">
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
                    {...(at === liveTallyAt ? { live: true, tails } : {})}
                  />
                );
              }
              if (part.kind === "job") {
                return <JobAnchor key={at} item={part.item} language={language} jobsByToolUse={jobsByToolUse} onOpenJob={onOpenJob} />;
              }
              return part.item.type === "ask" && part.item.ask
                ? <AskCard key={`ask-${part.item.ask.id}`} ask={part.item.ask} language={language} onAnswer={onAnswer} />
                : <Step key={at} item={part.item} language={language} live={live} />;
            })}
            {tails.length > 0 && liveTallyAt < 0
              ? <Tally groups={[]} folded={[]} language={language} live tails={tails} />
              : null}
          </div>
        );
      })}
      {pending ? (
        <div className="agent-chat-step is-running">
          <span className="agent-chat-step-orbit" aria-hidden="true" />
          <span className="agent-chat-step-verb agent-chat-live-text" role="status">{t("terminal.chat.stepThinking")}</span>
        </div>
      ) : null}
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
function runningTails(parts: readonly AgentChatLedgerPart[]): ReadonlySet<AgentChatLedgerPart> {
  const hoisted = new Set<AgentChatLedgerPart>();
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    const part = parts[at];
    if (part === undefined) break;
    if (part.kind === "job") continue;
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
  live = false,
  tails = [],
}: {
  readonly groups: readonly AgentChatStepGroup[];
  readonly folded: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
  /** 도는 턴의 꼬리 집계인가 — 링과 물결을 얻고, 펼침 안에 진행 중 스텝까지 함께 든다. */
  readonly live?: boolean;
  /** 지금 도는 스텝들. 이 줄의 꼬리로 붙어 "무엇을 하는 중인지"를 말한다(병렬 배치는 여럿이다). */
  readonly tails?: readonly AgentChatTurnItem[];
}) {
  const t = getT(language);
  // 셀 것도 도는 것도 없으면 줄이 아니다. 도는 것만 있는 구간(도구로 시작한 구간)에서는 집계가
  // 비어도 이 줄이 서야 한다 — 그러지 않으면 그 스텝들이 다시 자기 행을 갖는다.
  if (groups.length === 0 && tails.length === 0) return null;
  const clauses = groups.map((group, index) => (
    <React.Fragment key={`${group.family}-${group.name ?? ""}`}>
      {index > 0 ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span> : null}
      <span className="agent-chat-tally-clause">
        <span className="agent-chat-tally-glyph" aria-hidden="true">{familyGlyph(group.family)}</span>
        {/* 알려진 계열은 문구 하나로 끝나지만, `other`는 도구 이름이 곧 주어다. 그 이름만 따로
            그려 한 단 밝은 잉크를 지운다 — 접히지 않은 스텝 줄의 동사가 이미 그 잉크를 쓰므로,
            이것은 새 문법이 아니라 두 줄을 같은 문법으로 되돌리는 것이다. */}
        {group.family === "other" && group.name !== undefined
          ? <span className="agent-chat-tally-name">{group.name}</span>
          : null}
        <span>{groupLabel(group, t)}</span>
      </span>
    </React.Fragment>
  ));
  // 라이브 줄은 자기가 살아 있다고 스스로 말해야 한다. 예전에는 최근 여덟 줄이 흘러가는 것
  // 자체가 그 증거였는데, 그 증거가 읽는 자리의 절반을 먹었다 — 이제 링과 좌→우 물결, 그리고
  // 지금 도는 도구의 이름 하나가 같은 말을 한 줄로 한다.
  // 도는 스텝은 전부 이 줄의 꼬리가 된다 — 병렬 배치의 N개도 행이 아니라 절이다.
  const running = live ? tails : [];
  const body = [...folded, ...running];
  const line = (
    <>
      {live ? <span className="agent-chat-step-orbit" aria-hidden="true" /> : null}
      <span className={live ? "agent-chat-tally-text agent-chat-live-text" : "agent-chat-tally-text"}>
        {clauses}
        {running.length > 0 ? (
          // 라이브 리전은 이 묶음 하나다 — 절마다 걸면 배치 하나가 N번 낭독된다.
          <span className="agent-chat-tally-running" role="status">
            {running.map((item, index) => (
              <React.Fragment key={index}>
                {index > 0 || clauses.length > 0
                  ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span>
                  : null}
                <span className="agent-chat-tally-clause">
                  <span className="agent-chat-tally-glyph" aria-hidden="true">{familyGlyph(agentChatToolFamily(item.name))}</span>
                  <span>{`${runningVerb(item.name ?? "", language)}${item.detail !== undefined && item.detail.length > 0 ? ` ${item.detail}` : ""}`}</span>
                </span>
              </React.Fragment>
            ))}
          </span>
        ) : null}
      </span>
    </>
  );
  // 펼칠 것이 없으면 눌리는 척하지 않는다 — 열쇠 없는 자물쇠는 어포던스가 아니라 거짓말이다.
  if (body.length === 0) return <div className={`agent-chat-tally${live ? " is-live" : ""}`}>{line}</div>;
  return (
    <details className="agent-chat-tally-fold">
      <summary className={`agent-chat-tally${live ? " is-live" : ""}`} aria-label={t("terminal.chat.tallyAria")}>
        {line}
        <span className="agent-chat-tally-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="agent-chat-tally-body">
        {body.map((item, index) => (
          <Step key={index} item={item} language={language} />
        ))}
      </div>
    </details>
  );
}

/**
 * 잡을 낳은 호출이 태어난 자리에 남기는 한 줄.
 *
 * 예전에는 여기에 카드가 섰다. 카드의 둘째 줄(종류·누구·토큰·도구·소요)은 작업 면이 이미
 * 같은 값을 더 자세히 지고 있었고, 원장에서는 읽는 흐름을 두 줄짜리 상자로 끊었다. 남는 것은
 * 하나다: **그 잡이 여기서 태어났다**, 그리고 거기로 가는 문. 몸은 작업 면의 것이다.
 */
function JobAnchor({
  item,
  language,
  jobsByToolUse,
  onOpenJob,
}: {
  readonly item: AgentChatTurnItem;
  readonly language: "en" | "ko";
  readonly jobsByToolUse: ReadonlyMap<string, AgentChatJob>;
  readonly onOpenJob: (id: string) => void;
}) {
  const t = getT(language);
  const job = item.id !== undefined ? jobsByToolUse.get(item.id) : undefined;
  if (job === undefined) return <Step item={item} language={language} />;
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
      <span className="agent-chat-job-glyph" aria-hidden="true">{jobGlyph(job.kind)}</span>
      {/* 카드가 제목 자리에 쓰던 값 그대로다. subagent_type(`who`)만 남기면 위임 여러 건이
          "◆ general-purpose"로 똑같아져, 어느 것이 무엇인지 열어 봐야만 알 수 있다 —
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
/**
 * 계열 표식 — 같은 종류의 일이 어디서 몇 번 있었는지를 읽기 전에 **보이게** 한다.
 *
 * 집계 줄은 절이 이어질수록 한 줄짜리 글자 덩어리가 되어, 무엇이 몇 건인지 세려면 문장을
 * 읽어야 했다. 표식이 앞에 서면 세는 일이 읽기가 아니라 훑기가 된다.
 *
 * 알파벳은 제품에 이미 있는 잡 글리프(◆ 위임 · ❯ 셸 · ⣿ 워크플로 · ▪ 그 밖)를 그대로
 * 물려받아 넓힌 것이다 — 같은 일을 두 면이 다른 기호로 부르면 표식이 어휘가 아니라 장식이
 * 된다. 전부 텍스트 표현 문자다: 이모지를 쓰면 자기 색을 들고 와 채널 계약을 깬다.
 */
function familyGlyph(family: string): string {
  return FAMILY_GLYPHS[family] ?? "▪";
}

const FAMILY_GLYPHS: Readonly<Record<string, string>> = {
  read: "▤",
  write: "✚",
  edit: "✎",
  run: "❯",
  inspect: "◉",
  search: "⌕",
  fetch: "↧",
  delegate: "◆",
  workflow: "⣿",
  stop: "■",
  plan: "☰",
  ask: "?",
  propose: "▷",
};

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
}: {
  readonly item: AgentChatTurnItem;
  readonly language: "en" | "ko";
  /** 도는 턴의 꼬리에 홀로 선 줄인가 — 집계가 없는 구간에서는 이 줄이 라이브 줄을 진다. */
  readonly live?: boolean;
}) {
  const t = getT(language);
  const running = item.state === "running";
  const failed = item.state === "fail";
  // 결과를 못 받고 닫힌 스텝은 성공도 실패도 아니다 — 시제도 체크 표시도 붙이지 않는다.
  // 과거형 동사와 ✓, 그리고 입력에서 뽑은 +N은 셋 다 "그 일이 일어났다"는 주장이고,
  // 우리가 아는 것은 호출이 나갔다는 사실뿐이다.
  const unconfirmed = item.state === "done";
  const name = item.name ?? "";
  const verb = running ? runningVerb(name, language) : unconfirmed ? name : pastVerb(name, language);
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
    <div className={`agent-chat-step is-${item.state ?? "done"}`}>
      {running
        ? <span className="agent-chat-step-orbit" aria-hidden="true" />
        : <span className="agent-chat-step-mark" aria-hidden="true">{failed ? "✕" : unconfirmed ? "·" : "✓"}</span>}
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
 */
function jobGlyph(kind: AgentChatJobKind): string {
  if (kind === "agent") return "◆";
  if (kind === "shell") return "❯";
  if (kind === "workflow") return "⣿";
  return "▪";
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

/** 원장 안에 서는 잡 카드. 누르면 Work 탭의 그 잡으로 간다. */
function JobCard({
  job,
  language,
  onOpen,
}: {
  readonly job: AgentChatJob;
  readonly language: "en" | "ko";
  readonly onOpen: (id: string) => void;
}) {
  const t = getT(language);
  return (
    <button
      type="button"
      className={`agent-chat-job ${jobStateClass(job)}`}
      aria-label={t("terminal.chat.workOpenAria")}
      onClick={() => onOpen(job.id)}
    >
      <span className="agent-chat-job-head">
        {job.open
          ? <span className="agent-chat-step-orbit" aria-hidden="true" />
          : <span className="agent-chat-job-mark" aria-hidden="true">{job.status === "failed" ? "✕" : job.status === "completed" ? "✓" : "·"}</span>}
        <span className="agent-chat-job-glyph" aria-hidden="true">{jobGlyph(job.kind)}</span>
        <span className="agent-chat-job-title">{job.title}</span>
        <span className="agent-chat-job-outcome">{jobOutcome(job, language)}</span>
        <span className="agent-chat-job-chev" aria-hidden="true">›</span>
      </span>
      <span className="agent-chat-job-meta">
        {jobMetaParts(job, language).map((part, index) => (
          <React.Fragment key={index}>
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            <span>{part}</span>
          </React.Fragment>
        ))}
        {job.kind === "workflow" && job.stages.length > 0 ? <StageDots stages={job.stages} /> : null}
      </span>
    </button>
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
 * 작업 면 — 잡 목록과 잡 하나의 상세. 둘은 같은 자리에서 갈아 끼워진다.
 *
 * 머리에는 스트립이 앉는다. 면이 열리면 떠 있던 알약이 이 자리로 옮겨 오고, 그것이 곧 접는
 * 문이다 — 눌린 것이 자랐으므로 접는 문도 자란 것 안에 있어야 한다.
 */
function WorkPanel({
  id,
  jobs,
  job,
  openJobs,
  operationId,
  language,
  onOpen,
  onBack,
  onCollapse,
}: {
  readonly id: string;
  readonly jobs: readonly AgentChatJob[];
  readonly job: AgentChatJob | null;
  readonly openJobs: readonly AgentChatJob[];
  readonly operationId: string;
  readonly language: "en" | "ko";
  readonly onOpen: (id: string) => void;
  readonly onBack: () => void;
  readonly onCollapse: () => void;
}) {
  const t = getT(language);
  const open = jobs.filter((entry) => entry.open);
  const settled = jobs.filter((entry) => !entry.open);
  return (
    <section className="agent-chat-work" id={id} aria-label={t("terminal.chat.workAria")}>
      <button
        type="button"
        className={`agent-chat-work-cap${openJobs.length === 0 ? " is-rest" : ""}`}
        aria-expanded
        aria-label={t("terminal.chat.workCollapseAria")}
        onClick={onCollapse}
      >
        {openJobs.length > 0
          ? <span className="agent-chat-strip-orbit" aria-hidden="true" />
          : <span className="agent-chat-strip-dot" aria-hidden="true" />}
        <span className="agent-chat-strip-count">
          {openJobs.length > 0
            ? t("terminal.chat.stripRunning", { count: openJobs.length })
            : settledLabel(jobs.length, t)}
        </span>
        <span className="agent-chat-work-cap-chev" aria-hidden="true">⌄</span>
      </button>
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
                {open.map((entry) => <JobCard key={entry.id} job={entry} language={language} onOpen={onOpen} />)}
              </>
            ) : null}
            {settled.length > 0 ? (
              <>
                <div className="agent-chat-work-sec">{t("terminal.chat.workSettled")} {settled.length}</div>
                {settled.map((entry) => <JobCard key={entry.id} job={entry} language={language} onOpen={onOpen} />)}
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
        <span className="agent-chat-job-glyph" aria-hidden="true">{jobGlyph(job.kind)}</span>
        <span className="agent-chat-detail-title">{job.title}</span>
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
        <JobExtra detail={detail} language={language} />
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
  language,
}: {
  readonly detail: { readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null };
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  if (detail.state === "idle") return null;
  if (detail.state === "loading") {
    return <div className="agent-chat-detail-loading">{t("terminal.chat.jobDetailLoading")}</div>;
  }
  const value = detail.value;
  // 못 읽었다는 것과 비어 있다는 것은 다르다. 전자는 좌표를 못 찾았거나 아직 안 쓰인 것이고,
  // 후자는 그 작업이 정말 아무 도구도 쓰지 않은 것이다 — 둘을 한 문장으로 뭉치면 거짓이 된다.
  if (value === null) {
    return <div className="agent-chat-work-empty">{t("terminal.chat.jobDetailUnavailable")}</div>;
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
        <div className="agent-chat-work-empty">{t("terminal.chat.jobTrailEmpty")}</div>
      </>
    );
  }
  return (
    <>
      <div className="agent-chat-kicker">{t("terminal.chat.jobTrail")} {value.steps.length}</div>
      {value.truncated ? <div className="agent-chat-detail-cut">{t("terminal.chat.jobTrailCut")}</div> : null}
      <div className="agent-chat-trail">
        {value.steps.map((step, index) => (
          // 원장의 스텝과 같은 클래스를 쓴다 — 서브에이전트가 한 일이 이 세션이 한 일과 같은
          // 문법으로 읽혀야, 중첩된 것이 새 화면이 아니라 같은 화면의 한 겹으로 보인다.
          <div key={index} className={`agent-chat-step is-${step.failed === true ? "fail" : "ok"}`}>
            <span className="agent-chat-step-mark" aria-hidden="true">{step.failed === true ? "✕" : "✓"}</span>
            <span className="agent-chat-step-verb">{step.name}</span>
            {step.detail !== undefined ? <span className="agent-chat-step-object">{step.detail}</span> : null}
            {step.outcome !== undefined ? (
              <span className={`agent-chat-step-out${step.failed === true ? " is-error" : ""}`}>{step.outcome}</span>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * 잡 상세를 그 잡을 연 그때 한 번 읽는다.
 *
 * 워크플로는 요청하지 않는다 — 단계 트리가 이미 맥박으로 흐르고 그것이 곧 상세다. 도는 잡도
 * 요청하지 않는다: 전사록과 출력 파일은 작업이 끝난 뒤에야 완결되므로, 도는 중에 읽으면 반쪽을
 * 보여 주고 그게 전부인 것처럼 굳는다.
 *
 * 그런데 "닫혔다"와 "결말이 보고됐다"는 같은 순간이 아니다. 백그라운드 셸은 `task_updated`가
 * `killed`로 먼저 닫고, 출력 파일의 좌표는 그 뒤에 오는 `task_notification`이 들고 온다(실측
 * 순서이며 매퍼에도 그렇게 적혀 있다). 그래서 상세를 열어 둔 채 잡이 끝나면 첫 요청이 좌표보다
 * 먼저 도착해 404를 받고, 좌표가 도착해도 다시 묻지 않아 "기록 없음"이 영영 굳는다.
 *
 * 그래서 결말 보고가 **도착한 횟수**를 의존성에 둔다. 보고의 내용(요약·소요 시간)으로 도착을
 * 추론하면, status만 실은 알림에서는 아무 필드도 바뀌지 않아 상세가 "기록 없음"에 굳는다 —
 * 매퍼가 허용하는 형태이고 테스트도 그 형태를 덮고 있다. 세는 것이 추론보다 정확하다.
 */
function useAgentChatJobDetail(
  operationId: string,
  job: AgentChatJob,
): { readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null } {
  const wanted = (job.kind === "agent" || job.kind === "shell") && !job.open;
  const [result, setResult] = React.useState<{ readonly state: "idle" | "loading" | "ready"; readonly value: AgentChatJobDetail | null }>(
    { state: "idle", value: null },
  );
  React.useEffect(() => {
    if (!wanted) {
      setResult({ state: "idle", value: null });
      return;
    }
    let live = true;
    setResult({ state: "loading", value: null });
    const controller = new AbortController();
    void readAgentChatJobDetail(operationId, job.id, controller.signal)
      .then((value) => { if (live) setResult({ state: "ready", value }); })
      .catch(() => { if (live) setResult({ state: "ready", value: null }); });
    return () => {
      live = false;
      controller.abort();
    };
  }, [operationId, job.id, wanted, job.ends]);
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
  return family === "other"
    ? t("terminal.chat.activityUsing", { name })
    : t(`terminal.chat.verb.${family}.now` as Parameters<typeof t>[0]);
}

function pastVerb(name: string, language: "en" | "ko"): string {
  const t = getT(language);
  const family = agentChatToolFamily(name);
  return family === "other" ? name : t(`terminal.chat.verb.${family}.past` as Parameters<typeof t>[0]);
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
