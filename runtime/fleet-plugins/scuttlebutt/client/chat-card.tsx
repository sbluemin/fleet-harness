import { renderMarkdown } from "@fleet-console/markdown/core";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { lastAnswer, type ChatEntry, type ChatState } from "./chat-store.js";
import type { AdmiralId } from "./chat-session.js";
import { copyCodeBlock, useCopyAnswer } from "./copy-answer.js";
import { placeCard, placeDockedCard, type CardPlacement } from "./geometry.js";
import { ClearIcon, CloseIcon, DockIcon, HeadAction, MoorIcon, UndockIcon } from "./head-action.js";
import { diagramHydratorLabels, getT, markdownRenderOptions } from "./scuttlebutt-catalog.js";
import type { ChatStreamUsage } from "./sse-client.js";

export function ChatCard({
  state,
  draft,
  admiral,
  mascot,
  moored,
  docked,
  onDock,
  onUndock,
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
  /**
   * 상단 바에 둔 부관의 시트로 선다. 닻은 새가 아니라 밴드의 글리프이고, 봉투는 글리프 아래
   * 우측 정렬 480px — 새의 위치와 무관하게 늘 같은 자리에 답이 선다.
   */
  readonly docked: boolean;
  readonly onDock: () => void;
  readonly onUndock: () => void;
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
  const { copied, copy: copyAnswer } = useCopyAnswer();

  const position = React.useCallback(() => {
    const mascotElement = mascot.current;
    const card = cardRef.current;
    if (!mascotElement || !card) return;
    const mascotRect = mascotElement.getBoundingClientRect();
    // 레이아웃 크기(offset*)로 잰다 — 진입 애니메이션이 scale로 도는 동안 getBoundingClientRect는
    // 줄어든 상자를 돌려주고, 그 폭으로 오른쪽을 맞추면 애니메이션이 끝난 뒤 카드가 닻 밖으로 튀어나온다.
    // 변환은 레이아웃을 바꾸지 않으므로 ResizeObserver도 그 어긋남을 알리지 않는다.
    const size = { width: card.offsetWidth || (docked ? 480 : 420), height: card.offsetHeight || 320 };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const anchor = { left: mascotRect.left, top: mascotRect.top, width: mascotRect.width, height: mascotRect.height };
    const next = docked ? placeDockedCard(viewport, anchor, size) : placeCard(viewport, anchor, size);
    // 같은 자리면 상태를 바꾸지 않는다 — 시트의 추적 루프가 프레임마다 리렌더를 몰고 오지 않게.
    setPlacement((current) => (current && samePlacement(current, next) ? current : next));
  }, [docked, mascot]);

  // 포커스는 카드가 열릴 때(그리고 다른 부관으로 바뀔 때, 자리를 옮길 때) 준다. 재배치 신호에
  // 묶어 두면 부관 크기 조절처럼 카드 밖에서 일어난 사건이 사용자가 잡고 있던 포커스를 빼앗는다.
  // 자리를 옮기면 눌렀던 헤더 아이콘이 사라져 포커스가 문서로 떨어진다 — 그러면 Escape가 닿지 않는다.
  React.useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [admiral, docked]);

  React.useLayoutEffect(() => {
    position();
    const card = cardRef.current;
    if (typeof ResizeObserver === "undefined" || !card) return;
    const observer = new ResizeObserver(position);
    observer.observe(card);
    return () => observer.disconnect();
  }, [position, positionRevision]);

  // 상단 바의 글리프는 밴드의 다른 칩(호스트·연결 상태)이 늘고 줄 때 옆으로 밀린다 — 시트는 그
  // 닻을 프레임마다 따라간다(말풍선이 새를 따르는 것과 같다). 자리가 같으면 위에서 걸러진다.
  React.useLayoutEffect(() => {
    if (!docked) return;
    let frame = window.requestAnimationFrame(function follow() {
      position();
      frame = window.requestAnimationFrame(follow);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [docked, position]);

  React.useEffect(() => {
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [position]);

  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
    position();
  }, [state.entries, state.phase, position]);

  // `mermaid` 펜스의 자리표시자를 도식으로 채운다 — 말풍선과 같은 설치 계약.
  React.useEffect(() => {
    const log = logRef.current;
    if (log) installDiagramHydrator(log, diagramHydratorLabels(locale));
  }, [locale]);

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

  // 시트의 Escape는 창 단위로도 받는다 — 글리프를 눌러 열면 포커스가 밴드의 글리프에 남아 카드의
  // onKeyDown에 닿지 않는다. 전면 표면이 소비한 Escape와 모달 독점은 답변 말풍선과 같은 계약으로 비켜선다.
  React.useEffect(() => {
    if (!docked) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (cardRef.current?.contains(event.target as Node | null)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      window.setTimeout(() => {
        if (event.defaultPrevented) return;
        onClose(true);
      }, 0);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [docked, onClose]);

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

  const style = placementStyle(placement);
  const busy = state.phase === "starting" || state.phase === "thinking";
  const answer = lastAnswer(state);
  const canSend = !busy && draft.trim().length > 0;
  const submit = () => {
    if (canSend) onAsk(draft);
  };
  return (
    <div
      ref={cardRef}
      className={`scuttlebutt-chat-card${docked ? " is-docked" : ""}`}
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
        {/* 자리 조작은 그 부관에게만 걸린다 — 전역 설정으로 빼지 않고 헤더에 아이콘으로만 둔다.
            시트(상단 바)에서는 정박이 의미가 없으므로 떼어내기 하나만 선다. */}
        {docked ? (
          <HeadAction
            id={`scuttlebutt-undock-${admiral}`}
            label={t("chat.undock")}
            hint={t("chat.undock.hint")}
            icon={<UndockIcon />}
            onClick={onUndock}
          />
        ) : (
          <>
            <HeadAction
              id={`scuttlebutt-moor-${admiral}`}
              label={t("chat.stayPut")}
              hint={t("chat.stayPut.hint")}
              icon={<MoorIcon />}
              pressed={moored}
              onClick={onToggleMoored}
            />
            <HeadAction
              id={`scuttlebutt-dock-${admiral}`}
              label={t("chat.dock")}
              hint={t("chat.dock.hint")}
              icon={<DockIcon />}
              onClick={onDock}
            />
          </>
        )}
        {state.entries.length > 0 ? (
          <HeadAction
            id={`scuttlebutt-clear-${admiral}`}
            label={t("action.clear")}
            hint={t("action.clear.hint")}
            icon={<ClearIcon />}
            disabled={busy}
            onClick={onClear}
          />
        ) : null}
        <HeadAction
          id={`scuttlebutt-tuck-${admiral}`}
          label={t("chat.tuck")}
          hint={t("chat.tuck.hint")}
          icon={<CloseIcon />}
          onClick={onTuck}
        />
      </div>
      <div ref={logRef} className="scuttlebutt-chat-log" aria-live="polite" onClick={(event) => copyCodeBlock(event, t("action.copied"))}>
        {state.entries.length === 0 ? (
          <div className="scuttlebutt-message-sam">
            {t(`chat.greeting.${admiral}`)}
          </div>
        ) : null}
        {state.entries.map((entry) => renderEntry(entry, locale))}
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

function renderEntry(entry: ChatEntry, locale: ConsoleLocale | undefined): React.ReactNode {
  if (entry.kind === "assistant") {
    return (
      <div
        key={entry.id}
        className="scuttlebutt-message-sam scuttlebutt-markdown-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text, markdownRenderOptions(locale)).html }}
      />
    );
  }
  if (entry.kind === "user") return <div key={entry.id} className="scuttlebutt-message-user">{entry.text}</div>;
  if (entry.kind === "notice") return <div key={entry.id} className="scuttlebutt-status-row is-notice">{entry.text}</div>;
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

function samePlacement(left: CardPlacement, right: CardPlacement): boolean {
  if (left.side !== right.side || Math.abs(left.left - right.left) > 0.5 || Math.abs(left.maxHeight - right.maxHeight) > 0.5) return false;
  const leftY = left.side === "above" ? left.bottom : left.top;
  const rightY = right.side === "above" ? right.bottom : right.top;
  return Math.abs(leftY - rightY) <= 0.5;
}

function placementStyle(placement: CardPlacement | null): React.CSSProperties {
  if (!placement) return { visibility: "hidden" };
  if (placement.side === "above") {
    return { left: placement.left, bottom: placement.bottom, maxHeight: placement.maxHeight };
  }
  return { left: placement.left, top: placement.top, maxHeight: placement.maxHeight };
}
