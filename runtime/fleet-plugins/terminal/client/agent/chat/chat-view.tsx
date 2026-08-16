import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { getT } from "../../i18n/index.js";
import { AgentApiError, readAgentChatJobDetail } from "../api.js";
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
  type AgentChatStepGroup,
  type AgentChatTurn,
  type AgentChatTurnItem,
} from "./chat-events.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

/**
 * Chat Mode의 Operation 본문 — 지휘 로그.
 *
 * 대화 입력창은 없다: 지시는 Quick Launch 멘션으로만 들어온다(제품 결정). 다만 모델이 멈춰 서서
 * 물으면 그 자리에 카드가 서고, 카드 안에서 답한다 — 이 패널은 터미널을 대신하는 에이전트 실행
 * 환경이고, 에이전트가 물었을 때 답하는 것은 그 환경의 기본 기능이다. 카드의 입력은 새 턴을
 * 만들지 않고 지금 그 질문에만 살며, 답하면 사라진다.
 *
 * 턴의 표현 문법은 두 국면이다. 진행 중에는 **라이브 원장**이 선다 — 이 턴이 건드린 파일이
 * 맨 위에 스트립으로 서고, 그 아래로 스텝이 쌓이며, 각 스텝은 이름·좌표·결과를 차례로
 * 채워 간다. 지나간 스텝과 흘러나온 문장은 화면에서 사라지지 않는다. 끝나면 Answer 앞의
 * 전부가 `{duration} 동안 작업함` 한 줄로 접히고, 그 줄 오른쪽의 아이콘이 다시 편다.
 * 접힘은 실패를 삼키지 않는다 — 실패한 스텝이 있으면 그 수가 접힌 줄에 남는다.
 */
export function AgentChatView({
  context,
  onOpenTerminal,
  tourAnchors,
  leadingChip,
}: {
  readonly context: OperationRenderContext;
  readonly onOpenTerminal: () => Promise<void>;
  /** 사용자가 이 마운트에서 직접 채팅 뷰를 연 경우에만 true — 투어 앵커 렌더 여부를 결정한다. */
  readonly tourAnchors: boolean;
  /** 칩 줄의 선행 칩(Analyst 진입) — 뷰 전환 칩과 같은 줄에 나란히 선다. */
  readonly leadingChip?: React.ReactNode;
}) {
  const t = getT(context.language ?? "en");
  const state = useAgentChatStream(context.operationId, context.bodyLive !== false);
  // 현재 작업 여부의 권위는 호스트가 쥔 런타임 축 하나다 — 이 뷰가 따로 축을 주장하면 열려 있는
  // 동안만 정직해지고, 패널을 닫는 순간 사이드바가 다시 휴면으로 돌아간다. 축이 degraded면 호스트가
  // null 을 건네므로 진행 중이라고 주장하지 않는다(그 사실은 전역 배너가 말한다).
  const runtime = context.runtimeState;
  const working = runtime?.lifecycle === "live" && runtime.activity === "running";
  const [terminalPending, setTerminalPending] = React.useState(false);
  const [terminalError, setTerminalError] = React.useState<"none" | "busy" | "failed">("none");
  const [stopping, setStopping] = React.useState(false);
  // 바닥을 따라가는 중인지 — 칩 가시성의 권위. ref 와 같은 값이지만, 스크롤이 바꾼 뒤에는
  // 그려져야 하므로 state 로도 둔다.
  const [following, setFollowing] = React.useState(true);
  // 두 번째 목적지는 **나란히** 선다. 탭 교체는 대화를 통째로 숨겼는데, 백그라운드 작업은
  // 대화를 대신하는 것이 아니라 대화 옆에서 동시에 도는 것이다 — 동시에 일어나는 두 가지 앞에서
  // 하나를 고르라고 요구하면, 무엇이 도는지 보려고 무엇을 물었는지를 잃는다.
  const [workOpen, setWorkOpen] = React.useState(false);
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

  const handleOpenTerminal = React.useCallback(async () => {
    setTerminalPending(true);
    setTerminalError("none");
    try {
      await onOpenTerminal();
    } catch (error) {
      // 왜 안 되는지가 다음 행동을 가른다 — 진행 중인 턴은 기다리면 풀리고, 그 밖의 실패는 아니다.
      setTerminalError(error instanceof AgentApiError && error.message === "chat_busy" ? "busy" : "failed");
    } finally {
      setTerminalPending(false);
    }
  }, [onOpenTerminal]);

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
  }, []);

  const handleFollow = React.useCallback(() => {
    nearBottomRef.current = true;
    bottomDistanceRef.current = null;
    setFollowing(true);
    const log = logRef.current;
    if (log) applyScrollTop(log.scrollHeight);
  }, [applyScrollTop]);


  const timeFormat = React.useMemo(
    () => new Intl.DateTimeFormat(context.language === "ko" ? "ko" : "en", { hour: "2-digit", minute: "2-digit" }),
    [context.language],
  );

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
  // 스트립과 작업 면을 잇는 좌표. 한 화면에 채팅 패널이 여럿 열릴 수 있으므로 마운트마다 고유해야 한다.
  const paneId = React.useId();
  // 잡을 한 번이라도 낳은 세션에만 문이 선다. 하나도 없으면 스트립도 작업 면도 크롬일 뿐이다.
  const hasJobs = state.jobs.length > 0;
  // 마지막 턴이 도는가 — 중지 버튼의 권위. 호스트 런타임 축은 백그라운드 대기까지 working으로
  // 읽으므로 여기서는 쓰지 않는다: 끊을 턴이 없는데 서 있는 중지 버튼은 눌러도 409를 받는다.
  const turnRunning = state.turns.at(-1)?.state === "working";

  const collapseWork = React.useCallback(() => {
    setWorkOpen(false);
    setOpenJobId(null);
  }, []);

  const handleStop = React.useCallback(async (): Promise<void> => {
    setStopping(true);
    try {
      await state.stopTurn();
    } catch {
      // 실패해도 따로 말하지 않는다. 이 버튼이 실패하는 경우는 사실상 "이미 끝났다" 하나이고,
      // 그 사실은 턴이 스스로 닫히면서 화면에 말한다 — 오류 줄을 더하면 같은 사건이 두 번 읽힌다.
    } finally {
      setStopping(false);
    }
  }, [state.stopTurn]);

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
      setWorkRatio(Math.min(0.78, Math.max(0.18, raw)));
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }, []);

  return (
    <section className="agent-chat" aria-label={t("terminal.chat.aria")}>
      {/* 대화 면과 작업 면이 나란히 산다. 넓은 패널에서는 작업 면이 오른쪽 컬럼이고, 좁아지면
          같은 면이 아래 서랍으로 접힌다 — 별개의 기능이 아니라 한 면의 두 방향이며, 그 전환은
          뷰포트가 아니라 이 패널의 폭이 정한다(패널은 덱 안에서 얼마든지 좁아진다). */}
      <div
        className={`agent-chat-split${workOpen ? " is-open" : ""}`}
        ref={splitRef}
        style={workOpen ? ({ "--agent-chat-work": `${Math.round(workRatio * 1000) / 10}%` } as React.CSSProperties) : undefined}
      >
        <div className="agent-chat-pane">
          {/* 터미널 복귀는 터미널 뷰의 채팅 전환 칩과 같은 문법이다 — 두 뷰가 서로를 같은
              자리·같은 모양의 떠 있는 칩으로 가리켜, 전환이 한 쌍의 동작으로 읽힌다.
              띠바를 두면 채팅 본문이 패널 면과 다른 면 위에 앉아 창이 두 장으로 갈린다.
              Analyst 진입 칩이 선행하면 같은 줄에 나란히 선다.
              이 줄이 대화 면 **안에** 사는 이유는 실측이다: 패널 전체에 걸어 두면 작업 면이 열린
              순간 그 오른쪽 위로 넘어가 접기 컨트롤을 덮고, 히트 테스트가 칩을 집는다. */}
          <div className="agent-view-chip-row">
            {leadingChip}
            <ContextMeterChip context={state.context} working={working} language={language} />
            <button
              type="button"
              className="agent-chat-mode-chip"
              {...(tourAnchors ? { "data-chat-tour": "terminal" } : {})}
              disabled={terminalPending}
              aria-label={t("terminal.chat.openTerminalAria")}
              onClick={() => { void handleOpenTerminal(); }}
            >
              <span aria-hidden="true">❯</span> {terminalPending ? t("terminal.chat.openingTerminal") : t("terminal.chat.openTerminal")}
            </button>
          </div>

          {/* data-chat-tour는 코어 feature-tour 카탈로그가 짚는 크로스 번들 앵커 계약이다 —
              사용자가 직접 전환해 들어온 마운트에서만 세워, 리로드로 복원된 채팅 패널이
              콘솔 로드 화면에서 투어를 발화시키지 않게 한다. */}
          <div
            className="agent-chat-log"
            ref={logRef}
            onScroll={handleScroll}
            {...(tourAnchors ? { "data-chat-tour": "log" } : {})}
          >
        {/* 시드를 못 세운 세션은 스트림이 오류 하나를 쓰고 닫는다 — 그 뒤로 아무 이벤트도 오지
            않으므로, 이 분기가 없으면 패널은 "연결하는 중…"에 영원히 머문다. 고착된 스피너는
            상태가 아니다: 무엇이 없고 어디로 가야 하는지 말하고, 위 터미널 전환 칩이 그 출구다. */}
        {state.errorCode === "chat_transcript_missing"
          ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.transcriptMissing")}</div>
          : state.connection === "connecting" && state.turns.length === 0
            ? <div className="agent-chat-sys">{t("terminal.chat.connecting")}</div>
            : null}
        {state.replayedTurns > 0
          ? <div className="agent-chat-sys">{t("terminal.chat.replayed", { count: state.replayedTurns })}</div>
          : null}
        {state.errorCode === "chat_replay_unavailable"
          ? <div className="agent-chat-sys agent-chat-sys--warn">{t("terminal.chat.replayUnavailable")}</div>
          : null}
        {state.turns.map((turn, index) => (
          <ChatTurn
            key={index}
            operationId={context.operationId}
            turn={turn}
            previousContextTotal={state.turns[index - 1]?.contextTotal}
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
              aria-label={t("terminal.chat.followAria")}
              onClick={handleFollow}
            >
              {t("terminal.chat.follow")}
            </button>
          ) : null}

          {/* 살아 있는 잡이 있는 동안만 서는 한 줄. 읽는 자리가 어디든 "지금 나를 위해 도는 일이
              있다"를 말하고, 그 자체가 작업 면을 여는 문이다 — 읽고 끝나는 표시가 아니다.
              면이 열리면 이 줄은 사라지고 면의 머리가 같은 내용을 진다: 떠 있는 알약으로 남으면
              열린 면의 첫 줄을 덮고, 접는 문이 자란 것 밖에 서게 된다.
              Follow 칩과 같은 하단 중앙을 쓰므로 한 층 위에 선다(CSS가 두 높이를 가른다). */}
          {!workOpen && openJobs.length > 0 ? (
            <button
              type="button"
              className="agent-chat-strip"
              aria-label={t("terminal.chat.stripAria")}
              aria-expanded={false}
              aria-controls={`${paneId}-work`}
              onClick={() => { setOpenJobId(null); setWorkOpen(true); }}
            >
              <span className="agent-chat-strip-orbit" aria-hidden="true" />
              <span className="agent-chat-strip-count">{t("terminal.chat.stripRunning", { count: openJobs.length })}</span>
              <span className="agent-chat-strip-names">
                {openJobs.map((job) => `${jobGlyph(job.kind)} ${job.who ?? job.title}`).join("  ·  ")}
              </span>
              <span className="agent-chat-strip-chev" aria-hidden="true">⌃</span>
            </button>
          ) : null}

          {/* 잡을 한 번이라도 낳았지만 지금 도는 것이 없을 때의 문. 스트립이 살아 있는 잡만
              말하므로, 이것이 없으면 끝난 잡에 닿을 길이 사라진다(탭이 지던 몫이다). */}
          {!workOpen && hasJobs && openJobs.length === 0 ? (
            <button
              type="button"
              className="agent-chat-strip is-rest"
              aria-label={t("terminal.chat.stripAria")}
              aria-expanded={false}
              aria-controls={`${paneId}-work`}
              onClick={() => { setOpenJobId(null); setWorkOpen(true); }}
            >
              <span className="agent-chat-strip-dot" aria-hidden="true" />
              <span className="agent-chat-strip-count">{settledLabel(state.jobs.length, t)}</span>
              <span className="agent-chat-strip-chev" aria-hidden="true">⌃</span>
            </button>
          ) : null}

          {/* 도는 턴을 끊는 문. 이 문은 턴만 닫는다 — 이미 태어난 백그라운드 작업은 계속 살고
              잡 표면이 그것을 그대로 말한다(잡 하나만 멈추는 제어 경로는 SDK에 없다). */}
          {turnRunning ? (
            <button
              type="button"
              className="agent-chat-stop"
              aria-label={t("terminal.chat.stopAria")}
              title={t("terminal.chat.stopTitle")}
              disabled={stopping}
              onClick={() => { void handleStop(); }}
            >
              <span className="agent-chat-stop-mark" aria-hidden="true" />
              {t("terminal.chat.stop")}
            </button>
          ) : null}

          {/* 아직 아무 턴도 없는 세션에서는 이 문이 곧 유일한 다음 행동이다. 본문 한가운데의
              안내 문장 대신 그 문 자체를 초대 상태로 세운다 — 읽고 나서 어디를 눌러야 하는지
              다시 찾게 만들지 않기 위해서다. 닫는 수단은 두지 않는다: 첫 턴이 시작되면 상태가
              스스로 지나가고, 그전까지는 계속 참인 안내다. */}
          {awaitingFirstTurn ? (
            <p className="agent-chat-invite" aria-hidden="true">{t("terminal.chat.emptyInvite")}</p>
          ) : null}
          {/* 회신은 이 패널을 읽던 사람이 이어서 하는 일이므로 어포던스도 본문 안에 선다. 누르면
              호스트 컴포저가 이 Operation을 행선지로 들고 열린다 — 여기는 입력창이 아니라 그리로
              가는 문이다(이 뷰에 입력창을 두지 않는다는 결정은 그대로다). */}
          <button
            type="button"
            className={awaitingFirstTurn ? "agent-chat-reply agent-chat-reply--inviting" : "agent-chat-reply"}
            {...(tourAnchors ? { "data-chat-tour": "composer" } : {})}
            aria-label={t(awaitingFirstTurn ? "terminal.chat.emptyInviteAria" : "terminal.chat.replyAria")}
            title={t(awaitingFirstTurn ? "terminal.chat.emptyInvite" : "terminal.chat.replyTitle")}
            onClick={() => { context.composer.open({ mentionOperationId: context.operationId }); }}
          >
            <ReplyBubbleIcon />
          </button>
        </div>

        {workOpen ? (
          <>
            {/* 두 면의 비율을 손으로 정한다. 방향은 CSS가 정하고 이 손잡이는 그 방향을 읽어
                따른다 — 컬럼과 서랍이 서로 다른 컨트롤을 갖지 않게. */}
            <div
              className="agent-chat-grip"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("terminal.chat.gripAria")}
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

/** 회신 버튼의 말풍선 — 꼬리는 왼쪽 아래로, 몸통은 둥근 모서리 하나로 읽히게. */
function ReplyBubbleIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M6.4 15.6H6a3 3 0 0 1-3-3V7.6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H9.6l-3.2 2.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatTurn({
  operationId,
  turn,
  previousContextTotal,
  language,
  timeFormat,
  streaming,
  jobsByToolUse,
  onOpenJob,
  onAnswer,
}: {
  readonly operationId: string;
  readonly turn: AgentChatTurn;
  /** 바로 앞 턴이 끝났을 때의 문맥 총량. 이 턴의 증가분은 그것과의 차이다. */
  readonly previousContextTotal: number | undefined;
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
  // 앞뒤 어느 한쪽이라도 스냅숏이 없으면 증가분을 짓지 않는다 — 그 사이에 다른 턴의 몫이 섞이고,
  // 섞인 값은 "이 턴이 이만큼 먹었다"는 이 줄의 유일한 주장을 거짓으로 만든다.
  const contextGrew = turn.contextTotal !== undefined && previousContextTotal !== undefined
    ? turn.contextTotal - previousContextTotal
    : undefined;
  return (
    <>
      {turn.dispatch ? (
        <div className="agent-chat-dispatch">
          <div className="agent-chat-dispatch-meta">
            <span className="agent-chat-dispatch-via">{t("terminal.chat.viaQuickLaunch")}</span>
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
            ) : view.ledger.length > 0 || view.changes.length > 0 ? (
              <WorkFold
                durationMs={turn.durationMs}
                failed={view.failed}
                running={stillRunning}
                error={turn.state === "error"}
                stopped={turn.state === "stopped"}
                contextGrew={contextGrew}
                language={language}
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
              <div className="agent-chat-answer">
                <div className="agent-chat-answer-kicker">{t("terminal.chat.answerLabel")}</div>
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

/** 진행 중 턴 헤드의 라이브 티커 — 시각 전용이라 라이브 리전이 아니다(매초 재낭독 방지). */
function TurnElapsedLabel({
  turn,
  language,
}: {
  readonly turn: AgentChatTurn;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const elapsedMs = useTurnElapsedMs(turn.startedAt, turn.state === "working");
  return <span aria-hidden="true">{t("terminal.chat.turnWorking", { elapsed: formatElapsed(elapsedMs) })}</span>;
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
/**
 * 진행 중에 순서대로 남겨 두는 평범한 완료 스텝의 수. 방금 무엇을 했는지가 보여야 "일하는 중"으로
 * 읽히지만, 스무 건짜리 턴을 통째로 세우면 다시 벽이 된다 — 최근 것만 남기고 나머지는 앞머리
 * 한 줄로 접는다. 턴이 끝나면 이 창도 닫히고 전부 집계가 된다.
 */
const LIVE_STEP_WINDOW = 8;

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
  // 잡을 낳은 스텝은 접지 않는다 — "위임 1건"으로 접히면 그 잡으로 가는 문이 사라진다. 다만
  // 구간에서 꺼내지도 않는다: 원장의 구간을 가르는 것은 모델의 문장이고, 꺼내면 그 잡을 부른
  // 문장보다 위에 서서 어느 의도가 그것을 낳았는지가 사라진다. 실패·Theater 밖 스텝과 같은
  // "줄을 지키는 예외"로 세그먼터에 넘긴다.
  const pinned = React.useCallback(
    (item: AgentChatTurnItem) => item.id !== undefined && jobsByToolUse.has(item.id),
    [jobsByToolUse],
  );
  const segments = segmentAgentChatLedger(items, working ? LIVE_STEP_WINDOW : 0, pinned);
  if (segments.length === 0 && !pending) return null;
  const step = (item: AgentChatTurnItem, key: string): React.ReactNode => (
    <Step key={key} item={item} language={language} jobsByToolUse={jobsByToolUse} onOpenJob={onOpenJob} />
  );
  return (
    <div className="agent-chat-ledger">
      {segments.map((segment, index) => (
        <div className="agent-chat-segment" key={index}>
          {segment.note !== undefined ? (
            <StreamedMarkdown
              className="agent-chat-ledger-note markdown-body"
              text={segment.note}
              streaming={false}
              language={language}
            />
          ) : null}
          <Tally groups={segment.groups} folded={segment.folded} language={language} jobsByToolUse={jobsByToolUse} onOpenJob={onOpenJob} />
          {segment.inline.map((item, at) => (item.type === "ask" && item.ask
            ? <AskCard key={`ask-${item.ask.id}`} ask={item.ask} language={language} onAnswer={onAnswer} />
            : step(item, `in-${at}`)))}
          {segment.running.map((item, at) => step(item, `run-${at}`))}
        </div>
      ))}
      {pending ? (
        <div className="agent-chat-step is-running">
          <span className="agent-chat-step-orbit" aria-hidden="true" />
          <span className="agent-chat-step-verb" role="status">{t("terminal.chat.stepThinking")}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 끝난 평범한 스텝의 한 줄 집계 — "파일 2개 읽음 · 셸 1회 실행". 도구를 하나하나 세우면 긴 턴이
 * 읽히지 않으므로 일상은 여기로 접히고, 예외(진행 중·실패·Theater 밖)만 자기 줄을 지킨다.
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
}: {
  readonly groups: readonly AgentChatStepGroup[];
  readonly folded: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
  readonly jobsByToolUse: ReadonlyMap<string, AgentChatJob>;
  readonly onOpenJob: (id: string) => void;
}) {
  const t = getT(language);
  if (groups.length === 0) return null;
  const clauses = groups.map((group, index) => (
    <React.Fragment key={`${group.family}-${group.name ?? ""}`}>
      {index > 0 ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span> : null}
      {/* 알려진 계열은 문구 하나로 끝나지만, `other`는 도구 이름이 곧 주어다. 그 이름만 따로
          그려 한 단 밝은 잉크를 지운다 — 접히지 않은 스텝 줄의 동사가 이미 그 잉크를 쓰므로,
          이것은 새 문법이 아니라 두 줄을 같은 문법으로 되돌리는 것이다. */}
      {group.family === "other" && group.name !== undefined
        ? <span className="agent-chat-tally-name">{group.name}</span>
        : null}
      <span>{groupLabel(group, t)}</span>
    </React.Fragment>
  ));
  // 펼칠 것이 없으면 눌리는 척하지 않는다 — 열쇠 없는 자물쇠는 어포던스가 아니라 거짓말이다.
  if (folded.length === 0) return <div className="agent-chat-tally">{clauses}</div>;
  return (
    <details className="agent-chat-tally-fold">
      <summary className="agent-chat-tally" aria-label={t("terminal.chat.tallyAria")}>
        {clauses}
        <span className="agent-chat-tally-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="agent-chat-tally-body">
        {folded.map((item, index) => (
          <Step key={index} item={item} language={language} jobsByToolUse={jobsByToolUse} onOpenJob={onOpenJob} />
        ))}
      </div>
    </details>
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
        </div>
      ))}
    </>
  );
}

/** 스텝 한 줄 — 동사·좌표·결과. 진행 중인 줄만 라이브 리전으로 읽힌다. */
function Step({
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
  // 잡을 낳은 호출은 한 줄이 아니라 카드로 선다. 한 줄은 "그 호출이 성공했다"까지만 말할 수
  // 있는데, 사용자가 알아야 하는 것은 그 뒤에 도는 일이다.
  if (job !== undefined) return <JobCard job={job} language={language} onOpen={onOpenJob} />;
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
      <span className="agent-chat-step-verb" {...(running ? { role: "status" } : {})}>{verb}</span>
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
 * 실패한 스텝 수만 예외다 — 접힘이 실패를 삼키면 이 문법을 세운 이유가 사라진다.
 */
function WorkFold({
  durationMs,
  failed,
  running,
  error,
  stopped,
  contextGrew,
  language,
  children,
}: {
  readonly durationMs: number | undefined;
  readonly failed: number;
  /** 이 턴이 낳은 잡 중 아직 도는 것의 수. 접힘이 이것을 삼키면 접힘이 곧 거짓말이 된다. */
  readonly running: number;
  readonly error: boolean;
  /** 사용자가 끊은 턴. 실패와 같은 잉크를 쓰지 않는다 — 고칠 것이 없는 결말이다. */
  readonly stopped: boolean;
  /** 이 턴이 문맥 창에 더한 토큰. 앞 턴의 좌표가 없으면 undefined이고, 그때는 서지 않는다. */
  readonly contextGrew: number | undefined;
  readonly language: "en" | "ko";
  readonly children: React.ReactNode;
}) {
  const t = getT(language);
  const label = durationMs !== undefined
    ? t("terminal.chat.workedFor", { duration: formatDuration(durationMs) })
    : t("terminal.chat.workedLabel");
  return (
    <details className="agent-chat-fold" {...(running > 0 ? { open: true } : {})}>
      <summary aria-label={t("terminal.chat.foldAria")}>
        <span className="agent-chat-fold-label">{label}</span>
        {running > 0 ? <span className="agent-chat-fold-running">{t("terminal.chat.foldRunning", { count: running })}</span> : null}
        {failed > 0 ? <span className="agent-chat-fold-failed">{t("terminal.chat.foldFailed", { count: failed })}</span> : null}
        {stopped ? <span className="agent-chat-fold-stopped">{t("terminal.chat.foldTurnStopped")}</span> : null}
        {failed === 0 && error ? <span className="agent-chat-fold-failed">{t("terminal.chat.foldTurnFailed")}</span> : null}
        {/* 이 턴이 문맥에 더한 몫. 총량은 위 칩이 말하고, 이 줄은 그 총량이 어디서 왔는지만 말한다.
            줄어든 턴(압축이 끼어든 경우)도 그대로 부호를 지고 선다 — 압축은 사건이지 오류가 아니다. */}
        {contextGrew !== undefined && contextGrew !== 0 ? (
          <span className="agent-chat-fold-context">
            {contextGrew > 0 ? "+" : "−"}{formatTokens(Math.abs(contextGrew))}
          </span>
        ) : null}
        <span className="agent-chat-fold-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="agent-chat-fold-body">{children}</div>
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
  return (
    <>
      <div className="agent-chat-detail-head">
        <button type="button" className="agent-chat-detail-back" aria-label={t("terminal.chat.workBackAria")} onClick={onBack}>
          ‹ {t("terminal.chat.workBack")}
        </button>
        <span className="agent-chat-job-glyph" aria-hidden="true">{jobGlyph(job.kind)}</span>
        <span className="agent-chat-detail-title">{job.title}</span>
        <span className={`agent-chat-job-outcome ${jobStateClass(job)}`}>{jobOutcome(job, language)}</span>
      </div>
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
  const thousands = tokens / 1_000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * 미터가 어느 계단에 서는지. quota 레일이 쓰는 세 단계를 그대로 물려받는다 — 같은 제품 안에서
 * 같은 모양의 미터가 다른 임계로 물들면 사용자가 색을 두 번 배워야 한다.
 *
 * 자동 압축이 켜져 있으면 임계선이 곧 위험선이다. 꺼져 있으면 창을 다 쓰는 것 자체가 한계이므로
 * 고정 비율로 돌아간다.
 */
function contextTone(context: AgentChatContext): "" | " is-warn" | " is-critical" {
  const ratio = context.total / context.max;
  const limit = context.compactAt !== undefined ? context.compactAt / context.max : 1;
  if (ratio >= limit * 0.97) return " is-critical";
  if (ratio >= limit * 0.75) return " is-warn";
  return "";
}

/**
 * 문맥 미터 칩과 그 내역.
 *
 * 값은 **마지막으로 끝난 턴**의 것이다. 자식은 턴이 끝나기 전에 닫히므로 유휴 상태에서 다시 물을
 * 상대가 없고(실측), 도는 턴 안에서는 아직 자라는 중이다. 그래서 진행 중에는 숫자를 새 사실인 척
 * 세우지 않고 흐려 둔다 — 그 자리에 옛 숫자를 또렷하게 두면 방금 붙인 큰 파일이 공짜로 보인다.
 */
function ContextMeterChip({
  context,
  working,
  language,
}: {
  readonly context: AgentChatContext | null;
  readonly working: boolean;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

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

  const percent = Math.round((context.total / context.max) * 100);
  const summary = `${formatTokens(context.total)} / ${formatTokens(context.max)}`;
  return (
    <div className={`agent-chat-ctx${contextTone(context)}`} ref={wrapRef}>
      <button
        type="button"
        className={`agent-chat-mode-chip agent-chat-ctx-chip${working ? " is-stale" : ""}`}
        aria-expanded={open}
        aria-label={t("terminal.chat.contextAria", { percent: String(percent), summary })}
        title={working ? t("terminal.chat.contextWorking") : t("terminal.chat.contextAt", { summary })}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <ContextArc ratio={context.total / context.max} />
        <span className="agent-chat-ctx-pct">{working ? "···" : `${percent}%`}</span>
      </button>
      {open ? <ContextBreakdown context={context} working={working} language={language} /> : null}
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
  working,
  language,
}: {
  readonly context: AgentChatContext;
  readonly working: boolean;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const rows = [...context.slices].sort((left, right) => right.tokens - left.tokens);
  const free = Math.max(0, context.max - context.total);
  const percent = Math.round((context.total / context.max) * 100);
  return (
    <div className="agent-chat-ctx-pop" role="dialog" aria-label={t("terminal.chat.contextTitle")}>
      <div className="agent-chat-ctx-pop-head">
        <span className="agent-chat-ctx-pop-title">{t("terminal.chat.contextTitle")}</span>
        <span className="agent-chat-ctx-pop-total">
          {formatTokens(context.total)} / {formatTokens(context.max)} · {percent}%
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
        <li className="agent-chat-ctx-free">
          <span className="agent-chat-ctx-swatch is-free" aria-hidden="true" />
          <span className="agent-chat-ctx-name">{t("terminal.chat.contextFree")}</span>
          <span className="agent-chat-ctx-tokens">{formatTokens(free)}</span>
          <span className="agent-chat-ctx-share">{((free / context.max) * 100).toFixed(1)}%</span>
        </li>
      </ul>
      <ContextDetail label={t("terminal.chat.contextMemoryFiles")} rows={context.memoryFiles} />
      <ContextDetail label={t("terminal.chat.contextMcpTools")} rows={context.mcpTools} />
      <p className="agent-chat-ctx-foot">
        {working ? t("terminal.chat.contextWorking") : t("terminal.chat.contextAge")}
      </p>
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
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((left, right) => right.tokens - left.tokens);
  return (
    <details className="agent-chat-ctx-detail">
      <summary>
        <span className="agent-chat-ctx-name">{label}</span>
        <span className="agent-chat-ctx-tokens">{formatTokens(sorted.reduce((sum, row) => sum + row.tokens, 0))}</span>
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
