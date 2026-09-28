import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { onboardingBoundary } from "@fleet-console/sdk/onboarding/anchors";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { commanderMode, MAX_FOLLOWUPS, missionReady, unseenRecords, type CommanderMode, type ObjectiveCriterion, type ObjectiveCriterionProposal, type ObjectiveMember, type MissionRecord, type Objective, type ObjectiveMission } from "../server/types.js";
import { ActionBand, type MemberAwaiting } from "./action-band.js";
import { DecisionGlyph, DecisionList, DecisionRequestBlock, RequestGlyph } from "./decisions.js";
import { PastRoles } from "./past-roles.js";
import { RetroGlyph, Retrospective } from "./retrospective.js";
import { ObjectiveResults, ResultsGlyph, ResultsHeadTools } from "./results.js";
import { AttachButton, AttachmentDropVeil, NoteAttachments, imageFiles, useAttachmentUpload } from "./attachments.js";
import { CoordinationGraph } from "./graph.js";
import { DatePicker } from "./date-picker.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LaunchControl, LaunchedText, launchWords, launchedWords, useLaunchRows, StartViewGlyph, StartViewPicker, startViewLabel, type StartView } from "./launch-control.js";
import { discardPendingSelection, dockObjective, expandObjective, hasDecisionRequest, removeObjectiveLocally, focusOperation, loadTheater, patchObjectiveView, post, takeReveal, upsertObjectiveLocally, useOperationSummaries, useReveal, useObjectiveTheater, useObjectiveView, useObjectiveDisplayTheater, type ObjectiveGroup } from "./objectives-state.js";
import {
  discardedFollowups,
  followupGate,
  isFollowupSelectable,
  markFollowupsSeen,
  openFollowups,
  readBatches,
  readHistory,
  readOrigin,
  setFollowupOpen,
  unseenFollowupCount,
} from "./followups.js";
import { FollowupBatchResults, FollowupCandidateList, FollowupDiscardedTrace, FollowupForkGlyph } from "./followups-view.js";

export interface ObjectiveContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language?: ConsoleLocale;
  readonly place: "rail" | "expanded";
}

/** 중앙 pane 제목 줄의 범위 낱말 — 그룹은 목록이 아니라 카드 패널의 구획이다. */
type ListId = "today" | "due" | "all" | "agent";
const LISTS: readonly ListId[] = ["today", "due", "all", "agent"];
/** 끌어 놓을 자리 — 범위 낱말(오늘·기한) 또는 다른 그룹 구획. */
type DropTarget = "today" | "due" | "ungrouped" | `group:${string}`;
type DueFilter = "all" | "overdue" | "today" | "week" | "later";
/** 끌어서 순서 바꾸기의 놓을 자리 — 이웃 카드의 앞 또는 뒤. */
type Insert = { readonly anchorId: string; readonly place: "before" | "after" };
type T = Translate<ObjectiveMessageKey>;

const ExpandGlyph = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
const DockGlyph = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.5 2.5v11M3 8h7M7 5l3 3-3 3" /></svg>;
const CheckGlyph = () => <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="M2 5.2l2.2 2.2L8 3" /></svg>;
const TrashGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" /></svg>;
/** 브리핑 — 봉인된 작전 명령서. 문서 오른쪽 아래 모서리를 인장이 대신한다. */
const BriefGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.3 13.5H4.5A1.5 1.5 0 0 1 3 12V3.5A1.5 1.5 0 0 1 4.5 2h6A1.5 1.5 0 0 1 12 3.5v4.3" /><path d="M5.6 5.2h3.8M5.6 7.8h2.6" /><circle cx="11.4" cy="11.4" r="2.6" /><circle cx="11.4" cy="11.4" r="0.75" fill="currentColor" stroke="none" /></svg>;

/**
 * 상세 패널 폭 — 자리마다 따로 보는 사람의 브라우저에 남긴다(시작 보기 선택과 같은 자리). 레일은 좁은 자리, 확장 표면은
 * 넓은 자리라 한쪽에서 맞춘 폭이 다른 쪽을 좁히지 않게 기억을 나눈다. 레일은 끌기 전까지 기억이 없고(null), 그동안은
 * 손잡이가 생기기 전의 모습(960 미만 반반, 그 이상 480)을 그대로 세운다 — 두 번 누르면 기억을 지워 그 모습으로 돌아간다.
 */
interface DetailSplit {
  readonly key: string;
  readonly detailMin: number;
  readonly detailMax: number;
  readonly mainMin: number;
  /** 기억이 없을 때의 상세 폭. 레일은 표면 폭을 따른다. */
  readonly fallback: (rootWidth: number) => number;
  /** 두 번 눌렀을 때 남길 값 — null 이면 기억을 지운다. */
  readonly reset: number | null;
}
const EXPANDED_DETAIL_DEFAULT = 480;
const DETAIL_SPLIT: Readonly<Record<ObjectiveContext["place"], DetailSplit>> = {
  expanded: { key: "fleet.objectives.detail-width", detailMin: 360, detailMax: 760, mainMin: 420, fallback: () => EXPANDED_DETAIL_DEFAULT, reset: EXPANDED_DETAIL_DEFAULT },
  rail: { key: "fleet.objectives.rail-detail-width", detailMin: 300, detailMax: Infinity, mainMin: 240, fallback: (rootWidth) => Math.round(rootWidth < 960 ? rootWidth / 2 : 480), reset: null },
};
function readDetailWidth(split: DetailSplit): number | null {
  try {
    const raw = localStorage.getItem(split.key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= split.detailMin && value <= split.detailMax ? value : null;
  } catch { return null; }
}
function saveDetailWidth(split: DetailSplit, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(split.key);
    else localStorage.setItem(split.key, String(width));
  } catch { /* 저장을 차단한 브라우저에서도 이번 폭은 유지한다. */ }
}
/**
 * 세 칸 폭 — 목표 표면이 목록 기본 300 + 내용 최소 480 + 운영 기본 340 = 1120 이상일 때만 목록 | 내용·계획 | 운영·판단으로 선다.
 * 기억은 두 칸의 상세 폭 기억(detail-width · rail-detail-width)과 따로 둔다 — 세 칸에서 끈 폭이 두 칸의 상세 폭을 덮지 않는다.
 */
const THREE_PANE = { key: "fleet.objectives.three-pane-width", threshold: 1120, contentMin: 480, list: { min: 280, max: 360, fallback: 300 }, ops: { min: 300, max: 440, fallback: 340 } } as const;
interface ThreeWidths { readonly list: number; readonly ops: number }
function readThreeWidths(): ThreeWidths {
  const pick = (value: unknown, range: { readonly min: number; readonly max: number; readonly fallback: number }) => typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= range.max ? value : range.fallback;
  try {
    const raw = localStorage.getItem(THREE_PANE.key);
    const parsed = raw ? JSON.parse(raw) as Partial<Record<keyof ThreeWidths, unknown>> : {};
    return { list: pick(parsed.list, THREE_PANE.list), ops: pick(parsed.ops, THREE_PANE.ops) };
  } catch { return { list: THREE_PANE.list.fallback, ops: THREE_PANE.ops.fallback }; }
}
function saveThreeWidths(widths: ThreeWidths): void {
  try { localStorage.setItem(THREE_PANE.key, JSON.stringify(widths)); } catch { /* 저장을 차단한 브라우저에서도 이번 폭은 유지한다. */ }
}
/** 보이는 세 칸 폭 — 기억한 폭을 쓰되 내용 칸 480 을 먼저 지킨다(운영 칸부터, 모자라면 목록 칸을 줄인다). 기억은 그대로 둔다. */
function shownThreeWidths(rootWidth: number, stored: ThreeWidths): ThreeWidths & { readonly listMax: number; readonly opsMax: number } {
  let list = stored.list;
  let ops = stored.ops;
  if (rootWidth - list - ops < THREE_PANE.contentMin) ops = Math.max(THREE_PANE.ops.min, rootWidth - list - THREE_PANE.contentMin);
  if (rootWidth - list - ops < THREE_PANE.contentMin) list = Math.max(THREE_PANE.list.min, rootWidth - ops - THREE_PANE.contentMin);
  return {
    list,
    ops,
    listMax: Math.max(THREE_PANE.list.min, Math.min(THREE_PANE.list.max, rootWidth - ops - THREE_PANE.contentMin)),
    opsMax: Math.max(THREE_PANE.ops.min, Math.min(THREE_PANE.ops.max, rootWidth - list - THREE_PANE.contentMin)),
  };
}
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
 * 임무 기록 — 구상 입력 줄과 같은 문법이다: 상자·배경 없이 임무 글자와 같은 선에서 펼쳐지고, 한 건은 흐린 모노 한 줄(시각·종류)
 * 아래 결론과 나머지 줄. 오래된 것부터 읽는다. 「새 기록」은 펼친 순간 이미 읽은 기록의 id 로 가른다(펼치면 읽음이 되어도 표시는 남는다; 상한에서 밀려나도 위치가 아니라 id 라 어긋나지 않는다).
 */
function MissionRecords({ id, records, seenAtOpen, open, t, language }: { id: string; records: readonly MissionRecord[]; seenAtOpen: ReadonlySet<string>; open: boolean; t: Translate<ObjectiveMessageKey>; language: "en" | "ko" }) {
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
/** 범위 낱말과 기한 세부가 이 목표를 보이는가. */
function inScope(objective: Objective, list: ListId, dueFilter: DueFilter): boolean {
  if (list === "today") return objective.today;
  if (list === "due") return !!objective.dueDate && (dueFilter === "all" || dueBucket(objective.dueDate) === dueFilter);
  if (list === "agent") return !!objective.addedBy;
  return true;
}
/** 결정 요청 구획의 key — 접지 않는 구획이라 접힘 기억에 들지 않는다. */
const REQUEST_SECTION = "request";
/** 요청이 선 차례 — 먼저 청한 것이 먼저 선다. 같은 때면 저장된 순서 그대로다. */
const byRequestTime = (a: Objective, b: Objective): number => (a.decisionRequest?.createdAt ?? 0) - (b.decisionRequest?.createdAt ?? 0);
/** 표면이 한 열이 되는 폭 — objectives.css 의 `@container objectives-panel (width < 600px)` 와 같은 값이다. 그 아래에서는 상세가 목록을 덮는다. */
const ONE_COLUMN_BELOW = 600;
/** 방금 추가한 목표 행의 강조 — 임무 강조(highlightMission)와 같은 시간이다. */
const ADDED_HIGHLIGHT_MS = 2400;

export function ObjectivePanel({ ctx }: { readonly ctx: ObjectiveContext }) {
  const t = getT(ctx.language);
  const language = ctx.language === "ko" ? "ko" : "en";
  const theaterId = useObjectiveDisplayTheater(ctx.theaterId);
  const state = useObjectiveTheater(theaterId);
  const operations = useOperationSummaries();
  const reveal = useReveal();
  // 보기 상태(목록 · 펼친 항목 · 구획 접힘 · 기한 필터)는 Theater 별 모듈 스토어에 산다 — 표면을 닫았다 열어도 보던 자리 그대로.
  const view = useObjectiveView(theaterId);
  // 옛 보기 상태가 그룹·미분류 목록을 가리키면 「모두」로 읽는다 — 그 그룹은 「모두」의 구획으로 보인다.
  const list: ListId = (LISTS as readonly string[]).includes(view.list) ? view.list as ListId : "all";
  const selected = view.selected;
  const collapsed = view.collapsed;
  const dueFilter = view.dueFilter as DueFilter;
  const setList = useCallback((next: ListId) => patchObjectiveView(theaterId, () => ({ list: next })), [theaterId]);
  const setSelected = useCallback((next: string | null | ((value: string | null) => string | null)) => patchObjectiveView(theaterId, (current) => ({ selected: typeof next === "function" ? next(current.selected) : next, externalSelectionId: null })), [theaterId]);
  const setDueFilter = (next: DueFilter) => patchObjectiveView(theaterId, () => ({ dueFilter: next }));
  // 구획 접기 — 그룹 구획은 펼침이 기본, 맨 아래 「완료됨」은 접힘이 기본.
  const toggleSection = (key: string, defaultOpen: boolean) => patchObjectiveView(theaterId, (current) => ({ collapsed: { ...current.collapsed, [key]: key in current.collapsed ? !current.collapsed[key] : defaultOpen } }));
  const isOpen = (key: string, defaultOpen: boolean) => (key in collapsed ? !collapsed[key] : defaultOpen);
  const [highlightMission, setHighlightMission] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);
  // 방금 추가한 목표 — 목록 칸 안에서 짚고 잠깐 강조한다. 한 열에서는 상세를 열지 않고 입력줄의 「열기」가 이 목표를 가리킨다.
  const [highlightObjective, setHighlightObjective] = useState<string | null>(null);
  const objectiveHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (objectiveHighlightTimer.current) clearTimeout(objectiveHighlightTimer.current); }, []);
  const [addedId, setAddedId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ text: string; undo?: () => Promise<void> } | null>(null);
  const launchRows = useLaunchRows();
  const [nextView, setNextView] = useState<StartView>(() => { try { return localStorage.getItem("fleet.objectives.start-view") === "chat" ? "chat" : "terminal"; } catch { return "terminal"; } });
  const chooseNextView = (value: StartView) => { setNextView(value); try { localStorage.setItem("fleet.objectives.start-view", value); } catch { /* 저장을 차단한 브라우저에서도 선택은 유지한다. */ } };
  // 끌기 — 카드를 범위 낱말(오늘·기한)이나 다른 그룹 구획에 놓으면 그리로 옮기고, 같은 구획의 카드 사이에 놓으면 순서를 바꾼다.
  // 원래 자리는 빈 홈으로 남고 카드 유령이 커서를 따르며, 순서를 바꿀 자리에는 삽입선이 선다.
  const [drag, setDrag] = useState<{ objectiveId: string; x: number; y: number; over: DropTarget | null; insert: Insert | null; offX: number; offY: number; width: number; compact: boolean } | null>(null);
  const dragRef = useRef<{ objectiveId: string; section: string; startX: number; startY: number; live: boolean; over: DropTarget | null; insert: Insert | null; offX: number; offY: number; width: number } | null>(null);
  const suppressClick = useRef(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 목표 추가의 대상 그룹 — 구획 머리의 「+ 추가」로 고른다. 그룹을 만들고 이름을 바꾸는 일은 Console 사이드바가 맡는다.
  const [addGroupId, setAddGroupId] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const split = DETAIL_SPLIT[ctx.place];
  const [detailWidth, setDetailWidth] = useState(() => readDetailWidth(split));
  const [threeWidths, setThreeWidths] = useState<ThreeWidths>(readThreeWidths);
  const [resizing, setResizing] = useState(false);
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    setRootWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setRootWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [theaterId]);
  const placeButton = (className: string) => <button type="button" className={`objectives-place-button ${className}`} data-objectives-tour="place" aria-label={t(ctx.place === "rail" ? "objectives.panel.expand" : "objectives.panel.dock")} title={t(ctx.place === "rail" ? "objectives.panel.expand" : "objectives.panel.dock")} onClick={ctx.place === "rail" ? expandObjective : dockObjective}>
    {ctx.place === "rail" ? <ExpandGlyph /> : <DockGlyph />}
  </button>;
  useEffect(() => { if (theaterId) void loadTheater(ctx.api, theaterId); }, [ctx.api, theaterId]);
  // 남겨 둔 자리가 사라졌으면(항목 삭제 · 그룹 제거) 그 자리만 거둔다 — 다른 곳에서 지워진 것을 붙들고 빈 화면을 보이지 않게.
  useEffect(() => {
    if (!state.loaded) return;
    if (selected && !state.objectives.some((objective) => objective.id === selected)) setSelected(null);
    if (addGroupId && !state.groups.some((group) => group.id === addGroupId)) setAddGroupId(null);
  }, [state.loaded, state.objectives, state.groups, selected, addGroupId, setSelected]);

  // 팔레트·캡션에서 온 "이 항목으로" — 이 Theater 의 항목이면 고르고 임무를 잠깐 강조한다.
  useEffect(() => {
    if (!reveal) return;
    const objective = state.objectives.find((candidate) => candidate.id === reveal.objectiveId);
    if (!objective) return;
    takeReveal();
    setSelected(objective.id);
    setList("all");
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightMission(reveal.missionId ?? null);
    if (reveal.missionId) highlightTimer.current = setTimeout(() => { setHighlightMission(null); highlightTimer.current = null; }, 2400);
  }, [reveal, state.objectives]);

  // 중앙 하단 알림은 두지 않는다 — 결과는 화면 자체가 말한다(행·비콘·목록). 호출부는 남겨 두되 아무것도 띄우지 않는다.
  const toast = useCallback((_text: string, _undo?: () => Promise<void>) => undefined, []);
  const fail = useCallback((error: unknown) => {
    const code = error instanceof Error ? error.message : "unknown";
    toast(code === "objective_busy" ? t("objectives.toast.busy") : t("objectives.toast.failed", { code }));
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
  const objectiveActivity = useCallback((objective: Objective) => {
    const ids = [objective.id, ...objective.missions.flatMap((mission) => (mission.operationId ? [mission.operationId] : []))];
    return ids.map((id) => operationState(id)).filter((state) => state !== "closed").reduce((top, state) => ((URGENCY[state] ?? 9) < (URGENCY[top] ?? 9) ? state : top), "unknown" as ReturnType<typeof operationState>);
  }, [operationState]);
  // 지휘관이 일하는 동안 카드는 잠긴다 — 편집 대신 「중단」 하나만 남는다(서버도 같은 기준으로 거절한다).
  // 담당의 활동은 잠그지 않고, 지휘관이 사람을 기다리는(awaiting) 동안도 잠그지 않는다 — 그때는 사람이 손을 대야 한다.
  const isBusy = useCallback((objective: Objective): boolean => !objective.done && WORKING.has(operationState(objective.id)), [operationState]);
  // 하단 한 자리의 행동 — 실패를 삼키지 않고 코드를 던진다(띠가 원인 한 줄을 보이고 글을 지킨다).
  const request = useCallback((path: string, body: Record<string, unknown>) => post<unknown>(ctx.api, path, { ...body, language }), [ctx.api, language]);
  const modeLabel = (mode: CommanderMode) => t(mode === "direct" ? "objectives.mode.direct" : mode === "coordinate" ? "objectives.mode.coordinate" : "objectives.mode.mixed");
  const stateLabel = (state: string) => t((["running", "awaiting", "idle", "background", "ended", "closed"].includes(state) ? `objectives.state.${state}` : "objectives.state.unknown") as Parameters<typeof t>[0]);

  const groupOf = (groupId: string | null): ObjectiveGroup | null => (groupId ? state.groups.find((group) => group.id === groupId) ?? null : null);
  const inList = useCallback((objective: Objective): boolean => inScope(objective, list, dueFilter), [list, dueFilter]);
  const visible = useMemo(() => state.objectives.filter((objective) => inList(objective)), [state.objectives, inList]);
  const open = useMemo(() => visible.filter((objective) => !objective.done), [visible]);
  const finished = useMemo(() => visible.filter((objective) => objective.done), [visible]);
  // 카드 패널은 그룹별 구획으로 선다 — 사이드바 그룹 순서, 미분류는 마지막. 「모두」는 목표가 없는 그룹도 빈 구획으로 보여서
  // 끌어 놓을 자리와 「+ 추가」 입구가 된다. 다른 범위는 해당 목표가 있는 그룹만 선다.
  const sections = useMemo(() => {
    type Section = { key: string; label: string | null; swatch: string | null; objectives: Objective[]; done?: boolean; request?: boolean };
    const out: Section[] = [];
    // 결정 요청 — 사람의 답을 기다리는 항목은 맨 위 한 구획으로 모인다(검토 대기·그룹 구획에서 빠진다). 요청이 선 차례로 서고, 저장된
    // 순서와 그룹은 그대로라 요청이 풀리면 원래 자리로 돌아간다. 구획 접힘과 무관하게 보여야 하므로 접지 않는다.
    const requesting = open.filter(hasDecisionRequest).sort(byRequestTime);
    if (requesting.length) out.push({ key: REQUEST_SECTION, label: t("objectives.requests.section"), swatch: null, objectives: requesting, request: true });
    // 검토 대기 — 모든 임무와 달성 기준이 끝나 사람의 완료만 남은 항목은 결정 요청 다음 한 구획으로 모인다(그룹 구획에서 빠진다). 펼침이 기본.
    const reviewing = open.filter((objective) => objective.awaitingReview && !hasDecisionRequest(objective));
    if (reviewing.length) out.push({ key: "review", label: t("objectives.objectives.review"), swatch: null, objectives: reviewing });
    const working = open.filter((objective) => !objective.awaitingReview && !hasDecisionRequest(objective));
    for (const group of state.groups) {
      const objectives = working.filter((objective) => objective.groupId === group.id);
      if (objectives.length || list === "all") out.push({ key: group.id, label: group.name, swatch: group.color, objectives });
    }
    const rest = working.filter((objective) => !groupOf(objective.groupId));
    // 미분류도 「모두」에서는 비어 있어도 선다 — 카드를 그룹에서 빼는 놓을 자리가 늘 있어야 한다.
    if (rest.length || list === "all") out.push({ key: "ungrouped", label: t("objectives.list.ungrouped"), swatch: null, objectives: rest });
    // 완료된 항목은 목록 맨 아래 「완료됨」 한 구획 — 펼쳐야 보인다.
    if (finished.length) out.push({ key: "done", label: t("objectives.objectives.done"), swatch: null, objectives: finished, done: true });
    return out;
  }, [list, open, finished, state.groups, t]);
  const openCount = (predicate: (objective: Objective) => boolean) => state.objectives.filter((objective) => !objective.done && predicate(objective)).length;
  const current = selected ? state.objectives.find((objective) => objective.id === selected) ?? null : null;
  const detailRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const objectivesRef = useRef<HTMLDivElement | null>(null);
  // 결정 요청은 범위와 무관하게 전부 센다 — 요약 줄·「다음」·상세 머리의 「다른 요청」이 같은 줄을 돈다.
  const requests = useMemo(() => state.objectives.filter(hasDecisionRequest).sort(byRequestTime), [state.objectives]);
  const requestsOutside = requests.filter((objective) => !inList(objective)).length;
  /** 이 목표가 서는 구획 — 목록의 구획 규칙(sections)과 같은 순서로 판정한다. */
  const sectionKeyOf = (objective: Objective): string => objective.done ? "done" : hasDecisionRequest(objective) ? REQUEST_SECTION : objective.awaitingReview ? "review" : groupOf(objective.groupId) ? objective.groupId! : "ungrouped";
  const unfold = (collapsedNow: Readonly<Record<string, boolean>>, key: string) => (collapsedNow[key] ? { ...collapsedNow, [key]: false } : collapsedNow);
  /**
   * 목록 칸 안에서만 가장 가까운 끝으로 굴린다(scrollIntoView 의 block: "nearest" 와 같은 셈) — scrollIntoView 는 레일 카드·확대 표면·
   * 페이지처럼 넘침을 숨긴 조상까지 굴릴 수 있다. 확대 표면은 transform 조상이라 화면 거리를 표면 배율로 나눈다.
   */
  const scrollRowIntoList = (objectiveId: string) => {
    const listNode = objectivesRef.current;
    const row = listNode?.querySelector<HTMLElement>(`.objectives-objective[data-objective-id="${CSS.escape(objectiveId)}"]`);
    if (!listNode || !row) return;
    const box = listNode.getBoundingClientRect();
    const scale = listNode.offsetHeight ? box.height / listNode.offsetHeight : 1;
    const rect = row.getBoundingClientRect();
    const top = (rect.top - box.top) / (scale || 1) - listNode.clientTop;
    const bottom = (rect.bottom - box.top) / (scale || 1) - listNode.clientTop;
    if (top < 0) listNode.scrollTop += top - 6;
    else if (bottom > listNode.clientHeight) listNode.scrollTop += bottom - listNode.clientHeight + 6;
  };
  const scrollRowSoon = (objectiveId: string) => requestAnimationFrame(() => requestAnimationFrame(() => scrollRowIntoList(objectiveId)));
  /**
   * 「다음」·「다른 요청」 — 요청이 선 차례대로 다음 목표를 고른다(고른 목표가 요청이 아니면 첫 요청). 대상이 지금 범위 밖이면 「모두」로
   * 바꾸고, 대상이 든 구획이 접혀 있으면 펼친 뒤 목록 칸 안에서 짚는다. 누를 때마다 다음 요청으로 돌고, 끝에서 처음으로 돌아간다.
   */
  const openNextRequest = () => {
    if (requests.length === 0) return;
    const at = requests.findIndex((objective) => objective.id === selected);
    const target = requests[(at + 1) % requests.length]!;
    patchObjectiveView(theaterId, (view) => ({
      ...(inScope(target, (LISTS as readonly string[]).includes(view.list) ? view.list as ListId : "all", view.dueFilter as DueFilter) ? {} : { list: "all" }),
      collapsed: unfold(view.collapsed, sectionKeyOf(target)),
      selected: target.id,
      externalSelectionId: null,
    }));
    scrollRowSoon(target.id);
  };
  // 입력줄의 「열기」는 그 목표가 남아 있고 아직 아무것도 고르지 않은 동안만 선다.
  useEffect(() => { if (selected) setAddedId(null); }, [selected]);
  const added = addedId ? state.objectives.find((objective) => objective.id === addedId) ?? null : null;
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
    requestAnimationFrame(() => { if (id) objectivesRef.current?.querySelector<HTMLElement>(`.objectives-objective[data-objective-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }); });
  };

  const listTitle = t(`objectives.list.${list}`);
  const listCount = (id: ListId) => openCount((objective) => id === "today" ? objective.today : id === "due" ? !!objective.dueDate : id === "agent" ? !!objective.addedBy : true);

  // ── 행동 ──
  const completeObjective = async (objective: Objective) => {
    if (objective.done) { await call("/objective/complete", { objectiveId: objective.id, undone: true }); toast(t("objectives.toast.reopened")); return; }
    const result = await call("/objective/complete", { objectiveId: objective.id });
    if (result) toast(t("objectives.toast.completed"), async () => { await call("/objective/complete", { objectiveId: objective.id, undone: true }); });
  };
  /**
   * 목록·머리의 즉시 완료 체크 — open 후보가 1건 이상이면 상태와 관계없이 완료하지 않고 상세를 연다.
   * 편집 없는 검토 대기면 후보 칸까지 펼치고 첫 체크상자로 초점을 주고, 스티어링 대상 편집이면
   * 상세만 열어 띠의 「스티어링」에 초점을 준다. 후보가 없으면 기존처럼 바로 완료한다.
   */
  const openCandidateCount = (target: Objective): number => (target.done ? 0 : openFollowups(target).length);
  const openFollowupPicker = (target: Objective) => {
    const n = openCandidateCount(target);
    setSelected(target.id);
    if (n > 0 && isFollowupSelectable(target)) {
      setFollowupOpen(target.id, true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-followup-comp="${CSS.escape(target.id)}"] [data-followup-sel]`)?.focus();
        });
      });
    } else if (n > 0 && followupGate(target) === "steer") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(".objectives-detail-bottom .objectives-start")?.focus();
        });
      });
    } else if (n > 0) {
      // 읽기용 보기(openTip) — 상세가 이미 열려 있어도 접힌 구획을 펴고 머리까지 스크롤·포커스해 반응을 보인다.
      patchObjectiveView(theaterId, (view) => ({ collapsed: { ...view.collapsed, "detail:followups": false } }));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const head = document.querySelector<HTMLElement>('[aria-controls="objectives-sec-followups"]');
          head?.scrollIntoView({ block: "nearest" });
          head?.focus();
        });
      });
    }
  };
  const followupTip = (target: Objective, n: number): string => {
    if (isFollowupSelectable(target)) return t("objectives.followup.listTip", { n });
    if (followupGate(target) === "steer") return t("objectives.followup.steerTip", { n });
    return t("objectives.followup.openTip", { n });
  };
  /** 배치 결과·출처에서 목표 상세를 연다 — 목록에 없는 id(지워진 원본 등)는 두지 않는다. */
  const openObjectiveDetail = (operationId: string) => {
    if (state.objectives.some((entry) => entry.id === operationId)) setSelected(operationId);
  };
  /**
   * 목표 추가 — 응답의 목표를 로컬 스토어에 먼저 들인 뒤 고른다(선택이 먼저면 「사라진 선택 정리」가 되돌린다). 새 목표를 숨기는
   * 범위는 푼다: 「에이전트가 남김」은 「모두」로, 기한 세부 칩은 칩만 「모두」로. 든 구획이 접혀 있으면 펼친다. 넓은 표면에서는 새
   * 목표의 상세를 바로 열고, 한 열에서는 상세가 입력줄을 덮지 않게 행 강조와 「열기」만 보인다. 초점은 입력칸에 남는다.
   * 추가는 사람의 행동이라 편집 중 보류를 타지 않고, 보류해 둔 외부 선택은 버린다.
   */
  const addObjective = async (raw: string) => {
    const title = raw.trim();
    if (!title || !theaterId) return;
    const groupId = addGroupId && groupOf(addGroupId) ? addGroupId : null;
    const result = await call<{ objective: Objective }>("/objective/create", { theaterId, groupId, title, viewMode: nextView, today: list === "today", dueDate: list === "due" ? todayIso() : null });
    const created = result?.objective;
    if (!created || created.theaterId !== theaterId) return;
    upsertObjectiveLocally(created);
    discardPendingSelection();
    const wide = (rootRef.current?.clientWidth ?? rootWidth) >= ONE_COLUMN_BELOW;
    patchObjectiveView(theaterId, (view) => {
      let nextList: ListId = (LISTS as readonly string[]).includes(view.list) ? view.list as ListId : "all";
      let nextDue = view.dueFilter as DueFilter;
      if (!inScope(created, nextList, nextDue)) {
        if (nextList === "due" && created.dueDate) nextDue = "all";
        else nextList = "all";
      }
      return { list: nextList, dueFilter: nextDue, collapsed: unfold(view.collapsed, sectionKeyOf(created)), ...(wide ? { selected: created.id, externalSelectionId: null } : {}) };
    });
    setAddedId(wide ? null : created.id);
    if (objectiveHighlightTimer.current) clearTimeout(objectiveHighlightTimer.current);
    setHighlightObjective(created.id);
    objectiveHighlightTimer.current = setTimeout(() => { setHighlightObjective(null); objectiveHighlightTimer.current = null; }, ADDED_HIGHLIGHT_MS);
    scrollRowSoon(created.id);
  };
  const toggleEdge = async (objective: Objective, from: string, to: string) => {
    const result = await call<{ objective: Objective; linked: boolean }>("/edge/toggle", { objectiveId: objective.id, from, to });
    if (!result) return;
    const index = (id: string) => objective.missions.findIndex((mission) => mission.id === id) + 1;
    toast(t(result.linked ? "objectives.toast.linkedEdge" : "objectives.toast.cutEdge", { from: index(from), to: index(to) }));
  };

  /** 같은 구획 안에서 커서 높이에 맞는 삽입 자리 — 카드의 가운데보다 위면 그 앞, 끝을 지나면 마지막 카드 뒤. 제자리면 없다. */
  const insertAt = (x: number, y: number, objectiveId: string, sectionKey: string): Insert | null => {
    // 완료됨과 결정 요청은 정해진 순서(완료·요청 차례)로 선다 — 그 안의 끌기는 순서를 바꾸지 않는다.
    if (sectionKey === "done" || sectionKey === REQUEST_SECTION) return null;
    const section = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-section]");
    if (!section || section.dataset.section !== sectionKey) return null;
    const ids = [...section.querySelectorAll<HTMLElement>("[data-objective-id]")].map((card) => ({ id: card.dataset.objectiveId!, rect: card.getBoundingClientRect() }));
    const others = ids.filter((card) => card.id !== objectiveId);
    if (others.length === 0) return null;
    const next = others.find((card) => y < card.rect.top + card.rect.height / 2);
    const insert: Insert = next ? { anchorId: next.id, place: "before" } : { anchorId: others[others.length - 1]!.id, place: "after" };
    const from = ids.findIndex((card) => card.id === objectiveId);
    const anchor = ids.findIndex((card) => card.id === insert.anchorId);
    return (insert.place === "before" ? anchor === from + 1 : anchor === from - 1) ? null : insert;
  };
  const reorder = async (objective: Objective, insert: Insert) => {
    await call("/objective/move", { objectiveId: objective.id, ...(insert.place === "before" ? { beforeId: insert.anchorId } : { afterId: insert.anchorId }) });
  };
  /** 놓을 자리 — 범위 낱말이나 다른 그룹 구획. 잡은 카드의 구획 위는 자리가 아니다(그 안에서는 순서를 바꾼다). */
  const dropTargetAt = (x: number, y: number, fromSection: string): DropTarget | null => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-list]");
    if (!hit || hit.dataset.section === fromSection) return null;
    return (hit.dataset.dropList as DropTarget | undefined) ?? null;
  };
  const moveTo = async (objective: Objective, target: DropTarget) => {
    const patch: Record<string, unknown> = target === "today" ? { today: true }
      : target === "due" ? { dueDate: objective.dueDate ?? todayIso() }
      : target === "ungrouped" ? { groupId: null }
      : target.startsWith("group:") ? { groupId: target.slice(6) } : {};
    if (Object.keys(patch).length === 0) return;
    const result = await call("/objective/patch", { objectiveId: objective.id, patch });
    if (!result) return;
    const name = target === "today" ? t("objectives.list.today") : target === "due" ? t("objectives.list.due") : target === "ungrouped" ? t("objectives.list.ungrouped") : groupOf(target.slice(6))?.name ?? "";
    toast(t("objectives.toast.moved", { list: name }));
  };
  const onItemPointerDown = (event: ReactPointerEvent<HTMLDivElement>, objective: Objective, sectionKey: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, a")) return;
    // 지휘관이 일하는 동안에도 순서는 바꿀 수 있다(내용이 아니다). 목록 옮기기는 편집이라 그때는 잠긴다.
    const busy = isBusy(objective);
    // 잡은 지점을 기억한다 — 유령은 커서 옆이 아니라 손에 잡힌 그 자리에 그대로 붙어 따라온다.
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { objectiveId: objective.id, section: sectionKey, startX: event.clientX, startY: event.clientY, live: false, over: null, insert: null, offX: event.clientX - rect.left, offY: event.clientY - rect.top, width: rect.width };
    const onMove = (move: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.live) {
        if (Math.hypot(move.clientX - state.startX, move.clientY - state.startY) < 6) return;
        state.live = true;
        suppressClick.current = true;
      }
      state.over = busy ? null : dropTargetAt(move.clientX, move.clientY, state.section);
      state.insert = state.over ? null : insertAt(move.clientX, move.clientY, state.objectiveId, state.section);
      // 범위 낱말 줄에 들어오면 놓을 자리가 잡히기 전에도 카드가 표로 줄어든다 — 낱말이 카드 아래 가려지지 않게.
      const compact = !!document.elementFromPoint(move.clientX, move.clientY)?.closest(".objectives-scope");
      setDrag({ objectiveId: state.objectiveId, x: move.clientX, y: move.clientY, over: state.over, insert: state.insert, offX: state.offX, offY: state.offY, width: state.width, compact });
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
      if (state?.live && state.over) void moveTo(objective, state.over);
      else if (state?.live && state.insert) void reorder(objective, state.insert);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  const dragObjective = drag ? state.objectives.find((objective) => objective.id === drag.objectiveId) ?? null : null;

  const onItemKey = (event: ReactKeyboardEvent<HTMLDivElement>, objective: Objective, index: number, sectionKey: string) => {
    const rows = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".objectives-objective") ?? [])];
    // Alt+Shift+↑/↓ — 끌기의 키보드 짝(사이드바 칩 재정렬과 같은 조합; Alt+화살표는 Console 이 포커스 순환에 예약했다).
    // 같은 구획의 이웃 카드와 자리를 바꾸고 초점은 옮긴 카드에 남는다.
    if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (sectionKey === "done" || sectionKey === REQUEST_SECTION) return;
      const at = rows.indexOf(event.currentTarget);
      const neighbor = rows[event.key === "ArrowUp" ? at - 1 : at + 1]?.dataset.objectiveId;
      if (neighbor) void reorder(objective, { anchorId: neighbor, place: event.key === "ArrowUp" ? "before" : "after" });
      return;
    }
    if (event.key === " ") { event.preventDefault(); if (!isBusy(objective)) { if (openCandidateCount(objective) > 0) openFollowupPicker(objective); else void completeObjective(objective); } }
    else if (event.key === "Enter") { setSelected(objective.id); }
    else if (event.key === "ArrowDown") { event.preventDefault(); rows[index + 1]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); rows[index - 1]?.focus(); }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && selected && !document.querySelector(".objectives-cal, .objectives-zoom-backdrop, .objectives-menu")) closeDetail(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!theaterId) return <div className="objectives-container"><div className="objectives-root"><div className="objectives-main"><div className="objectives-empty">{t("objectives.objectives.emptyTheater")}</div></div></div></div>;

  const addGroup = addGroupId ? groupOf(addGroupId) : null;
  // 두 자리 모두 상세가 서면 폭을 조절한다(600 미만의 한 열에서는 CSS 가 손잡이를 거둔다). 표면이 좁아지면 저장한 폭은 두고
  // 보이는 폭만 줄인다.
  const sized = !!current;
  const detailMax = Math.max(split.detailMin, Math.min(split.detailMax, rootWidth - split.mainMin));
  const shownDetail = Math.max(split.detailMin, Math.min(detailWidth ?? split.fallback(rootWidth), detailMax));
  // 세 칸은 자리(레일·확대)가 아니라 목표 표면의 실제 안쪽 폭으로만 판정한다.
  const three = sized && rootWidth >= THREE_PANE.threshold;
  const threeShown = three ? shownThreeWidths(rootWidth, threeWidths) : null;
  const setThree = (patch: Partial<ThreeWidths>, save: boolean) => setThreeWidths((current) => { const next = { ...current, ...patch }; if (save) saveThreeWidths(next); return next; });
  const rootStyle = threeShown ? { "--objectives-list-w": `${threeShown.list}px`, "--objectives-detail-w": `${threeShown.ops}px` } as CSSProperties : sized ? { "--objectives-detail-w": `${shownDetail}px` } as CSSProperties : undefined;
  const pickAddGroup = (groupId: string) => { setAddGroupId(groupId); requestAnimationFrame(() => addInputRef.current?.focus()); };
  return (
    // 온보딩 경계(SDK 계약) — 투어 카드가 패널을 가리지 않고 패널 옆, 짚는 구획 높이에 선다(레일이든 넓은 화면이든
    // 자리가 없으면 앵커 기준 배치로 돌아간다).
    <div className="objectives-container" {...onboardingBoundary("anchor")} onPointerDownCapture={(event) => {
      if (highlightMission && !(event.target as Element).closest(`[data-mission-id="${CSS.escape(highlightMission)}"]`)) {
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
        setHighlightMission(null);
      }
    }}><div ref={rootRef} className={`objectives-root${current ? " has-detail" : ""}${three ? " is-three" : ""}${resizing ? " is-resizing" : ""}`} style={rootStyle}>
      {threeShown ? <>
        <PaneGrip side="list" label={t("objectives.detail.listWidth")} tip={t("objectives.detail.widthTip")} width={threeShown.list} min={THREE_PANE.list.min} max={threeShown.listMax} fallback={THREE_PANE.list.fallback} rootRef={rootRef} onResize={(list, save) => setThree({ list }, save)} onResizing={setResizing} />
        <PaneGrip side="ops" label={t("objectives.detail.opsWidth")} tip={t("objectives.detail.widthTip")} width={threeShown.ops} min={THREE_PANE.ops.min} max={threeShown.opsMax} fallback={THREE_PANE.ops.fallback} rootRef={rootRef} onResize={(ops, save) => setThree({ ops }, save)} onResizing={setResizing} />
      </> : sized ? <DetailGrip t={t} split={split} width={shownDetail} max={detailMax} rootRef={rootRef} onResize={setDetailWidth} onResizing={setResizing} /> : null}
      <section ref={mainRef} className="objectives-main">
        <div className="objectives-title">
          <ScopeWords current={list} onPick={setList} t={t} count={listCount} dropOver={drag?.over ?? null} />
          {placeButton("objectives-place-main")}
        </div>
        {list === "due" ? (
          <div className="objectives-chips">
            {(["all", "overdue", "today", "week", "later"] as const).map((bucket) => (
              <button key={bucket} type="button" className="objectives-chip" aria-pressed={dueFilter === bucket} onClick={() => setDueFilter(bucket)}>{t(bucket === "all" ? "objectives.due.all" : bucket === "overdue" ? "objectives.due.overdue" : bucket === "today" ? "objectives.due.today" : bucket === "week" ? "objectives.due.week" : "objectives.due.later")}</button>
            ))}
          </div>
        ) : null}
        {/* 결정 요청 요약 — 범위·스크롤·구획 접힘과 무관하게 목록 위에 늘 선다. 요청이 없으면 줄도 없다. */}
        {requests.length ? (
          <div className="objectives-requests">
            <RequestGlyph />
            <span>{t("objectives.requests.summary", { count: requests.length })}</span>
            {requestsOutside ? <span className="objectives-requests-outside">{t("objectives.requests.outside", { count: requestsOutside })}</span> : null}
            <button type="button" className="objectives-requests-next" title={t("objectives.requests.nextTip")} onClick={openNextRequest}>{t("objectives.requests.next")}</button>
          </div>
        ) : null}
        <div ref={objectivesRef} className="objectives-objectives" role="listbox" aria-label={listTitle} data-objectives-tour="list">
          {open.length === 0 && finished.length === 0 ? <div className="objectives-empty">{t("objectives.objectives.empty")}</div> : null}
          {sections.map((section) => { const expanded = section.request || isOpen(section.key, !section.done); const group = groupOf(section.key); const dropKey: DropTarget | null = group ? `group:${group.id}` : section.key === "ungrouped" ? "ungrouped" : null; return (<div key={section.key} data-section={section.key} {...(dropKey ? { "data-drop-list": dropKey } : {})} className={`objectives-section${section.done ? " is-done" : ""}${section.request ? " is-request" : ""}${expanded ? "" : " is-collapsed"}${dropKey && drag?.over === dropKey ? " is-drop" : ""}`}>
          {section.label && section.request ? <div className="objectives-section-row"><span className="objectives-section-hd is-request"><span className="objectives-section-chev" aria-hidden="true"><RequestGlyph /></span><span className="objectives-section-name">{section.label}</span><span className="objectives-count">{section.objectives.length}</span></span></div>
          : section.label ? <div className="objectives-section-row"><button type="button" className="objectives-section-hd" aria-expanded={expanded} onClick={() => toggleSection(section.key, !section.done)}><span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>{section.swatch ? <span className="objectives-swatch" style={{ background: `var(--id-${section.swatch}, var(--text-tertiary))` }} aria-hidden="true" /> : null}<span className="objectives-section-name">{section.label}</span><span className="objectives-count">{section.objectives.length}</span></button>
            {group ? <button type="button" className="objectives-section-add" aria-label={t("objectives.section.addTo", { name: group.name })} title={t("objectives.section.addTo", { name: group.name })} onClick={() => pickAddGroup(group.id)}>+ {t("objectives.section.add")}</button> : null}</div> : null}
          {expanded && dropKey && section.objectives.length === 0 ? <div className="objectives-section-empty">{t(group ? "objectives.section.empty" : "objectives.section.emptyUngrouped")}</div> : null}
          {expanded ? section.objectives.map((objective) => {
            // 방향키 이웃은 같은 구획의 카드 행 기준 — 검토 대기가 빠져나가면 visible 순서와 구획 안 순서가 어긋난다.
            const index = section.objectives.indexOf(objective);
            const mode = commanderMode(objective.missions);
            // 결정 요청 구획의 행은 원래 그룹을 칩으로 말한다 — 요청이 풀리면 그 구획으로 돌아간다.
            const showGroup = section.request ? groupOf(objective.groupId) : null;
            const busy = isBusy(objective);
            return (
              <div key={objective.id} data-objective-id={objective.id} className={`objectives-objective${objective.done ? " is-done" : ""}${busy ? " is-busy" : ""}${highlightObjective === objective.id ? " is-highlight" : ""}${drag?.objectiveId === objective.id ? " is-lifted" : ""}${drag?.insert?.anchorId === objective.id ? ` is-insert-${drag.insert.place}` : ""}`} role="option" aria-selected={selected === objective.id} tabIndex={0}
                onPointerDown={(event) => onItemPointerDown(event, objective, section.key)}
                onClick={() => { if (suppressClick.current) return; setSelected((value) => (value === objective.id ? null : objective.id)); }} onKeyDown={(event) => onItemKey(event, objective, index, section.key)}>
                {/* 동그라미 = 완료 버튼이자 상태. 지휘관이 연결돼 있으면 묶음에서 가장 급한 활동을 고리로 보이고, 일하는 동안은 누르지 못한다. 완료는 늘 사람의 몫이다. */}
                {/* 검토 대기 — 모든 임무와 기준이 끝난 상태. 고리는 사람의 완료 버튼이 된다. */}
                {objective.awaitingReview && !objective.done
                  ? (() => { const followups = openCandidateCount(objective); const tip = followups > 0 ? followupTip(objective, followups) : t("objectives.review.tip"); return (
                    <span className="objectives-check-tip"><button type="button" className="objectives-check is-linked is-review" aria-label={tip} onClick={(event) => { event.stopPropagation(); if (followups > 0) openFollowupPicker(objective); else void completeObjective(objective); }}><i aria-hidden="true" /></button><span className="objectives-check-bubble" aria-hidden="true">{tip}</span></span>
                  ); })()
                  // 인계 대기 — 아직 지휘관의 차례다. 활동 고리는 그대로 보이고, 누르면 완료 대신 상세를 연다(서버도 완료를 거절한다).
                  : objective.awaitingHandoff && !objective.done
                  ? (() => { const state = objectiveActivity(objective); const tip = t("objectives.handoff.tip"); return (
                    <span className="objectives-check-tip"><button type="button" className={`objectives-check is-linked is-${state} is-handoff`} aria-label={tip} onClick={(event) => { event.stopPropagation(); setSelected(objective.id); }}><i aria-hidden="true" /></button><span className="objectives-check-bubble" aria-hidden="true">{tip}</span></span>
                  ); })()
                  : !objective.done && objective.commander.started && operationState(objective.id) !== "closed"
                  ? (() => { const state = objectiveActivity(objective); const followups = openCandidateCount(objective); const tip = followups > 0 && !busy ? followupTip(objective, followups) : t(busy ? "objectives.objective.linkedBusyTip" : "objectives.objective.linkedTip", { state: stateLabel(state) }); return (
                    <span className="objectives-check-tip">
                      <button type="button" className={`objectives-check is-linked is-${state}`} aria-label={tip} disabled={busy} onClick={(event) => { event.stopPropagation(); if (followups > 0) openFollowupPicker(objective); else void completeObjective(objective); }}><i aria-hidden="true" /></button>
                      <span className="objectives-check-bubble" aria-hidden="true">{tip}</span>
                    </span>
                  ); })()
                  : (() => { const followups = openCandidateCount(objective); const label = objective.done ? t("objectives.objective.reopen") : followups > 0 && !busy ? followupTip(objective, followups) : t("objectives.objective.complete"); return (
                    <button type="button" className={`objectives-check${objective.done ? " is-on" : ""}`} aria-label={label} disabled={busy} onClick={(event) => { event.stopPropagation(); if (followups > 0 && !objective.done) openFollowupPicker(objective); else void completeObjective(objective); }}><CheckGlyph /></button>
                  ); })()}
                <div className="objectives-objective-body">
                  <div className="objectives-objective-title">{objective.title}</div>
                  <div className="objectives-objective-meta">
                    {objective.missions.length ? <span>✓ {objective.missions.filter((mission) => mission.done).length}/{objective.missions.length}</span> : null}
                    {objective.awaitingHandoff && !objective.done ? <span className="objectives-objective-handoff">{t("objectives.handoff.label")}</span> : null}
                    {objective.decisionRequest && !objective.done ? <span className="objectives-objective-request"><RequestGlyph />{t("objectives.decision.label")}{objective.decisionRequest.questions.length > 1 ? <em>{t("objectives.decision.labelMany", { count: objective.decisionRequest.questions.length })}</em> : null}</span> : null}
                    {objective.dueDate ? <span className={`objectives-objective-due${objective.dueDate < todayIso() && !objective.done ? " is-overdue" : ""}`}><CalGlyph />{dueLabel(objective.dueDate, language)}</span> : null}
                    {showGroup ? <span className="objectives-objective-group"><span className="objectives-swatch" style={{ background: `var(--id-${showGroup.color}, var(--text-tertiary))` }} aria-hidden="true" />{showGroup.name}</span> : null}
                    {objective.addedBy ? (() => { const name = objective.addedBy.title ?? "—"; const label = t("objectives.objective.addedBy", { name }); return <span className="objectives-by" title={label}><span className="objectives-by-name" aria-hidden="true">{name}</span><span className="objectives-by-sr">{label}</span></span>; })() : null}
                  </div>
                </div>
                <div className="objectives-objective-side">
                  <LaunchWords objective={objective} t={t} rows={launchRows} autoLabel={t("objectives.commander.effortAuto")} defaultLabel={t("objectives.launch.default")} state={objective.commander.started ? operationState(objective.id) : null} />
                  {!!operationOf(objective.id) ? <button type="button" className="objectives-glyph objectives-goto" aria-label={t("objectives.objective.goToOperation")} title={t("objectives.objective.goToOperation")} onClick={(event) => { event.stopPropagation(); focusOperation(objective.id); }}><GoGlyph /></button> : null}
                </div>
              </div>
            );
          }) : null}
          </div>); })}
        </div>
        <div className="objectives-add" data-objectives-tour="add">
          <span className="objectives-plus" aria-hidden="true">+</span>
          <input ref={addInputRef} aria-label={addGroup ? t("objectives.add.into", { name: addGroup.name }) : t("objectives.objectives.add")} placeholder={t("objectives.objectives.add")} onKeyDown={(event) => { if (submitKey(event)) { const target = event.currentTarget; void addObjective(target.value).then(() => { target.value = ""; }); } else if (event.key === "Escape" && addGroup) { event.preventDefault(); setAddGroupId(null); } }} />
          {added && !current ? <span className="objectives-add-added" role="status"><span>{t("objectives.add.added")}</span><button type="button" className="objectives-add-open" aria-label={t("objectives.add.openTip", { title: added.title })} title={t("objectives.add.openTip", { title: added.title })} onClick={() => setSelected(added.id)}>{t("objectives.add.open")}</button></span> : null}
          {addGroup ? <span className="objectives-add-target"><span className="objectives-swatch" style={{ background: `var(--id-${addGroup.color}, var(--text-tertiary))` }} aria-hidden="true" /><span>{t("objectives.add.into", { name: addGroup.name })}</span><button type="button" className="objectives-add-target-clear" aria-label={t("objectives.add.clear")} title={t("objectives.add.clear")} onClick={() => { setAddGroupId(null); addInputRef.current?.focus(); }}>×</button></span> : null}
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
        <ObjectiveDetail
          key={current.id}
          objective={current}
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
          highlightMission={highlightMission}
          onClose={closeDetail}
          detailRef={detailRef}
          layout={three ? "three" : "split"}
          placeButton={placeButton("objectives-place-detail")}
          onComplete={() => completeObjective(current)}
          onToggleEdge={(from, to) => toggleEdge(current, from, to)}
          onOpenObjective={openObjectiveDetail}
          otherRequests={requests.filter((objective) => objective.id !== current.id).length}
          onNextRequest={openNextRequest}
        />
      ) : null}
      {/* 유령은 body 포털 — 확대 표면은 transform 조상이라 fixed 가 그 안에서 어긋난다. */}
      {drag && dragObjective ? createPortal(
        // 놓을 자리(범위 낱말·다른 그룹 구획·카드 사이)가 잡히면 유령은 표로 줄어 커서 오른쪽 아래로 비킨다 — 카드 크기로 커서에 붙어 있으면 그 자리를 덮는다.
        <div className={`objectives-drag-ghost${drag.over || drag.insert ? " is-over" : ""}${drag.compact || drag.over || drag.insert ? " is-compact" : ""}`} style={drag.compact || drag.over || drag.insert ? { left: drag.x + 14, top: drag.y + 12, width: 224 } : { left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.width }} aria-hidden="true">
          <span className={`objectives-check${dragObjective.done ? " is-on" : ""}`}><CheckGlyph /></span>
          <span className="objectives-drag-title">{dragObjective.title}</span>
          <span className="objectives-drag-hint">{drag.over ? "↓" : drag.insert ? "↕" : t("objectives.drag.hint")}</span>
        </div>,
        document.body,
      ) : null}
    </div></div>
  );
}

/**
 * 상세 패널 폭 손잡이 — 상세의 왼쪽 가장자리. 끌기·←/→(Shift 는 크게)·Home/End 로 바꾸고 두 번 누르면 기본 폭으로 돌아간다.
 * 한도와 기억은 자리(split)가 정한다. 움직이지 않은 누름은 기억하지 않는다 — 레일은 기억이 없는 동안 표면 폭을 따르므로,
 * 클릭 한 번이 그 순간의 폭을 박제하면 안 된다.
 * 확대 표면은 transform 조상이라 화면 거리와 CSS 거리가 다를 수 있어 끌기는 표면의 배율로 나눈다.
 */
function DetailGrip({ t, split, width, max, rootRef, onResize, onResizing }: { t: T; split: DetailSplit; width: number; max: number; rootRef: RefObject<HTMLDivElement | null>; onResize: (width: number | null) => void; onResizing: (value: boolean) => void }) {
  const clamp = (value: number) => Math.round(Math.max(split.detailMin, Math.min(max, value)));
  const commit = (value: number | null) => { const next = value === null ? null : clamp(value); onResize(next); saveDetailWidth(split, next); };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const root = rootRef.current;
    const scale = root && root.offsetWidth ? root.getBoundingClientRect().width / root.offsetWidth : 1;
    const startX = event.clientX;
    const startWidth = width;
    let last = startWidth;
    onResizing(true);
    const onMove = (move: PointerEvent) => { last = clamp(startWidth - (move.clientX - startX) / (scale || 1)); onResize(last); };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      onResizing(false);
      if (last !== startWidth) saveDetailWidth(split, last);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step : event.key === "Home" ? max : event.key === "End" ? split.detailMin : null;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };
  return (
    <div className="objectives-detail-grip" role="separator" aria-orientation="vertical" aria-label={t("objectives.detail.width")} title={t("objectives.detail.widthTip")} aria-valuemin={split.detailMin} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
      onPointerDown={onPointerDown} onDoubleClick={() => commit(split.reset)} onKeyDown={onKeyDown} />
  );
}

/**
 * 세 칸의 폭 손잡이 — 모양과 키는 상세 손잡이와 같다. 목록 칸은 오른쪽 가장자리(끌어 오른쪽이 넓힘, → 가 넓힘),
 * 운영·판단 칸은 왼쪽 가장자리(끌어 왼쪽이 넓힘, ← 가 넓힘). Home 은 최대, End 는 최소, 두 번 누르면 기본 폭.
 * 움직이지 않은 누름은 기억하지 않는다. 확대 표면의 transform 배율로 끌기 거리를 나눈다.
 */
function PaneGrip({ side, label, tip, width, min, max, fallback, rootRef, onResize, onResizing }: { side: "list" | "ops"; label: string; tip: string; width: number; min: number; max: number; fallback: number; rootRef: RefObject<HTMLDivElement | null>; onResize: (width: number, save: boolean) => void; onResizing: (value: boolean) => void }) {
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)));
  const grow = side === "list" ? 1 : -1;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const root = rootRef.current;
    const scale = root && root.offsetWidth ? root.getBoundingClientRect().width / root.offsetWidth : 1;
    const startX = event.clientX;
    const startWidth = width;
    let last = startWidth;
    onResizing(true);
    const onMove = (move: PointerEvent) => { const next = clamp(startWidth + grow * (move.clientX - startX) / (scale || 1)); if (next !== last) { last = next; onResize(last, false); } };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      onResizing(false);
      if (last !== startWidth) onResize(last, true);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const wider = side === "list" ? "ArrowRight" : "ArrowLeft";
    const narrower = side === "list" ? "ArrowLeft" : "ArrowRight";
    const next = event.key === wider ? width + step : event.key === narrower ? width - step : event.key === "Home" ? max : event.key === "End" ? min : null;
    if (next === null) return;
    event.preventDefault();
    // 이미 한계에 닿아 폭이 그대로면 기억을 덮지 않는다 — 표면이 좁아 줄여 보이던 폭이 기억한 선호를 지우지 않게.
    if (clamp(next) !== width) onResize(clamp(next), true);
  };
  return (
    <div className={`objectives-detail-grip${side === "list" ? " is-list" : ""}`} role="separator" aria-orientation="vertical" aria-label={label} title={tip} aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} tabIndex={0}
      onPointerDown={onPointerDown} onDoubleClick={() => onResize(fallback, true)} onKeyDown={onKeyDown} />
  );
}

const SCOPE_GLYPH: Record<ListId, string> = { today: "☀", due: "", all: "∞", agent: "◌" };
/**
 * 범위 낱말 — 오늘·기한·모두·에이전트가 남김이 제목 줄에 늘 같은 자리로 선다. 상자도 채움도 없이 고른 낱말만 진해지고 얇은 밑줄이
 * 깔린다(탭 목록: ←/→·Home/End 로 옮기면 바로 고른다). 오늘·기한은 카드를 끌어 놓을 자리이기도 하다.
 */
function ScopeWords({ current, onPick, t, count, dropOver }: { current: ListId; onPick: (id: ListId) => void; t: T; count: (id: ListId) => number; dropOver: DropTarget | null }) {
  const refs = useRef<Partial<Record<ListId, HTMLButtonElement | null>>>({});
  const onKey = (event: ReactKeyboardEvent<HTMLButtonElement>, id: ListId) => {
    const at = LISTS.indexOf(id);
    const next = event.key === "ArrowRight" ? LISTS[(at + 1) % LISTS.length] : event.key === "ArrowLeft" ? LISTS[(at - 1 + LISTS.length) % LISTS.length] : event.key === "Home" ? LISTS[0] : event.key === "End" ? LISTS[LISTS.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    onPick(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="objectives-scope" role="tablist" aria-label={t("objectives.scope.label")} data-objectives-tour="scope">
      {LISTS.map((id) => (
        <button key={id} ref={(node) => { refs.current[id] = node; }} type="button" role="tab" className={`objectives-scope-word${dropOver === id ? " is-drop" : ""}`} aria-selected={current === id} tabIndex={current === id ? 0 : -1} title={t(`objectives.sub.${id}`)} onClick={() => onPick(id)} onKeyDown={(event) => onKey(event, id)} {...(id === "today" || id === "due" ? { "data-drop-list": id } : {})}>
          {SCOPE_GLYPH[id] ? <span className="objectives-scope-glyph" aria-hidden="true">{SCOPE_GLYPH[id]}</span> : null}
          <span>{t(`objectives.list.${id}`)}</span>
          <span className="objectives-count">{count(id)}</span>
        </button>
      ))}
    </div>
  );
}

/** 카드 오른쪽의 지휘관 모델·강도 — 지휘관 Operation 의 값. 살아 있으면 점이 켜진다. */
function LaunchWords({ objective, t, rows, autoLabel, defaultLabel, state }: { objective: Objective; t: T; rows: ReturnType<typeof useLaunchRows>; autoLabel: string; defaultLabel: string; state: string | null }) {
  // 모델이 비어 있으면 Console 기본값으로 뜨는 Operation 이다(사이드바에서 따로 만든 것).
  const words = !objective.commander.model
    ? { model: defaultLabel, effort: objective.commander.effort?.toUpperCase() ?? autoLabel }
    : launchWords(rows, objective.commander.model, objective.commander.effort, autoLabel);
  return (
    <span className={`objectives-objective-launch${state ? ` is-${state}` : ""}`} title={`${words.model} · ${words.effort}`}>
      {objective.commander.viewMode === "chat" ? <span className="objectives-objective-view" role="img" aria-label={startViewLabel(t, "chat")} title={startViewLabel(t, "chat")}><StartViewGlyph view="chat" /></span> : null}
      <span className="objectives-objective-model">{words.model}</span>
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
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  if (launched) {
    const running = launchedWords(rows, member.model, member.effort, labels);
    return { text: <LaunchedText model={running.model} words={running.words} />, title: running.title, label: `${running.words.model} · ${running.words.effort}` };
  }
  if (member.launch.mode === "route") return { text: <span className="objectives-launch-model">{t("objectives.memberSelection.route")}</span>, title: t("objectives.members.routeHint"), label: t("objectives.memberSelection.route") };
  if (member.launch.mode === "same") return { text: <span className="objectives-launch-model">{t("objectives.memberSelection.inherit")}</span>, title: t("objectives.memberSelection.inherit"), label: t("objectives.memberSelection.inherit") };
  const chosen = launchedWords(rows, member.launch.model, member.launch.effort, labels);
  return { title: chosen.title, label: `${chosen.words.model} · ${chosen.words.effort}` };
}
/** 사라진 Operation 은 실행값을 읽을 곳이 없다 — 띄우기 전처럼 설정 선택을 보인다(다음 개시가 연결을 새로 세운다). */
const memberLaunched = (member: ObjectiveMember, operationState: (operationId: string) => string): boolean => member.sessionName !== null && operationState(member.id) !== "closed";
/** 저장값만. false와 키 없음은 꺼짐. 실행 중 세션에 적용됐는지는 여기서 말하지 않는다. */
const memberSubagents = (member: ObjectiveMember): boolean => member.subagents === true;
const MEMBER_LIVE = new Set(["running", "background", "idle", "awaiting"]);

/** 구성원 표식의 색 — 명단 순번으로 정체성 톤(--id-*) 8가지를 돌려 쓴다. 명단·임무 줄·배정 메뉴가 같은 구성원에 같은 색을 쓴다. */
const MEMBER_TONES = 8;
const memberTone = (objective: Objective, memberId: string): number => Math.max(0, objective.members.findIndex((member) => member.id === memberId)) % MEMBER_TONES;

function MemberMark({ role, tone }: { role: string; tone: number }) {
  return <span className={`objectives-member-mark is-tone-${tone}`} aria-hidden="true">{Array.from(role)[0] ?? "?"}</span>;
}

/** 지휘관 표식 — 그래프 뿌리 노드처럼 둥근 brass 원에 계급 별. 구성원 표식(각진 칸·첫 글자·정체성 톤)과 모양·색·내용이 모두 다르다. */
function CommanderMark() {
  return <span className="objectives-member-mark is-commander" aria-hidden="true"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.2l1.75 3.55 3.92.57-2.84 2.77.67 3.9L8 11.15l-3.5 1.84.67-3.9-2.84-2.77 3.92-.57z" /></svg></span>;
}

function MemberRoster({ objective, t, call, request, operationState, rows, touchable, expanded, onToggle }: { objective: Objective; t: T; call: DetailProps["call"]; request: DetailProps["request"]; operationState: DetailProps["operationState"]; rows: ReturnType<typeof useLaunchRows>; touchable: boolean; expanded: boolean; onToggle: () => void }) {
  // 빼면 맡던 임무는 지휘관 직접으로 돌아간다 — 달성 기준처럼 되돌리기 없이 바로.
  const remove = (member: ObjectiveMember) => void call("/member/remove", { objectiveId: objective.id, memberId: member.id });
  const saving = useRef(new Set<string>());
  const [fault, setFault] = useState<{ id: string; code: string } | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const noteTimer = useRef<number | null>(null);
  useEffect(() => () => { if (noteTimer.current !== null) window.clearTimeout(noteTimer.current); }, []);
  const toggleSubagents = (member: ObjectiveMember, live: boolean) => {
    if (saving.current.has(member.id)) return;
    const next = !memberSubagents(member);
    saving.current.add(member.id);
    void request("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { subagents: next } }).then((payload) => {
      saving.current.delete(member.id);
      const saved = payload as { objective?: Objective } | null;
      const echoed = saved?.objective?.members.find((entry) => entry.id === member.id);
      if (!echoed || memberSubagents(echoed) !== next) { setFault({ id: member.id, code: "not_stored" }); return; }
      setFault((current) => current?.id === member.id ? null : current);
      setAnnounce(`${t(next ? "objectives.members.subagentsSaved" : "objectives.members.subagentsCleared", { role: member.role })}${live ? ` ${t("objectives.members.subagentsLive")}` : ""}`);
      if (!live) { setNoteFor((current) => current === member.id ? null : current); return; }
      setNoteFor(member.id);
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => setNoteFor((current) => current === member.id ? null : current), 10_000);
    }, (error: unknown) => {
      saving.current.delete(member.id);
      setFault({ id: member.id, code: error instanceof Error ? error.message : "unknown" });
    });
  };
  // 달성 기준·임무 줄과 같은 문법 — 글자 자체가 입력칸이고, 떠나면 저장한다. Enter 는 확정, Escape 는 되돌린다.
  const inlineKeys = (original: string) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (submitKey(event)) event.currentTarget.blur();
    else if (event.key === "Escape") { event.currentTarget.value = original; event.currentTarget.blur(); }
  };
  return <div className="objectives-members">
    <SectionHead glyph={<CoordGlyph />} label={t("objectives.members.title")} tools={<span>{objective.members.length}</span>}
      {...(objective.members.length > 0 ? { controls: "objectives-sec-members", expanded, onToggle } : {})} />
    <div id="objectives-sec-members" hidden={!expanded}>
    {objective.members.length === 0 ? <p className="objectives-members-empty">{t("objectives.members.empty")}</p> : null}
    {objective.members.map((member, index) => {
      const count = objective.missions.filter((mission) => mission.member === member.id).length;
      const state = member.sessionName !== null ? operationState(member.id) : "closed";
      const display = memberLaunchDisplay(member, memberLaunched(member, operationState), t, rows);
      const status = state === "closed" ? t("objectives.members.missions", { count }) : state === "ended" ? t("objectives.members.dormant") : state === "running" || state === "background" ? t("objectives.members.working") : state === "awaiting" ? t("objectives.awaiting.word") : t("objectives.members.idle");
      const allowed = memberSubagents(member);
      return (
        <div key={member.id} className="objectives-member-slot">
        <div className="objectives-member">
          <MemberMark role={member.role} tone={memberTone(objective, member.id)} />
          <div className="objectives-member-body">
            <span className="objectives-member-name">
              {/* 너비는 글자 수가 아니라 실제 글자 폭으로 — 숨은 복제(data-value)가 칸을 잡는다(한글처럼 넓은 글자도 잘리지 않게). */}
              <span key={`role:${member.role}`} className="objectives-member-role-fit" data-value={member.role}>
                <input className="objectives-member-role" aria-label={t("objectives.members.roleAria", { n: index + 1 })} defaultValue={member.role} readOnly={!touchable} maxLength={40} size={1}
                  onInput={(event) => { event.currentTarget.parentElement!.dataset.value = event.currentTarget.value; }}
                  onKeyDown={inlineKeys(member.role)} onBlur={(event) => { const value = event.target.value.trim(); if (value && value !== member.role) void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { role: value } }); else { event.target.value = member.role; event.target.parentElement!.dataset.value = member.role; } }} />
              </span>
              {member.by === "commander" ? <span className="objectives-member-by">{t("objectives.members.proposed")}</span> : null}
            </span>
            <WrapText key={`brief:${member.brief ?? ""}`} className="objectives-member-brief" label={t("objectives.members.briefAria", { role: member.role })} value={member.brief ?? ""} placeholder={touchable ? t("objectives.members.briefPlaceholder") : t("objectives.members.noBrief")} readOnly={!touchable} maxLength={300}
              onCommit={(value) => { if (value !== (member.brief ?? "")) void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { brief: value || null } }); return true; }} />
          </div>
          <div className="objectives-member-meta">
            <LaunchControl key={member.id} t={t} model={member.launch.mode === "model" ? member.launch.model : undefined} effort={member.launch.mode === "model" ? member.launch.effort : undefined} locked={!touchable} startAtList={member.launch.mode !== "model"} triggerLabel={t("objectives.members.modelAria", { role: member.role })}
              triggerText={display.text} triggerTitle={display.title}
              extras={[{ id: "route", label: t("objectives.memberSelection.route"), hint: t("objectives.members.routeHint"), active: member.launch.mode === "route", onPick: () => void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch: null } }) }, { id: "same", label: t("objectives.memberSelection.inherit"), active: member.launch.mode === "same", onPick: () => void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch: { mode: "same" } } }) }]}
              subagents={touchable ? { allowed, onToggle: () => toggleSubagents(member, MEMBER_LIVE.has(state)) } : undefined}
              onChange={(next) => { const model = next.model ?? (member.launch.mode === "model" ? member.launch.model : undefined); if (model) void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch: { mode: "model", model, effort: next.effort } } }); }} />
            <span className={`objectives-member-status is-${state}`} title={state === "ended" ? t("objectives.members.dormantHint") : undefined}>{status}{allowed ? <span className="objectives-member-subagents">{t("objectives.members.subagentsMark")}</span> : null}</span>
          </div>
          {touchable ? <button type="button" className="objectives-glyph objectives-member-remove" title={t("objectives.members.remove")} aria-label={t("objectives.members.removeAria", { role: member.role })} onClick={() => remove(member)}><TrashGlyph /></button> : null}
        </div>
        {noteFor === member.id ? <p className="objectives-member-note" aria-hidden="true">{t("objectives.members.subagentsLive")}</p> : null}
        {fault?.id === member.id ? <p className="objectives-member-note is-error" role="alert">{t("objectives.toast.failed", { code: fault.code })}</p> : null}
        </div>
      );
    })}
    {touchable ? (
      <div className="objectives-row objectives-mission-add">
        <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
        <input aria-label={t("objectives.members.add")} placeholder={t("objectives.members.add")} maxLength={40} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; const role = target.value.trim(); target.value = ""; void call("/member/add", { objectiveId: objective.id, member: { role } }); } }} />
      </div>
    ) : null}
    <PastRoles objective={objective} t={t} call={call} touchable={touchable} />
    </div>
    <p className="objectives-sr" aria-live="polite">{announce}</p>
  </div>;
}

function AssignControl({ t, objective, mission, onAssign, onCreate, label, rows, operationState }: { t: T; objective: Objective; mission: ObjectiveMission; onAssign: (member: string | null) => void; onCreate: (role: string) => Promise<boolean>; label: string; rows: ReturnType<typeof useLaunchRows>; operationState: DetailProps["operationState"] }) {
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
  }, [open, creating, objective.members.length]);
  const pick = (id: string | null) => { onAssign(id); setOpen(false); };
  return <>
    <button ref={trigger} type="button" className="objectives-launch is-glyph objectives-glyph" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => { setCreating(false); setOpen((value) => !value); }}><AssignGlyph /></button>
    {open ? createPortal(<div ref={menu} className="objectives-menu objectives-assign-menu" role="menu" aria-label={label} style={{ ...pos, width: 216 }}>
      <button type="button" role="menuitemradio" aria-checked={!mission.member} className={`objectives-menu-item${!mission.member ? " is-active" : ""}`} onClick={() => pick(null)}><CommanderMark /><span className="objectives-menu-label is-commander">{t("objectives.memberSelection.self")}</span></button>
      <div className="objectives-menu-divider" role="separator" />
      <p className="objectives-menu-caption objectives-assign-caption">{t("objectives.members.title")}</p>
      {objective.members.map((member) => <button key={member.id} type="button" role="menuitemradio" aria-checked={mission.member === member.id} className={`objectives-menu-item${mission.member === member.id ? " is-active" : ""}`} onClick={() => pick(member.id)}><MemberMark role={member.role} tone={memberTone(objective, member.id)} /><span className="objectives-menu-label">{member.role}</span>{((display) => <span className="objectives-assign-model" title={display.title}>{display.label}</span>)(memberLaunchDisplay(member, memberLaunched(member, operationState), t, rows))}</button>)}
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

type DetailSection = "detail:criteria" | "detail:missions" | "detail:results" | "detail:decisions" | "detail:followups" | "detail:members" | "detail:retro";

interface DetailProps {
  readonly objective: Objective;
  readonly t: T;
  readonly language: "en" | "ko";
  readonly launchAvailable: boolean;
  readonly call: <R,>(path: string, body: Record<string, unknown>) => Promise<R | null>;
  readonly toast: (text: string, undo?: () => Promise<void>) => void;
  readonly modeLabel: (mode: CommanderMode) => string;
  readonly stateLabel: (state: string) => string;
  readonly operationTitle: (operationId: string) => string;
  readonly operationState: (operationId: string) => string;
  /** 끌어올리기 전 자기 활동 — 지휘관 자신의 대기·실행을 구성원 것과 가를 때. */
  readonly operationOwnState: (operationId: string) => string;
  readonly busy: boolean;
  readonly request: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  /** 상세 섹션 접힘 — Theater별 메모리 보기 상태에 보존하며 기본은 펼침. */
  readonly sectionOpen: (key: DetailSection) => boolean;
  readonly onToggleSection: (key: DetailSection) => void;
  readonly onOpenSection: (key: DetailSection) => void;
  readonly highlightMission: string | null;
  readonly onClose: () => void;
  readonly detailRef: RefObject<HTMLElement | null>;
  /** 두 칸(목록 | 상세) 또는 세 칸(목록 | 내용·계획 | 운영·판단) — 같은 상세를 어떻게 나눠 그릴지만 정한다. */
  readonly layout: "split" | "three";
  readonly placeButton: ReactNode;
  readonly onComplete: () => void;
  readonly onToggleEdge: (from: string, to: string) => Promise<void>;
  /** 배치 결과·출처에서 목표 상세를 연다 — 목록에 있는 항목만 연다. */
  readonly onOpenObjective: (operationId: string) => void;
  /** 이 목표를 뺀 결정 요청 수 — 한 열에서 상세가 목록을 덮는 동안 머리에서 다른 요청으로 가는 길이 된다. */
  readonly otherRequests: number;
  readonly onNextRequest: () => void;
}

/**
 * 세부 — 입력 폼이 아니라 행의 목록이다. 일정 → 지휘관·구성원 → 브리핑 → 달성 기준 → 임무 → 편성, 맨 아래 하단 한 자리(action-band).
 * 값이 있는 행은 그 값을 말하고 × 로 지우며, 없는 행은 동사("기한 설정")로 선다. 테두리 친 입력은 없다 — 제목·임무·메모 모두 글 위에 바로 쓴다.
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
      <div ref={cardRef} className="objectives-zoom" role="dialog" aria-modal="true" aria-label={`${t("objectives.missions.title")} · ${title}`} tabIndex={-1}>
        <div className="objectives-zoom-head">
          <span className="objectives-zoom-title">{t("objectives.missions.title")}<span className="objectives-zoom-item">{title}</span></span>
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

const PROPOSAL_PLACEHOLDER: Readonly<Record<ObjectiveCriterionProposal["kind"], ObjectiveMessageKey>> = {
  add: "objectives.proposal.ph.add",
  revise: "objectives.proposal.ph.revise",
  retire: "objectives.proposal.ph.retire",
};

/**
 * 지휘관의 달성 기준 제안 한 줄 — 바뀔 기준 자리에 점선 테두리로 선다. 추가는 새 문구, 수정은 원문(취소선) 아래 새 문구,
 * 삭제는 원문 전체 취소선과 이유. 사람은 제안 문구를 고치지 않는다 — 승인·거절하거나 어노테이션을 달아 다시 구상하게 한다.
 * 어노테이션은 스티어링이 아니다: 저장만 하고, 다음 「다시 구상」 때 지휘관이 보드에서 읽는다.
 */
function ProposalRow({ proposal, target, n, objectiveId, t, call, touchable, annotating, onAnnotate }: {
  readonly proposal: ObjectiveCriterionProposal;
  /** 수정·삭제 대상인 승인된 기준 — 추가면 null. */
  readonly target: ObjectiveCriterion | null;
  /** 대상 기준의 번호(1부터) — 추가면 쓰지 않는다. */
  readonly n: number;
  readonly objectiveId: string;
  readonly t: T;
  readonly call: <R,>(path: string, body: Record<string, unknown>) => Promise<R | null>;
  readonly touchable: boolean;
  /** 어노테이션 칸이 열린 제안 id — 한 번에 하나. */
  readonly annotating: string | null;
  readonly onAnnotate: (proposalId: string | null) => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // 키나 버튼으로 이미 끝낸 칸 — 떼어질 때 뒤늦게 오는 blur 가 다시 저장(Esc 면 되돌린 글을 저장)하지 않게.
  const settled = useRef(false);
  const open = touchable && annotating === proposal.id;
  const saved = proposal.annotation ?? "";
  const label = proposal.kind === "add" ? t("objectives.proposal.add") : t(proposal.kind === "revise" ? "objectives.proposal.revise" : "objectives.proposal.retire", { n });
  const decide = (path: "/criterion/approve" | "/criterion/reject") => void call(path, { objectiveId, proposalId: proposal.id });
  /** 칸의 글을 저장한다 — 바뀌었을 때만. 빈 글은 어노테이션을 지운다. */
  const save = () => {
    const value = fieldRef.current?.value.trim();
    if (value !== undefined && value !== saved) void call("/criterion/annotate", { objectiveId, proposalId: proposal.id, annotation: value });
  };
  const close = (focusToggle: boolean) => {
    settled.current = true;
    onAnnotate(null);
    if (focusToggle) requestAnimationFrame(() => toggleRef.current?.focus());
  };
  return (
    <div className={`objectives-proposal is-${proposal.kind}`} role="group" aria-label={label}>
      <div className="objectives-criterion">
        <span className="objectives-criterion-mark" aria-hidden="true" />
        <div className="objectives-criterion-body">
          <span className="objectives-proposal-kind">{label}</span>
          {proposal.kind === "revise" && target ? <del className="objectives-proposal-text is-old">{target.text}</del> : null}
          {proposal.kind === "retire"
            ? <>
              <del className="objectives-proposal-text">{target?.text ?? ""}</del>
              {proposal.reason ? <span className="objectives-criterion-sub">{t("objectives.proposal.reason", { reason: proposal.reason })}</span> : null}
            </>
            : <span className="objectives-proposal-text">{proposal.text ?? ""}</span>}
        </div>
        <span className="objectives-criterion-state is-proposal">{t("objectives.proposal.state")}</span>
      </div>
      {touchable ? (
        <div className="objectives-proposal-acts">
          <button type="button" className="objectives-btn is-small is-approve" onClick={() => decide("/criterion/approve")}><span aria-hidden="true">✓</span>{t("objectives.proposal.approve")}</button>
          <button type="button" className="objectives-btn is-small is-reject" onClick={() => decide("/criterion/reject")}><span aria-hidden="true">✕</span>{t("objectives.proposal.reject")}</button>
          <button
            ref={toggleRef}
            type="button"
            className="objectives-btn is-small is-note"
            aria-expanded={open}
            // 열린 칸을 닫을 때 칸이 먼저 blur 로 닫혔다가 이 누름에 다시 열리지 않게 — 초점을 옮기지 않고 여기서 저장해 닫는다.
            onPointerDown={(event) => { if (open) event.preventDefault(); }}
            onClick={() => { if (open) { save(); close(false); } else { settled.current = false; onAnnotate(proposal.id); } }}
          >
            {t(saved ? "objectives.proposal.annotateEdit" : "objectives.proposal.annotate")}
          </button>
        </div>
      ) : null}
      {open ? (
        <div className="objectives-proposal-note">
          <textarea
            ref={fieldRef}
            autoFocus
            rows={2}
            maxLength={300}
            defaultValue={saved}
            placeholder={t(PROPOSAL_PLACEHOLDER[proposal.kind])}
            aria-label={t("objectives.proposal.annotationAria")}
            onKeyDown={(event) => {
              // Enter 는 저장하고 닫는다(Shift+Enter 는 줄바꿈). Esc 는 되돌리고 칸만 닫는다 — 상세는 닫지 않는다.
              if (submitKey(event) && !event.shiftKey) { event.preventDefault(); save(); close(true); }
              else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
            }}
            onBlur={() => { if (settled.current) return; save(); close(false); }}
          />
          <span className="objectives-proposal-hint">{t("objectives.proposal.annotationHint")}</span>
        </div>
      ) : saved ? (
        <div className="objectives-proposal-chip"><b>{t("objectives.proposal.annotation")}</b><span>{saved}</span></div>
      ) : null}
    </div>
  );
}

const BRIEF_LINES = 3;

function ObjectiveDetail({ objective, t, language, launchAvailable, call, toast, modeLabel, stateLabel, operationTitle, operationState, operationOwnState, busy, request, sectionOpen, onToggleSection, onOpenSection, highlightMission, onClose, detailRef, layout, placeButton, onComplete, onToggleEdge, onOpenObjective, otherRequests, onNextRequest }: DetailProps) {
  const [note, setNote] = useState(objective.note);
  const [title, setTitle] = useState(objective.title);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const launchRows = useLaunchRows();
  useEffect(() => { setNote(objective.note); }, [objective.note]);
  useEffect(() => { setTitle(objective.title); }, [objective.title]);
  const mode = commanderMode(objective.missions);
  // 수동 재개로 초기화된 유휴 세션도 잠근다. 구성원의 활동이 아니라 지휘관 자신의 상태로 판단한다.
  const locked = objective.commander.started || ["idle", "running", "background", "awaiting"].includes(operationOwnState(objective.id));
  const editable = !objective.done && !busy;
  // 지휘관이 일하는 동안에도 받는 편집 — 임무 추가, 끝나지 않은 임무의 문구·삭제·선행·담당, 메모. 구성원이 떠 있어도 임무는 끝나기 전까지 사람의 것이다. 서버가 같은 기준으로 가른다.
  const touchable = !objective.done;
  const notStarted = (mission: ObjectiveMission) => !mission.done;
  const canEditMission = (missionId: string) => { if (editable) return true; const target = objective.missions.find((candidate) => candidate.id === missionId); return touchable && !!target && notStarted(target); };
  const attachments = useAttachmentUpload(objective, t);
  const [dropping, setDropping] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  // 후속 후보 본문 — 달성 기준 아래 읽기 전용 구획. 줄·상세는 comp 와 같은 컴포넌트이고 한 번에 하나만 펼친다.
  const [followupOpenId, setFollowupOpenId] = useState<string | null>(null);
  useEffect(() => { setFollowupOpenId(null); }, [objective.id]);
  // 펼친 임무 기록 — 임무 id → 펼친 순간 이미 읽은 기록 id(「새 기록」 표시의 기준). 다른 항목으로 가면 모두 접는다.
  const [openRecords, setOpenRecords] = useState<Readonly<Record<string, ReadonlySet<string>>>>({});
  useEffect(() => { setOpenRecords({}); }, [objective.id]);
  // 펼친 동안 쌓이는 기록도 읽은 것이다 — 보이는 임무의 안 읽은 기록을 서버에 읽음으로 알린다.
  const seenPending = useRef(new Set<string>());
  useEffect(() => {
    for (const mission of objective.missions) {
      // 가장 최근 기록 id 로 거른다 — 기록 수는 상한(20)에 닿으면 더 늘지 않아, 그 뒤의 새 기록을 알리지 못한다.
      const key = `${mission.id}:${mission.records.at(-1)?.id ?? ""}`;
      if (!(mission.id in openRecords) || unseenRecords(mission) === 0 || seenPending.current.has(key)) continue;
      seenPending.current.add(key);
      void call("/mission/seen", { objectiveId: objective.id, missionId: mission.id });
    }
  }, [objective, openRecords, call]);
  const toggleRecords = (mission: ObjectiveMission) => setOpenRecords((current) => {
    if (mission.id in current) { const { [mission.id]: _closed, ...rest } = current; return rest; }
    return { ...current, [mission.id]: new Set(mission.records.slice(0, Math.min(mission.seen, mission.records.length)).map((record) => record.id)) };
  });
  // 짚은 임무 — 목록 행과 편성 노드가 서로를 켠다(그 임무의 선행도 함께).
  const [focusMission, setFocusMission] = useState<string | null>(null);
  const focused = focusMission ? objective.missions.find((mission) => mission.id === focusMission) ?? null : null;
  const numberOf = (missionId: string) => objective.missions.findIndex((mission) => mission.id === missionId) + 1;
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);

  // 결정 — 질문·기록에 붙은 구성원 표식과, 그 세션으로 가는 길(세션이 떠 있을 때만). 임무 줄의 결정 표식이 가리킨 결정은 잠시 비춘다.
  const memberMarkOf = (memberId: string) => {
    const member = objective.members.find((candidate) => candidate.id === memberId);
    return member ? { mark: <MemberMark role={member.role} tone={memberTone(objective, member.id)} />, role: member.role, live: member.sessionName !== null && operationState(member.id) !== "closed" } : null;
  };
  const [decisionFlash, setDecisionFlash] = useState<string | null>(null);
  const [decisionTrace, setDecisionTrace] = useState<string | null>(null);
  useEffect(() => { setDecisionFlash(null); setDecisionTrace(null); }, [objective.id]);
  useEffect(() => { if (objective.decisionRequest) setDecisionTrace(null); }, [objective.decisionRequest]);
  useEffect(() => {
    if (!decisionFlash) return;
    const frame = requestAnimationFrame(() => detailRef.current?.querySelector(`[data-decision-id="${CSS.escape(decisionFlash)}"]`)?.scrollIntoView({ block: "nearest" }));
    const timer = setTimeout(() => setDecisionFlash(null), 1600);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [decisionFlash, detailRef]);
  const showDecision = (decisionId: string) => { onOpenSection("detail:decisions"); setDecisionFlash(decisionId); };
  const showMission = (missionId: string) => {
    onOpenSection("detail:missions");
    setFocusMission(missionId);
    requestAnimationFrame(() => detailRef.current?.querySelector(`[data-mission-id="${CSS.escape(missionId)}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  const sendDecision = async (requestId: string, answers: readonly { questionId: string; selectedOptionIds: readonly string[]; text: string }[]) => {
    await request("/decision/answer", { objectiveId: objective.id, requestId, answers });
    setDecisionTrace(t("objectives.decision.sent", { count: answers.length }));
  };

  // 사람을 부르는 세션 — 지휘관 자신이 먼저, 다음은 명단 순서의 구성원(임무가 없는 구성원의 질문도 본다).
  // 지휘관 판정은 끌어올리기 전 자기 활동으로 한다 — 구성원만 묻고 있을 때 「지휘관이 기다립니다」로 서지 않게.
  const commanderAwaiting = !objective.done && operationOwnState(objective.id) === "awaiting";
  const memberAwaiting: MemberAwaiting | null = objective.done ? null : (() => {
    const member = objective.members.find((candidate) => candidate.sessionName !== null && operationState(candidate.id) === "awaiting");
    if (!member) return null;
    const mission = objective.missions.findIndex((mission) => !mission.done && mission.member === member.id);
    return { operationId: member.id, role: member.role, mission: mission >= 0 ? mission + 1 : null };
  })();
  // 작업 중 — 지휘관 자신이나 구성원 누군가가 돈다. 편집 잠금은 지금처럼 끌어올린 지휘관 활동(busy)이고, 하단 한 자리는
  // 지휘관 자신의 실행과 구성원 각자의 실행을 따로 본다(구성원이 묻는 동안 끌어올린 값은 대기라 실행을 가린다).
  const working = !objective.done && (WORKING.has(operationOwnState(objective.id)) || objective.members.some((member) => member.sessionName !== null && WORKING.has(operationState(member.id))));

  // 달성 기준 제안 — 결정(승인·거절)과 어노테이션은 줄마다 한다. 열린 어노테이션 칸은 한 번에 하나다.
  const proposals = objective.criteriaProposals;
  const [annotating, setAnnotating] = useState<string | null>(null);
  useEffect(() => { setAnnotating(null); }, [objective.id]);
  const proposalProps = { objectiveId: objective.id, t, call, touchable, annotating, onAnnotate: setAnnotating } as const;

  // 섹션 접힘 — 항목이 없으면 접지 않는다.
  const criteriaCollapsible = objective.criteria.length + proposals.length > 0;
  const missionsCollapsible = objective.missions.length > 0;
  const criteriaOpen = !criteriaCollapsible || sectionOpen("detail:criteria");
  const missionsOpen = !missionsCollapsible || sectionOpen("detail:missions");
  const resultsOpen = objective.results.length === 0 || sectionOpen("detail:results");
  // 제안이 새로 서면 접힌 기준 섹션을 편다 — 개시가 잠긴 까닭이 보여야 한다. 제안 목록이 바뀔 때 한 번만 펴서
  // 사람이 다시 접을 수 있게 둔다. onOpenSection 은 렌더마다 새로 만들어지므로 ref 로 읽는다(의존성에 넣으면 무한 렌더).
  const proposalKey = proposals.map((proposal) => proposal.id).join(",");
  const openSectionRef = useRef(onOpenSection);
  openSectionRef.current = onOpenSection;
  useEffect(() => { if (proposalKey) openSectionRef.current("detail:criteria"); }, [proposalKey]);
  // 「이 임무로」 — 임무 섹션을 펼치고 그 행으로 스크롤한다(편성 노드 호버로는 펼치지 않는다).
  useEffect(() => { if (highlightMission && !missionsOpen) onOpenSection("detail:missions"); }, [highlightMission, missionsOpen, onOpenSection]);
  useEffect(() => {
    if (!highlightMission || !missionsOpen) return;
    const frame = requestAnimationFrame(() => detailRef.current?.querySelector(`[data-mission-id="${CSS.escape(highlightMission)}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [highlightMission, missionsOpen, detailRef]);
  const unseenAny = objective.missions.some((mission) => unseenRecords(mission) > 0);
  // 후속 후보 — 본문 구획(읽기 전용)과 완료 뒤 결과. 후보가 없으면 서지 않는다.
  const followupOpenList = openFollowups(objective);
  const followupDiscardedList = discardedFollowups(objective);
  const followupBatches = readBatches(objective);
  const followupHistory = readHistory(objective);
  const followupOrigin = readOrigin(objective);
  const followupSelectableBody = isFollowupSelectable(objective);
  const followupGateKind = followupGate(objective);
  const showFollowupSection = !objective.done && (followupOpenList.length > 0 || followupDiscardedList.length > 0);
  const followupSectionOpen = !showFollowupSection || sectionOpen("detail:followups");
  const followupIdsKey = followupOpenList.map((candidate) => `${candidate.id}:${candidate.rev}`).join(",");
  const followupUnseen = unseenFollowupCount(objective.id, followupIdsKey ? followupIdsKey.split(",") : []);
  const openFollowupComp = () => {
    setFollowupOpen(objective.id, true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-followup-comp="${CSS.escape(objective.id)}"] [data-followup-sel]`)?.focus();
      });
    });
  };
  useEffect(() => {
    if (followupSectionOpen && followupIdsKey) markFollowupsSeen(objective.id, followupIdsKey.split(","));
  }, [objective.id, followupIdsKey, followupSectionOpen]);

  // 브리핑 — 쉴 때 3줄, 넘치면 「더 보기」. 쓰는 동안(초점)은 다 보인다(360px 뒤로는 안에서 스크롤).
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const [noteFocus, setNoteFocus] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteOverflow, setNoteOverflow] = useState(false);
  const noteClamped = !noteOpen && !noteFocus;
  // 빈 브리핑은 「브리핑 추가」 한 줄 — 누르거나 초점이 오면 편집 칸이 아래로 세 줄 펼쳐진다. 끌어오는 동안은 겹판만 서고 자리는 그대로다.
  const [briefActive, setBriefActive] = useState(false);
  const briefBlank = !note.trim() && objective.attachments.length === 0;
  const briefCollapsed = briefBlank && touchable && !briefActive && !attachments.error && attachments.sending === 0;
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
    noteTimer.current = setTimeout(() => { void call("/objective/patch", { objectiveId: objective.id, patch: { note: value } }); }, 600);
  };
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const doneMissions = objective.missions.filter((mission) => mission.done).length;

  const sHead = (<>
      <div className="objectives-group">
        <div className="objectives-detail-head">
          <button type="button" className="objectives-glyph objectives-detail-back" aria-label={t("objectives.detail.backToList")} title={t("objectives.detail.backToList")} onClick={onClose}>‹</button>
          {/* 한 열에서만 선다(CSS) — 넓은 표면에서는 목록 위 요약 줄이 같은 말을 한다. */}
          {otherRequests > 0 ? <button type="button" className="objectives-detail-requests" title={t("objectives.requests.othersTip")} onClick={onNextRequest}><RequestGlyph />{t("objectives.requests.others", { count: otherRequests })}</button> : null}
          {(() => {
            const n = objective.done || busy ? 0 : followupOpenList.length;
            const selectable = n > 0 && followupSelectableBody;
            const steerFirst = n > 0 && !selectable && followupGateKind === "steer";
            // 인계 대기 — 완료는 넘기기 뒤에만 된다. 후보가 없으면 동그라미는 하단 띠(「검토로 넘기기」)로 초점을 옮긴다.
            const handoffOnly = n === 0 && objective.awaitingHandoff && !objective.done;
            const label = selectable ? t("objectives.followup.listTip", { n }) : steerFirst ? t("objectives.followup.steerTip", { n }) : n > 0 ? t("objectives.followup.openTip", { n }) : handoffOnly ? t("objectives.handoff.tip") : t(objective.done ? "objectives.objective.reopen" : "objectives.objective.complete");
            return (
          <button type="button" className={`objectives-check${objective.done ? " is-on" : ""}`} aria-label={label} disabled={busy} onClick={() => {
            if (selectable) openFollowupComp();
            else if (handoffOnly) detailRef.current?.querySelector<HTMLElement>(".objectives-detail-bottom .objectives-start")?.focus();
            else if (steerFirst) detailRef.current?.querySelector<HTMLElement>(".objectives-detail-bottom .objectives-start")?.focus();
            else if (n > 0 && followupGateKind === "criteria") onOpenSection("detail:criteria");
            else if (n > 0) {
              // 읽기용 보기 — 접힌 후속 구획을 펴고 머리까지 스크롤·포커스한다.
              onOpenSection("detail:followups");
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const head = detailRef.current?.querySelector<HTMLElement>('[aria-controls="objectives-sec-followups"]');
                  head?.scrollIntoView({ block: "nearest" });
                  head?.focus();
                });
              });
            }
            else onComplete();
          }}><CheckGlyph /></button>
            );
          })()}
          <textarea className="objectives-detail-title" aria-label={t("objectives.objective.titleAria")} value={title} rows={1} readOnly={!editable} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={() => { if (title.trim() && title !== objective.title) void call("/objective/patch", { objectiveId: objective.id, patch: { title: title.trim() } }); }} />
          {!busy ? <button type="button" className="objectives-detail-delete" aria-label={t("objectives.objective.delete")} title={t("objectives.objective.delete")} onClick={async () => { const removed = await call<{ objective: Objective }>("/objective/remove", { objectiveId: objective.id }); if (removed) { removeObjectiveLocally(objective.id); toast(t("objectives.toast.deleted")); } }}><TrashGlyph /></button> : null}
          {placeButton}
        </div>
        {busy ? <div className="objectives-busy-line" role="status"><i aria-hidden="true" /><span>{t(objective.planning ? "objectives.planning" : "objectives.busy")}</span></div> : null}
      </div>
  </>);
  const sFollowupResults = (<>
      {/* 후속 목표 — 완료한 목표 상세의 머리 아래에 영속한다. 배치 요약과 줄 상태, 남긴 후보는 접힌 줄로. */}
      {followupBatches.length > 0 || followupHistory || (objective.done && followupOpenList.length > 0) ? (
      <div className="objectives-group">
        <SectionHead glyph={<FollowupForkGlyph />} label={t("objectives.followup.results")} />
        <FollowupBatchResults
          batches={followupBatches}
          leftover={objective.done ? followupOpenList : []}
          historyTotal={followupHistory}
          language={language}
          t={t}
          onRetry={(batchId, candidateId) => void call("/followup/retry", { objectiveId: objective.id, batchId, candidateId })}
          onOpenObjective={onOpenObjective}
        />
      </div>
      ) : null}
  </>);
  const sSchedule = (<>
      <div className="objectives-group">
        <div className={`objectives-row${objective.today ? " is-on" : ""}`}>
          <button type="button" className="objectives-row-main" aria-pressed={objective.today} disabled={!editable} onClick={() => void call("/objective/patch", { objectiveId: objective.id, patch: { today: !objective.today } })}>
            <span className="objectives-row-ic"><SunGlyph /></span>
            <span className="objectives-row-lab">{t(objective.today ? "objectives.schedule.todayOn" : "objectives.schedule.addToday")}</span>
          </button>
          {objective.today && editable ? <button type="button" className="objectives-row-x" aria-label={t("objectives.schedule.removeToday")} title={t("objectives.schedule.removeToday")} onClick={() => void call("/objective/patch", { objectiveId: objective.id, patch: { today: false } })}>×</button> : null}
        </div>
        <div className={`objectives-row${objective.dueDate ? " is-on" : ""}${objective.dueDate && objective.dueDate < todayIso() && !objective.done ? " is-overdue" : ""}`}>
          <button type="button" className="objectives-row-main" disabled={!editable} aria-haspopup="dialog" aria-expanded={!!dateAnchor} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setDateAnchor((value) => (value ? null : rect)); }}>
            <span className="objectives-row-ic"><CalGlyph /></span>
            <span className="objectives-row-lab">{objective.dueDate ? t("objectives.schedule.dueOn", { date: dueLabel(objective.dueDate, language) }) : t("objectives.schedule.setDue")}</span>
          </button>
          {dateAnchor ? <DatePicker anchor={dateAnchor} value={objective.dueDate} language={language} t={t} onPick={(next) => void call("/objective/patch", { objectiveId: objective.id, patch: { dueDate: next } })} onClose={() => setDateAnchor(null)} /> : null}
          {objective.dueDate && editable ? <button type="button" className="objectives-row-x" aria-label={t("objectives.schedule.clearDue")} title={t("objectives.schedule.clearDue")} onClick={() => void call("/objective/patch", { objectiveId: objective.id, patch: { dueDate: null } })}>×</button> : null}
        </div>
      </div>
  </>);
  const sCrew = (<>
      {/* 지휘관·구성원 — 목표는 곧 지휘관 Operation 이다. 이 행은 모델·강도·보기 설정만 맡고, 이동은 하단 띠의 이동 요소가 맡는다. */}
      <div className="objectives-group" data-objectives-tour="crew">
        <div className={`objectives-row${objective.commander.started ? " is-on" : ""}`}>
          <span className="objectives-row-main">
            <span className="objectives-row-ic"><CoordGlyph /></span>
            <span className="objectives-row-lab">{t("objectives.commander.title")}</span>
          </span>
          <LaunchControl t={t} model={objective.commander.model} effort={objective.commander.effort} viewMode={objective.commander.viewMode ?? "terminal"} onViewChange={(viewMode) => void call("/objective/patch", { objectiveId: objective.id, patch: { launch: { viewMode } } })} locked={locked || !editable} onChange={(next) => void call("/objective/patch", { objectiveId: objective.id, patch: { launch: next } })} />
        </div>
        <MemberRoster objective={objective} t={t} call={call} request={request} operationState={operationState} rows={launchRows} touchable={touchable}
          expanded={objective.members.length === 0 || sectionOpen("detail:members")} onToggle={() => onToggleSection("detail:members")} />
      </div>
  </>);
  const sBrief = (<>
      {/* 브리핑 — 사람이 쓴 요구. 붙이는 입구는 머리의 첨부 글리프이고, 첨부 띠는 이미지가 있을 때만 본문 위에 선다.
          메모에 이미지를 붙여넣거나 이 구획에 끌어오면 띠에 들어간다 — 끌어오는 동안은 자리를 밀지 않는 겹판이 선다. */}
      <div
        className="objectives-group objectives-note-group"
        data-objectives-tour="brief"
        onFocus={() => setBriefActive(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBriefActive(false); }}
        onDragOver={(event) => { if (touchable && [...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDropping(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(event) => { if (!touchable) return; event.preventDefault(); setDropping(false); const files = imageFiles(event.dataTransfer.files); if (files.length) void attachments.upload(files); }}
      >
        <SectionHead glyph={<BriefGlyph />} label={t("objectives.objective.memo")} tools={objective.attachments.length > 0 || touchable ? <>
          {objective.attachments.length > 0 ? <span className="objectives-criteria-count">{t("objectives.brief.images", { count: objective.attachments.length })}</span> : null}
          {touchable ? <AttachButton objective={objective} t={t} upload={attachments.upload} sending={attachments.sending} /> : null}
        </> : null} />
        <NoteAttachments objective={objective} t={t} touchable={touchable} error={attachments.error} sending={attachments.sending} onRemove={(attachment) => void call("/attachment/remove", { objectiveId: objective.id, attachmentId: attachment.id })} />
        <textarea ref={noteRef} className={`objectives-note${noteClamped ? " is-clamped" : ""}${briefBlank && !briefCollapsed ? " is-writing" : ""}`} rows={1} aria-label={t("objectives.objective.memo")} placeholder={t("objectives.objective.memoPlaceholder")} value={note} readOnly={!touchable} onChange={(event) => saveNote(event.target.value)}
          onFocus={() => setNoteFocus(true)} onBlur={() => setNoteFocus(false)}
          onPaste={(event) => { if (!touchable) return; const files = imageFiles(event.clipboardData.files); if (files.length) { event.preventDefault(); void attachments.upload(files); } }} />
        {dropping ? <AttachmentDropVeil t={t} /> : null}
        {noteOverflow && (noteOpen || !noteFocus) ? <button type="button" className="objectives-note-more" aria-expanded={noteOpen} onPointerDown={(event) => event.preventDefault()} onClick={() => setNoteOpen((value) => !value)}>{t(noteOpen ? "objectives.brief.less" : "objectives.brief.more")}</button> : null}
      </div>
  </>);
  const sOrigin = (<>
      {/* 출처 — 후속으로 태어난 목표의 원본. 한 줄(말줄임 제목 + ↗)로만 두고, 원본이 없으면 비활성 한 줄. */}
      {followupOrigin ? (
      <div className="objectives-group">
        {followupOrigin.title ? (
          <div className="objectives-row">
            <button type="button" className="objectives-row-main" onClick={() => onOpenObjective(followupOrigin.objectiveId)} aria-label={`${t("objectives.origin.label")} · ${followupOrigin.title}`}>
              <span className="objectives-row-lab objectives-origin-lab">{t("objectives.origin.label")}<span aria-hidden="true"> · </span><span className="objectives-origin-title">{followupOrigin.title}</span></span>
              <span className="objectives-origin-goto" aria-hidden="true"><GoGlyph /></span>
            </button>
          </div>
        ) : (
          <div className="objectives-row is-static">
            <span className="objectives-row-lab objectives-origin-lab">{t("objectives.origin.label")}<span aria-hidden="true"> · </span><span>{t("objectives.origin.deleted")}</span></span>
          </div>
        )}
        {followupOrigin.userImpact ? <p className="objectives-origin-impact"><b>{t("objectives.followup.impact")}</b> {followupOrigin.userImpact}</p> : null}
      </div>
      ) : null}
  </>);
  const sCriteria = (<>
      {/* 달성 기준 — 사람이 쓰고, 사람이 구상을 청한 턴에 지휘관이 추가·수정·삭제를 제안한다. 제안은 바뀔 기준 바로 그 줄에 서고
          (추가는 끝에 새 줄) 사람이 줄마다 승인·거절하거나 어노테이션을 달아 다시 구상하게 한다. 제안이 남아 있으면 개시·스티어링은 잠긴다.
          마지막 임무 뒤 지휘관이 기준마다 스스로 다시 따져 근거와 함께 충족으로 표시한다. 새 작업이 생기면 충족 표시는 거둬져
          「미확인」으로 돌아간다. 모든 임무와 기준이 끝나면 저절로 검토 대기다. */}
      <div className="objectives-group objectives-criteria-group" data-objectives-tour="criteria">
        <div className="objectives-criteria-head">
          <SectionHead
            glyph={<CriteriaGlyph />}
            label={t("objectives.criteria.title")}
            tools={proposals.length > 0 ? <span className="objectives-criteria-count is-pending">{t("objectives.criteria.pending", { count: proposals.length })}</span>
              : criteriaCollapsible ? <span className="objectives-criteria-count">{t("objectives.criteria.count", { met: objective.criteria.filter((criterion) => !!criterion.met).length, total: objective.criteria.length })}</span> : null}
            {...(criteriaCollapsible ? { controls: "objectives-sec-criteria", expanded: criteriaOpen, onToggle: () => onToggleSection("detail:criteria") } : {})}
          />
          {proposals.length > 1 && touchable ? <button type="button" className="objectives-btn is-small objectives-approve-all" onClick={() => void call("/criterion/approve-all", { objectiveId: objective.id })}>{t("objectives.criteria.approveAll")}</button> : null}
        </div>
        <div id="objectives-sec-criteria" hidden={!criteriaOpen}>
          {objective.criteria.map((criterion, index) => {
            const proposal = proposals.find((candidate) => candidate.target === criterion.id);
            if (proposal) return <ProposalRow key={proposal.id} proposal={proposal} target={criterion} n={index + 1} {...proposalProps} />;
            const evidence = criterion.met;
            return (
              <div key={criterion.id} className={`objectives-criterion${evidence ? " is-met" : ""}`}>
                <span className="objectives-criterion-mark" aria-hidden="true" />
                <div className="objectives-criterion-body">
                  <WrapText key={criterion.text} className="objectives-criterion-text" label={t("objectives.criteria.itemAria", { n: index + 1 })} value={criterion.text} readOnly={!touchable} maxLength={300}
                    onCommit={(value) => { if (!value) return false; if (value !== criterion.text) void call("/criterion/patch", { objectiveId: objective.id, criterionId: criterion.id, patch: { text: value } }); return true; }} />
                  {evidence ? <span className="objectives-criterion-sub is-evidence">{t("objectives.criteria.evidence", { evidence })}</span>
                    : criterion.by === "commander" ? <span className="objectives-criterion-sub">{t("objectives.criteria.proposed")}</span> : null}
                </div>
                <span className={`objectives-criterion-state${evidence ? " is-met" : ""}`}>{t(evidence ? "objectives.criteria.met" : "objectives.criteria.unchecked")}</span>
                {touchable ? <button type="button" className="objectives-glyph objectives-criterion-remove" title={t("objectives.criteria.remove")} aria-label={t("objectives.criteria.remove")} onClick={() => void call("/criterion/remove", { objectiveId: objective.id, criterionId: criterion.id })}><TrashGlyph /></button> : null}
              </div>
            );
          })}
          {proposals.filter((proposal) => proposal.kind === "add").map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} target={null} n={0} {...proposalProps} />)}
          {touchable ? (
            <div className="objectives-row objectives-mission-add">
              <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
              <input aria-label={t("objectives.criteria.add")} placeholder={t("objectives.criteria.add")} maxLength={300} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; const text = target.value.trim(); target.value = ""; void call("/criterion/add", { objectiveId: objective.id, criterion: { text } }); } }} />
            </div>
          ) : null}
        </div>
      </div>
  </>);
  const sResults = (<>
      {/* 결과물 — 달성 기준 바로 아래, 모든 상태에서 같은 자리. 증거가 먼저, PR 이 뒤. 없으면 머리 한 줄(「없음」)만 선다 —
          붙이라고 권하지 않는다. 붙이고 고치는 것은 지휘관의 도구이고 사람은 읽는다. PR 상태는 서버 관측이 SSE 로 갱신한다. */}
      <div className="objectives-group objectives-results-group">
        <SectionHead
          glyph={<ResultsGlyph />}
          label={t("objectives.results.title")}
          tools={<ResultsHeadTools objective={objective} t={t} expanded={resultsOpen} />}
          {...(objective.results.length > 0 ? { controls: "objectives-sec-results", expanded: resultsOpen, onToggle: () => onToggleSection("detail:results") } : {})}
        />
        {objective.results.length > 0 ? <div id="objectives-sec-results" hidden={!resultsOpen}><ObjectiveResults objective={objective} t={t} language={language} /></div> : null}
      </div>
  </>);
  const sMissions = (<>
      {/* 임무 — 목록과 편성 그래프를 한 섹션에 둔다. 머리 오른쪽은 완료 셈이고, 접혀도 남는다(접힌 임무에 안 읽은 기록이 있으면 셈 앞에 점 하나).
          머리를 접으면 목록과 추가 입력만 접히고, 그래프는 접지 않는다 — 접어도 진행이 한눈에 보인다. 임무가 없으면 그래프는 서지 않는다. */}
      <div className="objectives-group objectives-missions-group" data-objectives-tour="missions">
        <SectionHead
          glyph={<GraphGlyph />}
          label={t("objectives.missions.title")}
          tools={missionsCollapsible ? <>
            {!missionsOpen && unseenAny ? <i className="objectives-sec-unseen" title={t("objectives.missions.unseen")} /> : null}
            <span className="objectives-criteria-count">{t("objectives.missions.count", { done: doneMissions, total: objective.missions.length })}</span>
          </> : null}
          {...(missionsCollapsible ? { controls: "objectives-sec-missions", expanded: missionsOpen, onToggle: () => onToggleSection("detail:missions") } : {})}
        />
        <div id="objectives-sec-missions" hidden={!missionsOpen}>
          <div className="objectives-missions">
            {objective.missions.map((mission, index) => {
              const ready = missionReady(objective.missions, mission);
              const member = objective.members.find((candidate) => candidate.id === mission.member);
              const records = mission.records;
              const recordsOpen = mission.id in openRecords;
              const unseen = unseenRecords(mission);
              const recordsId = `objectives-records-${mission.id}`;
              return (
                <Fragment key={mission.id}>
                <div
                  data-mission-id={mission.id}
                  className={`objectives-mission${mission.done ? " is-done" : ""}${!mission.done && ready ? " is-ready" : ""}${recordsOpen ? " is-expanded" : ""}${highlightMission === mission.id ? " is-highlight" : ""}${focused?.id === mission.id ? " is-focus" : focused?.prerequisites.includes(mission.id) ? " is-pre" : ""}`}
                  onPointerEnter={() => setFocusMission(mission.id)}
                  onPointerLeave={() => setFocusMission(null)}
                  onFocus={() => setFocusMission(mission.id)}
                  onBlur={() => setFocusMission(null)}
                >
                  <button type="button" className={`objectives-check${mission.done ? " is-on" : ""}`} aria-label={t("objectives.missions.done")} disabled={!editable} onClick={() => void call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: { done: !mission.done } })}><CheckGlyph /></button>
                  {/* 번호는 편성 순서 — 그래프 노드와 같은 번호다. */}
                  <span className="objectives-mission-num" aria-hidden="true">{index + 1}</span>
                  <div className="objectives-mission-body">
                    <WrapText key={mission.text} className="objectives-mission-text" label={`${index + 1}`} value={mission.text} readOnly={!(editable || (touchable && notStarted(mission)))} maxLength={200}
                      onCommit={(value) => { if (!value) return false; if (value !== mission.text) void call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: { text: value } }); return true; }} />
                    <span className={`objectives-mission-sub${mission.operationId ? ` is-${operationState(mission.operationId)}` : " is-assign"}`} title={mission.operationId ? operationTitle(mission.operationId) : undefined}>{member ? <><MemberMark role={member.role} tone={memberTone(objective, member.id)} /><span className="objectives-mission-member-name">{member.role}</span></> : <><CommanderMark /><span className="objectives-mission-member-name is-commander">{t("objectives.memberSelection.self")}</span></>}</span>
                    {mission.unplaced && !mission.done ? <span className="objectives-mission-sub is-unplaced">{t("objectives.missions.unplaced")}</span> : null}
                  </div>
                  {records.length > 0 ? (
                    <button type="button" className={`objectives-records-count${unseen > 0 ? " is-unseen" : ""}`} aria-expanded={recordsOpen} aria-controls={recordsId} aria-label={`${t("objectives.records.count", { index: index + 1, count: records.length })}${unseen > 0 ? ` · ${t("objectives.records.unseen", { count: unseen })}` : ""}`} onClick={() => toggleRecords(mission)}>
                      {unseen > 0 ? <i aria-hidden="true" /> : <ThreadGlyph />}{records.length}
                    </button>
                  ) : null}
                  {((decisions) => decisions.length > 0 ? (
                    <button type="button" className="objectives-records-count objectives-decision-link" aria-label={t("objectives.decisions.missionLink", { index: index + 1, count: decisions.length })} title={t("objectives.decisions.missionLink", { index: index + 1, count: decisions.length })} onClick={() => showDecision(decisions.at(-1)!.id)}>
                      <DecisionGlyph />{decisions.length}
                    </button>
                  ) : null)(objective.decisions.filter((decision) => decision.missionId === mission.id))}
                  {/* 무엇을 기다리는지 번호로 말한다 — 끝나지 않은 선행만. 구성원 상태는 담당 줄이 말한다. */}
                  {!mission.done && !mission.unplaced ? (ready
                    ? <span className="objectives-wait is-ready">{t("objectives.missions.ready")}</span>
                    : <span className="objectives-wait" title={t("objectives.missions.waiting")}>{t("objectives.missions.prerequisites", { missions: mission.prerequisites.filter((id) => !objective.missions.find((candidate) => candidate.id === id)?.done).map(numberOf).filter((n) => n > 0).join("·") })}</span>) : null}
                  <span className="objectives-mission-tools">
                    {!mission.done && touchable ? <AssignControl t={t} objective={objective} mission={mission} rows={launchRows} operationState={operationState} onAssign={(member) => void call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: { member } })} onCreate={async (role) => { const result = await call<{ objective: Objective }>("/member/add", { objectiveId: objective.id, member: { role } }); const member = result?.objective.members.at(-1); return member ? !!(await call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: { member: member.id } })) : false; }} label={t("objectives.missions.setMember")} /> : null}
                    {notStarted(mission) && touchable ? <button type="button" className="objectives-glyph" title={t("objectives.missions.remove")} aria-label={t("objectives.missions.remove")} onClick={() => void call("/mission/remove", { objectiveId: objective.id, missionId: mission.id })}><TrashGlyph /></button> : null}
                  </span>
                </div>
                {records.length > 0 ? <MissionRecords id={recordsId} records={records} seenAtOpen={openRecords[mission.id] ?? EMPTY_IDS} open={recordsOpen} t={t} language={language} /> : null}
                </Fragment>
              );
            })}
          </div>
          {touchable ? (
            <div className="objectives-row objectives-mission-add">
              <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
              <input aria-label={t("objectives.missions.add")} placeholder={t("objectives.missions.add")} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; void call("/mission/add", { objectiveId: objective.id, mission: { text: target.value.trim() } }).then(() => { target.value = ""; }); } }} />
            </div>
          ) : null}
        </div>
        {objective.missions.length > 0 ? (
          <div className="objectives-graph-wrap">
            {/* 그래프 도구는 그래프 상자 안 오른쪽 위 — 확대가 맨 끝, 일렬·병렬은 그 왼쪽. */}
            <div className="objectives-graph-frame">
              <div className="objectives-graph-tools">
                {objective.missions.length > 1 && editable ? <>
                  <button type="button" className="objectives-btn is-small" onClick={async () => { if (await call("/edge/linear", { objectiveId: objective.id })) toast(t("objectives.toast.linear")); }}>{t("objectives.graph.linear")}</button>
                  <button type="button" className="objectives-btn is-small" onClick={async () => { if (await call("/edge/clear", { objectiveId: objective.id })) toast(t("objectives.toast.parallel")); }}>{t("objectives.graph.parallel")}</button>
                </> : null}
                <button ref={zoomTriggerRef} type="button" className="objectives-glyph" aria-haspopup="dialog" aria-expanded={zoomOpen} aria-label={t("objectives.graph.zoom")} title={t("objectives.graph.zoom")} onClick={() => setZoomOpen(true)}><ZoomGlyph /></button>
              </div>
              <div className="objectives-graph-horizontal"><CoordinationGraph objective={objective} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("objectives.graph.cycle"))} operationTitle={operationTitle} onZoom={() => setZoomOpen(true)} canEdit={canEditMission} focusMissionId={focusMission} onFocusMission={setFocusMission} /></div>
              <div className="objectives-graph-vertical"><CoordinationGraph vertical objective={objective} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("objectives.graph.cycle"))} operationTitle={operationTitle} onZoom={() => setZoomOpen(true)} canEdit={canEditMission} focusMissionId={focusMission} onFocusMission={setFocusMission} /></div>
            </div>
          </div>
        ) : null}
        {zoomOpen && objective.missions.length > 0 ? createPortal(
          <LineupZoom t={t} title={objective.title} onClose={() => { setZoomOpen(false); zoomTriggerRef.current?.focus(); }}>
            <CoordinationGraph zoom objective={objective} t={t} modeLabel={modeLabel(mode)} onToggleEdge={(from, to) => void onToggleEdge(from, to)} onCycle={() => toast(t("objectives.graph.cycle"))} operationTitle={operationTitle} canEdit={canEditMission} focusMissionId={focusMission} onFocusMission={setFocusMission} />
          </LineupZoom>,
          document.body,
        ) : null}
      </div>
  </>);
  const sDecisions = (<>
      {/* 결정 — 임무 아래, 후속 후보 위. 사람이 결정 요청에 보낸 답이 질문마다 쌓인다(지휘관·구성원도 보드에서 읽는다). 답이 없으면 서지 않는다. */}
      {objective.decisions.length > 0 ? (
      <div className="objectives-group">
        <SectionHead
          glyph={<DecisionGlyph />}
          label={t("objectives.decisions.title")}
          tools={<span className="objectives-criteria-count">{objective.decisions.length}</span>}
          controls="objectives-sec-decisions"
          expanded={sectionOpen("detail:decisions")}
          onToggle={() => onToggleSection("detail:decisions")}
        />
        <div id="objectives-sec-decisions" hidden={!sectionOpen("detail:decisions")}>
          <DecisionList objective={objective} t={t} language={language} flash={decisionFlash} memberMark={memberMarkOf} />
        </div>
      </div>
      ) : null}
  </>);
  const sFollowups = (<>
      {/* 후속 후보 — 임무 아래, 회고 위. 후보가 있을 때만 서고, 체크 없이 같은 줄·상세를 읽는다(폐기는 여기서도 된다).
          검토 대기에서는 띠로 보내 고르고, edited·gated·작업 중에는 읽기·폐기만 한다. */}
      {showFollowupSection ? (
      <div className="objectives-group">
        <SectionHead
          glyph={<FollowupForkGlyph />}
          label={t("objectives.followup.title")}
          tools={<>
            {followupUnseen > 0 ? <i className="objectives-followup-newdot" aria-hidden="true" /> : null}
            <span className="objectives-criteria-count">{t("objectives.followup.count", { k: followupOpenList.length, n: MAX_FOLLOWUPS })}</span>
          </>}
          controls="objectives-sec-followups"
          expanded={followupSectionOpen}
          onToggle={() => onToggleSection("detail:followups")}
        />
        <div id="objectives-sec-followups" hidden={!followupSectionOpen}>
          <div className="objectives-followup-note">
            {followupSelectableBody
              ? <>{t("objectives.followup.bodyReview")} <button type="button" className="objectives-btn is-small" onClick={openFollowupComp}>{t("objectives.followup.openBand")}</button></>
              : followupGateKind === "steer" ? t("objectives.followup.bodyEdited")
              : followupGateKind === "criteria" ? t("objectives.followup.bodyGated")
              : objective.awaitingHandoff ? t("objectives.followup.bodyHandoff")
              : t("objectives.followup.bodyWorking")}
          </div>
          <FollowupCandidateList
            candidates={followupOpenList}
            selectable={false}
            selection={EMPTY_IDS}
            t={t}
            idPrefix={`body-${objective.id}`}
            openId={followupOpenId}
            onOpenChange={setFollowupOpenId}
            onToggleCheck={() => {}}
            onDiscard={(candidateId) => void call("/followup/discard", { objectiveId: objective.id, candidateId })}
          />
          <FollowupDiscardedTrace discarded={followupDiscardedList} t={t} />
        </div>
      </div>
      ) : null}
  </>);
  const sRetro = (<>
      {/* 회고 — 후속 후보 아래(맨 끝). 인계 기록이 있을 때만(검토 대기와 완료 뒤). 지휘관이 넘겼으면 두 표, 사람이 넘겼으면 회고 없음 한 줄. 읽기 전용. */}
      {objective.handoff ? (
      <div className="objectives-group">
        <SectionHead glyph={<RetroGlyph />} label={t("objectives.retro.title")} controls="objectives-sec-retro" expanded={sectionOpen("detail:retro")} onToggle={() => onToggleSection("detail:retro")} />
        <div id="objectives-sec-retro" hidden={!sectionOpen("detail:retro")}>
          <Retrospective
            t={t}
            by={objective.handoff.by}
            good={objective.handoff.retrospective?.wentWell.map((pair) => ({ text: pair.point, aside: pair.because })) ?? []}
            regret={objective.handoff.retrospective?.fellShort.map((pair) => ({ text: pair.point, aside: pair.ifOnly })) ?? []}
            ratings={objective.handoff.ratings ?? []}
          />
        </div>
      </div>
      ) : null}
  </>);
  const bottom = (
      <div className="objectives-detail-bottom" data-objectives-tour="action">
        {/* 결정 요청 — 띠와 따로 서서 작업 중에도 가려지지 않는다. 보내고 나면 한 줄 흔적만 잠시 남는다. */}
        {objective.decisionRequest && !objective.done ? (
          <DecisionRequestBlock objective={objective} t={t} language={language} send={sendDecision} missionNumber={numberOf} memberMark={memberMarkOf} onOpenSession={focusOperation} onShowMission={showMission} />
        ) : decisionTrace ? <p className="objectives-decision-trace" role="status">{decisionTrace}</p> : null}
        <ActionBand
          objective={objective}
          t={t}
          busy={busy}
          working={working}
          commanderAwaiting={commanderAwaiting}
          memberAwaiting={memberAwaiting}
          launchAvailable={launchAvailable}
          commanderState={stateLabel(operationState(objective.id))}
          commanderExists={operationState(objective.id) !== "closed"}
          request={request}
          onFocusOperation={focusOperation}
        />
      </div>
  );
  // 두 칸과 세 칸은 같은 트리다 — 상세 aside > 스크롤 > 내용·계획 칸 · 운영·판단 칸, 그리고 하단. 폭 경계를 넘어도 요소 종류·부모
  // 경로가 그대로라 결정 요청 초안·추가 줄·편집 중 문구·하단 띠 같은 자식 상태가 다시 마운트되지 않는다. 배치는 CSS 만 바꾼다
  // (세 칸: aside·스크롤을 display: contents 로 걷어 두 칸과 하단이 표면 grid 에 선다).
  const three = layout === "three";
  return (
    <aside ref={detailRef} className={`objectives-detail${busy ? " is-busy" : ""}${three ? " is-three" : ""}`} aria-label={objective.title}>
      <div className="objectives-detail-scroll">
        <div className="objectives-detail-pane is-content">{sHead}{sFollowupResults}{sSchedule}{sBrief}{sOrigin}{sCriteria}{sMissions}</div>
        <div className="objectives-detail-pane is-ops" {...(three ? { role: "region", "aria-label": t("objectives.detail.opsPane", { title: objective.title }) } : {})}>{sCrew}{sDecisions}{sResults}{sFollowups}{sRetro}</div>
      </div>
      {bottom}
    </aside>
  );
}
