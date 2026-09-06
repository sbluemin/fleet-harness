import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { lastAnswer, type ChatEntry, type ChatState } from "./chat-store.js";
import type { AdmiralId } from "./chat-session.js";
import { placeCard, type CardPlacement } from "./geometry.js";
import { getT } from "./scuttlebutt-catalog.js";
import type { ChatStreamUsage } from "./sse-client.js";

export function ChatCard({
  state,
  draft,
  admiral,
  mascot,
  moored,
  onAsk,
  onRetry,
  onStop,
  onClear,
  onHandoff,
  onDraftChange,
  onToggleMoored,
  onClose,
  onTuck,
  locale,
  positionRevision,
}: {
  readonly state: ChatState;
  readonly draft: string;
  readonly admiral: AdmiralId;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly moored: boolean;
  readonly onAsk: (text: string) => void;
  readonly onRetry: () => void;
  readonly onStop: () => void;
  readonly onClear: () => void;
  /** 답을 Quick Launch 초안으로 넘긴다 — 빠른 답을 Operation 지시로 잇는 손잡이. */
  readonly onHandoff: (text: string) => void;
  readonly onDraftChange: (text: string) => void;
  readonly onToggleMoored: () => void;
  /**
   * `restoreFocus`는 키보드로 닫았을 때만 참이다. 마우스로 바깥을 눌러 닫고도 새에 포커스를
   * 되돌리면 `:focus-visible` 링이 새를 감싼 채 남는다(답변 말풍선과 같은 계약).
   */
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onTuck: () => void;
  readonly locale?: ConsoleLocale;
  readonly positionRevision: number;
}) {
  const t = getT(locale);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = React.useState<CardPlacement | null>(null);
  const [copied, setCopied] = React.useState(false);

  const position = React.useCallback(() => {
    const mascotElement = mascot.current;
    const card = cardRef.current;
    if (!mascotElement || !card) return;
    const mascotRect = mascotElement.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    setPlacement(placeCard(
      { width: window.innerWidth, height: window.innerHeight },
      { left: mascotRect.left, top: mascotRect.top, width: mascotRect.width, height: mascotRect.height },
      { width: cardRect.width || 380, height: cardRect.height || 320 },
    ));
  }, [mascot]);

  // 포커스는 카드가 열릴 때(그리고 다른 부관으로 바뀔 때) 한 번만 준다. 재배치 신호에 묶어 두면
  // 부관 크기 조절처럼 카드 밖에서 일어난 사건이 사용자가 잡고 있던 포커스를 빼앗는다.
  React.useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [admiral]);

  React.useLayoutEffect(() => {
    position();
    const card = cardRef.current;
    if (typeof ResizeObserver === "undefined" || !card) return;
    const observer = new ResizeObserver(position);
    observer.observe(card);
    return () => observer.disconnect();
  }, [position, positionRevision]);

  React.useEffect(() => {
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [position]);

  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    position();
  }, [state.entries, state.phase, position]);

  // 입력 높이는 내용에 맞춘다 — 한 줄로 시작해 붙여넣은 문단만큼 자라고, 상한은 CSS가 정한다.
  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    const max = Number.parseFloat(getComputedStyle(input).maxHeight) || Number.POSITIVE_INFINITY;
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
    // 상한에 닿기 전에는 스크롤바를 두지 않는다 — 한 줄짜리 입력에 스크롤 홈이 보이면 잘린 것처럼 읽힌다.
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  // 카드 바깥을 누르면 닫는다. 캡처 단계나 preventDefault를 쓰지 않으므로 그 클릭은
  // 아래 콘솔에 그대로 도달한다 — 마스코트 위 누름은 드래그 시작이라 닫힘에서 제외한다.
  React.useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (mascot.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [mascot, onClose]);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const style = placementStyle(placement);
  const busy = state.phase === "starting" || state.phase === "thinking";
  const answer = lastAnswer(state);
  const canSend = !busy && draft.trim().length > 0;
  const submit = () => {
    if (canSend) onAsk(draft);
  };
  const copyAnswer = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // 클립보드가 막힌 컨텍스트(권한·비보안 origin)에서는 조용히 둔다 — 텍스트는 화면에 있다.
    }
  };
  return (
    <div
      ref={cardRef}
      className="scuttlebutt-chat-card"
      style={style}
      role="dialog"
      aria-label={t(`chat.label.${admiral}`)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className="scuttlebutt-chat-head">
        <span className="scuttlebutt-chat-sigil" aria-hidden="true">⚓</span>
        <span className="scuttlebutt-chat-who">{t(`chat.label.${admiral}`)}</span>
        <button
          type="button"
          className="scuttlebutt-chat-moor"
          role="switch"
          aria-checked={moored}
          onClick={onToggleMoored}
        >
          <span className="scuttlebutt-chat-moor-track" aria-hidden="true"><i /></span>
          {t("chat.stayPut")}
        </button>
        {state.entries.length > 0 ? (
          <button
            type="button"
            className="scuttlebutt-chat-clear"
            title={t("action.clear")}
            aria-label={t("action.clear")}
            disabled={busy}
            onClick={onClear}
          >
            ⌫
          </button>
        ) : null}
        <button type="button" className="scuttlebutt-chat-tuck" aria-label={t("chat.tuck")} onClick={onTuck}>✕</button>
      </div>
      <div ref={logRef} className="scuttlebutt-chat-log" aria-live="polite">
        {state.entries.length === 0 ? (
          <div className="scuttlebutt-message-sam">
            {t(`chat.greeting.${admiral}`)}
          </div>
        ) : null}
        {state.entries.map((entry) => renderEntry(entry, t))}
        {answer && !busy ? (
          <div className="scuttlebutt-answer-actions">
            {answer.sources.length > 0 ? (
              <div className="scuttlebutt-sources">
                <span className="scuttlebutt-sources-label">{t("sources.label")}</span>
                {answer.sources.map((url) => (
                  <a key={url} className="scuttlebutt-source" href={url} target="_blank" rel="noreferrer noopener" title={url}>
                    {sourceLabel(url)}
                  </a>
                ))}
              </div>
            ) : null}
            <div className="scuttlebutt-answer-toolbar">
              <button type="button" className="scuttlebutt-answer-action" onClick={() => void copyAnswer(answer.text)}>
                {copied ? t("action.copied") : t("action.copy")}
              </button>
              <button type="button" className="scuttlebutt-answer-action" onClick={() => onHandoff(answer.text)}>
                {t("action.handoff")}
              </button>
              {answer.usage ? <span className="scuttlebutt-usage">{usageLine(answer.usage, t)}</span> : null}
            </div>
          </div>
        ) : null}
        {state.phase === "error" && lastError(state)?.retryable ? (
          <div className="scuttlebutt-answer-toolbar">
            <button type="button" className="scuttlebutt-answer-action" onClick={onRetry}>{t("action.retry")}</button>
          </div>
        ) : null}
      </div>
      {busy ? (
        <div className="scuttlebutt-thinking">
          <i /><i /><i />{t(`chat.thinking.${admiral}`)}
          <button type="button" className="scuttlebutt-stop" onClick={onStop}>{t("action.stop")}</button>
        </div>
      ) : null}
      <form className="scuttlebutt-composer" onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}>
        <textarea
          ref={inputRef}
          value={draft}
          disabled={busy}
          rows={1}
          placeholder={t(`chat.placeholder.${admiral}`)}
          autoComplete="off"
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter는 보내기, Shift+Enter는 줄바꿈 — Quick Launch 컴포저와 같은 문법.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" className="scuttlebutt-send" disabled={!canSend}>{t("chat.send")}</button>
      </form>
    </div>
  );
}

function renderEntry(entry: ChatEntry, t: ReturnType<typeof getT>): React.ReactNode {
  if (entry.kind === "assistant") {
    return (
      <div
        key={entry.id}
        className="scuttlebutt-message-sam scuttlebutt-markdown-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text).html }}
      />
    );
  }
  if (entry.kind === "user") return <div key={entry.id} className="scuttlebutt-message-user">{entry.text}</div>;
  if (entry.kind === "notice") return <div key={entry.id} className="scuttlebutt-status-row is-notice">{entry.text}</div>;
  void t;
  return (
    <div key={entry.id} className={`scuttlebutt-status-row${entry.kind === "error" ? " is-error" : ""}`}>
      {entry.text}
    </div>
  );
}

/** 마지막 오류 항목. 재시도 버튼은 그 항목이 재시도 가능하다고 말할 때만 선다. */
function lastError(state: ChatState): Extract<ChatEntry, { kind: "error" }> | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "error") return entry;
    if (entry?.kind === "user") return null;
  }
  return null;
}

/** 출처 칩의 글자 — 호스트 이름과 경로 첫 조각. 전체 URL은 title로 남긴다. */
export function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./u, "");
    const segment = parsed.pathname.split("/").filter(Boolean)[0];
    return segment ? `${host}/${segment.length > 24 ? `${segment.slice(0, 22)}…` : segment}` : host;
  } catch {
    return url;
  }
}

export function usageLine(usage: ChatStreamUsage, t: ReturnType<typeof getT>): string {
  const tokens = formatTokens(usage.inputTokens + usage.outputTokens);
  if (typeof usage.costUsd !== "number") return t("usage.lineNoCost", { tokens });
  const cost = usage.costUsd < 0.01 ? "<$0.01" : `$${usage.costUsd.toFixed(2)}`;
  return t("usage.line", { tokens, cost });
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function placementStyle(placement: CardPlacement | null): React.CSSProperties {
  if (!placement) return { visibility: "hidden" };
  if (placement.side === "above") {
    return { left: placement.left, bottom: placement.bottom, maxHeight: placement.maxHeight };
  }
  return { left: placement.left, top: placement.top, maxHeight: placement.maxHeight };
}
