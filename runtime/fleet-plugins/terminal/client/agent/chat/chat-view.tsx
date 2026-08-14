import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { getT } from "../../i18n/index.js";
import { StreamedMarkdown } from "../streamed-markdown.js";
import type { SessionInfo } from "../types.js";
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
  session,
  onOpenTerminal,
}: {
  readonly context: OperationRenderContext;
  readonly session: SessionInfo;
  readonly onOpenTerminal: () => Promise<void>;
}) {
  const t = getT(context.language ?? "en");
  const state = useAgentChatStream(context.operationId);
  const [terminalPending, setTerminalPending] = React.useState(false);
  const [terminalError, setTerminalError] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement>(null);
  const nearBottomRef = React.useRef(true);

  const model = readPayloadString(context.operation.payload, "launchModel");
  const effort = readPayloadString(context.operation.payload, "launchEffort");

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

  const timeFormat = React.useMemo(
    () => new Intl.DateTimeFormat(context.language === "ko" ? "ko" : "en", { hour: "2-digit", minute: "2-digit" }),
    [context.language],
  );

  return (
    <section className="agent-chat" aria-label={t("terminal.chat.aria")}>
      <div className="agent-chat-head">
        <span className="agent-chat-sess">
          <b>{session.cliLabel ?? "Claude"}</b>
          {model ? <span className="agent-chat-sess-model">{model}</span> : null}
          {effort ? <span className="agent-chat-sess-effort">{effort.toUpperCase()}</span> : null}
        </span>
        <span className="agent-chat-cap">{t("terminal.chat.badge")}</span>
        <button
          type="button"
          className="agent-chat-to-term"
          disabled={terminalPending}
          aria-label={t("terminal.chat.openTerminalAria")}
          onClick={() => { void handleOpenTerminal(); }}
        >
          {terminalPending ? t("terminal.chat.openingTerminal") : t("terminal.chat.openTerminal")}
        </button>
      </div>

      <div className="agent-chat-log" ref={logRef} onScroll={handleScroll}>
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

      <div className={`agent-chat-strip${state.working ? " is-working" : ""}`}>
        <span className="agent-chat-strip-state">
          <span className="agent-chat-strip-dot" aria-hidden="true" />
          {state.working ? t("terminal.chat.working") : t("terminal.chat.idle")}
        </span>
        <span className="agent-chat-strip-hint">
          {t("terminal.chat.replyHint")}
          <kbd className="agent-chat-kbd">⌃Space</kbd>
        </span>
      </div>
    </section>
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

function readPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}
