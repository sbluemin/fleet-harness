import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ConsoleTheaterSummary } from "@fleet-console/sdk/plugin";
import type { ClientTheaterInboxCapability, TheaterInboxAddress, TheaterInboxSectionDescriptor, TheaterInboxSectionState } from "@fleet-console/sdk/theater-inbox";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { theaterInitials } from "../sidebar/theater-initials.js";
import { TheaterMonogram } from "../sidebar/theater-monogram.js";
import type { TheaterInboxOpenState } from "./store.js";
import "./theater-inbox-sheet.css";

/** 호스트가 정준 id 를 붙인 섹션. 순서가 곧 목록 순서다(호스트의 「Theater 설정」이 맨 앞). */
export interface ResolvedTheaterInboxSection {
  readonly id: string;
  readonly descriptor: TheaterInboxSectionDescriptor;
}

export interface TheaterInboxSheetProps {
  readonly open: TheaterInboxOpenState;
  readonly theater: ConsoleTheaterSummary;
  readonly sections: readonly ResolvedTheaterInboxSection[];
  readonly language: ConsoleLocale;
  readonly navigation: ClientTheaterInboxCapability;
  /** 섹션 안의 칸 고르기 — 주소만 바꾸고 포커스 요청은 만들지 않는다(목록의 키보드 이동이 제자리에 남는다). */
  readonly select: (address: TheaterInboxAddress) => void;
  /** 다른 섹션을 열 수 없을 때 돌아갈 주소 — 호스트의 시스템 프롬프트 칸. */
  readonly fallback: TheaterInboxAddress;
}

/**
 * 시트 크기 — 창 정중앙. 기본은 1080×780이고, 창이 그보다 좁으면 사방 24px 안으로 줄어든다.
 * 크기 기억은 사령관 시트 시절의 키를 그대로 쓴다 — 이 시트가 그 시트를 넓힌 것이라 사람이 맞춘 크기를 잃지 않는다.
 */
const SHEET_MARGIN = 24;
const SHEET_DEFAULT_WIDTH = 1080;
const SHEET_DEFAULT_HEIGHT = 780;
const SHEET_MIN_WIDTH = 720;
const SHEET_MIN_HEIGHT = 480;
const SHEET_SIZE_KEY = "fleet.objectives.commodore.sheetSize";
const SHEET_RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type SheetResizeDir = (typeof SHEET_RESIZE_DIRS)[number];
const SHEET_FOCUSABLE = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";
/** 시트 안에서 연 메뉴·선택 상자·달력은 body 포털이다 — Tab 순환에 함께 넣는다. */
const SHEET_PORTALS = '[role="menu"], [role="listbox"], .fc-coord-menu, .fc-select__popup, .objectives-cal';

interface SheetSize { readonly width: number; readonly height: number }

function clampSheetSize(width: number, height: number): SheetSize {
  const maxWidth = Math.max(1, window.innerWidth - SHEET_MARGIN * 2);
  const maxHeight = Math.max(1, window.innerHeight - SHEET_MARGIN * 2);
  const minWidth = Math.min(SHEET_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(SHEET_MIN_HEIGHT, maxHeight);
  return { width: Math.round(Math.max(minWidth, Math.min(width, maxWidth))), height: Math.round(Math.max(minHeight, Math.min(height, maxHeight))) };
}

function readSheetSize(): SheetSize {
  const fallback = { width: SHEET_DEFAULT_WIDTH, height: SHEET_DEFAULT_HEIGHT };
  try {
    const raw = localStorage.getItem(SHEET_SIZE_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return fallback;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return fallback;
    if (parsed.width < SHEET_MIN_WIDTH || parsed.height < SHEET_MIN_HEIGHT || parsed.width > 8000 || parsed.height > 8000) return fallback;
    return { width: parsed.width, height: parsed.height };
  } catch {
    return fallback;
  }
}

function writeSheetSize(size: SheetSize): void {
  try {
    localStorage.setItem(SHEET_SIZE_KEY, JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }));
  } catch {
    // 저장이 막혀도 지금 크기로 그린다.
  }
}

function useSheetSize() {
  const preferred = useRef<SheetSize>(readSheetSize());
  const [frame, setFrame] = useState<SheetSize>(() => clampSheetSize(preferred.current.width, preferred.current.height));
  useLayoutEffect(() => {
    const place = () => setFrame(clampSheetSize(preferred.current.width, preferred.current.height));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);
  return {
    frame,
    resize: (width: number, height: number) => {
      const next = clampSheetSize(width, height);
      preferred.current = next;
      setFrame(next);
    },
    commit: () => writeSheetSize(preferred.current),
    reset: () => {
      preferred.current = { width: SHEET_DEFAULT_WIDTH, height: SHEET_DEFAULT_HEIGHT };
      writeSheetSize(preferred.current);
      setFrame(clampSheetSize(SHEET_DEFAULT_WIDTH, SHEET_DEFAULT_HEIGHT));
    },
  };
}

/** 네 변과 네 모서리. 시트는 가운데에 고정되므로 한 변을 끌면 반대 변도 같이 움직인다. 더블클릭은 기본 크기. */
function SheetResize({ label, width, height, onResize, onCommit, onReset }: {
  readonly label: string; readonly width: number; readonly height: number;
  readonly onResize: (width: number, height: number) => void; readonly onCommit: () => void; readonly onReset: () => void;
}) {
  const drag = useRef<{ pointerId: number; dir: SheetResizeDir; x: number; y: number; w: number; h: number } | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    const dir = current.dir;
    const nextWidth = dir.includes("e") ? current.w + 2 * dx : dir.includes("w") ? current.w - 2 * dx : current.w;
    const nextHeight = dir.includes("s") ? current.h + 2 * dy : dir.includes("n") ? current.h - 2 * dy : current.h;
    onResize(nextWidth, nextHeight);
    setReadout(`${Math.round(nextWidth)} × ${Math.round(nextHeight)}`);
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    setReadout(null);
    onCommit();
  };
  return (
    <>
      {SHEET_RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`theater-inbox-resize is-${dir}`}
          role="separator"
          aria-label={label}
          title={label}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, dir, x: event.clientX, y: event.clientY, w: width, h: height };
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onReset(); }}
        />
      ))}
      {readout ? <div className="theater-inbox-size" aria-hidden="true">{readout}</div> : null}
    </>
  );
}

/** 섹션마다 `read` 를 구독한다. 아무 섹션도 바뀌지 않았으면 같은 배열을 돌려준다(useSyncExternalStore). */
function useSectionStates(sections: readonly ResolvedTheaterInboxSection[], theater: ConsoleTheaterSummary, language: ConsoleLocale): readonly TheaterInboxSectionState[] {
  const cache = useRef<readonly TheaterInboxSectionState[]>([]);
  const subscribe = useMemo(() => (listener: () => void) => {
    const offs = sections.map(({ descriptor }) => { try { return descriptor.subscribe(listener); } catch { return () => undefined; } });
    return () => { for (const off of offs) off(); };
  }, [sections]);
  const read = () => {
    const next = sections.map(({ descriptor }): TheaterInboxSectionState => {
      try { return descriptor.read(theater, language); } catch { return LOADING; }
    });
    const previous = cache.current;
    if (next.length === previous.length && next.every((state, index) => state === previous[index])) return previous;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore(subscribe, read, read);
}
const LOADING: TheaterInboxSectionState = { availability: "loading", scope: "" };

/** 시트 안을 Tab 으로 돈다 — 시트에서 연 메뉴(body 포털)까지 한 바퀴. */
function trapSheetFocus(event: KeyboardEvent, sheet: HTMLElement | null): void {
  if (!sheet) return;
  const scopes = [sheet, ...document.querySelectorAll<HTMLElement>(SHEET_PORTALS)];
  const focusable = scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)])
    .filter((element) => element.tabIndex >= 0 && element.offsetParent !== null && getComputedStyle(element).visibility !== "hidden");
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); return; }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

function canTakeFocus(element: HTMLElement | null): element is HTMLElement {
  return !!element && element.isConnected && element.offsetParent !== null && !element.closest("[inert]");
}

/** 열린 팝업(선택 상자·메뉴)이 있으면 Esc 는 그 팝업 몫이다. */
const OPEN_POPUP = '[aria-expanded="true"]:is([aria-haspopup], [role="combobox"])';

/**
 * Theater Inbox — Theater 하나의 「Theater 설정」과 플러그인 섹션(사령관 등)을 한 시트에서. 왼쪽 목록은 섹션마다 제목·대상 한 줄·
 * 칸 목록으로 나뉘고(제목 붙은 목록 둘), 오른쪽은 고른 칸. 섹션 본문은 처음 들른 뒤 시트가 열린 동안 마운트된 채로 남아,
 * 섹션을 오가도 쓰던 글을 잃지 않는다.
 */
export function TheaterInboxSheet({ open, theater, sections, language, navigation, select, fallback }: TheaterInboxSheetProps) {
  const t = useT();
  const states = useSectionStates(sections, theater, language);
  const { frame, resize, commit, reset } = useSheetSize();
  const sheetRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([open.address.sectionId]));
  const [notice, setNotice] = useState(false);
  // 숨은 섹션은 마지막으로 보던 칸을 그대로 쥔다 — 섹션을 오가도 본문이 다른 칸으로 바뀌지 않는다.
  const lastPage = useRef(new Map<string, string>());
  const choose = (address: TheaterInboxAddress) => { setNotice(false); select(address); };
  const available = (index: number) => states[index]?.availability === "available";
  const currentIndex = sections.findIndex((section) => section.id === open.address.sectionId);
  const current = currentIndex >= 0 ? sections[currentIndex] : undefined;
  const currentState = currentIndex >= 0 ? states[currentIndex] : undefined;
  const currentPage = current?.descriptor.pages.find((page) => page.id === open.address.pageId);
  const shown = current && currentPage && available(currentIndex);

  // 고른 섹션을 그릴 수 없으면(없는 섹션·없는 칸·실험 기능 꺼짐) 시트를 닫지 않고 호스트의 시스템 프롬프트 칸으로 옮긴다.
  // 아직 판단할 수 없는(loading) 섹션은 기다린다.
  useEffect(() => {
    if (shown) return;
    if (current && currentPage && currentState?.availability === "loading") return;
    setNotice(true);
    navigation.open({ theaterId: theater.id, ...fallback });
  }, [shown, current, currentPage, currentState?.availability, navigation, theater.id, fallback]);

  useEffect(() => { if (shown) setVisited((before) => before.has(open.address.sectionId) ? before : new Set(before).add(open.address.sectionId)); }, [shown, open.address.sectionId]);
  useEffect(() => { setNotice(false); }, [theater.id]);

  // 입구가 연 순간(그리고 다른 섹션으로 옮겨 온 순간)은 칸 제목이 포커스를 받는다. 본문이 더 알맞은 자리(입력란)를 알면 그 뒤에 가져간다.
  // 목록에서 칸을 고르는 동안은 포커스 요청이 없어 목록에 남는다.
  useLayoutEffect(() => {
    if (open.focusRequest?.kind === "default") titleRef.current?.focus({ preventScroll: true });
  }, [open.focusRequest]);

  const close = () => {
    const opener = open.opener;
    navigation.close();
    window.requestAnimationFrame(() => {
      if (canTakeFocus(opener)) { opener.focus({ preventScroll: true }); return; }
      // 입구가 사라졌으면(접힌 Theater 등) 같은 Theater 의 사이드바 자리로 — 숨은 요소에는 주지 않는다.
      const row = document.querySelector<HTMLElement>(`.side-bar-theater-contributions[data-theater-id="${CSS.escape(theater.id)}"] button`);
      if (canTakeFocus(row)) row.focus({ preventScroll: true });
    });
  };

  const closeRef = useRef(close);
  closeRef.current = close;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Tab") { trapSheetFocus(event, sheetRef.current); return; }
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (sheetRef.current?.querySelector(OPEN_POPUP)) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  // 포커스가 문서로 떨어진 채(눌린 메뉴 항목이 사라진 직후 등)여도 Esc 는 시트를 닫는다. 다른 곳에 포커스가 있으면 그 표면 몫이다.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pageButtons = () => [...(sheetRef.current?.querySelectorAll<HTMLButtonElement>(".theater-inbox-page") ?? [])];
  const onListKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const buttons = pageButtons();
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
    const target = buttons[next];
    if (!target) return;
    choose({ sectionId: target.dataset.section ?? "", pageId: target.dataset.page ?? "" });
    target.focus();
  };

  const links = useMemo(() => {
    const operatorIndex = sections.findIndex((section, index) => section.descriptor.operatorDirectivePageId && states[index]?.availability === "available");
    const operator = operatorIndex >= 0 ? sections[operatorIndex] : undefined;
    return {
      systemPrompt: fallback,
      operatorDirective: operator?.descriptor.operatorDirectivePageId ? { sectionId: operator.id, pageId: operator.descriptor.operatorDirectivePageId } : null,
    };
  }, [sections, states, fallback]);

  const applies = shown ? currentPage.applies?.(language) : undefined;
  const sectionTitleId = "theater-inbox-section-title";
  const pageTitleId = "theater-inbox-page-title";

  return createPortal(
    <div className="theater-inbox-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section
        ref={sheetRef}
        className="theater-inbox-sheet"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("theaterInbox.aria", { theater: theater.label })}
        style={{ width: frame.width, height: frame.height }}
        onKeyDown={onKeyDown}
      >
        <SheetResize label={t("theaterInbox.resize")} width={frame.width} height={frame.height} onResize={resize} onCommit={commit} onReset={reset} />
        <nav className="theater-inbox-nav" aria-label={t("theaterInbox.nav")}>
          <div className="theater-inbox-who">
            <span className="theater-inbox-who-mark" aria-hidden="true"><TheaterMonogram>{theaterInitials(theater.label)}</TheaterMonogram></span>
            <span className="theater-inbox-who-text">
              <small>{t("theaterInbox.kicker")}</small>
              <strong title={theater.label}>{theater.label}</strong>
            </span>
          </div>
          {sections.map((section, index) => {
            const state = states[index] ?? LOADING;
            const headingId = `theater-inbox-group-${index}`;
            const title = section.descriptor.title(language);
            return (
              <div key={section.id} className={`theater-inbox-group is-${state.availability}`}>
                <h3 className="theater-inbox-group-head" id={headingId}>
                  <span className="theater-inbox-group-icon" aria-hidden="true"><PluginErrorBoundary fallback={<></>}>{section.descriptor.icon({ theater })}</PluginErrorBoundary></span>
                  <span>{title}</span>
                </h3>
                {state.availability === "disabled" ? <p className="theater-inbox-group-note">{state.disabledNote ?? state.scope}</p> : state.scope ? <p className="theater-inbox-group-scope">{state.scope}</p> : null}
                {state.availability === "available" ? (
                  <ul className="theater-inbox-pages" aria-labelledby={headingId}>
                    {section.descriptor.pages.map((page) => {
                      const selected = section.id === open.address.sectionId && page.id === open.address.pageId;
                      return (
                        <li key={page.id}>
                          <button
                            type="button"
                            className="theater-inbox-page"
                            data-section={section.id}
                            data-page={page.id}
                            aria-current={selected ? "page" : undefined}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => choose({ sectionId: section.id, pageId: page.id })}
                            onKeyDown={onListKey}
                          >
                            {page.title(language)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </nav>
        <div className="theater-inbox-main">
          <header className="theater-inbox-head">
            <div className="theater-inbox-head-text">
              {current ? (
                <span className="theater-inbox-crumb">
                  <span className="theater-inbox-group-icon" aria-hidden="true"><PluginErrorBoundary fallback={<></>}>{current.descriptor.icon({ theater })}</PluginErrorBoundary></span>
                  <span id={sectionTitleId}>{current.descriptor.title(language)}</span>
                </span>
              ) : null}
              <h2 ref={titleRef} id={pageTitleId} className="theater-inbox-title" tabIndex={-1}>{currentPage?.title(language) ?? ""}</h2>
            </div>
            <button type="button" className="theater-inbox-close" aria-label={t("theaterInbox.close")} title={t("theaterInbox.close")} onClick={close}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </header>
          {notice ? <p className="theater-inbox-notice" role="status">{t("theaterInbox.unavailable")}</p> : null}
          <div className="theater-inbox-region" role="region" aria-labelledby={`${sectionTitleId} ${pageTitleId}`}>
            {sections.map((section, index) => {
              if (!visited.has(section.id) || !available(index)) return null;
              const visible = section.id === open.address.sectionId && !!shown;
              if (visible) lastPage.current.set(section.id, open.address.pageId);
              const pageId = lastPage.current.get(section.id) ?? section.descriptor.pages[0]?.id ?? "";
              return (
                <div key={`${section.id}:${theater.id}`} className="theater-inbox-section" hidden={!visible}>
                  <PluginErrorBoundary>
                    {section.descriptor.render({
                      theater,
                      language,
                      pageId,
                      visible,
                      focusRequest: visible ? open.focusRequest : null,
                      links,
                      navigation,
                    })}
                  </PluginErrorBoundary>
                </div>
              );
            })}
            {currentState?.availability === "loading" ? <p className="theater-inbox-loading" role="status">…</p> : null}
          </div>
          {applies ? <p className="theater-inbox-applies"><span>{t("theaterInbox.applies")}</span>{applies}</p> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
