import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { coordinatorMode, stepReady, unseenRecords, type CoordinatorMode, type ObjectiveMember, type StepRecord, type ObjectiveItem, type ObjectiveStep } from "../server/types.js";
import { ActionBand, type MemberAwaiting } from "./action-band.js";
import { NoteAttachments, imageFiles, useAttachmentUpload } from "./attachments.js";
import { CoordinationGraph } from "./graph.js";
import { DatePicker } from "./date-picker.js";
import { GroupMenu, opensGroupMenu, type GroupMenuAnchor, type GroupPatch } from "./group-menu.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LaunchControl, LaunchedText, launchWords, launchedWords, useLaunchRows, StartViewGlyph, StartViewPicker, startViewLabel, type StartView } from "./launch-control.js";
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
const StarGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true"><path d="M8 2.4l1.8 3.75 4.1.55-3 2.85.75 4.07L8 11.68l-3.65 1.94.75-4.07-3-2.85 4.1-.55z" /></svg>;
const TrashGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" /></svg>;
/** 브리핑 — 봉인된 작전 명령서. 문서 오른쪽 아래 모서리를 인장이 대신한다. */
const BriefGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.3 13.5H4.5A1.5 1.5 0 0 1 3 12V3.5A1.5 1.5 0 0 1 4.5 2h6A1.5 1.5 0 0 1 12 3.5v4.3" /><path d="M5.6 5.2h3.8M5.6 7.8h2.6" /><circle cx="11.4" cy="11.4" r="2.6" /><circle cx="11.4" cy="11.4" r="0.75" fill="currentColor" stroke="none" /></svg>;
/** 임무 — 차례로 선 할 일. */
const MissionsGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="3.6" cy="4" r="1.5" /><circle cx="3.6" cy="8" r="1.5" /><circle cx="3.6" cy="12" r="1.5" /><path d="M7 4h6.5M7 8h6.5M7 12h4.5" /></svg>;
const MoreGlyph = () => <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>;

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
/** 한글 IME 조합 중의 Return 은 확정이지 제출이 아니다 — 조합 확정과 제출로 두 번 오는 keydown 중 앞의 것을 거른다. */
function submitKey(event: ReactKeyboardEvent<HTMLElement>): boolean { return event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229; }
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
  const setSelected = useCallback((next: string | null | ((value: string | null) => string | null)) => patchObjectiveView(theaterId, (current) => ({ selected: typeof next === "function" ? next(current.selected) : next, externalSelectionId: null })), [theaterId]);
  const setDueFilter = (next: DueFilter) => patchObjectiveView(theaterId, () => ({ dueFilter: next }));
  // 구획 접기 — 그룹 구획은 펼침이 기본, 맨 아래 「완료됨」은 접힘이 기본.
  const toggleSection = (key: string, defaultOpen: boolean) => patchObjectiveView(theaterId, (current) => ({ collapsed: { ...current.collapsed, [key]: key in current.collapsed ? !current.collapsed[key] : defaultOpen } }));
  const isOpen = (key: string, defaultOpen: boolean) => (key in collapsed ? !collapsed[key] : defaultOpen);
  const [highlightStep, setHighlightStep] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; undo?: () => Promise<void> } | null>(null);
  const launchRows = useLaunchRows();
  const [nextView, setNextView] = useState<StartView>(() => { try { return localStorage.getItem("fleet.objectives.start-view") === "chat" ? "chat" : "terminal"; } catch { return "terminal"; } });
  const chooseNextView = (value: StartView) => { setNextView(value); try { localStorage.setItem("fleet.objectives.start-view", value); } catch { /* 저장을 차단한 브라우저에서도 선택은 유지한다. */ } };
  // 끌기 — 카드를 왼쪽 목록 위에 놓으면 그 목록으로 옮기고, 같은 구획의 카드 사이에 놓으면 순서를 바꾼다.
  // 원래 자리는 빈 홈으로 남고 카드 유령이 커서를 따르며, 순서를 바꿀 자리에는 삽입선이 선다.
  const [drag, setDrag] = useState<{ itemId: string; x: number; y: number; over: ListId | null; insert: Insert | null; offX: number; offY: number; width: number; compact: boolean } | null>(null);
  const dragRef = useRef<{ itemId: string; section: string; startX: number; startY: number; live: boolean; over: ListId | null; insert: Insert | null; offX: number; offY: number; width: number } | null>(null);
  const suppressClick = useRef(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const listMenuRef = useRef<HTMLDivElement | null>(null);
  const listTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 그룹 메뉴 — 목록 열의 그룹 행·스마트 목록의 그룹 구획 머리·그룹 목록 제목 옆 「···」에서 연다(이름·색만).
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; anchor: GroupMenuAnchor; returnFocus: HTMLElement | null } | null>(null);
  const openGroupMenu = (groupId: string, anchor: GroupMenuAnchor, returnFocus: HTMLElement | null) => setGroupMenu({ groupId, anchor, returnFocus });
  /** 우클릭·Shift+F10·메뉴 키 — 우클릭은 커서 자리, 키보드는 요소의 왼쪽 아래. */
  const groupMenuHandlers = (groupId: string) => ({
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => { event.preventDefault(); openGroupMenu(groupId, { x: event.clientX, y: event.clientY }, event.currentTarget); },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!opensGroupMenu(event)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openGroupMenu(groupId, { x: rect.left + 12, y: rect.bottom + 4 }, event.currentTarget);
    },
  });
  const moreButton = (group: ObjectiveGroup, className: string) => (
    <button type="button" className={`objectives-glyph objectives-group-more ${className}`} aria-label={t("objectives.group.menu", { name: group.name })} title={t("objectives.group.menu", { name: group.name })} aria-haspopup="menu" aria-expanded={groupMenu?.groupId === group.id}
      onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openGroupMenu(group.id, { x: rect.left, y: rect.bottom + 4 }, event.currentTarget); }}><MoreGlyph /></button>
  );
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
  // 지휘관 자신의 활동 — 코어는 구성원의 대기·실행을 지휘관 활동으로 끌어올린다. 하단 한 자리는 지휘관 자신의 대기·실행과
  // 구성원의 것을 가려야 하므로 끌어올리기 전 값(ownActivity)을 읽는다. 구성원·부모 아닌 Operation 은 activity 와 같다.
  const operationOwnState = useCallback((operationId: string): string => { const operation = operationOf(operationId); return operation ? operation.ownActivity ?? operation.activity : "closed"; }, [operationOf]);
  // 항목의 활동 = 지휘관과 담당 가운데 가장 급한 것 — 호스트가 캔버스에서 지휘관을 그리는 셈법과 같다.
  const URGENCY: Record<string, number> = { awaiting: 0, running: 1, background: 2, idle: 3, ended: 4, unknown: 5 };
  const itemActivity = useCallback((item: ObjectiveItem) => {
    const ids = [item.id, ...item.steps.flatMap((step) => (step.operationId ? [step.operationId] : []))];
    return ids.map((id) => operationState(id)).filter((state) => state !== "closed").reduce((top, state) => ((URGENCY[state] ?? 9) < (URGENCY[top] ?? 9) ? state : top), "unknown" as ReturnType<typeof operationState>);
  }, [operationState]);
  // 조율자가 일하는 동안 카드는 잠긴다 — 편집 대신 「중단」 하나만 남는다(서버도 같은 기준으로 거절한다).
  // 담당의 활동은 잠그지 않고, 조율자가 사람을 기다리는(awaiting) 동안도 잠그지 않는다 — 그때는 사람이 손을 대야 한다.
  const isBusy = useCallback((item: ObjectiveItem): boolean => !item.done && WORKING.has(operationState(item.id)), [operationState]);
  // 하단 한 자리의 행동 — 실패를 삼키지 않고 코드를 던진다(띠가 원인 한 줄을 보이고 글을 지킨다).
  const request = useCallback((path: string, body: Record<string, unknown>) => post<unknown>(ctx.api, path, { ...body, language }), [ctx.api, language]);
  const modeLabel = (mode: CoordinatorMode) => t(mode === "direct" ? "objectives.mode.direct" : mode === "coordinate" ? "objectives.mode.coordinate" : "objectives.mode.mixed");
  const stateLabel = (state: string) => t((["running", "awaiting", "idle", "background", "ended", "closed"].includes(state) ? `objectives.state.${state}` : "objectives.state.unknown") as Parameters<typeof t>[0]);

  const groupOf = (groupId: string | null): ObjectiveGroup | null => (groupId ? state.groups.find((group) => group.id === groupId) ?? null : null);
  const inList = useCallback((item: ObjectiveItem): boolean => {
    if (list === "today") return item.today;
    if (list === "due") return !!item.dueDate && (dueFilter === "all" || dueBucket(item.dueDate) === dueFilter);
    if (list === "all") return true;
    if (list === "agent") return !!item.addedBy;
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
    // 검토 대기 — 모든 임무와 달성 기준이 끝나 사람의 완료만 남은 항목은 맨 위 한 구획으로 모인다(그룹 구획에서 빠진다). 펼침이 기본.
    const reviewing = open.filter((item) => item.awaitingReview);
    if (reviewing.length) out.push({ key: "review", label: t("objectives.items.review"), swatch: null, items: reviewing });
    const working = open.filter((item) => !item.awaitingReview);
    if (!sectioned) out.push({ key: "flat", label: null, swatch: null, items: working });
    else {
      for (const group of state.groups) {
        const items = working.filter((item) => item.groupId === group.id);
        if (items.length) out.push({ key: group.id, label: group.name, swatch: group.color, items });
      }
      const rest = working.filter((item) => !groupOf(item.groupId));
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
    if (view.externalSelectionId === selected) return;
    const frame = requestAnimationFrame(() => {
      if (mainRef.current && getComputedStyle(mainRef.current).display === "none") detailRef.current?.querySelector<HTMLElement>(".objectives-detail-back")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, view.externalSelectionId]);
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
    const result = await call("/item/complete", { itemId: item.id });
    if (result) toast(t("objectives.toast.completed"), async () => { await call("/item/complete", { itemId: item.id, undone: true }); });
  };
  const addItem = async (raw: string) => {
    let title = raw.trim();
    if (!title) return;
    const important = /(^|\s)!/.test(title);
    title = title.replace(/(^|\s)!\S*/g, "$1").trim();
    if (!title || !theaterId) return;
    const groupId = list.startsWith("group:") ? list.slice(6) : null;
    await call("/item/create", { theaterId, groupId, title, important, viewMode: nextView, today: list === "today", dueDate: list === "due" ? todayIso() : null });
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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && selected && !listMenuOpen && !document.querySelector(".objectives-cal, .objectives-zoom-backdrop, .objectives-menu")) closeDetail(); };
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
        <ListButton id="agent" current={list} onPick={setList} label={`◌ ${t("objectives.list.agent")}`} count={openCount((item) => !!item.addedBy)} />
        <div className="objectives-lists-hd" title={t("objectives.list.groupsHint")}>{t("objectives.list.groups")}</div>
        {state.groups.map((group) => (
          <div key={group.id} className={`objectives-list-row${groupMenu?.groupId === group.id ? " is-menu" : ""}`}>
            <ListButton id={`group:${group.id}`} current={list} onPick={setList} drop over={drag?.over === `group:${group.id}`} label={group.name} swatch={group.color} count={openCount((item) => item.groupId === group.id)} menuProps={groupMenuHandlers(group.id)} />
            {moreButton(group, "is-row")}
          </div>
        ))}
        <ListButton id="ungrouped" current={list} onPick={setList} drop over={drag?.over === "ungrouped"} label={t("objectives.list.ungrouped")} muted count={openCount((item) => !groupOf(item.groupId))} />
        <button type="button" className="objectives-lists-add" onClick={async () => { const result = await call<{ group: ObjectiveGroup }>("/group/create", { theaterId, name: t("objectives.list.newGroupName"), color: "teal" }); if (result) { setList(`group:${result.group.id}`); toast(t("objectives.toast.groupCreated")); } }}>+ {t("objectives.list.newGroup")}</button>
      </nav>

      <section ref={mainRef} className="objectives-main">
        <div className="objectives-title">
          <div ref={listMenuRef} className="objectives-list-select">
            <button ref={listTriggerRef} type="button" className="objectives-list-trigger" aria-label={t("objectives.list.select")} aria-haspopup="menu" aria-expanded={listMenuOpen} onClick={() => setListMenuOpen((value) => !value)}><span>{listTitle}</span><span className="objectives-count">{open.length}</span><span aria-hidden="true">⌄</span></button>
            {listMenuOpen ? <div className="objectives-list-menu" role="menu" aria-label={t("objectives.list.select")}>
              {(["today", "due", "all", "agent"] as const).map((id) => <ListButton key={id} id={id} current={list} onPick={pickList} label={t(`objectives.list.${id}`)} count={openCount((item) => id === "today" ? item.today : id === "due" ? !!item.dueDate : id === "agent" ? !!item.addedBy : true)} menu />)}
              <div className="objectives-lists-hd">{t("objectives.list.groups")}</div>
              {state.groups.map((group) => <ListButton key={group.id} id={`group:${group.id}`} current={list} onPick={pickList} label={group.name} swatch={group.color} count={openCount((item) => item.groupId === group.id)} menu />)}
              <ListButton id="ungrouped" current={list} onPick={pickList} label={t("objectives.list.ungrouped")} count={openCount((item) => !groupOf(item.groupId))} menu />
              <button type="button" className="objectives-lists-add" role="menuitem" onClick={async () => { const result = await call<{ group: ObjectiveGroup }>("/group/create", { theaterId, name: t("objectives.list.newGroupName"), color: "teal" }); if (result) { pickList(`group:${result.group.id}`); toast(t("objectives.toast.groupCreated")); } }}>+ {t("objectives.list.newGroup")}</button>
            </div> : null}
          </div>
          <h2>{listTitle}</h2>
          {list.startsWith("group:") && groupOf(list.slice(6)) ? moreButton(groupOf(list.slice(6))!, "is-title") : null}
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
          {section.label ? <button type="button" className="objectives-section-hd" aria-expanded={expanded} onClick={() => toggleSection(section.key, !section.done)} {...(section.swatch && groupOf(section.key) ? groupMenuHandlers(section.key) : {})}><span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>{section.swatch ? <span className="objectives-swatch" style={{ background: `var(--id-${section.swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}<span>{section.label}</span><span className="objectives-count">{section.items.length}</span></button> : null}
          {expanded ? section.items.map((item) => {
            // 방향키 이웃은 같은 구획의 카드 행 기준 — 검토 대기가 빠져나가면 visible 순서와 구획 안 순서가 어긋난다.
            const index = section.items.indexOf(item);
            const mode = coordinatorMode(item.steps);
            const showGroup = false as false | ObjectiveGroup | null;
            const busy = isBusy(item);
            return (
              <div key={item.id} data-item-id={item.id} className={`objectives-item${item.done ? " is-done" : ""}${busy ? " is-busy" : ""}${drag?.itemId === item.id ? " is-lifted" : ""}${drag?.insert?.anchorId === item.id ? ` is-insert-${drag.insert.place}` : ""}`} role="option" aria-selected={selected === item.id} tabIndex={0}
                onPointerDown={(event) => onItemPointerDown(event, item, section.key)}
                onClick={() => { if (suppressClick.current) return; setSelected((value) => (value === item.id ? null : item.id)); }} onKeyDown={(event) => onItemKey(event, item, index, section.key)}>
                {/* 동그라미 = 완료 버튼이자 상태. 지휘관이 연결돼 있으면 묶음에서 가장 급한 활동을 고리로 보이고, 일하는 동안은 누르지 못한다. 완료는 늘 사람의 몫이다. */}
                {/* 검토 대기 — 모든 임무와 기준이 끝난 상태. 고리는 사람의 완료 버튼이 된다. */}
                {item.awaitingReview && !item.done
                  ? <span className="objectives-check-tip"><button type="button" className="objectives-check is-linked is-review" aria-label={t("objectives.review.tip")} onClick={(event) => { event.stopPropagation(); void completeItem(item); }}><i aria-hidden="true" /></button><span className="objectives-check-bubble" aria-hidden="true">{t("objectives.review.tip")}</span></span>
                  : !item.done && item.commander.started && operationState(item.id) !== "closed"
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
                    {item.addedBy ? <span className="objectives-by">{t("objectives.item.addedBy", { name: item.addedBy.title ?? "—" })}</span> : null}
                  </div>
                </div>
                <div className="objectives-item-side">
                  <LaunchWords item={item} t={t} rows={launchRows} autoLabel={t("objectives.coordinator.effortAuto")} defaultLabel={t("objectives.launch.default")} state={item.commander.started ? operationState(item.id) : null} />
                  <button type="button" className="objectives-glyph objectives-goto" aria-label={t("objectives.item.goToOperation")} title={t("objectives.item.goToOperation")} onClick={(event) => { event.stopPropagation(); focusOperation(item.id); }}><GoGlyph /></button>
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
          <StartViewPicker t={t} value={nextView} onChange={chooseNextView} />
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
          operationOwnState={operationOwnState}
          busy={isBusy(current)}
          request={request}
          sectionOpen={(key) => isOpen(key, true)}
          onToggleSection={(key) => toggleSection(key, true)}
          onOpenSection={(key) => patchObjectiveView(theaterId, (view) => ({ collapsed: { ...view.collapsed, [key]: false } }))}
          highlightStep={highlightStep}
          onClose={closeDetail}
          detailRef={detailRef}
          placeButton={placeButton("objectives-place-detail")}
          onComplete={() => completeItem(current)}
          onToggleEdge={(from, to) => toggleEdge(current, from, to)}
        />
      ) : null}
      {groupMenu && groupOf(groupMenu.groupId) ? (
        <GroupMenu
          key={groupMenu.groupId}
          group={groupOf(groupMenu.groupId)!}
          anchor={groupMenu.anchor}
          t={t}
          onPatch={(patch: GroupPatch) => void call("/group/patch", { groupId: groupMenu.groupId, ...patch })}
          onClose={(returnFocus) => { const back = groupMenu.returnFocus; setGroupMenu(null); if (returnFocus) back?.focus(); }}
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

function ListButton({ id, current, onPick, label, count, swatch, muted, drop, over, menu, menuProps }: { id: ListId; current: ListId; onPick: (id: ListId) => void; label: string; count: number; swatch?: string; muted?: boolean; drop?: boolean; over?: boolean; menu?: boolean; menuProps?: { onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void; onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } }) {
  return (
    <button type="button" className={`objectives-list-btn${muted ? " is-muted" : ""}${over ? " is-drop" : ""}`} role={menu ? "menuitemradio" : undefined} aria-checked={menu ? current === id : undefined} aria-current={current === id} aria-haspopup={menuProps ? "menu" : undefined} onClick={() => onPick(id)} {...(drop ? { "data-drop-list": id } : {})} {...(menuProps ?? {})}>
      {swatch ? <span className="objectives-swatch" style={{ background: `var(--id-${swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}
      <span>{label}</span>
      <span className="objectives-count">{count}</span>
    </button>
  );
}

/** 카드 오른쪽의 지휘관 모델·강도 — 지휘관 Operation 의 값. 살아 있으면 점이 켜진다. */
function LaunchWords({ item, t, rows, autoLabel, defaultLabel, state }: { item: ObjectiveItem; t: T; rows: ReturnType<typeof useLaunchRows>; autoLabel: string; defaultLabel: string; state: string | null }) {
  // 모델이 비어 있으면 Console 기본값으로 뜨는 Operation 이다(사이드바에서 따로 만든 것).
  const words = !item.commander.model
    ? { model: defaultLabel, effort: item.commander.effort?.toUpperCase() ?? autoLabel }
    : launchWords(rows, item.commander.model, item.commander.effort, autoLabel);
  return (
    <span className={`objectives-item-launch${state ? ` is-${state}` : ""}`} title={`${words.model} · ${words.effort}`}>
      {item.commander.viewMode === "chat" ? <span className="objectives-item-view" role="img" aria-label={startViewLabel(t, "chat")} title={startViewLabel(t, "chat")}><StartViewGlyph view="chat" /></span> : null}
      <span>{words.model}</span>
      <b>{words.effort}</b>
    </span>
  );
}

/**
 * 구성원 트리거의 표시 — 실행과 설정을 가른다. 띄운 Operation 이 있으면 어떤 방식이든 그 Operation 의 모델이 실제 실행값이다(연결 뒤
 * 설정을 바꿔도 기존 Operation 은 옛 모델로 재개된다). 띄우기 전에는 라우팅·지휘관과 같게는 선택 낱말, 모델 지정은 선택값 그대로.
 * 메뉴의 선택 표시(model·effort·active)는 이 값이 아니라 member.launch 만 따른다.
 */
function memberLaunchDisplay(member: ObjectiveMember, launched: boolean, t: T, rows: ReturnType<typeof useLaunchRows>): { text?: ReactNode; title: string; label: string } {
  const labels = { auto: t("objectives.coordinator.effortAuto"), fallback: t("objectives.launch.default") };
  if (launched) {
    const running = launchedWords(rows, member.model, member.effort, labels);
    return { text: <LaunchedText model={running.model} words={running.words} />, title: running.title, label: `${running.words.model} · ${running.words.effort}` };
  }
  if (member.launch.mode === "route") return { text: <span className="objectives-launch-model">{t("objectives.assign.route")}</span>, title: t("objectives.members.routeHint"), label: t("objectives.assign.route") };
  if (member.launch.mode === "same") return { text: <span className="objectives-launch-model">{t("objectives.assign.inherit")}</span>, title: t("objectives.assign.inherit"), label: t("objectives.assign.inherit") };
  const chosen = launchedWords(rows, member.launch.model, member.launch.effort, labels);
  return { title: chosen.title, label: `${chosen.words.model} · ${chosen.words.effort}` };
}
/** 사라진 Operation 은 실행값을 읽을 곳이 없다 — 띄우기 전처럼 설정 선택을 보인다(다음 개시가 연결을 새로 세운다). */
const memberLaunched = (member: ObjectiveMember, operationState: (operationId: string) => string): boolean => !!member.operationId && operationState(member.operationId) !== "closed";

/** 구성원 표식의 색 — 명단 순번으로 정체성 톤(--id-*) 8가지를 돌려 쓴다. 명단·임무 줄·배정 메뉴가 같은 구성원에 같은 색을 쓴다. */
const MEMBER_TONES = 8;
const memberTone = (item: ObjectiveItem, memberId: string): number => Math.max(0, item.members.findIndex((member) => member.id === memberId)) % MEMBER_TONES;

function MemberMark({ role, tone }: { role: string; tone: number }) {
  return <span className={`objectives-member-mark is-tone-${tone}`} aria-hidden="true">{Array.from(role)[0] ?? "?"}</span>;
}

function MemberRoster({ item, t, call, operationState, rows, touchable }: { item: ObjectiveItem; t: T; call: DetailProps["call"]; operationState: DetailProps["operationState"]; rows: ReturnType<typeof useLaunchRows>; touchable: boolean }) {
  // 빼면 맡던 임무는 지휘관 직접으로 돌아간다 — 달성 기준처럼 되돌리기 없이 바로.
  const remove = (member: ObjectiveMember) => void call("/member/remove", { itemId: item.id, memberId: member.id });
  // 달성 기준·임무 줄과 같은 문법 — 글자 자체가 입력칸이고, 떠나면 저장한다. Enter 는 확정, Escape 는 되돌린다.
  const inlineKeys = (original: string) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (submitKey(event)) event.currentTarget.blur();
    else if (event.key === "Escape") { event.currentTarget.value = original; event.currentTarget.blur(); }
  };
  return <div className="objectives-members">
    <div className="objectives-members-heading">{t("objectives.members.title")} <span>{item.members.length}</span></div>
    {item.members.length === 0 ? <p className="objectives-members-empty">{t("objectives.members.empty")}</p> : null}
    {item.members.map((member, index) => {
      const count = item.steps.filter((step) => step.member === member.id).length;
      const state = member.operationId ? operationState(member.operationId) : "closed";
      const display = memberLaunchDisplay(member, memberLaunched(member, operationState), t, rows);
      const status = state === "closed" ? t("objectives.members.missions", { count }) : state === "ended" ? t("objectives.members.dormant") : state === "running" || state === "background" ? t("objectives.members.working") : state === "awaiting" ? t("objectives.state.awaiting") : t("objectives.members.idle");
      return (
        <div key={member.id} className="objectives-member">
          <MemberMark role={member.role} tone={memberTone(item, member.id)} />
          <div className="objectives-member-body">
            <span className="objectives-member-name">
              {/* 너비는 글자 수가 아니라 실제 글자 폭으로 — 숨은 복제(data-value)가 칸을 잡는다(한글처럼 넓은 글자도 잘리지 않게). */}
              <span key={`role:${member.role}`} className="objectives-member-role-fit" data-value={member.role}>
                <input className="objectives-member-role" aria-label={t("objectives.members.roleAria", { n: index + 1 })} defaultValue={member.role} readOnly={!touchable} maxLength={40} size={1}
                  onInput={(event) => { event.currentTarget.parentElement!.dataset.value = event.currentTarget.value; }}
                  onKeyDown={inlineKeys(member.role)} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== member.role) void call("/member/patch", { itemId: item.id, memberId: member.id, patch: { role: value } }); else { event.target.value = member.role; event.target.parentElement!.dataset.value = member.role; } }} />
              </span>
              {member.by === "commander" ? <span className="objectives-member-by">{t("objectives.members.proposed")}</span> : null}
            </span>
            <WrapText key={`brief:${member.brief ?? ""}`} className="objectives-member-brief" label={t("objectives.members.briefAria", { role: member.role })} value={member.brief ?? ""} placeholder={touchable ? t("objectives.members.briefPlaceholder") : t("objectives.members.noBrief")} readOnly={!touchable} maxLength={300}
              onCommit={(value) => { if (value !== (member.brief ?? "")) void call("/member/patch", { itemId: item.id, memberId: member.id, patch: { brief: value || null } }); return true; }} />
          </div>
          <div className="objectives-member-meta">
            <LaunchControl key={member.id} t={t} model={member.launch.mode === "model" ? member.launch.model : undefined} effort={member.launch.mode === "model" ? member.launch.effort : undefined} locked={!touchable} startAtList={member.launch.mode !== "model"} triggerLabel={t("objectives.members.modelAria", { role: member.role })}
              triggerText={display.text} triggerTitle={display.title}
              extras={[{ id: "route", label: t("objectives.assign.route"), hint: t("objectives.members.routeHint"), active: member.launch.mode === "route", onPick: () => void call("/member/patch", { itemId: item.id, memberId: member.id, patch: { launch: null } }) }, { id: "same", label: t("objectives.assign.inherit"), active: member.launch.mode === "same", onPick: () => void call("/member/patch", { itemId: item.id, memberId: member.id, patch: { launch: { mode: "same" } } }) }]}
              onChange={(next) => { const model = next.model ?? (member.launch.mode === "model" ? member.launch.model : undefined); if (model) void call("/member/patch", { itemId: item.id, memberId: member.id, patch: { launch: { mode: "model", model, effort: next.effort } } }); }} />
            <span className={`objectives-member-status is-${state}`} title={state === "ended" ? t("objectives.members.dormantHint") : undefined}>{status}</span>
          </div>
          {touchable ? <button type="button" className="objectives-glyph objectives-member-remove" title={t("objectives.members.remove")} aria-label={t("objectives.members.removeAria", { role: member.role })} onClick={() => remove(member)}><TrashGlyph /></button> : null}
        </div>
      );
    })}
    {touchable ? (
      <div className="objectives-row objectives-step-add">
        <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
        <input aria-label={t("objectives.members.add")} placeholder={t("objectives.members.add")} maxLength={40} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; const role = target.value.trim(); target.value = ""; void call("/member/add", { itemId: item.id, member: { role } }); } }} />
      </div>
    ) : null}
  </div>;
}

function AssignControl({ t, item, step, onAssign, onCreate, label, rows, operationState }: { t: T; item: ObjectiveItem; step: ObjectiveStep; onAssign: (member: string | null) => void; onCreate: (role: string) => Promise<boolean>; label: string; rows: ReturnType<typeof useLaunchRows>; operationState: DetailProps["operationState"] }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState("");
  const creatingRef = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -1000, top: -1000 });
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 250;
    setPos({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 228)), top: rect.bottom + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 6) : rect.bottom + 6 });
  }, [open, creating, item.members.length]);
  const pick = (id: string | null) => { onAssign(id); setOpen(false); };
  return <>
    <button ref={trigger} type="button" className="objectives-launch is-glyph objectives-glyph" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => { setCreating(false); setOpen((value) => !value); }}><AssignGlyph /></button>
    {open ? createPortal(<div ref={menu} className="objectives-menu objectives-assign-menu" role="menu" aria-label={label} style={{ ...pos, width: 216 }}>
      <button type="button" role="menuitemradio" aria-checked={!step.member} className={`objectives-menu-item${!step.member ? " is-active" : ""}`} onClick={() => pick(null)}><span className="objectives-menu-label">{t("objectives.assign.self")}</span></button>
      <div className="objectives-menu-divider" role="separator" />
      <p className="objectives-menu-caption objectives-assign-caption">{t("objectives.members.title")}</p>
      {item.members.map((member) => <button key={member.id} type="button" role="menuitemradio" aria-checked={step.member === member.id} className={`objectives-menu-item${step.member === member.id ? " is-active" : ""}`} onClick={() => pick(member.id)}><MemberMark role={member.role} tone={memberTone(item, member.id)} /><span className="objectives-menu-label">{member.role}</span>{((display) => <span className="objectives-assign-model" title={display.title}>{display.label}</span>)(memberLaunchDisplay(member, memberLaunched(member, operationState), t, rows))}</button>)}
      <div className="objectives-menu-divider" role="separator" />
      {creating ? <div className="objectives-assign-new"><input autoFocus maxLength={40} aria-label={t("objectives.members.new")} placeholder={t("objectives.members.rolePlaceholder")} value={role} onChange={(event) => setRole(event.target.value)} onKeyDown={(event) => { if (submitKey(event) && role.trim() && !creatingRef.current) { creatingRef.current = true; void onCreate(role.trim()).then((created) => { if (created) { setOpen(false); setRole(""); } }).finally(() => { creatingRef.current = false; }); } }} /><span>{t("objectives.members.newHint")}</span></div>
        : <button type="button" role="menuitem" className="objectives-menu-item objectives-assign-create" onClick={() => setCreating(true)}>{t("objectives.members.new")}</button>}
    </div>, document.body) : null}
  </>;
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

type DetailSection = "detail:criteria" | "detail:missions";

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
  /** 끌어올리기 전 자기 활동 — 지휘관 자신의 대기·실행을 구성원 것과 가를 때. */
  readonly operationOwnState: (operationId: string) => string;
  readonly busy: boolean;
  readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  /** 상세 섹션 접힘 — 보기 상태(Theater별)에 산다. 키는 `detail:criteria`·`detail:missions`, 기본은 펼침. */
  readonly sectionOpen: (key: DetailSection) => boolean;
  readonly onToggleSection: (key: DetailSection) => void;
  readonly onOpenSection: (key: DetailSection) => void;
  readonly highlightStep: string | null;
  readonly onClose: () => void;
  readonly detailRef: RefObject<HTMLElement | null>;
  readonly placeButton: ReactNode;
  readonly onComplete: () => void;
  readonly onToggleEdge: (from: string, to: string) => Promise<void>;
}

/**
 * 세부 — 입력 폼이 아니라 행의 목록이다. 일정 → 지휘관·구성원 → 브리핑 → 달성 기준 → 임무 → 편성, 맨 아래 하단 한 자리(action-band).
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

/** 한 줄로 저장하는 문구 — 붙여넣은 줄바꿈은 저장 때 공백이 된다. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();
/** `field-sizing: content` 가 없는 엔진(WebKit)은 글상자 높이를 직접 잰다. */
const FIELD_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
function fitHeight(element: HTMLTextAreaElement | null): void {
  if (!element || FIELD_SIZING) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

/**
 * 임무·달성 기준·구성원 설명의 문구 — 한 줄 입력칸이 아니라 줄바꿈하는 글상자라 길어도 전문이 그 자리에서 보인다(제목·근거 줄과
 * 같은 문법). 편집은 그대로: Enter 는 확정이고(줄바꿈이 아니다) 떠나면 저장한다. Esc 는 되돌리고 칸만 떠난다(상세는 닫지 않는다).
 */
function WrapText({ className, label, value, readOnly, maxLength, placeholder, onCommit }: {
  readonly className: string;
  readonly label: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly maxLength?: number;
  readonly placeholder?: string;
  /** 줄바꿈을 공백으로 바꾼 값. 저장하지 않을 값이면 false 를 돌려 칸을 원래 글로 되돌린다. */
  readonly onCommit: (value: string) => boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { fitHeight(ref.current); }, [value]);
  // 폴백 엔진에서는 폭이 바뀌면 줄 수도 바뀐다.
  useEffect(() => {
    const element = ref.current;
    if (FIELD_SIZING || !element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; fitHeight(element); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      className={className}
      rows={1}
      aria-label={label}
      defaultValue={value}
      readOnly={readOnly}
      maxLength={maxLength}
      placeholder={placeholder}
      onInput={(event) => fitHeight(event.currentTarget)}
      onKeyDown={(event) => {
        if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); }
        else if (event.key === "Escape") { event.preventDefault(); event.currentTarget.value = value; fitHeight(event.currentTarget); event.currentTarget.blur(); }
      }}
      onBlur={(event) => {
        const next = oneLine(event.currentTarget.value);
        event.currentTarget.value = onCommit(next) ? next : value;
        fitHeight(event.currentTarget);
      }}
    />
  );
}

/**
 * 섹션 머리 — 글리프 열·라벨·오른쪽 셈과 도구. 접히는 섹션은 행 전체가 버튼이고 셰브런이 맨 끝에 선다(접힘 0°, 펼침 90°).
 * 항목이 없으면 접지 않는다 — 추가 행이 늘 보이게 셰브런 없는 정적 머리로 둔다.
 */
function SectionHead({ glyph, label, tools, controls, expanded, onToggle }: {
  readonly glyph: ReactNode;
  readonly label: string;
  readonly tools?: ReactNode;
  /** 접히는 본문의 id — 없으면 정적 머리. */
  readonly controls?: string;
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
}) {
  const inner = <>
    <span className="objectives-row-ic">{glyph}</span>
    <span className="objectives-row-lab">{label}</span>
    {tools ? <span className="objectives-row-tools">{tools}</span> : null}
  </>;
  if (!controls) return <div className="objectives-row is-static">{inner}</div>;
  return (
    <button type="button" className="objectives-row objectives-acc-hd" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {inner}
      <span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>
    </button>
  );
}

const BRIEF_LINES = 3;

function ItemDetail({ item, t, language, launchAvailable, call, toast, modeLabel, stateLabel, operationTitle, operationState, operationOwnState, busy, request, sectionOpen, onToggleSection, onOpenSection, highlightStep, onClose, detailRef, placeButton, onComplete, onToggleEdge }: DetailProps) {
  const [note, setNote] = useState(item.note);
  const [title, setTitle] = useState(item.title);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const launchRows = useLaunchRows();
  useEffect(() => { setNote(item.note); }, [item.note]);
  useEffect(() => { setTitle(item.title); }, [item.title]);
  const mode = coordinatorMode(item.steps);
  // 수동 재개로 초기화된 유휴 세션도 잠근다. 구성원의 활동이 아니라 지휘관 자신의 상태로 판단한다.
  const locked = item.commander.started || ["idle", "running", "background", "awaiting"].includes(operationOwnState(item.id));
  const editable = !item.done && !busy;
  // 지휘관이 일하는 동안에도 받는 편집 — 단계 추가, 끝나지 않은 단계의 문구·삭제·선행·담당, 메모. 구성원이 떠 있어도 임무는 끝나기 전까지 사람의 것이다. 서버가 같은 기준으로 가른다.
  const touchable = !item.done;
  const notStarted = (step: ObjectiveStep) => !step.done;
  const canEditStep = (stepId: string) => { if (editable) return true; const target = item.steps.find((candidate) => candidate.id === stepId); return touchable && !!target && notStarted(target); };
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
      const key = `${step.id}:${step.records.at(-1)?.id ?? ""}`;
      if (!(step.id in openRecords) || unseenRecords(step) === 0 || seenPending.current.has(key)) continue;
      seenPending.current.add(key);
      void call("/step/seen", { itemId: item.id, stepId: step.id });
    }
  }, [item, openRecords, call]);
  const toggleRecords = (step: ObjectiveStep) => setOpenRecords((current) => {
    if (step.id in current) { const { [step.id]: _closed, ...rest } = current; return rest; }
    return { ...current, [step.id]: new Set(step.records.slice(0, Math.min(step.seen, step.records.length)).map((record) => record.id)) };
  });
  // 짚은 단계 — 목록 행과 편성 노드가 서로를 켠다(그 단계의 선행도 함께).
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const focused = focusStep ? item.steps.find((step) => step.id === focusStep) ?? null : null;
  const numberOf = (stepId: string) => item.steps.findIndex((step) => step.id === stepId) + 1;
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);

  // 사람을 부르는 세션 — 지휘관 자신이 먼저, 다음은 명단 순서의 구성원(임무가 없는 구성원의 질문도 본다).
  // 지휘관 판정은 끌어올리기 전 자기 활동으로 한다 — 구성원만 묻고 있을 때 「지휘관이 기다립니다」로 서지 않게.
  const commanderAwaiting = !item.done && operationOwnState(item.id) === "awaiting";
  const memberAwaiting: MemberAwaiting | null = item.done ? null : (() => {
    const member = item.members.find((candidate) => candidate.operationId && operationState(candidate.operationId) === "awaiting");
    if (!member?.operationId) return null;
    const mission = item.steps.findIndex((step) => !step.done && step.member === member.id);
    return { operationId: member.operationId, role: member.role, mission: mission >= 0 ? mission + 1 : null };
  })();
  // 작업 중 — 지휘관 자신이나 구성원 누군가가 돈다. 편집 잠금은 지금처럼 끌어올린 지휘관 활동(busy)이고, 하단 한 자리는
  // 지휘관 자신의 실행과 구성원 각자의 실행을 따로 본다(구성원이 묻는 동안 끌어올린 값은 대기라 실행을 가린다).
  const working = !item.done && (WORKING.has(operationOwnState(item.id)) || item.members.some((member) => !!member.operationId && WORKING.has(operationState(member.operationId))));

  // 섹션 접힘 — 항목이 없으면 접지 않는다.
  const criteriaCollapsible = item.criteria.length > 0;
  const missionsCollapsible = item.steps.length > 0;
  const criteriaOpen = !criteriaCollapsible || sectionOpen("detail:criteria");
  const missionsOpen = !missionsCollapsible || sectionOpen("detail:missions");
  // 「이 임무로」 — 임무 섹션을 펼치고 그 행으로 스크롤한다(편성 노드 호버로는 펼치지 않는다).
  useEffect(() => { if (highlightStep && !missionsOpen) onOpenSection("detail:missions"); }, [highlightStep, missionsOpen, onOpenSection]);
  useEffect(() => {
    if (!highlightStep || !missionsOpen) return;
    const frame = requestAnimationFrame(() => detailRef.current?.querySelector(`[data-step-id="${CSS.escape(highlightStep)}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [highlightStep, missionsOpen, detailRef]);
  const unseenAny = item.steps.some((step) => unseenRecords(step) > 0);

  // 브리핑 — 쉴 때 3줄, 넘치면 「더 보기」. 쓰는 동안(초점)은 다 보인다(360px 뒤로는 안에서 스크롤).
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const [noteFocus, setNoteFocus] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteOverflow, setNoteOverflow] = useState(false);
  const noteClamped = !noteOpen && !noteFocus;
  // 빈 브리핑은 「브리핑 추가」 한 줄 — 누르거나 초점이 오면(또는 이미지를 끌어오면) 편집 칸과 첨부 띠가 펼쳐진다.
  const [briefActive, setBriefActive] = useState(false);
  const briefBlank = !note.trim() && item.attachments.length === 0;
  const briefCollapsed = briefBlank && touchable && !briefActive && !dropping && !attachments.error && attachments.sending === 0;
  const fitNote = useCallback(() => {
    const element = noteRef.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 20;
    const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const clampAt = line * BRIEF_LINES + pad;
    element.style.height = "0px";
    const full = element.scrollHeight;
    element.style.height = `${Math.ceil(Math.min(full, noteClamped ? clampAt : 360))}px`;
    setNoteOverflow(full > clampAt + 1);
  }, [noteClamped]);
  useLayoutEffect(() => { fitNote(); }, [note, fitNote]);
  useEffect(() => {
    const element = noteRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; fitNote(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fitNote]);

  const saveNote = (value: string) => {
    setNote(value);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => { void call("/item/patch", { itemId: item.id, patch: { note: value } }); }, 600);
  };
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const doneSteps = item.steps.filter((step) => step.done).length;

  return (
    <aside ref={detailRef} className={`objectives-detail${busy ? " is-busy" : ""}`} aria-label={item.title}>
      <div className="objectives-detail-scroll">
      <div className="objectives-group">
        <div className="objectives-detail-head">
          <button type="button" className="objectives-glyph objectives-detail-back" aria-label={t("objectives.detail.backToList")} title={t("objectives.detail.backToList")} onClick={onClose}>‹</button>
          <button type="button" className={`objectives-check${item.done ? " is-on" : ""}`} aria-label={t(item.done ? "objectives.item.reopen" : "objectives.item.complete")} disabled={busy} onClick={onComplete}><CheckGlyph /></button>
          <textarea className="objectives-detail-title" aria-label={t("objectives.item.titleAria")} value={title} rows={1} readOnly={!editable} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={() => { if (title.trim() && title !== item.title) void call("/item/patch", { itemId: item.id, patch: { title: title.trim() } }); }} />
          <button type="button" className={`objectives-star${item.important ? " is-on" : ""}`} aria-label={t("objectives.item.important")} aria-pressed={item.important} onClick={() => void call("/item/patch", { itemId: item.id, patch: { important: !item.important } })}><StarGlyph /></button>
          {!busy ? <button type="button" className="objectives-detail-delete" aria-label={t("objectives.item.delete")} title={t("objectives.item.delete")} onClick={async () => { const removed = await call<{ item: ObjectiveItem }>("/item/remove", { itemId: item.id }); if (removed) toast(t("objectives.toast.deleted")); }}><TrashGlyph /></button> : null}
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

      {/* 지휘관·구성원 — 목표는 곧 지휘관 Operation 이다. 행을 누르면 그 Operation 으로 가고, 오른쪽 끝은 모델·강도(깨기 전까지 바꿀 수 있다). */}
      <div className="objectives-group">
        <div className={`objectives-row${item.commander.started ? " is-on" : ""}`}>
          <button type="button" className="objectives-row-main" title={t("objectives.item.goToOperation")} onClick={() => focusOperation(item.id)}>
            <span className="objectives-row-ic"><CoordGlyph /></span>
            <span className="objectives-row-lab">{t("objectives.coordinator.title")}</span>
          </button>
          <LaunchControl t={t} model={item.commander.model} effort={item.commander.effort} viewMode={item.commander.viewMode ?? "terminal"} onViewChange={(viewMode) => void call("/item/patch", { itemId: item.id, patch: { launch: { viewMode } } })} locked={locked || !editable} onChange={(next) => void call("/item/patch", { itemId: item.id, patch: { launch: next } })} />
        </div>
        <MemberRoster item={item} t={t} call={call} operationState={operationState} rows={launchRows} touchable={touchable} />
      </div>

      {/* 브리핑 — 사람이 쓴 요구. 첨부 띠는 본문 위에 머문다. 메모에 이미지를 붙여넣거나 이 구획에 끌어오면 띠에 들어간다. */}
      <div
        className={`objectives-group objectives-note-group${dropping ? " is-drop" : ""}`}
        onFocus={() => setBriefActive(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBriefActive(false); }}
        onDragOver={(event) => { if (touchable && [...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDropping(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(event) => { if (!touchable) return; event.preventDefault(); setDropping(false); const files = imageFiles(event.dataTransfer.files); if (files.length) void attachments.upload(files); }}
      >
        <SectionHead glyph={<BriefGlyph />} label={t("objectives.item.memo")} tools={item.attachments.length > 0 ? <span className="objectives-criteria-count">{t("objectives.brief.images", { count: item.attachments.length })}</span> : null} />
        {briefCollapsed ? null : <NoteAttachments item={item} t={t} touchable={touchable} upload={attachments.upload} error={attachments.error} sending={attachments.sending} onRemove={(attachment) => void call("/attachment/remove", { itemId: item.id, attachmentId: attachment.id })} />}
        <textarea ref={noteRef} className={`objectives-note${noteClamped ? " is-clamped" : ""}${briefBlank && !briefCollapsed ? " is-writing" : ""}`} rows={1} aria-label={t("objectives.item.memo")} placeholder={t("objectives.item.memoPlaceholder")} value={note} readOnly={!touchable} onChange={(event) => saveNote(event.target.value)}
          onFocus={() => setNoteFocus(true)} onBlur={() => setNoteFocus(false)}
          onPaste={(event) => { if (!touchable) return; const files = imageFiles(event.clipboardData.files); if (files.length) { event.preventDefault(); void attachments.upload(files); } }} />
        {noteOverflow && (noteOpen || !noteFocus) ? <button type="button" className="objectives-note-more" aria-expanded={noteOpen} onPointerDown={(event) => event.preventDefault()} onClick={() => setNoteOpen((value) => !value)}>{t(noteOpen ? "objectives.brief.less" : "objectives.brief.more")}</button> : null}
      </div>

      {/* 달성 기준 — 사람이 쓰고(비어 있으면 구상 때 지휘관이 제안), 마지막 임무 뒤 지휘관이 기준마다 스스로 다시 따져 근거와 함께
          충족으로 표시한다. 새 작업이 생기면 충족 표시는 거둬져 「미확인」으로 돌아간다. 모든 임무와 기준이 끝나면 저절로 검토 대기다. */}
      <div className="objectives-group objectives-criteria-group">
        <SectionHead
          glyph={<CriteriaGlyph />}
          label={t("objectives.criteria.title")}
          tools={criteriaCollapsible ? <span className="objectives-criteria-count">{t("objectives.criteria.count", { met: item.criteria.filter((criterion) => !!criterion.met).length, total: item.criteria.length })}</span> : null}
          {...(criteriaCollapsible ? { controls: "objectives-sec-criteria", expanded: criteriaOpen, onToggle: () => onToggleSection("detail:criteria") } : {})}
        />
        <div id="objectives-sec-criteria" hidden={!criteriaOpen}>
          {item.criteria.map((criterion, index) => {
            const evidence = criterion.met;
            return (
              <div key={criterion.id} className={`objectives-criterion${evidence ? " is-met" : ""}`}>
                <span className="objectives-criterion-mark" aria-hidden="true" />
                <div className="objectives-criterion-body">
                  <WrapText key={criterion.text} className="objectives-criterion-text" label={t("objectives.criteria.itemAria", { n: index + 1 })} value={criterion.text} readOnly={!touchable} maxLength={300}
                    onCommit={(value) => { if (!value) return false; if (value !== criterion.text) void call("/criterion/patch", { itemId: item.id, criterionId: criterion.id, patch: { text: value } }); return true; }} />
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
      </div>

      {/* 임무 — 편성 순. 머리 오른쪽은 완료 셈이고, 접혀도 남는다(접힌 임무에 안 읽은 기록이 있으면 셈 앞에 점 하나). */}
      <div className="objectives-group objectives-missions-group">
        <SectionHead
          glyph={<MissionsGlyph />}
          label={t("objectives.steps.title")}
          tools={missionsCollapsible ? <>
            {!missionsOpen && unseenAny ? <i className="objectives-sec-unseen" title={t("objectives.steps.unseen")} /> : null}
            <span className="objectives-criteria-count">{t("objectives.steps.count", { done: doneSteps, total: item.steps.length })}</span>
          </> : null}
          {...(missionsCollapsible ? { controls: "objectives-sec-missions", expanded: missionsOpen, onToggle: () => onToggleSection("detail:missions") } : {})}
        />
        <div id="objectives-sec-missions" hidden={!missionsOpen}>
          <div className="objectives-steps">
            {item.steps.map((step, index) => {
              const ready = stepReady(item.steps, step);
              const member = item.members.find((candidate) => candidate.id === step.member);
              const records = step.records;
              const recordsOpen = step.id in openRecords;
              const unseen = unseenRecords(step);
              const recordsId = `objectives-records-${step.id}`;
              return (
                <Fragment key={step.id}>
                <div
                  data-step-id={step.id}
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
                    <WrapText key={step.text} className="objectives-step-text" label={`${index + 1}`} value={step.text} readOnly={!(editable || (touchable && notStarted(step)))} maxLength={200}
                      onCommit={(value) => { if (!value) return false; if (value !== step.text) void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { text: value } }); return true; }} />
                    <span className={`objectives-step-sub${step.operationId ? ` is-${operationState(step.operationId)}` : " is-assign"}`} title={step.operationId ? operationTitle(step.operationId) : undefined}>{member ? <><MemberMark role={member.role} tone={memberTone(item, member.id)} /><span className="objectives-step-member-name">{member.role}</span></> : t("objectives.assign.self")}</span>
                    {step.unplaced && !step.done ? <span className="objectives-step-sub is-unplaced">{t("objectives.steps.unplaced")}</span> : null}
                  </div>
                  {records.length > 0 ? (
                    <button type="button" className={`objectives-records-count${unseen > 0 ? " is-unseen" : ""}`} aria-expanded={recordsOpen} aria-controls={recordsId} aria-label={`${t("objectives.records.count", { index: index + 1, count: records.length })}${unseen > 0 ? ` · ${t("objectives.records.unseen", { count: unseen })}` : ""}`} onClick={() => toggleRecords(step)}>
                      {unseen > 0 ? <i aria-hidden="true" /> : <ThreadGlyph />}{records.length}
                    </button>
                  ) : null}
                  {/* 무엇을 기다리는지 번호로 말한다 — 끝나지 않은 선행만. 구성원 상태는 담당 줄이 말한다. */}
                  {!step.done && !step.unplaced ? (ready
                    ? <span className="objectives-wait is-ready">{t("objectives.steps.ready")}</span>
                    : <span className="objectives-wait" title={t("objectives.steps.waiting")}>{t("objectives.steps.after", { steps: step.after.filter((id) => !item.steps.find((candidate) => candidate.id === id)?.done).map(numberOf).filter((n) => n > 0).join("·") })}</span>) : null}
                  <span className="objectives-step-tools">
                    {!step.done && touchable ? <AssignControl t={t} item={item} step={step} rows={launchRows} operationState={operationState} onAssign={(member) => void call("/step/patch", { itemId: item.id, stepId: step.id, patch: { member } })} onCreate={async (role) => { const result = await call<{ item: ObjectiveItem }>("/member/add", { itemId: item.id, member: { role } }); const member = result?.item.members.at(-1); return member ? !!(await call("/step/patch", { itemId: item.id, stepId: step.id, patch: { member: member.id } })) : false; }} label={t("objectives.steps.assign")} /> : null}
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
            </div>
          ) : null}
        </div>
      </div>

      {/* 편성 — 임무의 순서와 담당. 접지 않는다. 임무가 없으면 서지 않는다. */}
      {item.steps.length > 0 ? (
        <div className="objectives-group">
          <SectionHead
            glyph={<GraphGlyph />}
            label={t("objectives.graph.title")}
            tools={<>
              {item.steps.length > 1 && editable ? <>
                <button type="button" className="objectives-btn is-small" onClick={async () => { if (await call("/edge/linear", { itemId: item.id })) toast(t("objectives.toast.linear")); }}>{t("objectives.graph.linear")}</button>
                <button type="button" className="objectives-btn is-small" onClick={async () => { if (await call("/edge/clear", { itemId: item.id })) toast(t("objectives.toast.parallel")); }}>{t("objectives.graph.parallel")}</button>
              </> : null}
              <button ref={zoomTriggerRef} type="button" className="objectives-glyph" aria-haspopup="dialog" aria-expanded={zoomOpen} aria-label={t("objectives.graph.zoom")} title={t("objectives.graph.zoom")} onClick={() => setZoomOpen(true)}><ZoomGlyph /></button>
            </>}
          />
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
        </div>
      ) : null}

      </div>
      <div className="objectives-detail-bottom">
        <ActionBand
          item={item}
          t={t}
          busy={busy}
          working={working}
          commanderAwaiting={commanderAwaiting}
          memberAwaiting={memberAwaiting}
          launchAvailable={launchAvailable}
          commanderState={stateLabel(operationState(item.id))}
          request={request}
          onFocusOperation={focusOperation}
        />
      </div>
    </aside>
  );
}
