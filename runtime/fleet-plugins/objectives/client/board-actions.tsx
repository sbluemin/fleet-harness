import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import type { GroupBoardAction, GroupBoardActions, GroupBoardPanelContext, GroupBoardRunResult } from "@fleet-console/sdk/conversation";
import type { LocalizedText, Translate } from "@fleet-console/sdk/i18n";

import { MAX_CONTEXT, ROUTING_PREVIEW_TTL_MS, type Objective, type ObjectiveEditKind, type ObjectiveMember, type RoutingPreview } from "../server/types.js";
import { nonHumanEditors } from "./actors.js";
import { commodoreLanguage } from "./commodore-state.js";
import {
  clearSelection,
  discardedFollowups,
  isFollowupSelectable,
  newBatchId,
  openFollowups,
  pruneSelection,
  readSelectionRevs,
  setFollowupOpen,
  takeFollowupFocus,
  toggleFollowupSelection,
  useFollowupOpen,
  useFollowupSelection,
} from "./followups.js";
import { FollowupCandidateList, FollowupDiscardedTrace } from "./followups-view.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { LaunchControl, LaunchedText, launchedWords, localized, routingReason, useLaunchRows } from "./launch-control.js";
import { memberMongleState, ObjectiveAvatar } from "./objective-avatar.js";
import { findAnyObjective, listedOperationSummaries, objectivesApi, openObjectiveFromCluster, post, readTheater, revealObjective, subscribeObjective, subscribeObjectiveOrFinished } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 목표의 보드 동작 — 사람이 지금 할 일을 고르는 상태 사다리와, 그 결과를 구성원 채팅 입력창(`GroupConversationActions.board`)에
 * 건네는 일. 입력창 위 제안 줄의 칩·입력창 안 동작 칩·＋ 메뉴의 압축 행은 호스트가 그리고, 여기서는 무엇을 언제 어느 서버 경로로
 * 보내는지만 정한다. 라우팅 확인과 후속 후보 고르기는 입력창 바로 위 칸(`renderPanel`)에 이 플러그인이 그린다.
 *
 * 우선순위 — 사람이 지금 무엇을 해야 하나: 완료됨 > 지휘관 결정 대기 > 작업 중(구성원 실행 포함) > 구성원 결정 대기 >
 * 검토 대기 > 인계 대기 > 깨운 뒤 유휴 > 개시 전. 인계 대기에서 쉬는 지휘관 대신 사람이 「검토로 넘기기」를 쓸 수 있다 — 한 번 누름으로
 * 넘어가지 않게 두 번 눌러 보낸다. 지휘관이 마지막으로 읽은 뒤 사람이 보드를 고쳤으면 낱말은 상태와 상관없이 「스티어링」이고,
 * 서버 경로는 상태가 고른다(쉬는 구성원까지 깨워야 하는 유휴는 개시 경로, 작업 중·검토 대기·구상 중은 스티어링 경로).
 * 달성 기준 제안이 남아 있으면 개시·스티어링은 잠긴 한 줄로 서고(서버가 criteria_pending 으로 거부한다), 「다시 구상」만 열린다.
 * 중단은 입력창의 보내기↔정지 단추, 메시지는 입력창의 기본 동작이다 — 칩으로 세우지 않는다.
 */

type IntentKey = "plan" | "replan" | "start" | "resume" | "steer" | "steerIdle" | "complete" | "handOff" | "decide" | "decideMember" | "stop" | "message" | "extend";

interface MemberAwaiting {
  readonly operationId: string;
  readonly role: string;
  /** 그 구성원이 맡은 끝나지 않은 첫 임무의 번호(1부터). 없으면 null. */
  readonly mission: number | null;
}

const EDIT_KEYS: Readonly<Record<ObjectiveEditKind, ObjectiveMessageKey>> = {
  title: "objectives.edit.title",
  note: "objectives.edit.note",
  missions: "objectives.edit.missions",
  lineup: "objectives.edit.lineup",
  members: "objectives.edit.members",
  member: "objectives.edit.member",
  criteria: "objectives.edit.criteria",
};

const REASONS: Readonly<Record<string, ObjectiveMessageKey>> = {
  objective_busy: "objectives.band.reason.busy",
  slot_taken: "objectives.band.reason.taken",
  session_awaiting_input: "objectives.band.reason.awaiting",
  launch_failed: "objectives.band.reason.undelivered",
  claude_trust_required: "objectives.band.reason.trustRequired",
  launch_unavailable: "objectives.band.reason.unavailable",
  objective_done: "objectives.band.reason.done",
  criteria_pending: "objectives.band.reason.criteriaPending",
  criteria_not_planning: "objectives.band.reason.criteriaNotPlanning",
  followup_changed: "objectives.band.reason.followupChanged",
  followup_capacity: "objectives.band.reason.followupCapacity",
  too_many_followups: "objectives.band.reason.followupTooMany",
  followup_backlog: "objectives.band.reason.followupBacklog",
  steer_required: "objectives.band.reason.steerRequired",
  not_in_review: "objectives.band.reason.notInReview",
  not_awaiting_handoff: "objectives.band.reason.notAwaitingHandoff",
  routing_preview_stale: "objectives.band.reason.routingStale",
};

/** 메시지의 거절은 지휘관이 아니라 받는 이의 사정이다. */
const MESSAGE_REASONS: Readonly<Record<string, ObjectiveMessageKey>> = {
  session_awaiting_input: "objectives.band.reason.recipientAwaiting",
  unknown_member: "objectives.band.reason.recipientGone",
  unknown_operation: "objectives.band.reason.recipientGone",
  session_not_found: "objectives.band.reason.recipientGone",
  // 세션 좌표가 남지 않은 휴면 세션 — 이어 붙일 세션이 없어 깨울 수 없다.
  capability_unavailable: "objectives.band.reason.recipientUnreachable",
  resume_unavailable: "objectives.band.reason.recipientUnreachable",
};

const codeOf = (error: unknown): string => (error instanceof Error ? error.message : "unknown");
const reasonText = (t: T, code: string): string => (REASONS[code] ? t(REASONS[code]!) : t("objectives.band.reason.other", { code }));

/** 실패 코드를 사유 한 줄로 — 메시지의 거절은 받는 이의 사정이 먼저다. 입력창·모바일 ⋮·시작 화면이 같은 문구를 쓴다. */
export function bandFailure(t: T, error: unknown, options: { readonly message: boolean; readonly talk: boolean }): string {
  const code = codeOf(error);
  const reasonKey = options.message ? MESSAGE_REASONS[code] ?? REASONS[code] : REASONS[code];
  const reason = reasonKey ? t(reasonKey) : t("objectives.band.reason.other", { code });
  return t(options.talk ? "objectives.band.failed" : "objectives.band.failedAction", { reason });
}

interface ChooseInput {
  readonly objective: Objective;
  /** 지휘관 자신이나 구성원 누군가가 일한다. */
  readonly working: boolean;
  /** 지휘관 자신이 사람의 결정을 기다린다(끌어올리기 전 값 — 구성원의 대기는 memberAwaiting). */
  readonly commanderAwaiting: boolean;
  readonly memberAwaiting: MemberAwaiting | null;
}

/** 지금 상태의 주행동과, 함께 성립하는 것. 제안이 남아 잠긴 개시·스티어링은 gated 가 말한다(주행동은 「다시 구상」). */
function choose(props: ChooseInput): { readonly primary: IntentKey | null; readonly alts: readonly IntentKey[]; readonly gated?: true } {
  const { objective, working, commanderAwaiting, memberAwaiting } = props;
  if (objective.done) return { primary: "extend", alts: [] };
  const started = objective.commander.started;
  // 한 번도 깨지 않은 지휘관은 보드를 처음부터 읽는다 — 그 전의 편집은 알릴 것이 아니다.
  const edited = started && (objective.edited?.kinds.length ?? 0) > 0;
  if (commanderAwaiting) return { primary: "decide", alts: [] };
  if (working) return edited ? { primary: "steer", alts: ["stop"] } : { primary: "stop", alts: [] };
  if (memberAwaiting) return { primary: "decideMember", alts: [] };
  if (objective.criteriaProposals.length > 0) return { primary: "replan", alts: [], gated: true };
  if (objective.awaitingReview) return edited ? { primary: "steer", alts: ["extend", "replan"] } : { primary: "complete", alts: ["extend"] };
  if (objective.awaitingHandoff) return edited ? { primary: "steerIdle", alts: ["handOff"] } : { primary: "handOff", alts: [started ? "resume" : "start"] };
  // 구상이 끝나 개시를 기다린다 — 편집이 있으면 편성을 이어서 짜게 알리고(스티어링), 개시도 여기서 고른다.
  if (started && objective.planning) return edited ? { primary: "steer", alts: ["start"] } : { primary: "start", alts: ["replan"] };
  if (started) return edited ? { primary: "steerIdle", alts: ["replan"] } : { primary: "resume", alts: ["replan"] };
  return objective.missions.length === 0 ? { primary: "plan", alts: ["start"] } : { primary: "start", alts: ["plan"] };
}

/** 지금 고를 수 있는 할 일 — 주행동·보조·후속 후보 고르기·메시지 가능 여부. 모바일 ⋮ 와 시작 화면도 같은 판정을 쓴다. */
export function bandChoices(props: ChooseInput & { readonly commanderExists: boolean; readonly recipientCount: number }) {
  const { objective } = props;
  const { primary, alts: stateAlts, gated } = choose(props);
  // 후속 후보 — 검토 대기 + 후보 1건 이상 + edited 아님이 `complete` 와 겹치면 바로 완료하지 않고 후보를 고르게 한다.
  const followupCandidates = openFollowups(objective);
  const followupAvailable = primary === "complete" && !gated && isFollowupSelectable(objective) && followupCandidates.length > 0;
  // 「메시지」 — 깨어난 지휘관이 있으면 어느 상태에서든 고른다. 결정 대기·후속 후보·잠긴 동작은 제 할 일이 먼저다.
  // 완료한 목표는 한 번 섰던 지휘관과 늘 이야기할 수 있다 — 보관됐어도 서버가 휴면으로 되살려 전하고, 완료는 그대로다.
  const messageable = objective.done ? objective.commander.started
    : !!primary && objective.commander.started && props.commanderExists && props.recipientCount > 0
      && primary !== "decide" && primary !== "decideMember" && !gated && !followupAvailable;
  const alts: readonly IntentKey[] = messageable ? [...stateAlts, "message"] : stateAlts;
  return { primary, alts, gated, followupCandidates, followupAvailable };
}

// ── 지금 보이는 활동 ───────────────────────────────────────────────────────

/**
 * 보드가 읽는 활동 — 화면처럼 턴 뒤 백그라운드는 작업 중으로 접는다. 지휘관은 구성원을 끌어올리기 전 자기 활동이다.
 * 보관된 Operation 의 describe 요약은 세지 않는다 — 완료로 보관된 지휘관은 없는 것(closed)이다.
 */
interface BoardLive {
  readonly commander: string;
  readonly member: (operationId: string) => string;
  readonly launchAvailable: boolean;
}

const shown = (activity: string | undefined): string => (activity === undefined ? "closed" : activity === "background" ? "running" : activity);

function liveOf(objective: Objective): BoardLive {
  const summaries = listedOperationSummaries();
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const commander = byId.get(objective.id);
  return {
    commander: shown(commander ? commander.ownActivity ?? commander.activity : undefined),
    member: (operationId) => shown(byId.get(operationId)?.activity),
    // 보관된 완료 목표는 살아 있는 목록에 없다 — 목록이 아니라 그 Theater 의 기동 가능 여부를 읽는다.
    launchAvailable: readTheater(objective.theaterId).launchAvailable,
  };
}

/** 살아 있는 목록에서, 없으면 읽어 둔 끝난 목표(보관)에서 — 완료 화면의 범위 넓히기도 같은 레코드로 보낸다. */
const findObjective = (objectiveId: string): Objective | null => findAnyObjective(objectiveId);
const memberLaunchedIn = (live: BoardLive) => (member: ObjectiveMember): boolean => member.sessionName !== null && live.member(member.id) !== "closed";
const routingTargetsOf = (objective: Objective, live: BoardLive): readonly ObjectiveMember[] => objective.members.filter((member) => member.launch.mode === "route" && !memberLaunchedIn(live)(member));

function choicesOf(objective: Objective, live: BoardLive) {
  const done = objective.done;
  const working = !done && (live.commander === "running" || objective.members.some((member) => member.sessionName !== null && live.member(member.id) === "running"));
  const commanderAwaiting = !done && live.commander === "awaiting";
  const awaitingMember = done ? undefined : objective.members.find((member) => member.sessionName !== null && live.member(member.id) === "awaiting");
  const mission = awaitingMember ? objective.missions.findIndex((candidate) => !candidate.done && candidate.member === awaitingMember.id) : -1;
  const memberAwaiting: MemberAwaiting | null = awaitingMember ? { operationId: awaitingMember.id, role: awaitingMember.role, mission: mission >= 0 ? mission + 1 : null } : null;
  const recipientCount = [live.commander, ...objective.members.filter((member) => member.sessionName !== null).map((member) => live.member(member.id))].filter((state) => state !== "closed").length;
  return { ...bandChoices({ objective, working, commanderAwaiting, memberAwaiting, commanderExists: live.commander !== "closed", recipientCount }), memberAwaiting, working };
}

/** 넘김 카드와 완료 칩이 같은 보드·실행 상태로 후보 고르기를 연다. */
export function followupPickable(objective: Objective): boolean {
  return choicesOf(objective, liveOf(objective)).followupAvailable;
}

// ── 이어받는 칸(라우팅 확인) ───────────────────────────────────────────────

/** 라우팅 확인을 기다리는 개시 — 목표 id → 덧붙일 말. 플러그인 번들 안의 보기 상태다. */
const sheets = new Map<string, { readonly intent: IntentKey; readonly context: string }>();
const sheetListeners = new Set<() => void>();
const setSheet = (objectiveId: string, value: { readonly intent: IntentKey; readonly context: string } | null) => {
  if (value) sheets.set(objectiveId, value); else sheets.delete(objectiveId);
  for (const listener of sheetListeners) listener();
};
const subscribeSheets = (listener: () => void) => { sheetListeners.add(listener); return () => { sheetListeners.delete(listener); }; };
/**
 * 칸이 「이대로 개시」를 보내는 중인 목표 — 그 응답 전에는 같은 목표의 개시를 다시 받지 않는다. 다시 받으면 앞선 개시의 정산이 새로 쓴
 * 말의 판을 걷어 버린다(입력창은 동작 id 로 정산한다). 거절은 실패로 돌려 입력창이 쓴 말과 기억한 판을 그대로 둔다.
 */
const sheetsSending = new Set<string>();

// ── 계약 ──────────────────────────────────────────────────────────────────

const language = (): "en" | "ko" => commodoreLanguage() ?? "en";
const request = <R,>(path: string, body: Record<string, unknown>): Promise<R> => {
  const api = objectivesApi();
  if (!api) return Promise.reject(new Error("objectives_unavailable"));
  return post<R>(api, path, { ...body, language: language() });
};
const failed = (error: unknown, talk: boolean): GroupBoardRunResult => ({ outcome: "failed", notice: {
  tone: "warn",
  text: (locale) => bandFailure(getT(locale), error, { message: false, talk }),
  mobileText: (locale) => bandFailure(getT(locale, true), error, { message: false, talk }),
} });
/** 개시 응답의 failed — 띄우지 못한 구성원을 알린다(개시 자체는 이어졌다). */
const started = (result: unknown): GroupBoardRunResult => {
  const missed = (result as { failed?: readonly { role: string }[] } | undefined)?.failed ?? [];
  return missed.length
    ? { outcome: "done", notice: { tone: "warn", text: localized((t) => t("objectives.start.failedMembers", { count: missed.length, roles: missed.map((entry) => entry.role).join(", ") })) } }
    : { outcome: "done" };
};

const TALK: ReadonlySet<IntentKey> = new Set(["plan", "replan", "start", "resume", "steer", "steerIdle", "extend"]);
const CHIP: ReadonlySet<IntentKey> = new Set([...TALK, "complete", "handOff"]);

/** 보드 동작 한 칸을 계약의 모양으로 — 낱말·부제·자리표시는 로케일마다 다시 푼다. */
function actionOf(objective: Objective, key: IntentKey, primary: boolean, live: BoardLive): GroupBoardAction {
  const kinds = (t: T) => [(objective.edited?.kinds ?? []).map((kind) => t(EDIT_KEYS[kind])).join("·"), ...nonHumanEditors(t, objective.edited?.actors)].filter(Boolean).join(" · ");
  const talk = (placeholder: (t: T) => string, required = false, prefill?: string) => ({ context: { placeholder: localized(placeholder), required, maxLength: MAX_CONTEXT, ...(prefill ? { prefill } : {}) } });
  const unavailable = TALK.has(key) && !live.launchAvailable ? { unavailable: localized((t) => t("objectives.commander.unavailable")) } : {};
  const emphasis = primary ? { emphasis: key === "complete" ? "review" as const : "primary" as const } : {};
  const base = { id: key, ...emphasis, ...unavailable };
  switch (key) {
    case "plan": return { ...base, label: localized((t) => t("objectives.band.plan")), glyph: "plan", ...talk((t) => t("objectives.commander.planContext"), false, objective.planRequest ?? undefined) };
    case "replan": return { ...base, label: localized((t) => t("objectives.band.replan")), glyph: "plan", ...talk((t) => t("objectives.band.replan.ph"), false, objective.planRequest ?? undefined) };
    case "start": case "resume": {
      const members = objective.members.length;
      return { ...base, label: localized((t) => t("objectives.commander.start")), glyph: "start", ...(key === "start" && members ? { detail: localized((t) => t("objectives.composer.members", { count: members })) } : {}),
        ...talk((t) => t(key === "start" ? "objectives.band.start.ph" : "objectives.band.resume.ph")) };
    }
    case "steer": case "steerIdle": return { ...base, label: localized((t) => t("objectives.steer")), glyph: "steer", ...(objective.edited?.kinds.length ? { detail: localized(kinds) } : {}), ...talk((t) => t("objectives.band.steer.ph")) };
    case "extend": return { ...base, label: localized((t) => t("objectives.extend.action")), glyph: "plan", ...talk((t) => t("objectives.extend.placeholder"), true) };
    case "complete": return { ...base, label: localized((t) => t("objectives.review.complete")), glyph: "complete", ...(choicesOf(objective, live).followupAvailable ? {} : { confirm: true }) };
    default: return { ...base, label: localized((t) => t("objectives.handoff.send")), glyph: "handOff", confirm: true };
  }
}

/** 제안 줄 앞의 한 줄 — 잠긴 개시, 구상 중의 중단 안내, 허용을 기다리는 참여자. */
function noteOf(objective: Objective, choices: ReturnType<typeof choicesOf>, live: BoardLive): GroupBoardActions["note"] {
  if (choices.gated) {
    const edited = objective.commander.started && (objective.edited?.kinds.length ?? 0) > 0;
    const count = objective.criteriaProposals.length;
    return {
      tone: "lock",
      text: localized((t) => t("objectives.composer.locked", { word: t(edited ? "objectives.steer" : "objectives.commander.start"), reason: t("objectives.band.gated", { count }) })),
      reveal: { label: localized((t) => t("objectives.composer.reveal")), run: () => { revealObjective({ objectiveId: objective.id }); openObjectiveFromCluster(objective.theaterId); } },
    };
  }
  if (choices.primary === "decide") return { tone: "awaiting", text: localized((t) => t("objectives.composer.awaitingCommander")) };
  const member = choices.memberAwaiting;
  if (choices.primary === "decideMember" && member) {
    return { tone: "awaiting", text: localized((t) => (member.mission ? t("objectives.composer.awaitingMemberMission", { role: member.role, index: member.mission }) : t("objectives.composer.awaitingMember", { role: member.role }))) };
  }
  if (choices.working && objective.planning && live.commander === "running") return { tone: "working", text: localized((t) => t("objectives.composer.planning")) };
  return undefined;
}

const HINTS: Partial<Record<IntentKey, ObjectiveMessageKey>> = {
  plan: "objectives.composer.hint.context",
  start: "objectives.composer.hint.context",
  steer: "objectives.composer.hint.steer",
  steerIdle: "objectives.composer.hint.steer",
  complete: "objectives.composer.hint.review",
  handOff: "objectives.composer.hint.handoff",
};

/** 보드 동작 계약 — 지금 상태로 칩을 세우고, 실행은 늘 지금 보드를 다시 읽어 보낸다(묶음 캐시가 옛 목표를 쥐어도 같다). */
export function objectiveBoardActions(objective: Objective): GroupBoardActions {
  const live = liveOf(objective);
  const objectiveId = objective.id;
  const choices = choicesOf(objective, live);
  const keys = choices.primary && CHIP.has(choices.primary) ? [choices.primary, ...choices.alts.filter((key) => CHIP.has(key))] : choices.alts.filter((key) => CHIP.has(key));
  const done = objective.done;
  // 제안 줄은 칩 1~2개 — 같은 상태에서 함께 성립하는 셋째부터는 ＋ 메뉴의 보드 행으로 선다(사다리의 결과를 버리지 않는다).
  // 완료한 목표의 범위 넓히기는 고를 수 있는 칩일 뿐이다 — 기본 전송은 지휘관에게 가는 메시지이므로 강조하지 않는다.
  const offered = keys.map((key, index) => actionOf(objective, key, !done && index === 0 && key === choices.primary, live));
  const suggestions = offered.slice(0, 2);
  const more = offered.slice(2);
  const hintKey = done ? (choices.alts.includes("message") ? "objectives.extend.doneDesc" : undefined) : choices.primary ? HINTS[choices.primary] : undefined;
  const compactSessions = new Set([objectiveId, ...objective.members.filter((member) => member.sessionName !== null).map((member) => member.id)]).size;
  const note = noteOf(objective, choices, live);
  return {
    suggestions,
    ...(more.length ? { more } : {}),
    ...(hintKey && suggestions.length ? { hint: localized((t) => t(hintKey)) } : {}),
    // 완료한 목표의 평범한 메시지는 지휘관에게만 — 구성원은 임무를 닫았다(서버도 objective_done 으로 거절한다).
    ...(done ? { commanderOnly: true } : {}),
    // 지휘관이 서기 전에는 평범한 메시지가 갈 곳이 없다 — 구상·개시(완료한 목표면 범위 넓히기)에 덧붙일 말만 받는다.
    ...(!objective.commander.started && (done || live.commander === "closed") ? { actionsOnly: true } : {}),
    ...(note ? { note } : {}),
    ...(live.commander !== "closed" ? { compact: { sessions: compactSessions, run: () => runCompact(objectiveId) } } : {}),
    run: (actionId, context) => runAction(objectiveId, actionId as IntentKey, context),
    renderPanel: (ctx) => <BoardPanel objectiveId={objectiveId} ctx={ctx} />,
  };
}

async function runAction(objectiveId: string, key: IntentKey, context: string): Promise<GroupBoardRunResult> {
  const objective = findObjective(objectiveId);
  if (!objective) return failed(new Error("unknown_objective"), false);
  const live = liveOf(objective);
  const withContext = context ? { context } : {};
  try {
    switch (key) {
      case "plan": case "replan": await request("/plan/request", { objectiveId, context }); return { outcome: "done" };
      case "extend": await request("/objective/extend", { objectiveId, context }); return { outcome: "done" };
      case "steer": await request("/commander/steer", { objectiveId, ...withContext }); return { outcome: "done" };
      case "start": case "resume": case "steerIdle": {
        // 라우팅으로 띄울 구성원이 있으면 개시는 늘 판단 → 확인 → 기동으로 나뉜다 — 여기서는 칸만 열고 말은 칸이 이어받는다.
        if (routingTargetsOf(objective, live).length > 0) {
          if (sheetsSending.has(objectiveId)) return { outcome: "failed", notice: { tone: "info", text: localized((t) => t("objectives.band.sending")) } };
          setSheet(objectiveId, { intent: key, context });
          return { outcome: "held" };
        }
        return started(await request("/commander/start", { objectiveId, ...withContext }));
      }
      case "complete": {
        // 후보가 있으면 완료하지 않고 칸을 연다 — 한 번 누름으로 후보 검토를 건너뛰는 길을 없앤다.
        if (choicesOf(objective, live).followupAvailable) { setFollowupOpen(objectiveId, true); return { outcome: "held" }; }
        await request("/objective/complete", { objectiveId });
        return { outcome: "done" };
      }
      case "handOff": await request("/objective/hand-off", { objectiveId }); return { outcome: "done" };
      default: return failed(new Error("unknown_action"), false);
    }
  } catch (error) {
    return failed(error, TALK.has(key));
  }
}

interface CompactResult { readonly requested: number; readonly woken: number; readonly rejected: number; readonly excluded: number }
async function runCompact(objectiveId: string): Promise<GroupBoardRunResult> {
  try {
    const result = await request<Partial<CompactResult> | undefined>("/commander/compact", { objectiveId });
    const counts: CompactResult = { requested: result?.requested ?? 0, woken: result?.woken ?? 0, rejected: result?.rejected ?? 0, excluded: result?.excluded ?? 0 };
    if (counts.requested === 0) return { outcome: "failed", notice: { tone: "warn", text: localized((t) => t("objectives.band.failedAction", { reason: t("objectives.compact.none") })) } };
    const text: LocalizedText = localized((t) => ([["requested", counts.requested], ["woken", counts.woken], ["rejected", counts.rejected], ["excluded", counts.excluded]] as const)
      .filter(([, count]) => count > 0).map(([name, count]) => t(`objectives.compact.${name}`, { count })).join(" · "));
    return { outcome: "done", notice: { tone: "info", text } };
  } catch (error) {
    return failed(error, false);
  }
}

// ── 입력창 위 칸 ───────────────────────────────────────────────────────────

const Spinner = () => <span className="objectives-routing-spinner" aria-hidden="true" />;
/** 대상 전원에 걸친 사유 — 항목별 사유가 아니라 판단 자체가 돌지 못했다. 칸 위에 띠로 선다. */
const SET_WIDE_REASONS = new Set(["routing_disabled", "routing_timeout", "routing_unavailable", "routing_failed"]);

const useObjective = (objectiveId: string) => useSyncExternalStore(subscribeObjectiveOrFinished, () => findObjective(objectiveId), () => findObjective(objectiveId));
const useSheet = (objectiveId: string) => useSyncExternalStore(subscribeSheets, () => sheets.get(objectiveId) ?? null, () => null);

/** 입력창 바로 위 칸 — 라우팅 확인이 먼저, 그다음 후속 후보 고르기. 띄울 것이 없으면 아무것도 그리지 않는다. */
function BoardPanel({ objectiveId, ctx }: { readonly objectiveId: string; readonly ctx: GroupBoardPanelContext }) {
  const objective = useObjective(objectiveId);
  const sheet = useSheet(objectiveId);
  const followupOpen = useFollowupOpen(objectiveId);
  useSyncExternalStore(subscribeObjective, listedOperationSummaries, listedOperationSummaries);
  const t = getT(ctx.language, ctx.layout === "mobile");
  if (!objective) return null;
  if (sheet) return <RoutingPanel key={objectiveId} objective={objective} t={t} intent={sheet.intent} context={sheet.context} settle={ctx.settle} />;
  if (followupOpen && choicesOf(objective, liveOf(objective)).followupAvailable) return <FollowupPanel key={objectiveId} objective={objective} t={t} settle={ctx.settle} />;
  return null;
}

/** Esc 는 칸만 닫는다 — 입력창이나 상세를 닫는 창 처리기로 올라가지 않는다. */
const onPanelKey = (close: () => void) => (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  close();
};

/** 후속 후보 — 고르면 새 목표로 만들고 같은 자리에서 완료한다. 선택은 완료를 누르기 전까지 이 탭의 초안이다. */
function FollowupPanel({ objective, t, settle }: { readonly objective: Objective; readonly t: T; readonly settle: GroupBoardPanelContext["settle"] }) {
  const objectiveId = objective.id;
  const selection = useFollowupSelection(objectiveId);
  const candidates = openFollowups(objective);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idsKey = candidates.map((candidate) => `${candidate.id}:${candidate.rev}`).join(",");
  // 목록에서 사라진 id 는 초안에서 거두고, rev 가 바뀐 id 는 선택을 풀어 새로 고친 본문을 확인한 뒤 다시 고르게 한다.
  useEffect(() => {
    const revs = new Map(idsKey ? idsKey.split(",").map((entry) => { const at = entry.lastIndexOf(":"); return [entry.slice(0, at), Number(entry.slice(at + 1))] as const; }) : []);
    pruneSelection(objectiveId, revs);
  }, [objectiveId, idsKey]);
  const picked = candidates.filter((candidate) => selection.has(candidate.id)).length;
  const close = () => setFollowupOpen(objectiveId, false);
  // 다른 곳(사이드바 검토 글리프·보드)에서 고르러 왔으면 칸이 선 뒤 첫 체크상자로 초점을 준다 — 이 칸의 DOM 만 본다.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (takeFollowupFocus(objectiveId)) rootRef.current?.querySelector<HTMLElement>("[data-followup-sel]")?.focus();
  }, [objectiveId]);
  /** 선택 순간의 rev 로 한 번만 보낸다. 바뀌었으면 서버가 followup_changed 로 거절한다. 고른 게 없으면 지금 완료 그대로다. */
  const complete = async () => {
    if (sending) return;
    const stored = readSelectionRevs(objectiveId);
    const live = new Set(openFollowups(objective).map((candidate) => candidate.id));
    const chosen = [...stored].filter(([id]) => live.has(id));
    setSending(true);
    setError(null);
    try {
      if (chosen.length === 0) await request("/objective/complete", { objectiveId });
      else await request("/objective/complete", { objectiveId, batchId: newBatchId(), followups: chosen.map(([id, rev]) => ({ id, rev })) });
      clearSelection(objectiveId);
      close();
      settle({ outcome: "done", actionId: "complete" });
    } catch (failure) {
      setError(t("objectives.band.failedAction", { reason: reasonText(t, codeOf(failure)) }));
    } finally {
      setSending(false);
    }
  };
  const discard = (candidateId: string) => {
    void request("/followup/discard", { objectiveId, candidateId }).catch((failure: unknown) => setError(t("objectives.band.failedAction", { reason: reasonText(t, codeOf(failure)) })));
  };
  return (
    <div ref={rootRef} className="objectives-composer-panel" role="dialog" aria-label={t("objectives.followup.pick")} onKeyDown={onPanelKey(close)}>
      <div className="objectives-composer-panel-head">
        <span>{t("objectives.followup.pick")} · <span aria-live="polite">{t("objectives.followup.count", { k: picked, n: candidates.length })}</span></span>
        <button type="button" className="objectives-glyph" aria-label={t("objectives.routing.close")} title={t("objectives.routing.close")} onClick={close}><CloseGlyph /></button>
      </div>
      <FollowupCandidateList
        candidates={candidates}
        selectable
        selection={selection}
        t={t}
        idPrefix={`composer-${objectiveId}`}
        openId={openId}
        onOpenChange={setOpenId}
        onToggleCheck={(candidateId, checked) => { const rev = candidates.find((candidate) => candidate.id === candidateId)?.rev ?? 1; toggleFollowupSelection(objectiveId, candidateId, checked, rev); setError(null); }}
        onDiscard={discard}
      />
      <FollowupDiscardedTrace discarded={discardedFollowups(objective)} t={t} />
      {error ? <p className="objectives-composer-panel-error" role="alert">{error}</p> : null}
      <div className="objectives-composer-panel-foot">
        <span>{picked === 0 ? t("objectives.followup.sendEmpty", { n: candidates.length }) : t("objectives.followup.sendSome", { k: picked })}</span>
        {/* 보내는 중은 aria-disabled로만 막는다 — native disabled는 막 누른 버튼의 포커스를 문서로 떨군다. */}
        <button type="button" className="objectives-btn is-primary" aria-disabled={sending || undefined} aria-busy={sending || undefined} onClick={() => void complete()}>{t("objectives.review.complete")}</button>
      </div>
    </div>
  );
}

/** 라우팅 확인 칸 — 판단 중(judging)·본 결과를 갱신 중(refreshing)·결과(ready). overridden 은 칸에서 직접 지정으로 바꾼 구성원이다. */
interface RoutingState {
  readonly phase: "judging" | "refreshing" | "ready";
  readonly preview: RoutingPreview | null;
  /** 칸에서 직접 지정한 값 — 저장이 방송으로 돌아오기 전에도 행이 그 모델을 말한다. */
  readonly overridden: ReadonlyMap<string, { readonly model: string; readonly effort?: string }>;
  /** 이 칸에서 본 판단 결과 — 다시 읽어도 직접 지정으로 대상에서 빠진 구성원의 결과를 남긴다. */
  readonly known: ReadonlyMap<string, RoutingPreview["members"][number]>;
  readonly error: string | null;
}

function RoutingPanel({ objective, t, intent, context, settle }: { readonly objective: Objective; readonly t: T; readonly intent: IntentKey; readonly context: string; readonly settle: GroupBoardPanelContext["settle"] }) {
  const objectiveId = objective.id;
  const live = liveOf(objective);
  const targets = routingTargetsOf(objective, live);
  const launched = memberLaunchedIn(live);
  const rows = useLaunchRows();
  const [state, setState] = useState<RoutingState>({ phase: "judging", preview: null, overridden: new Map(), known: new Map(), error: null });
  const [sending, setSending] = useState(false);
  // 판단 응답이 칸을 닫은 뒤에 닿으면 버린다.
  const token = useRef(0);
  const ttlMinutes = Math.round(ROUTING_PREVIEW_TTL_MS / 60_000);
  const labels = { auto: t("objectives.commander.effortAuto"), fallback: t("objectives.launch.default") };
  /** 판단(또는 캐시) — rejudge 면 다시 판단한다. 결과를 이미 보고 있으면 그대로 두고 갱신만 한다(refreshing). */
  const load = (rejudge: boolean) => {
    const mine = ++token.current;
    setState((current) => ({ ...current, phase: current.preview && !rejudge ? "refreshing" : "judging", known: rejudge ? new Map() : current.known, error: null }));
    void request<{ preview?: RoutingPreview } | undefined>("/routing/preview", { objectiveId, ...(rejudge ? { rejudge: true } : {}) }).then((result) => {
      if (mine !== token.current) return;
      const preview = result?.preview ?? null;
      // 직접 지정으로 대상에서 빠진 구성원의 앞선 결과도 남긴다 — 「라우팅 결과 쓰기」가 무엇으로 돌아가는지 계속 말한다.
      setState((current) => ({ ...current, phase: "ready", preview, known: new Map([...current.known, ...(preview?.members ?? []).map((entry) => [entry.id, entry] as const)]) }));
    }, (failure: unknown) => {
      if (mine !== token.current) return;
      setState((current) => ({ ...current, phase: "ready", error: codeOf(failure) }));
    });
  };
  useEffect(() => { load(false); return () => { token.current += 1; }; }, [objectiveId]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => {
    if (state.preview) settle({ outcome: "held", actionId: intent, notice: { tone: "info", text: localized((tt) => tt("objectives.routing.kept", { minutes: ttlMinutes })) } });
    setSheet(objectiveId, null);
  };
  /** 직접 지정 — 구성원 선택을 바꾸고(라우팅으로 되돌리기 포함) 결과를 다시 읽는다. */
  const pick = (member: ObjectiveMember, launch: { mode: "model"; model: string; effort?: string } | null) => {
    const previous = state.overridden.get(member.id);
    const overridden = new Map(state.overridden);
    if (launch) overridden.set(member.id, launch); else overridden.delete(member.id);
    setState((current) => ({ ...current, overridden }));
    void request("/member/patch", { objectiveId, memberId: member.id, patch: { launch } }).then(() => load(false), (failure: unknown) => {
      // 저장되지 않은 선택을 행에 남기지 않는다 — 「이대로 개시」는 저장된 설정으로 띄우므로 행도 지정 전 값으로 돌아간다.
      setState((current) => {
        const restored = new Map(current.overridden);
        if (previous) restored.set(member.id, previous); else restored.delete(member.id);
        return { ...current, overridden: restored, error: codeOf(failure) };
      });
    });
  };
  const settling = state.phase !== "ready";
  /** 「이대로 개시」 — 본 결과 그대로 띄운다. 그새 결과를 쓸 수 없게 됐으면 다시 읽어 보여 준다(바뀐 대상만 판단). */
  const go = async () => {
    if (sending || settling) return;
    setSending(true);
    sheetsSending.add(objectiveId);
    try {
      const result = await request("/commander/start", { objectiveId, routing: "preview", ...(context ? { context } : {}) });
      token.current += 1;
      setSheet(objectiveId, null);
      // 칸은 개시를 누를 때 넘겨받은 말을 보낸다 — 칸이 열린 사이 입력창에 새로 쓴 말은 입력창이 남긴다(actionId 의 판 비교).
      settle({ ...started(result), actionId: intent });
    } catch (failure) {
      const code = codeOf(failure);
      if (code === "routing_preview_stale") load(false);
      setState((current) => ({ ...current, error: code }));
    } finally {
      sheetsSending.delete(objectiveId);
      setSending(false);
    }
  };
  const judging = state.phase === "judging";
  const rowLocked = judging || sending;
  const commanderWords = launchedWords(rows, objective.commander.model, objective.commander.effort, labels);
  const wide = (state.preview?.members ?? []).flatMap((entry) => (entry.via === "fallback" && SET_WIDE_REASONS.has(entry.reason) ? [entry.reason] : []))[0];
  const minutes = state.preview ? Math.floor((Date.now() - state.preview.at) / 60_000) : 0;
  const status = judging ? t("objectives.routing.judging") : !state.preview ? "" : state.preview.judged ? t("objectives.routing.judgedNow") : minutes <= 0 ? t("objectives.routing.cachedNow") : t("objectives.routing.cached", { minutes });
  const words = (model: string | undefined, effort: string | undefined) => { const shownWords = launchedWords(rows, model, effort, labels); return <span className="objectives-routing-words" title={shownWords.title}><LaunchedText model={shownWords.model} words={shownWords.words} /></span>; };
  const mark = (member: ObjectiveMember) => <ObjectiveAvatar operationId={member.id} role="member" state={memberMongleState(objective, member.id, member.sessionName !== null ? live.member(member.id) : "closed")} />;
  const memberRow = (member: ObjectiveMember) => {
    const result = state.known.get(member.id);
    const target = targets.some((candidate) => candidate.id === member.id);
    const picked = state.overridden.get(member.id);
    const row = (label: string, control: ReactNode, why?: { readonly text: string; readonly warn?: boolean }, fixed = false) => (
      <div key={member.id} className={`objectives-routing-row${fixed ? " is-fixed" : ""}`}>
        {mark(member)}
        <span className="objectives-routing-who"><span className="objectives-routing-role">{member.role}</span><small>{label}</small></span>
        <span className="objectives-routing-pick">{control}</span>
        {why ? <span className={`objectives-routing-why${why.warn ? " is-warn" : ""}`}>{why.text}</span> : null}
      </div>
    );
    // 예약이 걸린 구성원은 예약값으로 재개를 시도한다 — 칸도 그 모델을 보인다.
    if (launched(member)) return member.next && !member.next.failed
      ? row(t("objectives.routing.fixedReserved"), words(member.next.model, member.next.effort), undefined, true)
      : row(t("objectives.routing.fixedResume"), words(member.model, member.effort), undefined, true);
    // 폴백은 띄우는 순간의 지휘관 프리셋으로 뜬다 — 칸을 연 사이 프리셋을 바꿔도 보이는 모델이 실제 기동과 같게 지금 값을 보인다.
    const shownModel = result?.via === "fallback" ? objective.commander : result;
    const resultWords = result ? `${launchedWords(rows, shownModel?.model, shownModel?.effort, labels).title}${result.via === "fallback" ? ` · ${t("objectives.members.fallback")}` : ""}` : t("objectives.routing.atLaunch");
    const useResult = { id: "route", label: t("objectives.routing.useResult"), hint: resultWords };
    const onModel = (next: { model?: string; effort?: string }) => { if (next.model) pick(member, { mode: "model", model: next.model, ...(next.effort ? { effort: next.effort } : {}) }); };
    if (picked) {
      return row(t("objectives.routing.viaPicked"), <LaunchControl t={t} model={picked.model} effort={picked.effort} locked={rowLocked} startAtList triggerLabel={t("objectives.routing.rowAria", { role: member.role })}
        extras={[{ ...useResult, active: false, onPick: () => pick(member, null) }]} onChange={onModel} />, { text: t("objectives.routing.picked") });
    }
    if (target) {
      const trigger = judging && !result ? <span className="objectives-routing-judging"><Spinner />{t("objectives.routing.judgingRow")}</span>
        : result ? <>{words(shownModel?.model, shownModel?.effort)}{result.via === "fallback" ? <span className="objectives-member-via is-fallback">{t("objectives.members.fallback")}</span> : null}</>
        : <span className="objectives-launch-model">{t("objectives.routing.atLaunch")}</span>;
      const why = !result || judging ? undefined : result.via === "route" ? (result.because ? { text: result.because } : undefined) : { text: t("objectives.routing.fallbackWhy", { reason: routingReason(t, result.reason) }), warn: true };
      return row(t("objectives.routing.viaRoute"), <LaunchControl t={t} model={undefined} effort={undefined} locked={rowLocked} startAtList triggerLabel={t("objectives.routing.rowAria", { role: member.role })} triggerText={trigger}
        extras={[{ ...useResult, active: true, onPick: () => undefined }]} onChange={onModel} />, why);
    }
    if (member.launch.mode === "model") return row(t("objectives.routing.fixedModel"), words(member.launch.model, member.launch.effort), undefined, true);
    return row(t("objectives.memberSelection.inherit"), words(objective.commander.model, objective.commander.effort), undefined, true);
  };
  const model = `${commanderWords.words.model} · ${commanderWords.words.effort}`;
  return (
    <div className="objectives-composer-panel objectives-routing" role="dialog" aria-label={t("objectives.routing.title")} aria-busy={judging || undefined} tabIndex={-1} onKeyDown={onPanelKey(close)} data-intent={intent}>
      <div className="objectives-composer-panel-head">
        <span className="objectives-routing-head"><b>{t("objectives.routing.title")}</b><span aria-live="polite">{judging ? <><Spinner />{status}</> : status}</span></span>
        <button type="button" className="objectives-glyph" aria-label={t("objectives.routing.close")} title={t("objectives.routing.close")} onClick={close}><CloseGlyph /></button>
      </div>
      {wide && !judging ? <div className="objectives-routing-banner" role="note">{wide === "routing_disabled" ? t("objectives.routing.banner.disabled", { model }) : t("objectives.routing.banner.other", { reason: routingReason(t, wide), model })}</div> : null}
      <div className="objectives-routing-list">{objective.members.map(memberRow)}</div>
      {state.error ? <p className="objectives-composer-panel-error" role="alert">{state.error === "routing_preview_stale" ? reasonText(t, state.error) : t("objectives.routing.failed", { reason: reasonText(t, state.error) })}</p> : null}
      <div className="objectives-routing-foot">
        <span>{targets.length ? t("objectives.routing.foot", { count: targets.length, minutes: ttlMinutes }) : t("objectives.routing.footNone")}</span>
        {/* 재판단 대기·보내는 중은 일시 상태라 aria-disabled로 막는다(onClick이 거른다) — 키보드로 막 누른 「다시 판단」의 포커스를 지킨다. */}
        <button type="button" className="objectives-btn is-small" disabled={targets.length === 0} aria-disabled={settling || sending || undefined} aria-busy={settling || undefined} onClick={() => { if (settling || sending || targets.length === 0) return; load(true); }}>{t("objectives.routing.rejudge")}</button>
      </div>
      <div className="objectives-composer-panel-foot">
        <span>{sending ? t("objectives.band.sending") : null}</span>
        {/* 판단 대기·보내는 중은 저절로 끝나는 일시 상태라 aria-disabled로만 막는다(go가 둘 다 거른다). */}
        <button type="button" className="objectives-btn is-primary" aria-disabled={settling || sending || undefined} aria-busy={sending || undefined} onClick={() => void go()}>{t("objectives.routing.go")}</button>
      </div>
    </div>
  );
}

const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
