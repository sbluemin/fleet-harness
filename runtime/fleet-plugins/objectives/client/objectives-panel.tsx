import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { coordinatorMode, stepReady, unseenRecords, type CoordinatorMode, type StepAssign, type StepRecord, type ObjectiveItem, type ObjectiveStep } from "../server/types.js";
import { NoteAttachments, imageFiles, useAttachmentUpload } from "./attachments.js";
import { CoordinationGraph } from "./graph.js";
import { DatePicker } from "./date-picker.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LaunchControl, ProviderGlyph, launchWords, loadLaunchRows, useLaunchRows } from "./launch-control.js";
import { dockObjective, expandObjective, focusOperation, loadTheater, patchObjectiveView, post, takeReveal, useOperationSummaries, useReveal, useObjectiveTheater, useObjectiveView, type ObjectiveGroup } from "./objectives-state.js";

export interface ObjectiveContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language?: ConsoleLocale;
  readonly place: "rail" | "expanded";
}

type ListId = "today" | "due" | "all" | "agent" | "ungrouped" | `group:${string}`;
type DueFilter = "all" | "overdue" | "today" | "week" | "later";
/** 끌어서 순서 바꾸기의 놓을 자리 — 이웃 카드의 앞 또는 뒤. */
type Insert = { readonly anchorId: string; readonly place: "before" | "after" };
type T = Translate<ObjectiveMessageKey>;

const ExpandGlyph = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
const DockGlyph = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.5 2.5v11M3 8h7M7 5l3 3-3 3" /></svg>;
const CheckGlyph = () => <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="M2 5.2l2.2 2.2L8 3" /></svg>;
const TrashGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" /></svg>;
const WandGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><path d="M3 13l7-7M10 3l.6 1.6L12.2 5l-1.6.6L10 7.2 9.4 5.6 7.8 5l1.6-.6zM13 9l.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4z" /></svg>;

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
/** 한글 IME 조합 중의 Return 은 확정이지 제출이 아니다 — 조합 확정과 제출로 두 번 오는 keydown 중 앞의 것을 거른다. */
function submitKey(event: ReactKeyboardEvent<HTMLElement>): boolean { return event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229; }
function createdLabel(at: number, language: "en" | "ko"): string {
  const date = new Date(at);
  if (language === "ko") {
    // "2026년 9월 23일 (수)" — 요일을 괄호로 감싼 한국어 표기. Intl 은 요일에 괄호를 치지 않는다.
    const weekday = new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(date);
    return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 (${weekday})`;
  }
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(date);
}
/** 기록 시각 — 오늘이면 시:분, 아니면 월·일과 시:분. 옛 결과에서 옮긴 기록은 시각이 없다. */
function recordTime(at: number | null, language: "en" | "ko", earlier: string): string {
  if (at === null) return earlier;
  const date = new Date(at);
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)} ${time}`;
}
const EMPTY_IDS: ReadonlySet<string> = new Set();
const ThreadGlyph = () => <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" aria-hidden="true"><path d="M2 3h8M2 6h8M2 9h5" /></svg>;

/**
 * 단계 기록 — 구상 입력 줄과 같은 문법이다: 상자·배경 없이 단계 글자와 같은 선에서 펼쳐지고, 한 건은 흐린 모노 한 줄(시각·종류)
 * 아래 결론과 나머지 줄. 오래된 것부터 읽는다. 「새 기록」은 펼친 순간 이미 읽은 기록의 id 로 가른다(펼치면 읽음이 되어도 표시는 남는다; 상한에서 밀려나도 위치가 아니라 id 라 어긋나지 않는다).
 */
function StepRecords({ id, records, seenAtOpen, open, t, language }: { id: string; records: readonly StepRecord[]; seenAtOpen: ReadonlySet<string>; open: boolean; t: Translate<ObjectiveMessageKey>; language: "en" | "ko" }) {
  return (
    <div id={id} className={`objectives-records${open ? " is-open" : ""}`} hidden={!open}>
      <div className="objectives-records-inner">
        {records.map((record) => (
          <div key={record.id} className="objectives-record">
            <div className="objectives-record-meta">
              <span>{recordTime(record.at, language, t("objectives.records.earlier"))}</span>
              <span aria-hidden="true">·</span>
              <span className={record.kind === "redone" ? "is-redone" : undefined}>{t(record.kind === "redone" ? "objectives.records.redone" : "objectives.records.done")}</span>
              {!seenAtOpen.has(record.id) ? <span className="is-new">· {t("objectives.records.new")}</span> : null}
            </div>
            {record.lines.map((line, at) => <div key={at} className={at === 0 ? "objectives-record-head" : "objectives-record-line"}>{line}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}

function dueLabel(iso: string, language: "en" | "ko"): string {
  const date = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" }).format(date);
}
const SunGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" /></svg>;
const CalGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></svg>;
const CoordGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="4" r="2" /><circle cx="4" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><path d="M7 5.7L5 10.3M9 5.7l2 4.6" /></svg>;
/** 달성 기준 — 과녁. 목표가 이루어졌다고 말할 조건들이 이 아래에 선다. */
const CriteriaGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.4" /><circle cx="8" cy="8" r="0.6" fill="currentColor" /></svg>;
const GraphGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="3.5" cy="8" r="1.6" /><circle cx="12.5" cy="4" r="1.6" /><circle cx="12.5" cy="12" r="1.6" /><path d="M5 7.3l6-2.6M5 8.7l6 2.6" /></svg>;
const StopGlyph = () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>;
const WORKING = new Set(["running", "background"]);
const ChevronGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
function dueBucket(due: string | null): DueFilter | null {
  if (!due) return null;
  const today = todayIso();
  if (due < today) return "overdue";
  if (due === today) return "today";
  const week = new Date(); week.setDate(week.getDate() + 7);
  return due <= week.toISOString().slice(0, 10) ? "week" : "later";
}

export function ObjectivePanel({ ctx }: { readonly ctx: ObjectiveContext }) {
  const t = getT(ctx.language);
  const language = ctx.language === "ko" ? "ko" : "en";
  const theaterId = ctx.theaterId;
  const state = useObjectiveTheater(theaterId);
  const operations = useOperationSummaries();
  const reveal = useReveal();
  // 보기 상태(목록 · 펼친 항목 · 구획 접힘 · 기한 필터)는 Theater 별 모듈 스토어에 산다 — 표면을 닫았다 열어도 보던 자리 그대로.
  const view = useObjectiveView(theaterId);
  const list = view.list as ListId;
  const selected = view.selected;
  const collapsed = view.collapsed;
  const dueFilter = view.dueFilter as DueFilter;
  const setList = useCallback((next: ListId) => patchObjectiveView(theaterId, () => ({ list: next })), [theaterId]);
  const setSelected = useCallback((next: string | null | ((value: string | null) => string | null)) => patchObjectiveView(theaterId, (current) => ({ selected: typeof next === "function" ? next(current.selected) : next })), [theaterId]);
  const setDueFilter = (next: DueFilter) => patchObjectiveView(theaterId, () => ({ dueFilter: next }));
  // 구획 접기 — 그룹 구획은 펼침이 기본, 맨 아래 「완료됨」은 접힘이 기본.
  const toggleSection = (key: string, defaultOpen: boolean) => patchObjectiveView(theaterId, (current) => ({ collapsed: { ...current.collapsed, [key]: key in current.collapsed ? !current.collapsed[key] : defaultOpen } }));
  const isOpen = (key: string, defaultOpen: boolean) => (key in collapsed ? !collapsed[key] : defaultOpen);
  const [highlightStep, setHighlightStep] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; undo?: () => Promise<void> } | null>(null);
  const launchRows = useLaunchRows();
  // 끌기 — 카드를 왼쪽 목록 위에 놓으면 그 목록으로 옮기고, 같은 구획의 카드 사이에 놓으면 순서를 바꾼다.
  // 원래 자리는 빈 홈으로 남고 카드 유령이 커서를 따르며, 순서를 바꿀 자리에는 삽입선이 선다.
  const [drag, setDrag] = useState<{ itemId: string; x: number; y: number; over: ListId | null; insert: Insert | null; offX: number; offY: number; width: number; compact: boolean } | null>(null);
  const dragRef = useRef<{ itemId: string; section: string; startX: number; startY: number; live: boolean; over: ListId | null; insert: Insert | null; offX: number; offY: number; width: number } | null>(null);
  const suppressClick = useRef(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const listMenuRef = useRef<HTMLDivElement | null>(null);
  const listTriggerRef = useRef<HTMLButtonElement | null>(null);
  const placeButton = (className: string) => <button type="button" className={`objectives-place-button ${className}`} aria-label={t(ctx.place === "rail" ? "objectives.panel.expand" : "objectives.panel.dock")} title={t(ctx.place === "rail" ? "objectives.panel.expand" : "objectives.panel.dock")} onClick={ctx.place === "rail" ? expandObjective : dockObjective}>
    {ctx.place === "rail" ? <ExpandGlyph /> : <DockGlyph />}
  </button>;
  useEffect(() => {
    if (!listMenuOpen) return;
    const onDown = (event: PointerEvent) => { if (!listMenuRef.current?.contains(event.target as Node)) setListMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setListMenuOpen(false); listTriggerRef.current?.focus(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey, true); };
  }, [listMenuOpen]);

  useEffect(() => { if (theaterId) void loadTheater(ctx.api, theaterId); }, [ctx.api, theaterId]);
  // 남겨 둔 자리가 사라졌으면(항목 삭제 · 그룹 제거) 그 자리만 거둔다 — 다른 곳에서 지워진 것을 붙들고 빈 화면을 보이지 않게.
  useEffect(() => {
    if (!state.loaded) return;
    if (selected && !state.items.some((item) => item.id === selected)) setSelected(null);
    if (list.startsWith("group:") && !state.groups.some((group) => group.id === list.slice(6))) setList("all");
  }, [state.loaded, state.items, state.groups, selected, list, setSelected, setList]);

  // 팔레트·캡션에서 온 "이 항목으로" — 이 Theater 의 항목이면 고르고 단계를 잠깐 강조한다.
  useEffect(() => {
    if (!reveal) return;
    const item = state.items.find((candidate) => candidate.id === reveal.itemId);
    if (!item) return;
    takeReveal();
    setSelected(item.id);
    setList(item.groupId ? `group:${item.groupId}` : "ungrouped");
    if (reveal.stepId) { setHighlightStep(reveal.stepId); setTimeout(() => setHighlightStep(null), 2400); }
  }, [reveal, state.items]);

  // 중앙 하단 알림은 두지 않는다 — 결과는 화면 자체가 말한다(행·비콘·목록). 호출부는 남겨 두되 아무것도 띄우지 않는다.
  const toast = useCallback((_text: string, _undo?: () => Promise<void>) => undefined, []);
  const fail = useCallback((error: unknown) => {
    const code = error instanceof Error ? error.message : "unknown";
    toast(code === "item_busy" ? t("objectives.toast.busy") : t("objectives.toast.failed", { code }));
  }, [t, toast]);
  const call = useCallback(async <R,>(path: string, body: Record<string, unknown>): Promise<R | null> => {
    try { return await post<R>(ctx.api, path, { ...body, language }); } catch (error) { fail(error); return null; }
  }, [ctx.api, fail, language]);

  const operationOf = useCallback((operationId: string) => operations.find((candidate) => candidate.id === operationId) ?? null, [operations]);
  const operationTitle = useCallback((operationId: string) => operationOf(operationId)?.title ?? "—", [operationOf]);
  const operationState = useCallback((operationId: string): string => operationOf(operationId)?.activity ?? "closed", [operationOf]);
  // 항목의 활동 = 지휘관과 담당 가운데 가장 급한 것 — 호스트가 캔버스에서 지휘관을 그리는 셈법과 같다.
  const URGENCY: Record<string, number> = { awaiting: 0, running: 1, background: 2, idle: 3, ended: 4, unknown: 5 };
  const itemActivity = useCallback((item: ObjectiveItem) => {
    const ids = [item.slot?.operationId, ...item.steps.map((step) => step.slot?.operationId)].filter((id): id is string => !!id);
    return ids.map((id) => operationState(id)).filter((state) => state !== "closed").reduce((top, state) => ((URGENCY[state] ?? 9) < (URGENCY[top] ?? 9) ? state : top), "unknown" as ReturnType<typeof operationState>);
  }, [operationState]);
  // 조율자가 일하는 동안 카드는 잠긴다 — 편집 대신 「중단」 하나만 남는다(서버도 같은 기준으로 거절한다).
  // 담당의 활동은 잠그지 않고, 조율자가 사람을 기다리는(awaiting) 동안도 잠그지 않는다 — 그때는 사람이 손을 대야 한다.
  const isBusy = useCallback((item: ObjectiveItem): boolean => !item.done && !!item.slot && WORKING.has(operationState(item.slot.operationId)), [operationState]);
  const stopItem = async (item: ObjectiveItem) => {
    const result = await call<{ interrupted: number }>("/coordinator/stop", { itemId: item.id });
    if (result) toast(t("objectives.toast.stopped", { count: result.interrupted }));
  };
  const modeLabel = (mode: CoordinatorMode) => t(mode === "direct" ? "objectives.mode.direct" : mode === "coordinate" ? "objectives.mode.coordinate" : "objectives.mode.mixed");
  const stateLabel = (state: string) => t((["running", "awaiting", "idle", "background", "ended", "closed"].includes(state) ? `objectives.state.${state}` : "objectives.state.unknown") as Parameters<typeof t>[0]);

  const groupOf = (groupId: string | null): ObjectiveGroup | null => (groupId ? state.groups.find((group) => group.id === groupId) ?? null : null);
  const inList = useCallback((item: ObjectiveItem): boolean => {
    if (list === "today") return item.today;
    if (list === "due") return !!item.dueDate && (dueFilter === "all" || dueBucket(item.dueDate) === dueFilter);
    if (list === "all") return true;
    if (list === "agent") return item.author.kind === "operation";
    if (list === "ungrouped") return !groupOf(item.groupId);
    return item.groupId === list.slice(6);
  }, [list, dueFilter, state.groups]);
  const visible = useMemo(() => state.items.filter((item) => inList(item)), [state.items, inList]);
  const open = useMemo(() => visible.filter((item) => !item.done), [visible]);
  const finished = useMemo(() => visible.filter((item) => item.done), [visible]);
  // 스마트 목록(오늘·기한·전부·에이전트)은 그룹별 구획으로 선다 — 사이드바 그룹 순서, 미분류는 마지막.
  const sectioned = !list.startsWith("group:") && list !== "ungrouped";
  const sections = useMemo(() => {
    type Section = { key: string; label: string | null; swatch: string | null; items: ObjectiveItem[]; done?: boolean };
    const out: Section[] = [];
    if (!sectioned) out.push({ key: "flat", label: null, swatch: null, items: open });
    else {
      for (const group of state.groups) {
        const items = open.filter((item) => item.groupId === group.id);
        if (items.length) out.push({ key: group.id, label: group.name, swatch: group.color, items });
      }
      const rest = open.filter((item) => !groupOf(item.groupId));
      if (rest.length) out.push({ key: "ungrouped", label: t("objectives.list.ungrouped"), swatch: null, items: rest });
    }
    // 완료된 항목은 목록 맨 아래 「완료됨」 한 구획 — 펼쳐야 보인다.
    if (finished.length) out.push({ key: "done", label: t("objectives.items.done"), swatch: null, items: finished, done: true });
    return out;
  }, [sectioned, open, finished, state.groups, t]);
  const openCount = (predicate: (item: ObjectiveItem) => boolean) => state.items.filter((item) => !item.done && predicate(item)).length;
  const current = selected ? state.items.find((item) => item.id === selected) ?? null : null;
  const detailRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      if (mainRef.current && getComputedStyle(mainRef.current).display === "none") detailRef.current?.querySelector<HTMLElement>(".objectives-detail-back")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  const closeDetail = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => { if (id) itemsRef.current?.querySelector<HTMLElement>(`.objectives-item[data-item-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); });
  };

  const listTitle = list === "today" ? t("objectives.list.today") : list === "due" ? t("objectives.list.due") : list === "all" ? t("objectives.list.all") : list === "agent" ? t("objectives.list.agent") : list === "ungrouped" ? t("objectives.list.ungrouped") : groupOf(list.slice(6))?.name ?? t("objectives.list.all");
  const listSub = list === "today" ? t("objectives.sub.today") : list === "due" ? t("objectives.sub.due") : list === "all" ? t("objectives.sub.all") : list === "agent" ? t("objectives.sub.agent") : list === "ungrouped" ? t("objectives.sub.ungrouped") : t("objectives.sub.group");

  // ── 행동 ──
  const completeItem = async (item: ObjectiveItem) => {
    if (item.done) { await call("/item/complete", { itemId: item.id, undone: true }); toast(t("objectives.toast.reopened")); return; }
    const slots = (item.slot ? 1 : 0) + item.steps.filter((step) => step.slot).length;
    const result = await call("/item/complete", { itemId: item.id });
    if (result) toast(t("objectives.toast.completed", { count: slots }), async () => { await call("/item/complete", { itemId: item.id, undone: true }); });
  };
  const addItem = async (raw: string) => {
    let title = raw.trim();
    if (!title) return;
    const important = /(^|\s)!/.test(title);
    title = title.replace(/(^|\s)!\S*/g, "$1").trim();
    if (!title || !theaterId) return;
    const groupId = list.startsWith("group:") ? list.slice(6) : null;
    await call("/item/create", { theaterId, groupId, title, important, today: list === "today", dueDate: list === "due" ? todayIso() : null });
  };
  const toggleEdge = async (item: ObjectiveItem, from: string, to: string) => {
    const result = await call<{ item: ObjectiveItem; linked: boolean }>("/edge/toggle", { itemId: item.id, from, to });
    if (!result) return;
    const index = (id: string) => item.steps.findIndex((step) => step.id === id) + 1;
    toast(t(result.linked ? "objectives.toast.linkedEdge" : "objectives.toast.cutEdge", { from: index(from), to: index(to) }));
  };

  /** 같은 구획 안에서 커서 높이에 맞는 삽입 자리 — 카드의 가운데보다 위면 그 앞, 끝을 지나면 마지막 카드 뒤. 제자리면 없다. */
  const insertAt = (x: number, y: number, itemId: string, sectionKey: string): Insert | null => {
    if (sectionKey === "done") return null;
    const section = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-section]");
    if (!section || section.dataset.section !== sectionKey) return null;
    const ids = [...section.querySelectorAll<HTMLElement>("[data-item-id]")].map((card) => ({ id: card.dataset.itemId!, rect: card.getBoundingClientRect() }));
    const others = ids.filter((card) => card.id !== itemId);
    if (others.length === 0) return null;
    const next = others.find((card) => y < card.rect.top + card.rect.height / 2);
    const insert: Insert = next ? { anchorId: next.id, place: "before" } : { anchorId: others[others.length - 1]!.id, place: "after" };
    const from = ids.findIndex((card) => card.id === itemId);
    const anchor = ids.findIndex((card) => card.id === insert.anchorId);
    return (insert.place === "before" ? anchor === from + 1 : anchor === from - 1) ? null : insert;
  };
  const reorder = async (item: ObjectiveItem, insert: Insert) => {
    await call("/item/move", { itemId: item.id, ...(insert.place === "before" ? { beforeId: insert.anchorId } : { afterId: insert.anchorId }) });
  };
  const dropTargetAt = (x: number, y: number): ListId | null => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-list]");
    return (hit?.dataset.dropList as ListId | undefined) ?? null;
  };
  const moveTo = async (item: ObjectiveItem, target: ListId) => {
    const patch: Record<string, unknown> = target === "today" ? { today: true }
      : target === "due" ? { dueDate: item.dueDate ?? todayIso() }
      : target === "ungrouped" ? { groupId: null }
      : target.startsWith("group:") ? { groupId: target.slice(6) } : {};
    if (Object.keys(patch).length === 0) return;
    const result = await call("/item/patch", { itemId: item.id, patch });
    if (!result) return;
    const name = target === "today" ? t("objectives.list.today") : target === "due" ? t("objectives.list.due") : target === "ungrouped" ? t("objectives.list.ungrouped") : groupOf(target.slice(6))?.name ?? "";
    toast(t("objectives.toast.moved", { list: name }));
  };
  const onItemPointerDown = (event: ReactPointerEvent<HTMLDivElement>, item: ObjectiveItem, sectionKey: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, a")) return;
    // 지휘관이 일하는 동안에도 순서는 바꿀 수 있다(내용이 아니다). 목록 옮기기는 편집이라 그때는 잠긴다.
    const busy = isBusy(item);
    // 잡은 지점을 기억한다 — 유령은 커서 옆이 아니라 손에 잡힌 그 자리에 그대로 붙어 따라온다.
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { itemId: item.id, section: sectionKey, startX: event.clientX, startY: event.clientY, live: false, over: null, insert: null, offX: event.clientX - rect.left, offY: event.clientY - rect.top, width: rect.width };
    const onMove = (move: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.live) {
        if (Math.hypot(move.clientX - state.startX, move.clientY - state.startY) < 6) return;
        state.live = true;
        suppressClick.current = true;
      }
      state.over = busy ? null : dropTargetAt(move.clientX, move.clientY);
      state.insert = state.over ? null : insertAt(move.clientX, move.clientY, state.itemId, state.section);
      // 목록 열 위로 들어오면 카드가 손 안의 표로 줄어든다 — 놓을 자리가 카드 아래 가려지지 않게.
      const compact = !!document.elementFromPoint(move.clientX, move.clientY)?.closest(".objectives-lists");
      setDrag({ itemId: state.itemId, x: move.clientX, y: move.clientY, over: state.over, insert: state.insert, offX: state.offX, offY: state.offY, width: state.width, compact });
    };
    // 취소(pointercancel — 시스템 제스처·창 전환)는 놓기가 아니다 — 아무것도 옮기지 않고 끝낸다.
    const onUp = (end: PointerEvent) => {
      const state = end.type === "pointercancel" ? null : dragRef.current;
      dragRef.current = null;
      setTimeout(() => { suppressClick.current = false; }, 0);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      setDrag(null);
      if (state?.live && state.over) void moveTo(item, state.over);
      else if (state?.live && state.insert) void reorder(item, state.insert);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  const dragItem = drag ? state.items.find((item) => item.id === drag.itemId) ?? null : null;

  const onItemKey = (event: ReactKeyboardEvent<HTMLDivElement>, item: ObjectiveItem, index: number, sectionKey: string) => {
    const rows = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".objectives-item") ?? [])];
    // Alt+Shift+↑/↓ — 끌기의 키보드 짝(사이드바 칩 재정렬과 같은 조합; Alt+화살표는 Console 이 포커스 순환에 예약했다).
    // 같은 구획의 이웃 카드와 자리를 바꾸고 초점은 옮긴 카드에 남는다.
    if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (sectionKey === "done") return;
      const at = rows.indexOf(event.currentTarget);
      const neighbor = rows[event.key === "ArrowUp" ? at - 1 : at + 1]?.dataset.itemId;
      if (neighbor) void reorder(item, { anchorId: neighbor, place: event.key === "ArrowUp" ? "before" : "after" });
      return;
    }
    if (event.key === " ") { event.preventDefault(); if (!isBusy(item)) void completeItem(item); }
    else if (event.key === "Enter") { setSelected(item.id); }
    else if (event.key === "ArrowDown") { event.preventDefault(); rows[index + 1]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); rows[index - 1]?.focus(); }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && selected && !listMenuOpen && !document.querySelector(".objectives-cal, .objectives-zoom-backdrop, .objectives-menu")) closeDetail(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, listMenuOpen]);

  if (!theaterId) return <div className="objectives-container"><div className="objectives-root"><div className="objectives-main"><div className="objectives-empty">{t("objectives.items.emptyTheater")}</div></div></div></div>;

  const pickList = (next: ListId) => { setList(next); setListMenuOpen(false); listTriggerRef.current?.focus(); };
  return (
    <div className="objectives-container"><div className={`objectives-root${current ? " has-detail" : ""}`}>
      <nav className={`objectives-lists${drag ? " is-dragging" : ""}`} aria-label={t("objectives.panel.title")}>
        <ListButton id="today" current={list} onPick={setList} drop over={drag?.over === "today"} label={`☀ ${t("objectives.list.today")}`} count={openCount((item) => item.today)} />
        <ListButton id="due" current={list} onPick={setList} drop over={drag?.over === "due"} label={t("objectives.list.due")} count={openCount((item) => !!item.dueDate)} />
        <ListButton id="all" current={list} onPick={setList} label={`∞ ${t("objectives.list.all")}`} count={openCount(() => true)} />
        <ListButton id="agent" current={list} onPick={setList} label={`◌ ${t("objectives.list.agent")}`} count={openCount((item) => item.author.kind === "operation")} />
        <div className="objectives-lists-hd" title={t("objectives.list.groupsHint")}>{t("objectives.list.groups")}</div>
        {state.groups.map((group) => (
          <ListButton key={group.id} id={`group:${group.id}`} current={list} onPick={setList} drop over={drag?.over === `group:${group.id}`} label={group.name} swatch={group.color} count={openCount((item) => item.groupId === group.id)} />
        ))}
        <ListButton id="ungrouped" current={list} onPick={setList} drop over={drag?.over === "ungrouped"} label={t("objectives.list.ungrouped")} muted count={openCount((item) => !groupOf(item.groupId))} />
        <button type="button" className="objectives-lists-add" onClick={async () => { const result = await call<{ group: ObjectiveGroup }>("/group/create", { theaterId, name: t("objectives.list.newGroupName"), color: "teal" }); if (result) { setList(`group:${result.group.id}`); toast(t("objectives.toast.groupCreated")); } }}>+ {t("objectives.list.newGroup")}</button>
      </nav>

      <section ref={mainRef} className="objectives-main">
        <div className="objectives-title">
          <div ref={listMenuRef} className="objectives-list-select">
            <button ref={listTriggerRef} type="button" className="objectives-list-trigger" aria-label={t("objectives.list.select")} aria-haspopup="menu" aria-expanded={listMenuOpen} onClick={() => setListMenuOpen((value) => !value)}><span>{listTitle}</span><span className="objectives-count">{open.length}</span><span aria-hidden="true">⌄</span></button>
            {listMenuOpen ? <div className="objectives-list-menu" role="menu" aria-label={t("objectives.list.select")}>
              {(["today", "due", "all", "agent"] as const).map((id) => <ListButton key={id} id={id} current={list} onPick={pickList} label={t(`objectives.list.${id}`)} count={openCount((item) => id === "today" ? item.today : id === "due" ? !!item.dueDate : id === "agent" ? item.author.kind === "operation" : true)} menu />)}
              <div className="objectives-lists-hd">{t("objectives.list.groups")}</div>
              {state.groups.map((group) => <ListButton key={group.id} id={`group:${group.id}`} current={list} onPick={pickList} label={group.name} swatch={group.color} count={openCount((item) => item.groupId === group.id)} menu />)}
              <ListButton id="ungrouped" current={list} onPick={pickList} label={t("objectives.list.ungrouped")} count={openCount((item) => !groupOf(item.groupId))} menu />
              <button type="button" className="objectives-lists-add" role="menuitem" onClick={async () => { const result = await call<{ group: ObjectiveGroup }>("/group/create", { theaterId, name: t("objectives.list.newGroupName"), color: "teal" }); if (result) { pickList(`group:${result.group.id}`); toast(t("objectives.toast.groupCreated")); } }}>+ {t("objectives.list.newGroup")}</button>
            </div> : null}
          </div>
          <h2>{listTitle}</h2>
          <span className="objectives-sub">{listSub}</span>
          {placeButton("objectives-place-main")}
        </div>
        {list === "due" ? (
          <div className="objectives-chips">
            {(["all", "overdue", "today", "week", "later"] as const).map((bucket) => (
              <button key={bucket} type="button" className="objectives-chip" aria-pressed={dueFilter === bucket} onClick={() => setDueFilter(bucket)}>{t(bucket === "all" ? "objectives.due.all" : bucket === "overdue" ? "objectives.due.overdue" : bucket === "today" ? "objectives.due.today" : bucket === "week" ? "objectives.due.week" : "objectives.due.later")}</button>
            ))}
          </div>
        ) : null}
        <div ref={itemsRef} className="objectives-items" role="listbox" aria-label={listTitle}>
          {open.length === 0 && finished.length === 0 ? <div className="objectives-empty">{t("objectives.items.empty")}</div> : null}
          {sections.map((section) => { const expanded = isOpen(section.key, !section.done); return (<div key={section.key} data-section={section.key} className={`objectives-section${section.done ? " is-done" : ""}${expanded ? "" : " is-collapsed"}`}>
          {section.label ? <button type="button" className="objectives-section-hd" aria-expanded={expanded} onClick={() => toggleSection(section.key, !section.done)}><span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>{section.swatch ? <span className="objectives-swatch" style={{ background: `var(--id-${section.swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}<span>{section.label}</span><span className="objectives-count">{section.items.length}</span></button> : null}
          {expanded ? section.items.map((item) => {
            const index = visible.indexOf(item);
            const mode = coordinatorMode(item);
            const showGroup = false as false | ObjectiveGroup | null;
            const busy = isBusy(item);
            return (
              <div key={item.id} data-item-id={item.id} className={`objectives-item${item.done ? " is-done" : ""}${busy ? " is-busy" : ""}${drag?.itemId === item.id ? " is-lifted" : ""}${drag?.insert?.anchorId === item.id ? ` is-insert-${drag.insert.place}` : ""}`} role="option" aria-selected={selected === item.id} tabIndex={0}
                onPointerDown={(event) => onItemPointerDown(event, item, section.key)}
                onClick={() => { if (suppressClick.current) return; setSelected((value) => (value === item.id ? null : item.id)); }} onKeyDown={(event) => onItemKey(event, item, index, section.key)}>
                {/* 동그라미 = 완료 버튼이자 상태. 지휘관이 연결돼 있으면 묶음에서 가장 급한 활동을 고리로 보이고, 일하는 동안은 누르지 못한다. 완료는 늘 사람의 몫이다. */}
                {/* 검토 대기 — 지휘관이 다 했다고 넘긴 상태. 고리는 사람의 완료 버튼이 된다. */}
                {item.review && !item.done
                  ? <span className="objectives-check-tip"><button type="button" className="objectives-check is-linked is-review" aria-label={t("objectives.review.tip")} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><i aria-hidden="true" /></button><span className="objectives-check-bubble" aria-hidden="true">{t("objectives.review.tip")}</span></span>
                  : item.slot && !item.done && operationState(item.slot.operationId) !== "closed"
                  ? (() => { const state = itemActivity(item); return (
                    <span className="objectives-check-tip">
                      <button type="button" className={`objectives-check is-linked is-${state}`} aria-label={t(busy ? "objectives.item.linkedBusyTip" : "objectives.item.linkedTip", { state: stateLabel(state) })} disabled={busy} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><i aria-hidden="true" /></button>
                      <span className="objectives-check-bubble" aria-hidden="true">{t(busy ? "objectives.item.linkedBusyTip" : "objectives.item.linkedTip", { state: stateLabel(state) })}</span>
                    </span>
                  ); })()
                  : <button type="button" className={`objectives-check${item.done ? " is-on" : ""}`} aria-label={t(item.done ? "objectives.item.reopen" : "objectives.item.complete")} disabled={busy} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><CheckGlyph /></button>}
                <div>
                  <div className="objectives-item-title">{item.title}</div>
                  <div className="objectives-item-meta">
                    {item.steps.length ? <span>✓ {item.steps.filter((step) => step.done).length}/{item.steps.length}</span> : null}
                    {item.dueDate ? <span className={`objectives-item-due${item.dueDate < todayIso() && !item.done ? " is-overdue" : ""}`}><CalGlyph />{dueLabel(item.dueDate, language)}</span> : null}
                    {showGroup ? <span>{showGroup.name}</span> : null}
                    {item.author.kind === "operation" ? <span className="objectives-by">{t("objectives.item.addedBy", { name: item.author.title ?? "" })}</span> : null}
                  </div>
                </div>
                <div className="objectives-item-side">
                  <LaunchWords item={item} rows={launchRows} autoLabel={t("objectives.coordinator.effortAuto")} defaultLabel={t("objectives.launch.default")} state={item.slot ? operationState(item.slot.operationId) : null} />
                  {item.slot && operationState(item.slot.operationId) !== "closed" ? <button type="button" className="objectives-glyph objectives-goto" aria-label={t("objectives.item.goToOperation")} title={t("objectives.item.goToOperation")} onClick={(event) => { event.stopPropagation(); focusOperation(item.slot!.operationId); }}><GoGlyph /></button> : null}
                  <button type="button" className={`objectives-star${item.important ? " is-on" : ""}`} aria-label={t("objectives.item.important")} aria-pressed={item.important} onClick={(event) => { event.stopPropagation(); void call("/item/patch", { itemId: item.id, patch: { important: !item.important } }); }}>{item.important ? "★" : "☆"}</button>
                </div>
              </div>
            );
          }) : null}
          </div>); })}
        </div>
        <div className="objectives-add">
          <span className="objectives-plus" aria-hidden="true">+</span>
          <input aria-label={t("objectives.items.add")} placeholder={t("objectives.items.add")} onKeyDown={(event) => { if (submitKey(event)) { const target = event.currentTarget; void addItem(target.value).then(() => { target.value = ""; }); } }} />
        </div>
        {banner ? (
          <div className="objectives-banner" role="status">
            <span>{banner.text}</span>
            {banner.undo ? <button type="button" className="objectives-btn objectives-banner-undo" onClick={() => { void banner.undo?.(); setBanner(null); }}>{t("objectives.undo")}</button> : null}
          </div>
        ) : null}
      </section>

      {current ? (
        <ItemDetail
          key={current.id}
          item={current}
          t={t}
          language={language}
          launchAvailable={state.launchAvailable}
          call={call}
          toast={toast}
          modeLabel={modeLabel}
          stateLabel={stateLabel}
          operationTitle={operationTitle}
          operationState={operationState}
          busy={isBusy(current)}
          onStop={() => stopItem(current)}
          highlightStep={highlightStep}
          onClose={closeDetail}
          detailRef={detailRef}
          placeButton={placeButton("objectives-place-detail")}
          onComplete={() => completeItem(current)}
          onToggleEdge={(from, to) => toggleEdge(current, from, to)}
          freeOperations={operations.filter((operation) => operation.theaterId === theaterId && operation.activity !== "ended")}
        />
      ) : null}
      {/* 유령은 body 포털 — 확대 표면은 transform 조상이라 fixed 가 그 안에서 어긋난다. */}
      {drag && dragItem ? createPortal(
        // 순서를 바꿀 자리가 잡히면 유령은 표로 줄어 커서 오른쪽 아래로 비킨다 — 카드 크기로 커서에 붙어 있으면 바로 그 틈의 삽입선을 덮는다.
        <div className={`objectives-drag-ghost${drag.over || drag.insert ? " is-over" : ""}${drag.compact || drag.insert ? " is-compact" : ""}`} style={drag.compact ? { left: drag.x - 18, top: drag.y - 16, width: 224 } : drag.insert ? { left: drag.x + 14, top: drag.y + 12, width: 224 } : { left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.width }} aria-hidden="true">
          <span className={`objectives-check${dragItem.done ? " is-on" : ""}`}><CheckGlyph /></span>
          <span className="objectives-drag-title">{dragItem.title}</span>
          <span className="objectives-drag-hint">{drag.over ? "↓" : drag.insert ? "↕" : t("objectives.drag.hint")}</span>
        </div>,
        document.body,
      ) : null}
    </div></div>
  );
}

function ListButton({ id, current, onPick, label, count, swatch, muted, drop, over, menu }: { id: ListId; current: ListId; onPick: (id: ListId) => void; label: string; count: number; swatch?: string; muted?: boolean; drop?: boolean; over?: boolean; menu?: boolean }) {
  return (
    <button type="button" className={`objectives-list-btn${muted ? " is-muted" : ""}${over ? " is-drop" : ""}`} role={menu ? "menuitemradio" : undefined} aria-checked={menu ? current === id : undefined} aria-current={current === id} onClick={() => onPick(id)} {...(drop ? { "data-drop-list": id } : {})}>
      {swatch ? <span className="objectives-swatch" style={{ background: `var(--id-${swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}
      <span>{label}</span>
      <span className="objectives-count">{count}</span>
    </button>
  );
}

/** 카드 오른쪽의 조율자 모델·강도 — 시작 뒤엔 슬롯의 값, 전엔 예약값. 살아 있으면 점이 켜진다. */
function LaunchWords({ item, rows, autoLabel, defaultLabel, state }: { item: ObjectiveItem; rows: ReturnType<typeof useLaunchRows>; autoLabel: string; defaultLabel: string; state: string | null }) {
  // 슬롯이 찼는데 모델이 비어 있으면 Console 기본값으로 뜬 것이다 — 예약값을 되비치면 거짓이 된다.
  const words = item.slot && !item.slot.model
    ? { model: defaultLabel, effort: item.slot.effort?.toUpperCase() ?? autoLabel }
    : launchWords(rows, item.slot?.model ?? item.launch.model, item.slot?.effort ?? item.launch.effort, autoLabel);
  return (
    <span className={`objectives-item-launch${state ? ` is-${state}` : ""}`} title={`${words.model} · ${words.effort}`}>
      <span>{words.model}</span>
      <b>{words.effort}</b>
    </span>
  );
}

function OpChip({ state, label, title, onRemove, removeLabel }: { state: string; label: string; title?: string; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className={`objectives-op is-${state}`} title={title ?? label}>
      <i aria-hidden="true" />
      {label}
      {onRemove ? <button type="button" className="objectives-x" aria-label={removeLabel} onClick={(event) => { event.stopPropagation(); onRemove(); }}>×</button> : null}
    </span>
  );
}

interface DetailProps {
  readonly item: ObjectiveItem;
  readonly t: T;
  readonly language: "en" | "ko";
  readonly launchAvailable: boolean;
  readonly call: <R,>(path: string, body: Record<string, unknown>) => Promise<R | null>;
  readonly toast: (text: string, undo?: () => Promise<void>) => void;
  readonly modeLabel: (mode: CoordinatorMode) => string;
  readonly stateLabel: (state: string) => string;
  readonly operationTitle: (operationId: string) => string;
  readonly operationState: (operationId: string) => string;
  readonly busy: boolean;
  readonly onStop: () => Promise<void>;
  readonly highlightStep: string | null;
  readonly onClose: () => void;
  readonly detailRef: RefObject<HTMLElement | null>;
  readonly placeButton: ReactNode;
  readonly onComplete: () => void;
  readonly onToggleEdge: (from: string, to: string) => Promise<void>;
  readonly freeOperations: readonly { id: string; title: string; activity: string }[];
}

/**
 * 세부 — 입력 폼이 아니라 행의 목록이다. 일정 → 지휘관 → 구상 → 단계 → 편성 → 메모, 맨 아래 시작/중단/완료 띠와 닫기·삭제.
 * 값이 있는 행은 그 값을 말하고 × 로 지우며, 없는 행은 동사("기한 설정")로 선다. 테두리 친 입력은 없다 — 제목·단계·메모 모두 글 위에 바로 쓴다.
 */
const ZoomGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;

/** 편성 확대본 — body 포털의 고정 오버레이. Esc·바깥 누름·닫기 글리프로 닫히고, 열릴 때 카드가 포커스를 받는다. */
function LineupZoom({ t, title, onClose, children }: { readonly t: Translate<ObjectiveMessageKey>; readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 최초 한 번만 카드로 초점을 옮긴다 — 부모가 다시 그려도(항목 사건 갱신) 사용자가 옮겨 둔 초점을 되돌리지 않는다.
  useEffect(() => { cardRef.current?.focus(); }, []);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onClose = () => onCloseRef.current();
    // 캡처 단계에서 삼킨다 — 같은 Esc 가 창의 처리기까지 올라가 상세를 함께 닫지 않도록.
    // Tab 은 카드 안에서만 돈다(aria-modal): 뒤의 패널로 초점이 새면 열린 채로 숨은 조작이 가능해진다.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab" || !cardRef.current) return;
      const card = cardRef.current;
      const stops = [...card.querySelectorAll<HTMLElement | SVGElement>("button, [tabindex]:not([tabindex='-1'])")].filter((el) => !(el as HTMLButtonElement).disabled);
      const active = document.activeElement;
      const inside = active instanceof Node && card.contains(active);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) { event.preventDefault(); card.focus(); return; }
      if (event.shiftKey ? !inside || active === first || active === card : !inside || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="objectives-zoom-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={cardRef} className="objectives-zoom" role="dialog" aria-modal="true" aria-label={`${t("objectives.graph.title")} · ${title}`} tabIndex={-1}>
        <div className="objectives-zoom-head">
          <span className="objectives-zoom-title">{t("objectives.graph.title")}<span className="objectives-zoom-item">{title}</span></span>
          <button type="button" className="objectives-glyph" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><CloseGlyph /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const GoGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5 7.5 8.5" /></svg>;

const AssignGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="2.2" /><circle cx="11" cy="11" r="2.2" /><path d="M7 5h3.5a1.5 1.5 0 0 1 1.5 1.5V8.8M9 11H5.5A1.5 1.5 0 0 1 4 9.5V7.2" /></svg>;

/**
 * 단계의 사전 배정 — 지휘관 컨트롤과 같은 메뉴에 「지휘관 직접 · 라우팅 · 지휘관과 같게」가 먼저 서고, 그 아래 모델 목록.
 * 모델을 고르면 그 모델·강도로 담당이 뜨고, 라우팅은 시작할 때 AI Gateway 가 난이도로 고른다. `all` 은 열린 단계 전부에 같은 배정.
 */
function AssignControl({ t, assign, onChange, label, all = false }: { readonly t: Translate<ObjectiveMessageKey>; readonly assign: StepAssign | null; readonly onChange: (assign: StepAssign | null) => void; readonly label: string; readonly all?: boolean }) {
  return (
    <LaunchControl
      t={t}
      model={assign?.mode === "model" ? assign.model : undefined}
      effort={assign?.mode === "model" ? assign.effort : undefined}
      view={undefined}
      locked={false}
      startAtList
      trigger={<AssignGlyph />}
      triggerLabel={label}
      extras={[
        { id: "self", label: t("objectives.assign.self"), active: !assign || assign.mode === "self", onPick: () => onChange({ mode: "self" }) },
        { id: "route", label: t("objectives.assign.route"), hint: t("objectives.assign.routeHint"), active: assign?.mode === "route", onPick: () => onChange({ mode: "route" }) },
        ...(all ? [] : [{ id: "inherit", label: t("objectives.assign.inherit"), active: assign === null, onPick: () => onChange(null) }]),
      ]}
      onChange={(next) => { if (next.view !== undefined && next.model === undefined) return; onChange({ mode: "model", model: next.model ?? assign?.model, effort: next.effort ?? assign?.effort }); }}
    />
  );
}

function SendGlyph() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" /></svg>;
}

function ItemDetail({ item, t, language, launchAvailable, call, toast, modeLabel, stateLabel, operationTitle, operationState, busy, onStop, highlightStep, onClose, detailRef, placeButton, onComplete, onToggleEdge, freeOperations }: DetailProps) {
  const [note, setNote] = useState(item.note);
  const [cook, setCook] = useState(item.cook ?? "");
  const [cookOpen, setCookOpen] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [picker, setPicker] = useState<{ stepId: string | null } | null>(null);
  const [planning, setPlanning] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const launchRows = useLaunchRows();
  useEffect(() => { setNote(item.note); }, [item.note]);
  useEffect(() => { setCook(item.cook ?? ""); }, [item.cook]);
  useEffect(() => { setTitle(item.title); }, [item.title]);
  const mode = coordinatorMode(item);
  const locked = !!item.slot;
  const editable = !item.done && !busy;
  // 지휘관이 일하는 동안에도 받는 편집 — 단계 추가, 시작 전(끝나지 않고 담당이 없는) 단계의 문구·삭제·선행, 메모. 서버가 같은 기준으로 가른다.
  const touchable = !item.done;
  const notStarted = (step: ObjectiveStep) => !step.done && !step.slot;
  const canEditStep = (stepId: string) => { if (editable) return true; const target = item.steps.find((candidate) => candidate.id === stepId); return touchable && !!target && notStarted(target); };
  const [steering, setSteering] = useState(false);
  // 지휘관에게 알릴 편집이 쌓였다 — 지휘관이 일하는 중이거나, 일을 마치고 검토를 맡긴 뒤다(지휘관은 그 편집을 아직 읽지 않았다).
  const steerPending = !item.done && !!item.edited && !!item.slot && (busy || !!item.review);
  const attachments = useAttachmentUpload(item, t);
  const [dropping, setDropping] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  // 펼친 단계 기록 — 단계 id → 펼친 순간 이미 읽은 기록 id(「새 기록」 표시의 기준). 다른 항목으로 가면 모두 접는다.
  const [openRecords, setOpenRecords] = useState<Readonly<Record<string, ReadonlySet<string>>>>({});
  useEffect(() => { setOpenRecords({}); }, [item.id]);
  // 펼친 동안 쌓이는 기록도 읽은 것이다 — 보이는 단계의 안 읽은 기록을 서버에 읽음으로 알린다.
  const seenPending = useRef(new Set<string>());
  useEffect(() => {
    for (const step of item.steps) {
      // 가장 최근 기록 id 로 거른다 — 기록 수는 상한(20)에 닿으면 더 늘지 않아, 그 뒤의 새 기록을 알리지 못한다.
      const key = `${step.id}:${step.records?.at(-1)?.id ?? ""}`;
      if (!(step.id in openRecords) || unseenRecords(step) === 0 || seenPending.current.has(key)) continue;
      seenPending.current.add(key);
      void call("/step/seen", { itemId: item.id, stepId: step.id });
    }
  }, [item, openRecords, call]);
  const toggleRecords = (step: ObjectiveStep) => setOpenRecords((current) => {
    if (step.id in current) { const { [step.id]: _closed, ...rest } = current; return rest; }
    const records = step.records ?? [];
    return { ...current, [step.id]: new Set(records.slice(0, Math.min(step.seen ?? 0, records.length)).map((record) => record.id)) };
  });
  // 짚은 단계 — 목록 행과 편성 노드가 서로를 켠다(그 단계의 선행도 함께).
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const focused = focusStep ? item.steps.find((step) => step.id === focusStep) ?? null : null;
  const numberOf = (stepId: string) => item.steps.findIndex((step) => step.id === stepId) + 1;
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 사람의 결정을 기다리는 세션 — 지휘관이 먼저, 다음은 단계 순서. 카드가 잠기지 않은 채 사람을 부르는 유일한 상태다.
  const awaiting = item.done ? null : (() => {
    if (item.slot && operationState(item.slot.operationId) === "awaiting") return { operationId: item.slot.operationId, stepIndex: null as number | null };
    const index = item.steps.findIndex((step) => step.slot && operationState(step.slot.operationId) === "awaiting");
    return index >= 0 ? { operationId: item.steps[index]!.slot!.operationId, stepIndex: index } : null;
  })();

  const saveNote = (value: string) => {
    setNote(value);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => { void call("/item/patch", { itemId: item.id, patch: { note: value } }); }, 600);
  };
  const start = async () => {
    const result = await call<{ operationId: string }>("/coordinator/start", { itemId: item.id });
    if (result) { const words = launchWords(launchRows, item.launch.model, item.launch.effort, t("objectives.coordinator.effortAuto")); toast(t("objectives.toast.started", { model: `${words.model} · ${words.effort}` })); }
  };
  const steer = async () => {
    setSteering(true);
    await call("/coordinator/steer", { itemId: item.id });
    setSteering(false);
  };
  const plan = async (context: string) => {
    setPlanning(true);
    const result = await call<{ started: boolean }>("/plan/request", { itemId: item.id, context });
    setPlanning(false);
    if (result) { setCookOpen(false); toast(t(result.started ? "objectives.toast.planStarted" : "objectives.toast.planRequested")); }
  };
  const link = async (operationId: string) => {
    if (!picker) return;
    const path = picker.stepId ? "/step/link" : "/coordinator/link";
    await call(path, { itemId: item.id, ...(picker.stepId ? { stepId: picker.stepId } : {}), operationId });
    setPicker(null);
  };
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);

  return (
    <aside ref={detailRef} className={`objectives-detail${busy ? " is-busy" : ""}`} aria-label={item.title}>
      <div className="objectives-detail-scroll">
      <div className="objectives-group">
        <div className="objectives-detail-head">
          <button type="button" className="objectives-glyph objectives-detail-back" aria-label={t("objectives.detail.backToList")} title={t("objectives.detail.backToList")} onClick={onClose}>‹</button>
          <button type="button" className={`objectives-check${item.done ? " is-on" : ""}`} aria-label={t(item.done ? "objectives.item.reopen" : "objectives.item.complete")} disabled={busy} onClick={onComplete}><CheckGlyph /></button>
          <textarea className="objectives-detail-title" aria-label={t("objectives.item.titleAria")} value={title} rows={1} readOnly={!editable} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={() => { if (title.trim() && title !== item.title) void call("/item/patch", { itemId: item.id, patch: { title: title.trim() } }); }} />
          <button type="button" className={`objectives-star${item.important ? " is-on" : ""}`} aria-label={t("objectives.item.important")} aria-pressed={item.important} onClick={() => void call("/item/patch", { itemId: item.id, patch: { important: !item.important } })}>{item.important ? "★" : "☆"}</button>
          {placeButton}
        </div>
        {busy ? <div className="objectives-busy-line" role="status"><i aria-hidden="true" /><span>{t(item.cooking ? "objectives.cooking" : "objectives.busy")}</span></div> : null}
      </div>

      <div className="objectives-group">
        <div className={`objectives-row${item.today ? " is-on" : ""}`}>
          <button type="button" className="objectives-row-main" aria-pressed={item.today} disabled={!editable} onClick={() => void call("/item/patch", { itemId: item.id, patch: { today: !item.today } })}>
            <span className="objectives-row-ic"><SunGlyph /></span>
            <span className="objectives-row-lab">{t(item.today ? "objectives.schedule.todayOn" : "objectives.schedule.addToday")}</span>
          </button>
          {item.today && editable ? <button type="button" className="objectives-row-x" aria-label={t("objectives.schedule.removeToday")} title={t("objectives.schedule.removeToday")} onClick={() => void call("/item/patch", { itemId: item.id, patch: { today: false } })}>×</button> : null}
        </div>
        <div className={`objectives-row${item.dueDate ? " is-on" : ""}${item.dueDate && item.dueDate < todayIso() && !item.done ? " is-overdue" : ""}`}>
          <button type="button" className="objectives-row-main" disabled={!editable} aria-haspopup="dialog" aria-expanded={!!dateAnchor} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setDateAnchor((value) => (value ? null : rect)); }}>
            <span className="objectives-row-ic"><CalGlyph /></span>
            <span className="objectives-row-lab">{item.dueDate ? t("objectives.schedule.dueOn", { date: dueLabel(item.dueDate, language) }) : t("objectives.schedule.setDue")}</span>
          </button>
          {dateAnchor ? <DatePicker anchor={dateAnchor} value={item.dueDate} language={language} t={t} onPick={(next) => void call("/item/patch", { itemId: item.id, patch: { dueDate: next } })} onClose={() => setDateAnchor(null)} /> : null}
          {item.dueDate && editable ? <button type="button" className="objectives-row-x" aria-label={t("objectives.schedule.clearDue")} title={t("objectives.schedule.clearDue")} onClick={() => void call("/item/patch", { itemId: item.id, patch: { dueDate: null } })}>×</button> : null}
        </div>
      </div>

      <div className="objectives-group">
        {/* 조율자 행 — 왼쪽은 「조율자 · 부제」, 오른쪽 끝은 모델·강도. 아직 조율자가 없으면 행 자체가 연결 목록을 아래로 펼치는 손잡이다. */}
        <div className={`objectives-row${item.slot ? " is-on" : ""}${picker && picker.stepId === null ? " is-expanded" : ""}`}>
          <button type="button" className="objectives-row-main" disabled={!!item.slot || !editable} aria-expanded={!item.slot ? !!picker && picker.stepId === null : undefined} onClick={() => setPicker((value) => (value && value.stepId === null ? null : { stepId: null }))}>
            <span className="objectives-row-ic"><CoordGlyph /></span>
            <span className="objectives-row-lab">
              {t("objectives.coordinator.title")}

            </span>
          </button>
          <LaunchControl t={t} model={item.slot?.model ?? item.launch.model} effort={item.slot?.effort ?? item.launch.effort} view={item.launch.view} locked={locked} onChange={(next) => void call("/item/patch", { itemId: item.id, patch: { launch: next } })} />
          {item.slot && editable ? <button type="button" className="objectives-row-x" aria-label={t("objectives.coordinator.unlink")} title={t("objectives.coordinator.unlink")} onClick={() => void call("/coordinator/unlink", { itemId: item.id })}>×</button> : null}
        </div>
        {picker && picker.stepId === null ? (
          <div className="objectives-pick" role="listbox" aria-label={t("objectives.link.pick")}>
            {freeOperations.length === 0 ? <span className="objectives-hint">{t("objectives.link.none")}</span> : null}
            {freeOperations.map((operation) => <button key={operation.id} type="button" onClick={() => void link(operation.id)}><i className={`objectives-op is-${operation.activity}`} style={{ padding: 0, border: 0 }}><i aria-hidden="true" /></i>{operation.title}</button>)}
          </div>
        ) : null}
        {/* 구상 — 누르면 그 자리에서 맥락 한 줄이 펼쳐진다. 비워 두고 Enter 해도 된다. */}
        {editable && launchAvailable ? (
          <>
            <button type="button" className={`objectives-row${cookOpen ? " is-expanded" : ""}`} title={t("objectives.steps.planHint")} disabled={planning} aria-expanded={cookOpen} onClick={() => setCookOpen((value) => !value)}>
              <span className="objectives-row-ic"><WandGlyph /></span>
              <span className="objectives-row-lab">{t(planning ? "objectives.steps.planning" : "objectives.steps.plan")}</span>
            </button>
            {cookOpen ? (
              <div className="objectives-cook-line">
                <textarea
                  className="objectives-cook"
                  aria-label={t("objectives.coordinator.cookContext")}
                  placeholder={t("objectives.coordinator.cookContext")}
                  value={cook}
                  rows={1}
                  autoFocus
                  disabled={planning}
                  ref={(element) => { if (element) { element.style.height = "0px"; element.style.height = `${element.scrollHeight}px`; } }}
                  onChange={(event) => { setCook(event.target.value); event.target.style.height = "0px"; event.target.style.height = `${event.target.scrollHeight}px`; }}
                  onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setCookOpen(false); return; } if (submitKey(event) && !event.shiftKey) { event.preventDefault(); void plan(cook); } }}
                />
                <button type="button" className="objectives-glyph objectives-cook-send" aria-label={t("objectives.coordinator.cookSend")} title={t("objectives.coordinator.cookSend")} disabled={planning} onClick={() => void plan(cook)}><SendGlyph /></button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="objectives-group">
        <div className="objectives-steps">
          {item.steps.map((step, index) => {
            const ready = stepReady(item, step);
            const records = step.records ?? [];
            const recordsOpen = step.id in openRecords;
            const unseen = unseenRecords(step);
            const recordsId = `objectives-records-${step.id}`;
            return (
              <Fragment key={step.id}>
              <div
                className={`objectives-step${step.done ? " is-done" : ""}${!step.done && ready ? " is-ready" : ""}${recordsOpen ? " is-expanded" : ""}${highlightStep === step.id ? " is-highlight" : ""}${focused?.id === step.id ? " is-focus" : focused?.after.includes(step.id) ? " is-pre" : ""}`}
                onPointerEnter={() => setFocusStep(step.id)}
                onPointerLeave={() => setFocusStep(null)}
                onFocus={() => setFocusStep(step.id)}
                onBlur={() => setFocusStep(null)}
              >
                <button type="button" className={`objectives-check${step.done ? " is-on" : ""}`} aria-label={t("objectives.steps.done")} disabled={!editable} onClick={() => void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { done: !step.done } })}><CheckGlyph /></button>
                {/* 번호는 편성 순서 — 그래프 노드와 같은 번호다. */}
                <span className="objectives-step-num" aria-hidden="true">{index + 1}</span>
                <div className="objectives-step-body">
                  <input className="objectives-step-text" aria-label={`${index + 1}`} defaultValue={step.text} readOnly={!(editable || (touchable && notStarted(step)))} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== step.text) void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { text: value } }); }} onKeyDown={(event) => { if (submitKey(event)) event.currentTarget.blur(); }} />
                  {/* 배정된 모델은 단계 이름 아래 dim 한 줄 — 풀네임 · 강도. 담당은 상태 점, 예약은 ✦. */}
                  {step.slot ? <span className={`objectives-step-sub is-${operationState(step.slot.operationId)}`} title={`${t("objectives.steps.assignee")} · ${operationTitle(step.slot.operationId)}`}><ProviderGlyph model={step.slot.model} /><span>{launchWords(launchRows, step.slot.model, step.slot.effort, t("objectives.coordinator.effortAuto")).model}</span>{step.slot.effort ? <b>{launchWords(launchRows, step.slot.model, step.slot.effort, t("objectives.coordinator.effortAuto")).effort}</b> : null}</span>
                    : step.unplaced && !step.done ? <span className="objectives-step-sub is-unplaced">{t("objectives.steps.unplaced")}</span>
                    : !step.done ? <span className="objectives-step-sub is-assign">{!step.assign || step.assign.mode === "self" ? t("objectives.assign.self") : step.assign.mode === "route" ? t("objectives.assign.route") : <><ProviderGlyph model={step.assign.model} /><span>{launchWords(launchRows, step.assign.model, step.assign.effort, t("objectives.coordinator.effortAuto")).model}</span><b>{launchWords(launchRows, step.assign.model, step.assign.effort, t("objectives.coordinator.effortAuto")).effort}</b></>}</span> : null}
                </div>
                {records.length > 0 ? (
                  <button type="button" className={`objectives-records-count${unseen > 0 ? " is-unseen" : ""}`} aria-expanded={recordsOpen} aria-controls={recordsId} aria-label={`${t("objectives.records.count", { index: index + 1, count: records.length })}${unseen > 0 ? ` · ${t("objectives.records.unseen", { count: unseen })}` : ""}`} onClick={() => toggleRecords(step)}>
                    {unseen > 0 ? <i aria-hidden="true" /> : <ThreadGlyph />}{records.length}
                  </button>
                ) : null}
                {/* 무엇을 기다리는지 번호로 말한다 — 끝나지 않은 선행만. 담당이 있으면 담당 줄이 상태를 말한다. */}
                {!step.slot && !step.done && !step.unplaced ? (ready
                  ? <span className="objectives-wait is-ready">{t("objectives.steps.ready")}</span>
                  : <span className="objectives-wait" title={t("objectives.steps.waiting")}>{t("objectives.steps.after", { steps: step.after.filter((id) => !item.steps.find((candidate) => candidate.id === id)?.done).map(numberOf).filter((n) => n > 0).join("·") })}</span>) : null}
                <span className="objectives-step-tools">
                  {!step.done && !step.slot && editable ? <AssignControl t={t} assign={step.assign ?? null} onChange={(assign) => void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { assign } })} label={t("objectives.steps.assign")} /> : null}
                  {step.slot && editable ? <button type="button" className="objectives-glyph" title={t("objectives.steps.unlink")} aria-label={t("objectives.steps.unlink")} onClick={() => void call("/step/unlink", { itemId: item.id, stepId: step.id })}>×</button> : null}
                  {notStarted(step) && touchable ? <button type="button" className="objectives-glyph" title={t("objectives.steps.remove")} aria-label={t("objectives.steps.remove")} onClick={() => void call("/step/remove", { itemId: item.id, stepId: step.id })}><TrashGlyph /></button> : null}
                </span>
              </div>
              {records.length > 0 ? <StepRecords id={recordsId} records={records} seenAtOpen={openRecords[step.id] ?? EMPTY_IDS} open={recordsOpen} t={t} language={language} /> : null}
              </Fragment>
            );
          })}
        </div>
        {touchable ? (
          <div className="objectives-row objectives-step-add">
            <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
            <input aria-label={t("objectives.steps.add")} placeholder={t("objectives.steps.add")} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; void call("/step/add", { itemId: item.id, step: { text: target.value.trim() } }).then(() => { target.value = ""; }); } }} />
            {editable && item.steps.some((step) => !step.done && !step.slot) ? (
              <AssignControl t={t} assign={null} all label={t("objectives.steps.assignAll")} onChange={async (assign) => { for (const step of item.steps) if (!step.done && !step.slot) await call("/step/patch", { itemId: item.id, stepId: step.id, patch: { assign } }); }} />
            ) : null}
          </div>
        ) : null}
        {item.steps.length > 0 ? (
          <>
            <div className="objectives-row is-static">
              <span className="objectives-row-ic"><GraphGlyph /></span>
              <span className="objectives-row-lab">{t("objectives.graph.title")}</span>
              <span className="objectives-row-tools">
                {item.steps.length > 1 && editable ? <>
                  <button type="button" className="objectives-btn is-small" onClick={async () => { if (await call("/edge/linear", { itemId: item.id })) toast(t("objectives.toast.linear")); }}>{t("objectives.graph.linear")}</button>
                  <button type="button" className="objectives-btn is-small" onClick={async () => { if (await call("/edge/clear", { itemId: item.id })) toast(t("objectives.toast.parallel")); }}>{t("objectives.graph.parallel")}</button>
                </> : null}
                <button ref={zoomTriggerRef} type="button" className="objectives-glyph" aria-haspopup="dialog" aria-expanded={zoomOpen} aria-label={t("objectives.graph.zoom")} title={t("objectives.graph.zoom")} onClick={() => setZoomOpen(true)}><ZoomGlyph /></button>
              </span>
            </div>
            <div className="objectives-graph-wrap">
              <div className="objectives-graph-horizontal"><CoordinationGraph item={item} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("objectives.graph.cycle"))} operationTitle={operationTitle} onZoom={() => setZoomOpen(true)} canEdit={canEditStep} focusStepId={focusStep} onFocusStep={setFocusStep} /></div>
              <div className="objectives-graph-vertical"><CoordinationGraph vertical item={item} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("objectives.graph.cycle"))} operationTitle={operationTitle} onZoom={() => setZoomOpen(true)} canEdit={canEditStep} focusStepId={focusStep} onFocusStep={setFocusStep} /></div>
            </div>
            {zoomOpen ? createPortal(
              <LineupZoom t={t} title={item.title} onClose={() => { setZoomOpen(false); zoomTriggerRef.current?.focus(); }}>
                <CoordinationGraph zoom item={item} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("objectives.graph.cycle"))} operationTitle={operationTitle} canEdit={canEditStep} focusStepId={focusStep} onFocusStep={setFocusStep} />
              </LineupZoom>,
              document.body,
            ) : null}
          </>
        ) : null}
      </div>

      {/* 달성 기준 — 임무 아래의 새 섹션. 사람이 쓰고(비어 있으면 구상 때 지휘관이 제안), 마지막 임무 뒤 지휘관이 기준마다 스스로 다시 따진다.
          충족·근거는 받아들여진 달성 보고에만 있다 — 검토 대기 동안만 「충족」과 근거 한 줄이 보이고, 새 작업이 검토를 거두면 「미확인」으로 돌아간다. */}
      <div className="objectives-group objectives-criteria-group">
        <div className="objectives-row is-static">
          <span className="objectives-row-ic"><CriteriaGlyph /></span>
          <span className="objectives-row-lab">{t("objectives.criteria.title")}</span>
          {(item.criteria?.length ?? 0) > 0 ? <span className="objectives-row-tools"><span className="objectives-criteria-count">{t("objectives.criteria.count", { met: (item.review?.criteria ?? []).length, total: item.criteria!.length })}</span></span> : null}
        </div>
        {(item.criteria ?? []).map((criterion, index) => {
          const evidence = item.review?.criteria?.find((entry) => entry.id === criterion.id)?.evidence;
          return (
            <div key={criterion.id} className={`objectives-criterion${evidence ? " is-met" : ""}`}>
              <span className="objectives-criterion-mark" aria-hidden="true" />
              <div className="objectives-criterion-body">
                <input className="objectives-criterion-text" aria-label={t("objectives.criteria.itemAria", { n: index + 1 })} defaultValue={criterion.text} readOnly={!touchable} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== criterion.text) void call("/criterion/patch", { itemId: item.id, criterionId: criterion.id, patch: { text: value } }); else event.target.value = criterion.text; }} />
                {evidence ? <span className="objectives-criterion-sub is-evidence">{t("objectives.criteria.evidence", { evidence })}</span>
                  : criterion.by === "commander" ? <span className="objectives-criterion-sub">{t("objectives.criteria.proposed")}</span> : null}
              </div>
              <span className={`objectives-criterion-state${evidence ? " is-met" : ""}`}>{t(evidence ? "objectives.criteria.met" : "objectives.criteria.unchecked")}</span>
              {touchable ? <button type="button" className="objectives-glyph objectives-criterion-remove" title={t("objectives.criteria.remove")} aria-label={t("objectives.criteria.remove")} onClick={() => void call("/criterion/remove", { itemId: item.id, criterionId: criterion.id })}><TrashGlyph /></button> : null}
            </div>
          );
        })}
        {touchable ? (
          <div className="objectives-row objectives-step-add">
            <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
            <input aria-label={t("objectives.criteria.add")} placeholder={t("objectives.criteria.add")} maxLength={300} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; const text = target.value.trim(); target.value = ""; void call("/criterion/add", { itemId: item.id, criterion: { text } }); } }} />
          </div>
        ) : null}
      </div>

      {/* 메모 — 본문 아래 첨부 띠. 메모에 이미지를 붙여넣거나 메모 구획에 끌어오면 띠에 들어간다. */}
      <div
        className={`objectives-group objectives-note-group${dropping ? " is-drop" : ""}`}
        onDragOver={(event) => { if (touchable && [...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDropping(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(event) => { if (!touchable) return; event.preventDefault(); setDropping(false); const files = imageFiles(event.dataTransfer.files); if (files.length) void attachments.upload(files); }}
      >
        <textarea className="objectives-note" aria-label={t("objectives.item.memo")} placeholder={t("objectives.item.memoPlaceholder")} value={note} readOnly={!touchable} onChange={(event) => saveNote(event.target.value)}
          onPaste={(event) => { if (!touchable) return; const files = imageFiles(event.clipboardData.files); if (files.length) { event.preventDefault(); void attachments.upload(files); } }} />
        <NoteAttachments item={item} t={t} touchable={touchable} upload={attachments.upload} error={attachments.error} sending={attachments.sending} onRemove={(attachment) => void call("/attachment/remove", { itemId: item.id, attachmentId: attachment.id })} />
      </div>

      </div>
      <div className="objectives-detail-bottom">
      {/* 마지막 행동 한 자리 — 검토 대기면 「완료」, 누군가 사람의 결정을 기다리면 「결정 대기」(누르면 그 Operation으로),
          아니면 「시작」, 일하는 동안에는 「중단」 — 일하는 동안이나 검토 대기 중에 사람이 보드를 고쳤으면 그 자리가 「스티어링」이 된다.
          같은 띠, 낱말만 다르다. 검토 대기의 「완료」는 목록 카드 고리에 남는다. */}
      {steerPending ? (
        <div className="objectives-group objectives-start-group">
          <button type="button" className="objectives-start is-steer" title={t("objectives.steer.hint")} disabled={steering} onClick={() => void steer()}>
            <span className="objectives-start-word">{t("objectives.steer")}</span>
            <span className="objectives-start-sub" />
            <span className="objectives-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : item.review && !item.done ? (
        <div className="objectives-group objectives-start-group">
          <button type="button" className="objectives-start is-review" title={item.review.summary} onClick={onComplete}>
            <span className="objectives-start-word">{t("objectives.review.complete")}</span>
            <span className="objectives-start-sub">{t((item.review?.criteria?.length ?? 0) > 0 ? "objectives.review.subCriteria" : "objectives.review.sub")}</span>
            <span className="objectives-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : awaiting && !busy ? (
        <div className="objectives-group objectives-start-group">
          <button type="button" className="objectives-start is-awaiting" title={operationTitle(awaiting.operationId)} onClick={() => focusOperation(awaiting.operationId)}>
            <span className="objectives-start-word"><i className="objectives-start-dot" aria-hidden="true" />{t("objectives.awaiting.word")}</span>
            <span className="objectives-start-sub">{awaiting.stepIndex === null ? t("objectives.awaiting.commander") : t("objectives.awaiting.step", { index: awaiting.stepIndex + 1 })}</span>
            <span className="objectives-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : editable && !busy ? (
        <div className="objectives-group objectives-start-group">
          <button type="button" className="objectives-start" disabled={!launchAvailable} title={launchAvailable ? undefined : t("objectives.coordinator.unavailable")} onClick={() => void start()}>
            <span className="objectives-start-word">{t("objectives.coordinator.start")}</span>
            <span className="objectives-start-sub">{item.slot ? `${stateLabel(operationState(item.slot.operationId))} · ${t("objectives.start.resume")}` : (() => { const open = item.steps.filter((step) => !step.done && !step.slot); const workers = open.filter((step) => step.assign && step.assign.mode !== "self").length; return open.length <= 1 || workers === 0 ? t("objectives.start.direct") : t("objectives.start.workers", { count: workers }); })()}</span>
            <span className="objectives-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : busy ? (
        <div className="objectives-group objectives-start-group">
          <button type="button" className="objectives-start is-stop" title={t("objectives.stopHint")} onClick={() => void onStop()}>
            <span className="objectives-start-word"><StopGlyph />{t("objectives.stop")}</span>
            <span className="objectives-start-sub">{t("objectives.stopHint")}</span>
          </button>
        </div>
      ) : null}
      <div className="objectives-detail-foot">
        <button type="button" className="objectives-glyph" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><ChevronGlyph /></button>
        <span className="objectives-detail-created">{t("objectives.detail.created", { date: createdLabel(item.createdAt, language) })}</span>
        {busy ? <span aria-hidden="true" className="objectives-detail-foot-spacer" /> : <button type="button" className="objectives-glyph is-danger is-large" aria-label={t("objectives.item.delete")} title={t("objectives.item.delete")} onClick={async () => { const removed = await call<{ item: ObjectiveItem }>("/item/remove", { itemId: item.id }); if (removed) toast(t("objectives.toast.deleted")); }}><TrashGlyph /></button>}
      </div>
      </div>
    </aside>
  );
}
