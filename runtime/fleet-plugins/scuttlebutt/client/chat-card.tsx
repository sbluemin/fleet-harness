import { CaptionComputerUseGlyph, CaptionConsoleUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import { HistoryBand, useHistoryReveal } from "@fleet-console/sdk/components/history-band";
import { LiveFold, LiveLine, LiveStep } from "@fleet-console/sdk/components/live-line";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { createPortal } from "react-dom";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { exchanges, lastAnswer, type ChatEntry, type ChatState } from "./chat-store.js";
import type { AdmiralId } from "./chat-session.js";
import { copyCodeBlock, useCopyAnswer } from "./copy-answer.js";
import { placeCard, placeDockedCard, type CardPlacement } from "./geometry.js";
import { GrantLine, GrantMarks, grantSummary } from "./grant-chips.js";
import { ClearIcon, CloseIcon, DockIcon, HeadAction, MoreIcon, MoorIcon, UndockIcon } from "./head-action.js";
import { foldStatus, isBusy, liveStatus } from "./live-status.js";
import { diagramHydratorLabels, getT } from "./scuttlebutt-catalog.js";
import type { AideGrants } from "./settings-store.js";
import type { ChatStreamUsage } from "./sse-client.js";
import { useStreamedHtml } from "./streamed-html.js";

/** 어느 실험이 켜져 있는가 — 켜진 확장만 메뉴에 행으로 선다(Operation 메뉴와 같다). */
export interface AideExtensionAvailability {
  readonly consoleUse: boolean;
  readonly computerUse: boolean;
}

export function ChatCard({
  state,
  draft,
  admiral,
  mascot,
  moored,
  docked,
  canDock,
  grants,
  extensions,
  onGrantChange,
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
  /** 글리프가 설 밴드 슬롯이 있는가. 없으면(모바일 배치) 「상단 바에 두기」를 내지 않는다. */
  readonly canDock: boolean;
  /** 이 부관의 AI 확장 허용 — 헤더 표식·인사말·메뉴 행의 상태. */
  readonly grants: AideGrants;
  readonly extensions: AideExtensionAvailability;
  readonly onGrantChange: (patch: Partial<AideGrants>) => void;
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
  const [menuOpen, setMenuOpen] = React.useState(false);
  // 메뉴는 문서 끝으로 포털한다 — 카드는 overflow: hidden 이고 인사말만 있을 때는 메뉴보다 낮아서,
  // 카드 안에 두면 잘린다. 닻은 ··· 버튼의 실제 자리다(헤더 도움말 말풍선과 같은 계약).
  const moreRef = React.useRef<HTMLSpanElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = React.useState<{ readonly top: number; readonly right: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!menuOpen) return;
    const rect = moreRef.current?.getBoundingClientRect();
    if (rect) setMenuAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  }, [menuOpen, positionRevision]);

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

  // 로그는 마지막 문답만 보여 준다. 앞선 문답은 상단 밴드 뒤에 접히고, 누르거나 맨 위에서 위로 한 번
  // 더 굴리면 펼쳐진다. 새 질문이 서면 다시 접히고 그 질문이 로그 상단에 앉는다 — 답은 그 아래에서
  // 자라고, 화면을 넘길 때만 바닥을 따른다(사용자가 위로 올려 읽는 중이면 따라가지 않는다).
  const groups = exchanges(state);
  const earlier = groups.slice(0, -1);
  const current = groups.at(-1) ?? [];
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const previousGroupCountRef = React.useRef(groups.length);
  const nearBottomRef = React.useRef(true);
  const revealHistory = React.useCallback(() => setHistoryOpen(true), []);
  useHistoryReveal({ ref: logRef, armed: !historyOpen && earlier.length > 0, onReveal: revealHistory });
  React.useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const asked = groups.length > previousGroupCountRef.current;
    previousGroupCountRef.current = groups.length;
    if (asked) {
      setHistoryOpen(false);
      nearBottomRef.current = true;
      log.scrollTop = 0;
    } else if (nearBottomRef.current) {
      log.scrollTop = log.scrollHeight;
    }
    position();
  }, [groups.length, state.entries, state.phase, position]);
  const onLogScroll = React.useCallback(() => {
    const log = logRef.current;
    if (!log || log.clientHeight === 0) return;
    nearBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }, []);

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
      if (menuRef.current?.contains(target)) return;
      if (mascot.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [mascot, onClose]);

  const style = placementStyle(placement);
  const busy = isBusy(state);
  const answer = lastAnswer(state);
  const canSend = !busy && draft.trim().length > 0;
  const submit = () => {
    if (canSend) onAsk(draft);
  };
  const summary = grantSummary(grants, locale);
  const greeting = `${t(`chat.greeting.${admiral}`)} ${summary ? t("greeting.grantsOn", { grants: summary }) : t("greeting.grantsOff")}`;
  const menuRows = [
    extensions.consoleUse ? { id: "console" as const, key: "consoleUse" as const, glyph: <CaptionConsoleUseGlyph />, name: t("menu.consoleUse"), hint: t(grants.consoleUse ? "menu.consoleUseOn" : "menu.consoleUseOff") } : null,
    extensions.computerUse ? { id: "computer" as const, key: "computerUse" as const, glyph: <CaptionComputerUseGlyph />, name: t("menu.computerUse"), hint: t(grants.computerUse ? "menu.computerUseOn" : "menu.computerUseOff") } : null,
  ].filter((row) => row !== null);
  return (
    <div
      ref={cardRef}
      className={`scuttlebutt-chat-card${docked ? " is-docked" : ""}`}
      style={style}
      role="dialog"
      aria-label={t(`chat.label.${admiral}`)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (menuOpen) {
          setMenuOpen(false);
          return;
        }
        onClose(true);
      }}
    >
      <div className="scuttlebutt-chat-head">
        <span className="scuttlebutt-chat-sigil" aria-hidden="true">⚓</span>
        <span className="scuttlebutt-chat-who">
          {t(`chat.label.${admiral}`)}
          <GrantMarks grants={grants} locale={locale} />
        </span>
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
            {canDock ? (
              <HeadAction
                id={`scuttlebutt-dock-${admiral}`}
                label={t("chat.dock")}
                hint={t("chat.dock.hint")}
                icon={<DockIcon />}
                onClick={onDock}
              />
            ) : null}
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
        {/* AI 확장은 이 부관 자신의 ··· 메뉴에서 켠다 — Operation 메뉴의 「AI 확장」 섹션과 같은 행,
            같은 글리프, 같은 문구. 켜진 실험의 확장만 행으로 서고, 아무것도 안 켜져 있으면 설정으로
            가는 길만 한 줄 선다. */}
        <span ref={moreRef} className="scuttlebutt-head-slot">
          <HeadAction
            id={`scuttlebutt-more-${admiral}`}
            label={t("menu.more")}
            hint={t("menu.more.hint")}
            icon={<MoreIcon />}
            pressed={menuOpen}
            quiet={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          />
        </span>
        {menuOpen && menuAnchor ? createPortal(
          <div
            ref={menuRef}
            className="scuttlebutt-menu"
            role="menu"
            aria-label={t("menu.aiExtensions")}
            style={{ top: menuAnchor.top, right: menuAnchor.right }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setMenuOpen(false);
            }}
          >
            <div className="scuttlebutt-menu-label">{t("menu.aiExtensions")}</div>
            {menuRows.length === 0 ? (
              <div className="scuttlebutt-menu-hint">{t("menu.experimentOff")}</div>
            ) : menuRows.map((row) => (
              <MenuRow
                key={row.id}
                id={`scuttlebutt-menu-${admiral}-${row.id}`}
                item={row.id}
                name={row.name}
                hint={row.hint}
                glyph={row.glyph}
                checked={grants[row.key]}
                onToggle={() => onGrantChange({ [row.key]: !grants[row.key] })}
              />
            ))}
          </div>,
          document.body,
        ) : null}
        {/* 닫기는 아이콘이 스스로 말한다 — 말풍선 없이 aria-label만. */}
        <HeadAction
          id={`scuttlebutt-tuck-${admiral}`}
          label={t("chat.tuck")}
          icon={<CloseIcon />}
          onClick={onTuck}
        />
      </div>
      <div ref={logRef} className="scuttlebutt-chat-log" aria-live="polite" onScroll={onLogScroll} onClick={(event) => copyCodeBlock(event, t("action.copied"))}>
        {state.entries.length === 0 ? (
          <div className="scuttlebutt-greeting">
            <div className="scuttlebutt-message-sam">{greeting}</div>
            <GrantLine grants={grants} locale={locale} />
          </div>
        ) : null}
        <HistoryBand
          count={earlier.length}
          open={historyOpen}
          onToggle={() => setHistoryOpen((open) => !open)}
          label={t(historyOpen ? "history.bandOpen" : "history.band", { count: String(earlier.length) })}
        />
        <div className="scuttlebutt-history" hidden={!historyOpen}>
          {earlier.map((exchange) => <Exchange key={exchange[0]!.id} exchange={exchange} live={false} locale={locale} onStop={onStop} />)}
        </div>
        {current.length > 0 ? <Exchange key={current[0]!.id} exchange={current} live={busy} locale={locale} onStop={onStop} /> : null}
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
      {/* 한 줄 컴포저 — 입력과 동작(보내기/중지)이 한 면 안에 앉는다. 도는 동안은 같은 자리가 중지가 된다. */}
      <form className={`scuttlebutt-composer${busy ? " is-working" : ""}`} onSubmit={(event) => {
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
        {busy ? (
          <button type="button" className="scuttlebutt-send scuttlebutt-stop" aria-label={t("action.stop")} title={t("action.stop")} onClick={onStop}>
            <span aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className={`scuttlebutt-send${canSend ? " is-armed" : ""}`} disabled={!canSend} aria-label={t("chat.send")} title={t("chat.send")}>
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
          </button>
        )}
      </form>
    </div>
  );
}

/**
 * 메뉴의 한 줄 체크 행. 상태 문구는 행 아래에 쌓지 않고, 마우스를 올리거나 포커스했을 때 한 줄
 * 말풍선으로 선다 — 헤더 아이콘의 도움말과 같은 계약·같은 포털(role="tooltip").
 */
function MenuRow({ id, item, name, hint, glyph, checked, onToggle }: {
  readonly id: string;
  readonly item: string;
  readonly name: string;
  readonly hint: string;
  readonly glyph: React.ReactNode;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const rowRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<{ readonly top: number; readonly left: number } | null>(null);
  const tipId = `${id}-tip`;
  React.useLayoutEffect(() => {
    if (!open) return;
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 276)) });
  }, [open, hint]);
  return (
    <>
      <button
        ref={rowRef}
        type="button"
        className={`scuttlebutt-menu-row${checked ? " is-on" : ""}`}
        role="menuitemcheckbox"
        aria-checked={checked}
        aria-label={`${name} · ${hint}`}
        aria-describedby={tipId}
        data-aide-menu-item={item}
        onClick={onToggle}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <span className="scuttlebutt-menu-glyph" aria-hidden="true">{glyph}</span>
        <span className="scuttlebutt-menu-name">{name}</span>
        <svg viewBox="0 0 12 12" className="scuttlebutt-menu-check" aria-hidden="true">
          <path d="M2 6l3 3 5-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {createPortal(
        <span
          className="scuttlebutt-head-tip"
          role="tooltip"
          id={tipId}
          hidden={!open || anchor === null}
          style={anchor ? { top: anchor.top, left: anchor.left, right: "auto" } : undefined}
        >
          <b>{name}</b>
          {hint}
        </span>,
        document.body,
      )}
    </>
  );
}

/**
 * 문답 하나 — 질문, 그 아래 과정 한 줄(도는 동안은 Live line, 끝나면 접힘), 그리고 답.
 * 도구 호출은 행으로 서지 않는다. 답 조각은 도구 호출로 끊긴 순서대로 이어 그린다.
 */
function Exchange({ exchange, live, locale, onStop }: {
  readonly exchange: readonly ChatEntry[];
  readonly live: boolean;
  readonly locale: ConsoleLocale | undefined;
  readonly onStop: () => void;
}) {
  const t = getT(locale);
  const now = useNow(live);
  const fold = live ? null : foldStatus(exchange, locale);
  const status = live ? liveStatus(exchange, locale, now) : null;
  const question = exchange.find((entry) => entry.kind === "user");
  // 과정 한 줄은 질문 바로 아래, 답 조각 앞에 선다 — 답이 도구 호출로 끊겨 조각이 여럿이어도 줄은 하나다.
  return (
    <div className="scuttlebutt-exchange">
      {question?.kind === "user" ? <div className="scuttlebutt-message-user">{question.text}</div> : null}
      {status ? <LiveLine label={status.label} thinking={status.thinking} meta={status.meta} stopLabel={t("action.stop")} onStop={onStop} /> : null}
      {fold ? (
        <LiveFold summary={fold.summary} tone={fold.tone} ariaLabel={t("fold.aria")}>
          {fold.steps.length > 0 ? fold.steps.map((step, index) => <LiveStep key={index} mark={step.mark} label={step.label} {...(step.detail ? { detail: step.detail } : {})} />) : undefined}
        </LiveFold>
      ) : null}
      {exchange.map((entry, index) => {
        if (entry.kind === "assistant") {
          return <AssistantText key={entry.id} text={entry.text} streaming={live && index === exchange.length - 1} locale={locale} />;
        }
        if (entry.kind === "notice") return <div key={entry.id} className="scuttlebutt-status-row is-notice">{entry.text}</div>;
        if (entry.kind === "error") return <div key={entry.id} className="scuttlebutt-status-row is-error">{entry.text}</div>;
        return null;
      })}
    </div>
  );
}

function AssistantText({ text, streaming, locale }: { readonly text: string; readonly streaming: boolean; readonly locale: ConsoleLocale | undefined }) {
  const html = useStreamedHtml(text, streaming, locale);
  return <div className={`scuttlebutt-message-sam markdown-body${streaming ? " is-streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 도는 동안만 1초 시계 — 경과가 Live line의 오른쪽 끝에 선다. 멈추면 시계도 멈춘다. */
function useNow(live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
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
