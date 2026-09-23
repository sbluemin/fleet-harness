import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { coordinatorMode, stepReady, unseenRecords, type CoordinatorMode, type StepAssign, type StepRecord, type TodoItem, type TodoStep } from "../server/types.js";
import { NoteAttachments, imageFiles, useAttachmentUpload } from "./attachments.js";
import { CoordinationGraph } from "./graph.js";
import { DatePicker } from "./date-picker.js";
import { getT, type TodoMessageKey } from "./i18n/index.js";
import { LaunchControl, ProviderGlyph, launchWords, loadLaunchRows, useLaunchRows } from "./launch-control.js";
import { dockTodo, expandTodo, focusOperation, loadTheater, patchTodoView, post, takeReveal, useOperationSummaries, useReveal, useTodoTheater, useTodoView, type TodoGroup } from "./todo-state.js";

export interface TodoContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language?: ConsoleLocale;
  readonly place: "rail" | "expanded";
}

type ListId = "today" | "due" | "all" | "agent" | "ungrouped" | `group:${string}`;
type DueFilter = "all" | "overdue" | "today" | "week" | "later";
/** 끌어서 순서 바꾸기의 놓을 자리 — 이웃 카드의 앞 또는 뒤. */
type Insert = { readonly anchorId: string; readonly place: "before" | "after" };
type T = Translate<TodoMessageKey>;

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
const ThreadGlyph = () => <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" aria-hidden="true"><path d="M2 3h8M2 6h8M2 9h5" /></svg>;

/**
 * 단계 기록 — 쿠킹 입력 줄과 같은 문법이다: 상자·배경 없이 단계 글자와 같은 선에서 펼쳐지고, 한 건은 흐린 모노 한 줄(시각·종류)
 * 아래 결론과 나머지 줄. 오래된 것부터 읽는다. 「새 기록」은 펼친 순간의 읽은 수로 가른다(펼치면 읽음이 되어도 표시는 남는다).
 */
function StepRecords({ id, records, seenAtOpen, open, t, language }: { id: string; records: readonly StepRecord[]; seenAtOpen: number; open: boolean; t: Translate<TodoMessageKey>; language: "en" | "ko" }) {
  return (
    <div id={id} className={`todo-records${open ? " is-open" : ""}`} hidden={!open}>
      <div className="todo-records-inner">
        {records.map((record, index) => (
          <div key={record.id} className="todo-record">
            <div className="todo-record-meta">
              <span>{recordTime(record.at, language, t("todo.records.earlier"))}</span>
              <span aria-hidden="true">·</span>
              <span className={record.kind === "redone" ? "is-redone" : undefined}>{t(record.kind === "redone" ? "todo.records.redone" : "todo.records.done")}</span>
              {index >= seenAtOpen ? <span className="is-new">· {t("todo.records.new")}</span> : null}
            </div>
            {record.lines.map((line, at) => <div key={at} className={at === 0 ? "todo-record-head" : "todo-record-line"}>{line}</div>)}
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

export function TodoPanel({ ctx }: { readonly ctx: TodoContext }) {
  const t = getT(ctx.language);
  const language = ctx.language === "ko" ? "ko" : "en";
  const theaterId = ctx.theaterId;
  const state = useTodoTheater(theaterId);
  const operations = useOperationSummaries();
  const reveal = useReveal();
  // 보기 상태(목록 · 펼친 항목 · 구획 접힘 · 기한 필터)는 Theater 별 모듈 스토어에 산다 — 표면을 닫았다 열어도 보던 자리 그대로.
  const view = useTodoView(theaterId);
  const list = view.list as ListId;
  const selected = view.selected;
  const collapsed = view.collapsed;
  const dueFilter = view.dueFilter as DueFilter;
  const setList = useCallback((next: ListId) => patchTodoView(theaterId, () => ({ list: next })), [theaterId]);
  const setSelected = useCallback((next: string | null | ((value: string | null) => string | null)) => patchTodoView(theaterId, (current) => ({ selected: typeof next === "function" ? next(current.selected) : next })), [theaterId]);
  const setDueFilter = (next: DueFilter) => patchTodoView(theaterId, () => ({ dueFilter: next }));
  // 구획 접기 — 그룹 구획은 펼침이 기본, 맨 아래 「완료됨」은 접힘이 기본.
  const toggleSection = (key: string, defaultOpen: boolean) => patchTodoView(theaterId, (current) => ({ collapsed: { ...current.collapsed, [key]: key in current.collapsed ? !current.collapsed[key] : defaultOpen } }));
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
  const placeButton = (className: string) => <button type="button" className={`todo-place-button ${className}`} aria-label={t(ctx.place === "rail" ? "todo.panel.expand" : "todo.panel.dock")} title={t(ctx.place === "rail" ? "todo.panel.expand" : "todo.panel.dock")} onClick={ctx.place === "rail" ? expandTodo : dockTodo}>
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
    toast(code === "item_busy" ? t("todo.toast.busy") : t("todo.toast.failed", { code }));
  }, [t, toast]);
  const call = useCallback(async <R,>(path: string, body: Record<string, unknown>): Promise<R | null> => {
    try { return await post<R>(ctx.api, path, { ...body, language }); } catch (error) { fail(error); return null; }
  }, [ctx.api, fail, language]);

  const operationOf = useCallback((operationId: string) => operations.find((candidate) => candidate.id === operationId) ?? null, [operations]);
  const operationTitle = useCallback((operationId: string) => operationOf(operationId)?.title ?? "—", [operationOf]);
  const operationState = useCallback((operationId: string): string => operationOf(operationId)?.activity ?? "closed", [operationOf]);
  // 항목의 활동 = 셰프와 담당 가운데 가장 급한 것 — 호스트가 캔버스에서 셰프를 그리는 셈법과 같다.
  const URGENCY: Record<string, number> = { awaiting: 0, running: 1, background: 2, idle: 3, ended: 4, unknown: 5 };
  const itemActivity = useCallback((item: TodoItem) => {
    const ids = [item.slot?.operationId, ...item.steps.map((step) => step.slot?.operationId)].filter((id): id is string => !!id);
    return ids.map((id) => operationState(id)).filter((state) => state !== "closed").reduce((top, state) => ((URGENCY[state] ?? 9) < (URGENCY[top] ?? 9) ? state : top), "unknown" as ReturnType<typeof operationState>);
  }, [operationState]);
  // 조율자가 일하는 동안 카드는 잠긴다 — 편집 대신 「중단」 하나만 남는다(서버도 같은 기준으로 거절한다).
  // 담당의 활동은 잠그지 않고, 조율자가 사람을 기다리는(awaiting) 동안도 잠그지 않는다 — 그때는 사람이 손을 대야 한다.
  const isBusy = useCallback((item: TodoItem): boolean => !item.done && !!item.slot && WORKING.has(operationState(item.slot.operationId)), [operationState]);
  const stopItem = async (item: TodoItem) => {
    const result = await call<{ interrupted: number }>("/coordinator/stop", { itemId: item.id });
    if (result) toast(t("todo.toast.stopped", { count: result.interrupted }));
  };
  const modeLabel = (mode: CoordinatorMode) => t(mode === "direct" ? "todo.mode.direct" : mode === "coordinate" ? "todo.mode.coordinate" : "todo.mode.mixed");
  const stateLabel = (state: string) => t((["running", "awaiting", "idle", "background", "ended", "closed"].includes(state) ? `todo.state.${state}` : "todo.state.unknown") as Parameters<typeof t>[0]);

  const groupOf = (groupId: string | null): TodoGroup | null => (groupId ? state.groups.find((group) => group.id === groupId) ?? null : null);
  const inList = useCallback((item: TodoItem): boolean => {
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
    type Section = { key: string; label: string | null; swatch: string | null; items: TodoItem[]; done?: boolean };
    const out: Section[] = [];
    if (!sectioned) out.push({ key: "flat", label: null, swatch: null, items: open });
    else {
      for (const group of state.groups) {
        const items = open.filter((item) => item.groupId === group.id);
        if (items.length) out.push({ key: group.id, label: group.name, swatch: group.color, items });
      }
      const rest = open.filter((item) => !groupOf(item.groupId));
      if (rest.length) out.push({ key: "ungrouped", label: t("todo.list.ungrouped"), swatch: null, items: rest });
    }
    // 완료된 항목은 목록 맨 아래 「완료됨」 한 구획 — 펼쳐야 보인다.
    if (finished.length) out.push({ key: "done", label: t("todo.items.done"), swatch: null, items: finished, done: true });
    return out;
  }, [sectioned, open, finished, state.groups, t]);
  const openCount = (predicate: (item: TodoItem) => boolean) => state.items.filter((item) => !item.done && predicate(item)).length;
  const current = selected ? state.items.find((item) => item.id === selected) ?? null : null;
  const detailRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      if (mainRef.current && getComputedStyle(mainRef.current).display === "none") detailRef.current?.querySelector<HTMLElement>(".todo-detail-back")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  const closeDetail = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => { if (id) itemsRef.current?.querySelector<HTMLElement>(`.todo-item[data-item-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); });
  };

  const listTitle = list === "today" ? t("todo.list.today") : list === "due" ? t("todo.list.due") : list === "all" ? t("todo.list.all") : list === "agent" ? t("todo.list.agent") : list === "ungrouped" ? t("todo.list.ungrouped") : groupOf(list.slice(6))?.name ?? t("todo.list.all");
  const listSub = list === "today" ? t("todo.sub.today") : list === "due" ? t("todo.sub.due") : list === "all" ? t("todo.sub.all") : list === "agent" ? t("todo.sub.agent") : list === "ungrouped" ? t("todo.sub.ungrouped") : t("todo.sub.group");

  // ── 행동 ──
  const completeItem = async (item: TodoItem) => {
    if (item.done) { await call("/item/complete", { itemId: item.id, undone: true }); toast(t("todo.toast.reopened")); return; }
    const slots = (item.slot ? 1 : 0) + item.steps.filter((step) => step.slot).length;
    const result = await call("/item/complete", { itemId: item.id });
    if (result) toast(t("todo.toast.completed", { count: slots }), async () => { await call("/item/complete", { itemId: item.id, undone: true }); });
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
  const toggleEdge = async (item: TodoItem, from: string, to: string) => {
    const result = await call<{ item: TodoItem; linked: boolean }>("/edge/toggle", { itemId: item.id, from, to });
    if (!result) return;
    const index = (id: string) => item.steps.findIndex((step) => step.id === id) + 1;
    toast(t(result.linked ? "todo.toast.linkedEdge" : "todo.toast.cutEdge", { from: index(from), to: index(to) }));
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
  const reorder = async (item: TodoItem, insert: Insert) => {
    await call("/item/move", { itemId: item.id, ...(insert.place === "before" ? { beforeId: insert.anchorId } : { afterId: insert.anchorId }) });
  };
  const dropTargetAt = (x: number, y: number): ListId | null => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-list]");
    return (hit?.dataset.dropList as ListId | undefined) ?? null;
  };
  const moveTo = async (item: TodoItem, target: ListId) => {
    const patch: Record<string, unknown> = target === "today" ? { today: true }
      : target === "due" ? { dueDate: item.dueDate ?? todayIso() }
      : target === "ungrouped" ? { groupId: null }
      : target.startsWith("group:") ? { groupId: target.slice(6) } : {};
    if (Object.keys(patch).length === 0) return;
    const result = await call("/item/patch", { itemId: item.id, patch });
    if (!result) return;
    const name = target === "today" ? t("todo.list.today") : target === "due" ? t("todo.list.due") : target === "ungrouped" ? t("todo.list.ungrouped") : groupOf(target.slice(6))?.name ?? "";
    toast(t("todo.toast.moved", { list: name }));
  };
  const onItemPointerDown = (event: ReactPointerEvent<HTMLDivElement>, item: TodoItem, sectionKey: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, a")) return;
    // 셰프가 일하는 동안에도 순서는 바꿀 수 있다(내용이 아니다). 목록 옮기기는 편집이라 그때는 잠긴다.
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
      const compact = !!document.elementFromPoint(move.clientX, move.clientY)?.closest(".todo-lists");
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

  const onItemKey = (event: ReactKeyboardEvent<HTMLDivElement>, item: TodoItem, index: number, sectionKey: string) => {
    const rows = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".todo-item") ?? [])];
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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && selected && !listMenuOpen && !document.querySelector(".todo-cal, .todo-zoom-backdrop, .todo-menu")) closeDetail(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, listMenuOpen]);

  if (!theaterId) return <div className="todo-container"><div className="todo-root"><div className="todo-main"><div className="todo-empty">{t("todo.items.emptyTheater")}</div></div></div></div>;

  const pickList = (next: ListId) => { setList(next); setListMenuOpen(false); listTriggerRef.current?.focus(); };
  return (
    <div className="todo-container"><div className={`todo-root${current ? " has-detail" : ""}`}>
      <nav className={`todo-lists${drag ? " is-dragging" : ""}`} aria-label={t("todo.panel.title")}>
        <ListButton id="today" current={list} onPick={setList} drop over={drag?.over === "today"} label={`☀ ${t("todo.list.today")}`} count={openCount((item) => item.today)} />
        <ListButton id="due" current={list} onPick={setList} drop over={drag?.over === "due"} label={t("todo.list.due")} count={openCount((item) => !!item.dueDate)} />
        <ListButton id="all" current={list} onPick={setList} label={`∞ ${t("todo.list.all")}`} count={openCount(() => true)} />
        <ListButton id="agent" current={list} onPick={setList} label={`◌ ${t("todo.list.agent")}`} count={openCount((item) => item.author.kind === "operation")} />
        <div className="todo-lists-hd" title={t("todo.list.groupsHint")}>{t("todo.list.groups")}</div>
        {state.groups.map((group) => (
          <ListButton key={group.id} id={`group:${group.id}`} current={list} onPick={setList} drop over={drag?.over === `group:${group.id}`} label={group.name} swatch={group.color} count={openCount((item) => item.groupId === group.id)} />
        ))}
        <ListButton id="ungrouped" current={list} onPick={setList} drop over={drag?.over === "ungrouped"} label={t("todo.list.ungrouped")} muted count={openCount((item) => !groupOf(item.groupId))} />
        <button type="button" className="todo-lists-add" onClick={async () => { const result = await call<{ group: TodoGroup }>("/group/create", { theaterId, name: t("todo.list.newGroupName"), color: "teal" }); if (result) { setList(`group:${result.group.id}`); toast(t("todo.toast.groupCreated")); } }}>+ {t("todo.list.newGroup")}</button>
      </nav>

      <section ref={mainRef} className="todo-main">
        <div className="todo-title">
          <div ref={listMenuRef} className="todo-list-select">
            <button ref={listTriggerRef} type="button" className="todo-list-trigger" aria-label={t("todo.list.select")} aria-haspopup="menu" aria-expanded={listMenuOpen} onClick={() => setListMenuOpen((value) => !value)}><span>{listTitle}</span><span className="todo-count">{open.length}</span><span aria-hidden="true">⌄</span></button>
            {listMenuOpen ? <div className="todo-list-menu" role="menu" aria-label={t("todo.list.select")}>
              {(["today", "due", "all", "agent"] as const).map((id) => <ListButton key={id} id={id} current={list} onPick={pickList} label={t(`todo.list.${id}`)} count={openCount((item) => id === "today" ? item.today : id === "due" ? !!item.dueDate : id === "agent" ? item.author.kind === "operation" : true)} menu />)}
              <div className="todo-lists-hd">{t("todo.list.groups")}</div>
              {state.groups.map((group) => <ListButton key={group.id} id={`group:${group.id}`} current={list} onPick={pickList} label={group.name} swatch={group.color} count={openCount((item) => item.groupId === group.id)} menu />)}
              <ListButton id="ungrouped" current={list} onPick={pickList} label={t("todo.list.ungrouped")} count={openCount((item) => !groupOf(item.groupId))} menu />
              <button type="button" className="todo-lists-add" role="menuitem" onClick={async () => { const result = await call<{ group: TodoGroup }>("/group/create", { theaterId, name: t("todo.list.newGroupName"), color: "teal" }); if (result) { pickList(`group:${result.group.id}`); toast(t("todo.toast.groupCreated")); } }}>+ {t("todo.list.newGroup")}</button>
            </div> : null}
          </div>
          <h2>{listTitle}</h2>
          <span className="todo-sub">{listSub}</span>
          {placeButton("todo-place-main")}
        </div>
        {list === "due" ? (
          <div className="todo-chips">
            {(["all", "overdue", "today", "week", "later"] as const).map((bucket) => (
              <button key={bucket} type="button" className="todo-chip" aria-pressed={dueFilter === bucket} onClick={() => setDueFilter(bucket)}>{t(bucket === "all" ? "todo.due.all" : bucket === "overdue" ? "todo.due.overdue" : bucket === "today" ? "todo.due.today" : bucket === "week" ? "todo.due.week" : "todo.due.later")}</button>
            ))}
          </div>
        ) : null}
        <div ref={itemsRef} className="todo-items" role="listbox" aria-label={listTitle}>
          {open.length === 0 && finished.length === 0 ? <div className="todo-empty">{t("todo.items.empty")}</div> : null}
          {sections.map((section) => { const expanded = isOpen(section.key, !section.done); return (<div key={section.key} data-section={section.key} className={`todo-section${section.done ? " is-done" : ""}${expanded ? "" : " is-collapsed"}`}>
          {section.label ? <button type="button" className="todo-section-hd" aria-expanded={expanded} onClick={() => toggleSection(section.key, !section.done)}><span className="todo-section-chev" aria-hidden="true"><ChevronGlyph /></span>{section.swatch ? <span className="todo-swatch" style={{ background: `var(--id-${section.swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}<span>{section.label}</span><span className="todo-count">{section.items.length}</span></button> : null}
          {expanded ? section.items.map((item) => {
            const index = visible.indexOf(item);
            const mode = coordinatorMode(item);
            const showGroup = false as false | TodoGroup | null;
            const busy = isBusy(item);
            return (
              <div key={item.id} data-item-id={item.id} className={`todo-item${item.done ? " is-done" : ""}${busy ? " is-busy" : ""}${drag?.itemId === item.id ? " is-lifted" : ""}${drag?.insert?.anchorId === item.id ? ` is-insert-${drag.insert.place}` : ""}`} role="option" aria-selected={selected === item.id} tabIndex={0}
                onPointerDown={(event) => onItemPointerDown(event, item, section.key)}
                onClick={() => { if (suppressClick.current) return; setSelected((value) => (value === item.id ? null : item.id)); }} onKeyDown={(event) => onItemKey(event, item, index, section.key)}>
                {/* 동그라미 = 완료 버튼이자 상태. 셰프가 연결돼 있으면 묶음에서 가장 급한 활동을 고리로 보이고, 일하는 동안은 누르지 못한다. 완료는 늘 사람의 몫이다. */}
                {/* 검토 대기 — 셰프가 다 했다고 넘긴 상태. 고리는 사람의 완료 버튼이 된다. */}
                {item.review && !item.done
                  ? <span className="todo-check-tip"><button type="button" className="todo-check is-linked is-review" aria-label={t("todo.review.tip")} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><i aria-hidden="true" /></button><span className="todo-check-bubble" aria-hidden="true">{t("todo.review.tip")}</span></span>
                  : item.slot && !item.done && operationState(item.slot.operationId) !== "closed"
                  ? (() => { const state = itemActivity(item); return (
                    <span className="todo-check-tip">
                      <button type="button" className={`todo-check is-linked is-${state}`} aria-label={t(busy ? "todo.item.linkedBusyTip" : "todo.item.linkedTip", { state: stateLabel(state) })} disabled={busy} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><i aria-hidden="true" /></button>
                      <span className="todo-check-bubble" aria-hidden="true">{t(busy ? "todo.item.linkedBusyTip" : "todo.item.linkedTip", { state: stateLabel(state) })}</span>
                    </span>
                  ); })()
                  : <button type="button" className={`todo-check${item.done ? " is-on" : ""}`} aria-label={t(item.done ? "todo.item.reopen" : "todo.item.complete")} disabled={busy} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><CheckGlyph /></button>}
                <div>
                  <div className="todo-item-title">{item.title}</div>
                  <div className="todo-item-meta">
                    {item.steps.length ? <span>✓ {item.steps.filter((step) => step.done).length}/{item.steps.length}</span> : null}
                    {item.dueDate ? <span className={`todo-item-due${item.dueDate < todayIso() && !item.done ? " is-overdue" : ""}`}><CalGlyph />{dueLabel(item.dueDate, language)}</span> : null}
                    {showGroup ? <span>{showGroup.name}</span> : null}
                    {item.author.kind === "operation" ? <span className="todo-by">{t("todo.item.addedBy", { name: item.author.title ?? "" })}</span> : null}
                  </div>
                </div>
                <div className="todo-item-side">
                  <LaunchWords item={item} rows={launchRows} autoLabel={t("todo.coordinator.effortAuto")} defaultLabel={t("todo.launch.default")} state={item.slot ? operationState(item.slot.operationId) : null} />
                  {item.slot && operationState(item.slot.operationId) !== "closed" ? <button type="button" className="todo-glyph todo-goto" aria-label={t("todo.item.goToOperation")} title={t("todo.item.goToOperation")} onClick={(event) => { event.stopPropagation(); focusOperation(item.slot!.operationId); }}><GoGlyph /></button> : null}
                  <button type="button" className={`todo-star${item.important ? " is-on" : ""}`} aria-label={t("todo.item.important")} aria-pressed={item.important} onClick={(event) => { event.stopPropagation(); void call("/item/patch", { itemId: item.id, patch: { important: !item.important } }); }}>{item.important ? "★" : "☆"}</button>
                </div>
              </div>
            );
          }) : null}
          </div>); })}
        </div>
        <div className="todo-add">
          <span className="todo-plus" aria-hidden="true">+</span>
          <input aria-label={t("todo.items.add")} placeholder={t("todo.items.add")} onKeyDown={(event) => { if (submitKey(event)) { const target = event.currentTarget; void addItem(target.value).then(() => { target.value = ""; }); } }} />
        </div>
        {banner ? (
          <div className="todo-banner" role="status">
            <span>{banner.text}</span>
            {banner.undo ? <button type="button" className="todo-btn todo-banner-undo" onClick={() => { void banner.undo?.(); setBanner(null); }}>{t("todo.undo")}</button> : null}
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
          placeButton={placeButton("todo-place-detail")}
          onComplete={() => completeItem(current)}
          onToggleEdge={(from, to) => toggleEdge(current, from, to)}
          freeOperations={operations.filter((operation) => operation.theaterId === theaterId && operation.activity !== "ended")}
        />
      ) : null}
      {/* 유령은 body 포털 — 확대 표면은 transform 조상이라 fixed 가 그 안에서 어긋난다. */}
      {drag && dragItem ? createPortal(
        // 순서를 바꿀 자리가 잡히면 유령은 표로 줄어 커서 오른쪽 아래로 비킨다 — 카드 크기로 커서에 붙어 있으면 바로 그 틈의 삽입선을 덮는다.
        <div className={`todo-drag-ghost${drag.over || drag.insert ? " is-over" : ""}${drag.compact || drag.insert ? " is-compact" : ""}`} style={drag.compact ? { left: drag.x - 18, top: drag.y - 16, width: 224 } : drag.insert ? { left: drag.x + 14, top: drag.y + 12, width: 224 } : { left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.width }} aria-hidden="true">
          <span className={`todo-check${dragItem.done ? " is-on" : ""}`}><CheckGlyph /></span>
          <span className="todo-drag-title">{dragItem.title}</span>
          <span className="todo-drag-hint">{drag.over ? "↓" : drag.insert ? "↕" : t("todo.drag.hint")}</span>
        </div>,
        document.body,
      ) : null}
    </div></div>
  );
}

function ListButton({ id, current, onPick, label, count, swatch, muted, drop, over, menu }: { id: ListId; current: ListId; onPick: (id: ListId) => void; label: string; count: number; swatch?: string; muted?: boolean; drop?: boolean; over?: boolean; menu?: boolean }) {
  return (
    <button type="button" className={`todo-list-btn${muted ? " is-muted" : ""}${over ? " is-drop" : ""}`} role={menu ? "menuitemradio" : undefined} aria-checked={menu ? current === id : undefined} aria-current={current === id} onClick={() => onPick(id)} {...(drop ? { "data-drop-list": id } : {})}>
      {swatch ? <span className="todo-swatch" style={{ background: `var(--id-${swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}
      <span>{label}</span>
      <span className="todo-count">{count}</span>
    </button>
  );
}

/** 카드 오른쪽의 조율자 모델·강도 — 시작 뒤엔 슬롯의 값, 전엔 예약값. 살아 있으면 점이 켜진다. */
function LaunchWords({ item, rows, autoLabel, defaultLabel, state }: { item: TodoItem; rows: ReturnType<typeof useLaunchRows>; autoLabel: string; defaultLabel: string; state: string | null }) {
  // 슬롯이 찼는데 모델이 비어 있으면 Console 기본값으로 뜬 것이다 — 예약값을 되비치면 거짓이 된다.
  const words = item.slot && !item.slot.model
    ? { model: defaultLabel, effort: item.slot.effort?.toUpperCase() ?? autoLabel }
    : launchWords(rows, item.slot?.model ?? item.launch.model, item.slot?.effort ?? item.launch.effort, autoLabel);
  return (
    <span className={`todo-item-launch${state ? ` is-${state}` : ""}`} title={`${words.model} · ${words.effort}`}>
      <span>{words.model}</span>
      <b>{words.effort}</b>
    </span>
  );
}

function OpChip({ state, label, title, onRemove, removeLabel }: { state: string; label: string; title?: string; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className={`todo-op is-${state}`} title={title ?? label}>
      <i aria-hidden="true" />
      {label}
      {onRemove ? <button type="button" className="todo-x" aria-label={removeLabel} onClick={(event) => { event.stopPropagation(); onRemove(); }}>×</button> : null}
    </span>
  );
}

interface DetailProps {
  readonly item: TodoItem;
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
 * 세부 — 입력 폼이 아니라 행의 목록이다. 일정 → 셰프 → 쿠킹 → 단계 → 레시피 → 메모, 맨 아래 시작/중단/완료 띠와 닫기·삭제.
 * 값이 있는 행은 그 값을 말하고 × 로 지우며, 없는 행은 동사("기한 설정")로 선다. 테두리 친 입력은 없다 — 제목·단계·메모 모두 글 위에 바로 쓴다.
 */
const ZoomGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;

/** 레시피 확대본 — body 포털의 고정 오버레이. Esc·바깥 누름·닫기 글리프로 닫히고, 열릴 때 카드가 포커스를 받는다. */
function RecipeZoom({ t, title, onClose, children }: { readonly t: Translate<TodoMessageKey>; readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
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
    <div className="todo-zoom-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={cardRef} className="todo-zoom" role="dialog" aria-modal="true" aria-label={`${t("todo.graph.title")} · ${title}`} tabIndex={-1}>
        <div className="todo-zoom-head">
          <span className="todo-zoom-title">{t("todo.graph.title")}<span className="todo-zoom-item">{title}</span></span>
          <button type="button" className="todo-glyph" aria-label={t("todo.detail.close")} title={t("todo.detail.close")} onClick={onClose}><CloseGlyph /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const GoGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5 7.5 8.5" /></svg>;

const AssignGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="2.2" /><circle cx="11" cy="11" r="2.2" /><path d="M7 5h3.5a1.5 1.5 0 0 1 1.5 1.5V8.8M9 11H5.5A1.5 1.5 0 0 1 4 9.5V7.2" /></svg>;

/**
 * 단계의 사전 배정 — 셰프 컨트롤과 같은 메뉴에 「셰프 직접 · 라우팅 · 셰프와 같게」가 먼저 서고, 그 아래 모델 목록.
 * 모델을 고르면 그 모델·강도로 담당이 뜨고, 라우팅은 시작할 때 AI Gateway 가 난이도로 고른다. `all` 은 열린 단계 전부에 같은 배정.
 */
function AssignControl({ t, assign, onChange, label, all = false }: { readonly t: Translate<TodoMessageKey>; readonly assign: StepAssign | null; readonly onChange: (assign: StepAssign | null) => void; readonly label: string; readonly all?: boolean }) {
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
        { id: "self", label: t("todo.assign.self"), active: !assign || assign.mode === "self", onPick: () => onChange({ mode: "self" }) },
        { id: "route", label: t("todo.assign.route"), hint: t("todo.assign.routeHint"), active: assign?.mode === "route", onPick: () => onChange({ mode: "route" }) },
        ...(all ? [] : [{ id: "inherit", label: t("todo.assign.inherit"), active: assign === null, onPick: () => onChange(null) }]),
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
  // 셰프가 일하는 동안에도 받는 편집 — 단계 추가, 시작 전(끝나지 않고 담당이 없는) 단계의 문구·삭제·선행, 메모. 서버가 같은 기준으로 가른다.
  const touchable = !item.done;
  const notStarted = (step: TodoStep) => !step.done && !step.slot;
  const canEditStep = (stepId: string) => { if (editable) return true; const target = item.steps.find((candidate) => candidate.id === stepId); return touchable && !!target && notStarted(target); };
  const [steering, setSteering] = useState(false);
  const attachments = useAttachmentUpload(item, t);
  const [dropping, setDropping] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  // 펼친 단계 기록 — 단계 id → 펼친 순간의 읽은 수(「새 기록」 표시의 기준). 다른 항목으로 가면 모두 접는다.
  const [openRecords, setOpenRecords] = useState<Readonly<Record<string, number>>>({});
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
  const toggleRecords = (step: TodoStep) => setOpenRecords((current) => {
    if (step.id in current) { const { [step.id]: _closed, ...rest } = current; return rest; }
    return { ...current, [step.id]: Math.min(step.seen ?? 0, step.records?.length ?? 0) };
  });
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 사람의 결정을 기다리는 세션 — 셰프가 먼저, 다음은 단계 순서. 카드가 잠기지 않은 채 사람을 부르는 유일한 상태다.
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
    if (result) { const words = launchWords(launchRows, item.launch.model, item.launch.effort, t("todo.coordinator.effortAuto")); toast(t("todo.toast.started", { model: `${words.model} · ${words.effort}` })); }
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
    if (result) { setCookOpen(false); toast(t(result.started ? "todo.toast.planStarted" : "todo.toast.planRequested")); }
  };
  const link = async (operationId: string) => {
    if (!picker) return;
    const path = picker.stepId ? "/step/link" : "/coordinator/link";
    await call(path, { itemId: item.id, ...(picker.stepId ? { stepId: picker.stepId } : {}), operationId });
    setPicker(null);
  };
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);

  return (
    <aside ref={detailRef} className={`todo-detail${busy ? " is-busy" : ""}`} aria-label={item.title}>
      <div className="todo-detail-scroll">
      <div className="todo-group">
        <div className="todo-detail-head">
          <button type="button" className="todo-glyph todo-detail-back" aria-label={t("todo.detail.backToList")} title={t("todo.detail.backToList")} onClick={onClose}>‹</button>
          <button type="button" className={`todo-check${item.done ? " is-on" : ""}`} aria-label={t(item.done ? "todo.item.reopen" : "todo.item.complete")} disabled={busy} onClick={onComplete}><CheckGlyph /></button>
          <textarea className="todo-detail-title" aria-label={t("todo.item.titleAria")} value={title} rows={1} readOnly={!editable} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={() => { if (title.trim() && title !== item.title) void call("/item/patch", { itemId: item.id, patch: { title: title.trim() } }); }} />
          <button type="button" className={`todo-star${item.important ? " is-on" : ""}`} aria-label={t("todo.item.important")} aria-pressed={item.important} onClick={() => void call("/item/patch", { itemId: item.id, patch: { important: !item.important } })}>{item.important ? "★" : "☆"}</button>
          {placeButton}
        </div>
        {busy ? <div className="todo-busy-line" role="status"><i aria-hidden="true" /><span>{t(item.cooking ? "todo.cooking" : "todo.busy")}</span></div> : null}
      </div>

      <div className="todo-group">
        <div className={`todo-row${item.today ? " is-on" : ""}`}>
          <button type="button" className="todo-row-main" aria-pressed={item.today} disabled={!editable} onClick={() => void call("/item/patch", { itemId: item.id, patch: { today: !item.today } })}>
            <span className="todo-row-ic"><SunGlyph /></span>
            <span className="todo-row-lab">{t(item.today ? "todo.schedule.todayOn" : "todo.schedule.addToday")}</span>
          </button>
          {item.today && editable ? <button type="button" className="todo-row-x" aria-label={t("todo.schedule.removeToday")} title={t("todo.schedule.removeToday")} onClick={() => void call("/item/patch", { itemId: item.id, patch: { today: false } })}>×</button> : null}
        </div>
        <div className={`todo-row${item.dueDate ? " is-on" : ""}${item.dueDate && item.dueDate < todayIso() && !item.done ? " is-overdue" : ""}`}>
          <button type="button" className="todo-row-main" disabled={!editable} aria-haspopup="dialog" aria-expanded={!!dateAnchor} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setDateAnchor((value) => (value ? null : rect)); }}>
            <span className="todo-row-ic"><CalGlyph /></span>
            <span className="todo-row-lab">{item.dueDate ? t("todo.schedule.dueOn", { date: dueLabel(item.dueDate, language) }) : t("todo.schedule.setDue")}</span>
          </button>
          {dateAnchor ? <DatePicker anchor={dateAnchor} value={item.dueDate} language={language} t={t} onPick={(next) => void call("/item/patch", { itemId: item.id, patch: { dueDate: next } })} onClose={() => setDateAnchor(null)} /> : null}
          {item.dueDate && editable ? <button type="button" className="todo-row-x" aria-label={t("todo.schedule.clearDue")} title={t("todo.schedule.clearDue")} onClick={() => void call("/item/patch", { itemId: item.id, patch: { dueDate: null } })}>×</button> : null}
        </div>
      </div>

      <div className="todo-group">
        {/* 조율자 행 — 왼쪽은 「조율자 · 부제」, 오른쪽 끝은 모델·강도. 아직 조율자가 없으면 행 자체가 연결 목록을 아래로 펼치는 손잡이다. */}
        <div className={`todo-row${item.slot ? " is-on" : ""}${picker && picker.stepId === null ? " is-expanded" : ""}`}>
          <button type="button" className="todo-row-main" disabled={!!item.slot || !editable} aria-expanded={!item.slot ? !!picker && picker.stepId === null : undefined} onClick={() => setPicker((value) => (value && value.stepId === null ? null : { stepId: null }))}>
            <span className="todo-row-ic"><CoordGlyph /></span>
            <span className="todo-row-lab">
              {t("todo.coordinator.title")}

            </span>
          </button>
          <LaunchControl t={t} model={item.slot?.model ?? item.launch.model} effort={item.slot?.effort ?? item.launch.effort} view={item.launch.view} locked={locked} onChange={(next) => void call("/item/patch", { itemId: item.id, patch: { launch: next } })} />
          {item.slot && editable ? <button type="button" className="todo-row-x" aria-label={t("todo.coordinator.unlink")} title={t("todo.coordinator.unlink")} onClick={() => void call("/coordinator/unlink", { itemId: item.id })}>×</button> : null}
        </div>
        {picker && picker.stepId === null ? (
          <div className="todo-pick" role="listbox" aria-label={t("todo.link.pick")}>
            {freeOperations.length === 0 ? <span className="todo-hint">{t("todo.link.none")}</span> : null}
            {freeOperations.map((operation) => <button key={operation.id} type="button" onClick={() => void link(operation.id)}><i className={`todo-op is-${operation.activity}`} style={{ padding: 0, border: 0 }}><i aria-hidden="true" /></i>{operation.title}</button>)}
          </div>
        ) : null}
        {/* 쿠킹 — 누르면 그 자리에서 맥락 한 줄이 펼쳐진다. 비워 두고 Enter 해도 된다. */}
        {editable && launchAvailable ? (
          <>
            <button type="button" className={`todo-row${cookOpen ? " is-expanded" : ""}`} title={t("todo.steps.planHint")} disabled={planning} aria-expanded={cookOpen} onClick={() => setCookOpen((value) => !value)}>
              <span className="todo-row-ic"><WandGlyph /></span>
              <span className="todo-row-lab">{t(planning ? "todo.steps.planning" : "todo.steps.plan")}</span>
            </button>
            {cookOpen ? (
              <div className="todo-cook-line">
                <textarea
                  className="todo-cook"
                  aria-label={t("todo.coordinator.cookContext")}
                  placeholder={t("todo.coordinator.cookContext")}
                  value={cook}
                  rows={1}
                  autoFocus
                  disabled={planning}
                  ref={(element) => { if (element) { element.style.height = "0px"; element.style.height = `${element.scrollHeight}px`; } }}
                  onChange={(event) => { setCook(event.target.value); event.target.style.height = "0px"; event.target.style.height = `${event.target.scrollHeight}px`; }}
                  onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setCookOpen(false); return; } if (submitKey(event) && !event.shiftKey) { event.preventDefault(); void plan(cook); } }}
                />
                <button type="button" className="todo-glyph todo-cook-send" aria-label={t("todo.coordinator.cookSend")} title={t("todo.coordinator.cookSend")} disabled={planning} onClick={() => void plan(cook)}><SendGlyph /></button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="todo-group">
        <div className="todo-steps">
          {item.steps.map((step, index) => {
            const ready = stepReady(item, step);
            const records = step.records ?? [];
            const recordsOpen = step.id in openRecords;
            const unseen = unseenRecords(step);
            const recordsId = `todo-records-${step.id}`;
            return (
              <Fragment key={step.id}>
              <div className={`todo-step${step.done ? " is-done" : ""}${recordsOpen ? " is-expanded" : ""}${highlightStep === step.id ? " is-highlight" : ""}`}>
                <button type="button" className={`todo-check${step.done ? " is-on" : ""}`} aria-label={t("todo.steps.done")} disabled={!editable} onClick={() => void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { done: !step.done } })}><CheckGlyph /></button>
                <div className="todo-step-body">
                  <input className="todo-step-text" aria-label={`${index + 1}`} defaultValue={step.text} readOnly={!(editable || (touchable && notStarted(step)))} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== step.text) void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { text: value } }); }} onKeyDown={(event) => { if (submitKey(event)) event.currentTarget.blur(); }} />
                  {/* 배정된 모델은 단계 이름 아래 dim 한 줄 — 풀네임 · 강도. 담당은 상태 점, 예약은 ✦. */}
                  {step.slot ? <span className={`todo-step-sub is-${operationState(step.slot.operationId)}`} title={`${t("todo.steps.assignee")} · ${operationTitle(step.slot.operationId)}`}><ProviderGlyph model={step.slot.model} /><span>{launchWords(launchRows, step.slot.model, step.slot.effort, t("todo.coordinator.effortAuto")).model}</span>{step.slot.effort ? <b>{launchWords(launchRows, step.slot.model, step.slot.effort, t("todo.coordinator.effortAuto")).effort}</b> : null}</span>
                    : step.unplaced && !step.done ? <span className="todo-step-sub is-unplaced">{t("todo.steps.unplaced")}</span>
                    : !step.done ? <span className="todo-step-sub is-assign">{!step.assign || step.assign.mode === "self" ? t("todo.assign.self") : step.assign.mode === "route" ? t("todo.assign.route") : <><ProviderGlyph model={step.assign.model} /><span>{launchWords(launchRows, step.assign.model, step.assign.effort, t("todo.coordinator.effortAuto")).model}</span><b>{launchWords(launchRows, step.assign.model, step.assign.effort, t("todo.coordinator.effortAuto")).effort}</b></>}</span> : null}
                </div>
                {records.length > 0 ? (
                  <button type="button" className={`todo-records-count${unseen > 0 ? " is-unseen" : ""}`} aria-expanded={recordsOpen} aria-controls={recordsId} aria-label={`${t("todo.records.count", { index: index + 1, count: records.length })}${unseen > 0 ? ` · ${t("todo.records.unseen", { count: unseen })}` : ""}`} onClick={() => toggleRecords(step)}>
                    {unseen > 0 ? <i aria-hidden="true" /> : <ThreadGlyph />}{records.length}
                  </button>
                ) : null}
                {!step.slot && !step.done && !ready && !step.unplaced ? <span className="todo-wait" title={t("todo.steps.waiting")}>⏸</span> : null}
                <span className="todo-step-tools">
                  {!step.done && !step.slot && editable ? <AssignControl t={t} assign={step.assign ?? null} onChange={(assign) => void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { assign } })} label={t("todo.steps.assign")} /> : null}
                  {step.slot && editable ? <button type="button" className="todo-glyph" title={t("todo.steps.unlink")} aria-label={t("todo.steps.unlink")} onClick={() => void call("/step/unlink", { itemId: item.id, stepId: step.id })}>×</button> : null}
                  {notStarted(step) && touchable ? <button type="button" className="todo-glyph" title={t("todo.steps.remove")} aria-label={t("todo.steps.remove")} onClick={() => void call("/step/remove", { itemId: item.id, stepId: step.id })}><TrashGlyph /></button> : null}
                </span>
              </div>
              {records.length > 0 ? <StepRecords id={recordsId} records={records} seenAtOpen={openRecords[step.id] ?? 0} open={recordsOpen} t={t} language={language} /> : null}
              </Fragment>
            );
          })}
        </div>
        {touchable ? (
          <div className="todo-row todo-step-add">
            <span className="todo-row-ic todo-plus" aria-hidden="true">+</span>
            <input aria-label={t("todo.steps.add")} placeholder={t("todo.steps.add")} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; void call("/step/add", { itemId: item.id, step: { text: target.value.trim() } }).then(() => { target.value = ""; }); } }} />
            {editable && item.steps.some((step) => !step.done && !step.slot) ? (
              <AssignControl t={t} assign={null} all label={t("todo.steps.assignAll")} onChange={async (assign) => { for (const step of item.steps) if (!step.done && !step.slot) await call("/step/patch", { itemId: item.id, stepId: step.id, patch: { assign } }); }} />
            ) : null}
          </div>
        ) : null}
        {item.steps.length > 0 ? (
          <>
            <div className="todo-row is-static">
              <span className="todo-row-ic"><GraphGlyph /></span>
              <span className="todo-row-lab">{t("todo.graph.title")}</span>
              <span className="todo-row-tools">
                {item.steps.length > 1 && editable ? <>
                  <button type="button" className="todo-btn is-small" onClick={async () => { if (await call("/edge/linear", { itemId: item.id })) toast(t("todo.toast.linear")); }}>{t("todo.graph.linear")}</button>
                  <button type="button" className="todo-btn is-small" onClick={async () => { if (await call("/edge/clear", { itemId: item.id })) toast(t("todo.toast.parallel")); }}>{t("todo.graph.parallel")}</button>
                </> : null}
                <button ref={zoomTriggerRef} type="button" className="todo-glyph" aria-haspopup="dialog" aria-expanded={zoomOpen} aria-label={t("todo.graph.zoom")} title={t("todo.graph.zoom")} onClick={() => setZoomOpen(true)}><ZoomGlyph /></button>
              </span>
            </div>
            <div className="todo-graph-wrap">
              <div className="todo-graph-horizontal"><CoordinationGraph item={item} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("todo.graph.cycle"))} operationTitle={operationTitle} onZoom={() => setZoomOpen(true)} canEdit={canEditStep} /></div>
              <div className="todo-graph-vertical"><CoordinationGraph vertical item={item} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("todo.graph.cycle"))} operationTitle={operationTitle} onZoom={() => setZoomOpen(true)} canEdit={canEditStep} /></div>
            </div>
            {zoomOpen ? createPortal(
              <RecipeZoom t={t} title={item.title} onClose={() => { setZoomOpen(false); zoomTriggerRef.current?.focus(); }}>
                <CoordinationGraph zoom item={item} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("todo.graph.cycle"))} operationTitle={operationTitle} canEdit={canEditStep} />
              </RecipeZoom>,
              document.body,
            ) : null}
          </>
        ) : null}
      </div>

      {/* 메모 — 본문 아래 첨부 띠. 메모에 이미지를 붙여넣거나 메모 구획에 끌어오면 띠에 들어간다. */}
      <div
        className={`todo-group todo-note-group${dropping ? " is-drop" : ""}`}
        onDragOver={(event) => { if (touchable && [...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDropping(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(event) => { if (!touchable) return; event.preventDefault(); setDropping(false); const files = imageFiles(event.dataTransfer.files); if (files.length) void attachments.upload(files); }}
      >
        <textarea className="todo-note" aria-label={t("todo.item.memo")} placeholder={t("todo.item.memoPlaceholder")} value={note} readOnly={!touchable} onChange={(event) => saveNote(event.target.value)}
          onPaste={(event) => { if (!touchable) return; const files = imageFiles(event.clipboardData.files); if (files.length) { event.preventDefault(); void attachments.upload(files); } }} />
        <NoteAttachments item={item} t={t} touchable={touchable} upload={attachments.upload} error={attachments.error} sending={attachments.sending} onRemove={(attachment) => void call("/attachment/remove", { itemId: item.id, attachmentId: attachment.id })} />
      </div>

      </div>
      <div className="todo-detail-bottom">
      {/* 마지막 행동 한 자리 — 검토 대기면 「완료」, 누군가 사람의 결정을 기다리면 「결정 대기」(누르면 그 Operation으로),
          아니면 「시작」, 일하는 동안에는 「중단」 — 그동안 사람이 보드를 고쳤으면 「중단」 자리가 「스티어링」이 된다. 같은 띠, 낱말만 다르다. */}
      {item.review && !item.done ? (
        <div className="todo-group todo-start-group">
          <button type="button" className="todo-start is-review" title={item.review.summary} onClick={onComplete}>
            <span className="todo-start-word">{t("todo.review.complete")}</span>
            <span className="todo-start-sub">{t("todo.review.sub")}</span>
            <span className="todo-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : awaiting && !busy ? (
        <div className="todo-group todo-start-group">
          <button type="button" className="todo-start is-awaiting" title={operationTitle(awaiting.operationId)} onClick={() => focusOperation(awaiting.operationId)}>
            <span className="todo-start-word"><i className="todo-start-dot" aria-hidden="true" />{t("todo.awaiting.word")}</span>
            <span className="todo-start-sub">{awaiting.stepIndex === null ? t("todo.awaiting.chef") : t("todo.awaiting.step", { index: awaiting.stepIndex + 1 })}</span>
            <span className="todo-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : editable && !busy ? (
        <div className="todo-group todo-start-group">
          <button type="button" className="todo-start" disabled={!launchAvailable} title={launchAvailable ? undefined : t("todo.coordinator.unavailable")} onClick={() => void start()}>
            <span className="todo-start-word">{t("todo.coordinator.start")}</span>
            <span className="todo-start-sub">{item.slot ? `${stateLabel(operationState(item.slot.operationId))} · ${t("todo.start.resume")}` : (() => { const open = item.steps.filter((step) => !step.done && !step.slot); const workers = open.filter((step) => step.assign && step.assign.mode !== "self").length; return open.length <= 1 || workers === 0 ? t("todo.start.direct") : t("todo.start.workers", { count: workers }); })()}</span>
            <span className="todo-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : busy && item.edited ? (
        <div className="todo-group todo-start-group">
          <button type="button" className="todo-start is-steer" title={t("todo.steer.hint")} disabled={steering} onClick={() => void steer()}>
            <span className="todo-start-word">{t("todo.steer")}</span>
            <span className="todo-start-sub" />
            <span className="todo-start-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      ) : busy ? (
        <div className="todo-group todo-start-group">
          <button type="button" className="todo-start is-stop" title={t("todo.stopHint")} onClick={() => void onStop()}>
            <span className="todo-start-word"><StopGlyph />{t("todo.stop")}</span>
            <span className="todo-start-sub">{t("todo.stopHint")}</span>
          </button>
        </div>
      ) : null}
      <div className="todo-detail-foot">
        <button type="button" className="todo-glyph" aria-label={t("todo.detail.close")} title={t("todo.detail.close")} onClick={onClose}><ChevronGlyph /></button>
        <span className="todo-detail-created">{t("todo.detail.created", { date: createdLabel(item.createdAt, language) })}</span>
        {busy ? <span aria-hidden="true" className="todo-detail-foot-spacer" /> : <button type="button" className="todo-glyph is-danger is-large" aria-label={t("todo.item.delete")} title={t("todo.item.delete")} onClick={async () => { const removed = await call<{ item: TodoItem }>("/item/remove", { itemId: item.id }); if (removed) toast(t("todo.toast.deleted")); }}><TrashGlyph /></button>}
      </div>
      </div>
    </aside>
  );
}
