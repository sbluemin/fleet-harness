import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * 컴포저 덱 — '@'·'/'를 치면 입력창 위에 서는 목록 한 벌(퀵 런치바 덱의 문법).
 *
 * 새 세션·사령관·지휘관/구성원·채팅 원장이 이 부품을 같이 쓴다. 클래스(`fc-composer-deck*`)는 고정이고 외형은 호스트
 * components.css 가 그린다. 각 표면은 덱이 뜨는 자리(z-index·폭)와 행의 내용만 정한다. 상태(질의·활성 행·닫음)는 표면이 가진다 —
 * 호스트와 플러그인 번들이 이 모듈을 각자 적재하므로 모듈 스코프 상태를 두지 않는다.
 *
 * 문법: 묶음 머리는 글자 한 줄 + 오른쪽으로 이어지는 구분선이다(퀵 런치바의 「ObjectiveRecords ───」). 묶음 안의 띠(Theater·공급자)는
 * 구분선 없는 글자 한 줄이다. 행은 [머리 칸][이름][값][메타] 네 칸이고, 목록 전체가 한 격자를 subgrid 로 나눠 써서 값·메타 열이
 * 모든 행에서 같은 x 에 선다. 활성 행은 고른 행 워시 위에 2px 금색 링(행 안쪽)이다 — 입력 포커스는 컴포저에 남고 활성 행은
 * aria-activedescendant 로만 옮겨진다.
 */

/** 덱이 쓸 수 있는 최대 높이와, 위가 이만큼은 남아야 아래로 뒤집지 않는다는 문턱. */
const DECK_MAX_HEIGHT = 340;
const DECK_FLIP_THRESHOLD = 220;
/** 덱과 입력 상자 사이(`--space-2`)와 잘림 경계까지 남길 여유. */
const DECK_EDGE_GAP = 12;

interface DeckPlacement {
  readonly below: boolean;
  readonly maxHeight: number;
}

/**
 * 가장 가까운 조상에서 멈추지 않는다 — 줌인한 패널이 화면 위로 나가면 패널 자신의 경계는 화면 밖이고, 실제로 덱을 자르는 것은
 * 그 바깥의 캔버스 뷰포트다. 모든 overflow 조상의 교집합이 잘림 경계다.
 */
function findClipRect(from: HTMLElement): { readonly top: number; readonly bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = from.parentElement; node; node = node.parentElement) {
    if (window.getComputedStyle(node).overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}

function readDeckPlacement(deck: HTMLElement): DeckPlacement | null {
  const field = deck.offsetParent;
  if (!(field instanceof HTMLElement)) return null;
  const clip = findClipRect(field);
  const box = field.getBoundingClientRect();
  // 사각형은 화면 px 이고 max-height 는 CSS px 다. 캔버스 줌(scale) 아래에서 둘을 섞으면 배율이 두 번 곱해진다.
  const scale = field.offsetHeight > 0 && box.height > 0 ? box.height / field.offsetHeight : 1;
  const above = (box.top - clip.top) / scale - DECK_EDGE_GAP;
  const below = (clip.bottom - box.bottom) / scale - DECK_EDGE_GAP;
  const want = Math.min(DECK_MAX_HEIGHT, deck.scrollHeight + 2);
  // 위가 원하는 높이(혹은 문턱)를 담거나 아래보다 넓으면 위에 선다. 상자가 화면 가운데 떠 있으면(히어로) 아래로 뒤집는다.
  const flip = !(above >= Math.min(want, DECK_FLIP_THRESHOLD) || above >= below);
  const room = flip ? below : above;
  // 하한을 두지 않는다 — 남은 공간이 곧 상한이다(하한으로 키운 덱은 다시 패널 밖으로 넘어가 머리가 잘린다).
  return { below: flip, maxHeight: Math.round(Math.max(0, Math.min(DECK_MAX_HEIGHT, room))) };
}

/**
 * 덱 높이를 상자 위(또는 아래)에 실제로 남은 공간에 맞춘다. 칠하기 전에 재야 한 번 잘린 채로 깜박이지 않는다. 기준면은 덱의
 * offsetParent(표면이 position 을 준 상자)다. 조상의 style·class 가 바뀌거나(캔버스 줌) 상자 크기가 바뀌면 프레임당 한 번 다시 잰다.
 */
function useComposerDeckPlacement(deckRef: { readonly current: HTMLDivElement | null }, contentKey: string): DeckPlacement | null {
  const [placement, setPlacement] = useState<DeckPlacement | null>(null);
  useLayoutEffect(() => {
    const deck = deckRef.current;
    if (!deck || typeof window === "undefined") return;
    const place = () => {
      const next = readDeckPlacement(deck);
      setPlacement((previous) => (previous?.below === next?.below && previous?.maxHeight === next?.maxHeight ? previous : next));
    };
    place();
    const field = deck.offsetParent;
    if (!(field instanceof HTMLElement)) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    for (let node = field.parentElement; node && node !== document.body; node = node.parentElement) {
      mutations?.observe(node, { attributes: true, attributeFilter: ["style", "class"] });
    }
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizes?.observe(field);
    if (field.parentElement) resizes?.observe(field.parentElement);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      mutations?.disconnect();
      resizes?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [deckRef, contentKey]);
  return placement;
}

export interface ComposerDeckProps {
  readonly id: string;
  /** 목록의 이름(aria-label). */
  readonly label: string;
  /**
   * 고를 행이 있을 때만 listbox 다 — option 0개짜리 listbox 는 보조기기에 "목록, 항목 없음"만 남긴다. 빈 상태·로딩은 안의
   * status(`ComposerDeckEmpty`)가 말한다.
   */
  readonly listbox: boolean;
  /** 내용이 바뀌는 열쇠(질의·행 수) — 바뀌면 남은 공간을 다시 잰다. */
  readonly contentKey: string;
  /** 자리(z-index·폭)를 정하는 표면 클래스. */
  readonly className?: string;
  readonly children: ReactNode;
}

/** 덱 상자. 위로 열고, 위가 모자라면 아래로 뒤집는다. 행을 누르는 마우스는 입력의 포커스를 빼앗지 않는다. */
export function ComposerDeck({ id, label, listbox, contentKey, className, children }: ComposerDeckProps) {
  const deckRef = useRef<HTMLDivElement | null>(null);
  const placement = useComposerDeckPlacement(deckRef, contentKey);
  return (
    <div
      ref={deckRef}
      id={id}
      className={["fc-composer-deck", placement?.below ? "is-below" : null, className].filter(Boolean).join(" ")}
      {...(listbox ? { role: "listbox", "aria-label": label } : {})}
      style={placement ? { maxHeight: `${placement.maxHeight}px` } : undefined}
      // 행을 누를 때 입력이 blur 되지 않게 막는다. blur 가 먼저 오면 덱이 닫히면서 그 클릭이 어디에도 닿지 않는다.
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="fc-composer-deck-list">{children}</div>
    </div>
  );
}

/**
 * 묶음 머리 — 글자 + (보조 문구) + 오른쪽으로 이어지는 구분선. 머리만 따로 세울 때(모바일 시트 같은 덱 밖 목록) 쓴다.
 * 그림이라 aria-hidden 이고, 이름은 감싼 group 의 aria-label 이 진다.
 */
export function ComposerDeckCategory({ label, note }: { readonly label: ReactNode; readonly note?: ReactNode }) {
  return (
    <p className="fc-composer-deck-category" aria-hidden="true">
      <span>{label}</span>
      {note ? <span className="fc-composer-deck-category-note">{note}</span> : null}
      <span className="fc-composer-deck-category-rule" />
    </p>
  );
}

/**
 * 묶음 — role=group 이고 상자를 만들지 않는다(display: contents). 행이 목록 격자의 직계 칸이어야 subgrid 가 열을 받는다.
 * listbox 안에 option 도 group 도 아닌 `<p>`가 직접 섞이지 않게 머리 글자는 이 안에 둔다.
 */
export function ComposerDeckGroup({ label, note, children }: { readonly label: string; readonly note?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="fc-composer-deck-group" role="group" aria-label={label}>
      <ComposerDeckCategory label={label} note={note} />
      {children}
    </div>
  );
}

/**
 * 묶음 안의 띠(Theater·공급자) — 구분선 없는 글자 한 줄. `lead`(공급자 글리프)가 있으면 글자가 행 이름 열과 같은 x 에 서서
 * 아래 행들이 띠의 소속으로 읽힌다. `sticky` 띠는 덱이 스크롤해도 위에 붙어 출처를 놓치지 않게 한다.
 */
export function ComposerDeckBand({ label, lead, sticky = false, className }: { readonly label: ReactNode; readonly lead?: ReactNode; readonly sticky?: boolean; readonly className?: string }) {
  return (
    <p className={["fc-composer-deck-band", sticky ? "is-sticky" : null, className].filter(Boolean).join(" ")} aria-hidden="true">
      {lead ? <span className="fc-composer-deck-band-lead">{lead}</span> : null}
      <span className="fc-composer-deck-band-label">{label}</span>
    </p>
  );
}

/** 빈 상태 한 줄 — 고를 것이 없다. Enter 는 막히지 않고 쓴 문장이 그대로 나간다. */
export function ComposerDeckEmpty({ children }: { readonly children: ReactNode }) {
  return <div className="fc-composer-deck-empty" role="status">{children}</div>;
}

export interface ComposerDeckRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onMouseMove" | "onMouseDown" | "role" | "name" | "value"> {
  readonly id: string;
  readonly active: boolean;
  /** 고를 수 없는 행 — 흐리게 서고 방향키가 건너뛴다(`composerDeckKeyDown`). */
  readonly disabled?: boolean;
  /** 머리 칸(아이콘·아바타). */
  readonly lead?: ReactNode;
  readonly name: ReactNode;
  /** 지금 값·설명. */
  readonly value?: ReactNode;
  /** 오른쪽 끝 메타(능력 문구·표식). */
  readonly meta?: ReactNode;
  /** 타이핑 별칭(`/model`). */
  readonly token?: string | null;
  readonly checked?: boolean;
  readonly onPick: () => void;
  readonly onHover?: () => void;
}

/** 덱 행 — option. 포인터가 지나간 자리(mousemove)로 활성 행을 옮긴다: 방향키 뒤 포인터 아래로 미끄러져 온 행은 이동이 아니다. */
export function ComposerDeckRow({ id, active, disabled = false, lead, name, value, meta, token, checked = false, onPick, onHover, className, ...rest }: ComposerDeckRowProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  // 잘린 목록에서 하이라이트만 움직이면 활성 행이 보이지 않는다 — 최소한만 움직여(nearest) 자기 위치를 잃지 않게 한다.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <button
      {...rest}
      ref={ref}
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      className={["fc-composer-deck-row", active ? "is-active" : null, disabled ? "is-dim" : null, className].filter(Boolean).join(" ")}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => { if (!active && !disabled) onHover?.(); }}
      onClick={() => { if (!disabled) onPick(); }}
    >
      <span className="fc-composer-deck-lead" aria-hidden="true">{lead ?? null}</span>
      <span className="fc-composer-deck-name">{name}</span>
      <span className="fc-composer-deck-value">{value ?? null}</span>
      <span className="fc-composer-deck-meta">
        {meta ?? null}
        {token ? <span className="fc-composer-deck-token" aria-hidden="true">{token}</span> : null}
        {checked ? <span className="fc-composer-deck-check" aria-hidden="true">✓</span> : null}
      </span>
    </button>
  );
}

/** 덱의 키 문법이 읽는 행 — 어떤 모양이든 받고, `disabled: true` 인 행만 고를 수 없는 행으로 본다. */
export type ComposerDeckKeyRow = unknown;

function isDimRow(row: ComposerDeckKeyRow): boolean {
  return typeof row === "object" && row !== null && (row as { readonly disabled?: unknown }).disabled === true;
}

/** 지금 활성 행 — 가리킨 행을 고를 수 없으면(사라졌거나 흐린 행) 첫 고를 수 있는 행. 없으면 -1. */
export function composerDeckActiveIndex(rows: readonly ComposerDeckKeyRow[], index: number): number {
  if (index >= 0 && index < rows.length && !isDimRow(rows[index])) return index;
  return rows.findIndex((row) => !isDimRow(row));
}

/** 덱 키 처리기가 받는 키 사건의 최소 모양 — React 키 사건이 그대로 맞는다. */
export interface ComposerDeckKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly keyCode?: number;
  readonly nativeEvent: { readonly isComposing?: boolean };
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * 네 표면이 같이 쓰는 덱 키 문법. 처리했으면 true 다.
 * - ↑↓ 는 고를 수 있는 행만 돈다(끝에서 처음으로 이어진다).
 * - Enter·Tab(Shift 없이)은 활성 행을 고른다. 고를 행이 없으면 Enter 를 잡지 않는다 — 쓴 문장이 그대로 나간다.
 * - Esc 는 덱만 닫고 전파를 끊는다(바깥의 Esc — 턴 중지·화면 닫기 — 까지 올라가지 않는다).
 * 한글 조합 중의 키는 다루지 않는다(false) — 조합 중 Enter 를 조합 뒤 고르기로 미루는 일은 입력 요소를 가진 표면이 한다.
 */
export function composerDeckKeyDown(event: ComposerDeckKeyEvent, deck: {
  readonly rows: readonly ComposerDeckKeyRow[];
  readonly activeIndex: number;
  readonly setActive: (index: number) => void;
  readonly pick: (index: number) => void;
  readonly dismiss: () => void;
}): boolean {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    deck.dismiss();
    return true;
  }
  const active = composerDeckActiveIndex(deck.rows, deck.activeIndex);
  if (active < 0) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    for (let offset = 1; offset <= deck.rows.length; offset += 1) {
      const next = (active + step * offset + deck.rows.length * offset) % deck.rows.length;
      if (!isDimRow(deck.rows[next])) { deck.setActive(next); break; }
    }
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
    event.preventDefault();
    deck.pick(active);
    return true;
  }
  return false;
}
