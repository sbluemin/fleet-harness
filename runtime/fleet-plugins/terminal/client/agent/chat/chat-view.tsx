import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { getT } from "../../i18n/index.js";
import { StreamedMarkdown } from "../streamed-markdown.js";
import type { SessionInfo } from "../types.js";
import { useAgentChatStream } from "./chat-store.js";
import type { AgentChatTurn } from "./chat-events.js";
import "./chat.css";

/**
 * Chat Mode의 Operation 본문 — 읽기 전용 지휘 로그.
 *
 * 입력창은 의도적으로 없다: 지시는 Quick Launch 멘션으로만 들어온다(제품 결정). 이 뷰는
 * 서버 chat-stream을 구독해 디스패치·턴·도구 사용을 렌더링하고, 상태는 좌측 스파인 노드가
 * 신호 토큰(aurora/warn/coral/positive)으로만 말한다.
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

  const entryCount = state.turns.reduce((count, turn) => count + turn.items.length + (turn.dispatch ? 1 : 0), 0);
  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (!log || !nearBottomRef.current) return;
    log.scrollTop = log.scrollHeight;
  }, [entryCount, state.working, state.turns.length]);

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
            model={model}
            effort={effort}
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
  model,
  effort,
  language,
  timeFormat,
  streaming,
}: {
  readonly turn: AgentChatTurn;
  readonly model: string;
  readonly effort: string;
  readonly language: "en" | "ko";
  readonly timeFormat: Intl.DateTimeFormat;
  readonly streaming: boolean;
}) {
  const t = getT(language);
  const lastTextIndex = turn.items.reduce((last, item, index) => (item.type === "text" ? index : last), -1);
  return (
    <>
      {turn.dispatch ? (
        <div className="agent-chat-dispatch">
          <div className="agent-chat-dispatch-kicker">
            <span>{t("terminal.chat.you")}</span>
            <span className="agent-chat-dispatch-via">{t("terminal.chat.viaQuickLaunch")}</span>
            {turn.dispatch.at !== undefined ? <span>{timeFormat.format(new Date(turn.dispatch.at))}</span> : null}
          </div>
          <div className="agent-chat-dispatch-text">{turn.dispatch.text}</div>
        </div>
      ) : null}
      {turn.items.length > 0 || turn.state === "working" ? (
        <div className={`agent-chat-turn is-${turn.state}`}>
          <div className="agent-chat-turn-spine" aria-hidden="true"><span className="agent-chat-turn-node" /></div>
          <div className="agent-chat-turn-body">
            <div className="agent-chat-turn-head">
              {model ? <span className="agent-chat-turn-model">{model}{effort ? ` · ${effort.toUpperCase()}` : ""}</span> : null}
              {turn.durationMs !== undefined ? <span>{formatDuration(turn.durationMs)}</span> : null}
              {turn.toolCount > 0
                ? <span>{turn.toolCount === 1 ? t("terminal.chat.oneTool") : t("terminal.chat.toolCount", { count: turn.toolCount })}</span>
                : null}
            </div>
            {turn.items.map((item, index) => item.type === "text"
              ? (
                <StreamedMarkdown
                  key={index}
                  className="agent-chat-turn-text"
                  text={item.text ?? ""}
                  streaming={streaming && index === lastTextIndex}
                  language={language}
                />
              )
              : (
                <div key={index} className="agent-chat-tool">
                  <span className="agent-chat-tool-glyph" aria-hidden="true">▸</span>
                  <span className="agent-chat-tool-name">{item.name}</span>
                  {item.detail ? <span className="agent-chat-tool-detail">{item.detail}</span> : null}
                </div>
              ))}
          </div>
        </div>
      ) : null}
    </>
  );
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
