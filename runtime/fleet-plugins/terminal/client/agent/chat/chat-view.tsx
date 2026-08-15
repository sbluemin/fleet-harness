import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { getT } from "../../i18n/index.js";
import { StreamedMarkdown } from "../streamed-markdown.js";
import { useAgentChatStream } from "./chat-store.js";
import {
  agentChatToolFamily,
  groupAgentChatLedger,
  splitAgentChatTurn,
  type AgentChatChange,
  type AgentChatStepGroup,
  type AgentChatTurn,
  type AgentChatTurnItem,
} from "./chat-events.js";
import "@fleet-console/markdown/styles.css";
import "./chat.css";

/**
 * Chat Mode의 Operation 본문 — 읽기 전용 지휘 로그.
 *
 * 입력창은 의도적으로 없다: 지시는 Quick Launch 멘션으로만 들어온다(제품 결정).
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
  const state = useAgentChatStream(context.operationId);
  // 현재 작업 여부의 권위는 호스트가 쥔 런타임 축 하나다 — 이 뷰가 따로 축을 주장하면 열려 있는
  // 동안만 정직해지고, 패널을 닫는 순간 사이드바가 다시 휴면으로 돌아간다. 축이 degraded면 호스트가
  // null 을 건네므로 진행 중이라고 주장하지 않는다(그 사실은 전역 배너가 말한다).
  const runtime = context.runtimeState;
  const working = runtime?.lifecycle === "live" && runtime.activity === "running";
  const [terminalPending, setTerminalPending] = React.useState(false);
  const [terminalError, setTerminalError] = React.useState(false);
  const logRef = React.useRef<HTMLDivElement>(null);
  // 스크롤 팔로우는 터미널과 같은 문법이다(terminal-scroll-follow): 바닥을 따라가는 중인지, 아니면
  // 사용자가 세워 둔 위치가 있는지. 후자는 "바닥까지의 거리"로 기억해야 패널 크기가 변해도 같은
  // 내용이 보인다 — 절대 scrollTop 은 높이가 바뀌는 순간 다른 곳을 가리킨다.
  const nearBottomRef = React.useRef(true);
  const bottomDistanceRef = React.useRef<number | null>(null);
  // 프로그램적 복원이 낳은 scroll 이벤트는 사용자 의도가 아니다. 이것을 걸러내지 않으면 복원 자체가
  // 팔로우 상태를 뒤집어, 한 번 튄 스크롤이 영영 바닥으로 돌아오지 못한다.
  const suppressScrollRef = React.useRef(0);

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
  // 지금 팔로우 중이면 바닥으로, 아니면 기억해 둔 바닥 거리로 되돌린다.
  const restoreAnchor = React.useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    const next = nearBottomRef.current
      ? log.scrollHeight
      : Math.max(0, log.scrollHeight - log.clientHeight - (bottomDistanceRef.current ?? 0));
    if (log.scrollTop === next) return;
    suppressScrollRef.current += 1;
    log.scrollTop = next;
    requestAnimationFrame(() => {
      suppressScrollRef.current = Math.max(0, suppressScrollRef.current - 1);
    });
  }, []);

  React.useLayoutEffect(() => {
    restoreAnchor();
  }, [restoreAnchor, scrollSignal, working, state.turns.length]);

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
    nearBottomRef.current = distance < 80;
    bottomDistanceRef.current = nearBottomRef.current ? null : distance;
  }, []);


  const timeFormat = React.useMemo(
    () => new Intl.DateTimeFormat(context.language === "ko" ? "ko" : "en", { hour: "2-digit", minute: "2-digit" }),
    [context.language],
  );

  return (
    <section className="agent-chat" aria-label={t("terminal.chat.aria")}>
      {/* 터미널 복귀는 터미널 뷰의 채팅 전환 칩과 같은 문법이다 — 두 뷰가 서로를 같은
          자리·같은 모양의 떠 있는 칩으로 가리켜, 전환이 한 쌍의 동작으로 읽힌다.
          띠바를 두면 채팅 본문이 패널 면과 다른 면 위에 앉아 창이 두 장으로 갈린다.
          Analyst 진입 칩이 선행하면 같은 줄에 나란히 선다. */}
      <div className="agent-view-chip-row">
        {leadingChip}
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
      <div className="agent-chat-log" ref={logRef} onScroll={handleScroll} {...(tourAnchors ? { "data-chat-tour": "log" } : {})}>
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
                  items={view.ledger}
                  language={language}
                  pending={view.streamingText === null && !view.ledger.some((item) => item.state === "running")}
                />
              </>
            ) : view.ledger.length > 0 || view.changes.length > 0 ? (
              <WorkFold
                durationMs={turn.durationMs}
                failed={view.failed}
                error={turn.state === "error"}
                language={language}
              >
                <ChangeStrip changes={view.changes} language={language} />
                <Ledger items={view.ledger} language={language} />
              </WorkFold>
            ) : null}
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
  items,
  language,
  pending = false,
}: {
  readonly items: readonly AgentChatTurnItem[];
  readonly language: "en" | "ko";
  /** 원장 꼬리에 "아직 살아 있다" 한 줄을 세운다 — 도구도 글자도 없는 구간의 유일한 신호다. */
  readonly pending?: boolean;
}) {
  const t = getT(language);
  const view = groupAgentChatLedger(items);
  if (items.length === 0 && !pending) return null;
  return (
    <div className="agent-chat-ledger">
      {view.inline.map((item, index) => item.type === "text"
        ? <div key={index} className="agent-chat-ledger-note">{item.text}</div>
        : <Step key={index} item={item} language={language} />)}
      <Tally groups={view.groups} language={language} />
      {view.running.map((item, index) => <Step key={`run-${index}`} item={item} language={language} />)}
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
 */
function Tally({
  groups,
  language,
}: {
  readonly groups: readonly AgentChatStepGroup[];
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  if (groups.length === 0) return null;
  return (
    <div className="agent-chat-tally">
      {groups.map((group, index) => (
        <React.Fragment key={`${group.family}-${group.name ?? ""}`}>
          {index > 0 ? <span className="agent-chat-tally-sep" aria-hidden="true">·</span> : null}
          <span>{groupLabel(group, t)}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

/** 복수형은 이 저장소 관례대로 호출부가 고른다(`_one`/`_other`). */
function groupLabel(group: AgentChatStepGroup, t: ReturnType<typeof getT>): string {
  const plural = group.count === 1 ? "one" : "other";
  const key = `terminal.chat.group.${group.family}_${plural}` as Parameters<typeof t>[0];
  return t(key, { count: group.count, ...(group.name !== undefined ? { name: group.name } : {}) });
}

/** 스텝 한 줄 — 동사·좌표·결과. 진행 중인 줄만 라이브 리전으로 읽힌다. */
function Step({
  item,
  language,
}: {
  readonly item: AgentChatTurnItem;
  readonly language: "en" | "ko";
}) {
  const t = getT(language);
  const running = item.state === "running";
  const failed = item.state === "fail";
  const name = item.name ?? "";
  const verb = running ? runningVerb(name, language) : pastVerb(name, language);
  // 결과 칩은 변경 장부가 있으면 줄 수를, 없으면 도구가 돌려준 한 줄 요약을 보인다.
  // 실패는 언제나 요약이 이긴다 — 무엇이 잘못됐는지가 얼마나 썼는지보다 먼저다.
  const outcome = failed
    ? item.result ?? t("terminal.chat.stepFailed")
    : item.change && (item.change.added > 0 || item.change.removed > 0)
      ? formatChange(item.change)
      : item.result ?? null;
  return (
    <div className={`agent-chat-step is-${item.state ?? "done"}`}>
      {running
        ? <span className="agent-chat-step-orbit" aria-hidden="true" />
        : <span className="agent-chat-step-mark" aria-hidden="true">{failed ? "✕" : "✓"}</span>}
      <span className="agent-chat-step-verb" {...(running ? { role: "status" } : {})}>{verb}</span>
      {item.detail ? <span className="agent-chat-step-object">{item.detail}</span> : null}
      {item.outside ? (
        <span className="agent-chat-step-outside" title={t("terminal.chat.outsideTheaterTitle")}>
          {t("terminal.chat.outsideTheater")}
        </span>
      ) : null}
      {outcome ? <span className={`agent-chat-step-out${failed ? " is-error" : ""}`}>{outcome}</span> : null}
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
  error,
  language,
  children,
}: {
  readonly durationMs: number | undefined;
  readonly failed: number;
  readonly error: boolean;
  readonly language: "en" | "ko";
  readonly children: React.ReactNode;
}) {
  const t = getT(language);
  const label = durationMs !== undefined
    ? t("terminal.chat.workedFor", { duration: formatDuration(durationMs) })
    : t("terminal.chat.workedLabel");
  return (
    <details className="agent-chat-fold">
      <summary aria-label={t("terminal.chat.foldAria")}>
        <span className="agent-chat-fold-label">{label}</span>
        {failed > 0 ? <span className="agent-chat-fold-failed">{t("terminal.chat.foldFailed", { count: failed })}</span> : null}
        {failed === 0 && error ? <span className="agent-chat-fold-failed">{t("terminal.chat.foldTurnFailed")}</span> : null}
        <span className="agent-chat-fold-chev" aria-hidden="true">⌄</span>
      </summary>
      <div className="agent-chat-fold-body">{children}</div>
    </details>
  );
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
