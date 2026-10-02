import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { onboardingBoundary } from "@fleet-console/sdk/onboarding/anchors";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import { commanderMode, MAX_FOLLOWUPS, missionReady, unseenRecords, type CommanderMode, type ObjectiveCriterion, type ObjectiveCriterionProposal, type ObjectiveMember, type MissionRecord, type Objective, type ObjectiveMission } from "../server/types.js";
import { ActionBand, type MemberAwaiting, type MessageRecipient } from "./action-band.js";
import { DecisionGlyph, DecisionList, DecisionRequestBlock } from "./decisions.js";
import { RetroGlyph, Retrospective } from "./retrospective.js";
import { ObjectiveResults, ResultsGlyph, ResultsHeadTools } from "./results.js";
import { AttachButton, AttachmentDropVeil, NoteAttachments, imageFiles, useAttachmentUpload } from "./attachments.js";
import { CoordinationGraph, MissionNodeIcon, graphMissionStates, type MissionDetailActions, type MissionState } from "./graph.js";
import { DatePicker } from "./date-picker.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { hasRoutingReason, LaunchControl, LaunchedText, launchedWords, routingReason, useLaunchRows } from "./launch-control.js";
import { dockObjective, expandObjective, openNewOperation, hasDecisionRequest, removeObjectiveLocally, focusOperation, followActiveOperation, loadTheater, notifyObjectiveSurface, patchObjectiveView, post, takeReveal, useOperationSummaries, useReveal, useObjectiveTheater, useObjectiveView, useObjectiveDisplayTheater } from "./objectives-state.js";
import { ObjectiveSwitcher } from "./switcher.js";
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
import { criterionSources, MergedTrail, TidiedDetail } from "./tidied.js";
import { SyncedTextarea } from "@fleet-console/sdk/composer";

export interface ObjectiveContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language?: ConsoleLocale;
  readonly place: "rail" | "expanded";
  /** 호스트 사이드바가 펼쳐져 보이는가 — 아니면(접힘·모바일) 제목 ⌄ 전환 목록이 트리를 대신한다. */
  readonly sideBarVisible?: boolean;
}

type T = Translate<ObjectiveMessageKey>;

const ExpandGlyph = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></svg>;
const DockGlyph = () => <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.5 2.5v11M3 8h7M7 5l3 3-3 3" /></svg>;
const CheckGlyph = () => <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path d="M2 5.2l2.2 2.2L8 3" /></svg>;
const TrashGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" /></svg>;
/** 브리핑 — 봉인된 작전 명령서. 문서 오른쪽 아래 모서리를 인장이 대신한다. */
const BriefGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.3 13.5H4.5A1.5 1.5 0 0 1 3 12V3.5A1.5 1.5 0 0 1 4.5 2h6A1.5 1.5 0 0 1 12 3.5v4.3" /><path d="M5.6 5.2h3.8M5.6 7.8h2.6" /><circle cx="11.4" cy="11.4" r="2.6" /><circle cx="11.4" cy="11.4" r="0.75" fill="currentColor" stroke="none" /></svg>;

/**
 * 2-Pane — 표면 안쪽 폭이 800 이상이고 레일이 아니면 상세 | 운영·판단으로 선다. 운영 칸은 표면 폭의 28%를 300~440 사이로
 * 쓰고, 상세는 480 을 먼저 지킨다. 그 밖은 1-Pane — 같은 트리에서 운영·판단 구획이 상세 아래로 쌓인다.
 * 목록 칸은 없다 — 목표는 Console 사이드바 그룹 트리의 줄로 서고, 사이드바가 접힌 자리에서는 제목 ⌄ 전환 목록이 대신한다.
 */
const TWO_PANE = { threshold: 800, detailMin: 480, opsMin: 300, opsMax: 440, opsShare: 0.28 } as const;
/** 목록 칸 시절의 폭 기억 — 읽는 곳이 없으니 거둔다. */
const RETIRED_WIDTH_KEYS = ["fleet.objectives.three-pane-width", "fleet.objectives.detail-width", "fleet.objectives.rail-detail-width"] as const;
const opsWidthOf = (rootWidth: number): number => Math.max(TWO_PANE.opsMin, Math.min(TWO_PANE.opsMax, Math.round(rootWidth * TWO_PANE.opsShare), rootWidth - TWO_PANE.detailMin));
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
            {record.lines.map((line, at) => <div key={at} className={at === 0 ? "objectives-record-head" : "objectives-record-line"}><LinkText text={line} /></div>)}
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
/** 명단 일괄 모델 설정 입구 트리거 — 3개 노드와 정렬 제어 화살표. */
const BatchTunerGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="3.8" cy="4.5" r="1.4" /><circle cx="3.8" cy="8" r="1.4" /><circle cx="3.8" cy="11.5" r="1.4" /><path d="M7.5 4.5h5M7.5 8h3.5M7.5 11.5h5" /><path d="M11 3l2 1.5-2 1.5M9.5 6.5l2 1.5-2 1.5M11 10l2 1.5-2 1.5" /></svg>;
/** 지휘관과 같게 — 4각 스파크 별에서 우하단 수신 궤도로 꺾여 내려오는 동기화선. */
const StarSparkGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5L4.8 4.2L6.5 5L4.8 5.8L4 7.5L3.2 5.8L1.5 5L3.2 4.2Z" fill="currentColor" stroke="none" /><path d="M6.5 5h3.5a2 2 0 0 1 2 2v4.8M9.8 9.8l2 2 2-2" /><circle cx="4" cy="12.2" r="1.4" /></svg>;
/** 라우팅 — 좌측 단일 요청 노드에서 3갈래 지능 게이트웨이로 모델이 배정되는 분기망. */
const TridentRouteGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="3" cy="8" r="1.4" /><path d="M4.4 8h2.6c1.6 0 2.2-3.8 4.2-3.8h2.2M4.4 8h7M7 8c0 3.8.6 3.8 2.2 3.8h2.2" /><circle cx="13.2" cy="4.2" r="1.1" fill="currentColor" /><circle cx="13.2" cy="8" r="1.1" fill="currentColor" /><circle cx="13.2" cy="11.8" r="1.1" fill="currentColor" /></svg>;
/** 달성 기준 — 과녁. 목표가 이루어졌다고 말할 조건들이 이 아래에 선다. */
const CriteriaGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.4" /><circle cx="8" cy="8" r="0.6" fill="currentColor" /></svg>;
const GraphGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="3.5" cy="8" r="1.6" /><circle cx="12.5" cy="4" r="1.6" /><circle cx="12.5" cy="12" r="1.6" /><path d="M5 7.3l6-2.6M5 8.7l6 2.6" /></svg>;
const WORKING = new Set(["running", "background"]);
const ChevronGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
/** 요청이 선 차례 — 먼저 청한 것이 먼저 선다. 같은 때면 저장된 순서 그대로다. */
const byRequestTime = (a: Objective, b: Objective): number => (a.decisionRequest?.createdAt ?? 0) - (b.decisionRequest?.createdAt ?? 0);

export function ObjectivePanel({ ctx }: { readonly ctx: ObjectiveContext }) {
  const t = getT(ctx.language);
  const language = ctx.language === "ko" ? "ko" : "en";
  const theaterId = useObjectiveDisplayTheater(ctx.theaterId);
  const state = useObjectiveTheater(theaterId);
  const operations = useOperationSummaries();
  const reveal = useReveal();
  // 보기 상태(고른 목표 · 상세 구획 접힘)는 Theater 별 모듈 스토어에 산다 — 표면을 닫았다 열어도 보던 자리 그대로.
  const view = useObjectiveView(theaterId);
  const selected = view.selected;
  const collapsed = view.collapsed;
  const setSelected = useCallback((next: string | null) => patchObjectiveView(theaterId, () => ({ selected: next, externalSelectionId: null })), [theaterId]);
  const toggleSection = (key: string, defaultOpen: boolean) => patchObjectiveView(theaterId, (current) => ({ collapsed: { ...current.collapsed, [key]: key in current.collapsed ? !current.collapsed[key] : defaultOpen } }));
  const isOpen = (key: string, defaultOpen: boolean) => (key in collapsed ? !collapsed[key] : defaultOpen);
  const [highlightMission, setHighlightMission] = useState<string | null>(null);
  // 전환 목록의 열림 — ⌄ 와 빈 상태의 「목표 목록 열기」가 함께 쓴다. 사이드바가 다시 보이면 ⌄ 와 함께 닫는다.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => { if (ctx.sideBarVisible === true) setSwitcherOpen(false); }, [ctx.sideBarVisible]);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootWidth, setRootWidth] = useState(0);
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    setRootWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setRootWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [theaterId]);
  useEffect(() => {
    try { for (const key of RETIRED_WIDTH_KEYS) localStorage.removeItem(key); } catch { /* 저장소를 막은 브라우저에는 거둘 것도 없다. */ }
  }, []);
  // 사이드바 줄의 선택 표시는 표면이 열려 있을 때만 선다 — 열리고 닫힐 때 줄이 다시 읽게 한다(닫힘은 자리 상태가 바뀐 뒤에).
  useEffect(() => {
    notifyObjectiveSurface();
    // 사이드바가 활성으로 보이는 Operation 의 목표로 연다 — 줄·팔레트가 가리킨 목표(reveal)가 있으면 그쪽이 앞선다.
    followActiveOperation();
    return () => { setTimeout(notifyObjectiveSurface, 0); };
  }, []);
  const placeButton = (className: string) => <button type="button" className={`objectives-place-button ${className}`} data-objectives-tour="place" aria-label={t(ctx.place === "rail" ? "objectives.panel.expand" : "objectives.panel.dock")} title={t(ctx.place === "rail" ? "objectives.panel.expand" : "objectives.panel.dock")} onClick={ctx.place === "rail" ? expandObjective : dockObjective}>
    {ctx.place === "rail" ? <ExpandGlyph /> : <DockGlyph />}
  </button>;
  useEffect(() => { if (theaterId) void loadTheater(ctx.api, theaterId); }, [ctx.api, theaterId]);
  // 남겨 둔 자리가 사라졌으면(항목 삭제) 그 자리만 거둔다 — 다른 곳에서 지워진 것을 붙들고 빈 화면을 보이지 않게.
  useEffect(() => {
    if (!state.loaded) return;
    if (selected && !state.objectives.some((objective) => objective.id === selected)) setSelected(null);
  }, [state.loaded, state.objectives, selected, setSelected]);

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
  /** 전환 목록 줄의 글리프 — 사이드바 줄과 같은 판정: 검토 대기 · 시작 전 · 묶음에서 가장 급한 활동. */
  const glyphOf = (objective: Objective): { state: StatusGlyphState; label: string } => {
    if (objective.awaitingReview) return { state: "review", label: t("objectives.objectives.review") };
    if (!objective.commander.started && !operationOf(objective.id)) return { state: "fresh", label: t("objectives.state.fresh") };
    const activity = objectiveActivity(objective);
    return activity === "awaiting" || activity === "running" || activity === "background" || activity === "idle"
      ? { state: activity, label: stateLabel(activity) }
      : { state: "ended", label: stateLabel("ended") };
  };

  const current = selected ? state.objectives.find((objective) => objective.id === selected) ?? null : null;
  const detailRef = useRef<HTMLElement | null>(null);
  // 결정 요청은 전부 센다 — 상세 머리의 「다른 요청」이 이 줄을 돈다.
  const requests = useMemo(() => state.objectives.filter((objective) => hasDecisionRequest(objective) && !objective.removed).sort(byRequestTime), [state.objectives]);
  const reviews = useMemo(() => state.objectives.filter((objective) => objective.awaitingReview && !objective.done && !objective.removed && !hasDecisionRequest(objective)), [state.objectives]);
  /** 「다른 요청」 — 요청이 선 차례대로 다음 목표를 고른다(고른 목표가 요청이 아니면 첫 요청). 끝에서 처음으로 돌아간다. */
  const openNextRequest = () => {
    if (requests.length === 0) return;
    const at = requests.findIndex((objective) => objective.id === selected);
    setSelected(requests[(at + 1) % requests.length]!.id);
  };

  // ── 행동 ──
  const completeObjective = async (objective: Objective) => {
    if (objective.done) { await call("/objective/complete", { objectiveId: objective.id, undone: true }); toast(t("objectives.toast.reopened")); return; }
    const result = await call("/objective/complete", { objectiveId: objective.id });
    if (result) toast(t("objectives.toast.completed"), async () => { await call("/objective/complete", { objectiveId: objective.id, undone: true }); });
  };
  /**
   * 사이드바 검토 대기 글리프의 후속 선택 — open 후보가 1건 이상이면 완료하지 않고 상세를 연다.
   * 편집 없는 검토 대기면 후보 칸까지 펼치고 첫 체크상자로 초점을 주고, 스티어링 대상 편집이면
   * 상세만 열어 띠의 「스티어링」에 초점을 준다.
   */
  const openFollowupPicker = (target: Objective) => {
    const n = target.done ? 0 : openFollowups(target).length;
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
  /** 배치 결과·출처에서 목표 상세를 연다 — 목록에 없는 id(지워진 원본 등)는 두지 않는다. */
  const openObjectiveDetail = (operationId: string) => {
    if (state.objectives.some((entry) => entry.id === operationId)) setSelected(operationId);
  };
  const toggleEdge = async (objective: Objective, from: string, to: string, linked?: boolean) => {
    const result = await call<{ objective: Objective; linked: boolean }>("/edge/toggle", { objectiveId: objective.id, from, to, linked });
    if (!result) return;
    const index = (id: string) => objective.missions.findIndex((mission) => mission.id === id) + 1;
    toast(t(result.linked ? "objectives.toast.linkedEdge" : "objectives.toast.cutEdge", { from: index(from), to: index(to) }));
  };

  // 사이드바 줄·팔레트·캡션에서 온 "이 항목으로" — 이 Theater 의 항목이면 고르고 임무를 잠깐 강조한다. 시작 전 목표(Operation 없음)도 연다.
  // 검토 대기 글리프는 후속 선택으로, 「+ 목표」로 막 만든 목표는 제목 편집으로 바로 들어간다.
  useEffect(() => {
    if (!reveal) return;
    const objective = state.objectives.find((candidate) => candidate.id === reveal.objectiveId);
    if (!objective) return;
    takeReveal();
    setSelected(objective.id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightMission(reveal.missionId ?? null);
    if (reveal.missionId) highlightTimer.current = setTimeout(() => { setHighlightMission(null); highlightTimer.current = null; }, 2400);
    if (reveal.followups) openFollowupPicker(objective);
    if (reveal.focusTitle) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const title = detailRef.current?.querySelector<HTMLTextAreaElement>("textarea.objectives-detail-title");
        title?.focus();
        title?.select();
      }));
    }
  }, [reveal, state.objectives]); // eslint-disable-line react-hooks/exhaustive-deps

  // 고른 입구(팔레트·빈 상태 바로가기)가 사라져 포커스가 BODY 로 빠졌고 트리를 보일 사이드바도 없다 — 새 상세의 ⌄ 가 받는다.
  // 사이드바가 보이면 그 줄이 받는다(호스트 몫). 상세가 새 목표로 다시 마운트된 뒤 프레임에서.
  useEffect(() => {
    if (!selected || ctx.sideBarVisible === true) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body && active.isConnected) return;
        rootRef.current?.querySelector<HTMLElement>(".objectives-switch")?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, ctx.sideBarVisible]);

  if (!theaterId) return <div className="objectives-container"><div className="objectives-root"><div className="objectives-pick-pane"><div className="objectives-pick"><p>{t("objectives.objectives.emptyTheater")}</p></div></div></div></div>;

  // 사이드바가 보이면 트리는 거기 있다. 접혀 있거나(Zen·War Room·Cruise 접힘) 사이드바가 없는 자리(모바일)에서만 ⌄ 가 선다.
  const switcher = ctx.sideBarVisible === true ? null : (
    <ObjectiveSwitcher
      t={t}
      language={language}
      theaterId={theaterId}
      objectives={state.objectives}
      groups={state.groups}
      selected={selected}
      glyphOf={glyphOf}
      hasOperation={(objectiveId) => operationOf(objectiveId) !== null}
      onPick={setSelected}
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      onNewOperation={openNewOperation}
    />
  );
  const noObjectives = state.loaded && !state.objectives.some((objective) => !objective.removed);
  const objectiveShown = !!current && !current.removed;
  const two = objectiveShown && ctx.place !== "rail" && rootWidth >= TWO_PANE.threshold;
  const rootStyle = two ? { "--objectives-ops-w": `${opsWidthOf(rootWidth)}px` } as CSSProperties : undefined;

  let body: ReactNode;
  if (!current && noObjectives) {
    // 고를 목표가 없다 — 「고르세요」도 「목록 열기」도 틀린다. 목표가 어디서 시작하는지 말하고 그 입구를 둔다.
    body = (
      <div className="objectives-pick-pane">
        <div className="objectives-pick-head">
          <span className="objectives-pick-label">{t("objectives.pick.label")}</span>
          {switcher}
          {placeButton("objectives-place-detail")}
        </div>
        <div className="objectives-pick" data-objectives-tour="pick">
          <h5>{t("objectives.none.title")}</h5>
          <p>{t("objectives.none.body")}</p>
          <div className="objectives-pick-shortcuts">
            <button type="button" className="objectives-new-operation" onClick={openNewOperation}>{t("objectives.none.newOperation")}</button>
          </div>
        </div>
      </div>
    );
  } else if (!current) {
    body = (
      <div className="objectives-pick-pane">
        <div className="objectives-pick-head">
          <span className="objectives-pick-label">{t("objectives.pick.label")}</span>
          {switcher}
          {placeButton("objectives-place-detail")}
        </div>
        <div className="objectives-pick" data-objectives-tour="pick">
          <h5>{t("objectives.pick.title")}</h5>
          {/* 트리가 사이드바에 없으면 「사이드바에서 고르라」는 말이 틀린다 — 접혔다고 밝히고(사이드바가 없는 자리에서는 생략) 목록을 여는 입구를 둔다. */}
          <p>{switcher ? [
            ctx.sideBarVisible === false ? t("objectives.pick.collapsed") : null,
            t(requests.length || reviews.length ? "objectives.pick.openHintShortcuts" : "objectives.pick.openHint"),
          ].filter(Boolean).join(" ") : t("objectives.pick.body")}</p>
          {requests.length || reviews.length || switcher ? (
            <div className="objectives-pick-shortcuts">
              {requests.map((objective) => <button key={objective.id} type="button" onClick={() => setSelected(objective.id)}>{t("objectives.pick.request", { title: objective.title })}</button>)}
              {reviews.map((objective) => <button key={objective.id} type="button" onClick={() => setSelected(objective.id)}>{t("objectives.pick.review", { title: objective.title })}</button>)}
              {switcher ? <button type="button" className="objectives-pick-open" data-objectives-switch-opener aria-haspopup="true" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen(!switcherOpen)}>{t("objectives.pick.openList")}</button> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  } else if (current.removed) {
    body = <TidiedDetail key={current.id} objective={current} t={t} language={language} call={call} onOpenObjective={openObjectiveDetail} detailRef={detailRef} head={<>{switcher}{placeButton("objectives-place-detail")}</>} />;
  } else {
    body = (
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
        sectionOpen={(key) => isOpen(key, key !== "detail:missionList")}
        onToggleSection={(key) => toggleSection(key, key !== "detail:missionList")}
        onOpenSection={(key) => patchObjectiveView(theaterId, (view) => ({ collapsed: { ...view.collapsed, [key]: false } }))}
        highlightMission={highlightMission}
        switcher={switcher}
        detailRef={detailRef}
        layout={two ? "two" : "one"}
        placeButton={placeButton("objectives-place-detail")}
        onComplete={() => completeObjective(current)}
        onToggleEdge={(from, to, linked) => toggleEdge(current, from, to, linked)}
        onOpenObjective={openObjectiveDetail}
        otherRequests={requests.filter((objective) => objective.id !== current.id).length}
        onNextRequest={openNextRequest}
      />
    );
  }
  return (
    // 온보딩 경계(SDK 계약) — 투어 카드가 패널을 가리지 않고 패널 옆, 짚는 구획 높이에 선다(레일이든 넓은 화면이든
    // 자리가 없으면 앵커 기준 배치로 돌아간다).
    <div className="objectives-container" {...onboardingBoundary("anchor")} onPointerDownCapture={(event) => {
      if (highlightMission && !(event.target as Element).closest(`[data-mission-id="${CSS.escape(highlightMission)}"]`)) {
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
        setHighlightMission(null);
      }
    }}><div ref={rootRef} className={`objectives-root${two ? " is-two" : ""}`} style={rootStyle}>
      {body}
    </div></div>
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
    // 라우팅으로 떴으면 그 근거, 폴백이면 사유가 풀네임 뒤에 붙는다 — 같은 「모델 · 강도」 줄이 어떻게 정해졌는지 말한다.
    const title = member.routed?.via === "route" ? t("objectives.members.routedBecause", { model: running.title, because: member.routed.because })
      : member.routed?.via === "fallback" ? t("objectives.members.fallbackBecause", { model: running.title, reason: routingReason(t, member.routed.reason) }) : running.title;
    return { text: <LaunchedText model={running.model} words={running.words} />, title, label: `${running.words.model} · ${running.words.effort}` };
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
/** 라우팅이 꺼졌거나 후보가 없는 것은 실패가 아니라 설정 상태다 — 폴백 줄도 시트처럼 중립으로 말한다. */
const ROUTING_OFF_REASONS = new Set(["routing_disabled", "routing_off", "no_candidate"]);

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
  const [notes, setNotes] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [balloon, setBalloon] = useState<{ kind: "done"; changed: number; preserved: number; mode: "same" | "route" } | { kind: "failed" } | null>(null);
  const batchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const batchMenuRef = useRef<HTMLDivElement | null>(null);
  const balloonTimer = useRef<number | null>(null);
  // 실패 줄의 「다른 모델」이 그 구성원의 메뉴를 연다 — 구성원마다 여는 손잡이 하나.
  const openers = useRef(new Map<string, MutableRefObject<(() => void) | null>>());
  const opener = (id: string) => { let ref = openers.current.get(id); if (!ref) { ref = { current: null }; openers.current.set(id, ref); } return ref; };
  const cancelNext = (member: ObjectiveMember) => void call("/member/next-cancel", { objectiveId: objective.id, memberId: member.id });
  // 예약한 구성원의 수명이 바뀌는 것을 보면 서버가 그 예약을 따지게 한다 — 휴면 중 예약은 깨어난 것으로, 떠 있던 중 예약은 잠들었다가
  // 새 프로세스로 깨어난 것으로(서버가 세대를 가른다) 거둔다. 같은 예약·같은 수명 구간에서는 한 번만 묻고, 다시 휴면해도 옛 예약이 되살아나지 않는다.
  const settled = useRef(new Map<string, string>());
  const wokenKeys = objective.members.flatMap((member) => {
    if (!member.next || member.next.failed) return [];
    const state = member.sessionName !== null ? operationState(member.id) : "closed";
    // 떠 있는 채팅의 턴 뒤 예약은 그 턴이 닫히는 것을 보면 서버가 호스트 좌표를 다시 읽어 마감한다(적용이 끝날 때까지 서버가 잠깐 더 본다).
    if (member.next.afterTurn) return state === "idle" || state === "background" ? [`${member.id}:${member.next.model}:${member.next.effort ?? ""}:turn`] : [];
    const live = MEMBER_LIVE.has(state);
    if (!live && member.next.reservedWhile === "dormant") return [];
    return [`${member.id}:${member.next.model}:${member.next.effort ?? ""}:${member.next.reservedWhile}:${live ? "live" : "ended"}`];
  });
  useEffect(() => {
    for (const key of wokenKeys) {
      const memberId = key.slice(0, key.indexOf(":"));
      if (settled.current.get(memberId) === key) continue;
      settled.current.set(memberId, key);
      void request("/member/next-settle", { objectiveId: objective.id, memberId }).catch(() => { if (settled.current.get(memberId) === key) settled.current.delete(memberId); });
    }
  }, [objective.id, wokenKeys.join("|")]);
  // 안내는 구성원마다 따로 사라진다 — 한 타이머를 공유하면 앞서 뜬 구성원의 안내가 남는다.
  const noteTimers = useRef(new Map<string, number>());
  const dropNote = (id: string) => {
    const timer = noteTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    noteTimers.current.delete(id);
    setNotes((current) => { if (!current.has(id)) return current; const updated = new Set(current); updated.delete(id); return updated; });
  };
  const showNotes = (ids: readonly string[]) => {
    setNotes((current) => new Set([...current, ...ids]));
    for (const id of ids) {
      const timer = noteTimers.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      noteTimers.current.set(id, window.setTimeout(() => dropNote(id), 10_000));
    }
  };

  // 바뀐 순간의 확인 — 곧바로 적용된 응답이나 이번 턴 뒤 예약의 정산을 보면 그 행 아래에 잠깐 「바꿨습니다」를 세운다. 서버에 남기지 않는 화면의 일시 상태다.
  const [applied, setApplied] = useState<ReadonlyMap<string, { readonly model?: string; readonly effort?: string }>>(new Map());
  const appliedTimers = useRef(new Map<string, number>());
  const flashApplied = (id: string, to: { readonly model?: string; readonly effort?: string }) => {
    const timer = appliedTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    setApplied((current) => new Map(current).set(id, to));
    appliedTimers.current.set(id, window.setTimeout(() => {
      appliedTimers.current.delete(id);
      setApplied((current) => { if (!current.has(id)) return current; const updated = new Map(current); updated.delete(id); return updated; });
    }, 2_600));
  };
  // 턴 뒤 예약은 서버 방송으로 정산된다 — 직전 렌더에 그 예약이 있었고, 이제 실패 없이 사라져 실행값이 그 값이면 바뀐 순간이다.
  const afterTurnSeen = useRef(new Map<string, { readonly model: string; readonly effort?: string }>());
  useEffect(() => {
    const seen = new Map<string, { readonly model: string; readonly effort?: string }>();
    for (const member of objective.members) {
      const before = afterTurnSeen.current.get(member.id);
      if (before && !member.next && member.model === before.model && (member.effort ?? "") === (before.effort ?? "")) flashApplied(member.id, before);
      if (member.next?.afterTurn && !member.next.failed) seen.set(member.id, { model: member.next.model, ...(member.next.effort ? { effort: member.next.effort } : {}) });
    }
    afterTurnSeen.current = seen;
  }, [objective.members]);

  useEffect(() => () => {
    for (const timer of noteTimers.current.values()) window.clearTimeout(timer);
    for (const timer of appliedTimers.current.values()) window.clearTimeout(timer);
    if (balloonTimer.current !== null) window.clearTimeout(balloonTimer.current);
  }, []);

  useEffect(() => {
    if (!batchOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!batchMenuRef.current?.contains(target) && !batchTriggerRef.current?.contains(target)) {
        setBatchOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setBatchOpen(false);
        batchTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [batchOpen]);

  // 띄운 구성원의 모델 — 떠 있는 채팅은 호스트가 곧바로 또는 이번 턴 뒤 바꾼다. 호스트가 거절하면(문맥이 새 모델의 창보다 큼 등) 그 행에 사유가 선다.
  const pickLaunched = (member: ObjectiveMember, launch: Record<string, unknown>) => {
    void request("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch } }).then(
      (payload) => {
        setFault((current) => current?.id === member.id ? null : current);
        // 유휴 채팅은 곧바로 바뀐다 — 예약 없이 실행값이 달라졌으면 그 순간이다.
        const echoed = (payload as { objective?: Objective } | null)?.objective?.members.find((entry) => entry.id === member.id);
        if (echoed?.switchesLive && !echoed.next && (echoed.model !== member.model || (echoed.effort ?? "") !== (member.effort ?? ""))) flashApplied(member.id, { ...(echoed.model ? { model: echoed.model } : {}), ...(echoed.effort ? { effort: echoed.effort } : {}) });
      },
      (error: unknown) => setFault({ id: member.id, code: error instanceof Error ? error.message : "unknown" }));
  };
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
      if (!live) { dropNote(member.id); return; }
      showNotes([member.id]);
    }, (error: unknown) => {
      saving.current.delete(member.id);
      setFault({ id: member.id, code: error instanceof Error ? error.message : "unknown" });
    });
  };

  const applyBatch = (mode: "same" | "route") => {
    if (saving.current.has("batch") || !touchable) return;
    saving.current.add("batch");
    setBatchOpen(false);
    // 앞선 결과 말풍선은 이번 선택의 결과가 아니다 — 먼저 거둔다.
    if (balloonTimer.current !== null) window.clearTimeout(balloonTimer.current);
    setBalloon(null);
    const settle = (next: NonNullable<typeof balloon>) => {
      setBalloon(next);
      balloonTimer.current = window.setTimeout(() => setBalloon(null), 3800);
    };

    // 성공도 실패도 입구 글리프의 말풍선으로 알린다 — 패널에는 따로 띄우는 알림이 없고, 명단은 접혀 있을 수 있다.
    void request("/member/batch-launch", { objectiveId: objective.id, mode }).then((payload) => {
      saving.current.delete("batch");
      const echoed = (payload as { objective?: Objective } | null)?.objective?.members;
      if (!echoed) { settle({ kind: "failed" }); setAnnounce(t("objectives.members.batchFailed")); return; }

      const changedMembers = echoed.filter((member) => {
        const old = objective.members.find((entry) => entry.id === member.id);
        return old && old.launch.mode !== member.launch.mode;
      });
      // 직접 지정과, 일괄 「라우팅」이 건너뛴 띄운 구성원 — 서버가 센다.
      const preservedCount = (payload as { preserved?: number } | null)?.preserved ?? echoed.filter((member) => member.launch.mode === "model").length;
      const changedCount = changedMembers.length;

      settle({ kind: "done", changed: changedCount, preserved: preservedCount, mode });

      if (changedCount > 0) {
        setAnnounce(t("objectives.members.batchAnnounce", { count: changedCount, preserved: preservedCount }));
      } else {
        setAnnounce(t("objectives.members.batchAnnounceNoop"));
      }

      // 실제로 값이 바뀐 구성원 중 실행 중인 세션에게만 안내 노출
      const changedLiveIds = changedMembers
        .filter((member) => MEMBER_LIVE.has(member.sessionName !== null ? operationState(member.id) : "closed"))
        .map((member) => member.id);

      if (changedLiveIds.length > 0) showNotes(changedLiveIds);
    }, () => {
      saving.current.delete("batch");
      settle({ kind: "failed" });
      setAnnounce(t("objectives.members.batchFailed"));
    });
  };

  // 달성 기준·임무 줄과 같은 문법 — 글자 자체가 입력칸이고, 떠나면 저장한다. Enter 는 확정, Escape 는 되돌린다.
  const inlineKeys = (original: string) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (submitKey(event)) event.currentTarget.blur();
    else if (event.key === "Escape") { event.currentTarget.value = original; event.currentTarget.blur(); }
  };

  const actions = objective.members.length > 0 && touchable ? (
    <div className="objectives-batch-actions">
      <button
        ref={batchTriggerRef}
        type="button"
        className={`objectives-glyph objectives-batch-trigger${batchOpen ? " is-active" : ""}`}
        title={t("objectives.members.batchTitle")}
        aria-label={t("objectives.members.batchAria")}
        aria-haspopup="menu"
        aria-expanded={batchOpen}
        onClick={() => setBatchOpen((open) => !open)}
      >
        <BatchTunerGlyph />
      </button>
      {balloon?.kind === "failed" ? (
        <span className="objectives-batch-balloon" aria-hidden="true">
          <span className="objectives-batch-balloon-dot is-failed" />
          <span>{t("objectives.members.batchFailed")}</span>
        </span>
      ) : balloon ? (
        <span className="objectives-batch-balloon" aria-hidden="true">
          <span className={`objectives-batch-balloon-dot is-${balloon.mode}`} />
          <span>{balloon.changed > 0 ? t("objectives.members.batchChanged", { count: balloon.changed }) : t("objectives.members.batchNoop")}</span>
          {balloon.preserved > 0 ? <span className="objectives-batch-balloon-preserved">{t("objectives.members.batchPreserved", { count: balloon.preserved })}</span> : null}
        </span>
      ) : null}
      {batchOpen ? (
        <div ref={batchMenuRef} className="objectives-menu objectives-batch-menu" role="menu" aria-label={t("objectives.members.batchTitle")}>
          <button type="button" role="menuitem" className="objectives-menu-item" onClick={() => applyBatch("same")}>
            <span className="objectives-batch-menu-glyph is-same"><StarSparkGlyph /></span>
            <span className="objectives-menu-label">
              <span className="objectives-batch-menu-title">{t("objectives.members.batchInherit")}</span>
              <span className="objectives-batch-menu-hint">{t("objectives.members.batchInheritHint")}</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="objectives-menu-item" onClick={() => applyBatch("route")}>
            <span className="objectives-batch-menu-glyph is-route"><TridentRouteGlyph /></span>
            <span className="objectives-menu-label">
              <span className="objectives-batch-menu-title">{t("objectives.members.batchRoute")}</span>
              <span className="objectives-batch-menu-hint">{t("objectives.members.batchRouteHint")}</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  ) : null;

  return <div className="objectives-members">
    <SectionHead glyph={<CoordGlyph />} label={t("objectives.members.title")} tools={<span>{objective.members.length}</span>} actions={actions}
      {...(objective.members.length > 0 ? { controls: "objectives-sec-members", expanded, onToggle } : {})} />
    <div id="objectives-sec-members" hidden={!expanded}>
    {objective.members.length === 0 ? <p className="objectives-members-empty">{t("objectives.members.empty")}</p> : null}
    {objective.members.map((shownMember, index) => {
      const count = objective.missions.filter((mission) => mission.member === shownMember.id).length;
      const state = shownMember.sessionName !== null ? operationState(shownMember.id) : "closed";
      // 휴면 중 예약한 구성원이 깨어 있으면 그 재개가 이미 예약 좌표를 읽었다 — 서버가 다시 방송하기 전에도 실행값으로 보인다.
      const wokeOnNext = !!shownMember.next && !shownMember.next.failed && !shownMember.next.afterTurn && shownMember.next.reservedWhile === "dormant" && MEMBER_LIVE.has(state);
      const member: ObjectiveMember = wokeOnNext && shownMember.next ? { ...shownMember, model: shownMember.next.model, effort: shownMember.next.effort, routed: null, next: null } : shownMember;
      const launched = memberLaunched(member, operationState);
      const display = memberLaunchDisplay(member, launched, t, rows);
      const routed = launched ? member.routed : null;
      const next = launched ? member.next : null;
      const reserved = next && !next.failed ? next : null;
      const appliedTo = launched ? applied.get(member.id) ?? null : null;
      const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
      const commanderWords = launchedWords(rows, objective.commander.model, objective.commander.effort, labels);
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
            <WrapText key={`brief:${member.brief ?? ""}`} className="objectives-member-brief" label={t("objectives.members.briefAria", { role: member.role })} editLabel={t("objectives.link.edit")} value={member.brief ?? ""} placeholder={touchable ? t("objectives.members.briefPlaceholder") : t("objectives.members.noBrief")} readOnly={!touchable} maxLength={300}
              onCommit={(value) => { if (value !== (member.brief ?? "")) void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { brief: value || null } }); return true; }} />
          </div>
          <div className="objectives-member-meta">
            {routed ? <span className={`objectives-member-via is-${routed.via}`} title={t(routed.via === "route" ? "objectives.members.routedTitle" : ROUTING_OFF_REASONS.has(routed.reason) ? "objectives.members.fallbackOffTitle" : "objectives.members.fallbackTitle")}>{t(routed.via === "route" ? "objectives.members.routed" : "objectives.members.fallback")}</span> : null}
            {launched ? (
              // 띄운 구성원 — 행은 실행값 그대로, 고른 값은 다음 재개부터의 예약이다. 라우팅은 새로 띄울 때만 판단하므로 고를 수 없다.
              <LaunchControl key={member.id} t={t} model={reserved ? reserved.model : member.model} effort={reserved ? reserved.effort : member.effort} locked={!touchable} startAtList triggerLabel={t("objectives.members.modelAria", { role: member.role })}
                triggerText={display.text} triggerTitle={display.title} openRef={opener(member.id)}
                head={<><b>{t(state === "ended" ? "objectives.members.menuHead.last" : "objectives.members.menuHead.running", { model: display.label })}</b><span>{t(state === "ended" ? "objectives.members.menuHead.dormant" : !member.switchesLive ? "objectives.members.menuHead.live" : state === "idle" || state === "background" ? "objectives.members.menuHead.chatIdle" : "objectives.members.menuHead.chatRunning")}</span></>}
                extras={[{ id: "same", label: t("objectives.memberSelection.inherit"), hint: `${commanderWords.words.model} · ${commanderWords.words.effort}`, active: member.launch.mode === "same", onPick: () => pickLaunched(member, { mode: "same" }) }]}
                extrasCaption={t("objectives.members.routeAtLaunch")}
                subagents={touchable ? { allowed, onToggle: () => toggleSubagents(member, MEMBER_LIVE.has(state)) } : undefined}
                onChange={(picked) => { const model = picked.model ?? reserved?.model ?? member.model; if (model) pickLaunched(member, { mode: "model", model, effort: picked.effort }); }} />
            ) : (
            <LaunchControl key={member.id} t={t} model={member.launch.mode === "model" ? member.launch.model : undefined} effort={member.launch.mode === "model" ? member.launch.effort : undefined} locked={!touchable} startAtList={member.launch.mode !== "model"} triggerLabel={t("objectives.members.modelAria", { role: member.role })}
              triggerText={display.text} triggerTitle={display.title}
              extras={[{ id: "route", label: t("objectives.memberSelection.route"), hint: t("objectives.members.routeHint"), active: member.launch.mode === "route", onPick: () => void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch: null } }) }, { id: "same", label: t("objectives.memberSelection.inherit"), active: member.launch.mode === "same", onPick: () => void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch: { mode: "same" } } }) }]}
              subagents={touchable ? { allowed, onToggle: () => toggleSubagents(member, MEMBER_LIVE.has(state)) } : undefined}
              onChange={(next) => { const model = next.model ?? (member.launch.mode === "model" ? member.launch.model : undefined); if (model) void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch: { mode: "model", model, effort: next.effort } } }); }} />
            )}
            <span className={`objectives-member-status is-${state}`} title={state === "ended" ? t("objectives.members.dormantHint") : undefined}>{status}{allowed ? <span className="objectives-member-subagents">{t("objectives.members.subagentsMark")}</span> : null}</span>
          </div>
          {touchable ? <button type="button" className="objectives-glyph objectives-member-remove" title={t("objectives.members.remove")} aria-label={t("objectives.members.removeAria", { role: member.role })} onClick={() => remove(member)}><TrashGlyph /></button> : null}
        </div>
        {reserved ? (
          <div className="objectives-member-next">
            <span className="objectives-member-next-when">{t(reserved.afterTurn ? "objectives.members.next.whenTurn" : "objectives.members.next.when")}</span>
            <span className="objectives-member-next-arrow" aria-hidden="true">→</span>
            {((words) => <span className="objectives-member-next-to" title={words.title}><LaunchedText model={words.model} words={words.words} /></span>)(launchedWords(rows, reserved.model, reserved.effort, labels))}
            {touchable ? <button type="button" className="objectives-glyph objectives-member-next-x" aria-label={t("objectives.members.next.cancel", { role: member.role })} title={t("objectives.members.next.cancel", { role: member.role })} onClick={() => cancelNext(member)}><CloseGlyph /></button> : null}
          </div>
        ) : next?.failed ? (
          <div className="objectives-member-next is-failed" role="alert">
            <span className="objectives-member-next-when">{t(next.afterTurn ? "objectives.members.next.failedTurn" : "objectives.members.next.failed")}</span>
            <span className="objectives-member-next-body">{t(next.afterTurn ? "objectives.members.next.failedTurnBody" : "objectives.members.next.failedBody", { model: launchedWords(rows, next.model, next.effort, labels).title, reason: routingReason(t, next.failed) })}</span>
            {touchable ? <button type="button" className="objectives-btn is-small objectives-member-next-other" onClick={() => opener(member.id).current?.()}>{t("objectives.members.next.other")}</button> : null}
            {touchable ? <button type="button" className="objectives-glyph objectives-member-next-x" aria-label={t("objectives.members.next.dismiss")} title={t("objectives.members.next.dismiss")} onClick={() => cancelNext(member)}><CloseGlyph /></button> : null}
          </div>
        ) : appliedTo ? (
          <div className="objectives-member-next is-applied" role="status">
            <span className="objectives-member-next-when">{t("objectives.members.next.applied")}</span>
            <span className="objectives-member-next-arrow" aria-hidden="true">→</span>
            {((words) => <span className="objectives-member-next-to" title={words.title}><LaunchedText model={words.model} words={words.words} /></span>)(launchedWords(rows, appliedTo.model, appliedTo.effort, labels))}
          </div>
        ) : routed?.via === "fallback" ? <p className="objectives-member-reason" title={routed.detail}>{routed.reason === "no_candidate" ? t("objectives.members.fallbackNoCandidate") : ROUTING_OFF_REASONS.has(routed.reason) ? t("objectives.members.fallbackOff") : t("objectives.members.fallbackLine", { reason: routingReason(t, routed.reason) })}</p> : null}
        {notes.has(member.id) ? <p className="objectives-member-note" aria-hidden="true">{t("objectives.members.subagentsLive")}</p> : null}
        {fault?.id === member.id ? <p className="objectives-member-note is-error" role="alert">{hasRoutingReason(fault.code) ? routingReason(t, fault.code) : t("objectives.toast.failed", { code: fault.code })}</p> : null}
        </div>
      );
    })}
    {touchable ? (
      <div className="objectives-row objectives-mission-add">
        <span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span>
        <input aria-label={t("objectives.members.add")} placeholder={t("objectives.members.add")} maxLength={40} onKeyDown={(event) => { if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget; const role = target.value.trim(); target.value = ""; void call("/member/add", { objectiveId: objective.id, member: { role } }); } }} />
      </div>
    ) : null}
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

type DetailSection = "detail:criteria" | "detail:missions" | "detail:missionList" | "detail:results" | "detail:decisions" | "detail:followups" | "detail:members" | "detail:retro";

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
  /** 제목 옆 ⌄ 전환 목록 — 사이드바가 보이면 없다. */
  readonly switcher: ReactNode;
  readonly detailRef: RefObject<HTMLElement | null>;
  /** 1-Pane(운영·판단이 아래로 쌓임) 또는 2-Pane(내용·계획 | 운영·판단) — 같은 상세를 어떻게 나눠 그릴지만 정한다. */
  readonly layout: "one" | "two";
  readonly placeButton: ReactNode;
  readonly onComplete: () => void;
  readonly onToggleEdge: (from: string, to: string, linked?: boolean) => Promise<void>;
  /** 배치 결과·출처에서 목표 상세를 연다 — 목록에 있는 항목만 연다. */
  readonly onOpenObjective: (operationId: string) => void;
  /** 이 목표를 뺀 결정 요청 수 — 모든 폭에서 머리의 「다른 요청 N」이 다음 요청으로 가는 길이 된다. */
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
function LineupZoom({ t, title, width, onClose, children }: { readonly t: Translate<ObjectiveMessageKey>; readonly title: string; readonly width?: number | null; readonly onClose: () => void; readonly children: ReactNode }) {
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
      if (event.key === "Escape") { if (document.querySelector("[data-graph-popup]:not(.is-closing)")) return; event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab" || !cardRef.current) return;
      const card = cardRef.current;
      const stops = [...card.querySelectorAll<HTMLElement | SVGElement>("button, input, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !(el as HTMLButtonElement).disabled);
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
      <div ref={cardRef} className="objectives-zoom" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal="true" aria-label={`${t("objectives.missions.title")} · ${title}`} tabIndex={-1}>
        <div className="objectives-zoom-head">
          <span className="objectives-zoom-title">{t("objectives.missions.title")}<span className="objectives-zoom-item">{title}</span></span>
          <button type="button" className="objectives-glyph" aria-label={t("objectives.detail.close")} title={t("objectives.detail.close")} onClick={onClose}><CloseGlyph /></button>
        </div>
        {children}
      </div>
    </div>
  );
}


const AssignGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="2.2" /><circle cx="11" cy="11" r="2.2" /><path d="M7 5h3.5a1.5 1.5 0 0 1 1.5 1.5V8.8M9 11H5.5A1.5 1.5 0 0 1 4 9.5V7.2" /></svg>;

const GoGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9.5 3.5h3v3M12.5 3.5 7.5 8.5" /></svg>;


/** 한 줄로 저장하는 문구 — 붙여넣은 줄바꿈은 저장 때 공백이 된다. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();
/** `field-sizing: content` 가 없는 엔진(WebKit)은 글상자 높이를 직접 잰다. */
const FIELD_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
function fitHeight(element: HTMLTextAreaElement | null): void {
  if (!element || FIELD_SIZING) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

/** 누른 자리의 글자 오프셋. 읽기 표시의 편집 단추 글자는 세지 않고, 못 구하면 null. */
function readCaretOffset(root: HTMLElement, x: number, y: number): number | null {
  const legacy = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const position = document.caretPositionFromPoint?.(x, y);
  const hit = position ? null : legacy.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? hit?.startContainer ?? null;
  const offset = position ? position.offset : hit?.startOffset;
  if (!node || offset === undefined || !root.contains(node)) return null;
  const host = node instanceof Element ? node : node.parentElement;
  if (host?.closest("button")) return null;
  const range = document.createRange();
  try {
    range.setStart(root, 0);
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  const fragment = range.cloneContents();
  fragment.querySelectorAll("button").forEach((button) => button.remove());
  return fragment.textContent?.length ?? null;
}

function placeCaret(field: HTMLTextAreaElement, offset: number | null): void {
  const at = offset === null ? field.value.length : Math.min(Math.max(0, offset), field.value.length);
  field.setSelectionRange(at, at);
}

/**
 * 임무·달성 기준·구성원 설명의 문구 — 한 줄 입력칸이 아니라 줄바꿈하는 글상자라 길어도 전문이 그 자리에서 보인다(제목·근거 줄과
 * 같은 문법). 편집은 그대로: Enter 는 확정이고(줄바꿈이 아니다) 떠나면 저장한다. Esc 는 되돌리고 칸만 떠난다(상세는 닫지 않는다).
 */
function WrapText({ className, label, editLabel, value, readOnly, maxLength, placeholder, onCommit, onEscape }: {
  readonly className: string;
  readonly label: string;
  /** 읽기 표시에서 원문 입력으로 들어가는 단추 이름. */
  readonly editLabel: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly maxLength?: number;
  readonly placeholder?: string;
  /** 줄바꿈을 공백으로 바꾼 값. 저장하지 않을 값이면 false 를 돌려 칸을 원래 글로 되돌린다. */
  readonly onCommit: (value: string) => boolean;
  readonly onEscape?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const placedCaret = useRef(false);
  useLayoutEffect(() => {
    if (!editing) { placedCaret.current = false; return; }
    const field = ref.current;
    if (!field) return;
    fitHeight(field);
    if (placedCaret.current) return;
    placedCaret.current = true;
    field.focus();
    placeCaret(field, caretRef.current);
  }, [editing, value]);
  // 폴백 엔진에서는 폭이 바뀌면 줄 수도 바뀐다.
  useEffect(() => {
    if (!editing) return;
    const element = ref.current;
    if (FIELD_SIZING || !element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; fitHeight(element); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [editing]);
  if (!editing) {
    const start = (offset: number | null) => { if (!readOnly) { caretRef.current = offset; setEditing(true); } };
    return (
      <div
        className={`${className} is-read`}
        onClick={(event) => {
          if (readOnly) return;
          const target = event.target;
          if (target instanceof Element && target.closest("a, button")) return;
          if (window.getSelection()?.toString()) return;
          start(readCaretOffset(event.currentTarget, event.clientX, event.clientY));
        }}
      >
        {value ? <LinkText text={value} /> : placeholder ? <span className="objectives-read-placeholder">{placeholder}</span> : null}
        {readOnly ? null : <button type="button" className="objectives-read-edit" aria-label={`${editLabel}: ${label}`} onClick={() => start(null)}>{editLabel}</button>}
      </div>
    );
  }
  return (
    <SyncedTextarea
      ref={ref}
      className={className}
      rows={1}
      aria-label={label}
      value={value}
      readOnly={readOnly}
      maxLength={maxLength}
      placeholder={placeholder}
      onInput={(event) => fitHeight(event.currentTarget)}
      onKeyDown={(event) => {
        if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); }
        else if (event.key === "Escape") { event.preventDefault(); event.currentTarget.value = value; fitHeight(event.currentTarget); event.currentTarget.blur(); if (onEscape) { event.stopPropagation(); onEscape(); } }
      }}
      onBlur={(event) => {
        const next = oneLine(event.currentTarget.value);
        event.currentTarget.value = onCommit(next) ? next : value;
        fitHeight(event.currentTarget);
        setEditing(false);
      }}
    />
  );
}

/**
 * 섹션 머리 — 글리프 열·라벨·오른쪽 셈과 도구. 접히는 섹션은 행 전체가 버튼이고 셰브런이 맨 끝에 선다(접힘 0°, 펼침 90°).
 * 항목이 없으면 접지 않는다 — 추가 행이 늘 보이게 셰브런 없는 정적 머리로 둔다.
 */
function SectionHead({ glyph, label, tools, actions, controls, expanded, onToggle }: {
  readonly glyph: ReactNode;
  readonly label: string;
  readonly tools?: ReactNode;
  readonly actions?: ReactNode;
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
  const head = !controls ? <div className="objectives-row is-static">{inner}</div> : (
    <button type="button" className="objectives-row objectives-acc-hd" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {inner}
      <span className="objectives-section-chev" aria-hidden="true"><ChevronGlyph /></span>
    </button>
  );
  if (!actions) return head;
  return (
    <div className="objectives-section-head-bar">
      {head}
      <div className="objectives-section-head-actions">{actions}</div>
    </div>
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
        {n > 0 ? <span className="objectives-criterion-number" aria-hidden="true">{n}</span> : null}
        <div className="objectives-criterion-body">
          <span className="objectives-proposal-kind">{label}</span>
          {proposal.kind === "revise" && target ? <del className="objectives-proposal-text is-old"><LinkText text={target.text} /></del> : null}
          {proposal.kind === "retire"
            ? <>
              <del className="objectives-proposal-text"><LinkText text={target?.text ?? ""} /></del>
              {proposal.reason ? <span className="objectives-criterion-sub"><LinkText text={t("objectives.proposal.reason", { reason: proposal.reason })} /></span> : null}
            </>
            : <span className="objectives-proposal-text"><LinkText text={proposal.text ?? ""} /></span>}
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
          <SyncedTextarea
            ref={fieldRef}
            autoFocus
            rows={2}
            maxLength={300}
            value={saved}
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

// 제목 초안은 제 칸에서만 산다 — 상세 전체가 글자마다 다시 그리지 않는다. 값은 SyncedTextarea가 DOM에 맞춘다(글자마다
// React가 defaultValue를 다시 쓰면 문서의 :has() 무효화가 맵 전체의 스타일을 다시 계산한다).
function DetailTitle({ objective, t, editable, call }: { objective: Objective; t: T; editable: boolean; call: DetailProps["call"] }) {
  return (
    <SyncedTextarea className="objectives-detail-title" aria-label={t("objectives.objective.titleAria")} value={objective.title} rows={1} readOnly={!editable} onKeyDown={(event) => { if (submitKey(event)) { event.preventDefault(); event.currentTarget.blur(); } }} onBlur={(event) => { const title = event.currentTarget.value; if (title.trim() && title !== objective.title) void call("/objective/patch", { objectiveId: objective.id, patch: { title: title.trim() } }); }} />
  );
}

// 브리핑 구획 — 초안·초점·접힘·첨부 상태를 구획 안에 둬서 쓰는 동안 상세의 나머지(그래프·구획 입력칸)가 따라 그리지 않는다.
function BriefSection({ objective, t, language, touchable, call, onOpenObjective }: { objective: Objective; t: T; language: DetailProps["language"]; touchable: boolean; call: DetailProps["call"]; onOpenObjective: DetailProps["onOpenObjective"] }) {
  const [note, setNote] = useState(objective.note);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setNote(objective.note); }, [objective.note]);
  const attachments = useAttachmentUpload(objective, t);
  const [dropping, setDropping] = useState(false);
  // 브리핑 — 쉴 때 3줄, 넘치면 「더 보기」. 쓰는 동안(초점)은 다 보인다(360px 뒤로는 안에서 스크롤).
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const readRef = useRef<HTMLDivElement | null>(null);
  const wasEditing = useRef(false);
  const briefCaret = useRef<number | null>(null);
  const [noteFocus, setNoteFocus] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteOverflow, setNoteOverflow] = useState(false);
  const [briefEditing, setBriefEditing] = useState(false);
  const noteClamped = !noteOpen && !noteFocus;
  // 빈 브리핑은 「브리핑 추가」 한 줄 — 누르거나 초점이 오면 편집 칸이 아래로 세 줄 펼쳐진다. 끌어오는 동안은 겹판만 서고 자리는 그대로다.
  const [briefActive, setBriefActive] = useState(false);
  const briefBlank = !note.trim() && objective.attachments.length === 0;
  const briefCollapsed = briefBlank && touchable && !briefActive && !attachments.error && attachments.sending === 0;
  const startBrief = (offset: number | null = null) => {
    briefCaret.current = offset;
    setBriefEditing(true);
    setBriefActive(true);
    setNoteFocus(true);
  };
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
  const fitRead = useCallback(() => {
    const element = readRef.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 20;
    const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const clampAt = line * BRIEF_LINES + pad;
    const clamped = !noteOpen;
    element.style.maxHeight = "none";
    element.style.overflow = "visible";
    const full = element.scrollHeight;
    element.style.maxHeight = `${Math.ceil(Math.min(full, clamped ? clampAt : 360))}px`;
    element.style.overflow = clamped ? "hidden" : "auto";
    setNoteOverflow(full > clampAt + 1);
  }, [noteOpen]);
  useLayoutEffect(() => {
    if (briefEditing) {
      const field = noteRef.current;
      const entering = !wasEditing.current;
      if (entering) field?.focus();
      wasEditing.current = true;
      fitNote();
      if (entering && field) placeCaret(field, briefCaret.current);
    } else {
      wasEditing.current = false;
      fitRead();
    }
  }, [note, briefEditing, fitNote, fitRead]);
  useEffect(() => {
    const element = briefEditing ? noteRef.current : readRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; if (briefEditing) fitNote(); else fitRead(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [briefEditing, fitNote, fitRead]);

  const saveNote = (value: string) => {
    setNote(value);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => { void call("/objective/patch", { objectiveId: objective.id, patch: { note: value } }); }, 600);
  };
  return (<>
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
          {touchable && !briefEditing ? <button type="button" className="objectives-read-edit" onClick={() => startBrief()}>{t("objectives.link.edit")}</button> : null}
          {touchable ? <AttachButton objective={objective} t={t} upload={attachments.upload} sending={attachments.sending} /> : null}
        </> : null} />
        <NoteAttachments objective={objective} t={t} touchable={touchable} error={attachments.error} sending={attachments.sending} onRemove={(attachment) => void call("/attachment/remove", { objectiveId: objective.id, attachmentId: attachment.id })} />
        {briefEditing && touchable ? (
          <SyncedTextarea ref={noteRef} className={`objectives-note${noteClamped ? " is-clamped" : ""}${briefBlank && !briefCollapsed ? " is-writing" : ""}`} rows={1} aria-label={t("objectives.objective.memo")} placeholder={t("objectives.objective.memoPlaceholder")} value={note} onChange={(event) => saveNote(event.target.value)}
            onFocus={() => setNoteFocus(true)} onBlur={() => { setNoteFocus(false); setBriefEditing(false); }}
            onPaste={(event) => { const files = imageFiles(event.clipboardData.files); if (files.length) { event.preventDefault(); void attachments.upload(files); } }} />
        ) : note.trim() ? (
          <div ref={readRef} className={`objectives-note is-read${noteClamped ? " is-clamped" : ""}`} onClick={(event) => {
            if (!touchable) return;
            const target = event.target;
            if (target instanceof Element && target.closest("a")) return;
            if (window.getSelection()?.toString()) return;
            startBrief(readCaretOffset(event.currentTarget, event.clientX, event.clientY));
          }}><LinkText text={note} /></div>
        ) : touchable ? (
          <button type="button" className="objectives-note is-read is-placeholder" onFocus={() => startBrief()} onClick={() => startBrief()}>{t("objectives.objective.memoPlaceholder")}</button>
        ) : (
          <div className="objectives-note is-read is-placeholder">{t("objectives.objective.memoPlaceholder")}</div>
        )}
        {dropping ? <AttachmentDropVeil t={t} /> : null}
        {noteOverflow && (noteOpen || !noteFocus) ? <button type="button" className="objectives-note-more" aria-expanded={noteOpen} onPointerDown={(event) => event.preventDefault()} onClick={() => setNoteOpen((value) => !value)}>{t(noteOpen ? "objectives.brief.less" : "objectives.brief.more")}</button> : null}
        <MergedTrail objective={objective} t={t} language={language} call={call} onOpenObjective={onOpenObjective} />
      </div>
  </>);
}

function ObjectiveDetail({ objective, t, language, launchAvailable, call, toast, modeLabel, stateLabel, operationTitle, operationState, operationOwnState, busy, request, sectionOpen, onToggleSection, onOpenSection, highlightMission, switcher, detailRef, layout, placeButton, onComplete, onToggleEdge, onOpenObjective, otherRequests, onNextRequest }: DetailProps) {
  const launchRows = useLaunchRows();
  const mode = commanderMode(objective.missions);
  const mergedFrom = criterionSources(objective);
  // 수동 재개로 초기화된 유휴 세션도 잠근다. 구성원의 활동이 아니라 지휘관 자신의 상태로 판단한다.
  const locked = objective.commander.started || ["idle", "running", "background", "awaiting"].includes(operationOwnState(objective.id));
  const editable = !objective.done && !busy;
  // 지휘관이 일하는 동안에도 받는 편집 — 임무 추가, 끝나지 않은 임무의 문구·삭제·선행·담당, 메모. 구성원이 떠 있어도 임무는 끝나기 전까지 사람의 것이다. 서버가 같은 기준으로 가른다.
  const touchable = !objective.done;
  const notStarted = (mission: ObjectiveMission) => !mission.done;
  const canEditMission = (missionId: string) => { if (editable) return true; const target = objective.missions.find((candidate) => candidate.id === missionId); return touchable && !!target && notStarted(target); };
  const [zoomOpen, setZoomOpen] = useState(false);
  // 확대 카드 폭 — 확대 그래프가 스크롤 없이 들어가는 폭을 알려 준다.
  const [zoomWidth, setZoomWidth] = useState<number | null>(null);
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
  // 그래프 팝업에서 편 기록 — 팝업이 다른 임무로 가거나 닫히면 이것만 접는다(목록 행에서 편 기록은 남는다).
  const popupRecords = useRef(new Set<string>());
  const togglePopupRecords = (mission: ObjectiveMission) => {
    if (mission.id in openRecords) popupRecords.current.delete(mission.id); else popupRecords.current.add(mission.id);
    toggleRecords(mission);
  };
  const closePopupRecords = (showing: string | null) => {
    const drop = [...popupRecords.current].filter((id) => id !== showing);
    popupRecords.current = new Set(showing && popupRecords.current.has(showing) ? [showing] : []);
    if (drop.length) setOpenRecords((current) => drop.some((id) => id in current) ? Object.fromEntries(Object.entries(current).filter(([id]) => !drop.includes(id))) : current);
  };
  const [missionReveal, setMissionReveal] = useState<{ id: string; at: number } | null>(null);
  // 짚은 목록 행 — 그 행과 선행 행을 함께 켠다.
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
    setMissionReveal({ id: missionId, at: Date.now() });
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
  // 임무 목록 — 그래프 위에 서고 접힘이 기본이다. 머리를 접어도 그래프와 추가 입력은 남는다.
  const missionListOpen = missionsCollapsible && sectionOpen("detail:missionList");
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
    setMissionReveal({ id: highlightMission, at: Date.now() });
    // 접힌 목록의 행은 숨어 있다 — 보이는 첫 자리(펼친 행, 아니면 그래프 노드)로 간다.
    const frame = requestAnimationFrame(() => [...detailRef.current?.querySelectorAll(`[data-mission-id="${CSS.escape(highlightMission)}"]`) ?? []].find((element) => element.getClientRects().length > 0)?.scrollIntoView({ block: "nearest" }));
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

  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const doneMissions = objective.missions.filter((mission) => mission.done).length;

  const sHead = (<>
      <div className="objectives-group">
        <div className="objectives-detail-head">
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
          <DetailTitle objective={objective} t={t} editable={editable} call={call} />
          {switcher}
          {otherRequests > 0 ? <button type="button" className="objectives-detail-requests" title={t("objectives.requests.othersTip")} onClick={onNextRequest}>{t("objectives.requests.others", { count: otherRequests })}</button> : null}
          {!busy ? <button type="button" className="objectives-detail-delete" aria-label={t("objectives.objective.delete")} title={t("objectives.objective.delete")} onClick={async () => { const removed = await call<{ objective: Objective }>("/objective/remove", { objectiveId: objective.id }); if (removed && !removed.objective.removed) { removeObjectiveLocally(objective.id); toast(t("objectives.toast.deleted")); } }}><TrashGlyph /></button> : null}
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
  const sBrief = <BriefSection objective={objective} t={t} language={language} touchable={touchable} call={call} onOpenObjective={onOpenObjective} />;
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
        {followupOrigin.userImpact ? <p className="objectives-origin-impact"><b>{t("objectives.followup.impact")}</b> <LinkText text={followupOrigin.userImpact} /></p> : null}
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
                <span className="objectives-criterion-number" aria-hidden="true">{index + 1}</span>
                <div className="objectives-criterion-body">
                  <WrapText key={criterion.text} className="objectives-criterion-text" label={t("objectives.criteria.itemAria", { n: index + 1 })} editLabel={t("objectives.link.edit")} value={criterion.text} readOnly={!touchable} maxLength={300}
                    onCommit={(value) => { if (!value) return false; if (value !== criterion.text) void call("/criterion/patch", { objectiveId: objective.id, criterionId: criterion.id, patch: { text: value } }); return true; }} />
                  {evidence ? <span className="objectives-criterion-sub is-evidence">{t("objectives.criteria.evidence", { evidence })}</span>
                    : criterion.by === "commander" ? <span className="objectives-criterion-sub">{t("objectives.criteria.proposed")}</span>
                    : mergedFrom.get(criterion.id) ? <span className="objectives-criterion-sub">{t("objectives.tidied.fromCriterion", { title: mergedFrom.get(criterion.id)! })}</span> : null}
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
  const renderMissionDetail = (mission: ObjectiveMission, { close, select, state }: MissionDetailActions) => {
    const index = numberOf(mission.id), member = objective.members.find(m => m.id === mission.member);
    const allowed = canEditMission(mission.id), recordsOpen = mission.id in openRecords, unseen = unseenRecords(mission);
    const children = objective.missions.filter(m => m.prerequisites.includes(mission.id));
    const patch = (value: Record<string, unknown>) => void call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: value });
    const edgeRow = (other: ObjectiveMission, from: string, to: string) => <div className="objectives-popup-edge-row" key={other.id}>
      <span className="objectives-popup-edge-icon"><MissionNodeIcon state={missionStates.get(other.id)!} number={numberOf(other.id)} /></span><button type="button" aria-label={`${t("objectives.graph.detail", { n: numberOf(other.id) })}. ${other.text}. ${t(`objectives.graph.state.${missionStates.get(other.id)!}`)}`} onClick={() => select(other.id)}>{other.text}</button>
      <button type="button" className="objectives-popup-cut" disabled={!canEditMission(to)} aria-label={t("objectives.graph.edgeAria", { from: numberOf(from), to: numberOf(to) })} title={canEditMission(to) ? t("objectives.graph.cut") : t("objectives.graph.locked")} onClick={() => void onToggleEdge(from, to, false)}>×</button>
      {mission.why[other.id] && mission.why[other.id] !== "human" ? <small>{mission.why[other.id]}</small> : null}
    </div>;
    return <>
      <div className="objectives-popup-head"><span>{t("objectives.graph.detail", { n: index })}</span><span className={`objectives-popup-state is-${state}`}><i />{t(`objectives.graph.state.${state}`)}</span><button type="button" className="objectives-glyph" aria-label={t("objectives.detail.close")} onClick={close}><CloseGlyph /></button></div>
      <WrapText key={`${mission.id}:${mission.text}`} className="objectives-popup-title" label={t("objectives.graph.titleInput", { n: index })} editLabel={t("objectives.link.edit")} value={mission.text} readOnly={!allowed} maxLength={200} onEscape={close} onCommit={value => { if (!value) return false; if (value !== mission.text) patch({ text: value }); return true; }} />
      {!allowed ? <p className="objectives-popup-hint">{t("objectives.graph.locked")}</p> : null}
      {!mission.done && state === "blocked" ? <p className="objectives-popup-hint">{t("objectives.missions.prerequisites", { missions: mission.prerequisites.filter(id => !objective.missions.find(m => m.id === id)?.done).map(numberOf).join("·") })}</p> : null}
      <div className="objectives-popup-group"><div className="objectives-popup-group-head">{t("objectives.graph.owner")}<span>{member?.role ?? t("objectives.graph.commander")} · {stateLabel(operationOwnState(member?.id ?? objective.id))}</span></div>
        <div className="objectives-popup-members" role="radiogroup" aria-label={t("objectives.missions.setMember")} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], at = options.indexOf(document.activeElement as HTMLButtonElement);
          if (!options.length) return;
          event.preventDefault(); const next = options[(at + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + options.length) % options.length]!; next.focus(); next.click();
        }}>
          {[...objective.members, null].map(option => <button key={option?.id ?? "commander"} type="button" role="radio" aria-checked={mission.member === (option?.id ?? null)} tabIndex={mission.member === (option?.id ?? null) ? 0 : -1} disabled={!allowed} onClick={() => patch({ member: option?.id ?? null })}>{option ? <MemberMark role={option.role} tone={memberTone(objective, option.id)} /> : <CommanderMark />}{option?.role ?? t("objectives.graph.commander")}</button>)}
        </div>
      </div>
      <div className="objectives-popup-group"><div className="objectives-popup-group-head">{t("objectives.graph.parents")} {mission.prerequisites.length}</div>{mission.prerequisites.map(id => { const parent = objective.missions.find(m => m.id === id); return parent ? edgeRow(parent, parent.id, mission.id) : null; })}{mission.unplaced ? <p className="objectives-popup-hint">{t("objectives.graph.unplacedHint")}</p> : null}</div>
      {children.length ? <div className="objectives-popup-group"><div className="objectives-popup-group-head">{t("objectives.graph.children")} {children.length}</div>{children.map(child => edgeRow(child, mission.id, child.id))}</div> : null}
      {mission.records.length ? <div className="objectives-popup-group"><button type="button" className="objectives-popup-text-button" aria-expanded={recordsOpen} onClick={() => togglePopupRecords(mission)}>{t("objectives.records.count", { index, count: mission.records.length })}{unseen ? ` · ${t("objectives.records.unseen", { count: unseen })}` : ""} {recordsOpen ? "−" : "+"}</button>{recordsOpen ? <MissionRecords id={`graph-records-${mission.id}`} records={mission.records} seenAtOpen={openRecords[mission.id] ?? EMPTY_IDS} open t={t} language={language} /> : <p className="objectives-popup-hint">{mission.records.at(-1)?.lines[0] ? <LinkText text={mission.records.at(-1)!.lines[0]!} /> : null}</p>}</div> : null}
      {objective.decisions.filter(d => d.missionId === mission.id).map(d => <button key={d.id} type="button" className="objectives-popup-text-button" onClick={() => { close(); showDecision(d.id); }}>{t("objectives.decisions.missionLink", { index, count: 1 })}</button>)}
      <div className="objectives-popup-actions"><button type="button" className="objectives-popup-text-button" disabled={!editable} onClick={() => patch({ done: !mission.done })}>{t(mission.done ? "objectives.graph.reopen" : "objectives.missions.done")}</button><button type="button" className="objectives-popup-text-button is-danger" disabled={mission.done || !touchable} onClick={() => void call("/mission/remove", { objectiveId: objective.id, missionId: mission.id })}>{t("objectives.missions.remove")}</button></div>
      {!editable ? <p className="objectives-popup-hint">{t(objective.done ? "objectives.graph.locked" : "objectives.graph.doneLocked")}</p> : null}
    </>;
  };
  const missionStates = graphMissionStates(objective, operationOwnState);
  const countOrder: readonly MissionState[] = ["awaiting", "running", "ready", "blocked", "unplaced", "done"];
  const statusCounts = countOrder.map(state => ({ state, count: [...missionStates.values()].filter(value => value === state).length })).filter(entry => entry.count > 0);
  const renderCounts = (wide = false) => <span className={`objectives-graph-counts${wide ? " is-wide" : ""}`} role="img" aria-label={statusCounts.map(({ state, count }) => `${t(`objectives.graph.state.${state}`)} ${count}`).join(", ")}>{statusCounts.map(({ state, count }) => <span className={`objectives-popup-state is-${state}`} key={state} title={`${t(`objectives.graph.state.${state}`)} ${count}`}><i aria-hidden="true" /><span className="objectives-graph-count-label">{t(`objectives.graph.state.${state}`)}</span><b>{count}</b></span>)}</span>;
  const awaitingMissions = objective.done ? [] : objective.missions.filter(mission => missionStates.get(mission.id) === "awaiting");
  const missionAttention = awaitingMissions.map(mission => {
    const owner = objective.members.find(member => member.id === mission.member);
    const ownerName = owner?.role ?? t("objectives.graph.commander");
    return <div key={mission.id} className="objectives-graph-attention" role="status"><span className="objectives-popup-state is-awaiting" aria-hidden="true"><i /></span><span className="objectives-graph-attention-owner">{t("objectives.graph.ownerAwaiting", { owner: ownerName })}</span><button type="button" onClick={() => showMission(mission.id)}>{t("objectives.graph.detail", { n: numberOf(mission.id) })}</button><button type="button" className="objectives-graph-attention-session" onClick={() => focusOperation(owner?.id ?? objective.id)}>{t("objectives.graph.openSession")}</button></div>;
  });
  const graphProps = { objective, t, states: missionStates, canEdit: canEditMission, renderDetail: renderMissionDetail, onShowing: closePopupRecords, onEdge: (from: string, to: string, linked: boolean) => void onToggleEdge(from, to, linked), reveal: missionReveal };
  const missionAdd = touchable ? <div className="objectives-row objectives-mission-add"><span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span><input maxLength={200} aria-label={t("objectives.missions.add")} placeholder={t("objectives.missions.add")} onKeyDown={event => {
    if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget, value = target.value; void call("/mission/add", { objectiveId: objective.id, mission: { text: value.trim() } }).then(result => { if (result && target.value === value) target.value = ""; }); }
  }} /></div> : null;
  const graphTools = <button ref={zoomTriggerRef} type="button" className="objectives-glyph" aria-haspopup="dialog" aria-expanded={zoomOpen} aria-label={t("objectives.graph.zoom")} title={t("objectives.graph.zoom")} onClick={() => setZoomOpen(true)}><ZoomGlyph /></button>;
  const missionList = missionsCollapsible ? <div id="objectives-sec-mission-list" hidden={!missionListOpen}>
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
              <WrapText key={mission.text} className="objectives-mission-text" label={`${index + 1}`} editLabel={t("objectives.link.edit")} value={mission.text} readOnly={!canEditMission(mission.id)} maxLength={200}
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
  </div> : null;
  const sMissions = <div className="objectives-group objectives-missions-group" data-objectives-tour="missions">
    <SectionHead glyph={<GraphGlyph />} label={t("objectives.missions.title")} tools={<>{unseenAny ? <i className="objectives-sec-unseen" title={t("objectives.missions.unseen")} /> : null}{renderCounts()}</>}
      {...(missionsCollapsible ? { controls: "objectives-sec-mission-list", expanded: missionListOpen, onToggle: () => onToggleSection("detail:missionList"), actions: graphTools } : {})} />
    {missionAttention}
    {missionList}
    <div id="objectives-sec-missions">{objective.missions.length ? <CoordinationGraph {...graphProps} suspended={zoomOpen} /> : null}{missionAdd}</div>
    {zoomOpen && objective.missions.length > 0 ? createPortal(<LineupZoom t={t} title={objective.title} width={zoomWidth} onClose={() => { setZoomOpen(false); setZoomWidth(null); zoomTriggerRef.current?.focus(); }}><SectionHead glyph={<GraphGlyph />} label={t("objectives.missions.title")} tools={<><span className="objectives-criteria-count">{t("objectives.missions.count", { done: doneMissions, total: objective.missions.length })}</span>{renderCounts(true)}</>} />{missionAttention}<CoordinationGraph {...graphProps} zoom onFitWidth={setZoomWidth} />{missionAdd}</LineupZoom>, document.body) : null}
  </div>;
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
          />
        </div>
      </div>
      ) : null}
  </>);
  // 「메시지」의 받는 이 — 지휘관(자기 활동)과 세션이 떠 있는 구성원. 상태 낱말은 명단 줄과 같은 말을 쓴다.
  const memberStateWord = (state: string) => state === "ended" ? t("objectives.members.dormant") : state === "running" || state === "background" ? t("objectives.members.working") : state === "awaiting" ? t("objectives.awaiting.word") : t("objectives.members.idle");
  const recipients: MessageRecipient[] = [
    { id: objective.id, role: t("objectives.graph.commander"), mark: <CommanderMark />, state: operationOwnState(objective.id) },
    ...objective.members.filter((member) => member.sessionName !== null).map((member) => ({ id: member.id, role: member.role, mark: <MemberMark role={member.role} tone={memberTone(objective, member.id)} />, state: operationState(member.id) })),
  ].filter((recipient) => recipient.state !== "closed");
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
          recipients={recipients}
          stateWord={memberStateWord}
          request={request}
          onFocusOperation={focusOperation}
          routingTargets={objective.members.filter((member) => member.launch.mode === "route" && !memberLaunched(member, operationState))}
          memberLaunched={(member) => memberLaunched(member, operationState)}
          memberMark={(memberId) => <MemberMark role={objective.members.find((member) => member.id === memberId)?.role ?? "?"} tone={memberTone(objective, memberId)} />}
        />
      </div>
  );
  // 1-Pane 과 2-Pane 은 같은 트리다 — 상세 aside > 스크롤 > 내용·계획 칸 · 운영·판단 칸, 그리고 하단. 폭 경계를 넘어도 요소 종류·부모
  // 경로가 그대로라 결정 요청 초안·추가 줄·편집 중 문구·하단 띠 같은 자식 상태가 다시 마운트되지 않는다. 배치는 CSS 만 바꾼다
  // (2-Pane: aside·스크롤을 display: contents 로 걷어 두 칸과 하단이 표면 grid 에 선다).
  const two = layout === "two";
  return (
    <aside ref={detailRef} className={`objectives-detail${busy ? " is-busy" : ""}${two ? " is-two" : ""}`} aria-label={objective.title}>
      <div className="objectives-detail-scroll">
        <div className="objectives-detail-pane is-content">{sHead}{sFollowupResults}{sSchedule}{sBrief}{sOrigin}{sCriteria}{sMissions}</div>
        <div className="objectives-detail-pane is-ops" {...(two ? { role: "region", "aria-label": t("objectives.detail.opsPane", { title: objective.title }) } : {})}>{sCrew}{sDecisions}{sResults}{sFollowups}{sRetro}</div>
      </div>
      {bottom}
    </aside>
  );
}
