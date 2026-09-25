import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readOperationLaunch, type OperationNode } from "@fleet-console/sdk/operations";

import { ATTACHMENT_TYPES, MAX_ATTACHMENTS } from "./attachments.js";
import {
  MAX_CRITERIA,
  MAX_CRITERION_TEXT,
  MAX_FOLLOWUPS,
  MAX_FOLLOWUP_BATCHES,
  MAX_FOLLOWUP_DISCARDED,
  MAX_RECORDS,
  MAX_MISSIONS,
  awaitingReview,
  evidenceView,
  followupSettled,
  graphOf,
  hasCycle,
  lineupOrder,
  withoutMet,
  type CriterionProposalInput,
  type ObjectiveCriterionProposal,
  type ObjectiveAttachment,
  type ObjectiveEditKind,
  type Objective,
  type ObjectiveEvent,
  OBJECTIVE_FILE,
  type MemberLaunch,
  type StoredMember,
  type PlanInput,
  type MissionAddInput,
  type MissionPatchInput,
  type StoredEdge,
  type StoredObjective,
  type StoredRecord,
  type StoredMission,
  type FollowupBodyInput,
  type FollowupHistory,
  type FollowupItemState,
  type FollowupReviseInput,
  type StoredFollowup,
  type StoredFollowupBatch,
  type StoredFollowupItem,
  type StoredOrigin,
} from "./types.js";

/**
 * 목표 저장소 — Theater 의 목표 폴더(`workspaces/<프로젝트>/objectives`) 안에 목표마다 디렉터리 하나.
 *
 * ```
 * <objectiveId>/objective.json                        레코드 하나(보드 자리 rank 를 포함한다)
 * <objectiveId>/attachments/<attachmentId>.<확장자>     그 목표에 붙인 이미지
 * ```
 *
 * 디렉터리 이름과 레코드의 키는 지휘관 Operation id 다. 제목·그룹·Theater·만든 시각·세션 이름·모델은 Operation 이 들고
 * 있으므로 여기에 두지 않고, 화면 모양(`Objective`)은 읽을 때마다 Operation 과 합쳐 만든다. Operation 이 없으면(삭제
 * 유예 중) 목표도 보이지 않는다 — 디렉터리는 Operation 이 복원 불가로 확정될 때(`forget`) 통째로 지워진다.
 *
 * 목록은 폴더를 한 번 읽어 캐시에 올리고, Console 이 이 저장소의 유일한 쓰는 쪽이라 파일 잠금도 감시도 두지 않는다.
 * 모든 변경은 한 곳(`commit`)을 지나 **그 목표의 파일 한 건**에 tmp→rename 으로 쓰이고, 쓰기가 성공한 뒤에야 캐시가
 * 갈리고 마지막에 사건으로 방송된다 — 쓰기가 실패하면 캐시와 디스크가 함께 이전 상태로 남는다.
 */

export class ObjectiveStoreError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "ObjectiveStoreError";
  }
}

export interface ObjectiveStoreOptions {
  /** Theater 의 목표 디렉터리 — `workspaces/<프로젝트>/objectives`. Theater 경로를 모르면 null. */
  readonly dirOf: (theaterId: string) => string | null;
  readonly operations: { get(id: string): OperationNode | null; list(): readonly OperationNode[] };
  readonly emit: (event: ObjectiveEvent) => void;
  readonly now?: () => number;
}

/** 새 목표의 목표 고유값 — Operation 은 부르는 쪽이 먼저 만든다. */
export interface ObjectiveInit {
  readonly note?: string;
  readonly important?: boolean;
  readonly dueDate?: string | null;
  readonly today?: boolean;
  readonly missions?: readonly { readonly text: string; readonly prerequisites?: readonly number[] }[];
  /** Console Use 가 함께 받은 달성 기준 문장 — 저장될 때 기본 요구사항으로 by "human" 이 된다. */
  readonly criteria?: readonly string[];
  readonly addedBy?: string;
  /** 후속으로 태어난 목표 — 원본 목표·후보·배치와 근거. */
  readonly origin?: StoredOrigin;
}

/**
 * 새 목표의 초기 달성 기준 — 다듬은 문장. 한 건이라도 맞지 않으면 던진다. 키 붙은 생성은 Operation 을 띄우기 **전에** 이 검사를
 * 먼저 거친다(띄운 뒤 거절되면 그 키의 Operation 을 지울 수 없다 — 지우면 키가 삭제로 종결된다).
 */
export function checkedCriteria(init: Pick<ObjectiveInit, "criteria">): readonly string[] {
  const criteriaTexts = (init.criteria ?? []).map((entry) => entry.trim());
  if (criteriaTexts.length > MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
  if (criteriaTexts.some((entry) => entry.length === 0 || entry.length > MAX_CRITERION_TEXT)) throw new ObjectiveStoreError("invalid_criteria");
  return criteriaTexts;
}

/** 완료와 함께 고른 후보 — 화면이 본 rev 와, 고른 순간 동결할 기동 조건. */
export interface FollowupSelection {
  readonly batchId: string;
  readonly followups: readonly { readonly id: string; readonly rev: number }[];
  readonly launch: StoredFollowupBatch["launch"];
}

export interface ObjectivePatch {
  readonly note?: string;
  readonly planRequest?: string;
  readonly important?: boolean;
  readonly dueDate?: string | null;
  readonly today?: boolean;
}

export interface ObjectiveStore {
  list(theaterId: string): readonly Objective[];
  /** 알려진 모든 Theater 의 목표. */
  all(): readonly Objective[];
  find(objectiveId: string): Objective | null;
  /** 지휘관의 담당 Operation 들 — 지휘관 Operation 이 이미 사라진 뒤에도 레코드에서 찾는다. */
  membersOf(commanderId: string): readonly string[];
  /** 이 Operation 이 맡은 목표와 구성원. */
  findMember(operationId: string): { readonly objective: Objective; readonly memberId: string; readonly missionId: string | null } | null;
  /** 지휘관 Operation 을 이미 만든 뒤 — 그 Operation 의 목표 고유값을 채운다(저장된 자리의 맨 아래). */
  adopt(operationId: string, init: ObjectiveInit): Objective;
  patch(objectiveId: string, input: ObjectivePatch): Objective;
  /** Operation 쪽 값(제목·그룹·모델)이 바뀌었다 — 저장은 그대로, 합친 화면 모양만 다시 방송한다. */
  refresh(operationId: string): void;
  /** 지휘관 Operation 이 복원 불가로 사라졌다 — 레코드와 첨부를 지운다. 담당이었다면 그 임무의 연결을 푼다. */
  forget(operationId: string): void;
  /** 순서만 바꾼다 — 같은 Theater 의 다른 항목 앞(before) 또는 뒤(after)로. */
  move(objectiveId: string, anchor: { readonly beforeId: string } | { readonly afterId: string }): Objective;
  complete(objectiveId: string): Objective;
  reopen(objectiveId: string): Objective;
  /** `unplaced` — 사람이 선행 없이 더한 임무는 미분류로 들어간다(지휘관이 자리를 잡는다). */
  missionAdd(objectiveId: string, input: MissionAddInput, options?: { readonly unplaced?: boolean; readonly by?: "human" }): Objective;
  missionPatch(objectiveId: string, missionId: string, input: MissionPatchInput, options?: { readonly by?: "human" }): Objective;
  /** 지휘관의 완료 — 완료로 두고 기록 한 건을 더한다. */
  missionDone(objectiveId: string, missionId: string, lines: readonly string[]): Objective;
  /** 사람이 이 임무의 기록을 모두 읽었다. 이미 읽었으면 쓰지 않는다. */
  missionSeen(objectiveId: string, missionId: string): Objective;
  missionRemove(objectiveId: string, missionId: string): Objective;
  memberAdd(objectiveId: string, input: { readonly role: string; readonly brief?: string; readonly launch?: MemberLaunch; readonly subagents?: boolean }, by: "human" | "commander"): Objective;
  memberPatch(objectiveId: string, memberId: string, patch: { readonly role?: string; readonly brief?: string | null; readonly launch?: MemberLaunch | null; readonly subagents?: boolean }): Objective;
  memberRemove(objectiveId: string, memberId: string): { readonly objective: Objective; readonly removed: StoredMember; readonly missionIds: readonly string[] };
  setMemberOperation(objectiveId: string, memberId: string, operationId: string | null): Objective;
  /** 간선 토글 — `from` 이 `to` 의 선행. 있으면 끊고 없으면 잇는다. */
  edgeToggle(objectiveId: string, from: string, to: string, why?: string): { readonly objective: Objective; readonly linked: boolean };
  edgesLinear(objectiveId: string): Objective;
  edgesClear(objectiveId: string): Objective;
  plan(objectiveId: string, input: PlanInput): Objective;
  setPlanning(objectiveId: string, planning: boolean): Objective;
  setCriteriaOpen(objectiveId: string, open: boolean): Objective;
  /** 새 작업(스티어링)이 생겼다 — 앞선 충족 판단을 모두 거둔다. */
  clearMet(objectiveId: string): Objective;
  criterionAdd(objectiveId: string, text: string, by: "human" | "commander"): Objective;
  criterionPatch(objectiveId: string, criterionId: string, text: string): Objective;
  criterionRemove(objectiveId: string, criterionId: string): Objective;
  /** 지휘관이 기준 하나를 충족(근거와 함께) 또는 미충족으로 표시한다. */
  criterionMet(objectiveId: string, criterionId: string, evidence: string | null): Objective;
  proposalApprove(objectiveId: string, proposalId: string): Objective;
  proposalsApproveAll(objectiveId: string): Objective;
  proposalReject(objectiveId: string, proposalId: string): Objective;
  proposalAnnotate(objectiveId: string, proposalId: string, annotation: string): Objective;
  /** 사람의 편집을 쌓는다 · null 이면 지운다. 바뀐 것이 없으면 쓰지 않는다. */
  setEdited(objectiveId: string, kinds: readonly ObjectiveEditKind[] | null): Objective;
  attachmentAdd(objectiveId: string, input: { readonly name: string; readonly type: ObjectiveAttachment["type"]; readonly data: Buffer; readonly width?: number; readonly height?: number }): { readonly objective: Objective; readonly attachment: ObjectiveAttachment };
  attachmentRemove(objectiveId: string, attachmentId: string): Objective;
  /** 첨부 파일의 절대 경로 — 서버 안(파일 서빙·지휘관의 도구 응답)에서만 쓴다. */
  attachmentPath(objective: Objective, attachment: ObjectiveAttachment): string;
  /** 후속 후보 — 지휘관만 쓴다. 활성(open·selected) 은 목표당 상한까지. 끝난 목표에는 쓰지 않는다. */
  followupAdd(objectiveId: string, body: FollowupBodyInput): Objective;
  /** open 후보만 고친다 — rev 가 오른다. */
  followupRevise(objectiveId: string, candidateId: string, patch: FollowupReviseInput): Objective;
  /** 지휘관이 자기 open 후보를 거둔다 — 흔적 없이 빠진다. */
  followupWithdraw(objectiveId: string, candidateId: string): Objective;
  /** 사람이 open 후보를 버린다 — 제목·요약과 시각만 흔적으로 남는다(멱등). */
  followupDiscard(objectiveId: string, candidateId: string): Objective;
  /**
   * 고른 후보와 함께 완료한다 — 검토 대기·편집·기준 제안·rev 를 검사하고, `reserve` 로 기동 키 용량을 먼저 확보한 뒤 완료·배치
   * 기록·후보 잠금을 한 번에 쓴다. 이미 같은 배치로 완료됐다면 쓰지 않고 그대로 돌려준다(`fresh: false`).
   */
  completeWithFollowups(objectiveId: string, selection: FollowupSelection, reserve: (candidateIds: readonly string[]) => void): { readonly objective: Objective; readonly fresh: boolean };
  /** 배치 항목의 생성 결과를 기록한다. 끝난 항목(created·deleted)은 후보 목록에서 빠지고 배치에만 남는다. */
  followupSettle(objectiveId: string, batchId: string, candidateId: string, next: { readonly state: FollowupItemState; readonly operationId?: string; readonly error?: string; readonly attempted?: boolean }): Objective;
  /** failed·confirming 항목을 다시 creating 으로 — 같은 스냅샷·같은 키로 다시 확인하거나 만든다. */
  followupRetry(objectiveId: string, batchId: string, candidateId: string): Objective;
  /** failed 항목을 포기한다 — 후보는 같은 rev 의 open 으로 돌아간다. */
  followupAbandon(objectiveId: string, batchId: string, candidateId: string): Objective;
  /** 저장된 배치 그대로 — 동결된 기동 조건과 스냅샷 원형. 원본이 보이지 않으면 null. */
  followupBatch(objectiveId: string, batchId: string): StoredFollowupBatch | null;
  /** 이 Operation 에 목표 레코드가 이미 있는가 — 키 붙은 생성의 재시도가 입양을 되풀이하지 않게 한다. */
  recorded(operationId: string): boolean;
}

const MAX_SEGMENT = 200;
const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/** 새 자리를 벌릴 때 쓰는 걸음 — 보드 끝에 붙이거나 저장 목표를 새로 만들 때 이만큼 띄운다. */
const RANK_STEP = 1024;
/**
 * id 의 안정 해시 소수부 — 같은 밀리초에 태어난 목표들이 같은 가상 자리에 겹치지 않게 1/1024 칸으로 흩는다.
 * 1/1024 은 지금 시각(약 1.79e12 ms)에서 4 ulp 라 인접한 칸 사이에도 중간값이 남는다. 2^42 ms(약 2109년)부터는 1 ulp 로
 * 좁아지고 2^43 부터는 소수부가 사라져 다시 겹치며, 해시는 1024 칸이라 같은 밀리초의 두 목표가 겹칠 수도 있다 —
 * 그 경우의 자리는 `respread` 의 구간 확장이 만든다.
 */
const idFraction = (id: string): number => {
  let hash = 0x811c9dc5;
  for (let ix = 0; ix < id.length; ix += 1) hash = Math.imul(hash ^ id.charCodeAt(ix), 0x01000193) >>> 0;
  return (hash % RANK_STEP) / RANK_STEP;
};
/**
 * 레코드 없는 목표의 가상 자리 — 만든 시각의 음수다(같은 밀리초는 위 `idFraction` 이 가른다). 새로 만든 Operation 이
 * 위에 서고, 저장 목표는 양수 밴드에서 태어나므로(아래 `bottomRank`) 아무도 옮기지 않은 보드는 「레코드 없는 목표가
 * 위」다. 옮기고 나면 둘의 구분은 없다.
 */
const virtualRank = (node: Pick<OperationNode, "id" | "ts">): number => -(node.ts.createdAt + idFraction(node.id));

/** 따로 만든 Operation 처럼 아직 목표 고유값이 없는 목표 — 저장하지 않고, 첫 편집 때 지금 자리를 그대로 받아 레코드가 된다. */
const bareRecord = (operationId: string): StoredObjective => ({ operationId, rank: 0, note: "", missions: [] });
/** 목표가 되는 Operation — Console 이 띄우는 에이전트 세션(플러그인 소유 Operation 은 아니다). */
export const isObjectiveOperation = (node: Pick<OperationNode, "type" | "pluginId">): boolean => node.type === "agent" && node.pluginId === null;

/** 파일 이름 한 칸 — `safeSegment` 는 `.`·`..` 를 그대로 두므로 이것만으로 담김이 보장되지 않는다. 여기서 먼저 막는다. */
function dirSegment(id: string): string {
  const segment = safeSegment(id);
  if (!segment || segment === "." || segment === ".." || segment.length > MAX_SEGMENT) throw new ObjectiveStoreError("unsafe_path");
  return segment;
}

/** 이미 있는 가장 가까운 조상까지 심볼릭 링크를 풀어 실경로를 만든다 — 아직 없는 경로도 「만들 자리」를 검사할 수 있다. */
function realOf(target: string): string {
  const rest: string[] = [];
  let at = path.resolve(target);
  for (;;) {
    try { return path.join(fs.realpathSync(at), ...[...rest].reverse()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(at);
    if (parent === at) return path.resolve(target);
    rest.push(path.basename(at));
    at = parent;
  }
}

/** 실경로 담김 — `root` 안에 있고 `root` 자신은 아니다. */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 목표 디렉터리 안의 파일 한 자리 — 이름 한 칸을 붙이고, 해석한 실경로가 그 디렉터리 안인지 확인한다. 자리 자신이
 * 심볼릭 링크로 밖을 가리키면 읽지도 쓰지도 않는다(디렉터리만 검사하면 그 안의 파일 링크로 밖이 열린다).
 */
function containedFile(dir: string, name: string): string {
  const file = path.join(dir, name);
  if (!inside(realOf(dir), realOf(file))) throw new ObjectiveStoreError("unsafe_path");
  return file;
}

/** 깨진 파일은 덮어쓰지 않고 비켜 둔다 — 그 목표만 빈 목표가 되고 다른 목표는 그대로다. */
function quarantine(file: string): void {
  try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* 이미 없으면 그만 */ }
}

/** 목표 파일 하나 — 없으면 null, 깨졌거나 디렉터리 이름과 어긋나면 비켜 두고 null. 읽기 자체가 실패하면 전파한다. */
function readObjective(dir: string, segment: string): StoredObjective | null {
  const file = path.join(dir, OBJECTIVE_FILE);
  // 밖을 가리키는 자리는 따라가지 않는다 — 링크 자신을 비켜 두어 그 목표만 빈 목표가 된다.
  if (!inside(realOf(dir), realOf(file))) { quarantine(file); return null; }
  let raw: string;
  // 없는 파일만 「레코드 없음」이다. 권한·입출력 오류를 빈 목표로 읽으면 다음 편집이 남아 있는 파일을 덮어쓴다.
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredObjective>;
    // 디렉터리 이름이 곧 그 목표의 id 다 — 어긋난 파일은 이 목표의 상태가 아니다.
    if (parsed && typeof parsed === "object" && typeof parsed.operationId === "string" && safeSegment(parsed.operationId) === segment) {
      return { ...parsed, operationId: parsed.operationId, rank: Number.isFinite(parsed.rank) ? parsed.rank! : 0, note: typeof parsed.note === "string" ? parsed.note : "", missions: Array.isArray(parsed.missions) ? parsed.missions : [] };
    }
  } catch { /* 깨진 파일 */ }
  quarantine(file);
  return null;
}

/**
 * tmp→rename 으로 한 자리를 바꾼다 — tmp 는 매번 새 이름으로 배타 생성(`O_EXCL`)해 이미 있는 자리를, 특히 밖을 가리키는
 * 심볼릭 링크를 따라가며 쓰지 않는다. rename 은 목표 자리의 링크를 따라가지 않고 그 자리 자신을 갈아 끼운다.
 */
function writeFileExclusive(file: string, data: Buffer): void {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 이미 없으면 그만 */ }
    throw error;
  }
}

function writeObjectiveAtomic(dir: string, objective: StoredObjective): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileExclusive(containedFile(dir, OBJECTIVE_FILE), Buffer.from(`${JSON.stringify(compact(objective), null, 2)}\n`, "utf8"));
}

/** 기본값·빈 값은 쓰지 않는다 — 저장 모양에는 뜻이 있는 값만 남는다. */
function compact(objective: StoredObjective): StoredObjective {
  const out: Record<string, unknown> = { ...objective };
  for (const key of ["note", "planRequest", "dueDate", "addedBy", "followupHistory", "origin"] as const) if (!out[key]) delete out[key];
  if (!objective.followups?.length) delete out.followups;
  if (!objective.followupBatches?.length) delete out.followupBatches;
  for (const key of ["planning", "criteriaOpen", "important", "today"] as const) if (out[key] !== true) delete out[key];
  if (!(objective.attachments?.length)) delete out.attachments;
  if (!(objective.criteria?.length)) delete out.criteria;
  if (!(objective.criteriaProposals?.length)) delete out.criteriaProposals;
  if (!objective.members?.length) delete out.members;
  else out.members = objective.members.map((member) => ({ ...member, ...(member.brief ? {} : { brief: undefined }), ...(member.launch ? {} : { launch: undefined }), ...(member.operationId ? {} : { operationId: undefined }), ...(member.subagents === true ? {} : { subagents: undefined }) }));
  if (!objective.edited) delete out.edited;
  if (!objective.done) delete out.done;
  out.missions = objective.missions.map((mission) => {
    const next: Record<string, unknown> = { ...mission };
    if (mission.done !== true) delete next.done;
    if (!mission.member) delete next.member;
    if (!mission.records?.length) { delete next.records; delete next.seen; }
    else if (!mission.seen) delete next.seen;
    next.prerequisites = mission.prerequisites.map((edge) => (edge.why ? edge : { id: edge.id }));
    return next;
  });
  if (objective.missions.length === 0) delete out.missions;
  return out as unknown as StoredObjective;
}

export function createObjectiveStore(options: ObjectiveStoreOptions): ObjectiveStore {
  const now = options.now ?? (() => Date.now());
  /** Theater 마다 목표 id → 레코드. 폴더를 처음 볼 때 한 번 읽어 올리고, 그 뒤로는 이 캐시가 저장소의 모양이다. */
  const cache = new Map<string, Map<string, StoredObjective>>();

  const dirFor = (theaterId: string): string => {
    const dir = options.dirOf(theaterId);
    if (!dir) throw new ObjectiveStoreError("unknown_theater");
    return dir;
  };
  /**
   * 이 목표의 디렉터리 — 어휘 검사를 지난 한 칸을 목표 폴더에 붙이고, 해석한 실경로가 그 폴더 안인지까지 확인한다
   * (심볼릭 링크로 밖을 가리키는 자리를 쓰지 않는다).
   */
  const objectiveDir = (theaterId: string, objectiveId: string): string => {
    const root = dirFor(theaterId);
    const dir = path.resolve(root, dirSegment(objectiveId));
    if (path.dirname(dir) !== path.resolve(root) || !inside(realOf(root), realOf(dir))) throw new ObjectiveStoreError("unsafe_path");
    return dir;
  };
  const readAll = (dir: string): Map<string, StoredObjective> => {
    const objectives = new Map<string, StoredObjective>();
    let entries: fs.Dirent[];
    // 아직 없는 폴더만 빈 보드다 — 권한·입출력 오류를 빈 보드로 캐시하면 그 뒤의 편집이 남아 있는 파일을 덮어쓴다.
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return objectives; throw error; }
    for (const entry of entries) {
      // 목표는 디렉터리다 — 파일과 (밖을 가리킬 수 있는) 심볼릭 링크는 목표가 아니다.
      if (!entry.isDirectory()) continue;
      const stored = readObjective(path.join(dir, entry.name), entry.name);
      if (stored) objectives.set(stored.operationId, stored);
    }
    return objectives;
  };
  const load = (theaterId: string): Map<string, StoredObjective> => {
    let objectives = cache.get(theaterId);
    if (!objectives) {
      const dir = options.dirOf(theaterId);
      // 폴더를 풀 수 없는 Theater 는 빈 보드로 보이되 캐시하지 않는다 — 빈 목록을 붙들어 두면 폴더가 돌아온 뒤에도
      // 저장된 목표가 보이지 않는다. 쓰기는 dirFor 가 unknown_theater 로 막는다.
      if (!dir) return new Map();
      objectives = readAll(dir);
      cache.set(theaterId, objectives);
    }
    return objectives;
  };
  /**
   * 새 저장 목표의 자리 — 저장된 자리 가운데 가장 아래에서 한 걸음 더, 그리고 언제나 양수다. 레코드 없는 목표의 가상
   * 자리는 음수이므로 아무도 옮기지 않은 보드에서는 저장 목표가 그 아래에 모인다.
   */
  const bottomRank = (theaterId: string): number => {
    let bottom = 0;
    for (const entry of load(theaterId).values()) if (entry.rank > bottom) bottom = entry.rank;
    return bottom + RANK_STEP;
  };
  const theaterIds = (): readonly string[] => [...new Set([...options.operations.list().map((node) => node.theaterId), ...cache.keys()])];
  /** 첨부 한 자리 — 목표 디렉터리 안인지까지 확인한다(`attachments` 나 그 안의 파일이 링크로 밖을 가리키면 거절). */
  const fileOf = (theaterId: string, objectiveId: string, attachment: Pick<ObjectiveAttachment, "id" | "type">) =>
    containedFile(objectiveDir(theaterId, objectiveId), path.join("attachments", `${dirSegment(attachment.id)}.${ATTACHMENT_TYPES[attachment.type]}`));

  /** 화면 모양 — 저장 레코드와 지휘관 Operation 을 합친다. 담당 세션 이름은 담당 Operation 에서. */
  const project = (stored: StoredObjective, node: OperationNode): Objective => {
    const launch = readOperationLaunch(node.payload);
    const addedBy = stored.addedBy ? { operationId: stored.addedBy, title: options.operations.get(stored.addedBy)?.title ?? null } : null;
    const members = (stored.members ?? []).map((member) => {
      const memberNode = member.operationId ? options.operations.get(member.operationId) : null;
      const preset = memberNode ? readOperationLaunch(memberNode.payload) : null;
      return { ...member, subagents: member.subagents === true, launch: member.launch ?? { mode: "route" as const }, sessionName: preset?.sessionName ?? null, ...(preset?.model ? { model: preset.model } : {}), ...(preset?.effort ? { effort: preset.effort } : {}) };
    });
    const byMember = new Map(members.map((member) => [member.id, member]));
    return {
      id: stored.operationId,
      theaterId: node.theaterId,
      groupId: node.groupId ?? null,
      title: node.title,
      createdAt: node.ts.createdAt,
      commander: { sessionName: launch.sessionName, viewMode: launch.viewMode ?? "terminal", ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}), started: launch.started },
      note: stored.note,
      attachments: stored.attachments ?? [],
      ...(stored.planRequest ? { planRequest: stored.planRequest } : {}),
      planning: stored.planning === true,
      criteriaOpen: stored.criteriaOpen === true,
      ...(stored.edited ? { edited: stored.edited } : {}),
      important: stored.important === true,
      dueDate: stored.dueDate ?? null,
      today: stored.today === true,
      addedBy,
      done: stored.done ?? null,
      awaitingReview: awaitingReview(stored),
      criteria: (stored.criteria ?? []).map((criterion) => ({ ...criterion })),
      criteriaProposals: (stored.criteriaProposals ?? []).map((proposal) => ({ ...proposal })),
      members,
      followups: (stored.followups ?? []).map((candidate) => ({
        id: candidate.id, rev: candidate.rev, state: candidate.state, title: candidate.title, summary: candidate.summary,
        brief: candidate.brief, criteria: [...candidate.criteria], evidence: candidate.evidence.map(evidenceView),
        at: candidate.at, updatedAt: candidate.updatedAt, batchId: candidate.batchId ?? null,
        discarded: candidate.state === "discarded" ? { at: candidate.discardedAt ?? candidate.updatedAt, by: "human" as const } : null,
      })),
      followupBatches: (stored.followupBatches ?? []).map((batch) => ({
        id: batch.id, at: batch.at,
        items: batch.items.map((entry) => ({
          candidateId: entry.candidateId, rev: entry.rev,
          snapshot: { title: entry.snapshot.title, summary: entry.snapshot.summary, brief: entry.snapshot.brief, criteria: [...entry.snapshot.criteria], evidence: entry.snapshot.evidence.map(evidenceView) },
          // 만든 뒤 사람이 지운 후속은 보기 시점에 「삭제됨」 — 저장은 created 그대로라 복원하면 돌아오고 누계·멱등성은 그대로다.
          state: entry.state === "created" && entry.operationId && !options.operations.get(entry.operationId) ? "deleted" as const : entry.state, operationId: entry.operationId ?? null, error: entry.error ?? null, attempts: entry.attempts, settledAt: entry.settledAt ?? null,
        })),
      })),
      followupHistory: stored.followupHistory ?? null,
      origin: stored.origin ? { objectiveId: stored.origin.objectiveId, title: options.operations.get(stored.origin.objectiveId)?.title ?? null, candidateId: stored.origin.candidateId, evidence: stored.origin.evidence.map(evidenceView) } : null,
      missions: stored.missions.map((mission) => {
        const member = mission.member ? byMember.get(mission.member) : null;
        return {
          id: mission.id,
          text: mission.text,
          done: mission.done === true,
          prerequisites: mission.prerequisites.map((edge) => edge.id),
          why: Object.fromEntries(mission.prerequisites.flatMap((edge) => (edge.why ? [[edge.id, edge.why]] : []))),
          member: member?.id ?? null,
          ...(mission.memberBy ? { memberBy: mission.memberBy } : {}),
          ...(mission.unplaced ? { unplaced: true as const } : {}),
          operationId: member?.operationId ?? null,
          sessionName: member?.sessionName ?? null,
          ...(member?.launch.mode === "model" && member.model ? { model: member.model } : {}),
          ...(member?.launch.mode === "model" && member.effort ? { effort: member.effort } : {}),
          records: (mission.records ?? []).map((record, index) => ({ ...record, kind: index === 0 ? "done" as const : "redone" as const })),
          seen: mission.seen ?? 0,
        };
      }),
    };
  };
  /** 담당 Operation — 목표가 아니라 목표의 임무를 맡은 세션이다. */
  const memberIds = (objectives: Iterable<StoredObjective>): ReadonlySet<string> => new Set([...objectives].flatMap((entry) => (entry.members ?? []).flatMap((member) => (member.operationId ? [member.operationId] : []))));
  /** 목표가 되는 Operation 인가 — 이 Theater 의 에이전트 Operation 이고 다른 목표의 담당이 아니다. */
  const objectiveNode = (theaterId: string, operationId: string): OperationNode | null => {
    const node = options.operations.get(operationId);
    if (!node || node.theaterId !== theaterId || !isObjectiveOperation(node)) return null;
    return memberIds(load(theaterId).values()).has(operationId) ? null : node;
  };
  /** 지휘관 Operation 이 이 Theater 에 살아 있을 때만 화면에 선다. */
  const view = (theaterId: string, stored: StoredObjective): Objective | null => {
    const node = objectiveNode(theaterId, stored.operationId);
    return node ? project(stored, node) : null;
  };
  /**
   * 보드 순서 — 레코드가 있든 없든 한 줄이다. 자리는 rank(레코드 없는 목표는 가상 자리) 오름차순, 동률은 만든 시각,
   * 그다음 id 로 가른다. 지휘관 Operation 이 없는 레코드(삭제 유예 중)는 보이지 않는다.
   */
  type BoardEntry = { readonly stored: StoredObjective; readonly node: OperationNode; readonly bare: boolean; readonly rank: number };
  const visible = (theaterId: string): readonly BoardEntry[] => {
    const objectives = load(theaterId);
    const members = memberIds(objectives.values());
    return options.operations.list()
      .filter((node) => node.theaterId === theaterId && isObjectiveOperation(node) && !members.has(node.id))
      .map((node) => {
        const stored = objectives.get(node.id);
        return { stored: stored ?? bareRecord(node.id), node, bare: !stored, rank: stored ? stored.rank : virtualRank(node) };
      })
      .sort((a, b) => a.rank - b.rank || a.node.ts.createdAt - b.node.ts.createdAt || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  };
  /** 방송에 싣는 보드 줄 — 화면이 서버의 순서를 그대로 따를 수 있게 보이는 목표 전부를 싣는다. */
  const boardOrder = (theaterId: string): readonly string[] => visible(theaterId).map((entry) => entry.node.id);

  /** 목표 하나 — 레코드가 없으면(따로 만든 Operation) 빈 목표이고 `recorded` 는 false 다. */
  const locate = (objectiveId: string): { theaterId: string; recorded: boolean; stored: StoredObjective; node: OperationNode } => {
    const found = options.operations.get(objectiveId);
    const node = found ? objectiveNode(found.theaterId, objectiveId) : null;
    if (!node) throw new ObjectiveStoreError("unknown_objective");
    const stored = load(node.theaterId).get(objectiveId);
    return { theaterId: node.theaterId, recorded: !!stored, stored: stored ?? bareRecord(objectiveId), node };
  };

  /** 자리가 바뀐 뒤의 방송 — 지금 캐시가 말하는 줄을 그대로 실어 화면이 서버와 같은 순서를 본다. */
  const announce = (theaterId: string, stored: StoredObjective): Objective | null => {
    const objective = view(theaterId, stored);
    if (objective) options.emit({ op: "upsert", theaterId, objectiveId: objective.id, objective, order: boardOrder(theaterId) });
    return objective;
  };

  /** 쓰기 한 곳 — 그 목표의 파일 한 건이 성공한 뒤에 캐시를 갈고, 마지막에 방송한다. */
  const commit = (theaterId: string, changed: StoredObjective, reordered = false): Objective | null => {
    writeObjectiveAtomic(objectiveDir(theaterId, changed.operationId), changed);
    load(theaterId).set(changed.operationId, changed);
    if (reordered) return announce(theaterId, changed);
    const objective = view(theaterId, changed);
    if (objective) options.emit({ op: "upsert", theaterId, objectiveId: objective.id, objective });
    return objective;
  };

  const update = (objectiveId: string, mutate: (stored: StoredObjective) => StoredObjective): Objective => {
    const { theaterId, recorded, stored, node } = locate(objectiveId);
    const mutated = mutate(stored);
    if (mutated === stored) return project(stored, node);
    if (mutated.missions.length > MAX_MISSIONS) throw new ObjectiveStoreError("too_many_missions");
    if (hasCycle(graphOf(mutated.missions))) throw new ObjectiveStoreError("dependency_cycle");
    // 선행이 바뀌면 임무도 편성 순으로 다시 선다 — 목록·번호·지휘관 도구의 n 이 편성과 같은 순서를 말한다.
    const missions = lineupOrder(mutated.missions);
    const ordered = missions === mutated.missions ? mutated : { ...mutated, missions: [...missions] };
    // 따로 만든 Operation 의 첫 편집 — 여기서 레코드가 된다. 지금 서 있는 가상 자리를 그대로 굳혀 자리가 흔들리지 않게
    // 하고, 그래도 화면이 서버와 어긋나지 않도록 보드 줄을 함께 방송한다.
    const next = recorded ? ordered : { ...ordered, rank: virtualRank(node) };
    return commit(theaterId, next, !recorded) ?? project(next, node);
  };

  const missionOf = (stored: StoredObjective, missionId: string): { at: number; mission: StoredMission } => {
    const at = stored.missions.findIndex((mission) => mission.id === missionId);
    if (at < 0) throw new ObjectiveStoreError("unknown_mission");
    return { at, mission: stored.missions[at]! };
  };
  const replaceMission = (stored: StoredObjective, at: number, mission: StoredMission): StoredObjective => {
    const missions = [...stored.missions];
    missions[at] = mission;
    return { ...stored, missions };
  };
  /** 자리가 정해졌다 — 미분류 표시를 뗀다. */
  const placed = (mission: StoredMission): StoredMission => (mission.unplaced ? (({ unplaced: _unplaced, ...rest }) => rest)(mission) : mission);
  const withoutEdge = (mission: StoredMission, id: string): StoredMission => ({ ...mission, prerequisites: mission.prerequisites.filter((edge) => edge.id !== id) });
  const proposalsOf = (stored: StoredObjective, input: readonly CriterionProposalInput[]): readonly ObjectiveCriterionProposal[] => {
    const criteria = stored.criteria ?? [];
    const added = input.filter((proposal) => "text" in proposal && !("revise" in proposal)).length;
    if (criteria.length + added > MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
    const targets = new Set<string>();
    return input.map((proposal): ObjectiveCriterionProposal => {
      const id = randomUUID();
      if (!("revise" in proposal) && !("retire" in proposal)) return { id, kind: "add", text: proposal.text };
      const reference = "revise" in proposal ? proposal.revise : proposal.retire;
      const target = typeof reference === "number" ? criteria[reference - 1] : criteria.find((criterion) => criterion.id === reference);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      if (targets.has(target.id)) throw new ObjectiveStoreError("duplicate_criterion_proposal");
      targets.add(target.id);
      return "revise" in proposal
        ? { id, kind: "revise", target: target.id, text: proposal.text }
        : { id, kind: "retire", target: target.id, reason: proposal.reason };
    });
  };
  const approve = (stored: StoredObjective, proposal: ObjectiveCriterionProposal): StoredObjective => {
    const criteria = stored.criteria ?? [];
    if (proposal.kind === "add") {
      if (criteria.length >= MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
      return { ...stored, criteria: [...criteria, { id: randomUUID(), text: proposal.text!, by: "commander" }] };
    }
    if (!criteria.some((criterion) => criterion.id === proposal.target)) throw new ObjectiveStoreError("unknown_criterion");
    return { ...stored, criteria: proposal.kind === "retire"
      ? criteria.filter((criterion) => criterion.id !== proposal.target)
      : criteria.map((criterion) => criterion.id === proposal.target ? { id: criterion.id, text: proposal.text!, by: criterion.by } : criterion) };
  };

  const store: ObjectiveStore = {
    list: (theaterId) => visible(theaterId).map(({ stored, node }) => project(stored, node)),
    all: () => theaterIds().flatMap((theaterId) => store.list(theaterId)),
    find: (objectiveId) => { try { const { stored, node } = locate(objectiveId); return project(stored, node); } catch { return null; } },
    membersOf(commanderId) {
      for (const theaterId of theaterIds()) {
        const stored = load(theaterId).get(commanderId);
        if (stored) return (stored.members ?? []).flatMap((member) => (member.operationId ? [member.operationId] : []));
      }
      return [];
    },
    findMember(operationId) {
      for (const objective of store.all()) {
        const member = objective.members.find((candidate) => candidate.operationId === operationId);
        if (member) return { objective, memberId: member.id, missionId: objective.missions.find((mission) => mission.member === member.id)?.id ?? null };
      }
      return null;
    },

    adopt(operationId, init) {
      const node = options.operations.get(operationId);
      if (!node || !isObjectiveOperation(node)) throw new ObjectiveStoreError("unknown_operation");
      if (load(node.theaterId).has(operationId)) throw new ObjectiveStoreError("already_objective");
      const missionIds = (init.missions ?? []).map(() => randomUUID());
      const missions: StoredMission[] = (init.missions ?? []).map((mission, ix) => ({
        id: missionIds[ix]!,
        text: mission.text,
        // 선행은 1-based 임무 번호 — 자기 앞에 선 임무만 가리킬 수 있다.
        prerequisites: (mission.prerequisites ?? []).filter((n) => n >= 1 && n <= ix).map((n) => ({ id: missionIds[n - 1]! })),
      }));
      // 함께 받은 달성 기준은 같은 저장에 기본 요구사항(by "human")으로 남는다 — 한 건이라도 맞지 않으면 목표 자체를 세우지 않는다.
      const criteriaTexts = checkedCriteria(init);
      const stored: StoredObjective = {
        operationId,
        // 새 목표는 저장된 자리의 맨 아래(양수 밴드)에 선다 — 레코드 없는 목표들 밑이다.
        rank: bottomRank(node.theaterId),
        note: init.note ?? "",
        ...(init.important ? { important: true as const } : {}),
        ...(init.dueDate ? { dueDate: init.dueDate } : {}),
        ...(init.today ? { today: true as const } : {}),
        ...(init.addedBy ? { addedBy: init.addedBy } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
        ...(criteriaTexts.length ? { criteria: criteriaTexts.map((text) => ({ id: randomUUID(), text, by: "human" as const })) } : {}),
        missions: [...lineupOrder(missions)],
      };
      return commit(node.theaterId, stored, true) ?? project(stored, node);
    },

    patch: (objectiveId, input) => update(objectiveId, (stored) => ({
      ...stored,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.planRequest !== undefined ? { planRequest: input.planRequest } : {}),
      ...(input.important !== undefined ? { important: input.important ? true as const : undefined } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? undefined } : {}),
      ...(input.today !== undefined ? { today: input.today ? true as const : undefined } : {}),
    })),

    refresh(operationId) {
      const node = options.operations.get(operationId);
      if (!node) return;
      if (objectiveNode(node.theaterId, operationId)) {
        const stored = load(node.theaterId).get(operationId) ?? bareRecord(operationId);
        options.emit({ op: "upsert", theaterId: node.theaterId, objectiveId: operationId, objective: project(stored, node) });
        return;
      }
      // 담당 Operation 이 바뀌었다(세션 이름 등) — 그 임무가 있는 목표를 다시 방송한다.
      for (const owner of load(node.theaterId).values()) {
        if (!(owner.members ?? []).some((member) => member.operationId === operationId)) continue;
        const objective = view(node.theaterId, owner);
        if (objective) options.emit({ op: "upsert", theaterId: node.theaterId, objectiveId: objective.id, objective });
      }
    },

    forget(operationId) {
      for (const theaterId of theaterIds()) {
        const objectives = load(theaterId);
        if (objectives.has(operationId)) {
          // 복원 불가로 확정됐다 — 그 목표의 디렉터리가 통째로 사라진다(붙인 이미지도 함께). 지운 뒤에야 캐시를 갈고
          // 방송한다. 없는 디렉터리는 `force` 가 넘기고, 그 밖의 삭제 실패는 전파한다 — 지우지 못한 목표를 지운 척하면
          // 다음 기동이 남은 파일을 되살린다.
          fs.rmSync(objectiveDir(theaterId, operationId), { recursive: true, force: true });
          objectives.delete(operationId);
          options.emit({ op: "remove", theaterId, objectiveId: operationId });
        }
        // 담당이었다면 그 연결만 푼다 — 맡긴 목표의 파일 한 건씩만 다시 쓴다.
        for (const owner of [...objectives.values()]) {
          if (!(owner.members ?? []).some((member) => member.operationId === operationId)) continue;
          commit(theaterId, { ...owner, members: owner.members?.map((member) => (member.operationId === operationId ? { ...member, operationId: undefined } : member)) });
        }
      }
    },

    move(objectiveId, anchor) {
      const { theaterId, stored, node } = locate(objectiveId);
      const anchorId = "beforeId" in anchor ? anchor.beforeId : anchor.afterId;
      if (anchorId === objectiveId) return project(stored, node);
      const board = visible(theaterId).filter((entry) => entry.node.id !== objectiveId);
      const target = board.findIndex((entry) => entry.node.id === anchorId);
      if (target < 0) throw new ObjectiveStoreError("unknown_objective");
      const at = "beforeId" in anchor ? target : target + 1;
      // 자리는 보이는 줄에서 정한다 — 이웃이 레코드든 아니든 그 둘의 자리 사이 값을 받으므로 떨어뜨린 자리가 그대로 남고,
      // 파일을 얻는 목표는 옮긴 이 하나뿐이다(이웃이 레코드 없는 목표여도 파일을 만들지 않는다).
      const previous = board[at - 1] ?? null;
      const following = board[at] ?? null;
      const rank = previous && following ? (previous.rank + following.rank) / 2
        : previous ? previous.rank + RANK_STEP
        : following ? following.rank - RANK_STEP
        : 0;
      const moved: StoredObjective = { ...stored, rank };
      // 이웃 사이에 실수가 남지 않았다 — 그때만 이 자리를 감싼 「레코드 없는 목표」 경계 안의 저장 목표들을 다시 벌린다.
      if (!Number.isFinite(rank) || (previous && previous.rank >= rank) || (following && rank >= following.rank)) {
        return respread(theaterId, board, at, moved, node);
      }
      return commit(theaterId, moved, true) ?? project(moved, node);
    },

    // 완료는 상태이지 연결 해제가 아니다 — 담당 연결은 그대로 남아 묶음·이동이 살아 있다.
    complete: (objectiveId) => update(objectiveId, (stored) => {
      if (stored.done) return stored;
      // 남은 후보가 있으면 고르지 않은 완료도 후보 검토의 경계를 지난다 — 후보가 없는 목표의 완료는 지금 그대로다.
      if ((stored.followups ?? []).some((candidate) => candidate.state === "open")) assertReviewable(stored);
      return { ...stored, done: { at: now() }, planning: undefined, criteriaOpen: undefined };
    }),
    reopen: (objectiveId) => update(objectiveId, (stored) => (stored.done ? { ...stored, done: undefined } : stored)),

    missionAdd: (objectiveId, input, addOptions) => update(objectiveId, (stored) => {
      const known = new Set(stored.missions.map((mission) => mission.id));
      const prerequisites = (input.prerequisites ?? []).filter((id) => known.has(id)).map((id): StoredEdge => ({ id }));
      // 선행을 함께 준 추가는 이미 자리가 있다 — 미분류는 선행 없이 더한 사람의 임무뿐이다.
      const unplaced = addOptions?.unplaced === true && input.prerequisites === undefined;
      if (input.member && !(stored.members ?? []).some((member) => member.id === input.member)) throw new ObjectiveStoreError("unknown_member");
      const mission: StoredMission = { id: randomUUID(), text: input.text, prerequisites, ...(input.member ? { member: input.member } : {}), ...(addOptions?.by === "human" && input.member !== undefined ? { memberBy: "human" as const } : {}), ...(unplaced ? { unplaced: true as const } : {}) };
      // 새 일이 생겼다 — 앞선 충족 판단은 옛 보드에 대한 것이다.
      return withoutMet({ ...stored, missions: [...stored.missions, mission] });
    }),

    missionPatch: (objectiveId, missionId, input, patchOptions) => update(objectiveId, (stored) => {
      const { at, mission } = missionOf(stored, missionId);
      const known = new Set(stored.missions.map((candidate) => candidate.id));
      const why = (id: string) => input.why?.[id] ?? mission.prerequisites.find((edge) => edge.id === id)?.why;
      // 선행을 정하면(빈 배열도) 자리가 정해진 것이다.
      const base = input.prerequisites !== undefined ? placed(mission) : mission;
      const prerequisites = input.prerequisites !== undefined
        ? input.prerequisites.filter((id) => known.has(id) && id !== missionId).map((id) => ({ id, ...(why(id) ? { why: why(id)! } : {}) }))
        : input.why ? mission.prerequisites.map((edge) => ({ id: edge.id, ...(why(edge.id) ? { why: why(edge.id)! } : {}) })) : mission.prerequisites;
      if (input.member && !(stored.members ?? []).some((member) => member.id === input.member)) throw new ObjectiveStoreError("unknown_member");
      const next: StoredMission = {
        ...base,
        prerequisites,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.done !== undefined ? { done: input.done ? true as const : undefined } : {}),
        ...(input.member !== undefined ? { member: input.member ?? undefined, memberBy: patchOptions?.by === "human" ? "human" as const : undefined } : {}),
      };
      const replaced = replaceMission(stored, at, next);
      // 끝난 임무를 되돌리면 새 일이다 — 충족 판단을 거둔다.
      return input.done === false && mission.done ? withoutMet(replaced) : replaced;
    }),

    missionDone: (objectiveId, missionId, lines) => update(objectiveId, (stored) => {
      const { at, mission } = missionOf(stored, missionId);
      const records = mission.records ?? [];
      const record: StoredRecord = { id: randomUUID(), at: now(), lines: [...lines] };
      const kept = [...records, record].slice(-MAX_RECORDS);
      // 밀려난 기록만큼 읽은 수도 줄인다 — 남은 기록 중 안 읽은 것이 그대로 안 읽은 것으로 남는다.
      const seen = Math.max(0, Math.min(mission.seen ?? 0, records.length) - (records.length + 1 - kept.length));
      return replaceMission(stored, at, { ...mission, done: true, records: kept, seen });
    }),

    missionSeen: (objectiveId, missionId) => update(objectiveId, (stored) => {
      const { at, mission } = missionOf(stored, missionId);
      const count = mission.records?.length ?? 0;
      return (mission.seen ?? 0) === count ? stored : replaceMission(stored, at, { ...mission, seen: count });
    }),

    missionRemove: (objectiveId, missionId) => update(objectiveId, (stored) => {
      missionOf(stored, missionId);
      return { ...stored, missions: stored.missions.filter((mission) => mission.id !== missionId).map((mission) => withoutEdge(mission, missionId)) };
    }),

    memberAdd: (objectiveId, input, by) => update(objectiveId, (stored) => {
      if ((stored.members?.length ?? 0) >= MAX_MISSIONS) throw new ObjectiveStoreError("too_many_members");
      return { ...stored, members: [...(stored.members ?? []), { id: randomUUID(), role: input.role.trim(), ...(input.brief ? { brief: input.brief } : {}), ...(input.launch ? { launch: input.launch } : {}), ...(input.subagents === true ? { subagents: true as const } : {}), by }] };
    }),
    memberPatch: (objectiveId, memberId, patch) => update(objectiveId, (stored) => {
      if (!(stored.members ?? []).some((member) => member.id === memberId)) throw new ObjectiveStoreError("unknown_member");
      return { ...stored, members: stored.members!.map((member) => member.id === memberId ? {
        ...member, ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief || undefined } : {}),
        ...(patch.launch !== undefined ? { launch: patch.launch ?? undefined } : {}),
        ...(patch.subagents !== undefined ? { subagents: patch.subagents ? true as const : undefined } : {}),
      } : member) };
    }),
    memberRemove(objectiveId, memberId) {
      const found = locate(objectiveId).stored;
      const removed = (found.members ?? []).find((member) => member.id === memberId);
      if (!removed) throw new ObjectiveStoreError("unknown_member");
      const missionIds = found.missions.filter((mission) => mission.member === memberId).map((mission) => mission.id);
      const objective = update(objectiveId, (stored) => ({ ...stored, members: stored.members?.filter((member) => member.id !== memberId), missions: stored.missions.map((mission) => mission.member === memberId ? { ...mission, member: undefined, memberBy: undefined } : mission) }));
      return { objective, removed, missionIds };
    },
    setMemberOperation: (objectiveId, memberId, operationId) => update(objectiveId, (stored) => {
      if (!(stored.members ?? []).some((member) => member.id === memberId)) throw new ObjectiveStoreError("unknown_member");
      return { ...stored, members: stored.members!.map((member) => member.id === memberId ? { ...member, operationId: operationId ?? undefined } : member) };
    }),

    edgeToggle(objectiveId, from, to, why) {
      let linked = false;
      const objective = update(objectiveId, (stored) => {
        missionOf(stored, from);
        const { at, mission } = missionOf(stored, to);
        // 사람이 간선을 직접 이으면 양 끝 모두 자리가 정해진 것으로 본다 — 끊는 것은 자리를 되돌리지 않는다.
        if (mission.prerequisites.some((edge) => edge.id === from)) { linked = false; return replaceMission(stored, at, withoutEdge(mission, from)); }
        linked = true;
        const fromAt = stored.missions.findIndex((candidate) => candidate.id === from);
        const withFrom = replaceMission(stored, fromAt, placed(stored.missions[fromAt]!));
        return replaceMission(withFrom, at, { ...placed(mission), prerequisites: [...mission.prerequisites, { id: from, why: why ?? "human" }] });
      });
      return { objective, linked };
    },

    edgesLinear: (objectiveId) => update(objectiveId, (stored) => ({
      ...stored,
      missions: stored.missions.map((mission, ix) => ({ ...placed(mission), prerequisites: ix === 0 ? [] : [{ id: stored.missions[ix - 1]!.id, why: "human" }] })),
    })),

    edgesClear: (objectiveId) => update(objectiveId, (stored) => ({ ...stored, missions: stored.missions.map((mission) => ({ ...placed(mission), prerequisites: [] })) })),

    plan: (objectiveId, input) => update(objectiveId, (stored) => {
      if (input.criteria !== undefined && !stored.criteriaOpen) throw new ObjectiveStoreError("criteria_not_planning");
      // 검증과 편성 변경은 한 번의 update 안에서 끝난다 — 실패하면 기준 제안도 임무도 바뀌지 않는다.
      const proposals = input.criteria === undefined ? stored.criteriaProposals : proposalsOf(stored, input.criteria);
      if (input.members !== undefined && stored.members?.length) throw new ObjectiveStoreError("members_exist");
      const members = input.members?.length ? input.members.map((member): StoredMember => ({ id: randomUUID(), role: member.role, ...(member.brief ? { brief: member.brief } : {}), by: "commander" })) : stored.members ?? [];
      const resolve = (reference: string | undefined): string | undefined => {
        if (!reference) return undefined;
        const member = members.find((entry) => entry.id === reference || entry.role === reference);
        if (!member) throw new ObjectiveStoreError("unknown_member");
        return member.id;
      };
      // 구성원 기동은 임무 수행의 증거가 아니다. 완료·미분류·기록이 있는 임무만 보존한다.
      const kept = stored.missions.filter((mission) => mission.done || mission.unplaced || !!mission.records?.length || mission.memberBy === "human");
      const keptIds = new Set(kept.map((mission) => mission.id));
      const freshIds = input.missions.map(() => randomUUID());
      const fresh: StoredMission[] = input.missions.map((mission, ix) => {
        const prerequisites: StoredEdge[] = [];
        for (const edge of mission.prerequisites ?? []) {
          // missionId 는 유지되는 기존 임무, n 은 이 계획 안의 1-based 임무 번호.
          const at = edge.n === undefined ? undefined : edge.n - 1;
          const targetId = edge.missionId && keptIds.has(edge.missionId) ? edge.missionId : at !== undefined && at !== ix ? freshIds[at] : undefined;
          if (!targetId || prerequisites.some((entry) => entry.id === targetId)) continue;
          prerequisites.push({ id: targetId, ...(edge.why ? { why: edge.why } : {}) });
        }
        const member = resolve(mission.member);
        return { id: freshIds[ix]!, text: mission.text, prerequisites, ...(member ? { member } : {}) };
      });
      return withoutMet({ ...stored, members, criteriaProposals: proposals, missions: [...kept.map((mission) => ({ ...mission, prerequisites: mission.prerequisites.filter((edge) => keptIds.has(edge.id)) })), ...fresh] });
    }),

    setPlanning: (objectiveId, planning) => update(objectiveId, (stored) => (!!stored.planning === planning ? stored : { ...stored, planning: planning ? true as const : undefined })),
    setCriteriaOpen: (objectiveId, open) => update(objectiveId, (stored) => (!!stored.criteriaOpen === open ? stored : { ...stored, criteriaOpen: open ? true as const : undefined })),
    clearMet: (objectiveId) => update(objectiveId, (stored) => withoutMet(stored)),

    setEdited(objectiveId, kinds) {
      return update(objectiveId, (stored) => {
        if (kinds === null) return stored.edited ? { ...stored, edited: undefined } : stored;
        if (kinds.length === 0) return stored;
        const merged = [...new Set([...(stored.edited?.kinds ?? []), ...kinds])];
        if (stored.edited && merged.length === stored.edited.kinds.length) return stored;
        return { ...stored, edited: { at: now(), kinds: merged } };
      });
    },

    criterionAdd: (objectiveId, text, by) => update(objectiveId, (stored) => {
      const criteria = stored.criteria ?? [];
      if (criteria.length >= MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
      return { ...stored, criteria: [...criteria, { id: randomUUID(), text: text.trim(), by }] };
    }),
    criterionPatch: (objectiveId, criterionId, text) => update(objectiveId, (stored) => {
      const criteria = stored.criteria ?? [];
      const target = criteria.find((entry) => entry.id === criterionId);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      if (target.text === text.trim()) return stored;
      // 문구가 바뀐 기준의 충족 근거는 옛 문구에 대한 것이다 — 그 기준만 미충족으로 돌린다.
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: text.trim(), by: entry.by } : entry)) };
    }),
    criterionRemove: (objectiveId, criterionId) => update(objectiveId, (stored) => {
      const criteria = stored.criteria ?? [];
      if (!criteria.some((entry) => entry.id === criterionId)) throw new ObjectiveStoreError("unknown_criterion");
      return { ...stored, criteria: criteria.filter((entry) => entry.id !== criterionId), criteriaProposals: stored.criteriaProposals?.filter((proposal) => proposal.target !== criterionId) };
    }),
    criterionMet: (objectiveId, criterionId, evidence) => update(objectiveId, (stored) => {
      if (stored.criteriaProposals?.length) throw new ObjectiveStoreError("criteria_pending");
      const criteria = stored.criteria ?? [];
      const target = criteria.find((entry) => entry.id === criterionId);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      const met = evidence?.trim() || undefined;
      if (target.met === met) return stored;
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: entry.text, by: entry.by, ...(met ? { met } : {}) } : entry)) };
    }),
    proposalApprove: (objectiveId, proposalId) => update(objectiveId, (stored) => {
      const proposal = stored.criteriaProposals?.find((entry) => entry.id === proposalId);
      if (!proposal) throw new ObjectiveStoreError("unknown_proposal");
      const next = approve(stored, proposal);
      return { ...next, criteriaProposals: stored.criteriaProposals?.filter((entry) => entry.id !== proposalId) };
    }),
    proposalsApproveAll: (objectiveId) => update(objectiveId, (stored) => {
      if (!stored.criteriaProposals?.length) return stored;
      const next = stored.criteriaProposals.reduce(approve, stored);
      return { ...next, criteriaProposals: undefined };
    }),
    proposalReject: (objectiveId, proposalId) => update(objectiveId, (stored) => {
      if (!stored.criteriaProposals?.some((entry) => entry.id === proposalId)) throw new ObjectiveStoreError("unknown_proposal");
      return { ...stored, criteriaProposals: stored.criteriaProposals.filter((entry) => entry.id !== proposalId) };
    }),
    proposalAnnotate: (objectiveId, proposalId, annotation) => update(objectiveId, (stored) => {
      if (!stored.criteriaProposals?.some((entry) => entry.id === proposalId)) throw new ObjectiveStoreError("unknown_proposal");
      if (annotation.length > 300) throw new ObjectiveStoreError("annotation_too_long");
      return { ...stored, criteriaProposals: stored.criteriaProposals.map((entry) => entry.id === proposalId ? { ...entry, annotation: annotation.trim() || undefined } : entry) };
    }),

    attachmentAdd(objectiveId, input) {
      const { theaterId, stored } = locate(objectiveId);
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const existing = stored.attachments ?? [];
      if (existing.length >= MAX_ATTACHMENTS) throw new ObjectiveStoreError("too_many_attachments");
      const attachment: ObjectiveAttachment = {
        id: randomUUID(),
        n: existing.reduce((top, entry) => Math.max(top, entry.n), 0) + 1,
        name: input.name,
        type: input.type,
        bytes: input.data.length,
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        at: now(),
      };
      const file = fileOf(theaterId, objectiveId, attachment);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 이진 먼저, 레코드 나중 — 레코드 쓰기가 실패하면 방금 쓴 이진을 거둬 가리키는 이가 없는 파일을 남기지 않는다.
      writeFileExclusive(file, input.data);
      try {
        const objective = update(objectiveId, (current) => ({ ...current, attachments: [...(current.attachments ?? []), attachment] }));
        return { objective, attachment };
      } catch (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        throw error;
      }
    },

    attachmentRemove(objectiveId, attachmentId) {
      const { theaterId, stored } = locate(objectiveId);
      const target = (stored.attachments ?? []).find((entry) => entry.id === attachmentId);
      if (!target) throw new ObjectiveStoreError("unknown_attachment");
      const objective = update(objectiveId, (current) => ({ ...current, attachments: (current.attachments ?? []).filter((entry) => entry.id !== attachmentId) }));
      try { fs.rmSync(fileOf(theaterId, objectiveId, target), { force: true }); } catch { /* 이미 없으면 그만 */ }
      return objective;
    },

    attachmentPath: (objective, attachment) => fileOf(objective.theaterId, objective.id, attachment),

    followupAdd: (objectiveId, body) => update(objectiveId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const followups = stored.followups ?? [];
      if (followups.filter((candidate) => candidate.state !== "discarded").length >= MAX_FOLLOWUPS) throw new ObjectiveStoreError("too_many_followups");
      const at = now();
      return { ...stored, followups: [...followups, { id: randomUUID(), rev: 1, state: "open", ...body, at, updatedAt: at }] };
    }),
    followupRevise: (objectiveId, candidateId, patch) => update(objectiveId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const target = openFollowup(stored, candidateId);
      const next: StoredFollowup = { ...target, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), rev: target.rev + 1, updatedAt: now() };
      return { ...stored, followups: (stored.followups ?? []).map((candidate) => (candidate.id === candidateId ? next : candidate)) };
    }),
    followupWithdraw: (objectiveId, candidateId) => update(objectiveId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      openFollowup(stored, candidateId);
      return { ...stored, followups: (stored.followups ?? []).filter((candidate) => candidate.id !== candidateId) };
    }),
    followupDiscard: (objectiveId, candidateId) => update(objectiveId, (stored) => {
      const target = (stored.followups ?? []).find((candidate) => candidate.id === candidateId);
      if (!target) throw new ObjectiveStoreError("unknown_followup");
      if (target.state === "discarded") return stored;
      if (target.state !== "open") throw new ObjectiveStoreError("followup_locked");
      const at = now();
      // 흔적은 제목·요약·시각만 — 브리핑·기준·근거는 남기지 않는다. 넘치면 오래된 흔적부터 정리한다.
      const trace: StoredFollowup = { id: target.id, rev: target.rev, state: "discarded", title: target.title, summary: target.summary, brief: "", criteria: [], evidence: [], at: target.at, updatedAt: at, discardedAt: at };
      let followups = (stored.followups ?? []).map((candidate) => (candidate.id === candidateId ? trace : candidate));
      const traces = followups.filter((candidate) => candidate.state === "discarded");
      if (traces.length > MAX_FOLLOWUP_DISCARDED) {
        const drop = new Set(traces.sort((a, b) => (a.discardedAt ?? 0) - (b.discardedAt ?? 0)).slice(0, traces.length - MAX_FOLLOWUP_DISCARDED).map((candidate) => candidate.id));
        followups = followups.filter((candidate) => !drop.has(candidate.id));
      }
      return { ...stored, followups };
    }),

    completeWithFollowups(objectiveId, selection, reserve) {
      let fresh = false;
      const objective = update(objectiveId, (stored) => {
        const batches = stored.followupBatches ?? [];
        if (stored.done) {
          if (batches.some((batch) => batch.id === selection.batchId)) return stored;
          throw new ObjectiveStoreError("objective_done");
        }
        assertReviewable(stored);
        if (batches.some((batch) => batch.id === selection.batchId)) throw new ObjectiveStoreError("followup_changed");
        const ids = selection.followups.map((entry) => entry.id);
        if (new Set(ids).size !== ids.length) throw new ObjectiveStoreError("followup_changed");
        const chosen = selection.followups.map((entry) => {
          const candidate = (stored.followups ?? []).find((existing) => existing.id === entry.id);
          if (!candidate || candidate.state !== "open" || candidate.rev !== entry.rev) throw new ObjectiveStoreError("followup_changed");
          return candidate;
        });
        if (batches.filter((batch) => !batch.items.every((entry) => followupSettled(entry.state))).length >= MAX_FOLLOWUP_BATCHES) throw new ObjectiveStoreError("followup_backlog");
        // 기동 키 용량을 완료 기록보다 먼저 확보한다 — 목표만 완료되고 생성이 막히는 일이 없게.
        reserve(ids);
        const items: StoredFollowupItem[] = chosen.map((candidate) => ({
          candidateId: candidate.id, rev: candidate.rev,
          snapshot: { title: candidate.title, summary: candidate.summary, brief: candidate.brief, criteria: [...candidate.criteria], evidence: [...candidate.evidence] },
          state: "creating", attempts: 0,
        }));
        const chosenIds = new Set(ids);
        fresh = true;
        return foldBatches({
          ...stored,
          done: { at: now() }, planning: undefined, criteriaOpen: undefined,
          followups: (stored.followups ?? []).map((candidate) => (chosenIds.has(candidate.id) ? { ...candidate, state: "selected" as const, batchId: selection.batchId } : candidate)),
          followupBatches: [...batches, { id: selection.batchId, at: now(), launch: selection.launch, items }],
        });
      });
      return { objective, fresh };
    },

    followupSettle: (objectiveId, batchId, candidateId, next) => update(objectiveId, (stored) => {
      const { batch, entry } = batchItem(stored, batchId, candidateId);
      const settled = next.state !== "creating";
      const updated: StoredFollowupItem = {
        candidateId: entry.candidateId, rev: entry.rev, snapshot: entry.snapshot, state: next.state,
        ...(next.operationId ?? entry.operationId ? { operationId: next.operationId ?? entry.operationId } : {}),
        ...(next.error ? { error: next.error } : {}),
        attempts: entry.attempts + (next.attempted ? 1 : 0),
        ...(settled ? { settledAt: now() } : {}),
      };
      if (updated.state === entry.state && updated.operationId === entry.operationId && updated.error === entry.error && updated.attempts === entry.attempts) return stored;
      // 끝난 항목의 후보는 목록에서 빠진다(배치에 남는다). 포기한 항목의 후보는 같은 rev 의 open 으로 돌아간다.
      const followups = updated.state === "created" || updated.state === "deleted"
        ? (stored.followups ?? []).filter((candidate) => candidate.id !== candidateId)
        : updated.state === "abandoned"
          ? (stored.followups ?? []).map((candidate) => { if (candidate.id !== candidateId) return candidate; const { batchId: _batch, ...rest } = candidate; return { ...rest, state: "open" as const }; })
          : stored.followups;
      return foldBatches({ ...stored, followups, followupBatches: replaceItem(stored, batch, updated) });
    }),
    followupRetry: (objectiveId, batchId, candidateId) => update(objectiveId, (stored) => {
      const { batch, entry } = batchItem(stored, batchId, candidateId);
      if (entry.state === "creating") return stored;
      if (entry.state !== "failed" && entry.state !== "confirming") throw new ObjectiveStoreError("followup_settled");
      const { error: _error, settledAt: _settled, ...rest } = entry;
      return { ...stored, followupBatches: replaceItem(stored, batch, { ...rest, state: "creating" }) };
    }),
    followupAbandon(objectiveId, batchId, candidateId) {
      const current = store.find(objectiveId);
      const entry = current?.followupBatches.find((batch) => batch.id === batchId)?.items.find((candidate) => candidate.candidateId === candidateId);
      if (!current || !entry) throw new ObjectiveStoreError("unknown_followup");
      if (entry.state === "abandoned") return current;
      // 결과가 확정되지 않은 항목(confirming)은 포기하지 않는다 — 만들어졌을 수 있다. 같은 키의 재조회만 한다.
      if (entry.state !== "failed") throw new ObjectiveStoreError("followup_not_failed");
      return store.followupSettle(objectiveId, batchId, candidateId, { state: "abandoned" });
    },
    followupBatch(objectiveId, batchId) {
      try { return locate(objectiveId).stored.followupBatches?.find((batch) => batch.id === batchId) ?? null; }
      catch { return null; }
    },
    recorded(operationId) {
      const node = options.operations.get(operationId);
      return !!node && load(node.theaterId).has(operationId);
    },
  };

  /** 떨어뜨린 한 줄의 새 자리 — 쓰는 순서대로 담는다. */
  type Placement = { readonly entry: BoardEntry; readonly rank: number };

  /** 두 자리 사이에 쓸 수 있는 실수가 남았는가 — 같은 자리끼리 맞붙거나 IEEE 754 로 중간값이 사라지면 아니다. */
  const roomBetween = (below: number, above: number): boolean => {
    if (below === -Infinity || above === Infinity) return true;
    const middle = (below + above) / 2;
    return below < middle && middle < above;
  };

  /**
   * 구간을 위에서 아래로 다시 벌린 계획 — 「방금 정한 위 자리」와 「아직 손대지 않은 아래 벽」 사이를 잡는다. 아래 벽은
   * 아직 쓰지 않은 첫 목표의 **지금** 자리(없으면 구간 밖 경계)이므로, 앞몫까지만 쓰이고 멈춰도 쓴 몫과 안 쓴 몫이
   * 섞인 줄의 순서가 그대로다. 자리가 없으면 파일을 하나도 쓰기 전에 `rank_exhausted` 로 끝난다.
   */
  function planSpread(run: readonly BoardEntry[], placed: BoardEntry, lower: number, upper: number): readonly Placement[] {
    const plan: Placement[] = [];
    let previous = lower;
    for (const [ix, member] of run.entries()) {
      // 옮긴 목표는 지금 자리가 없으므로 벽이 되지 못한다.
      const barrier = run.slice(ix + 1).find((rest) => rest !== placed)?.rank ?? upper;
      const rank = previous === -Infinity && barrier === Infinity ? 0
        : previous === -Infinity ? barrier - RANK_STEP
        : barrier === Infinity ? previous + RANK_STEP
        : (previous + barrier) / 2;
      if (!Number.isFinite(rank) || rank <= previous || rank >= barrier) throw new ObjectiveStoreError("rank_exhausted");
      previous = rank;
      plan.push({ entry: member, rank });
    }
    return plan;
  }

  /**
   * 마지막 수단 — 보드 전체를 1024 간격 정수로 균등하게 다시 깐다. 새 자리는 지금 자리 전부보다 아래(큰 값)에 깔고
   * **아래에서 위로** 쓴다: 어디까지만 쓰이고 멈춰도 손대지 않은 앞몫은 전부 쓴 몫보다 위에 남아 줄의 순서가 그대로다.
   * 바깥 경계를 침범할 일은 없다 — 구간을 보드 전체까지 넓힌 뒤에만 이 길로 오므로 바깥이 없다.
   */
  function planUniform(line: readonly BoardEntry[]): readonly Placement[] {
    let previous = 0;
    for (const entry of line) if (entry.rank > previous) previous = entry.rank;
    const plan: Placement[] = [];
    for (const entry of line) {
      const rank = previous + RANK_STEP;
      // 1024 걸음이 자리로 남지 않는 크기(약 4.6e18 이상)이거나 무한으로 넘치면 여기서 멈춘다.
      if (!Number.isFinite(rank) || rank <= previous) throw new ObjectiveStoreError("rank_exhausted");
      previous = rank;
      plan.push({ entry, rank });
    }
    return plan.reverse();
  }

  /**
   * 자리를 다시 벌리기 — 이웃 사이에 실수가 남지 않았을 때만 지난다(일반 이동은 떨어뜨린 목표 파일 하나뿐이다).
   *
   * 떨어뜨린 자리에서 시작해 **양쪽에 표현 가능한 간격이 나올 때까지** 구간을 넓힌다. 구간 안의 레코드 없는 목표는
   * 이때 레코드가 되고(자리를 우리가 정해야 하므로), 저장 목표는 그대로 남아 자리만 바뀐다. 계획을 먼저 세우므로
   * 되는 구간을 찾기까지 넓혀도 파일은 하나도 쓰이지 않는다.
   *
   * 한 건씩 쓰고 성공한 것만 캐시에 올리므로 캐시와 디스크는 늘 같은 몫에서 멈추고, 멈춘 자리의 줄을 방송해 화면도
   * 같은 순서를 본다. 보드 전체까지 넓혀도 수치 검사가 깨지면 보드 전체를 1024 간격으로 한 번 더 균등하게 깔고,
   * 그마저 안 되면 아무 것도 뒤집지 않은 채 `rank_exhausted` 로 멈춘다 — 어느 길에서도 내용은 잃지 않는다.
   */
  function respread(theaterId: string, board: readonly BoardEntry[], at: number, moved: StoredObjective, node: OperationNode): Objective {
    const objectives = load(theaterId);
    const placed: BoardEntry = { stored: moved, node, bare: false, rank: moved.rank };
    const line = [...board.slice(0, at), placed, ...board.slice(at)];
    const edge = (ix: number, beyond: number): number => line[ix]?.rank ?? beyond;
    let head = at;
    let tail = at;
    let spread: readonly Placement[] | null = null;
    for (;;) {
      try { spread = planSpread(line.slice(head, tail + 1), placed, edge(head - 1, -Infinity), edge(tail + 1, Infinity)); break; }
      catch (error) { if (!(error instanceof ObjectiveStoreError) || error.code !== "rank_exhausted") throw error; }
      // 간격이 없는 쪽을 먼저 삼킨다. 양쪽에 간격이 있는데도 모자라면(구간 안이 촘촘하다) 위쪽부터 더 넓힌다.
      if (head > 0 && !roomBetween(edge(head - 1, -Infinity), line[head]!.rank)) head -= 1;
      else if (tail + 1 < line.length && !roomBetween(line[tail]!.rank, edge(tail + 1, Infinity))) tail += 1;
      else if (head > 0) head -= 1;
      else if (tail + 1 < line.length) tail += 1;
      else break;
    }
    const placements = spread ?? planUniform(line);
    // 자리가 바닥난 예외 — 한 줄 남긴다(일반 이동은 파일 하나이므로 여기 오는 일 자체가 드물다).
    if (!spread || placements.length > 1) {
      const born = placements.filter(({ entry }) => entry.bare).length;
      console.warn(`[objectives] ${theaterId}: ${moved.operationId} 자리가 바닥나 ${spread ? `구간 ${placements.length}건을 다시 벌렸다` : `보드 ${placements.length}건 전체를 1024 간격으로 다시 깔았다`} (레코드 새로 세움 ${born}건)`);
    }

    let settled: StoredObjective | null = null;
    try {
      for (const { entry, rank } of placements) {
        // 이미 그 자리인 레코드는 다시 쓰지 않는다 — 레코드 없는 목표는 자리가 같아도 파일을 세워야 한다.
        if (entry !== placed && !entry.bare && entry.rank === rank) continue;
        const record: StoredObjective = { ...entry.stored, rank };
        writeObjectiveAtomic(objectiveDir(theaterId, record.operationId), record);
        objectives.set(record.operationId, record);
        if (entry === placed) settled = record;
      }
    } catch (error) {
      // 성공한 몫만 디스크와 캐시에 남았다 — 화면이 옛 줄에 머물지 않게 지금의 줄을 방송한 뒤 알린다.
      console.warn(`[objectives] respread stopped in ${theaterId}: ${error instanceof Error ? error.message : String(error)}`);
      announce(theaterId, objectives.get(moved.operationId) ?? bareRecord(moved.operationId));
      throw error;
    }
    return (settled ? announce(theaterId, settled) : null) ?? project(settled ?? moved, node);
  }

  /** 화면의 「완료」와 같은 조건을 서버가 원자적으로 다시 따진다 — 제안 대기·스티어링 우선·검토 대기. */
  function assertReviewable(stored: StoredObjective): void {
    if (stored.criteriaProposals?.length) throw new ObjectiveStoreError("criteria_pending");
    // 스티어링은 한 번이라도 깬 지휘관에게만 뜻이 있다 — 화면의 띠와 같은 정의(started && 편집 종류).
    const commander = options.operations.get(stored.operationId);
    const started = !!commander && readOperationLaunch(commander.payload).started;
    if (started && stored.edited?.kinds.length) throw new ObjectiveStoreError("steer_required");
    if (!awaitingReview(stored)) throw new ObjectiveStoreError("not_in_review");
  }
  function openFollowup(stored: StoredObjective, candidateId: string): StoredFollowup {
    const target = (stored.followups ?? []).find((candidate) => candidate.id === candidateId);
    if (!target) throw new ObjectiveStoreError("unknown_followup");
    if (target.state !== "open") throw new ObjectiveStoreError("followup_locked");
    return target;
  }
  function batchItem(stored: StoredObjective, batchId: string, candidateId: string): { batch: StoredFollowupBatch; entry: StoredFollowupItem } {
    const batch = (stored.followupBatches ?? []).find((candidate) => candidate.id === batchId);
    const entry = batch?.items.find((candidate) => candidate.candidateId === candidateId);
    if (!batch || !entry) throw new ObjectiveStoreError("unknown_followup");
    return { batch, entry };
  }
  function replaceItem(stored: StoredObjective, batch: StoredFollowupBatch, updated: StoredFollowupItem): readonly StoredFollowupBatch[] {
    return (stored.followupBatches ?? []).map((candidate) => (candidate.id === batch.id ? { ...candidate, items: candidate.items.map((entry) => (entry.candidateId === updated.candidateId ? updated : entry)) } : candidate));
  }
  /** 배치가 상한을 넘으면 가장 오래된 끝난 배치를 누계로 접는다 — 건수는 잃지 않고, 진행 중 배치는 접지 않는다. */
  function foldBatches(stored: StoredObjective): StoredObjective {
    let batches = [...(stored.followupBatches ?? [])];
    let history: FollowupHistory | undefined = stored.followupHistory;
    while (batches.length > MAX_FOLLOWUP_BATCHES) {
      const index = batches.findIndex((batch) => batch.items.every((entry) => followupSettled(entry.state)));
      if (index < 0) break;
      const [old] = batches.splice(index, 1);
      const base = history ?? { batches: 0, created: 0, deleted: 0, abandoned: 0 };
      history = { batches: base.batches + 1, created: base.created + old!.items.filter((entry) => entry.state === "created").length, deleted: base.deleted + old!.items.filter((entry) => entry.state === "deleted").length, abandoned: base.abandoned + old!.items.filter((entry) => entry.state === "abandoned").length };
    }
    return batches.length === stored.followupBatches?.length ? stored : { ...stored, followupBatches: batches, ...(history ? { followupHistory: history } : {}) };
  }
  return store;
}
