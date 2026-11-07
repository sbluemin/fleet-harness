import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ConsoleLocale } from "@fleet-console/i18n";
import { usePointerDrag } from "@fleet-console/ui/react";
import { focusFloatingWindow, useFloatingWindowZ } from "@fleet-console/ui/store";
import { getT } from "./i18n/index.js";
import { CommanderRowPanel, DETAIL_TABS, type DetailTab } from "./objectives-panel.js";
import { findAnyObjective, subscribeObjectiveOrFinished } from "./objectives-state.js";
import "./result-window.css";

/**
 * 지휘관·구성원 채팅의 목표 창 — 목표·구성원·라이브러리를 결과물 창과 같은 떠 있는 창 하나에 보인다. 배경을 덮지 않고, 머리를 끌어 옮기고
 * 가장자리로 크기를 바꾸며, 위치·크기를 기억한다. 창은 하나다 — 채팅 머리의 글리프가 이 창의 항목을 바꾸고, 보이는 항목의 글리프를 다시
 * 누르면 닫힌다. 레일·탭의 수명 밖에 두어 가운데 대화가 바뀌어도 창은 남는다(대화가 다른 목표로 옮기면 그 목표로 바뀐다).
 */
export interface ObjectiveWindowState {
  readonly objectiveId: string;
  readonly commodoreId: string;
  readonly tab: DetailTab;
}

let opened: ObjectiveWindowState | null = null;
let opener: HTMLElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => opened;
const OBJECTIVE_WINDOW_ID = "objectives-objective";
const RECT_KEY = "fleet.objectives.objective-window.rect";

function update(next: ObjectiveWindowState | null): void {
  opened = next;
  if (next !== null) focusFloatingWindow(OBJECTIVE_WINDOW_ID);
  for (const listener of listeners) listener();
}

/** 목표 창을 그 항목으로 연다 — 이미 열려 있으면 항목·목표만 바꾼다. */
export function openObjectiveWindow(target: ObjectiveWindowState, from: HTMLElement | null = null): void {
  if (from !== null) opener = from;
  update(target);
}

/** 채팅 머리 글리프 — 같은 목표의 같은 항목이 보이는 중이면 닫고, 아니면 그 항목으로 연다. */
export function toggleObjectiveWindow(target: ObjectiveWindowState, from: HTMLElement | null = null): void {
  if (opened !== null && opened.objectiveId === target.objectiveId && opened.tab === target.tab) { closeObjectiveWindow(); return; }
  openObjectiveWindow(target, from);
}

/** 열린 창의 목표만 바꾼다 — 닫힌 창은 열지 않는다. 가운데 대화가 다른 목표로 옮길 때 쓴다. */
export function retargetObjectiveWindow(objectiveId: string, commodoreId: string): void {
  if (opened === null || (opened.objectiveId === objectiveId && opened.commodoreId === commodoreId)) return;
  opened = { ...opened, objectiveId, commodoreId };
  for (const listener of listeners) listener();
}

export function closeObjectiveWindow(): void {
  const back = opener;
  opener = null;
  update(null);
  if (back?.isConnected && back.getClientRects().length && !back.closest("[hidden], [inert]")) back.focus({ preventScroll: true });
}

export function useObjectiveWindow(): ObjectiveWindowState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
type Direction = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const DIRECTIONS: readonly Direction[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const GAP = 12, MIN_W = 360, MIN_H = 260;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
function fit(rect: Rect): Rect {
  const maxW = Math.max(1, window.innerWidth - GAP * 2), maxH = Math.max(1, window.innerHeight - GAP * 2);
  const w = clamp(rect.w, Math.min(MIN_W, maxW), maxW), h = clamp(rect.h, Math.min(MIN_H, maxH), maxH);
  return { x: clamp(rect.x, GAP, window.innerWidth - GAP - w), y: clamp(rect.y, GAP, window.innerHeight - GAP - h), w, h };
}
/** 처음에는 채팅 머리 아래, 가운데 칸 오른쪽에 선다 — 결과물 창의 기본 자리와 겹치지 않게 조금 왼쪽·아래다. */
function defaultRect(): Rect {
  const stage = document.querySelector(".conversation-stage")?.getBoundingClientRect();
  const right = stage ? stage.right : window.innerWidth;
  return fit({ x: right - 560 - 24, y: 64, w: 560, h: Math.min(620, window.innerHeight - 140) });
}
function initialRect(): Rect {
  try {
    const value = JSON.parse(localStorage.getItem(RECT_KEY) ?? "null") as Rect | null;
    if (value && [value.x, value.y, value.w, value.h].every((part) => typeof part === "number" && Number.isFinite(part))) return fit(value);
  } catch { /* 저장소 없이도 화면 안에서 연다. */ }
  return defaultRect();
}
function saveRect(rect: Rect) { try { localStorage.setItem(RECT_KEY, JSON.stringify(rect)); } catch { /* 선택적 편의 상태 */ } }

const TAB_KEY = { goal: "objectives.tabs.goal", crew: "objectives.tabs.crew", results: "objectives.tabs.results" } as const;

/** 데스크톱에만 선다 — 폰은 대화 정보 화면의 탭이 같은 내용을 맡는다. */
export function ObjectiveWindowHost({ language = "en", mobile = false, onOpenObjective }: {
  readonly language?: ConsoleLocale;
  readonly mobile?: boolean;
  readonly onOpenObjective: (objectiveId: string) => void;
}) {
  const state = useObjectiveWindow();
  if (state === null || mobile) return null;
  return createPortal(<ObjectiveWindow state={state} language={language === "ko" ? "ko" : "en"} onOpenObjective={onOpenObjective} />, document.body);
}

function ObjectiveWindow({ state, language, onOpenObjective }: { readonly state: ObjectiveWindowState; readonly language: "en" | "ko"; readonly onOpenObjective: (objectiveId: string) => void }) {
  const t = getT(language);
  const rootRef = useRef<HTMLDivElement>(null);
  const objective = useSyncExternalStore(subscribeObjectiveOrFinished, () => findAnyObjective(state.objectiveId), () => null);
  const [rect, setRect] = useState(initialRect);
  const [dragging, setDragging] = useState(false);
  const zIndex = useFloatingWindowZ(OBJECTIVE_WINDOW_ID, 59);
  const drag = usePointerDrag();
  const heading = t(TAB_KEY[state.tab]);
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, [state.objectiveId]);
  useEffect(() => {
    const resize = () => setRect((current) => fit(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    // 비모달 창 — Esc 는 초점이 창 안에 있을 때만 이 창을 닫는다. 입력 중인 칸과 창 안의 메뉴는 자기 Esc 를 먼저 쓴다.
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || event.key !== "Escape" || event.defaultPrevented || event.isComposing || !root.contains(document.activeElement)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      event.stopPropagation();
      closeObjectiveWindow();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const start = (event: ReactPointerEvent<HTMLElement>, direction?: Direction) => {
    if (event.button !== 0 || !event.isPrimary || (!direction && (event.target as Element).closest("button, select, a"))) return;
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    const origin = rect, px = event.clientX, py = event.clientY;
    let latest = origin, frame = 0;
    drag(event, event.currentTarget, {
      onStart: () => setDragging(true),
      onMove: (next) => {
        const dx = next.clientX - px, dy = next.clientY - py;
        let { x, y, w, h } = origin;
        if (!direction) { x += dx; y += dy; }
        else {
          if (direction.includes("e")) w = clamp(origin.w + dx, MIN_W, window.innerWidth - GAP - origin.x);
          if (direction.includes("s")) h = clamp(origin.h + dy, MIN_H, window.innerHeight - GAP - origin.y);
          if (direction.includes("w")) { x = clamp(origin.x + dx, GAP, origin.x + origin.w - MIN_W); w = origin.x + origin.w - x; }
          if (direction.includes("n")) { y = clamp(origin.y + dy, GAP, origin.y + origin.h - MIN_H); h = origin.y + origin.h - y; }
        }
        latest = fit({ x, y, w, h });
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; setRect(latest); });
      },
      onEnd: (end) => {
        cancelAnimationFrame(frame); setDragging(false);
        setRect(end ? latest : fit(origin));
        if (end) saveRect(latest);
      },
    });
  };
  const choose = (tab: DetailTab) => openObjectiveWindow({ ...state, tab });
  return <div ref={rootRef} className={`objectives-result-window objectives-objective-window${dragging ? " is-dragging" : ""}`} role="dialog" aria-modal={false} aria-label={`${heading} · ${objective?.title ?? ""}`} tabIndex={-1}
    onPointerDownCapture={() => focusFloatingWindow(OBJECTIVE_WINDOW_ID)} style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex }}>
    <header className="objectives-rw-head" onPointerDown={(event) => start(event)}>
      <span className="objectives-ow-tabs" role="tablist" aria-label={objective?.title}>
        {DETAIL_TABS.map((tab) => <button key={tab} type="button" role="tab" aria-selected={state.tab === tab} className="objectives-ow-tab" onClick={() => choose(tab)}>{t(TAB_KEY[tab])}</button>)}
      </span>
      <span className="objectives-rw-objective" title={objective?.title}>{objective?.title}</span>
      <button type="button" className="objectives-rw-reset" aria-label={t("objectives.results.window.reset")} title={t("objectives.results.window.reset")} onClick={() => { const next = defaultRect(); setRect(next); saveRect(next); }}>↺</button>
      <button type="button" className="objectives-rw-close" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={closeObjectiveWindow}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
    </header>
    <div className={`objectives-ow-body is-${state.tab}`} role="tabpanel" aria-label={heading}>
      <CommanderRowPanel commodoreId={state.commodoreId} objectiveId={state.objectiveId} language={language} tab={state.tab} onGlyphTab={choose} onOpenObjective={onOpenObjective} />
    </div>
    {DIRECTIONS.map((direction) => <span key={direction} className={`objectives-result-resize is-${direction}`} aria-hidden="true" onPointerDown={(event) => start(event, direction)} />)}
  </div>;
}
