import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ModelCoordinatePicker, rosterCoordinateWords, type ModelCoordinateValue } from "@fleet-console/sdk/components/model-coordinate-picker";
import { ComposerInput, ComposerSubmitButton } from "@fleet-console/sdk/composer";
import type { Translate } from "@fleet-console/sdk/i18n";
import { isAgentEffort, type ModelRosterTarget } from "@fleet-console/sdk/models";
import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

import type { CommodoreLiveEvent, CommodorePatrolMinutes, CommodoreRunStatus, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { commodoreLogBlocks, commodoreTurnCovering, errorWord, type CommodoreLogTurn } from "./commodore-chat.js";
import { CommodoreTrail } from "./commodore-trail.js";
import { clampTrailWidth, CommodoreTrailSeam, readTrailWidth, TRAIL_WIDTH_DEFAULT, writeTrailWidth } from "./commodore-trail-seam.js";
import { clockTime } from "./commodore-row.js";
import {
  addCommodoreIntel,
  closeCommodoreDrawer,
  commodoreTranscriptRenderer,
  commodoreTheaterLabel,
  loadTranscript,
  messageCommodore,
  noteCommodoreLanguage,
  removeCommodoreIntel,
  retryCommodore,
  routeCommodoreDrawerToMobile,
  saveCommodoreDirective,
  setCommodoreAutonomy,
  setCommodoreCommander,
  setCommodoreCoordinates,
  setCommodorePatrol,
  setCommodoreTab,
  useCommodore,
  useCommodoreDrawer,
  useCommodoreEnabled,
  useCommodoreRoster,
  type CommodoreTab,
} from "./commodore-state.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH } from "./launch-control.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 시트 크기 — 퀵런치처럼 창 정중앙. 기본은 1080×780이고, 창이 그보다 좁으면 사방 24px 안으로 줄어든다.
 * 사이드바를 열고 닫아도 자리는 바뀌지 않는다.
 */
const SHEET_MARGIN = 24;
const SHEET_DEFAULT_WIDTH = 1080;
const SHEET_DEFAULT_HEIGHT = 780;
const SHEET_MIN_WIDTH = 720;
const SHEET_MIN_HEIGHT = 480;
/** 시트가 이보다 좁으면 구역 목록을 글리프만 남긴다. */
const SHEET_COMPACT_WIDTH = 720;
const SHEET_SIZE_KEY = "fleet.objectives.commodore.sheetSize";
const SHEET_RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type SheetResizeDir = (typeof SHEET_RESIZE_DIRS)[number];
/** 서버 `COMMODORE_CONTEXT_ROTATE_RATIO` 와 같다. 그 파일은 서버 모듈이라 브라우저가 값으로 가져오지 않는다. */
const CONTEXT_ROTATE_RATIO = 0.75;
const SHEET_FOCUSABLE = "a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex='-1'])";
/** 순찰 간격 사다리 — 서버 `COMMODORE_PATROL_MINUTES` 와 같다(서버 모듈은 브라우저 번들에 싣지 않는다). */
export const PATROL_STEPS: readonly CommodorePatrolMinutes[] = [15, 30, 60, 120, 240, 480];
export const DEFAULT_PATROL: CommodorePatrolMinutes = 60;
const PATROL_MENU_WIDTH = 248;
const PATROL_MENU_MARGIN = 12;

/** 상주 기여 — 시트는 사령관 줄이 접혀 사라져도 열린 채로 남는다. */
export function CommodoreDrawerHost({ language, layout }: PersistentComponentContext) {
  const enabled = useCommodoreEnabled();
  const drawer = useCommodoreDrawer();
  const mobile = layout === "mobile";
  // 폰 배치에서는 이 시트가 서지 않는다 — 사령관은 드로어 목적지 화면이다. 서랍을 여는 길(데스크톱에서 연 채 보기를 바꾼 경우 등)은
  // 서랍을 닫고 같은 구역으로 그 화면을 연다.
  useEffect(() => { if (mobile && drawer) routeCommodoreDrawerToMobile(); }, [mobile, drawer]);
  // 상주 기여라 서랍이 닫혀 있어도 언어를 알린다 — 리액트 밖의 Quick Launch '@' 행이 이 값으로 문구를 고른다.
  if (language) noteCommodoreLanguage(language);
  if (!enabled || !drawer || mobile) return null;
  return <CommodoreSheet key={drawer.theaterId} theaterId={drawer.theaterId} tab={drawer.tab} openedAt={drawer.openedAt} language={language ?? "en"} />;
}

function rowElement(theaterId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.objectives-commodore-row[data-theater-id="${CSS.escape(theaterId)}"]`);
}

interface SheetFrame {
  readonly width: number;
  readonly height: number;
  /** 좁은 시트 — 구역 목록이 글리프만 남는다. */
  readonly compact: boolean;
}

interface SheetPreferred { readonly width: number; readonly height: number }

/** 창 안에 넣는 크기. 최소 720×480, 최대는 사방 24px. 창이 최소보다 작으면 창 안을 따른다. */
function clampSheetSize(width: number, height: number): SheetFrame {
  const maxWidth = Math.max(1, window.innerWidth - SHEET_MARGIN * 2);
  const maxHeight = Math.max(1, window.innerHeight - SHEET_MARGIN * 2);
  const minWidth = Math.min(SHEET_MIN_WIDTH, maxWidth);
  const minHeight = Math.min(SHEET_MIN_HEIGHT, maxHeight);
  const nextWidth = Math.round(Math.max(minWidth, Math.min(width, maxWidth)));
  const nextHeight = Math.round(Math.max(minHeight, Math.min(height, maxHeight)));
  return { width: nextWidth, height: nextHeight, compact: nextWidth < SHEET_COMPACT_WIDTH };
}

function readSheetSize(): SheetPreferred {
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

function writeSheetSize(size: SheetPreferred): void {
  try {
    localStorage.setItem(SHEET_SIZE_KEY, JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }));
  } catch {
    // 저장이 막혀도 지금 크기로 그린다.
  }
}

function useCommodoreSheetSize(): { readonly frame: SheetFrame; readonly resize: (width: number, height: number) => void; readonly commit: () => void; readonly reset: () => void } {
  const preferred = useRef<SheetPreferred>(readSheetSize());
  const [frame, setFrame] = useState<SheetFrame>(() => clampSheetSize(preferred.current.width, preferred.current.height));
  useLayoutEffect(() => {
    const place = () => setFrame(clampSheetSize(preferred.current.width, preferred.current.height));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);
  const resize = (width: number, height: number) => {
    const next = clampSheetSize(width, height);
    preferred.current = { width: next.width, height: next.height };
    setFrame(next);
  };
  const commit = () => writeSheetSize(preferred.current);
  const reset = () => {
    preferred.current = { width: SHEET_DEFAULT_WIDTH, height: SHEET_DEFAULT_HEIGHT };
    writeSheetSize(preferred.current);
    setFrame(clampSheetSize(SHEET_DEFAULT_WIDTH, SHEET_DEFAULT_HEIGHT));
  };
  return { frame, resize, commit, reset };
}

/** 네 변과 네 모서리. 시트는 가운데에 고정되므로 한 변을 끌면 반대 변도 같이 움직인다. 더블클릭은 기본 크기. */
function SheetResize({ label, width, height, onResize, onCommit, onReset }: {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly onResize: (width: number, height: number) => void;
  readonly onCommit: () => void;
  readonly onReset: () => void;
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
          className={`objectives-commodore-resize is-${dir}`}
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
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onReset(); } }}
        />
      ))}
      {readout ? <div className="objectives-commodore-size" aria-hidden="true">{readout}</div> : null}
    </>
  );
}

/** 시트와, 시트에서 연 메뉴(body 포털) 안에서 Tab을 가둔다. */
function trapSheetFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const scopes = [dialog, ...document.querySelectorAll<HTMLElement>('[role="menu"], .fc-coord-menu')];
  const focusable = scopes.flatMap((scope) => [...scope.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)])
    .filter((element) => element.tabIndex >= 0 && element.offsetParent !== null && getComputedStyle(element).visibility !== "hidden");
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

const NAV_GLYPHS: Record<CommodoreTab, ReactNode> = {
  log: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 4.5h11M3.5 9h11M3.5 13.5h7" /></svg>,
  directive: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 15.5V2.75M4.5 3.25h8.25l-1.75 3 1.75 3H4.5" /></svg>,
  intel: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="1.6" /><path d="M5.6 12.4a4.8 4.8 0 0 1 0-6.8M12.4 5.6a4.8 4.8 0 0 1 0 6.8M3.4 14.6a8 8 0 0 1 0-11.2M14.6 3.4a8 8 0 0 1 0 11.2" /></svg>,
  settings: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7" /><circle cx="11.5" cy="5" r="1.6" /><circle cx="6.5" cy="13" r="1.6" /></svg>,
};

/**
 * 「사령관 기록」 시트 — 퀵런치와 같이 창 전체를 덮고 정중앙에 선다. 왼쪽은 구역 목록(기록·지시·정보·설정)과 사령관의 지금,
 * 오른쪽은 고른 구역. 배경을 누르거나 Esc 로 닫힌다.
 */
function CommodoreSheet({ theaterId, tab, openedAt, language }: { readonly theaterId: string; readonly tab: CommodoreTab; readonly openedAt: number; readonly language: "en" | "ko" }) {
  const t = getT(language);
  noteCommodoreLanguage(language);
  const { view, entries, live, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const { frame, resize, commit, reset } = useCommodoreSheetSize();
  const dialogRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Record<CommodoreTab, HTMLButtonElement | null>>({ log: null, directive: null, intel: null, settings: null });
  const [failure, setFailure] = useState<string | null>(null);
  // 곁 칸에서 고른 시각 — 기록 칸이 그 시각의 턴을 드러낸다. 같은 줄을 다시 눌러도 다시 드러나게 nonce 가 오른다.
  const [reveal, setReveal] = useState<{ readonly at: number; readonly nonce: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [trailPreferred, setTrailPreferred] = useState(readTrailWidth);
  const [logBodyWidth, setLogBodyWidth] = useState(0);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const measure = () => setLogBodyWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const measured = logBodyWidth > 0;
  const trailWidth = measured ? clampTrailWidth(trailPreferred, logBodyWidth) : trailPreferred;
  const setTrailWidth = (next: number) => {
    const clamped = clampTrailWidth(next, logBodyWidth);
    setTrailPreferred(clamped);
    writeTrailWidth(clamped);
  };
  // 더블클릭·Enter는 기본 260을 기억한다. 지금 본문이 좁으면 화면에는 절반까지만 그리고, 본문이 넓어지면 기본으로 돌아온다.
  const resetTrailWidth = () => {
    setTrailPreferred(TRAIL_WIDTH_DEFAULT);
    writeTrailWidth(TRAIL_WIDTH_DEFAULT);
  };
  const label = commodoreTheaterLabel(theaterId);
  const on = view?.state.autonomy === true;
  const run = view?.run;

  // 열릴 때 — 지시 탭으로 열었으면 입력란에, 아니면 고른 구역에 초점을 둔다. 초점은 열 때 한 번만 옮긴다.
  useEffect(() => {
    const target = dialogRef.current?.querySelector<HTMLElement>(tab === "directive" ? "textarea" : "[role='tab'][aria-selected='true']");
    target?.focus({ preventScroll: true });
  }, [openedAt]); // eslint-disable-line react-hooks/exhaustive-deps -- 여는 순간만.

  const close = () => {
    closeCommodoreDrawer();
    rowElement(theaterId)?.querySelector<HTMLElement>(".objectives-commodore-row-main")?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Tab") { trapSheetFocus(event, dialogRef.current); return; }
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const fail = (error: unknown) => {
    const code = error instanceof Error ? error.message : "failed";
    setFailure(code === "commodore_disabled" ? t("objectives.commodore.failed.disabled") : code === "commodore_inactive" ? t("objectives.commodore.failed.inactive") : t("objectives.commodore.failed", { code }));
  };
  const tabs: readonly { readonly id: CommodoreTab; readonly label: string }[] = [
    { id: "log", label: t("objectives.commodore.tabs.log") },
    { id: "directive", label: t("objectives.commodore.tabs.directive") },
    { id: "intel", label: t("objectives.commodore.tabs.intel") },
    { id: "settings", label: t("objectives.commodore.tabs.settings") },
  ];
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowDown" ? 1 : tabs.length - 1)) % tabs.length;
    const id = tabs[next]!.id;
    setCommodoreTab(id);
    tabRefs.current[id]?.focus();
  };

  const status = !view ? "" : [
    on ? t("objectives.commodore.meta.autonomous") : t("objectives.commodore.meta.manual"),
    on && run?.phase === "idle" && run.nextWakeAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null,
    on && run?.phase === "turn" ? t("objectives.commodore.meta.turn") : null,
    on && run?.phase === "retrying" && run.nextWakeAt ? t("objectives.commodore.drawer.retryAt", { time: clockTime(run.nextWakeAt) }) : null,
    on && run?.phase === "error" ? `${t("objectives.commodore.meta.error")}${run.reason ? ` · ${errorWord(t, run.reason)}` : ""}` : null,
  ].filter(Boolean).join(" · ");
  const totals = !view ? "" : [
    run && run.totals.session > 0 ? t("objectives.commodore.drawer.session", { n: run.totals.session }) : null,
    t("objectives.commodore.drawer.cost", { cost: (run?.totals.costUsd ?? 0).toFixed(2) }),
  ].filter(Boolean).join(" · ");
  const current = tabs.find((item) => item.id === tab) ?? tabs[0]!;

  return createPortal(
    <div className="objectives-commodore-overlay" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section
        ref={dialogRef}
        className={`objectives-commodore-sheet${frame.compact ? " is-compact" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("objectives.commodore.drawer.aria", { theater: label })}
        style={{ width: frame.width, height: frame.height }}
        onKeyDown={onKeyDown}
      >
        <SheetResize label={t("objectives.commodore.sheet.resize")} width={frame.width} height={frame.height} onResize={resize} onCommit={commit} onReset={reset} />
        <nav className="objectives-commodore-nav" aria-label={t("objectives.commodore.tabs.aria")}>
          <div className="objectives-commodore-nav-id">
            <p className="objectives-commodore-nav-kicker">{t("objectives.commodore.sheet.kicker")}</p>
            <p className="objectives-commodore-nav-theater" title={label}>{label || t("objectives.commodore.name")}</p>
            <p className={`objectives-commodore-nav-status${on ? " is-on" : ""}`}>{status}</p>
          </div>
          <div className="objectives-commodore-nav-list" role="tablist" aria-orientation="vertical" aria-label={t("objectives.commodore.tabs.aria")}>
            {tabs.map((item, index) => (
              <button
                key={item.id}
                ref={(node) => { tabRefs.current[item.id] = node; }}
                type="button"
                role="tab"
                id={`objectives-commodore-tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls={`objectives-commodore-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                className="objectives-commodore-nav-item"
                title={item.label}
                onClick={() => setCommodoreTab(item.id)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                <span className="objectives-commodore-nav-glyph">{NAV_GLYPHS[item.id]}</span>
                <span className="objectives-commodore-nav-label">{item.label}</span>
              </button>
            ))}
          </div>
          {totals ? <p className="objectives-commodore-nav-foot">{totals}</p> : null}
        </nav>
        <div className="objectives-commodore-main">
          <header className="objectives-commodore-main-head">
            <h2 className="objectives-commodore-main-title">{current.label}</h2>
            <button type="button" className="objectives-commodore-close" aria-label={t("objectives.commodore.drawer.close")} title={t("objectives.commodore.drawer.close")} onClick={close}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </header>
          {on && (run?.phase === "retrying" || run?.phase === "error") ? (
            <div className="objectives-commodore-retry">
              <span>{run.reason ? errorWord(t, run.reason) : t("objectives.commodore.meta.error")}</span>
              <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(theaterId).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button>
            </div>
          ) : null}
          <div ref={bodyRef} className={`objectives-commodore-body is-${tab}`} role="tabpanel" id={`objectives-commodore-panel-${tab}`} aria-labelledby={`objectives-commodore-tab-${tab}`}>
            {tab === "log" ? (
              <>
                <CommodoreLog t={t} language={language} theaterId={theaterId} entries={entries} live={live} hasMore={hasMore} loaded={transcriptLoaded} reveal={reveal} />
                {frame.compact ? null : (
                  <CommodoreTrailSeam
                    label={t("objectives.commodore.trail.resize")}
                    value={trailWidth}
                    bodyWidth={logBodyWidth}
                    onChange={setTrailWidth}
                    onReset={resetTrailWidth}
                  />
                )}
                <CommodoreTrail t={t} language={language} theaterId={theaterId} width={frame.compact || !measured ? undefined : trailWidth} onReveal={(at) => setReveal((current) => ({ at, nonce: (current?.nonce ?? 0) + 1 }))} />
              </>
            ) : null}
            {tab === "directive" && view ? <CommodoreDirective t={t} theaterId={theaterId} directive={view.state.directive} active={view.active} onFail={fail} onClear={() => setFailure(null)} /> : null}
            {tab === "intel" && view ? <CommodoreIntel t={t} theaterId={theaterId} intel={view.state.intel} sources={view.state.sources} onFail={fail} onClear={() => setFailure(null)} /> : null}
            {tab === "settings" && view ? <CommodoreSettings t={t} theaterId={theaterId} view={view} onFail={(error) => { fail(error); }} onClear={() => setFailure(null)} /> : null}
          </div>
          {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
          {tab === "log" ? <footer className="objectives-commodore-foot"><CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : true} context={run?.context} onFail={fail} onClear={() => setFailure(null)} /></footer> : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/* ── 설정 ─────────────────────────────────────────────────────────────── */

type CommodoreView = NonNullable<ReturnType<typeof useCommodore>["view"]>;

/** 「기본값 사용」 — 설정 줄 설명 끝의 글자 단추. 기본값을 쓰는 중이면 서지 않는다. */
function UseDefault({ t, onClick }: { readonly t: T; readonly onClick: () => void }) {
  return <> <button type="button" className="objectives-commodore-default" onClick={onClick}>{t("objectives.commodore.settings.useDefault")}</button></>;
}

/**
 * 사령관·지휘관 좌표 한 칸 — Console 공유 선택기(설정 행의 선택 상자). 사령관 세션은 `agent` 대상이라 ULTRACODE가 서지 않고,
 * 지휘관은 Agent CLI 실행 대상이라 선다. 로스터 밖 저장값은 「꺼짐」으로 남아 보이고, 실행만 폴백한다. 폰 설정 화면 안에서는
 * 호스트의 좌표 시트로 열린다. 값이 비면 `fallback`(기본 좌표)을 보이고, `reset`은 그 기본값의 낱말을 설명으로 단다.
 */
export function CommodoreCoordinateField({ t, target, label, value, fallback, disabled, reset, onChange }: {
  readonly t: T;
  readonly target: ModelRosterTarget;
  readonly label: string;
  readonly value: ModelCoordinateValue;
  readonly fallback: ModelCoordinateValue;
  readonly disabled?: boolean;
  readonly reset?: { readonly label: string; readonly onSelect: () => void };
  readonly onChange: (next: { readonly model?: string; readonly effort?: string }) => void;
}) {
  const roster = useCommodoreRoster(target);
  const auto = t("objectives.commander.effortAuto");
  const fallbackWords = rosterCoordinateWords(roster, fallback, auto);
  return (
    <ModelCoordinatePicker
      roster={roster}
      value={value}
      fallback={fallback}
      onChange={onChange}
      startAt="list"
      {...(disabled ? { disabled } : {})}
      {...(reset ? { reset: { ...reset, description: [fallbackWords.model, fallbackWords.effort].filter(Boolean).join(" · ") } } : {})}
      labels={{
        menu: label,
        effort: t("objectives.commander.effortAria"),
        auto,
        back: t("objectives.launch.backToModels"),
        loading: t("objectives.launch.loading"),
        empty: t("objectives.launch.empty"),
        off: t("objectives.launch.off"),
        fallback: t("objectives.launch.fallback"),
      }}
      menuClassName="objectives-commodore-coord-menu"
      trigger={{ variant: "field" }}
    />
  );
}

/**
 * 설정 — Console 설정과 같은 줄(제목·설명·오른쪽 컨트롤). 모델·강도는 Console 공유 선택기 하나로 고른다(사령관은 Agent SDK
 * 로스터, 지휘관은 Agent CLI 로스터).
 */
function CommodoreSettings({ t, theaterId, view, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly view: CommodoreView; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const { state, defaults, run } = view;
  const on = state.autonomy === true;
  const modelOverridden = state.model !== undefined;
  const patrol = state.patrolMinutes ?? DEFAULT_PATROL;
  const commanderOverridden = state.commanderModel !== undefined;
  const act = (work: () => Promise<void>) => { onClear(); void work().catch(onFail); };
  return (
    <div className="objectives-commodore-settings">
      <SettingsRow label={t("objectives.commodore.settings.autonomy")} hint={t("objectives.commodore.settings.autonomyHint")}>
        <SettingsToggle checked={on} ariaLabel={t("objectives.commodore.switchAria")} onChange={(next) => act(() => setCommodoreAutonomy(theaterId, next))} />
      </SettingsRow>
      <SettingsRow
        label={t("objectives.commodore.settings.model")}
        hint={<>{t("objectives.commodore.settings.modelHint")}{modelOverridden ? <UseDefault t={t} onClick={() => act(() => setCommodoreCoordinates(theaterId, null))} /> : null}</>}
      >
        <CommodoreCoordinateField
          t={t}
          target="agent"
          label={t("objectives.commodore.drawer.modelAria")}
          value={commodoreValue(state)}
          fallback={defaults}
          onChange={(next) => act(() => setCommodoreCoordinates(theaterId, commodoreCoordinates(state, defaults, next)))}
        />
      </SettingsRow>
      <SettingsRow
        label={t("objectives.commodore.settings.patrol")}
        hint={<>{t("objectives.commodore.settings.patrolHint")}{state.patrolMinutes !== undefined ? <UseDefault t={t} onClick={() => act(() => setCommodorePatrol(theaterId, null))} /> : null}</>}
      >
        <PatrolControl
          t={t}
          minutes={patrol}
          nextPatrolAt={on && run.phase === "idle" ? run.nextWakeAt : undefined}
          onPick={(minutes) => act(() => setCommodorePatrol(theaterId, minutes === DEFAULT_PATROL ? null : minutes))}
        />
      </SettingsRow>
      <div className="objectives-commodore-settings-divider" role="separator" />
      <SettingsRow
        label={t("objectives.commodore.settings.commander")}
        hint={<>{t("objectives.commodore.settings.commanderHint")}{commanderOverridden ? <UseDefault t={t} onClick={() => act(() => setCommodoreCommander(theaterId, null))} /> : null}</>}
      >
        <CommodoreCoordinateField
          t={t}
          target="launch"
          label={t("objectives.commodore.settings.commanderAria")}
          value={commanderValue(state)}
          fallback={DEFAULT_LAUNCH}
          onChange={(next) => act(() => setCommodoreCommander(theaterId, commanderCoordinates(state, next)))}
        />
      </SettingsRow>
    </div>
  );
}

type CommodoreStateFields = CommodoreView["state"];

/** 사령관 좌표의 저장값 — 비어 있으면 선택기가 실험 기능 행의 기본값을 보인다. */
export function commodoreValue(state: CommodoreStateFields): ModelCoordinateValue {
  return { ...(state.model ? { model: state.model } : {}), ...(state.effort ? { effort: state.effort } : {}) };
}

/**
 * 고른 사령관 좌표 — 모델과 강도를 함께 저장한다. 트랙의 「자동」이나 강도를 받지 않는 모델이면 지금 강도(없으면 실험 기능
 * 행의 강도)를 남긴다: 실행은 행 사다리 안으로 클램프되고, 강도 있는 모델로 돌아오면 그 값이 산다.
 */
export function commodoreCoordinates(state: CommodoreStateFields, defaults: CommodoreView["defaults"], next: { readonly model?: string; readonly effort?: string }) {
  const model = next.model ?? state.model ?? defaults.model;
  const effort = isAgentEffort(next.effort) ? next.effort : state.effort ?? defaults.effort;
  return { model, effort };
}

/** 지휘관 좌표의 저장값 — 비어 있으면 선택기가 보드 기본값(DEFAULT_LAUNCH)을 보인다. */
export function commanderValue(state: CommodoreStateFields): ModelCoordinateValue {
  return state.commanderModel ? { model: state.commanderModel, ...(state.commanderEffort ? { effort: state.commanderEffort } : {}) } : {};
}

export function commanderCoordinates(state: CommodoreStateFields, next: { readonly model?: string; readonly effort?: string }) {
  const model = next.model ?? state.commanderModel ?? DEFAULT_LAUNCH.model;
  const effort = next.effort ?? (next.model ? undefined : state.commanderEffort);
  return { model, ...(effort ? { effort } : {}) };
}

/* ── 순찰 간격 ───────────────────────────────────────────────────────── */

export function patrolWord(t: T, minutes: number): string {
  if (minutes < 60) return t("objectives.commodore.patrol.minutes", { n: minutes });
  return minutes === 60 ? t("objectives.commodore.patrol.hour") : t("objectives.commodore.patrol.hours", { n: minutes / 60 });
}

const PatrolGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8.5" r="5.25" />
    <path d="M8 5.75V8.5l1.9 1.2M6.5 1.75h3" />
  </svg>
);

const CheckGlyph = () => <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.75 6.25 5 8.5l4.25-5" /></svg>;

/**
 * 순찰 간격 — 모델 칩 옆의 같은 문법(글리프 + 낱말)이고, 누르면 같은 유리 메뉴에 사다리가 선다. 고르면 곧바로 저장하고 닫힌다.
 * 메뉴는 body 포털이라 서랍의 Esc(서랍 닫기)에 닿지 않게 키 입력을 메뉴 안에서 끝낸다.
 */
function PatrolControl({ t, minutes, nextPatrolAt, onPick }: { readonly t: T; readonly minutes: number; readonly nextPatrolAt: number | undefined; readonly onPick: (minutes: CommodorePatrolMinutes) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef(false);
  const word = patrolWord(t, minutes);
  const title = [t("objectives.commodore.patrol.title", { interval: word }), nextPatrolAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(nextPatrolAt) }) : null].filter(Boolean).join(" · ");

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(PATROL_MENU_MARGIN, Math.min(rect.right - PATROL_MENU_WIDTH, window.innerWidth - PATROL_MENU_WIDTH - PATROL_MENU_MARGIN));
    const height = menuRef.current?.offsetHeight ?? 300;
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - PATROL_MENU_MARGIN ? Math.max(PATROL_MENU_MARGIN, rect.top - height - 6) : below;
    setPos({ left, top, width: PATROL_MENU_WIDTH });
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const close = (refocus: boolean) => { setOpen(false); if (refocus) triggerRef.current?.focus({ preventScroll: true }); };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => { event.preventDefault(); items[(next + items.length) % items.length]?.focus(); };
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") close(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // 설정 행의 값 자리 — 모델 좌표 선택기의 field 변형과 같은 호스트 계약(fc-row-value)으로 그린다.
        className="fc-row-value objectives-commodore-patrol"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("objectives.commodore.patrol.aria")} · ${word}`}
        title={title}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusOnOpen.current = true; setOpen(true); } }}
        onClick={(event) => { focusOnOpen.current = event.detail === 0; setOpen((value) => !value); }}
      >
        <span className="objectives-commodore-patrol-glyph"><PatrolGlyph /></span>
        <span className="fc-row-value-text">{word}</span>
      </button>
      {open ? createPortal(
        <div ref={menuRef} className="objectives-menu objectives-commodore-patrol-menu" role="menu" aria-label={t("objectives.commodore.patrol.aria")} style={pos} onKeyDown={onMenuKey}>
          <div className="objectives-menu-head">
            <b>{t("objectives.commodore.patrol.head")}</b>
            <span>{t("objectives.commodore.patrol.hint")}</span>
          </div>
          {PATROL_STEPS.map((step) => {
            const active = step === minutes;
            return (
              <button key={step} type="button" role="menuitemradio" aria-checked={active} className={`objectives-menu-item${active ? " is-active" : ""}`} onClick={() => { if (!active) onPick(step); close(true); }}>
                <span className="objectives-menu-label">{patrolWord(t, step)}</span>
                {step === DEFAULT_PATROL ? <span className="objectives-menu-hint">{t("objectives.commodore.patrol.default")}</span> : null}
                <span className="objectives-menu-chev objectives-commodore-patrol-check" aria-hidden="true">{active ? <CheckGlyph /> : null}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/* ── 기록 ─────────────────────────────────────────────────────────────── */

/** 바닥에서 이만큼 안이면 새 줄을 따라 내려간다 — 위를 읽는 중이면 자리를 지킨다. */
const FOLLOW_SLACK_PX = 48;

/**
 * 사령관 기록 — Operation 채팅과 같은 턴 렌더러로 그린다. 진행 중인 턴과 마지막으로 끝난 턴만 펼치고,
 * 그 전 턴은 「출처 · 답 첫 줄 · 걸린 시간 · 시각」 한 줄로 접는다. 줄 자체가 버튼이고, 곁 칸에서 시각을 누르면 그 턴이 펼쳐진다.
 */
function CommodoreLog({ t, language, theaterId, entries, live, hasMore, loaded, reveal }: { readonly t: T; readonly language: "en" | "ko"; readonly theaterId: string; readonly entries: readonly CommodoreTranscriptEntry[]; readonly live: readonly CommodoreLiveEvent[]; readonly hasMore: boolean; readonly loaded: boolean; readonly reveal: { readonly at: number; readonly nonce: number } | null }) {
  const Transcript = commodoreTranscriptRenderer();
  const blocks = useMemo(() => commodoreLogBlocks(t, entries, live), [t, entries, live]);
  const lastFinishedId = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block?.kind === "turn" && !block.turn.working) return block.turn.id;
    }
    return null;
  }, [blocks]);
  const [pinnedOpen, setPinnedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedClosed, setPinnedClosed] = useState<ReadonlySet<string>>(() => new Set());
  const revealedId = reveal ? commodoreTurnCovering(blocks, reveal.at)?.id ?? null : null;
  useEffect(() => {
    if (!revealedId) return;
    setPinnedOpen((current) => (current.has(revealedId) ? current : new Set(current).add(revealedId)));
    setPinnedClosed((current) => {
      if (!current.has(revealedId)) return current;
      const next = new Set(current);
      next.delete(revealedId);
      return next;
    });
  }, [reveal?.nonce, revealedId]);
  const openTurn = (turn: CommodoreLogTurn) => turn.working || pinnedOpen.has(turn.id) || (!pinnedClosed.has(turn.id) && turn.id === lastFinishedId);
  const toggleTurn = (turn: CommodoreLogTurn) => {
    if (turn.working) return;
    const open = openTurn(turn);
    setPinnedOpen((current) => {
      const next = new Set(current);
      if (open) next.delete(turn.id);
      else next.add(turn.id);
      return next;
    });
    setPinnedClosed((current) => {
      const next = new Set(current);
      if (open) next.add(turn.id);
      else next.delete(turn.id);
      return next;
    });
  };
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const anchor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (anchor.current !== null) { node.scrollTop += node.scrollHeight - anchor.current; anchor.current = null; return; }
    if (follow.current) node.scrollTop = node.scrollHeight;
  }, [blocks]);
  const older = () => {
    if (loadingOlder) return;
    anchor.current = scrollRef.current?.scrollHeight ?? null;
    setLoadingOlder(true);
    void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false));
  };
  const empty = loaded && blocks.length === 0;
  return (
    <div ref={scrollRef} className="objectives-commodore-log" onScroll={(event) => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_SLACK_PX; }}>
      {empty ? <p className="objectives-commodore-empty">{t("objectives.commodore.log.empty")}</p> : null}
      {hasMore ? (
        <button type="button" className="objectives-commodore-text-button objectives-commodore-older" disabled={loadingOlder} onClick={older}>
          {t("objectives.commodore.log.older")}
        </button>
      ) : null}
      {Transcript ? blocks.map((block) => {
        if (block.kind === "note") {
          const note = { kind: "note" as const, text: block.text, ...(block.at !== undefined ? { at: block.at } : {}), ...(block.tone ? { tone: block.tone } : {}) };
          return <Transcript key={`note-${block.at ?? block.text}`} entries={[{ event: note, ...(block.at !== undefined ? { at: block.at } : {}) }]} language={language} />;
        }
        const turn = block.turn;
        const open = openTurn(turn);
        const line = turn.working ? null : (
          <CommodoreTurnLine t={t} turn={turn} open={open} onToggle={() => toggleTurn(turn)} />
        );
        if (!open) return <div key={turn.id}>{line}</div>;
        const shown = turn.message || turn.working ? turn.entries : turn.entries.filter((entry) => entry.event.kind !== "dispatch");
        return (
          <div key={turn.id} className="objectives-commodore-turn-open" data-commodore-turn={turn.id}>
            {line}
            <Transcript entries={shown} language={language} reveal={reveal && revealedId === turn.id ? reveal : null} />
          </div>
        );
      }) : null}
    </div>
  );
}

/** 접힌 턴 한 줄. 채팅 작업 접힘과 같이 줄 끝의 ⌄가 열림을 말하고, 줄 자체가 버튼이다. */
function CommodoreTurnLine({ t, turn, open, onToggle }: { readonly t: T; readonly turn: CommodoreLogTurn; readonly open: boolean; readonly onToggle: () => void }) {
  const duration = turnDuration(t, turn.durationMs);
  const meta = [duration, clockTime(turn.at)].filter(Boolean).join(" · ");
  const tone = turn.failed ? " is-error" : turn.stopped ? " is-stopped" : turn.message ? " is-message" : "";
  return (
    <button
      type="button"
      className={`objectives-commodore-turn${tone}${open ? " is-open" : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="objectives-commodore-turn-dot" aria-hidden="true" />
      <span className="objectives-commodore-turn-label">{turn.label}</span>
      <span className="objectives-commodore-turn-summary">{turn.summary}</span>
      <span className="objectives-commodore-turn-meta">{meta}</span>
      <span className="objectives-commodore-turn-chev" aria-hidden="true">⌄</span>
    </button>
  );
}

function turnDuration(t: T, durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return t("objectives.commodore.log.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? t("objectives.commodore.log.minutes", { n: minutes })
    : t("objectives.commodore.log.minutesSeconds", { m: minutes, s: rest });
}


/** 시트를 닫아도 남기는 입력. Theater마다 하나고, 전송·저장으로 비운 값은 지운다. */
interface SheetDraft {
  readonly composer: string;
  readonly directive: string | null;
  readonly intel: string;
}
const sheetDrafts = new Map<string, SheetDraft>();
function sheetDraft(theaterId: string): SheetDraft {
  return sheetDrafts.get(theaterId) ?? { composer: "", directive: null, intel: "" };
}
function rememberSheetDraft(theaterId: string, patch: Partial<SheetDraft>): void {
  sheetDrafts.set(theaterId, { ...sheetDraft(theaterId), ...patch });
}


/** 전송 왼쪽의 문맥 원호. 채팅과 같은 16px 글리프이고, 내역은 총량과 교대 기준선만 말한다. */
function CommodoreContextMeter({ t, context }: { readonly t: T; readonly context: NonNullable<CommodoreRunStatus["context"]> }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);
  const occupied = context.inputTokens;
  const limit = CONTEXT_ROTATE_RATIO;
  const ratio = context.window > 0 ? occupied / context.window : 0;
  const tone = ratio >= limit * 0.97 ? " is-critical" : ratio >= limit * 0.75 ? " is-warn" : "";
  const percent = Math.round(ratio * 100);
  const summary = `${formatContextTokens(occupied)} / ${formatContextTokens(context.window)}`;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, ratio)) * circumference;
  const untilRotate = Math.max(0, context.window * limit - occupied);
  const free = Math.max(0, context.window - occupied);
  return (
    <span className={`objectives-commodore-ctx${tone}`} ref={wrapRef}>
      <button
        type="button"
        className="objectives-commodore-ctx-chip"
        aria-expanded={open}
        aria-label={t("objectives.commodore.context.aria", { percent, summary })}
        title={t("objectives.commodore.context.title", { summary })}
        onClick={() => setOpen((was) => !was)}
      >
        <svg className="objectives-commodore-ctx-arc" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="objectives-commodore-ctx-track" cx="8" cy="8" r={radius} />
          <circle className="objectives-commodore-ctx-fill" cx="8" cy="8" r={radius} strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`} />
        </svg>
      </button>
      {open ? (
        <div className="objectives-commodore-ctx-pop" role="dialog" aria-label={t("objectives.commodore.context.label")}>
          <div className="objectives-commodore-ctx-head">
            <span>{t("objectives.commodore.context.label")}</span>
            <span>{summary} · {percent}%</span>
          </div>
          <div className="objectives-commodore-ctx-bar">
            <i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
            <span className="objectives-commodore-ctx-line" style={{ left: `${limit * 100}%` }} />
          </div>
          <ul className="objectives-commodore-ctx-rows">
            <li><span className="objectives-commodore-ctx-swatch" /><span>{t("objectives.commodore.context.used")}</span><span>{formatContextTokens(occupied)}</span><span>{(ratio * 100).toFixed(1)}%</span></li>
            <li><span className="objectives-commodore-ctx-swatch is-line" /><span>{t("objectives.commodore.context.untilRotate")}</span><span>{formatContextTokens(untilRotate)}</span><span>{Math.round(limit * 100)}%</span></li>
            <li><span className="objectives-commodore-ctx-swatch is-free" /><span>{t("objectives.commodore.context.free")}</span><span>{formatContextTokens(free)}</span><span>{((free / context.window) * 100).toFixed(1)}%</span></li>
          </ul>
          <p className="objectives-commodore-ctx-foot">{t("objectives.commodore.context.foot")}</p>
        </div>
      ) : null}
    </span>
  );
}

function formatContextTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const text = millions < 10 ? millions.toFixed(1) : String(Math.round(millions));
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}M`;
  }
  const thousands = tokens / 1_000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * 사령관에게 말하기 — 채팅 화면의 입력과 같은 문법: 한 상자 안에 자라는 입력과 원형 전송, 초점이면 상자가 brass 로 선다.
 * 자율 운영이 꺼져 있으면 닿지 않을 메시지이므로 입력을 잠그고 사유를 말한다. 쓰던 초안은 그대로 두어 다시 켜면 보낼 수 있다.
 * 다른 창에서 막 끈 경합은 서버가 거절하고(`commodore_inactive`) 초안은 지우지 않는다.
 */
function CommodoreComposer({ t, theaterId, active, context, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly active: boolean; readonly context?: CommodoreRunStatus["context"]; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const [text, setText] = useState(() => sheetDraft(theaterId).composer);
  useEffect(() => { rememberSheetDraft(theaterId, { composer: text }); }, [theaterId, text]);
  const [sending, setSending] = useState(false);
  const composing = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const armed = active && !!text.trim() && !sending;
  const send = () => {
    const value = text.trim();
    if (!active || !value || sending) return;
    onClear();
    setSending(true);
    void messageCommodore(theaterId, value).then(() => setText("")).catch(onFail).finally(() => { setSending(false); inputRef.current?.focus({ preventScroll: true }); });
  };
  return (
    <>
    <div className={`objectives-commodore-composer${active ? "" : " is-disabled"}`} onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}>
      <ComposerInput
        ref={inputRef}
        className="objectives-commodore-composer-input"
        value={text}
        disabled={!active}
        aria-describedby={active ? undefined : `objectives-commodore-composer-idle-${theaterId}`}
        rows={1}
        placeholder={t("objectives.commodore.composer.placeholder")}
        aria-label={t("objectives.commodore.composer.aria")}
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
      />
      {context ? <CommodoreContextMeter t={t} context={context} /> : null}
      <ComposerSubmitButton
        className={`objectives-commodore-composer-send${armed ? " is-armed" : ""}`}
        aria-label={t("objectives.commodore.composer.send")}
        title={t("objectives.commodore.composer.send")}
        disabled={!armed}
        onClick={send}
      />
    </div>
    {active ? null : <p id={`objectives-commodore-composer-idle-${theaterId}`} className="objectives-commodore-hint objectives-commodore-composer-idle">{t("objectives.commodore.composer.idle")}</p>}
    </>
  );
}

/* ── 지시 ─────────────────────────────────────────────────────────────── */

function CommodoreDirective({ t, theaterId, directive, active, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly directive: { readonly text: string; readonly rev: number; readonly updatedAt: number }; readonly active: boolean; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const [draft, setDraft] = useState(() => sheetDraft(theaterId).directive ?? directive.text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 다른 곳(다른 창)에서 고친 지시는 입력이 깨끗할 때만 따라간다 — 쓰던 글을 덮지 않는다. 시트를 닫아도 더러운 초안은 남는다.
  const base = useRef(directive.text);
  useEffect(() => {
    if (draft === base.current) setDraft(directive.text);
    base.current = directive.text;
  }, [directive.text]); // eslint-disable-line react-hooks/exhaustive-deps -- 서버 값이 바뀔 때만.
  useEffect(() => { rememberSheetDraft(theaterId, { directive: draft === directive.text ? null : draft }); }, [theaterId, draft, directive.text]);
  const dirty = draft !== directive.text;
  const save = () => {
    if (saving || !dirty) return;
    onClear();
    setSaving(true);
    setSaved(false);
    void saveCommodoreDirective(theaterId, draft).then(() => setSaved(true)).catch(onFail).finally(() => setSaving(false));
  };
  return (
    <div className="objectives-commodore-section">
      <label className="objectives-commodore-section-title" htmlFor="objectives-commodore-directive">{t("objectives.commodore.directive.label")}</label>
      <textarea
        id="objectives-commodore-directive"
        className="objectives-commodore-input is-tall"
        value={draft}
        maxLength={8_000}
        placeholder={t("objectives.commodore.directive.placeholder")}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
      />
      <p className="objectives-commodore-hint">{t("objectives.commodore.directive.hint")}</p>
      <div className="objectives-commodore-section-foot">
        {directive.rev > 0 ? <span className="objectives-commodore-hint">{t("objectives.commodore.directive.rev", { rev: directive.rev, time: clockTime(directive.updatedAt) })}</span> : <span />}
        <button type="button" className="objectives-btn" disabled={saving || !dirty} onClick={save}>{t("objectives.commodore.directive.save")}</button>
      </div>
      {saved && !dirty ? <p className="objectives-commodore-hint is-done" role="status">{t(active ? "objectives.commodore.directive.saved" : "objectives.commodore.directive.savedIdle")}</p> : null}
    </div>
  );
}

/* ── 정보 ─────────────────────────────────────────────────────────────── */

function CommodoreIntel({ t, theaterId, intel, sources, onFail, onClear }: {
  readonly t: T;
  readonly theaterId: string;
  readonly intel: readonly { readonly id: string; readonly at: number; readonly source: string; readonly text: string }[];
  readonly sources: readonly { readonly id: string; readonly kind: string; readonly label: string; readonly locator: string }[];
  readonly onFail: (error: unknown) => void;
  readonly onClear: () => void;
}) {
  const [draft, setDraft] = useState(() => sheetDraft(theaterId).intel);
  useEffect(() => { rememberSheetDraft(theaterId, { intel: draft }); }, [theaterId, draft]);
  const [adding, setAdding] = useState(false);
  const sourceLabel = (source: string) => source === "person" ? t("objectives.commodore.intel.fromYou") : sources.find((candidate) => candidate.id === source)?.label ?? source;
  const add = () => {
    const value = draft.trim();
    if (!value || adding) return;
    onClear();
    setAdding(true);
    void addCommodoreIntel(theaterId, value).then(() => setDraft("")).catch(onFail).finally(() => setAdding(false));
  };
  const day = (at: number) => { const date = new Date(at); return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  return (
    <>
      <div className="objectives-commodore-section">
        <label className="objectives-commodore-section-title" htmlFor="objectives-commodore-intel">{t("objectives.commodore.intel.label")}</label>
        <textarea
          id="objectives-commodore-intel"
          className="objectives-commodore-input is-medium"
          value={draft}
          maxLength={4_000}
          placeholder={t("objectives.commodore.intel.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="objectives-commodore-section-foot">
          <span />
          <button type="button" className="objectives-btn" disabled={adding || !draft.trim()} onClick={add}>{t("objectives.commodore.intel.add")}</button>
        </div>
        {intel.length === 0 ? <p className="objectives-commodore-hint">{t("objectives.commodore.intel.empty")}</p> : (
          <ul className="objectives-commodore-intel-list">
            {intel.map((item) => (
              <li key={item.id}>
                <span className="objectives-commodore-intel-when">{day(item.at)}</span>
                <span className="objectives-commodore-intel-text">{item.text}<span className="objectives-commodore-intel-source">{sourceLabel(item.source)}</span></span>
                <button type="button" className="objectives-commodore-text-button" aria-label={t("objectives.commodore.intel.removeAria")} onClick={() => { onClear(); void removeCommodoreIntel(theaterId, item.id).catch(onFail); }}>{t("objectives.commodore.intel.remove")}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="objectives-commodore-section">
        <p className="objectives-commodore-section-title">{t("objectives.commodore.intel.sources")} <span className="objectives-commodore-later">· {t("objectives.commodore.intel.sourcesLater")}</span></p>
        {sources.length === 0 ? <p className="objectives-commodore-hint">{t("objectives.commodore.intel.sourcesEmpty")}</p> : (
          <ul className="objectives-commodore-sources">
            {sources.map((source) => <li key={source.id}><span>{source.label}</span><span className="objectives-commodore-source-locator">{source.locator}</span></li>)}
          </ul>
        )}
        <p className="objectives-commodore-hint">{t("objectives.commodore.intel.sourcesHint")}</p>
      </div>
    </>
  );
}
