import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { renderMarkdown } from "@fleet-console/markdown/core";
import "@fleet-console/markdown/styles.css";

import { ComposerInput, ComposerSubmitButton } from "@fleet-console/sdk/composer";
import type { Translate } from "@fleet-console/sdk/i18n";
import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { SettingsRow, SettingsToggle } from "@fleet-console/sdk/settings/browser";

import type { CommodorePatrolMinutes, CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { clockTime } from "./commodore-row.js";
import {
  addCommodoreIntel,
  closeCommodoreDrawer,
  commodoreMapInsets,
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
  subscribeCommodoreMapInsets,
  useCommodore,
  useCommodoreDrawer,
  useCommodoreEnabled,
  type CommodoreTab,
} from "./commodore-state.js";
import { getT, objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";
import { DEFAULT_LAUNCH, LaunchControl } from "./launch-control.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 시트 기하 — 바깥 틀은 Fleet 브라우저 시트와 같다(지도 안쪽 좌우 24px, 위·아래 사이드바 카드 선). 그 틀보다 크게 펴지지 않고,
 * 내용에 맞는 크기(최대 폭·높이)로 틀 가운데에 선다 — 넓은 화면에서 글이 한쪽에 몰린 빈 면이 되지 않게.
 */
const SHEET_INSET = 24;
const SHEET_MARGIN = 12;
/** 지도가 이보다 좁으면 사이드바·레일을 무시하고 창 전체를 쓴다 — 「열림」인데 안 보이는 상태는 두지 않는다. */
const SHEET_MIN_WIDTH = 560;
/** 맞춤 크기 — 구역 목록(220) + 읽는 폭(880) 언저리, 높이는 설정 줄과 기록 몇 묶음이 한눈에 드는 만큼. */
const SHEET_MAX_WIDTH = 1080;
const SHEET_MAX_HEIGHT = 780;
/** 시트가 이보다 좁으면 구역 목록을 글리프만 남긴다. */
const SHEET_COMPACT_WIDTH = 720;
/** 보드 읽기는 행위가 아니다 — 기록의 행위 칩에는 보드를 바꾼 호출만 선다. */
const READ_ACTIONS = new Set(["view", "read", "list", "get", "inbox", "fleet", "history", "evidence", "transcript"]);
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

interface SheetGeometry {
  readonly sheet: CSSProperties;
  /** 뒤의 투명한 닫기 영역 — 지도만 덮는다. 사이드바·레일·도구모음은 그대로 조작된다. */
  readonly scrim: CSSProperties;
  /** 좁은 시트 — 구역 목록이 글리프만 남는다. */
  readonly compact: boolean;
}

/**
 * 시트 자리 — 좌우는 지도 안쪽 24px, 위·아래는 사령관 줄이 선 사이드바 카드의 선. 사이드바가 접혀 줄이 없으면 마지막 선을 쓰고,
 * 처음부터 없으면 창 가장자리에서 카드 여백만큼. 사이드바·레일이 넓어지면 따라 줄어든다.
 */
function useSheetGeometry(theaterId: string): SheetGeometry {
  const lastCard = useRef<DOMRect | null>(null);
  const [geometry, setGeometry] = useState<SheetGeometry>({ sheet: { left: 300, top: 60, right: 24, bottom: 12 }, scrim: { left: 0, top: 0, right: 0, bottom: 0 }, compact: false });
  useLayoutEffect(() => {
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const card = rowElement(theaterId)?.closest("aside")?.getBoundingClientRect() ?? null;
      if (card && card.width > 4) lastCard.current = card;
      const known = lastCard.current;
      const insets = commodoreMapInsets();
      const mapLeft = known ? known.right : insets.left;
      const mapRight = insets.right;
      let left = Math.round(mapLeft + SHEET_INSET);
      let right = Math.round(mapRight > 0 ? mapRight + SHEET_INSET - SHEET_MARGIN : SHEET_INSET);
      if (vw - left - right < SHEET_MIN_WIDTH) { left = SHEET_MARGIN; right = SHEET_MARGIN; }
      const frameTop = Math.round(known ? known.top : 48 + SHEET_MARGIN);
      const frameBottom = Math.round(known ? Math.max(SHEET_MARGIN, vh - known.bottom) : SHEET_MARGIN);
      const top = frameTop;
      const bottom = frameBottom;
      // 틀 안에서 맞춤 크기로 줄이고 남는 만큼을 양쪽에 나눠 가운데에 둔다.
      const spareX = Math.max(0, vw - left - right - SHEET_MAX_WIDTH);
      const spareY = Math.max(0, vh - frameTop - frameBottom - SHEET_MAX_HEIGHT);
      setGeometry({
        sheet: { left: left + Math.floor(spareX / 2), right: right + Math.ceil(spareX / 2), top: frameTop + Math.floor(spareY / 2), bottom: frameBottom + Math.ceil(spareY / 2) },
        scrim: { left: Math.round(mapLeft), right: Math.round(mapRight), top, bottom },
        compact: Math.min(vw - left - right, SHEET_MAX_WIDTH) < SHEET_COMPACT_WIDTH,
      });
    };
    place();
    window.addEventListener("resize", place);
    const offMap = subscribeCommodoreMapInsets(place);
    // 사이드바 카드는 창 크기 사건 뒤에 제 높이를 다시 잡는다 — 카드 자체의 크기 변화도 따라간다.
    const card = rowElement(theaterId)?.closest("aside");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    if (card) observer?.observe(card);
    return () => { window.removeEventListener("resize", place); offMap(); observer?.disconnect(); };
  }, [theaterId]);
  return geometry;
}

const NAV_GLYPHS: Record<CommodoreTab, ReactNode> = {
  log: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 4.5h11M3.5 9h11M3.5 13.5h7" /></svg>,
  directive: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 15.5V2.75M4.5 3.25h8.25l-1.75 3 1.75 3H4.5" /></svg>,
  intel: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="1.6" /><path d="M5.6 12.4a4.8 4.8 0 0 1 0-6.8M12.4 5.6a4.8 4.8 0 0 1 0 6.8M3.4 14.6a8 8 0 0 1 0-11.2M14.6 3.4a8 8 0 0 1 0 11.2" /></svg>,
  settings: <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7" /><circle cx="11.5" cy="5" r="1.6" /><circle cx="6.5" cy="13" r="1.6" /></svg>,
};

/**
 * 「사령관 기록」 시트 — Fleet 브라우저처럼 지도 위 가운데 뜨는 면. 왼쪽은 구역 목록(기록·지시·정보·설정)과 사령관의 지금,
 * 오른쪽은 고른 구역. 설정은 Console 설정과 같은 줄 문법(제목·설명·오른쪽 컨트롤)이다. 뒤의 투명한 영역을 누르거나 Esc 로 닫힌다.
 */
function CommodoreSheet({ theaterId, tab, openedAt, language }: { readonly theaterId: string; readonly tab: CommodoreTab; readonly openedAt: number; readonly language: "en" | "ko" }) {
  const t = getT(language);
  noteCommodoreLanguage(language);
  const { view, entries, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const geometry = useSheetGeometry(theaterId);
  const dialogRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Record<CommodoreTab, HTMLButtonElement | null>>({ log: null, directive: null, intel: null, settings: null });
  const [failure, setFailure] = useState<string | null>(null);
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
    <>
      <div className="objectives-commodore-scrim" aria-hidden="true" style={geometry.scrim} onClick={close} />
      <section
        ref={dialogRef}
        className={`objectives-commodore-sheet${geometry.compact ? " is-compact" : ""}`}
        role="dialog"
        aria-label={t("objectives.commodore.drawer.aria", { theater: label })}
        style={geometry.sheet}
        onKeyDown={onKeyDown}
      >
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
          <div className={`objectives-commodore-body is-${tab}`} role="tabpanel" id={`objectives-commodore-panel-${tab}`} aria-labelledby={`objectives-commodore-tab-${tab}`}>
            {tab === "log" ? <CommodoreLog t={t} theaterId={theaterId} entries={entries} hasMore={hasMore} loaded={transcriptLoaded} /> : null}
            {tab === "directive" && view ? <CommodoreDirective t={t} theaterId={theaterId} directive={view.state.directive} active={view.active} onFail={fail} onClear={() => setFailure(null)} /> : null}
            {tab === "intel" && view ? <CommodoreIntel t={t} theaterId={theaterId} intel={view.state.intel} sources={view.state.sources} onFail={fail} onClear={() => setFailure(null)} /> : null}
            {tab === "settings" && view ? <CommodoreSettings t={t} theaterId={theaterId} view={view} onFail={(error) => { fail(error); }} onClear={() => setFailure(null)} /> : null}
          </div>
          {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
          {tab === "log" ? <footer className="objectives-commodore-foot"><CommodoreComposer t={t} theaterId={theaterId} active={view ? view.active : true} onFail={fail} onClear={() => setFailure(null)} /></footer> : null}
        </div>
      </section>
    </>,
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
 * 설정 — Console 설정과 같은 줄(제목·설명·오른쪽 컨트롤). 모델·강도는 Objectives 의 지휘관 메뉴(LaunchControl)를 그대로 쓰고,
 * 오른쪽 칸에서는 선택 상자 모양으로 선다.
 */
function CommodoreSettings({ t, theaterId, view, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly view: CommodoreView; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const { state, defaults, run } = view;
  const on = state.autonomy === true;
  const model = state.model ?? defaults.model;
  const effort = state.effort ?? defaults.effort;
  const modelOverridden = state.model !== undefined;
  const patrol = state.patrolMinutes ?? DEFAULT_PATROL;
  const commanderModel = state.commanderModel ?? DEFAULT_LAUNCH.model;
  const commanderEffort = state.commanderModel ? state.commanderEffort : DEFAULT_LAUNCH.effort;
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
        <span className="objectives-commodore-select">
          <LaunchControl
            t={t}
            model={model}
            effort={effort}
            locked={false}
            commitOnClose
            startAtList
            triggerLabel={t("objectives.commodore.drawer.modelAria")}
            onChange={(next) => {
              const nextModel = next.model ?? model;
              // 트랙의 「자동」은 사령관에게 실험 기능 행의 강도다 — 좌표는 모델과 강도를 함께 저장한다.
              const nextEffort = next.effort ?? defaults.effort;
              act(() => setCommodoreCoordinates(theaterId, { model: nextModel, effort: nextEffort }));
            }}
          />
        </span>
      </SettingsRow>
      <SettingsRow
        label={t("objectives.commodore.settings.patrol")}
        hint={<>{t("objectives.commodore.settings.patrolHint")}{state.patrolMinutes !== undefined ? <UseDefault t={t} onClick={() => act(() => setCommodorePatrol(theaterId, null))} /> : null}</>}
      >
        <span className="objectives-commodore-select">
          <PatrolControl
            t={t}
            minutes={patrol}
            nextPatrolAt={on && run.phase === "idle" ? run.nextWakeAt : undefined}
            onPick={(minutes) => act(() => setCommodorePatrol(theaterId, minutes === DEFAULT_PATROL ? null : minutes))}
          />
        </span>
      </SettingsRow>
      <div className="objectives-commodore-settings-divider" role="separator" />
      <SettingsRow
        label={t("objectives.commodore.settings.commander")}
        hint={<>{t("objectives.commodore.settings.commanderHint")}{commanderOverridden ? <UseDefault t={t} onClick={() => act(() => setCommodoreCommander(theaterId, null))} /> : null}</>}
      >
        <span className="objectives-commodore-select">
          <LaunchControl
            t={t}
            model={commanderModel}
            effort={commanderEffort}
            locked={false}
            commitOnClose
            startAtList
            triggerLabel={t("objectives.commodore.settings.commanderAria")}
            onChange={(next) => act(() => setCommodoreCommander(theaterId, { model: next.model ?? commanderModel, ...(next.effort ? { effort: next.effort } : {}) }))}
          />
        </span>
      </SettingsRow>
    </div>
  );
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
        className="objectives-launch objectives-commodore-patrol"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("objectives.commodore.patrol.aria")} · ${word}`}
        title={title}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusOnOpen.current = true; setOpen(true); } }}
        onClick={(event) => { focusOnOpen.current = event.detail === 0; setOpen((value) => !value); }}
      >
        <span className="objectives-commodore-patrol-glyph"><PatrolGlyph /></span>
        <span className="objectives-launch-model">{word}</span>
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

export function errorWord(t: T, code: string): string {
  const key = `objectives.commodore.errorCode.${code}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : code;
}

/** 깨움 이유 — `code` 또는 `code:N` 토큰. 모르는 토큰(문장)은 그대로 보인다. */
export function reasonWord(t: T, reason: string): string {
  const match = /^([a-z][a-z-]*)(?::(\d+))?$/.exec(reason);
  if (!match) return reason;
  const key = `objectives.commodore.reason.${match[1]}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey, { n: match[2] ?? "" }).trim() : reason;
}

export function actionWord(t: T, action: string): string {
  const key = `objectives.commodore.action.${action}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : action;
}

/* ── 기록 ─────────────────────────────────────────────────────────────── */

export type ToolEntry = Extract<CommodoreTranscriptEntry, { kind: "tool" }>;

interface WakeGroup {
  readonly kind: "wake";
  readonly key: string;
  readonly at: number;
  reasons: readonly string[];
  readonly texts: string[];
  readonly actions: { readonly key: string; readonly action: string; readonly title: string }[];
  readonly tools: ToolEntry[];
  readonly notes: { readonly key: string; readonly text: string; readonly tone: "warn" | "dim" }[];
}

type LogItem =
  | WakeGroup
  | { readonly kind: "marker"; readonly key: string; readonly at: number; readonly text: string }
  | { readonly kind: "message"; readonly key: string; readonly at: number; readonly text: string; readonly undelivered: boolean };

/** 서버는 사건마다 한 줄을 쌓는다 — 깨움에서 결과까지를 한 묶음으로 모으고, 세션 구분선과 사람의 말은 따로 선다. */
export function groupTranscript(t: T, entries: readonly CommodoreTranscriptEntry[]): LogItem[] {
  const items: LogItem[] = [];
  let open: WakeGroup | null = null;
  // 끌 때 싣지 못한 메시지 — 뒤에 오는 줄이 앞의 메시지를 가리킨다. 따로 서지 않고 그 메시지에 표시가 붙는다.
  const undelivered = new Set(entries.flatMap((entry) => entry.kind === "undelivered" ? entry.seqs : []));
  const start = (entry: CommodoreTranscriptEntry, reasons: readonly string[]): WakeGroup => {
    const group: WakeGroup = { kind: "wake", key: `w${entry.seq}`, at: entry.at, reasons, texts: [], actions: [], tools: [], notes: [] };
    items.push(group);
    return group;
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case "wake":
        open = start(entry, entry.reasons);
        break;
      case "session":
        open = null;
        items.push({ kind: "marker", key: `s${entry.seq}`, at: entry.at, text: t(`objectives.commodore.log.session.${entry.event}`) });
        break;
      case "message":
        items.push({ kind: "message", key: `m${entry.seq}`, at: entry.at, text: entry.text, undelivered: undelivered.has(entry.seq) });
        break;
      case "undelivered":
        break;
      case "text": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        if (entry.text.trim()) group.texts.push(entry.text);
        break;
      }
      case "thinking":
        break;
      case "tool": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        const tool: ToolEntry = entry;
        group.tools.push(tool);
        if (tool.name === "console_objectives" && tool.action && !READ_ACTIONS.has(tool.action)) {
          group.actions.push({ key: `a${entry.seq}`, action: tool.action, title: tool.title ?? "" });
        }
        break;
      }
      case "result": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        if (entry.outcome === "cancelled") group.notes.push({ key: `r${entry.seq}`, text: t("objectives.commodore.log.cancelled"), tone: "dim" });
        if (entry.outcome === "error" && !group.notes.some((note) => note.tone === "warn")) group.notes.push({ key: `r${entry.seq}`, text: t("objectives.commodore.log.turnError", { reason: entry.error ? errorWord(t, entry.error) : t("objectives.commodore.meta.error") }), tone: "warn" });
        open = null;
        break;
      }
      case "error": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        const code = errorWord(t, entry.code);
        group.notes.push({ key: `e${entry.seq}`, text: entry.retryAt ? t("objectives.commodore.log.errorRetry", { code, time: clockTime(entry.retryAt) }) : t("objectives.commodore.log.error", { code }), tone: "warn" });
        break;
      }
    }
  }
  return items;
}

/**
 * 사령관이 쓴 글 — Markdown 이다. Console 이 에이전트 글에 쓰는 같은 렌더러(정제된 HTML, 원시 HTML 없음)로 그리고,
 * 코드 블록의 복사 단추는 결과물 보기와 같은 위임으로 받는다.
 */
export function CommodoreMarkdown({ t, text }: { readonly t: T; readonly text: string }) {
  const html = useMemo(() => renderMarkdown(text, { copyLabel: t("objectives.results.copy"), copyAriaLabel: (language) => t("objectives.results.copyCode", { language }) }).html, [t, text]);
  const onCopy = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    const code = button?.closest("pre")?.getAttribute("data-code");
    if (!button || !code) return;
    void navigator.clipboard?.writeText(code).then(() => {
      const original = button.textContent;
      button.textContent = t("objectives.results.copied");
      window.setTimeout(() => { button.textContent = original; }, 1200);
    }, () => undefined);
  }, [t]);
  return <div className="markdown-body objectives-commodore-wake-text" onClick={onCopy} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function toolSummary(tools: readonly ToolEntry[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} × ${count}`).join(" · ");
}

function CommodoreLog({ t, theaterId, entries, hasMore, loaded }: { readonly t: T; readonly theaterId: string; readonly entries: readonly CommodoreTranscriptEntry[]; readonly hasMore: boolean; readonly loaded: boolean }) {
  // 새 묶음이 위에 선다 — 서랍을 열면 방금 일어난 일이 먼저 보인다.
  const items = useMemo(() => groupTranscript(t, entries).reverse(), [t, entries]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  if (loaded && items.length === 0) return <p className="objectives-commodore-empty">{t("objectives.commodore.log.empty")}</p>;
  return (
    <div className="objectives-commodore-log">
      {items.map((item) => {
        if (item.kind === "marker") {
          return <p key={item.key} className="objectives-commodore-marker"><span>{clockTime(item.at)}</span><span>{item.text}</span></p>;
        }
        if (item.kind === "message") {
          return (
            <div key={item.key} className="objectives-commodore-wake is-message">
              <p className="objectives-commodore-wake-head">
                <span>{clockTime(item.at)}</span><b>{t("objectives.commodore.log.you")}</b>
                {item.undelivered ? <span className="objectives-commodore-undelivered" title={t("objectives.commodore.log.undeliveredHint")}>{t("objectives.commodore.log.undelivered")}</span> : null}
              </p>
              <p className="objectives-commodore-wake-text">{item.text}</p>
            </div>
          );
        }
        return (
          <div key={item.key} className="objectives-commodore-wake">
            <p className="objectives-commodore-wake-head"><span>{clockTime(item.at)}</span><b>{item.reasons.length > 0 ? item.reasons.map((reason) => reasonWord(t, reason)).join(" · ") : t("objectives.commodore.log.woke")}</b></p>
            {item.texts.map((text, index) => <CommodoreMarkdown key={index} t={t} text={text} />)}
            {item.actions.length > 0 ? (
              <div className="objectives-commodore-acts">
                {item.actions.map((act) => <span key={act.key} className="objectives-commodore-act"><b>{actionWord(t, act.action)}</b>{act.title ? <span>{act.title}</span> : null}</span>)}
              </div>
            ) : null}
            {item.notes.map((note) => <p key={note.key} className={`objectives-commodore-note is-${note.tone}`}>{note.text}</p>)}
            {item.tools.length > 0 ? (
              <details className="objectives-commodore-tools">
                <summary>{t("objectives.commodore.log.tools", { summary: toolSummary(item.tools) })}</summary>
                <ul>
                  {item.tools.map((tool) => (
                    <li key={tool.seq} className={tool.ok === false ? "is-failed" : undefined}>
                      <span className="objectives-commodore-tool-name">{tool.action ? `${tool.name} ${tool.action}` : tool.name}</span>
                      {tool.summary ? <span>{tool.summary}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
      {hasMore ? (
        <button type="button" className="objectives-commodore-text-button objectives-commodore-older" disabled={loadingOlder} onClick={() => { setLoadingOlder(true); void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false)); }}>
          {t("objectives.commodore.log.older")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 사령관에게 말하기 — 채팅 화면의 입력과 같은 문법: 한 상자 안에 자라는 입력과 원형 전송, 초점이면 상자가 brass 로 선다.
 * 자율 운영이 꺼져 있으면 닿지 않을 메시지이므로 입력을 잠그고 사유를 말한다. 쓰던 초안은 그대로 두어 다시 켜면 보낼 수 있다.
 * 다른 창에서 막 끈 경합은 서버가 거절하고(`commodore_inactive`) 초안은 지우지 않는다.
 */
function CommodoreComposer({ t, theaterId, active, onFail, onClear }: { readonly t: T; readonly theaterId: string; readonly active: boolean; readonly onFail: (error: unknown) => void; readonly onClear: () => void }) {
  const [text, setText] = useState("");
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
  const [draft, setDraft] = useState(directive.text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 다른 곳(다른 창)에서 고친 지시는 입력이 깨끗할 때만 따라간다 — 쓰던 글을 덮지 않는다.
  const base = useRef(directive.text);
  useEffect(() => {
    if (draft === base.current) setDraft(directive.text);
    base.current = directive.text;
  }, [directive.text]); // eslint-disable-line react-hooks/exhaustive-deps -- 서버 값이 바뀔 때만.
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
  const [draft, setDraft] = useState("");
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
