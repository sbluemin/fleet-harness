import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { getT } from "../../i18n/index.js";
import { claimChatActivityAxis, releaseChatActivityAxis } from "../connection.js";
import { StreamedMarkdown } from "../streamed-markdown.js";
import { useAgentChatStream } from "./chat-store.js";
import { splitAgentChatTurn, type AgentChatTurn, type AgentChatTurnItem } from "./chat-events.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

/**
 * Chat Mode의 Operation 본문 — 읽기 전용 지휘 로그.
 *
 * 입력창은 의도적으로 없다: 지시는 Quick Launch 멘션으로만 들어온다(제품 결정). 턴의 표현
 * 문법은 Session Analyst와 한 계열이다 — 진행 중에는 펄스 카드(현재 활동 + elapsed) 하나가
 * 과정을 대변하며 응답이 글자 단위로 스트리밍되고, 끝나면 과정은 영수증 한 줄로 접히고
 * Answer만 콘솔 마크다운 문법으로 남는다.
 */
export function AgentChatView({
  context,
  onOpenTerminal,
  tourAnchors,
}: {
  readonly context: OperationRenderContext;
  readonly onOpenTerminal: () => Promise<void>;
  /** 사용자가 이 마운트에서 직접 채팅 뷰를 연 경우에만 true — 투어 앵커 렌더 여부를 결정한다. */
  readonly tourAnchors: boolean;
}) {
  const t = getT(context.language ?? "en");
  const state = useAgentChatStream(context.operationId);
  const [terminalPending, setTerminalPending] = React.useState(false);
  const [terminalError, setTerminalError] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement>(null);
  const nearBottomRef = React.useRef(true);

  const handleOpenTerminal = React.useCallback(async () => {
    setTerminalPending(true);
    setTerminalError(false);
    try {
      await onOpenTerminal();
    } catch {
      setTerminalError(true);
    } finally {
      setTerminalPending(false);
    }
  }, [onOpenTerminal]);

  // 델타가 흐르는 동안에도 바닥 추적이 이어지도록 draft 길이를 스크롤 신호에 합산한다.
  const scrollSignal = state.turns.reduce(
    (count, turn) => count + turn.items.length + (turn.dispatch ? 1 : 0) + turn.draft.length,
    0,
  );
  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !nearBottomRef.current) return;
    log.scrollTop = log.scrollHeight;
  }, [scrollSignal, state.working, state.turns.length]);

  const handleScroll = React.useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    nearBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }, []);

  // Chat Mode 세션의 작동 여부는 이 스트림만 안다 — 전환 시 PTY가 접히면서 터미널 세션 레코드는
  // dormant로 남고, 그 스냅샷을 그대로 두면 캡션이 턴이 도는 내내 휴면이라고 말한다. 그래서 뷰가
  // 마운트되는 동안 활동축을 인수하고, 떠날 때 되돌려준다.
  //
  // 능력 객체는 의존성이 될 수 없다: 호스트가 렌더마다 새로 만들어 건네므로 의존성에 넣으면
  // 매 렌더 정리가 돌아 방금 심은 상태를 도로 지운다(진행 중 턴의 1초 티커만으로도 깜빡인다).
  // 동작 자체는 안정적이므로 ref로 들고, 의존성은 실제로 바뀌는 값만 진다.
  const { operationId } = context;
  const statusRef = React.useRef(context.status);
  statusRef.current = context.status;
  React.useEffect(() => {
    claimChatActivityAxis(operationId);
    return () => {
      releaseChatActivityAxis(operationId);
      statusRef.current.clear(operationId);
    };
  }, [operationId]);

  // 스트림이 붙어 있을 때만 의견을 낸다. 연결 전·상실 구간에서 idle을 주장하면 아직 아무것도
  // 관측하지 못한 상태를 "쉬는 중"이라고 말하는 셈이라, 무의견으로 남겨 복원 Operation의 기본
  // 분류(dormant)가 그대로 서게 한다.
  const connected = state.connection === "open";
  const working = state.working;
  React.useEffect(() => {
    if (!connected) {
      statusRef.current.clear(operationId);
      return;
    }
    statusRef.current.set(operationId, working ? "running" : "idle");
  }, [connected, working, operationId]);

  const timeFormat = React.useMemo(
    () => new Intl.DateTimeFormat(context.language === "ko" ? "ko" : "en", { hour: "2-digit", minute: "2-digit" }),
    [context.language],
  );

  return (
    <section className="agent-chat" aria-label={t("terminal.chat.aria")}>
      {/* 터미널 복귀는 터미널 뷰의 채팅 전환 칩과 같은 문법이다 — 두 뷰가 서로를 같은
          자리·같은 모양의 떠 있는 칩으로 가리켜, 전환이 한 쌍의 동작으로 읽힌다.
          띠바를 두면 채팅 본문이 패널 면과 다른 면 위에 앉아 창이 두 장으로 갈린다. */}
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

      {/* data-chat-tour는 코어 feature-tour 카탈로그가 짚는 크로스 번들 앵커 계약이다 —
          사용자가 직접 전환해 들어온 마운트에서만 세워, 리로드로 복원된 채팅 패널이
          콘솔 로드 화면에서 투어를 발화시키지 않게 한다. */}
      <div className="agent-chat-log" ref={logRef} onScroll={handleScroll} {...(tourAnchors ? { "data-chat-tour": "log" } : {})}>
        {state.connection === "connecting" && state.turns.length === 0
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
            turn={turn}
            language={context.language ?? "en"}
            timeFormat={timeFormat}
            streaming={index === state.turns.length - 1 && turn.state === "working"}
          />
        ))}
        {state.turns.length === 0 && !state.replaying && state.connection === "open"
          ? <div className="agent-chat-empty">{t("terminal.chat.emptyHint")}</div>
          : null}
        {state.errorCode === "chat_turn_failed"
          ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.turnFailed")}</div>
          : null}
        {state.connection === "lost"
          ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.connectionLost")}</div>
          : null}
        {terminalError
          ? <div className="agent-chat-sys agent-chat-sys--error">{t("terminal.chat.openTerminalFailed")}</div>
          : null}
      </div>

      {/* 회신은 이 패널을 읽던 사람이 이어서 하는 일이므로 어포던스도 본문 안에 선다. 누르면
          호스트 컴포저가 이 Operation을 행선지로 들고 열린다 — 여기는 입력창이 아니라 그리로
          가는 문이다(이 뷰에 입력창을 두지 않는다는 결정은 그대로다). */}
      <button
        type="button"
        className="agent-chat-reply"
        {...(tourAnchors ? { "data-chat-tour": "composer" } : {})}
        aria-label={t("terminal.chat.replyAria")}
        title={t("terminal.chat.replyTitle")}
        onClick={() => { context.composer.open({ mentionOperationId: context.operationId }); }}
      >
        <ReplyBubbleIcon />
      </button>
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
  turn,
  language,
  timeFormat,
  streaming,
}: {
  readonly turn: AgentChatTurn;
  readonly language: "en" | "ko";
  readonly timeFormat: Intl.DateTimeFormat;
  readonly streaming: boolean;
}) {
  const t = getT(language);
  const view = splitAgentChatTurn(turn);
  const working = turn.state === "working";
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
            {/* 모델·강도는 상단 세션 바가 이미 말한다 — 헤드는 턴의 시간축만 맡는다:
                진행 중엔 라이브 티커, 완료 후엔 총 소요 시간. */}
            {working ? (
              <div className="agent-chat-turn-head">
                <TurnElapsedLabel turn={turn} language={language} />
              </div>
            ) : turn.durationMs !== undefined ? (
              <div className="agent-chat-turn-head">
                <span>{t("terminal.chat.workedFor", { duration: formatDuration(turn.durationMs) })}</span>
              </div>
            ) : null}
            {working
              ? <PulseCard turn={turn} writing={view.streamingText !== null} language={language} />
              : view.ledger.length > 0
                ? <Receipt turn={turn} ledger={view.ledger} language={language} />
                : null}
            {working && view.streamingText !== null ? (
              <StreamedMarkdown
                className="agent-chat-stream markdown-body"
                text={view.streamingText}
                streaming={streaming}
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

/** 진행 중 턴의 대변인 — 현재 활동 라벨. 시간축은 턴 헤드의 티커가 맡는다. */
function PulseCard({
  turn,
  writing,
  language,
}: {
  readonly turn: AgentChatTurn;
  readonly writing: boolean;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const lastTool = findLastTool(turn.items);
  const label = writing
    ? t("terminal.chat.activityWriting")
    : lastTool
      ? t("terminal.chat.activityUsing", { name: lastTool.name ?? "" })
      : t("terminal.chat.activityStarting");
  const note = !writing && lastTool?.detail ? lastTool.detail : null;
  return (
    <div className="agent-chat-pulse">
      <span className="agent-chat-pulse-orbit" aria-hidden="true" />
      {/* 라이브 리전은 활동 라벨로 한정한다 — 초 단위로 바뀌는 값이 섞이면 스크린 리더가
          턴 내내 카드를 재낭독한다. */}
      <span className="agent-chat-pulse-copy" role="status">
        <strong>{label}</strong>
        {note ? <small>{note}</small> : null}
      </span>
    </div>
  );
}

/** 완료 턴의 과정 영수증 — 접힌 한 줄, 펼치면 전 과정. */
function Receipt({
  turn,
  ledger,
  language,
}: {
  readonly turn: AgentChatTurn;
  readonly ledger: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const ok = turn.state === "done";
  // 소요 시간은 턴 헤드가 말한다 — 영수증 요약은 스텝 수만 맡아 중복을 피한다.
  return (
    <details className="agent-chat-receipt">
      <summary aria-label={t("terminal.chat.receiptAria")}>
        <span className="agent-chat-receipt-chev" aria-hidden="true">▸</span>
        <span className={`agent-chat-receipt-mark${ok ? "" : " is-error"}`} aria-hidden="true">{ok ? "✓" : "✕"}</span>
        <span>{ledger.length === 1 ? t("terminal.chat.oneStep") : t("terminal.chat.stepCount", { count: ledger.length })}</span>
      </summary>
      <div className="agent-chat-receipt-body">
        {ledger.map((item, index) => item.type === "text"
          ? <div key={index} className="agent-chat-receipt-note">{item.text}</div>
          : (
            <div key={index} className="agent-chat-tool">
              <span className="agent-chat-tool-glyph" aria-hidden="true">▸</span>
              <span className="agent-chat-tool-name">{item.name}</span>
              {item.detail ? <span className="agent-chat-tool-detail">{item.detail}</span> : null}
            </div>
          ))}
      </div>
    </details>
  );
}

function findLastTool(items: readonly AgentChatTurnItem[]): AgentChatTurnItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "tool") return items[index] ?? null;
  }
  return null;
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
