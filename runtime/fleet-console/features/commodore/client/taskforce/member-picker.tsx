import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CommodoreAvatar } from "../commodore-avatar.js";

export interface MemberPickerCandidate {
  readonly id: string;
  readonly name: string;
}

/**
 * 태스크포스 멤버 고르기 — '+ 멤버 추가' 트리거 아래에 뜨는 둥근 검색 드롭다운이다.
 * 멤버 탭과 새 태스크포스 화면이 같은 것을 쓴다. portal + fixed라
 * `.taskforce-dialog`의 `overflow: auto` 안에 잘리지 않고 아래 내용을 덮는다.
 */
export function MemberPicker({ anchor, candidates, searchPlaceholder, emptyText, listLabel, onPick, onClose }: {
  readonly anchor: HTMLElement | null;
  readonly candidates: readonly MemberPickerCandidate[];
  readonly searchPlaceholder: string;
  readonly emptyText: string;
  readonly listLabel: string;
  readonly onPick: (id: string) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const pick = useRef(onPick); pick.current = onPick;
  const close = useRef(onClose); close.current = onClose;
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? candidates.filter((row) => row.name.toLowerCase().includes(needle)) : candidates;
  }, [candidates, query]);
  const clamped = filtered.length ? Math.min(active, filtered.length - 1) : 0;
  const activeId = filtered.length ? `${baseId}-option-${filtered[clamped]!.id}` : undefined;

  // 자리는 실측으로 정한다 — 카드 폭은 고정, 높이는 후보 수에 따라 달라진다.
  useLayoutEffect(() => {
    if (!anchor) return;
    const card = rootRef.current;
    if (!card) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(PICKER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN));
    card.style.width = `${width}px`;
    const height = card.offsetHeight;
    const below = rect.bottom + PICKER_GAP;
    const above = rect.top - PICKER_GAP - height;
    const top = below + height + VIEWPORT_MARGIN <= window.innerHeight
      ? below
      : above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    setStyle({ left, top: Math.round(top) });
  }, [anchor, filtered.length]);

  // 첫 렌더는 숨김 자리(style 미정)라 focus가 무시된다 — 위치가 정해져 보이게 된 뒤에 둔다.
  useEffect(() => {
    if (style) inputRef.current?.focus({ preventScroll: true });
  }, [style]);

  // 활성 행이 목록 스크롤 밖에 있으면 따라간다.
  useEffect(() => {
    optionRefs.current.get(clamped)?.scrollIntoView({ block: "nearest" });
  }, [clamped, filtered.length]);

  useEffect(() => {
    if (!anchor) return;
    const closeWithFocus = () => { close.current(); if (anchor.isConnected) anchor.focus({ preventScroll: true }); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closeWithFocus(); }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) { close.current(); return; }
      if (rootRef.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close.current();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close.current);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close.current);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor]);

  if (!anchor) return null;
  const choose = (id: string) => {
    pick.current(id);
    close.current();
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActive(filtered.length ? (clamped + 1) % filtered.length : 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(filtered.length ? (clamped - 1 + filtered.length) % filtered.length : 0); }
    else if (event.key === "Enter") { event.preventDefault(); const row = filtered[clamped]; if (row) choose(row.id); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); if (anchor.isConnected) anchor.focus({ preventScroll: true }); }
  };
  return createPortal(
    <div
      ref={rootRef}
      className="taskforce-picker"
      style={style ?? { visibility: "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="search"
        className="taskforce-picker-search"
        value={query}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        {...(activeId ? { "aria-activedescendant": activeId } : {})}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={onInputKeyDown}
      />
      <div id={listId} className="taskforce-picker-list" role="listbox" aria-label={listLabel}>
        {filtered.length ? filtered.map((row, index) => (
          <button
            key={row.id}
            id={`${baseId}-option-${row.id}`}
            ref={(node) => {
              if (node) optionRefs.current.set(index, node);
              else optionRefs.current.delete(index);
            }}
            type="button"
            role="option"
            aria-selected={index === clamped}
            tabIndex={-1}
            className="taskforce-picker-option"
            data-active={index === clamped}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(row.id)}
          >
            <CommodoreAvatar commodoreId={row.id} state="idle" size={28} label="" decorative />
            <span>{row.name}</span>
          </button>
        )) : <p className="taskforce-picker-empty">{emptyText}</p>}
      </div>
    </div>,
    document.body,
  );
}

const PICKER_WIDTH = 220;
const PICKER_GAP = 8;
const VIEWPORT_MARGIN = 8;
