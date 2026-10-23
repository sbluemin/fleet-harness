import type { ConversationMemberProfile, GroupBoardActions } from "@fleet-console/sdk/conversation";
import type { LocalizedText } from "@fleet-console/sdk/i18n";
import type { ModelRoster } from "@fleet-console/sdk/models";
import type { ConsoleOperationSummary, OperationCluster, OperationClusterMember, OperationClusterProgress, OperationClusterRow, OperationClusterRowMark, OperationClusterRowNote, OperationClusterRowProvenance, OperationClusterSource } from "@fleet-console/sdk/plugin";

import { inboxReasons, livePersonHold, stalledObjectives, type BoardObservation, type BoardObserver } from "../shared/board-state.js";
import { memberFailureReason } from "../shared/signals.js";
import { latestRecord, missionReady, type Objective } from "../shared/types.js";
import { actorKind, actorName, lastAct } from "./actors.js";
import { objectiveConversation } from "./conversation.js";
import { objectiveConversationActions } from "./conversation-actions.js";
import { openCommodoreConversation, openCommodoreLog } from "./board-commodore.js";
import { freshConversationObjectiveId, openFreshConversation, subscribeFreshConversation } from "./fresh-conversation.js";
import { renderCommodoreRowGlyph, renderCommodoreRowGlyphOff } from "./board-commodore.js";
import { askObjectiveTitle, commodoreBoardOf, commodoreRevision, decisionTurn, livePersonHolds, openAsks, openAskTheaters, personTurnAt, readCommodore, subscribeCommodore } from "./board-commodore.js";
import { openFollowups } from "./followups.js";
import { getT } from "./i18n/index.js";
import { readLaunchRoster, subscribeLaunchRoster } from "./launch-control.js";
import { activeOperationId, viewedTheaterId, findFinishedObjective, finishedObjectivesRevision, focusOperation, isObjectiveSurfaceOpen, listedOperationSummaries, objectivesApi, openObjectiveFromCluster, operationSummaries, post, readAllTheaters, readObjectiveView, readTheater, revealObjective, runtimeHydration, subscribeFinishedObjectivesStore, subscribeObjective, subscribeObjectiveView, upsertObjectiveLocally } from "./objectives-state.js";

/**
 * 목표 → 호스트 묶음 서술자.
 *
 * 목표의 지휘관 Operation 이 뿌리, 구성원 Operation 이 묶음의 구성원이다 — 호스트는 구성원 목록에 든 Operation 을 지휘관
 * 아래로 접는다. 구성원은 여전히 임무 단위다: 구성원 Operation 은 자기 **대표 임무**(아직 끝나지 않은 첫 임무, 모두 끝났으면
 * 마지막 임무) 칸에 한 번만 서고, 같은 구성원의 나머지 임무와 지휘관 직접 임무는 자리표시 칸이다(호스트는 Operation id 로
 * 색인하므로 같은 id 를 두 번 내지 않는다). 임무를 맡지 않은 구성원도 역할 이름 칸으로 서서 따로 떠돌지 않는다.
 * 임무도 떠 있는 구성원도 없는 Operation 은 캡션 띠·노드 줄을 세우지 않는다. 완료된 목표도 묶음으로 남는다.
 *
 * 끝나지 않은 목표는 사이드바 그룹 트리의 한 줄(`row`)로도 선다 — 지휘관·구성원 칩은 그 줄로 접히고,
 * Operation 이 아직 없는 시작 전 목표도 뿌리 없는 줄로 선다. 오늘·기한·검토 대기의 판정은 여기서 하고 호스트는 그리기만 한다.
 * 셸처럼 목표가 아닌 Operation 은 여느 칩 그대로다.
 * 호스트가 useSyncExternalStore 로 읽으므로, 내용이 같으면 같은 배열을 돌려준다.
 */

function progressOf(objective: Objective, missionId: string, operationId: string, activity: Map<string, string>): OperationClusterProgress {
  const mission = objective.missions.find((candidate) => candidate.id === missionId)!;
  if (mission.done) return "done";
  if (!missionReady(objective.missions, mission)) return "blocked";
  return liveProgress(operationId, activity);
}
const liveProgress = (operationId: string, activity: Map<string, string>): OperationClusterProgress => {
  const current = activity.get(operationId);
  if (current === "awaiting") return "awaiting";
  if (current === "running" || current === "background") return "running";
  return "open";
};

/**
 * 구성원의 정체성 톤 — 명단 순번으로 여덟 톤을 돌려 쓴다. 지휘관 캡션의 「› 이름」과 무리 레일 글리프가 같은 구성원에 같은 색을 쓴다.
 */
const MEMBER_TONE_KEYS = ["teal", "amber", "plum", "moss", "cerulean", "rose", "indigo", "crimson"] as const;
const memberToneOf = (objective: Objective, memberId: string): string => MEMBER_TONE_KEYS[Math.max(0, objective.members.findIndex((member) => member.id === memberId)) % MEMBER_TONE_KEYS.length]!;

/** 아직 Operation 이 없는(또는 대표가 아닌) 임무의 자리표시 id — 띠의 사각 하나가 된다. 호스트는 pending 을 보고 행·패널을 세우지 않는다. */
const placeholderId = (missionId: string) => `mission:${missionId}`;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * 후속 목표의 원래 목표 제목 — 읽을 때 지금 목록에서 찾는다. 후속이 아니면 undefined, 원래 목표가 영구 삭제돼 없으면 null.
 * 서버가 실어 보낸 origin.title 은 원래 목표가 사라진 뒤에도 옛 값으로 남아 있을 수 있어 쓰지 않는다.
 */
export function originTitleOf(objective: Objective, byId: ReadonlyMap<string, Objective>): string | null | undefined {
  if (!objective.origin) return undefined;
  return byId.get(objective.origin.objectiveId)?.title ?? null;
}

/**
 * 줄 메모 — 자율 운영 중이면 사람의 손을 기다리던 자리를 사령관이 맡고 있다는 사실, 그리고 정체. 모듈 상수라
 * 줄 서명이 메모의 종류로 비교된다(글은 로케일마다 호스트가 푼다). 사령관이 결정 요청에 답하는 중이라는 사실은 메모가 아니라
 * 줄의 상태 문구(`delegated.status`)가 말한다.
 */
const NOTE_REVIEWING: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.autonomy.note.reviewing"), tone: "accent" };
const NOTE_STALLED: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.autonomy.note.stalled"), tone: "warn" };
/** 사령관이 사람에게 넘긴 항목이 선 줄 — 「내 결정」에 선 까닭(`decisionNote`). 대화 중심 화면에서도 줄의 상태 문구로 보인다. */
const HANDED_NOTE = (locale: "en" | "ko") => getT(locale)("objectives.autonomy.note.handed");
/** 구성원 실패 — 확인하지 않은 실패가 남은 동안만. 자율 운영과 상관없이 사람의 줄에 선다. 사유가 하나로 모이면 그 사유로 말한다. */
const NOTE_MEMBER_FAILED: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.note.memberFailed"), tone: "warn" };
const NOTE_MEMBER_LIMITED: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.note.memberLimited"), tone: "warn" };
const NOTE_MEMBER_RATE_LIMITED: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.note.memberRateLimited"), tone: "warn" };
const NOTE_KEYS = new Map<OperationClusterRowNote, string>([[NOTE_REVIEWING, "reviewing"], [NOTE_STALLED, "stalled"], [NOTE_MEMBER_FAILED, "member-failed"], [NOTE_MEMBER_LIMITED, "member-limited"], [NOTE_MEMBER_RATE_LIMITED, "member-rate-limited"]]);
const FAILURE_NOTE_TEXT = { limit_exhausted: "objectives.note.memberLimited", rate_limited: "objectives.note.memberRateLimited" } as const;
type MemberFailureNoteKey = "objectives.note.memberFailed" | (typeof FAILURE_NOTE_TEXT)[keyof typeof FAILURE_NOTE_TEXT];

/**
 * 목록 줄의 구성원 실패 표식 — 에이전트 inbox 의 `member-failed` 사유와 같은 판정(`inboxReasons`)을 그대로 쓴다. 실패가 풀리거나
 * 확인되면(acknowledged) 사유가 빠지고 표식도 내려간다. 확인하지 않은 실패가 모두 같은 사유(`memberFailureReason`)일 때만 그 사유로
 * 말한다 — 사유가 섞이거나 없는 실패가 하나라도 있으면 한 줄이 다른 실패를 그 사유로 덮지 않게 일반 표식이다. 구성원 행이 각자의 사유를 말한다.
 * 사이드바 줄·전환 목록이 이 하나를 읽는다.
 */
export const memberFailureNote = (objective: Objective): MemberFailureNoteKey | null => {
  if (!inboxReasons(objective).includes("member-failed")) return null;
  const reasons = new Set(objective.members.flatMap((member) => member.failure && !member.failure.acknowledged ? [memberFailureReason(member.failure)] : []));
  const [only] = reasons;
  return reasons.size === 1 && only ? FAILURE_NOTE_TEXT[only] : "objectives.note.memberFailed";
};
/** 사령관이 결정 요청에 답하는 동안 둘째 줄의 상태 문구 자리에 서는 말 — 모듈 상수라 줄 서명이 바뀌지 않는다. */
const STATUS_ANSWERING = (locale: "en" | "ko") => getT(locale)("objectives.autonomy.note.answering");

/**
 * 줄이 읽는 사령관 — `active` 는 자율 운영이 실제로 도는가(메모의 근거), `enabled` 는 실험 기능(꺼지면 사령관 표식이 서지 않는다),
 * `autonomy` 는 스위치(표식의 켬·끔), `peek` 는 사람이 Theater 머리의 사령관 글리프에 머무는 중(표식이 함께 밝아진다).
 */
export interface CommodoreBoard { readonly active: boolean; readonly stalled: readonly string[]; readonly enabled?: boolean; readonly autonomy?: boolean; readonly peek?: boolean }
const NO_COMMODORE: CommodoreBoard = { active: false, stalled: [] };

/** 경과 시간의 칸 — 5분 단위라 정체 점검과 같은 간격(5분)으로 다시 셀 때 「N분 전」이 그 간격보다 낡지 않는다. */
function ageOf(at: number, now: number): { readonly unit: "now" } | { readonly unit: "minutes" | "hours" | "days"; readonly n: number } {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 5) return { unit: "now" };
  if (minutes < 60) return { unit: "minutes", n: Math.floor(minutes / 5) * 5 };
  if (minutes < 24 * 60) return { unit: "hours", n: Math.floor(minutes / 60) };
  return { unit: "days", n: Math.floor(minutes / (24 * 60)) };
}

/**
 * 줄 둘째 줄의 출처 — 사람이 아닌 손이 더한 목표면 그 손(사람은 기본 주인이라 적지 않고, 후속은 `followup` 이 원천을 말한다),
 * 그리고 마지막으로 손댄 이와 그 행위·때. 사령관이 더한 목표는 줄 끝 표식이 사령관 운영으로 서 있는 동안 그 표식이 말하므로 숨기고,
 * 실험 기능이 꺼졌거나 사람이 돌려받았으면 글로 적는다(돌려받은 줄에서 사령관이 만들었다는 단서가 사라지지 않게). 사령관의 손은
 * brass 글자로만 선다.
 */
function provenanceOf(objective: Objective, board: CommodoreBoard, now: number): OperationClusterRowProvenance[] {
  const out: OperationClusterRowProvenance[] = [];
  const added = objective.addedBy;
  if (added && !objective.origin) {
    if (!("kind" in added)) out.push({ text: (locale) => { const t = getT(locale); return t("objectives.prov.addedBy", { who: added.title ?? t("objectives.actor.agent") }); } });
    else if (!board.enabled || objective.operator !== "commodore") out.push({ text: (locale) => getT(locale)("objectives.prov.addedByCommodore"), tone: "accent" });
  }
  const last = lastAct(objective);
  if (last) {
    const age = ageOf(last.at, now);
    out.push({
      text: (locale) => {
        const t = getT(locale);
        return t("objectives.prov.recent", { who: actorName(t, last.by), act: t(`objectives.prov.act.${last.act}`), age: age.unit === "now" ? t("objectives.prov.age.now") : t(`objectives.prov.age.${age.unit}`, { n: age.n }) });
      },
      ...(actorKind(last.by) === "commodore" ? { tone: "accent" as const } : {}),
    });
  }
  return out;
}

/**
 * 줄 끝 사령관 표식 — 그 자체가 맡김 스위치다. 기준은 서버가 판정해 보낸 운영 주체(`operator`) 하나이고(깨움과 같은 값),
 * 누르면 사람 전용 라우트로 맡기거나 돌려받는다. 켠 표식은 사령관 스위치와 같은 글리프로 자율 운영을 따라 켬·끔 잉크가 바뀌고,
 * 꺼진 표식은 외곽선이다. 실험 기능이 꺼져 있으면 서지 않는다.
 */
function commodoreMarkOf(objective: Objective, board: CommodoreBoard): OperationClusterRowMark | undefined {
  if (!board.enabled) return undefined;
  const operated = objective.operator === "commodore";
  const on = board.autonomy === true;
  return {
    square: on ? "filled" : "hollow",
    renderGlyph: operated ? renderCommodoreRowGlyph : renderCommodoreRowGlyphOff,
    ...(board.peek && operated ? { emphasized: true } : {}),
    label: (locale) => getT(locale)(operated ? (on ? "objectives.mark.commodore.onTip" : "objectives.mark.commodore.onTipOff") : "objectives.mark.commodore.offTip"),
    toggle: {
      pressed: operated,
      label: (locale) => getT(locale)("objectives.mark.commodore.toggle", { title: objective.title }),
      onToggle: (language) => setOperator(objective, !operated, language),
    },
  };
}

/** 맡기기·돌려받기 — 사람만 바꾸는 라우트. 결과는 목표 보기 갱신으로 돌아와 표식이 따라 바뀐다. */
function setOperator(objective: Objective, commodore: boolean, language: "en" | "ko"): void {
  const api = objectivesApi();
  if (api) void post(api, "/objective/operator", { objectiveId: objective.id, commodore, language }).catch(() => undefined);
}

/**
 * 구성원 실패와 정체는 자율 운영과 상관없이 사람의 줄에 선다. 자율 운영이 돌면 감독자가 본 정체를 그대로 쓰고(깨움과 같은 값), 꺼져
 * 있으면 보드가 같은 판정(`stalledObjectives`)으로 직접 센 값을 쓴다 — 한 줄에 정체 메모는 언제나 한 출처에서 하나다.
 */
function rowNotes(objective: Objective, board: CommodoreBoard, stalled: boolean): Pick<OperationClusterRow, "notes"> {
  const failureNote = memberFailureNote(objective);
  const failed = failureNote === null ? [] : [failureNote === "objectives.note.memberLimited" ? NOTE_MEMBER_LIMITED : failureNote === "objectives.note.memberRateLimited" ? NOTE_MEMBER_RATE_LIMITED : NOTE_MEMBER_FAILED];
  if (!board.active) return stalled || failed.length ? { notes: [...failed, ...(stalled ? [NOTE_STALLED] : [])] } : {};
  // 답하는 중·검토하는 중은 사령관이 운영하고 사람에게 넘기지 않은 항목에만 — 사람의 목표의 결정·검토로는 사령관이 깨어나지 않는다(서버 판정 `operator`).
  const handles = objective.operator !== "human";
  const notes: OperationClusterRowNote[] = [...failed];
  if (handles && objective.awaitingReview && !livePersonHold(objective, "review")) notes.push(NOTE_REVIEWING);
  if (board.stalled.includes(objective.id)) notes.push(NOTE_STALLED);
  return notes.length ? { notes } : {};
}

/**
 * 결정 구역 — 사람이 답할 차례면 「내 결정」(사람에게 넘긴 기준·검토·후속도 같은 구역). 자율 운영 중 사령관이 맡은 결정 요청은
 * 구역으로 올라가지 않고 제자리에서 상태 문구 「사령관이 답하는 중」으로 말한다. 판정은 `decisionTurn`·`personTurnAt` 하나를
 * 폰·전환 목록·레일과 함께 쓴다.
 */
function decisionZoneOf(objective: Objective, board: CommodoreBoard): Pick<OperationClusterRow, "decisionRequestedAt" | "decisionQuestions" | "decisionNote" | "delegated"> {
  const request = objective.decisionRequest;
  const turn = decisionTurn(objective, board.active);
  const at = personTurnAt(objective, board.active);
  // 사령관이 넘긴 항목은 자율 운영과 상관없이 사람의 차례다 — 줄이 「내 결정」에 선 까닭을 함께 단다.
  const handed = livePersonHolds(objective).length > 0;
  return {
    ...(at !== null ? { decisionRequestedAt: at, ...(turn === "person" && request ? { decisionQuestions: request.questions.length } : {}), ...(handed ? { decisionNote: HANDED_NOTE } : {}) } : {}),
    ...(turn === "commodore" && request ? { delegated: { questions: request.questions.length, status: STATUS_ANSWERING } } : {}),
  };
}

/**
 * 사이드바 줄 — 정리한(removed) 목표만 빼고 선다. 완료는 보관하지 않으므로 완료한 목표도 사람이 보관하기 전까지 「완료」 글리프 줄로
 * 제자리에 남는다(서버가 완료 목표의 이름·그룹 편집을 거절하므로 그 둘은 싣지 않는다). 보관은 아래 archive 규칙 그대로다.
 */
function rowOf(objective: Objective, order: number, fold: readonly string[], hasSession: boolean, selected: boolean, originTitle: string | null | undefined, board: CommodoreBoard = NO_COMMODORE, stalled = false, now = Date.now()): OperationClusterRow | null {
  if (objective.removed) return null;
  const done = !!objective.done;
  const provenance = provenanceOf(objective, board, now);
  const mark = commodoreMarkOf(objective, board);
  const overdue = !!objective.dueDate && objective.dueDate < todayIso();
  const doneMissions = objective.missions.filter((mission) => mission.done).length;
  const review = objective.awaitingReview;
  return {
    groupId: objective.groupId,
    order,
    fold,
    // 「시작 전」은 세션이 없는 목표에만 — Operation 이 서 있으면 개시 전이라도 호스트가 칩과 같은 활동 상태로 그린다.
    ...(done ? { glyph: "done" as const } : review ? { glyph: "review" as const } : !objective.commander.started && !hasSession ? { glyph: "fresh" as const } : {}),
    // 완료한 목표는 「오늘」 구역에 올리지 않는다 — 완료 전 Today·기한 표시는 보관 전까지 줄을 긴급 구역으로 승격시켜 끝난 일을 오늘 일로 보인다.
    ...(done ? {} : { ...(objective.today || overdue ? { today: true } : {}), ...(objective.dueDate ? { due: { date: objective.dueDate, overdue } } : {}) }),
    ...decisionZoneOf(objective, board),
    ...(objective.missions.length ? { progress: { done: doneMissions, total: objective.missions.length } } : {}),
    ...(originTitle !== undefined ? { followup: { originTitle } } : {}),
    ...(provenance.length ? { provenance } : {}),
    ...(mark ? { mark } : {}),
    ...rowNotes(objective, board, stalled),
    ...(selected ? { selected: true } : {}),
    ...(review ? { review: (language: "en" | "ko") => reviewObjective(objective, language) } : {}),
    ...(done ? {} : { moveToGroup: (groupId: string | null) => moveObjective(objective, groupId), rename: (title: string) => renameObjective(objective, title) }),
    // Operation 이 아직 없는 목표도 우클릭 「보관」으로 보관함에 보낸다 — 뿌리가 선 줄은 호스트가 그 Operation 을 보관한다.
    ...(objective.hasOperation ? {} : { archive: () => archiveObjective(objective) }),
  };
}

/**
 * 시작 전 목표의 「보관」 — 지우지 않고(restorable) 휴면 지휘관으로 보관함에 넣는다. 복원하면 휴면 지휘관 줄로 돌아온다. 보관 DTO(archived)는
 * upsert 가 활성 목록에서 거둔다. 목표 머리의 「영구 삭제」(두 번 확정)는 restorable 없이 같은 경로를 쓴다.
 */
function archiveObjective(objective: Objective): void {
  const api = objectivesApi();
  if (!api) return;
  void post<{ objective: Objective; deleted: boolean }>(api, "/objective/archive", { objectiveId: objective.id, restorable: true })
    .then((result) => { if (result?.objective) upsertObjectiveLocally(result.objective); })
    .catch(() => undefined);
}

/** 줄 제목을 고쳤을 때 — 상세 머리의 제목과 같은 `/objective/patch` 경로이며, 비었거나 그대로면 보내지 않는다. */
function renameObjective(objective: Objective, title: string): void {
  const next = title.trim();
  const api = objectivesApi();
  if (api && next && next !== objective.title) void post(api, "/objective/patch", { objectiveId: objective.id, patch: { title: next } }).catch(() => undefined);
}

/** 검토 대기 글리프 — 열린 후속 후보가 있으면 표면에서 고르게 하고, 없으면 바로 완료한다(목록 칸의 고리와 같은 동작). */
function reviewObjective(objective: Objective, language: "en" | "ko"): void {
  if (openFollowups(objective).length > 0) {
    // 후보 칸은 그 목표의 구성원 채팅 입력창 위에 선다 — 가운데 칸이 다른 대화여도 그 지휘관 대화부터 연다.
    if (listedOperationSummaries().some((summary) => summary.id === objective.id)) focusOperation(objective.id);
    revealObjective({ objectiveId: objective.id, followups: true });
    openObjectiveFromCluster(objective.theaterId, objective.id);
    return;
  }
  const api = objectivesApi();
  if (api) void post(api, "/objective/complete", { objectiveId: objective.id, language }).catch(() => undefined);
}

/** 뿌리 없는 줄을 다른 그룹에 놓았을 때 — 뿌리가 있으면 호스트가 지휘관 Operation 의 그룹을 직접 바꾼다. */
function moveObjective(objective: Objective, groupId: string | null): void {
  const api = objectivesApi();
  if (api && groupId !== objective.groupId) void post(api, "/objective/patch", { objectiveId: objective.id, patch: { groupId } }).catch(() => undefined);
}

export function clustersOf(objectives: readonly Objective[], activity: Map<string, string>, selectedOf: (objective: Objective) => boolean = () => false, boardOf: (theaterId: string) => CommodoreBoard = () => NO_COMMODORE, observe: BoardObserver = () => null, now = Date.now(), roster: ModelRoster | null = null): OperationCluster[] {
  const out: OperationCluster[] = [];
  const stalled = new Set(stalledObjectives(objectives, observe, now));
  const orderIn = new Map<string, number>();
  const byId = new Map(objectives.map((objective) => [objective.id, objective]));
  for (const objective of objectives) {
    const commander = objective.id;
    const order = orderIn.get(objective.theaterId) ?? 0;
    orderIn.set(objective.theaterId, order + 1);
    const live = (operationId: string | null | undefined): string | null => (operationId && operationId !== commander && activity.has(operationId) ? operationId : null);
    const liveMembers = objective.members.flatMap((member) => { const operationId = live(member.id); return operationId ? [{ member, operationId }] : []; });
    const fold = [...new Set([...(activity.has(commander) ? [commander] : []), ...liveMembers.map((entry) => entry.operationId), ...objective.missions.flatMap((mission) => { const operationId = live(mission.operationId); return operationId ? [operationId] : []; })])];
    const row = rowOf(objective, order, fold, activity.has(commander), selectedOf(objective), originTitleOf(objective, byId), boardOf(objective.theaterId), stalled.has(objective.id), now);
    // 임무나 떠 있는 구성원이 있는 목표의 지휘관 Operation 이 살아 있으면 묶음이 선다. 결정 요청이 선 목표도 — 목록 밖 표면의 표식이 이 서술자를 탄다.
    const decisionRequest = !!objective.decisionRequest && !objective.done;
    // 목록 밖 표면의 결정 표식(얼굴 「!」·칩·궤도·폰 대화 행)은 사람의 차례인 요청에만 — 사령관이 맡은 요청은 사람을 기다리지 않는다.
    const personDecision = decisionTurn(objective, boardOf(objective.theaterId).active) === "person";
    const openDetail = () => {
      revealObjective({ objectiveId: objective.id });
      openObjectiveFromCluster(objective.theaterId, objective.id);
      // 대화 중심 화면 — 시작 전 목표는 가운데 칸에 시작 화면으로 선다(활성 Operation 이 비고 세 영역이 이 목표를 가리킨다).
      if (row?.glyph === "fresh") openFreshConversation(objective.id);
    };
    const conversation = objectiveConversation(objective, (index) => MEMBER_TONE_KEYS[index % MEMBER_TONE_KEYS.length]!, openDetail, (at) => { openCommodoreConversation(objective.theaterId, { revealAt: at, readOnly: true, objectiveId: objective.id }); }, objectiveConversationActions(objective),
      { state: (operationId) => shownActivity(activity.get(operationId) ?? "closed"), roster }, boardOf(objective.theaterId).active);
    const structured = (objective.missions.length > 0 || liveMembers.length > 0 || decisionRequest) && activity.has(commander);
    if (!structured) {
      // 완료한 목표도 줄이 있다 — 보관하기 전까지 줄에서 대화(지휘관과의 메시지·범위 넓히기)를 다시 연다. 보관된 완료 목표는 아래 doneStandInCluster 가 맡는다.
      if (row) out.push({ id: objective.id, theaterId: objective.theaterId, title: objective.title, ...(activity.has(commander) ? { root: commander } : { avatarOperationId: commander }), members: [], conversation, open: openDetail, row });
      continue;
    }
    // 구성원 Operation → 대표 임무. 끝나지 않은 첫 임무가 이기고, 모두 끝났으면 마지막 임무.
    const representative = new Map<string, string>();
    for (const mission of objective.missions) {
      const operationId = live(mission.operationId);
      if (!operationId) continue;
      const current = representative.get(operationId);
      const currentDone = current ? objective.missions.find((candidate) => candidate.id === current)!.done : true;
      if (!current || currentDone) representative.set(operationId, mission.id);
    }
    const byMission = new Map(objective.missions.map((mission, index) => [mission.id, index + 1]));
    const idOf = (missionId: string): string => {
      const operationId = live(objective.missions.find((mission) => mission.id === missionId)?.operationId);
      return operationId && representative.get(operationId) === missionId ? operationId : placeholderId(missionId);
    };
    const memberOf = (operationId: string) => liveMembers.find((entry) => entry.operationId === operationId)?.member;
    const members: OperationClusterMember[] = objective.missions.map((mission) => {
      const id = idOf(mission.id);
      const pending = id === placeholderId(mission.id);
      const member = pending ? undefined : memberOf(id);
      const memberIndex = member ? objective.members.findIndex((candidate) => candidate.id === member.id) : -1;
      const name = member?.role;
      return {
        operationId: id,
        ...(pending ? { pending: true } : {}),
        // 노드 줄에는 구성원 이름으로 선다 — 「N 노드」가 아니라 「조사」.
        ...(name ? { name } : {}),
        ...(member ? { tone: memberToneOf(objective, member.id) } : {}),
        ...(memberIndex >= 0 ? { order: memberIndex } : {}),
        label: `${byMission.get(mission.id)}. ${mission.text}`,
        missionNumber: byMission.get(mission.id)!,
        after: mission.prerequisites.map(idOf),
        progress: pending ? (mission.done ? "done" : missionReady(objective.missions, mission) ? "open" : "blocked") : progressOf(objective, mission.id, id, activity),
        ...(!pending ? { awaitingInput: activity.get(id) === "awaiting" } : {}),
        // 캡션 피커의 한 줄 — 가장 최근 기록의 결론.
        ...((latest) => (latest ? { result: latest.lines[0] ?? "" } : {}))(latestRecord(mission)),
      };
    });
    // 임무를 맡지 않은 구성원 — 역할 이름 칸으로 묶음에 든다.
    for (const { member, operationId } of liveMembers) {
      if (representative.has(operationId)) continue;
      const memberIndex = objective.members.findIndex((candidate) => candidate.id === member.id);
      members.push({
        operationId,
        label: member.role,
        name: member.role,
        tone: memberToneOf(objective, member.id),
        ...(memberIndex >= 0 ? { order: memberIndex } : {}),
        after: [],
        progress: liveProgress(operationId, activity),
        awaitingInput: activity.get(operationId) === "awaiting",
      });
    }
    const open = (operationId?: string) => {
      const missionId = operationId
        ? operationId.startsWith("mission:") ? operationId.slice("mission:".length) : representative.get(operationId)
        : undefined;
      revealObjective(missionId ? { objectiveId: objective.id, missionId } : { objectiveId: objective.id });
      openObjectiveFromCluster(objective.theaterId, objective.id);
    };
    out.push({ id: objective.id, theaterId: objective.theaterId, title: objective.title, root: commander, members, conversation, open, ...(personDecision ? { decisionRequest: true } : {}), ...(row ? { row } : {}) });
  }
  // 사령관의 질문 — 목표 묶음이 아닌 줄로 「내 결정」에 선다(물은 시각순). 누르면 질문 카드가 선 사령관 기록이 열린다.
  for (const theaterId of openAskTheaters()) {
    const served = readCommodore(theaterId).view?.asks?.objectives;
    const board = readTheater(theaterId);
    for (const ask of openAsks(theaterId)) {
      const objectiveTitle = ask.objectiveId ? askObjectiveTitle(board, served, ask.objectiveId) : null;
      out.push({
        id: `commodore-ask:${ask.id}`, theaterId, title: ask.questions[0]?.text ?? "", members: [], open: () => openCommodoreLog(theaterId),
        row: {
          groupId: null, order: -1, fold: [], commodore: true, decisionRequestedAt: ask.at, decisionQuestions: ask.questions.length,
          decisionNote: (locale) => { const t = getT(locale); return objectiveTitle ? `${t("objectives.ask.title")} · ${objectiveTitle}` : t("objectives.ask.title"); },
        },
      });
    }
  }
  return out;
}

const rowSignature = (row: OperationClusterRow | undefined) => (row ? [row.groupId, row.order, row.fold, row.glyph ?? "", row.today === true, row.due ?? null, row.decisionRequestedAt ?? 0, row.decisionQuestions ?? 0, row.decisionNote ? resolveText(row.decisionNote) : "", row.commodore === true, row.delegated ? row.delegated.questions : null, row.progress ?? null, row.followup ?? null, row.notes?.map((note) => NOTE_KEYS.get(note) ?? "") ?? [], row.selected === true,
  // 출처 글은 영어로 풀어 비교한다 — 손·행위·경과 칸이 바뀌면 글이 바뀐다(로케일 전환은 호스트가 다시 그린다).
  row.provenance?.map((part) => [resolveText(part.text), part.tone ?? ""]) ?? [], row.mark ? [row.mark.square, row.mark.emphasized === true, resolveText(row.mark.label), row.mark.toggle?.pressed ?? null, row.mark.toggle ? resolveText(row.mark.toggle.label) : ""] : null] : null);
/** 화면 활동 — 보드와 같게 턴 뒤 백그라운드 작업은 작업 중으로 접는다. */
const shownActivity = (activity: string): string => (activity === "background" ? "running" : activity);
const resolveText = (text: LocalizedText): string => (typeof text === "string" ? text : text("en"));
// 명부 줄의 글은 함수라 JSON 이 버린다 — 영어로 풀어 비교한다(모델·상태·로스터가 바뀌면 글이 바뀐다).
const profileSignature = (profile: ConversationMemberProfile | undefined) => (profile ? [profile.badge ? resolveText(profile.badge) : "", profile.brief ?? "",
  profile.launch ? [resolveText(profile.launch.label), profile.launch.effort ? resolveText(profile.launch.effort) : "", profile.launch.title ? resolveText(profile.launch.title) : "", profile.launch.provider ?? "", profile.launch.struck === true, profile.launch.badge ? resolveText(profile.launch.badge) : "",
    profile.launch.via ? [resolveText(profile.launch.via.label), profile.launch.via.title ? resolveText(profile.launch.via.title) : "", profile.launch.via.tone ?? ""] : null] : null,
  profile.status ? [resolveText(profile.status.text), profile.status.tone ?? ""] : null,
  profile.notes?.map((note) => [resolveText(note.text), note.title ?? "", note.tone ?? ""]) ?? []] : null);
// 보드 동작의 글도 함수다 — 칩·안내·자리표시를 영어로 풀어 비교한다(상태 사다리가 바뀌면 글이나 칩이 바뀐다).
const boardSignature = (board: GroupBoardActions | undefined) => (board ? [
  board.suggestions.map((action) => [action.id, resolveText(action.label), action.detail ? resolveText(action.detail) : "", action.context ? resolveText(action.context.placeholder) : "", action.unavailable ? resolveText(action.unavailable) : ""]),
  board.note ? [resolveText(board.note.text), board.note.reveal ? resolveText(board.note.reveal.label) : ""] : null, board.hint ? resolveText(board.hint) : "",
  board.commanderOnly === true, board.actionsOnly === true,
] : null);
const signature = (clusters: readonly OperationCluster[]) => JSON.stringify(clusters.map((cluster) => [cluster.id, cluster.root ?? null, cluster.title, cluster.decisionRequest === true, cluster.conversation ?? null, boardSignature(cluster.conversation?.actions?.board), cluster.conversation?.members.map((member) => profileSignature(member.profile)) ?? [], profileSignature(cluster.conversation?.commander), rowSignature(cluster.row), cluster.members.map((member) => [member.operationId, member.pending ?? false, member.name ?? "", member.tone ?? "", member.order ?? -1, member.label, member.missionNumber ?? null, member.after, member.progress, member.awaitingInput ?? null, member.result ?? ""])]));

/**
 * 보드 줄의 관측 — 호스트 런타임 맵에서 온 요약 활동. 휴면(ended)은 수명주기 dormant 로 넘기고, 목록에 없는 Operation 은
 * 보관 describe 요약이 있어도 관측 없음(null)이라 정체로 세지 않는다. 지휘관은 구성원을 끌어올리기 전 자기 활동으로 본다(서버 관측과 같은 축).
 */
const observationOf = (summary: ConsoleOperationSummary): BoardObservation => {
  const activity = summary.ownActivity ?? summary.activity;
  return activity === "ended" ? { lifecycle: "dormant", activity } : { lifecycle: "live", activity };
};
/** 정체의 30분 경계는 보드 사건 없이 지나가므로 시계로 다시 센다 — 감독자의 정체 점검과 같은 5분 간격. */
const STALL_TICK_MS = 5 * 60_000;

let cached: readonly OperationCluster[] = [];
let cachedSignature = "";
/** 마지막 계산의 입력 — 호스트는 렌더마다(끌기·캔버스 이동의 매 프레임) 스냅숏을 읽으므로, 입력이 같으면 다시 셈하지 않는다. */
let cachedInputs: readonly unknown[] = [];

/**
 * 보관된 완료 목표의 대화 서술자 — 줄·뿌리 없이 대화(명부·보드 동작)만 싣는다. 지휘관 Operation 이 보관돼 활동이 없으므로 명부는 모두 닫힌
 * 것으로 센다. 가운데 칸의 완료 화면 입력창이 이 서술자의 보드 동작(지휘관에게만 가는 메시지·범위 넓히기 칩)을 읽는다.
 */
function doneStandInCluster(objective: Objective, roster: ModelRoster | null, boardOf: (theaterId: string) => CommodoreBoard): OperationCluster {
  const open = () => { revealObjective({ objectiveId: objective.id }); openObjectiveFromCluster(objective.theaterId); };
  const conversation = objectiveConversation(objective, (index) => MEMBER_TONE_KEYS[index % MEMBER_TONE_KEYS.length]!, open, (at) => { openCommodoreConversation(objective.theaterId, { revealAt: at, readOnly: true, objectiveId: objective.id }); }, objectiveConversationActions(objective),
    { state: () => "closed", roster }, boardOf(objective.theaterId).active);
  return { id: objective.id, theaterId: objective.theaterId, title: objective.title, avatarOperationId: objective.id, members: [], conversation };
}

export const objectivesClusterSource: OperationClusterSource = {
  subscribe: (listener) => {
    const offObjective = subscribeObjective(listener);
    const offView = subscribeObjectiveView(listener);
    const offCommodore = subscribeCommodore(listener);
    const offFresh = subscribeFreshConversation(listener);
    // 대화 명부의 모델 낱말은 보드와 같은 로스터로 짓는다 — 로스터가 오기 전에는 id 를 다듬은 낱말이 잠깐 선다.
    const offRoster = subscribeLaunchRoster(listener);
    // 가운데 칸의 완료 화면이 보는 보관된 목표 — 끝난 목표를 읽어 오면 그 입력창의 대화를 세운다.
    const offFinished = subscribeFinishedObjectivesStore(listener);
    const stallTick = setInterval(listener, STALL_TICK_MS);
    return () => { offObjective(); offView(); offCommodore(); offFresh(); offRoster(); offFinished(); clearInterval(stallTick); };
  },
  get: () => {
    const summaries = operationSummaries();
    const theaterStates = readAllTheaters();
    // 줄의 선택 표시는 표면이 열려 보고 있는 목표에만 선다 — 표면은 활성 Theater 를 보므로 비활성 Theater 의 줄에는 서지 않는다.
    // Operation 이 활성인 동안은 그 줄(칩)이 하이라이트를 가지므로 표면 선택으로는 서지 않는다 — 사이드바 하이라이트는 언제나 한 줄이다.
    const surfaceOpen = isObjectiveSurfaceOpen() && !activeOperationId();
    const theaterId = viewedTheaterId();
    // 가운데 칸에 시작 전 목표가 서 있으면 그 줄이 하이라이트를 가진다 — 패널을 닫아도 가운데 칸이 가리키는 대상은 그대로다.
    const selected = freshConversationObjectiveId() ?? (surfaceOpen ? readObjectiveView(theaterId).selected : null);
    // 기한 지남은 날짜로, 정체는 시간으로 판정하므로 날·정체 점검 간격이 바뀌면 다시 셈한다.
    const now = Date.now();
    // 런타임 축이 수화되기 전(pending)과 끊긴 동안(degraded)의 요약 활동은 관측이 아니라 폴백(ended·idle)이다 — 「모름」을
    // 휴면·유휴로 접어 정체를 세우지 않도록, 축을 신뢰할 수 있을 때만 보드가 직접 센다. 전이는 호스트 상태 통지로 깨어난다.
    const runtimeReady = runtimeHydration() === "ready";
    const roster = readLaunchRoster();
    const inputs = [summaries, surfaceOpen, theaterId, selected, todayIso(), Math.floor(now / STALL_TICK_MS), runtimeReady, commodoreRevision(), roster, finishedObjectivesRevision(), ...theaterStates];
    if (inputs.length === cachedInputs.length && inputs.every((input, index) => input === cachedInputs[index])) return cached;
    const activity = new Map(summaries.map((summary) => [summary.id, summary.activity]));
    // 보관(describe) 요약은 화면에선 휴면으로 서지만 관측이 아니다 — 서버처럼 관측 없음(null)으로 두어 정체로 세지 않는다.
    const observations = new Map(listedOperationSummaries().map((summary) => [summary.id, observationOf(summary)]));
    const showing = freshConversationObjectiveId();
    const live = theaterStates.flatMap((state) => state.objectives);
    // 보관된 완료 목표는 살아 있는 목록에 없다 — 완료 화면이 보는 동안만 읽어 둔 끝난 목표로 그 입력창의 대화(지휘관과의 메시지·범위 넓히기)를 세운다.
    const archivedShown = showing && !live.some((objective) => objective.id === showing) ? findFinishedObjective(showing) : null;
    const next = [
      ...clustersOf(live, activity, (objective) => objective.theaterId === theaterId && selected === objective.id, commodoreBoardOf, runtimeReady ? (operationId) => observations.get(operationId) ?? null : () => null, now, roster),
      ...(archivedShown?.done ? [doneStandInCluster(archivedShown, roster, commodoreBoardOf)] : []),
    ];
    const nextSignature = signature(next);
    cachedInputs = inputs;
    if (nextSignature === cachedSignature) return cached;
    cached = next;
    cachedSignature = nextSignature;
    return cached;
  },
};
