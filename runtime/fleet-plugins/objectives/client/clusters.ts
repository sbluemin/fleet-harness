import type { ConsoleOperationSummary, OperationCluster, OperationClusterMember, OperationClusterProgress, OperationClusterRow, OperationClusterRowNote, OperationClusterSource } from "@fleet-console/sdk/plugin";

import { stalledObjectives, type BoardObservation, type BoardObserver } from "../server/board-state.js";
import { latestRecord, missionReady, type Objective } from "../server/types.js";
import { commodoreBoardOf, commodoreRevision, subscribeCommodore } from "./commodore-state.js";
import { openFollowups } from "./followups.js";
import { getT } from "./i18n/index.js";
import { activeOperationId, activeTheaterId, isObjectiveSurfaceOpen, listedOperationSummaries, objectivesApi, openObjectiveFromCluster, operationSummaries, post, readAllTheaters, readObjectiveView, revealObjective, runtimeHydration, subscribeObjective, subscribeObjectiveView } from "./objectives-state.js";

/**
 * 목표 → 호스트 묶음 서술자.
 *
 * 목표의 지휘관 Operation 이 뿌리, 구성원 Operation 이 묶음의 구성원이다 — 호스트는 구성원 목록에 든 Operation 을 지휘관
 * 아래로 접는다. 띠는 여전히 임무 단위로 그린다: 구성원 Operation 은 자기 **대표 임무**(아직 끝나지 않은 첫 임무, 모두 끝났으면
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
 * 구성원의 정체성 톤 — 명단 순번으로 여덟 톤을 돌려 쓴다. 목표 표면의 구성원 표식(objectives.css `is-tone-N`)과 같은 순서라,
 * 지휘관 캡션의 「› 이름」이 목표 화면의 그 구성원과 같은 색으로 선다.
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
 * 줄 서명이 메모의 종류로 비교된다(글은 로케일마다 호스트가 푼다).
 */
const NOTE_ANSWERING: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.commodore.note.answering"), tone: "accent" };
const NOTE_REVIEWING: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.commodore.note.reviewing"), tone: "accent" };
const NOTE_STALLED: OperationClusterRowNote = { text: (locale) => getT(locale)("objectives.commodore.note.stalled"), tone: "warn" };
const NOTE_KEYS = new Map<OperationClusterRowNote, string>([[NOTE_ANSWERING, "answering"], [NOTE_REVIEWING, "reviewing"], [NOTE_STALLED, "stalled"]]);
const ZONE_HANDLING = (locale: "en" | "ko") => getT(locale)("objectives.commodore.zone.handling");

export interface CommodoreBoard { readonly active: boolean; readonly stalled: readonly string[] }
const NO_COMMODORE: CommodoreBoard = { active: false, stalled: [] };

/**
 * 정체는 자율 운영과 상관없이 사람의 줄에 선다. 자율 운영이 돌면 감독자가 본 정체를 그대로 쓰고(깨움과 같은 값), 꺼져 있으면
 * 보드가 같은 판정(`stalledObjectives`)으로 직접 센 값을 쓴다 — 한 줄에 정체 메모는 언제나 한 출처에서 하나다.
 */
function commodoreNotes(objective: Objective, board: CommodoreBoard, stalled: boolean): Pick<OperationClusterRow, "notes" | "zoneNote"> {
  if (!board.active) return stalled ? { notes: [NOTE_STALLED] } : {};
  const notes: OperationClusterRowNote[] = [];
  if (objective.decisionRequest) notes.push(NOTE_ANSWERING);
  if (objective.awaitingReview) notes.push(NOTE_REVIEWING);
  if (board.stalled.includes(objective.id)) notes.push(NOTE_STALLED);
  return { ...(notes.length ? { notes } : {}), ...(objective.decisionRequest ? { zoneNote: ZONE_HANDLING } : {}) };
}

/** 사이드바 줄 — 끝나지 않은 목표만. 정리한(removed) 목표와 완료한 목표는 보관함에 선다. */
function rowOf(objective: Objective, order: number, fold: readonly string[], hasSession: boolean, selected: boolean, originTitle: string | null | undefined, board: CommodoreBoard = NO_COMMODORE, stalled = false): OperationClusterRow | null {
  if (objective.removed || objective.done) return null;
  const overdue = !!objective.dueDate && objective.dueDate < todayIso();
  const doneMissions = objective.missions.filter((mission) => mission.done).length;
  const review = objective.awaitingReview;
  return {
    groupId: objective.groupId,
    order,
    fold,
    // 「시작 전」은 세션이 없는 목표에만 — Operation 이 서 있으면 개시 전이라도 호스트가 칩과 같은 활동 상태로 그린다.
    ...(review ? { glyph: "review" as const } : !objective.commander.started && !hasSession ? { glyph: "fresh" as const } : {}),
    ...(objective.today || overdue ? { today: true } : {}),
    ...(objective.dueDate ? { due: { date: objective.dueDate, overdue } } : {}),
    ...(objective.decisionRequest ? { decisionRequestedAt: objective.decisionRequest.createdAt, decisionQuestions: objective.decisionRequest.questions.length } : {}),
    ...(objective.missions.length ? { progress: { done: doneMissions, total: objective.missions.length } } : {}),
    ...(originTitle !== undefined ? { followup: { originTitle } } : {}),
    ...commodoreNotes(objective, board, stalled),
    ...(selected ? { selected: true } : {}),
    ...(review ? { review: (language: "en" | "ko") => reviewObjective(objective, language) } : {}),
    moveToGroup: (groupId: string | null) => moveObjective(objective, groupId),
  };
}

/** 검토 대기 글리프 — 열린 후속 후보가 있으면 표면에서 고르게 하고, 없으면 바로 완료한다(목록 칸의 고리와 같은 동작). */
function reviewObjective(objective: Objective, language: "en" | "ko"): void {
  if (openFollowups(objective).length > 0) {
    revealObjective({ objectiveId: objective.id, followups: true });
    openObjectiveFromCluster(objective.theaterId);
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

export function clustersOf(objectives: readonly Objective[], activity: Map<string, string>, selectedOf: (objective: Objective) => boolean = () => false, boardOf: (theaterId: string) => CommodoreBoard = () => NO_COMMODORE, observe: BoardObserver = () => null, now = Date.now()): OperationCluster[] {
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
    const row = rowOf(objective, order, fold, activity.has(commander), selectedOf(objective), originTitleOf(objective, byId), boardOf(objective.theaterId), stalled.has(objective.id));
    // 임무나 떠 있는 구성원이 있는 목표의 지휘관 Operation 이 살아 있으면 묶음이 선다. 결정 요청이 선 목표도 — 목록 밖 표면의 표식이 이 서술자를 탄다.
    const decisionRequest = !!objective.decisionRequest && !objective.done;
    const structured = (objective.missions.length > 0 || liveMembers.length > 0 || decisionRequest) && activity.has(commander);
    if (!structured) {
      if (row) out.push({ id: objective.id, theaterId: objective.theaterId, title: objective.title, ...(activity.has(commander) ? { root: commander } : {}), members: [], open: () => { revealObjective({ objectiveId: objective.id }); openObjectiveFromCluster(objective.theaterId); }, row });
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
      openObjectiveFromCluster(objective.theaterId);
    };
    out.push({ id: objective.id, theaterId: objective.theaterId, title: objective.title, root: commander, members, open, ...(decisionRequest ? { decisionRequest: true } : {}), ...(row ? { row } : {}) });
  }
  return out;
}

const rowSignature = (row: OperationClusterRow | undefined) => (row ? [row.groupId, row.order, row.fold, row.glyph ?? "", row.today === true, row.due ?? null, row.decisionRequestedAt ?? 0, row.decisionQuestions ?? 0, row.progress ?? null, row.followup ?? null, row.notes?.map((note) => NOTE_KEYS.get(note) ?? "") ?? [], row.zoneNote ? "zone" : "", row.selected === true] : null);
const signature = (clusters: readonly OperationCluster[]) => JSON.stringify(clusters.map((cluster) => [cluster.id, cluster.root ?? null, cluster.title, cluster.decisionRequest === true, rowSignature(cluster.row), cluster.members.map((member) => [member.operationId, member.pending ?? false, member.name ?? "", member.tone ?? "", member.order ?? -1, member.label, member.missionNumber ?? null, member.after, member.progress, member.awaitingInput ?? null, member.result ?? ""])]));

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

export const objectivesClusterSource: OperationClusterSource = {
  subscribe: (listener) => {
    const offObjective = subscribeObjective(listener);
    const offView = subscribeObjectiveView(listener);
    const offCommodore = subscribeCommodore(listener);
    const stallTick = setInterval(listener, STALL_TICK_MS);
    return () => { offObjective(); offView(); offCommodore(); clearInterval(stallTick); };
  },
  get: () => {
    const summaries = operationSummaries();
    const theaterStates = readAllTheaters();
    // 줄의 선택 표시는 표면이 열려 보고 있는 목표에만 선다 — 표면은 활성 Theater 를 보므로 비활성 Theater 의 줄에는 서지 않는다.
    // Operation 이 활성인 동안은 그 줄(칩)이 하이라이트를 가지므로 표면 선택으로는 서지 않는다 — 사이드바 하이라이트는 언제나 한 줄이다.
    const surfaceOpen = isObjectiveSurfaceOpen() && !activeOperationId();
    const theaterId = activeTheaterId();
    const selected = surfaceOpen ? readObjectiveView(theaterId).selected : null;
    // 기한 지남은 날짜로, 정체는 시간으로 판정하므로 날·정체 점검 간격이 바뀌면 다시 셈한다.
    const now = Date.now();
    // 런타임 축이 수화되기 전(pending)과 끊긴 동안(degraded)의 요약 활동은 관측이 아니라 폴백(ended·idle)이다 — 「모름」을
    // 휴면·유휴로 접어 정체를 세우지 않도록, 축을 신뢰할 수 있을 때만 보드가 직접 센다. 전이는 호스트 상태 통지로 깨어난다.
    const runtimeReady = runtimeHydration() === "ready";
    const inputs = [summaries, surfaceOpen, theaterId, selected, todayIso(), Math.floor(now / STALL_TICK_MS), runtimeReady, commodoreRevision(), ...theaterStates];
    if (inputs.length === cachedInputs.length && inputs.every((input, index) => input === cachedInputs[index])) return cached;
    const activity = new Map(summaries.map((summary) => [summary.id, summary.activity]));
    // 보관(describe) 요약은 화면에선 휴면으로 서지만 관측이 아니다 — 서버처럼 관측 없음(null)으로 두어 정체로 세지 않는다.
    const observations = new Map(listedOperationSummaries().map((summary) => [summary.id, observationOf(summary)]));
    const next = clustersOf(theaterStates.flatMap((state) => state.objectives), activity, (objective) => objective.theaterId === theaterId && selected === objective.id, commodoreBoardOf, runtimeReady ? (operationId) => observations.get(operationId) ?? null : () => null, now);
    const nextSignature = signature(next);
    cachedInputs = inputs;
    if (nextSignature === cachedSignature) return cached;
    cached = next;
    cachedSignature = nextSignature;
    return cached;
  },
};
