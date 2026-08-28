import { renderMarkdown } from "@fleet-console/markdown/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { currentExchange, type ChatState } from "./chat-store.js";
import type { AdmiralId } from "./chat-session.js";
import { placeCard, type CardPlacement } from "./geometry.js";
import { getT } from "./scuttlebutt-catalog.js";

export function ChatCard({
  state,
  draft,
  admiral,
  mascot,
  moored,
  onAsk,
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
  readonly onDraftChange: (text: string) => void;
  readonly onToggleMoored: () => void;
  readonly onClose: () => void;
  readonly onTuck: () => void;
  readonly locale?: ConsoleLocale;
  readonly positionRevision: number;
}) {
  const t = getT(locale);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = React.useState<CardPlacement | null>(null);

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

  // 카드 바깥을 누르면 닫는다. 캡처 단계나 preventDefault를 쓰지 않으므로 그 클릭은
  // 아래 콘솔에 그대로 도달한다 — 마스코트 위 누름은 드래그 시작이라 닫힘에서 제외한다.
  React.useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (mascot.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [mascot, onClose]);

  const style = placementStyle(placement);
  const busy = state.phase === "starting" || state.phase === "thinking";
  const visibleEntries = currentExchange(state);
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
          onClose();
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
        <button type="button" className="scuttlebutt-chat-tuck" aria-label={t("chat.tuck")} onClick={onTuck}>✕</button>
      </div>
      <div ref={logRef} className="scuttlebutt-chat-log" aria-live="polite">
        {visibleEntries.length === 0 ? (
          <div className="scuttlebutt-message-sam">
            {t(`chat.greeting.${admiral}`)}
          </div>
        ) : null}
        {visibleEntries.map((entry) => entry.kind === "assistant" ? (
          <div
            key={entry.id}
            className="scuttlebutt-message-sam scuttlebutt-markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text).html }}
          />
        ) : entry.kind === "user" ? (
          <div key={entry.id} className="scuttlebutt-message-user">{entry.text}</div>
        ) : (
          <div key={entry.id} className={`scuttlebutt-status-row${entry.kind === "error" ? " is-error" : ""}`}>
            {entry.text}
          </div>
        ))}
      </div>
      {busy ? <div className="scuttlebutt-thinking"><i /><i /><i />{t(`chat.thinking.${admiral}`)}</div> : null}
      <form className="scuttlebutt-composer" onSubmit={(event) => {
        event.preventDefault();
        onAsk(draft);
      }}>
        <input
          ref={inputRef}
          value={draft}
          disabled={busy}
          placeholder={t(`chat.placeholder.${admiral}`)}
          autoComplete="off"
          onChange={(event) => onDraftChange(event.currentTarget.value)}
        />
        <button type="submit" className="scuttlebutt-send" disabled={busy || !draft.trim()}>{t("chat.send")}</button>
      </form>
    </div>
  );
}

function placementStyle(placement: CardPlacement | null): React.CSSProperties {
  if (!placement) return { visibility: "hidden" };
  if (placement.side === "above") {
    return { left: placement.left, bottom: placement.bottom, maxHeight: placement.maxHeight };
  }
  return { left: placement.left, top: placement.top, maxHeight: placement.maxHeight };
}
