import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { onboardingBoundary } from "@fleet-console/sdk/onboarding/anchors";
import { createPortal } from "react-dom";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { OpenLinkHandler } from "@fleet-console/sdk/link";
import type { StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import { DISPLAY_QUIET_MS, describeQuietMission, objectiveUnderway, quietElapsed, quietSince } from "../server/signals.js";
import { commanderMode, extensionOf, missionReady, unseenRecords, type CommanderMode, type ObjectiveCriterion, type ObjectiveCriterionProposal, type ObjectiveMember, type MissionRecord, type Objective, type ObjectiveMission } from "../server/types.js";
import { DecisionGlyph, DecisionList, PersonHoldNote } from "./decisions.js";
import { RetroGlyph, Retrospective } from "./retrospective.js";
import { ExtensionChip, ExtensionDivider, ExtensionHistory } from "./extensions.js";
import { ObjectiveResults, ResultsGlyph, resultGroupKey } from "./results.js";
import { AttachButton, AttachmentDropVeil, NoteAttachments, imageFiles, useAttachmentUpload } from "./attachments.js";
import { commanderMongleState, memberMongleState, ObjectiveAvatar } from "./objective-avatar.js";
import { CoordinationGraph, MissionNodeIcon, graphMissionStates, setGraphOrientation, useGraphOrientation, type MissionDetailActions, type MissionState } from "./graph.js";
import { actorDid, criterionApproval } from "./actors.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LinkText } from "./link-text.js";
import { hasRoutingReason, LaunchControl, launchedWords, MEMBER_LIVE, MemberLaunchControl, memberLaunched, memberNotes, memberRoutedTag, memberStatus, memberSubagents, routingReason, useLaunchRows, type MemberLaunchChoice } from "./launch-control.js";
import { canOpenLedger, toggleLedger, useLedgerOperation, openNewOperation, hasDecisionRequest, focusOperation, followActiveOperation, listedOperationSummaries, loadTheater, notifyObjectiveSurface, patchObjectiveView, post, takeReveal, useOperationSummaries, useReveal, useObjectiveTheater, useObjectiveView, useObjectiveDisplayTheater } from "./objectives-state.js";
import { freshConversationObjectiveId, openFreshConversation, shownFinishedObjective, subscribeFreshConversation, subscribeShownFinished } from "./fresh-conversation.js";
import { personTurnAt, useCommodoreBoard } from "./commodore-state.js";
import { ObjectiveSwitcher } from "./switcher.js";
import {
  followupGate,
  isFollowupSelectable,
  openFollowups,
  readBatches,
  readHistory,
  readOrigin,
  requestFollowupFocus,
  setFollowupOpen,
} from "./followups.js";
import { FollowupBatchResults, FollowupForkGlyph } from "./followups-view.js";
import { criterionSources, MergedTrail } from "./merged.js";
import { ObjectiveLinkOpenProvider } from "./link-open-context.js";
import { SyncedTextarea } from "@fleet-console/sdk/composer";

export interface ObjectiveContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language?: ConsoleLocale;
  /** 호스트가 채워 준 링크 열기 길 — 없으면 앵커 기본 동작으로 떨어진다. */
  readonly openLink?: OpenLinkHandler | null;
  /** 호스트 사이드바가 펼쳐져 보이는가 — 아니면(접힘·모바일) 제목 ⌄ 전환 목록이 트리를 대신한다. */
  readonly sideBarVisible?: boolean;
}

type T = Translate<ObjectiveMessageKey>;

const TrashGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" /></svg>;
/** 브리핑 — 봉인된 작전 명령서. 문서 오른쪽 아래 모서리를 인장이 대신한다. */
const BriefGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.3 13.5H4.5A1.5 1.5 0 0 1 3 12V3.5A1.5 1.5 0 0 1 4.5 2h6A1.5 1.5 0 0 1 12 3.5v4.3" /><path d="M5.6 5.2h3.8M5.6 7.8h2.6" /><circle cx="11.4" cy="11.4" r="2.6" /><circle cx="11.4" cy="11.4" r="0.75" fill="currentColor" stroke="none" /></svg>;

/**
 * 상세 탭 — Console 오른쪽 패널 머리(아바타·이름 아래)에 두 줄로 선다: 첫 줄은 오늘·기한, 둘째 줄은 「목표 · 구성원 · 결과물」 세 낱말이다
 * (head-tabs.tsx). 결정 내역은 목표 탭 맨 아래, 임무 그래프는 구성원 탭 맨 아래에 섹션 머리로 이어 붙는다. 「구성원」은 대상의 구성원 탭을 대신한다. 탭은 요청한 내용만 담고,
 * 목표 전체의 상태는 머리에, 지금 할 일은 하단 띠에 둔다. 고른 탭은 Theater 별 보기 상태에 하나로 남는다(목표를 바꿔도 그 탭으로 연다).
 * 목록 칸은 없다 — 목표는 Console 사이드바 그룹 트리의 줄로 서고, 사이드바가 접힌 자리에서는 제목 ⌄ 전환 목록이 대신한다.
 */
export const DETAIL_TABS = ["goal", "crew", "results"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];
/** 합쳐진 옛 탭 — 임무는 구성원 탭 아래로, 결정사항은 목표 탭 아래로 갔다. 같은 세션의 옛 값과 옛 id 의 select 를 그 자리로 보낸다. */
const MERGED_TABS: Readonly<Record<string, DetailTab>> = { missions: "crew", decisions: "goal" };
export const detailTabOf = (value: string | undefined): DetailTab => (DETAIL_TABS as readonly string[]).includes(value ?? "") ? value as DetailTab : MERGED_TABS[value ?? ""] ?? "goal";
/** 목록 칸 시절의 폭 기억 — 읽는 곳이 없으니 거둔다. */
const RETIRED_WIDTH_KEYS = ["fleet.objectives.three-pane-width", "fleet.objectives.detail-width", "fleet.objectives.rail-detail-width"] as const;
export function todayIso(): string { return new Date().toISOString().slice(0, 10); }
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

/** 탭 바 기한 글리프 곁의 짧은 날짜 — 월·일 숫자만(좁은 폭에서는 숨는다). */
export function dueShort(iso: string, language: "en" | "ko"): string {
  const [, month, day] = iso.split("-").map(Number);
  return language === "ko" ? `${month}.${day}` : `${month}/${day}`;
}
export function dueLabel(iso: string, language: "en" | "ko"): string {
  const date = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", weekday: "short" }).format(date);
}
export const SunGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" /></svg>;
export const CalGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></svg>;
/** 명단 일괄 모델 설정 입구 트리거 — 3개 노드와 정렬 제어 화살표. */
const BatchTunerGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="3.8" cy="4.5" r="1.4" /><circle cx="3.8" cy="8" r="1.4" /><circle cx="3.8" cy="11.5" r="1.4" /><path d="M7.5 4.5h5M7.5 8h3.5M7.5 11.5h5" /><path d="M11 3l2 1.5-2 1.5M9.5 6.5l2 1.5-2 1.5M11 10l2 1.5-2 1.5" /></svg>;
/** 지휘관과 같게 — 4각 스파크 별에서 우하단 수신 궤도로 꺾여 내려오는 동기화선. */
const StarSparkGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5L4.8 4.2L6.5 5L4.8 5.8L4 7.5L3.2 5.8L1.5 5L3.2 4.2Z" fill="currentColor" stroke="none" /><path d="M6.5 5h3.5a2 2 0 0 1 2 2v4.8M9.8 9.8l2 2 2-2" /><circle cx="4" cy="12.2" r="1.4" /></svg>;
/** 라우팅 — 좌측 단일 요청 노드에서 3갈래 지능 게이트웨이로 모델이 배정되는 분기망. */
const TridentRouteGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="3" cy="8" r="1.4" /><path d="M4.4 8h2.6c1.6 0 2.2-3.8 4.2-3.8h2.2M4.4 8h7M7 8c0 3.8.6 3.8 2.2 3.8h2.2" /><circle cx="13.2" cy="4.2" r="1.1" fill="currentColor" /><circle cx="13.2" cy="8" r="1.1" fill="currentColor" /><circle cx="13.2" cy="11.8" r="1.1" fill="currentColor" /></svg>;
/** 달성 기준 — 과녁. 목표가 이루어졌다고 말할 조건들이 이 아래에 선다. */
const CriteriaGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="2.4" /><circle cx="8" cy="8" r="0.6" fill="currentColor" /></svg>;
const GraphGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true"><circle cx="3.5" cy="8" r="1.6" /><circle cx="12.5" cy="4" r="1.6" /><circle cx="12.5" cy="12" r="1.6" /><path d="M5 7.3l6-2.6M5 8.7l6 2.6" /></svg>;
const WORKING = new Set(["running"]);
/** 호스트 요약의 원시 활동 → 이 패널이 그리는 활동. 백그라운드 작업만 남은 Operation 도 진행 중으로 선다. */
const shownActivity = (activity: string): string => (activity === "background" ? "running" : activity);
const ChevronGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" /></svg>;
/** 요청이 선 차례 — 먼저 청한 것이 먼저 선다. 같은 때면 저장된 순서 그대로다. */


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
  /**
   * 사람이 고른 목표 — 완료해 지휘관이 보관된 목표는 가운데 칸에 완료 화면을 세운다. 범위 넓히기는 그 화면의 입력창이 받는다
   * (대화 중심 화면이 꺼져 있으면 아무 일도 없다).
   */
  const pickObjective = useCallback((next: string | null) => {
    setSelected(next);
    const picked = next === null ? undefined : state.objectives.find((objective) => objective.id === next);
    if (picked?.done && !listedOperationSummaries().some((summary) => summary.id === picked.id)) openFreshConversation(picked.id, picked.theaterId);
  }, [setSelected, state.objectives]);
  const toggleSection = (key: string, defaultOpen: boolean) => patchObjectiveView(theaterId, (current) => ({ collapsed: { ...current.collapsed, [key]: key in current.collapsed ? !current.collapsed[key] : defaultOpen } }));
  const isOpen = (key: string, defaultOpen: boolean) => (key in collapsed ? !collapsed[key] : defaultOpen);
  const [highlightMission, setHighlightMission] = useState<string | null>(null);
  // 전환 목록의 열림 — ⌄ 와 빈 상태의 「목표 목록 열기」가 함께 쓴다. 사이드바가 다시 보이면 ⌄ 와 함께 닫는다.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => { if (ctx.sideBarVisible === true) setSwitcherOpen(false); }, [ctx.sideBarVisible]);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);
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
  // 목표 상세는 대화 중심 화면의 우측 레일에만 선다 — 머리(제목·완료·보관·작업 줄)는 가운데 대화의 머리와 레일 캡션이 맡는다.
  useEffect(() => { if (theaterId) void loadTheater(ctx.api, theaterId); }, [ctx.api, theaterId]);
  // 남겨 둔 자리가 사라졌으면(항목 삭제) 그 자리만 거둔다 — 다른 곳에서 지워진 것을 붙들고 빈 화면을 보이지 않게.
  // 가운데 칸이 보관된 완료 목표의 완료 화면이면 그 목표는 목록에 없어도 남는다 — 보드는 읽어 둔 끝난 목표 레코드를 보인다(완료라 고칠 수 없다).
  const standingId = useSyncExternalStore(subscribeFreshConversation, freshConversationObjectiveId, freshConversationObjectiveId);
  const shownDone = useSyncExternalStore(subscribeShownFinished, shownFinishedObjective, shownFinishedObjective);
  useEffect(() => {
    if (!state.loaded) return;
    if (selected && selected !== standingId && !state.objectives.some((objective) => objective.id === selected)) setSelected(null);
  }, [state.loaded, state.objectives, selected, setSelected, standingId]);

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
  // 턴 뒤에 남은 백그라운드 작업(background)은 화면에서 진행 중(running)이다 — 활동을 읽는 이 두 곳에서 접는다.
  const operationState = useCallback((operationId: string): string => shownActivity(operationOf(operationId)?.activity ?? "closed"), [operationOf]);
  // 지휘관 자신의 활동 — 코어는 구성원의 대기·실행을 지휘관 활동으로 끌어올린다. 하단 한 자리는 지휘관 자신의 대기·실행과
  // 구성원의 것을 가려야 하므로 끌어올리기 전 값(ownActivity)을 읽는다. 구성원·부모 아닌 Operation 은 activity 와 같다.
  const operationOwnState = useCallback((operationId: string): string => { const operation = operationOf(operationId); return operation ? shownActivity(operation.ownActivity ?? operation.activity) : "closed"; }, [operationOf]);
  // 항목의 활동 = 지휘관과 담당 가운데 가장 급한 것 — 호스트가 캔버스에서 지휘관을 그리는 셈법과 같다.
  const URGENCY: Record<string, number> = { awaiting: 0, running: 1, idle: 3, ended: 4, unknown: 5 };
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
  const stateLabel = (state: string) => t((["running", "awaiting", "idle", "ended", "closed"].includes(state) ? `objectives.state.${state}` : "objectives.state.unknown") as Parameters<typeof t>[0]);
  /** 전환 목록 줄의 글리프 — 사이드바 줄과 같은 판정: 검토 대기 · 시작 전 · 묶음에서 가장 급한 활동. */
  const glyphOf = (objective: Objective): { state: StatusGlyphState; label: string } => {
    if (objective.awaitingReview) return { state: "review", label: t("objectives.objectives.review") };
    if (!objective.commander.started && !operationOf(objective.id)) return { state: "fresh", label: t("objectives.state.fresh") };
    const activity = objectiveActivity(objective);
    return activity === "awaiting" || activity === "running" || activity === "idle"
      ? { state: activity, label: stateLabel(activity) }
      : { state: "ended", label: stateLabel("ended") };
  };

  const current = selected ? state.objectives.find((objective) => objective.id === selected) ?? (shownDone?.id === selected ? shownDone : null) : null;
  const detailRef = useRef<HTMLElement | null>(null);
  // 사람의 차례만 센다 — 사이드바 「내 결정」·레일 배지와 같은 판정(`personTurnAt`). 상세 머리의 「다른 요청」이 이 줄을 돈다.
  // 사령관이 맡은 요청은 접힌 「사령관이 맡음」에서 연다.
  const commodore = useCommodoreBoard(theaterId ?? "");
  const requests = useMemo(() => state.objectives
    .flatMap((objective) => { const at = objective.removed ? null : personTurnAt(objective, commodore.active); return at === null ? [] : [{ objective, at }]; })
    .sort((a, b) => a.at - b.at).map((entry) => entry.objective), [state.objectives, commodore.active]);
  const reviews = useMemo(() => state.objectives.filter((objective) => objective.awaitingReview && !objective.done && !objective.removed && !hasDecisionRequest(objective)), [state.objectives]);
  // ── 행동 ──
  /**
   * 사이드바 검토 대기 글리프의 후속 선택 — open 후보가 1건 이상이면 완료하지 않고 상세를 연다.
   * 편집 없는 검토 대기면 입력창 위 후보 칸까지 펼치고 첫 체크상자로 초점을 주고, 기준 제안이 막고 있으면 목표 탭을 연다. 그 밖에는 상세만 연다.
   */
  const openFollowupPicker = (target: Objective) => {
    const n = target.done ? 0 : openFollowups(target).length;
    setSelected(target.id);
    if (n > 0 && isFollowupSelectable(target)) {
      // 후보 칸은 그 목표의 구성원 채팅 입력창 위에 선다 — 가운데 칸이 다른 대화면 그 지휘관 대화부터 연다. 초점은 칸이 서며 스스로 잡는다.
      requestFollowupFocus(target.id);
      setFollowupOpen(target.id, true);
      if (listedOperationSummaries().some((summary) => summary.id === target.id)) focusOperation(target.id);
    } else if (n > 0 && followupGate(target) === "criteria") {
      // 후보 목록은 탭에 두지 않는다 — 기준 제안이 고르기를 막고 있으면 그 제안이 선 목표 탭을 연다.
      patchObjectiveView(theaterId, () => ({ detailTab: "goal" }));
    }
    // 스티어링이 먼저이거나 아직 고를 때가 아니면(openTip) 할 일은 구성원 채팅 입력창 위 제안 줄에 선다 — 다른 번들의 DOM 이라 초점을 옮기지 않는다.
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
  // 검토 대기 글리프는 후속 선택으로 바로 들어간다.
  useEffect(() => {
    if (!reveal) return;
    const objective = state.objectives.find((candidate) => candidate.id === reveal.objectiveId);
    if (!objective) return;
    takeReveal();
    pickObjective(objective.id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightMission(reveal.missionId ?? null);
    if (reveal.missionId) highlightTimer.current = setTimeout(() => { setHighlightMission(null); highlightTimer.current = null; }, 2400);
    if (reveal.followups) openFollowupPicker(objective);
  }, [reveal, state.objectives]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!theaterId) return <div className="objectives-container"><div className="objectives-root"><div className="objectives-pick-pane"><div className="objectives-pick"><p>{t("objectives.objectives.emptyTheater")}</p></div></div></div></div>;

  // 사이드바가 보이면 트리는 거기 있다. 접혀 있거나 사이드바가 없는 자리(모바일)에서만 ⌄ 가 선다.
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
      onPick={pickObjective}
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      onNewOperation={openNewOperation}
    />
  );
  const noObjectives = state.loaded && !state.objectives.some((objective) => !objective.removed);

  let body: ReactNode;
  if (!current && noObjectives) {
    // 고를 목표가 없다 — 「고르세요」도 「목록 열기」도 틀린다. 목표가 어디서 시작하는지 말하고 그 입구를 둔다.
    body = (
      <div className="objectives-pick-pane">
        <div className="objectives-pick-head">
          <span className="objectives-pick-label">{t("objectives.pick.label")}</span>
          {switcher}
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
  } else if (!current || current.removed) {
    body = (
      <div className="objectives-pick-pane">
        <div className="objectives-pick-head">
          <span className="objectives-pick-label">{t("objectives.pick.label")}</span>
          {switcher}
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
  } else {
    body = (
      <ObjectiveDetail
        key={current.id}
        objective={current}
        t={t}
        language={language}
        call={call}
        toast={toast}
        modeLabel={modeLabel}
        stateLabel={stateLabel}
        operationTitle={operationTitle}
        operationState={operationState}
        operationOwnState={operationOwnState}
        busy={isBusy(current)}
        request={request}
        tab={detailTabOf(view.detailTab)}
        onTab={(next) => patchObjectiveView(theaterId, () => ({ detailTab: next }))}
        sectionOpen={(key) => isOpen(key, false)}
        onToggleSection={(key) => toggleSection(key, false)}
        groupOpen={(key) => isOpen(key, false)}
        onToggleGroup={(key) => toggleSection(key, false)}
        onOpenGroup={(key) => patchObjectiveView(theaterId, (view) => ({ collapsed: { ...view.collapsed, [key]: false } }))}
        highlightMission={highlightMission}
        detailRef={detailRef}
        onToggleEdge={(from, to, linked) => toggleEdge(current, from, to, linked)}
        onOpenObjective={openObjectiveDetail}
      />
    );
  }
  return (
    // 온보딩 경계(SDK 계약) — 투어 카드가 패널을 가리지 않고 패널 옆, 짚는 구획 높이에 선다(레일이든 넓은 화면이든
    // 자리가 없으면 앵커 기준 배치로 돌아간다).
    <ObjectiveLinkOpenProvider value={ctx.openLink ?? null}>
    <div className="objectives-container" {...onboardingBoundary("anchor")} onPointerDownCapture={(event) => {
      if (highlightMission && !(event.target as Element).closest(`[data-mission-id="${CSS.escape(highlightMission)}"]`)) {
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = null;
        setHighlightMission(null);
      }
    }}><div className="objectives-root">
      {body}
    </div></div>
    </ObjectiveLinkOpenProvider>
  );
}

/** 라우팅이 꺼졌거나 후보가 없는 것은 실패가 아니라 설정 상태다 — 폴백 줄도 시트처럼 중립으로 말한다. */

/** 구성원 표식 — 그 구성원 Operation 의 몽글 아바타(사이드바와 같은 모습). 세션이 아직 없으면 시작 전 얼굴이다. 이름은 곁의 글자가 말한다. */
function MemberMark({ objective, member, operationState, still, size }: { objective: Objective; member: ObjectiveMember; operationState: (operationId: string) => string; still?: boolean; size?: number }) {
  return <ObjectiveAvatar operationId={member.id} role="member" state={memberMongleState(objective, member.id, member.sessionName !== null ? operationState(member.id) : "closed")} still={still} {...(size ? { size } : {})} />;
}

/**
 * 지휘관 표식 — 목표 Operation 의 몽글 아바타. 구성원과는 머리 위 안테나(역할 특징)로 갈린다. 상태는 사이드바·레일과 같은
 * 기준이라 구성원 활동을 끌어올린 값(`operationState`)을 읽는다 — 자기 활동(ownActivity)은 결정 대기 같은 글자에만 쓴다.
 */
function CommanderMark({ objective, operationState, size }: { objective: Objective; operationState: (operationId: string) => string; size?: number }) {
  return <ObjectiveAvatar operationId={objective.id} role="commander" state={commanderMongleState(objective, operationState(objective.id))} {...(size ? { size } : {})} />;
}

/**
 * 원장 단추 — 표식을 누르면 그 참여자의 원장(가운데 칸의 읽기 전용 기록)이 열리고, 연 참여자를 다시 누르면 대화로 돌아간다. 호스트 「구성원」
 * 탭의 줄 누름과 같다. 아직 띄운 적 없는 참여자나 원장을 열 수 없는 호스트에서는 표식만 선다.
 */
function LedgerMark({ rootId, operationId, name, open, available, t, children }: { rootId: string; operationId: string; name: string; open: boolean; available: boolean; t: T; children: ReactNode }) {
  if (!available) return <>{children}</>;
  const label = open ? t("objectives.members.closeLedger") : t("objectives.members.openLedger", { name });
  return <button type="button" className="objectives-member-ledger" aria-pressed={open} aria-label={label} title={label} onClick={() => toggleLedger(rootId, operationId)}>{children}</button>;
}

/** 구성원 탭의 명단 — 머리(셈·일괄 설정) 아래 첫 줄에 지휘관 실행 설정(lead)이 같은 줄 문법으로 서고, 이어서 구성원 줄이다. 탭이 접힘을 대신하므로 머리는 접지 않는다. */
function MemberRoster({ objective, t, call, request, operationState, rows, touchable, lead }: { objective: Objective; t: T; call: DetailProps["call"]; request: DetailProps["request"]; operationState: DetailProps["operationState"]; rows: ReturnType<typeof useLaunchRows>; touchable: boolean; lead: ReactNode }) {
  const ledger = useLedgerOperation(objective.id);
  const ledgerReady = canOpenLedger();
  // 빼면 맡던 임무는 지휘관 직접으로 돌아간다 — 달성 기준처럼 되돌리기 없이 바로.
  const remove = (member: ObjectiveMember) => void call("/member/remove", { objectiveId: objective.id, memberId: member.id });
  const saving = useRef(new Set<string>());
  // picked 는 모델 선택이 거절된 경우 — 그 실패는 칩의 말풍선으로 서고, 나머지는 행 아래 안내로 선다.
  const [fault, setFault] = useState<{ id: string; code: string; picked?: { readonly model?: string; readonly effort?: string } } | null>(null);
  const [notes, setNotes] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [balloon, setBalloon] = useState<{ kind: "done"; changed: number; preserved: number; mode: "same" | "route" } | { kind: "failed" } | null>(null);
  const batchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const batchMenuRef = useRef<HTMLDivElement | null>(null);
  const balloonTimer = useRef<number | null>(null);
  const cancelNext = (member: ObjectiveMember) => void call("/member/next-cancel", { objectiveId: objective.id, memberId: member.id });
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

  // 바뀐 순간의 확인 — 곧바로 적용된 응답이나 이번 턴 뒤 예약의 정산을 보면 그 칩에 잠깐 「바꿨습니다」 말풍선을 세운다. 서버에 남기지 않는 화면의 일시 상태다.
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
  const pendingSeen = useRef(new Map<string, { readonly model: string; readonly effort?: string }>());
  useEffect(() => {
    const seen = new Map<string, { readonly model: string; readonly effort?: string }>();
    for (const member of objective.members) {
      const before = pendingSeen.current.get(member.id);
      if (before && !member.next && member.model === before.model && (member.effort ?? "") === (before.effort ?? "")) flashApplied(member.id, before);
      if (member.next && !member.next.failed) seen.set(member.id, { model: member.next.model, ...(member.next.effort ? { effort: member.next.effort } : {}) });
    }
    pendingSeen.current = seen;
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

  // 띄운 구성원의 모델 — 휴면·유휴면 곧바로, 일하는 중이면 이번 턴 뒤 바뀐다. 바꾸지 못하면(문맥이 새 모델의 창보다 큼 등) 그 칩에 사유가 선다.
  const pickLaunched = (member: ObjectiveMember, launch: MemberLaunchChoice) => {
    const picked = launch.mode === "same" ? { model: objective.commander.model, effort: objective.commander.effort } : { model: launch.model, effort: launch.effort };
    void request("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch } }).then(
      (payload) => {
        setFault((current) => current?.id === member.id ? null : current);
        // 곧바로 바뀌었다 — 예약 없이 실행값이 달라졌으면 그 순간이다.
        const echoed = (payload as { objective?: Objective } | null)?.objective?.members.find((entry) => entry.id === member.id);
        if (echoed && !echoed.next && (echoed.model !== member.model || (echoed.effort ?? "") !== (member.effort ?? ""))) flashApplied(member.id, { ...(echoed.model ? { model: echoed.model } : {}), ...(echoed.effort ? { effort: echoed.effort } : {}) });
      },
      (error: unknown) => setFault({ id: member.id, code: error instanceof Error ? error.message : "unknown", picked }));
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
    {/* 탭이 이름을 말하므로 머리는 결과물 탭과 같은 메타 한 줄 — 왼쪽은 수, 오른쪽은 일괄 설정. */}
    <div className="objectives-row is-static objectives-tab-meta"><span className="objectives-tab-count">{t("objectives.members.title")} {objective.members.length}</span>{actions ? <span className="objectives-row-tools">{actions}</span> : null}</div>
    <div id="objectives-sec-members">
    {lead}
    {objective.members.length === 0 ? <p className="objectives-members-empty">{t("objectives.members.empty")}</p> : null}
    {objective.members.map((member, index) => {
      const state = member.sessionName !== null ? operationState(member.id) : "closed";
      const launched = memberLaunched(member, operationState);
      const routedTag = memberRoutedTag(member, launched, t);
      const diagnostics = memberNotes(member, launched, t);
      const noteOf = (kind: (typeof diagnostics)[number]["kind"]) => diagnostics.find((note) => note.kind === kind);
      const next = launched ? member.next : null;
      const reserved = next && !next.failed ? next : null;
      const appliedTo = launched ? applied.get(member.id) ?? null : null;
      // 바꾸지 못한 변경 — 방금 고른 값을 호스트가 거절했거나(닫으면 표시만 지운다), 이번 턴 뒤 예약이 적용되지 못했다(닫으면 예약 전 선택으로 돌아간다).
      const picked = launched && fault?.id === member.id ? fault.picked ?? null : null;
      const failure = picked && fault ? { model: picked.model, effort: picked.effort, code: fault.code, dismiss: () => setFault(null) }
        : next?.failed ? { model: next.model, effort: next.effort, code: next.failed, cause: next.cause?.message, dismiss: () => cancelNext(member) } : null;
      const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
      const { text: status, failed } = memberStatus(member, state, objective, t);
      const allowed = memberSubagents(member);
      return (
        <div key={member.id} className="objectives-member-slot">
        <div className={`objectives-member${ledger === member.id ? " is-ledger" : ""}`}>
          <LedgerMark rootId={objective.id} operationId={member.id} name={member.role} open={ledger === member.id} available={ledgerReady && state !== "closed"} t={t}>
            <MemberMark objective={objective} member={member} operationState={operationState} still={false} size={28} />
          </LedgerMark>
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
            {routedTag ? <span className={`objectives-member-via is-${routedTag.via}`} title={routedTag.title}>{routedTag.label}</span> : null}
            <MemberLaunchControl key={member.id} t={t} objective={objective} member={member} state={state} rows={rows} touchable={touchable}
              onPickLaunched={(launch) => pickLaunched(member, launch)}
              onPatchLaunch={(launch) => void call("/member/patch", { objectiveId: objective.id, memberId: member.id, patch: { launch } })}
              onToggleSubagents={() => toggleSubagents(member, MEMBER_LIVE.has(state))} />
            <span className={`objectives-member-status is-${state}${failed ? " is-failed" : ""}`} title={state === "ended" ? t("objectives.members.dormantHint") : undefined}>{status}{allowed ? <span className="objectives-member-subagents">{t("objectives.members.subagentsMark")}</span> : null}</span>
          </div>
          {/* 모델 변경의 경과는 칩 아래(설명 줄의 오른쪽 칸)에 서서 칩을 가리키는 한 줄 말풍선이다 — 행의 칸이라 다른 행이나 조작을 덮지
              않고 레일 밖으로 넘치지 않는다. 실패의 사유는 길어서 말풍선의 title(과 읽기 도구용 문장)로 싣고, 다른 모델은 칩에서 고른다. */}
          {reserved ? ((words) => (
            <span className="objectives-member-bubble" role="status" title={`${t("objectives.members.next.whenTurn")} → ${words.title}`}>
              <span className="objectives-member-bubble-when">{t("objectives.members.next.whenTurn")}</span>
              <span className="objectives-member-bubble-arrow" aria-hidden="true">→</span>
              <span className="objectives-member-bubble-to">{words.words.model}<span className="objectives-member-bubble-effort"> · {words.words.effort}</span></span>
              {touchable ? <button type="button" className="objectives-glyph objectives-member-bubble-x" aria-label={t("objectives.members.next.cancel", { role: member.role })} title={t("objectives.members.next.cancel", { role: member.role })} onClick={() => cancelNext(member)}><CloseGlyph /></button> : null}
            </span>
          ))(launchedWords(rows, reserved.model, reserved.effort, labels)) : failure ? ((sentence) => (
            <span className="objectives-member-bubble is-failed" role="alert" title={sentence}>
              <span className="objectives-member-bubble-when">{t("objectives.members.next.failed")}</span>
              <span className="objectives-sr">{sentence}</span>
              {touchable ? <button type="button" className="objectives-glyph objectives-member-bubble-x" aria-label={t("objectives.members.next.dismiss")} title={t("objectives.members.next.dismiss")} onClick={failure.dismiss}><CloseGlyph /></button> : null}
            </span>
          // 자식이 던진 원문이 있으면 사유 문장 뒤에 그대로 붙인다 — 같은 코드 뒤의 서로 다른 원인을 사람이 읽는 자리다.
          ))(`${t("objectives.members.next.failedBody", { model: launchedWords(rows, failure.model, failure.effort, labels).title, reason: routingReason(t, failure.code) })}${"cause" in failure && failure.cause ? `\n${failure.cause}` : ""}`) : appliedTo ? (
            <span className="objectives-member-bubble is-applied" role="status"><span className="objectives-member-bubble-when">{t("objectives.members.next.applied")}</span></span>
          ) : null}
          {touchable ? <button type="button" className="objectives-glyph objectives-member-remove" title={t("objectives.members.remove")} aria-label={t("objectives.members.removeAria", { role: member.role })} onClick={() => remove(member)}><TrashGlyph /></button> : null}
        </div>
        {member.failure ? <details className="objectives-member-note is-error objectives-member-failure">
          <summary>{noteOf("failure")?.text}</summary>
          <p>{t("objectives.members.failureData")}</p>
          <pre>{[member.failure.error, member.failure.error_details, member.failure.last_assistant_message].filter((value) => value !== undefined).join("\n")}</pre>
        </details> : null}
        {/* 바뀌지 않은 모델 전환의 사유 — 세션이 거절하며 남긴 원문을 자르지 않고 펼쳐 보인다(말풍선 title 만으로는 마우스를 올려야 읽힌다). */}
        {launched && member.next?.failed && member.next.cause ? <details className="objectives-member-note is-error objectives-member-failure">
          <summary>{noteOf("switch")?.text}</summary>
          <pre>{member.next.cause.message}</pre>
          {member.next.cause.errorClass || member.next.cause.code || member.next.cause.exitCode !== undefined || member.next.cause.signal
            ? <p>{[member.next.cause.errorClass, member.next.cause.code, member.next.cause.exitCode !== undefined ? `exit ${member.next.cause.exitCode}` : undefined, member.next.cause.signal].filter((value) => value !== undefined && value !== "").join(" · ")}</p> : null}
        </details> : null}
        {member.noReportTool ? <p className="objectives-member-note is-warn" role="status">{noteOf("noReportTool")?.text}</p> : null}
        {/* 실패 없이 닫힌 턴이 아무 보고도 남기지 못했다 — 사유 칸은 판정한 출처가 있을 때만 붙는다. 마지막 응답은 원문 그대로다. */}
        {member.unreported ? <details className="objectives-member-note is-warn objectives-member-failure">
          <summary>{noteOf("unreported")?.text}</summary>
          {member.unreported.reason?.detail !== undefined ? <pre>{member.unreported.reason.detail}</pre> : null}
          {member.unreported.lastMessage !== undefined ? <><p>{t("objectives.members.unreportedData")}</p><pre>{member.unreported.lastMessage}</pre></> : <p>{t("objectives.members.unreportedEmpty")}</p>}
        </details> : null}
        {((fallback) => fallback ? <p className="objectives-member-reason" title={fallback.title}>{fallback.text}</p> : null)(noteOf("fallback"))}
        {notes.has(member.id) ? <p className="objectives-member-note" aria-hidden="true">{t("objectives.members.subagentsLive")}</p> : null}
        {fault?.id === member.id && !picked ? <p className="objectives-member-note is-error" role="alert">{hasRoutingReason(fault.code) ? routingReason(t, fault.code) : t("objectives.toast.failed", { code: fault.code })}</p> : null}
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

/** 그래프 팝업의 「새 구성원」 — 역할 이름을 적으면 구성원을 만들어 이 임무를 맡긴다(임무 목록 담당 메뉴의 같은 줄을 옮겼다). */
function NewMemberAssign({ t, onCreate }: { t: T; onCreate: (role: string) => Promise<boolean> }) {
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState("");
  const creatingRef = useRef(false);
  if (!creating) return <button type="button" className="objectives-popup-text-button objectives-assign-create" onClick={() => setCreating(true)}>{t("objectives.members.new")}</button>;
  return <div className="objectives-assign-new"><input autoFocus maxLength={40} aria-label={t("objectives.members.new")} placeholder={t("objectives.members.rolePlaceholder")} value={role} onChange={(event) => setRole(event.target.value)} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); setCreating(false); setRole(""); return; }
    if (submitKey(event) && role.trim() && !creatingRef.current) { creatingRef.current = true; void onCreate(role.trim()).then((created) => { if (created) { setCreating(false); setRole(""); } }).finally(() => { creatingRef.current = false; }); }
  }} /><span>{t("objectives.members.newHint")}</span></div>;
}

type DetailSection = "detail:decisions" | "detail:retro" | "detail:followupResults" | "detail:extensions";

interface DetailProps {
  readonly objective: Objective;
  readonly t: T;
  readonly language: "en" | "ko";
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
  /** 고른 탭 — Theater별 메모리 보기 상태에 하나로 남는다. */
  readonly tab: DetailTab;
  readonly onTab: (tab: DetailTab) => void;
  /** 결과물 탭 아래 묶음 접힘 — Theater별 메모리 보기 상태에 보존하며 기본은 접힘. */
  readonly sectionOpen: (key: DetailSection) => boolean;
  readonly onToggleSection: (key: DetailSection) => void;
  /** 결과물 묶음은 목표·임무 키별로 기억하며 기본은 접힘. 구획 접힘과는 독립이다. */
  readonly groupOpen: (key: string) => boolean;
  readonly onToggleGroup: (key: string) => void;
  readonly onOpenGroup: (key: string) => void;
  readonly highlightMission: string | null;
  readonly detailRef: RefObject<HTMLElement | null>;
  readonly onToggleEdge: (from: string, to: string, linked?: boolean) => Promise<void>;
  /** 배치 결과·출처에서 목표 상세를 연다 — 목록에 있는 항목만 연다. */
  readonly onOpenObjective: (operationId: string) => void;
}

/**
 * 세부 — 입력 폼이 아니라 행의 목록이다. 머리 줄(오늘·기한 글리프 | 탭) 아래 고른 탭 하나가 선다. 보드 동작은 구성원 채팅 입력창(board-actions)이 받는다.
 * 테두리 친 입력은 없다 — 제목·임무·메모 모두 글 위에 바로 쓴다.
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

/**
 * 달성 기준 머리줄의 제안 셈은 제자리에서 두 줄까지만 감긴다 — 세 줄째부터는 머리줄이 한 줄 높이를 넘으니 is-stacked 로 아랫줄에 내린다.
 * 폭 경계가 아니라 실제 감김으로 가른다: 셈 문구의 폭은 언어와 건수마다 다르다. 재기는 표시를 걷은 제자리 배치에서 해
 * 이전 판정에 기대지 않는다(경계에서 왕복하지 않는다). 크기는 머리줄이 아니라 그것을 담은 스크롤 칸에서 지켜본다 — 표시가 바꾸는
 * 머리줄 높이가 감시를 다시 부르지 않으니 같은 프레임 안에서 판정을 마쳐 세 줄 모양이 한 프레임도 그려지지 않는다.
 * 칸의 내용 폭(content-box)을 지켜봐 스크롤바가 생기고 사라지며 바뀌는 폭도 잡는다.
 */
function useStackedProposalCount(headRef: RefObject<HTMLDivElement | null>, count: string | null, layoutKey: string) {
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const target = count === null ? null : head.querySelector(".objectives-criteria-count.is-pending");
    if (!target) { head.classList.remove("is-stacked"); return; }
    const fit = () => {
      head.classList.remove("is-stacked");
      const range = document.createRange();
      range.selectNodeContents(target);
      const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size;
      head.classList.toggle("is-stacked", lines > 2);
    };
    fit();
    let pane = head.parentElement;
    while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
    const observer = new ResizeObserver(fit);
    observer.observe(pane ?? head);
    let alive = true;
    void document.fonts.ready.then(() => { if (alive) fit(); });
    return () => { alive = false; observer.disconnect(); head.classList.remove("is-stacked"); };
  }, [headRef, count, layoutKey]);
}

const PROPOSAL_PLACEHOLDER: Readonly<Record<ObjectiveCriterionProposal["kind"], ObjectiveMessageKey>> = {
  add: "objectives.proposal.ph.add",
  revise: "objectives.proposal.ph.revise",
  retire: "objectives.proposal.ph.retire",
  recheck: "objectives.proposal.ph.recheck",
};

/**
 * 지휘관의 달성 기준 제안 한 줄 — 바뀔 기준 자리에 점선 테두리로 선다. 추가는 새 문구, 수정은 원문(취소선) 아래 새 문구,
 * 삭제는 원문 전체 취소선과 이유. 사람은 제안 문구를 고치지 않는다 — 승인·거절하거나 어노테이션을 달아 다시 구상하게 한다.
 * 어노테이션은 스티어링이 아니다: 저장만 하고, 다음 「다시 구상」 때 지휘관이 보드에서 읽는다.
 */
function ProposalRow({ proposal, target, n, extension, objectiveId, t, call, touchable, annotating, onAnnotate }: {
  readonly extension?: number | null;
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
  const label = proposal.kind === "add" ? t("objectives.proposal.add") : t(proposal.kind === "revise" ? "objectives.proposal.revise" : proposal.kind === "recheck" ? "objectives.proposal.recheck" : "objectives.proposal.retire", { n });
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
          <ExtensionChip n={extension ?? null} t={t} />
          {proposal.kind === "revise" && target ? <del className="objectives-proposal-text is-old"><LinkText text={target.text} /></del> : null}
          {proposal.kind === "retire"
            ? <>
              <del className="objectives-proposal-text"><LinkText text={target?.text ?? ""} /></del>
              {proposal.reason ? <span className="objectives-criterion-sub"><LinkText text={t("objectives.proposal.reason", { reason: proposal.reason })} /></span> : null}
            </>
            : proposal.kind === "recheck"
              ? <>
                <span className="objectives-proposal-text"><LinkText text={target?.text ?? ""} /></span>
                {proposal.reason ? <span className="objectives-criterion-sub"><LinkText text={t("objectives.proposal.reason", { reason: proposal.reason })} /></span> : null}
                <span className="objectives-criterion-sub">{t("objectives.proposal.recheckHint")}</span>
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
/** 브리핑 — 후속으로 태어난 목표면 원본 한 줄(origin)이 머리 바로 아래, 브리핑의 일부로 선다. */
function BriefSection({ objective, t, language, touchable, call, origin }: { objective: Objective; t: T; language: DetailProps["language"]; touchable: boolean; call: DetailProps["call"]; origin: ReactNode }) {
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
        {origin}
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
        <MergedTrail objective={objective} t={t} language={language} />
      </div>
  </>);
}

function quietMissionLabel(objective: Objective, mission: ObjectiveMission, ready: boolean, now: number, language: "en" | "ko"): string | null {
  if (mission.done) return null;
  const elapsed = quietElapsed({
    ready, assigned: mission.member !== null, assignmentTs: mission.assignmentTs ?? null,
    boardUpdatedAt: objective.boardUpdatedAt ?? null, decisionPending: objective.decisionRequest !== null, reviewPending: objective.awaitingReview,
    underway: objectiveUnderway(objective),
  }, now);
  if (elapsed == null || elapsed < DISPLAY_QUIET_MS) return null;
  return describeQuietMission(elapsed / 60_000, language);
}

function ObjectiveDetail({ objective, t, language, call, toast, modeLabel, stateLabel, operationTitle, operationState, operationOwnState, busy, request, tab, onTab, sectionOpen, onToggleSection, groupOpen, onToggleGroup, onOpenGroup, highlightMission, detailRef, onToggleEdge, onOpenObjective }: DetailProps) {
  const launchRows = useLaunchRows();
  const [quietNow, setQuietNow] = useState(() => Date.now());
  // 문장은 경과 분이다. 임계에 닿은 뒤에도 1분마다 다시 읽어, 뱃지가 처음 분수에 멈물지 않게 한다.
  useEffect(() => {
    if (!objectiveUnderway(objective) || objective.decisionRequest || objective.awaitingReview) return;
    let next: number | null = null;
    let showing = false;
    for (const mission of objective.missions) {
      if (mission.done || mission.member === null || mission.assignmentTs == null || !missionReady(objective.missions, mission)) continue;
      const due = quietSince(mission.assignmentTs, objective.boardUpdatedAt ?? mission.assignmentTs) + DISPLAY_QUIET_MS;
      if (due <= quietNow) { showing = true; continue; }
      if (next === null || due < next) next = due;
    }
    const untilShown = next === null ? null : Math.max(0, next - Date.now());
    const wait = untilShown === null ? (showing ? 60_000 : null) : showing ? Math.min(untilShown, 60_000) : untilShown;
    if (wait === null) return;
    const timer = setTimeout(() => setQuietNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [objective, quietNow]);
  const mode = commanderMode(objective.missions);
  const mergedFrom = criterionSources(objective);
  // 수동 재개로 초기화된 유휴 세션도 잠근다. 구성원의 활동이 아니라 지휘관 자신의 상태로 판단한다.
  const locked = objective.commander.started || ["idle", "running", "awaiting"].includes(operationOwnState(objective.id));
  const editable = !objective.done && !busy;
  // 지휘관이 일하는 동안에도 받는 편집 — 임무 추가, 끝나지 않은 임무의 문구·삭제·선행·담당, 메모. 구성원이 떠 있어도 임무는 끝나기 전까지 사람의 것이다. 서버가 같은 기준으로 가른다.
  const touchable = !objective.done;
  const notStarted = (mission: ObjectiveMission) => !mission.done;
  const canEditMission = (missionId: string) => { if (editable) return true; const target = objective.missions.find((candidate) => candidate.id === missionId); return touchable && !!target && notStarted(target); };
  const [zoomOpen, setZoomOpen] = useState(false);
  // 확대 카드 폭 — 확대 그래프가 스크롤 없이 들어가는 폭을 알려 준다.
  const [zoomWidth, setZoomWidth] = useState<number | null>(null);
  // 그래프 형상(가로 기본 · 세로) — 확대는 가로에만 있다. 다른 창에서 세로로 바뀌면 열린 확대를 닫고 초점을 스위치로 돌린다.
  const orientation = useGraphOrientation(), verticalGraph = orientation === "vertical";
  const orientationRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!verticalGraph || !zoomOpen) return;
    setZoomOpen(false); setZoomWidth(null);
    if (!document.activeElement || document.activeElement === document.body) orientationRef.current?.focus();
  }, [verticalGraph, zoomOpen]);
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
  // 그래프 팝업에서 편 기록 — 팝업이 다른 임무로 가거나 닫히면 이것만 접는다.
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
  const [resultReveal, setResultReveal] = useState<{ id: string; at: number } | null>(null);
  useEffect(() => { setResultReveal(null); setMissionReveal(null); }, [objective.id]);
  const numberOf = (missionId: string) => objective.missions.findIndex((mission) => mission.id === missionId) + 1;
  const zoomTriggerRef = useRef<HTMLButtonElement | null>(null);

  // 결정 — 질문·기록에 붙은 구성원 표식과, 그 세션으로 가는 길(세션이 떠 있을 때만). 임무 줄의 결정 표식이 가리킨 결정은 잠시 비춘다.
  const memberMarkOf = (memberId: string) => {
    const member = objective.members.find((candidate) => candidate.id === memberId);
    return member ? { mark: <MemberMark objective={objective} member={member} operationState={operationState} />, role: member.role, live: member.sessionName !== null && operationState(member.id) !== "closed" } : null;
  };
  const [decisionFlash, setDecisionFlash] = useState<string | null>(null);
  useEffect(() => { setDecisionFlash(null); }, [objective.id]);
  useEffect(() => {
    if (!decisionFlash) return;
    const frame = requestAnimationFrame(() => detailRef.current?.querySelector(`[data-decision-id="${CSS.escape(decisionFlash)}"]`)?.scrollIntoView({ block: "nearest" }));
    const timer = setTimeout(() => setDecisionFlash(null), 1600);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [decisionFlash, detailRef]);
  // 결정·임무·결과물로 가는 길 — 그 섹션이 사는 탭으로 바꾼다. 결정은 목표 탭 맨 아래의 접히는 섹션이라 함께 편다.
  const showDecision = (decisionId: string) => { onTab("goal"); onOpenGroup("detail:decisions"); setDecisionFlash(decisionId); };
  const showMission = (missionId: string) => {
    onTab("crew");
    setMissionReveal({ id: missionId, at: Date.now() });
  };
  const showResults = (missionId: string) => {
    setZoomOpen(false);
    setMissionReveal(null);
    onTab("results");
    onOpenGroup(resultGroupKey(objective.id, missionId));
    setResultReveal({ id: missionId, at: Date.now() });
  };

  // 달성 기준 제안 — 결정(승인·거절)과 어노테이션은 줄마다 한다. 열린 어노테이션 칸은 한 번에 하나다.
  const proposals = objective.criteriaProposals;
  const [annotating, setAnnotating] = useState<string | null>(null);
  useEffect(() => { setAnnotating(null); }, [objective.id]);
  const proposalProps = { objectiveId: objective.id, t, call, touchable, annotating, onAnnotate: setAnnotating } as const;

  // 달성 기준 셈 — 항목이 있을 때만 선다.
  const criteriaCollapsible = objective.criteria.length + proposals.length > 0;
  const criteriaHeadRef = useRef<HTMLDivElement>(null);
  const pendingCount = proposals.length > 0 ? t("objectives.criteria.pending", { count: proposals.length }) : null;
  const approveAll = proposals.length > 1 && touchable;
  useStackedProposalCount(criteriaHeadRef, pendingCount, `${approveAll}:${criteriaCollapsible}`);
  const resultsOpen = tab === "results";
  useEffect(() => {
    if (!resultReveal || !resultsOpen || zoomOpen) return;
    const frame = requestAnimationFrame(() => {
      const group = detailRef.current?.querySelector<HTMLElement>(`[data-result-mission="${CSS.escape(resultReveal.id)}"]`);
      group?.scrollIntoView({ block: "start" });
      group?.querySelector<HTMLButtonElement>(".objectives-result-group-head")?.focus({ preventScroll: true });
    });
    const timer = setTimeout(() => setResultReveal(null), 1600);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [resultReveal, resultsOpen, zoomOpen, detailRef]);
  // 「이 임무로」 — 구성원 탭(맨 아래 임무 그래프)으로 바꾸고 그래프가 그 노드를 드러낸다. onTab 은 렌더마다 새로 만들어지므로 ref 로 읽는다(의존성에 넣으면 무한 렌더).
  const onTabRef = useRef(onTab);
  onTabRef.current = onTab;
  useEffect(() => {
    if (!highlightMission) return;
    onTabRef.current("crew");
    setMissionReveal({ id: highlightMission, at: Date.now() });
  }, [highlightMission]);
  // 후속 후보 — 고르기·폐기는 하단 띠가 맡고, 상세에는 완료 뒤 결과만 결과물 탭의 접힌 묶음으로 선다.
  const followupOpenList = openFollowups(objective);
  const followupBatches = readBatches(objective);
  const followupHistory = readHistory(objective);
  const followupOrigin = readOrigin(objective);

  const doneMissions = objective.missions.filter((mission) => mission.done).length;
  const extension = objective.extensions.at(-1);
  const missionExtension = (id: string) => extensionOf(objective.extensions, id, "mission");
  const criterionExtension = (id: string) => extensionOf(objective.extensions, id, "criterion");

  // 확장 라운드 — 탭 바 바로 아래 한 줄, 모든 탭 공통.
  const sExtension = extension ? <div className="objectives-extension-current">
      <div><ExtensionChip n={extension.n} t={t} /><time dateTime={new Date(extension.at).toISOString()}>{t("objectives.extend.started", { date: recordTime(extension.at, language, "") })}</time></div>
      <p className="objectives-extension-request"><b>{t("objectives.extend.request")}</b><LinkText text={extension.context} /></p>
    </div> : null;
  // 지휘관·구성원의 상태 낱말 — 명단 줄과 「메시지」의 받는 이가 같은 말을 쓴다.
  const memberStateWord = (state: string, outcome?: string) => {
    const isWorkingOrAwaiting = state === "running" || state === "awaiting";
    if (outcome === "failed" && !isWorkingOrAwaiting) return t("objectives.members.failed");
    if (state === "ended") return t("objectives.members.dormant");
    if (state === "running") return t("objectives.members.working");
    if (state === "awaiting") return t("objectives.awaiting.word");
    return t("objectives.members.idle");
  };
  // 지휘관 실행 설정 — 구성원 탭 첫 줄, 구성원과 같은 줄 문법(몽글·이름·설명 | 모델·강도·상태). 보기는 채팅으로 고정이라 고르지 않는다.
  const commanderState = operationOwnState(objective.id);
  const ledger = useLedgerOperation(objective.id);
  const commanderRow = (
    <div className={`objectives-member is-commander${ledger === objective.id ? " is-ledger" : ""}`}>
      <LedgerMark rootId={objective.id} operationId={objective.id} name={t("objectives.commander.title")} open={ledger === objective.id} available={canOpenLedger() && commanderState !== "closed"} t={t}>
        <CommanderMark objective={objective} operationState={operationState} size={28} />
      </LedgerMark>
      <div className="objectives-member-body">
        <span className="objectives-member-name"><span className="objectives-member-role-fit">{t("objectives.commander.title")}</span></span>
        <span className="objectives-member-brief">{t("objectives.commander.brief")}</span>
      </div>
      <div className="objectives-member-meta">
        <LaunchControl t={t} model={objective.commander.model} effort={objective.commander.effort} locked={locked || !editable} onChange={(next) => void call("/objective/patch", { objectiveId: objective.id, patch: { launch: next } })} />
        {commanderState !== "closed" ? <span className={`objectives-member-status is-${commanderState}${objective.commander.outcome === "failed" && commanderState !== "running" && commanderState !== "awaiting" ? " is-failed" : ""}`}>{memberStateWord(commanderState, objective.commander.outcome)}</span> : null}
      </div>
    </div>
  );
  const sCrew = (
      <div className="objectives-group objectives-crew-group">
        <MemberRoster objective={objective} t={t} call={call} request={request} operationState={operationState} rows={launchRows} touchable={touchable} lead={commanderRow} />
      </div>
  );
  const sOrigin = (<>
      {/* 출처 — 후속으로 태어난 목표의 원본. 브리핑 머리 아래 한 줄(말줄임 제목 + ↗)로만 두고, 원본이 없으면 비활성 한 줄. */}
      {followupOrigin ? (
      <div className="objectives-origin">
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
  const sBrief = <BriefSection objective={objective} t={t} language={language} touchable={touchable} call={call} origin={sOrigin} />;
  const sCriteria = (<>
      {/* 달성 기준 — 사람이 쓰고, 사람이 구상을 청한 턴에 지휘관이 추가·수정·삭제를 제안한다. 제안은 바뀔 기준 바로 그 줄에 서고
          (추가는 끝에 새 줄) 사람이 줄마다 승인·거절하거나 어노테이션을 달아 다시 구상하게 한다. 제안이 남아 있으면 개시·스티어링은 잠긴다.
          마지막 임무 뒤 지휘관이 기준마다 스스로 다시 따져 근거와 함께 충족으로 표시한다. 새 작업이 생기면 충족 표시는 거둬져
          「미확인」으로 돌아간다. 모든 임무와 기준이 끝나면 저절로 검토 대기다. */}
      <div className="objectives-group objectives-criteria-group" data-objectives-tour="criteria">
        <div className="objectives-criteria-head" ref={criteriaHeadRef}>
          <SectionHead
            glyph={<CriteriaGlyph />}
            label={t("objectives.criteria.title")}
            tools={pendingCount !== null ? <span className="objectives-criteria-count is-pending">{pendingCount}</span>
              : criteriaCollapsible ? <span className="objectives-criteria-count">{t("objectives.criteria.count", { met: objective.criteria.filter((criterion) => !!criterion.met).length, total: objective.criteria.length })}</span> : null}
          />
          {approveAll ? <button type="button" className="objectives-btn is-small objectives-approve-all" onClick={() => void call("/criterion/approve-all", { objectiveId: objective.id })}>{t("objectives.criteria.approveAll")}</button> : null}
        </div>
        <div id="objectives-sec-criteria">
          {/* 사령관이 넘긴 기준 제안 — 승인·거절은 사람의 차례다. 넘긴 이유와 돌려주기를 제안 줄 위에 둔다. */}
          {proposals.length > 0 ? <PersonHoldNote objective={objective} target="criteria" t={t} /> : null}
          {objective.criteria.map((criterion, index) => {
            const proposal = proposals.find((candidate) => candidate.target === criterion.id);
            const round = criterionExtension(criterion.id);
            const divider = extension && (index === 0 || round !== criterionExtension(objective.criteria[index - 1]!.id)) ? <ExtensionDivider n={round} t={t} /> : null;
            if (proposal) return <Fragment key={criterion.id}>{divider}<ProposalRow proposal={proposal} target={criterion} n={index + 1} extension={round} {...proposalProps} /></Fragment>;
            const evidence = criterion.met;
            return (
              <Fragment key={criterion.id}>{divider}
              <div className={`objectives-criterion${evidence ? " is-met" : ""}`}>
                <span className="objectives-criterion-mark" aria-hidden="true" />
                <span className="objectives-criterion-number" aria-hidden="true">{index + 1}</span>
                <div className="objectives-criterion-body">
                  <WrapText key={criterion.text} className="objectives-criterion-text" label={t("objectives.criteria.itemAria", { n: index + 1 })} editLabel={t("objectives.link.edit")} value={criterion.text} readOnly={!touchable} maxLength={300}
                    onCommit={(value) => { if (!value) return false; if (value !== criterion.text) void call("/criterion/patch", { objectiveId: objective.id, criterionId: criterion.id, patch: { text: value } }); return true; }} />
                  <ExtensionChip n={round} t={t} />
                  {evidence ? <span className="objectives-criterion-sub is-evidence">{t("objectives.criteria.evidence", { evidence })}</span>
                    : criterion.by === "commander" ? <span className="objectives-criterion-sub">{((did) => (did ? t("objectives.criteria.proposedBy", { did }) : t("objectives.criteria.proposed")))(actorDid(t, criterionApproval(objective, criterion), "approved"))}</span>
                    : mergedFrom.get(criterion.id) ? <span className="objectives-criterion-sub">{t("objectives.merged.fromCriterion", { title: mergedFrom.get(criterion.id)! })}</span> : null}
                </div>
                <span className={`objectives-criterion-state${evidence ? " is-met" : ""}`}>{t(evidence ? "objectives.criteria.met" : "objectives.criteria.unchecked")}</span>
                {touchable ? <button type="button" className="objectives-glyph objectives-criterion-remove" title={t("objectives.criteria.remove")} aria-label={t("objectives.criteria.remove")} onClick={() => void call("/criterion/remove", { objectiveId: objective.id, criterionId: criterion.id })}><TrashGlyph /></button> : null}
              </div>
              </Fragment>
            );
          })}
          {proposals.filter((proposal) => proposal.kind === "add").map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} target={null} n={0} extension={extension?.n} {...proposalProps} />)}
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
      {/* 결과물 장부 — 임무 순서의 묶음과 마지막 기록 한 줄. 임무 밖 연결은 끝에 남기고, 그래프 팝업과 묶음 머리가 왕복한다.
          사람은 읽기만 한다. PR 관측은 SSE로 갱신하고 Artifact는 외부 링크만 연다. 결과물 0개도 유효하다. */}
      <div className="objectives-group objectives-results-group">
        <div className="objectives-row is-static objectives-tab-meta"><span className="objectives-tab-count">{t("objectives.results.title")} {objective.results.length > 0 ? objective.results.length : t("objectives.results.none")}</span></div>
        {objective.results.length > 0 ? <div id="objectives-sec-results"><ObjectiveResults objective={objective} t={t} language={language} onShowMission={showMission} highlightMission={resultReveal?.id ?? null} groupOpen={groupOpen} onToggleGroup={onToggleGroup} /></div> : null}
      </div>
  </>);
  const renderMissionDetail = (mission: ObjectiveMission, { close, select, state }: MissionDetailActions) => {
    const index = numberOf(mission.id), member = objective.members.find(m => m.id === mission.member);
    const allowed = canEditMission(mission.id), recordsOpen = mission.id in openRecords, unseen = unseenRecords(mission);
    const quiet = quietMissionLabel(objective, mission, missionReady(objective.missions, mission), quietNow, language);
    const children = objective.missions.filter(m => m.prerequisites.includes(mission.id));
    const patch = (value: Record<string, unknown>) => void call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: value });
    const edgeRow = (other: ObjectiveMission, from: string, to: string) => <div className="objectives-popup-edge-row" key={other.id}>
      <span className="objectives-popup-edge-icon"><MissionNodeIcon state={missionStates.get(other.id)!} number={numberOf(other.id)} /></span><button type="button" aria-label={`${t("objectives.graph.detail", { n: numberOf(other.id) })}. ${other.text}. ${t(`objectives.graph.state.${missionStates.get(other.id)!}`)}`} onClick={() => select(other.id)}>{other.text}</button>
      <button type="button" className="objectives-popup-cut" disabled={!canEditMission(to)} aria-label={t("objectives.graph.edgeAria", { from: numberOf(from), to: numberOf(to) })} title={canEditMission(to) ? t("objectives.graph.cut") : t("objectives.graph.locked")} onClick={() => void onToggleEdge(from, to, false)}>×</button>
      {mission.why[other.id] && mission.why[other.id] !== "human" ? <small>{mission.why[other.id]}</small> : null}
    </div>;
    return <>
      <div className="objectives-popup-head"><span>{t("objectives.graph.detail", { n: index })}</span><ExtensionChip n={missionExtension(mission.id)} t={t} /><span className={`objectives-popup-state is-${state}`}><i />{t(`objectives.graph.state.${state}`)}</span><button type="button" className="objectives-glyph" aria-label={t("objectives.detail.close")} onClick={close}><CloseGlyph /></button></div>
      <WrapText key={`${mission.id}:${mission.text}`} className="objectives-popup-title" label={t("objectives.graph.titleInput", { n: index })} editLabel={t("objectives.link.edit")} value={mission.text} readOnly={!allowed} maxLength={200} onEscape={close} onCommit={value => { if (!value) return false; if (value !== mission.text) patch({ text: value }); return true; }} />
      {!allowed ? <p className="objectives-popup-hint">{t("objectives.graph.locked")}</p> : null}
      {!mission.done && state === "blocked" ? <p className="objectives-popup-hint">{t("objectives.missions.prerequisites", { missions: mission.prerequisites.filter(id => !objective.missions.find(m => m.id === id)?.done).map(numberOf).join("·") })}</p> : null}
      <div className="objectives-popup-group"><div className="objectives-popup-group-head">{t("objectives.graph.owner")}<span title={mission.operationId ? operationTitle(mission.operationId) : undefined}>{member?.role ?? t("objectives.graph.commander")} · {stateLabel(operationOwnState(member?.id ?? objective.id))}</span></div>
        <div className="objectives-popup-members" role="radiogroup" aria-label={t("objectives.missions.setMember")} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], at = options.indexOf(document.activeElement as HTMLButtonElement);
          if (!options.length) return;
          event.preventDefault(); const next = options[(at + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + options.length) % options.length]!; next.focus(); next.click();
        }}>
          {[...objective.members, null].map(option => <button key={option?.id ?? "commander"} type="button" role="radio" aria-checked={mission.member === (option?.id ?? null)} tabIndex={mission.member === (option?.id ?? null) ? 0 : -1} disabled={!allowed} onClick={() => patch({ member: option?.id ?? null })}>{option ? <MemberMark objective={objective} member={option} operationState={operationState} /> : <CommanderMark objective={objective} operationState={operationState} />}{option?.role ?? t("objectives.graph.commander")}</button>)}
        </div>
        {/* 임무 목록이 하던 담당 쪽 일 — 새 구성원을 만들어 맡기기, 조용한 임무, 발주·수신 흔적(본문은 보드에 없다). */}
        {allowed && !mission.done ? <NewMemberAssign key={mission.id} t={t} onCreate={async (role) => { const result = await call<{ objective: Objective }>("/member/add", { objectiveId: objective.id, member: { role } }); const created = result?.objective.members.at(-1); return created ? !!(await call("/mission/patch", { objectiveId: objective.id, missionId: mission.id, patch: { member: created.id } })) : false; }} /> : null}
        {quiet ? <p className="objectives-popup-hint">{quiet}</p> : null}
        {!mission.done && mission.dispatch ? <p className="objectives-popup-hint">{mission.dispatch.receivedAt !== null
          ? t("objectives.missions.dispatchReceived", { sent: recordTime(mission.dispatch.at, language, ""), received: recordTime(mission.dispatch.receivedAt, language, "") })
          : t("objectives.missions.dispatchSent", { sent: recordTime(mission.dispatch.at, language, "") })}</p> : null}
      </div>
      <div className="objectives-popup-group"><div className="objectives-popup-group-head">{t("objectives.graph.parents")} {mission.prerequisites.length}</div>{mission.prerequisites.map(id => { const parent = objective.missions.find(m => m.id === id); return parent ? edgeRow(parent, parent.id, mission.id) : null; })}{mission.unplaced ? <p className="objectives-popup-hint">{t("objectives.graph.unplacedHint")}</p> : null}</div>
      {children.length ? <div className="objectives-popup-group"><div className="objectives-popup-group-head">{t("objectives.graph.children")} {children.length}</div>{children.map(child => edgeRow(child, mission.id, child.id))}</div> : null}
      {mission.records.length ? <div className="objectives-popup-group"><button type="button" className="objectives-popup-text-button" aria-expanded={recordsOpen} onClick={() => togglePopupRecords(mission)}>{t("objectives.records.count", { index, count: mission.records.length })}{unseen ? ` · ${t("objectives.records.unseen", { count: unseen })}` : ""} {recordsOpen ? "−" : "+"}</button>{recordsOpen ? <MissionRecords id={`graph-records-${mission.id}`} records={mission.records} seenAtOpen={openRecords[mission.id] ?? EMPTY_IDS} open t={t} language={language} /> : <p className="objectives-popup-hint">{mission.records.at(-1)?.lines[0] ? <LinkText text={mission.records.at(-1)!.lines[0]!} /> : null}</p>}</div> : null}
      {((count) => count > 0 ? <div className="objectives-popup-group"><button type="button" className="objectives-popup-text-button objectives-popup-results-link" onClick={() => { close(); showResults(mission.id); }}><ResultsGlyph />{t("objectives.graph.results", { count })}<span aria-hidden="true">↗</span></button></div> : null)(objective.results.filter((result) => result.sourceMissionId === mission.id).length)}
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
    return <div key={mission.id} className="objectives-graph-attention" role="status">{owner ? <MemberMark objective={objective} member={owner} operationState={operationState} /> : <CommanderMark objective={objective} operationState={operationState} />}<span className="objectives-graph-attention-owner">{t("objectives.graph.ownerAwaiting", { owner: ownerName })}</span><button type="button" onClick={() => showMission(mission.id)}>{t("objectives.graph.detail", { n: numberOf(mission.id) })}</button><button type="button" className="objectives-graph-attention-session" onClick={() => focusOperation(owner?.id ?? objective.id)}>{t("objectives.graph.openSession")}</button></div>;
  });
  const ownerMark = (memberId: string | null) => {
    if (!memberId) return <CommanderMark objective={objective} operationState={operationState} />;
    const member = objective.members.find((candidate) => candidate.id === memberId);
    return member ? <MemberMark objective={objective} member={member} operationState={operationState} /> : null;
  };
  const graphProps = { objective, t, states: missionStates, ownerMark, canEdit: canEditMission, renderDetail: renderMissionDetail, onShowing: closePopupRecords, onEdge: (from: string, to: string, linked: boolean) => void onToggleEdge(from, to, linked), reveal: missionReveal, orientation };
  const missionAdd = touchable ? <div className="objectives-row objectives-mission-add"><span className="objectives-row-ic objectives-plus" aria-hidden="true">+</span><input maxLength={200} aria-label={t("objectives.missions.add")} placeholder={t("objectives.missions.add")} onKeyDown={event => {
    if (submitKey(event) && event.currentTarget.value.trim()) { const target = event.currentTarget, value = target.value; void call("/mission/add", { objectiveId: objective.id, mission: { text: value.trim() } }).then(result => { if (result && target.value === value) target.value = ""; }); }
  }} /></div> : null;
  // 형상 스위치(켜면 세로) 옆의 크게 보기는 가로에서만 선다 — 세로는 높이가 자라 상세가 스크롤하므로 확대할 것이 없다.
  const graphTools = <>
    <button ref={orientationRef} type="button" role="switch" aria-checked={verticalGraph} className="objectives-graph-orient" aria-label={t("objectives.graph.verticalAria")} title={t("objectives.graph.verticalAria")} onClick={() => setGraphOrientation(verticalGraph ? "horizontal" : "vertical")}><span className="objectives-graph-orient-track" aria-hidden="true" /><span className="objectives-graph-orient-label" aria-hidden="true">{t("objectives.graph.vertical")}</span></button>
    {verticalGraph ? null : <button ref={zoomTriggerRef} type="button" className="objectives-glyph" aria-haspopup="dialog" aria-expanded={zoomOpen} aria-label={t("objectives.graph.zoom")} title={t("objectives.graph.zoom")} onClick={() => setZoomOpen(true)}><ZoomGlyph /></button>}
  </>;
  // 임무 섹션 — 구성원 탭 맨 아래. 섹션 머리(글리프 · 「임무」 · 안 읽은 점 · 상태 셈 | 형상 스위치 · 크게 보기), 허용 대기 줄, 그래프,
  // 그 아래 「+ 임무 추가」. 임무 목록은 없다 — 조작은 그래프 팝업이 맡으므로 머리는 접히지 않는다.
  const unseenAny = objective.missions.some((mission) => unseenRecords(mission) > 0);
  const sMissions = <div className="objectives-group objectives-missions-group" data-objectives-tour="missions">
    <SectionHead glyph={<GraphGlyph />} label={t("objectives.missions.title")} tools={<>{unseenAny ? <i className="objectives-sec-unseen" title={t("objectives.tabs.unseenDot")} /> : null}{renderCounts()}</>}
      {...(objective.missions.length ? { actions: graphTools } : {})} />
    {missionAttention}
    <div id="objectives-sec-missions">{objective.missions.length ? <CoordinationGraph {...graphProps} suspended={zoomOpen && !verticalGraph} /> : null}{missionAdd}</div>
    {zoomOpen && !verticalGraph && objective.missions.length > 0 ? createPortal(<LineupZoom t={t} title={objective.title} width={zoomWidth} onClose={() => { setZoomOpen(false); setZoomWidth(null); zoomTriggerRef.current?.focus(); }}><SectionHead glyph={<GraphGlyph />} label={t("objectives.missions.title")} tools={<><span className="objectives-criteria-count">{t("objectives.missions.count", { done: doneMissions, total: objective.missions.length })}</span>{renderCounts(true)}</>} />{missionAttention}<CoordinationGraph {...graphProps} zoom onFitWidth={setZoomWidth} />{missionAdd}</LineupZoom>, document.body) : null}
  </div>;
  // 결정 섹션 — 목표 탭 맨 아래, 결정 내역만. 지금 답할 결정 요청은 가운데 대화의 결정 카드가 받고, 목표 탭에는 점만 선다.
  // 답이 없으면 서지 않는다(목표 탭 맨 아래의 빈 문구는 소음이다).
  const sDecisions = objective.decisions.length > 0 ? (
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
  ) : null;
  // 결과물 탭 아래 접힌 묶음 — 회고 · 후속 목표 · 이전 회차. 있는 것만 선다.
  const showFollowupResults = followupBatches.length > 0 || !!followupHistory || (objective.done && followupOpenList.length > 0);
  const sResultFolds = objective.handoff || showFollowupResults || objective.extensions.length ? (
      <div className="objectives-group objectives-result-folds">
        {/* 회고 — 인계 기록이 있을 때만(검토 대기와 완료 뒤). 지휘관이 넘겼으면 두 표, 사람이 넘겼으면 회고 없음 한 줄. 읽기 전용. */}
        {objective.handoff ? <>
          <SectionHead glyph={<RetroGlyph />} label={t("objectives.retro.title")} controls="objectives-sec-retro" expanded={sectionOpen("detail:retro")} onToggle={() => onToggleSection("detail:retro")} />
          <div id="objectives-sec-retro" hidden={!sectionOpen("detail:retro")}>
            <Retrospective
              t={t}
              by={objective.handoff.by}
              good={objective.handoff.retrospective?.wentWell.map((pair) => ({ text: pair.point, aside: pair.because })) ?? []}
              regret={objective.handoff.retrospective?.fellShort.map((pair) => ({ text: pair.point, aside: pair.ifOnly })) ?? []}
            />
          </div>
        </> : null}
        {/* 후속 목표 — 완료 때 고른 후보의 배치 요약과 줄 상태, 남긴 후보. */}
        {showFollowupResults ? <>
          <SectionHead glyph={<FollowupForkGlyph />} label={t("objectives.followup.results")} controls="objectives-sec-followup-results" expanded={sectionOpen("detail:followupResults")} onToggle={() => onToggleSection("detail:followupResults")} />
          <div id="objectives-sec-followup-results" hidden={!sectionOpen("detail:followupResults")}>
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
        </> : null}
        {objective.extensions.length ? <>
          <SectionHead glyph={<RetroGlyph />} label={t("objectives.extend.previous")} tools={<span className="objectives-criteria-count">{objective.extensions.length}</span>} controls="objectives-sec-extensions" expanded={sectionOpen("detail:extensions")} onToggle={() => onToggleSection("detail:extensions")} />
          <div id="objectives-sec-extensions" hidden={!sectionOpen("detail:extensions")}>
            <ExtensionHistory objective={objective} t={t} language={language} />
          </div>
        </> : null}
      </div>
  ) : null;
  const bottom = (
      <div className="objectives-detail-bottom">
        {/* 완료 검토·후속 후보 고르기는 구성원 채팅 입력창에서 한다 — 사령관이 넘긴 것이면 그 이유와 돌려주기를 여기 둔다. */}
        <PersonHoldNote objective={objective} target="review" t={t} label={t("objectives.objectives.review")} />
        <PersonHoldNote objective={objective} target="followup" t={t} label={t("objectives.followup.title")} />
      </div>
  );
  // 상세 aside > 탭 바 · 탭 칸(스크롤) · 하단. 탭을 바꿔도 탭 바·하단 띠는 다시 마운트되지 않는다.
  // 탭 칸(.objectives-detail-scroll)이 상세의 스크롤 컨테이너다 — 그래프의 드래그 자동 스크롤·팝업 앵커가 이 칸을 기준으로 삼는다.
  const panel = tab === "goal" ? <>{sBrief}{sCriteria}{sDecisions}</>
    : tab === "crew" ? <>{sCrew}{sMissions}</>
    : <>{sResults}{sResultFolds}</>;
  return (
    <aside ref={detailRef} className={`objectives-detail${busy ? " is-busy" : ""}`} aria-label={objective.title}>
      <div className="objectives-detail-scroll">
        <div className={`objectives-tab-body is-${tab}`}>{sExtension}{panel}</div>
      </div>
      {bottom}
    </aside>
  );
}
