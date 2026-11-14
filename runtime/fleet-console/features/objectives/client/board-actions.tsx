import { openObjectivePopup } from "./objectives-panel.js";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { GroupBoardAction, GroupBoardActions, GroupBoardPanelContext, GroupBoardRunResult } from "../../execution/shared/conversation/types.js";
import type { LocalizedText, Translate } from "@fleet-console/i18n";

import { MAX_CONTEXT, type Objective, type ObjectiveEditKind } from "../shared/types.js";
import { nonHumanEditors } from "./actors.js";
import { commodoreLanguage } from "./board-commodore.js";
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
import { localized } from "./launch-control.js";
import { findAnyObjective, listedObjectiveSummaries, objectivesApi, post, readBoard, subscribeObjective, subscribeObjectiveOrFinished } from "./objectives-state.js";

type T = Translate<ObjectiveMessageKey>;

/**
 * 목표의 보드 동작 — 사람이 지금 할 일을 고르는 상태 사다리와, 그 결과를 구성원 채팅 입력창(`GroupConversationActions.board`)에
 * 건네는 일. 입력창 위 제안 줄의 칩·입력창 안 동작 칩·＋ 메뉴의 압축 행은 호스트가 그리고, 여기서는 무엇을 언제 어느 서버 경로로
 * 보내는지만 정한다. 후속 후보 고르기는 입력창 바로 위 칸(`renderPanel`)에 이 플러그인이 그린다.
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
  readonly objectiveId: string;
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
  decision: "objectives.decisions.title",
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
};

/** 메시지의 거절은 지휘관이 아니라 받는 이의 사정이다. */
const MESSAGE_REASONS: Readonly<Record<string, ObjectiveMessageKey>> = {
  session_awaiting_input: "objectives.band.reason.recipientAwaiting",
  unknown_member: "objectives.band.reason.recipientGone",
  unknown_objectiveRecord: "objectives.band.reason.recipientGone",
  session_not_found: "objectives.band.reason.recipientGone",
  // 세션 좌표가 남지 않은 휴면 세션 — 이어 붙일 세션이 없어 깨울 수 없다.
  capability_unavailable: "objectives.band.reason.recipientUnreachable",
  resume_unavailable: "objectives.band.reason.recipientUnreachable",
};

const codeOf = (error: unknown): string => (error instanceof Error ? error.message : "unknown");
/** 거절 코드를 띠와 같은 사유 문구로 — 띠 밖의 표면(사령관 대화의 후속 후보 카드)도 같은 말을 쓴다. */
export const bandReason = (t: T, error: unknown): string => reasonText(t, codeOf(error));
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
 * 보관된 Objective 의 describe 요약은 세지 않는다 — 완료로 보관된 지휘관은 없는 것(closed)이다.
 */
interface BoardLive {
  readonly commander: string;
  readonly member: (objectiveId: string) => string;
  readonly launchAvailable: boolean;
}

const shown = (activity: string | undefined): string => (activity === undefined ? "closed" : activity === "background" ? "running" : activity);

function liveOf(objective: Objective): BoardLive {
  const summaries = listedObjectiveSummaries();
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const commander = byId.get(objective.id);
  return {
    commander: shown(commander ? commander.ownActivity ?? commander.activity : undefined),
    member: (objectiveId) => shown(byId.get(objectiveId)?.activity),
    // 보관된 완료 목표는 살아 있는 목록에 없다 — 목록이 아니라 그 Theater 의 기동 가능 여부를 읽는다.
    launchAvailable: readBoard(objective.commodoreId).launchAvailable,
  };
}

/** 살아 있는 목록에서, 없으면 읽어 둔 끝난 목표(보관)에서 — 완료 화면의 범위 넓히기도 같은 레코드로 보낸다. */
const findObjective = (objectiveId: string): Objective | null => findAnyObjective(objectiveId);

function choicesOf(objective: Objective, live: BoardLive) {
  const done = objective.done;
  const working = !done && (live.commander === "running" || objective.members.some((member) => member.sessionName !== null && live.member(member.id) === "running"));
  const commanderAwaiting = !done && live.commander === "awaiting";
  const awaitingMember = done ? undefined : objective.members.find((member) => member.sessionName !== null && live.member(member.id) === "awaiting");
  const mission = awaitingMember ? objective.missions.findIndex((candidate) => !candidate.done && candidate.member === awaitingMember.id) : -1;
  const memberAwaiting: MemberAwaiting | null = awaitingMember ? { objectiveId: awaitingMember.id, role: awaitingMember.role, mission: mission >= 0 ? mission + 1 : null } : null;
  const recipientCount = [live.commander, ...objective.members.filter((member) => member.sessionName !== null).map((member) => live.member(member.id))].filter((state) => state !== "closed").length;
  return { ...bandChoices({ objective, working, commanderAwaiting, memberAwaiting, commanderExists: live.commander !== "closed", recipientCount }), memberAwaiting, working };
}

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
      reveal: { label: localized((t) => t("objectives.composer.reveal")), run: () => openObjectivePopup(objective.id) },
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

const useObjective = (objectiveId: string) => useSyncExternalStore(subscribeObjectiveOrFinished, () => findObjective(objectiveId), () => findObjective(objectiveId));

/** 입력창 바로 위 칸 — 후속 후보 고르기. 띄울 것이 없으면 아무것도 그리지 않는다. */
function BoardPanel({ objectiveId, ctx }: { readonly objectiveId: string; readonly ctx: GroupBoardPanelContext }) {
  const objective = useObjective(objectiveId);
  const followupOpen = useFollowupOpen(objectiveId);
  useSyncExternalStore(subscribeObjective, listedObjectiveSummaries, listedObjectiveSummaries);
  const t = getT(ctx.language, ctx.layout === "mobile");
  if (!objective) return null;
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
        <button type="button" className="objectives-glyph" aria-label={t("objectives.panel.close")} title={t("objectives.panel.close")} onClick={close}><CloseGlyph /></button>
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

const CloseGlyph = () => <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
