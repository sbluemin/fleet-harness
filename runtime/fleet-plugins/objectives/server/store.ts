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
  MAX_STEPS,
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
  type ObjectiveItem,
  type ObjectiveItemEvent,
  type MemberLaunch,
  type StoredMember,
  type ObjectivesFile,
  type PlanInput,
  type StepAddInput,
  type StepPatchInput,
  type StoredEdge,
  type StoredObjective,
  type StoredRecord,
  type StoredStep,
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
 * 목표 저장소 — Theater 마다 `workspaces/<프로젝트>/objectives/state.json` 하나.
 *
 * 레코드의 키는 지휘관 Operation id 다. 제목·그룹·Theater·만든 시각·세션 이름·모델은 Operation 이 들고 있으므로
 * 여기에 두지 않고, 화면 모양(`ObjectiveItem`)은 읽을 때마다 Operation 과 합쳐 만든다. Operation 이 없으면(삭제 유예 중)
 * 목표도 보이지 않는다 — 레코드는 Operation 이 복원 불가로 확정될 때(`forget`) 지워진다.
 * 모든 변경은 한 곳(`commit`)을 지나 파일에 쓰이고 사건으로 방송된다.
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
  readonly emit: (event: ObjectiveItemEvent) => void;
  readonly now?: () => number;
}

/** 새 목표의 목표 고유값 — Operation 은 부르는 쪽이 먼저 만든다. */
export interface ObjectiveInit {
  readonly note?: string;
  readonly important?: boolean;
  readonly dueDate?: string | null;
  readonly today?: boolean;
  readonly steps?: readonly { readonly text: string; readonly after?: readonly number[] }[];
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
  readonly cook?: string;
  readonly important?: boolean;
  readonly dueDate?: string | null;
  readonly today?: boolean;
}

export interface ObjectiveStore {
  list(theaterId: string): readonly ObjectiveItem[];
  /** 알려진 모든 Theater 의 목표. */
  all(): readonly ObjectiveItem[];
  find(itemId: string): ObjectiveItem | null;
  /** 지휘관의 담당 Operation 들 — 지휘관 Operation 이 이미 사라진 뒤에도 레코드에서 찾는다. */
  assigneesOf(commanderId: string): readonly string[];
  /** 이 Operation 이 맡은 목표와 구성원. */
  findAssignee(operationId: string): { readonly item: ObjectiveItem; readonly memberId: string; readonly stepId: string | null } | null;
  /** 지휘관 Operation 을 이미 만든 뒤 — 그 Operation 의 목표 고유값을 채운다(보드 맨 위). */
  adopt(operationId: string, init: ObjectiveInit): ObjectiveItem;
  patch(itemId: string, input: ObjectivePatch): ObjectiveItem;
  /** Operation 쪽 값(제목·그룹·모델)이 바뀌었다 — 저장은 그대로, 합친 화면 모양만 다시 방송한다. */
  refresh(operationId: string): void;
  /** 지휘관 Operation 이 복원 불가로 사라졌다 — 레코드와 첨부를 지운다. 담당이었다면 그 단계의 연결을 푼다. */
  forget(operationId: string): void;
  /** 순서만 바꾼다 — 같은 Theater 의 다른 항목 앞(before) 또는 뒤(after)로. */
  move(itemId: string, anchor: { readonly beforeId: string } | { readonly afterId: string }): ObjectiveItem;
  complete(itemId: string): ObjectiveItem;
  reopen(itemId: string): ObjectiveItem;
  /** `unplaced` — 사람이 선행 없이 더한 단계는 미분류로 들어간다(지휘관이 자리를 잡는다). */
  stepAdd(itemId: string, input: StepAddInput, options?: { readonly unplaced?: boolean; readonly by?: "human" }): ObjectiveItem;
  stepPatch(itemId: string, stepId: string, input: StepPatchInput, options?: { readonly by?: "human" }): ObjectiveItem;
  /** 지휘관의 완료 — 완료로 두고 기록 한 건을 더한다. */
  stepDone(itemId: string, stepId: string, lines: readonly string[]): ObjectiveItem;
  /** 사람이 이 단계의 기록을 모두 읽었다. 이미 읽었으면 쓰지 않는다. */
  stepSeen(itemId: string, stepId: string): ObjectiveItem;
  stepRemove(itemId: string, stepId: string): ObjectiveItem;
  memberAdd(itemId: string, input: { readonly role: string; readonly brief?: string; readonly launch?: MemberLaunch; readonly subagents?: boolean }, by: "human" | "commander"): ObjectiveItem;
  memberPatch(itemId: string, memberId: string, patch: { readonly role?: string; readonly brief?: string | null; readonly launch?: MemberLaunch | null; readonly subagents?: boolean }): ObjectiveItem;
  memberRemove(itemId: string, memberId: string): { readonly item: ObjectiveItem; readonly removed: StoredMember; readonly stepIds: readonly string[] };
  setMemberOperation(itemId: string, memberId: string, operationId: string | null): ObjectiveItem;
  /** 간선 토글 — `from` 이 `to` 의 선행. 있으면 끊고 없으면 잇는다. */
  edgeToggle(itemId: string, from: string, to: string, why?: string): { readonly item: ObjectiveItem; readonly linked: boolean };
  edgesLinear(itemId: string): ObjectiveItem;
  edgesClear(itemId: string): ObjectiveItem;
  plan(itemId: string, input: PlanInput): ObjectiveItem;
  setCooking(itemId: string, cooking: boolean): ObjectiveItem;
  setCriteriaOpen(itemId: string, open: boolean): ObjectiveItem;
  /** 새 작업(스티어링)이 생겼다 — 앞선 충족 판단을 모두 거둔다. */
  clearMet(itemId: string): ObjectiveItem;
  criterionAdd(itemId: string, text: string, by: "human" | "commander"): ObjectiveItem;
  criterionPatch(itemId: string, criterionId: string, text: string): ObjectiveItem;
  criterionRemove(itemId: string, criterionId: string): ObjectiveItem;
  /** 지휘관이 기준 하나를 충족(근거와 함께) 또는 미충족으로 표시한다. */
  criterionMet(itemId: string, criterionId: string, evidence: string | null): ObjectiveItem;
  proposalApprove(itemId: string, proposalId: string): ObjectiveItem;
  proposalsApproveAll(itemId: string): ObjectiveItem;
  proposalReject(itemId: string, proposalId: string): ObjectiveItem;
  proposalAnnotate(itemId: string, proposalId: string, annotation: string): ObjectiveItem;
  /** 사람의 편집을 쌓는다 · null 이면 지운다. 바뀐 것이 없으면 쓰지 않는다. */
  setEdited(itemId: string, kinds: readonly ObjectiveEditKind[] | null): ObjectiveItem;
  attachmentAdd(itemId: string, input: { readonly name: string; readonly type: ObjectiveAttachment["type"]; readonly data: Buffer; readonly width?: number; readonly height?: number }): { readonly item: ObjectiveItem; readonly attachment: ObjectiveAttachment };
  attachmentRemove(itemId: string, attachmentId: string): ObjectiveItem;
  /** 첨부 파일의 절대 경로 — 서버 안(파일 서빙·지휘관의 도구 응답)에서만 쓴다. */
  attachmentPath(item: ObjectiveItem, attachment: ObjectiveAttachment): string;
  /** 후속 후보 — 지휘관만 쓴다. 활성(open·selected) 은 목표당 상한까지. 끝난 목표에는 쓰지 않는다. */
  followupAdd(itemId: string, body: FollowupBodyInput): ObjectiveItem;
  /** open 후보만 고친다 — rev 가 오른다. */
  followupRevise(itemId: string, candidateId: string, patch: FollowupReviseInput): ObjectiveItem;
  /** 지휘관이 자기 open 후보를 거둔다 — 흔적 없이 빠진다. */
  followupWithdraw(itemId: string, candidateId: string): ObjectiveItem;
  /** 사람이 open 후보를 버린다 — 제목·요약과 시각만 흔적으로 남는다(멱등). */
  followupDiscard(itemId: string, candidateId: string): ObjectiveItem;
  /**
   * 고른 후보와 함께 완료한다 — 검토 대기·편집·기준 제안·rev 를 검사하고, `reserve` 로 기동 키 용량을 먼저 확보한 뒤 완료·배치
   * 기록·후보 잠금을 한 번에 쓴다. 이미 같은 배치로 완료됐다면 쓰지 않고 그대로 돌려준다(`fresh: false`).
   */
  completeWithFollowups(itemId: string, selection: FollowupSelection, reserve: (candidateIds: readonly string[]) => void): { readonly item: ObjectiveItem; readonly fresh: boolean };
  /** 배치 항목의 생성 결과를 기록한다. 끝난 항목(created·deleted)은 후보 목록에서 빠지고 배치에만 남는다. */
  followupSettle(itemId: string, batchId: string, candidateId: string, next: { readonly state: FollowupItemState; readonly operationId?: string; readonly error?: string; readonly attempted?: boolean }): ObjectiveItem;
  /** failed·confirming 항목을 다시 creating 으로 — 같은 스냅샷·같은 키로 다시 확인하거나 만든다. */
  followupRetry(itemId: string, batchId: string, candidateId: string): ObjectiveItem;
  /** failed 항목을 포기한다 — 후보는 같은 rev 의 open 으로 돌아간다. */
  followupAbandon(itemId: string, batchId: string, candidateId: string): ObjectiveItem;
  /** 저장된 배치 그대로 — 동결된 기동 조건과 스냅샷 원형. 원본이 보이지 않으면 null. */
  followupBatch(itemId: string, batchId: string): StoredFollowupBatch | null;
  /** 이 Operation 에 목표 레코드가 이미 있는가 — 키 붙은 생성의 재시도가 입양을 되풀이하지 않게 한다. */
  recorded(operationId: string): boolean;
}

const STATE_FILE = "state.json";
const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/** 따로 만든 Operation 처럼 아직 목표 고유값이 없는 목표 — 저장하지 않고, 첫 편집 때 레코드가 된다. */
const bareRecord = (operationId: string): StoredObjective => ({ operationId, note: "", steps: [] });
/** 목표가 되는 Operation — Console 이 띄우는 에이전트 세션(플러그인 소유 Operation 은 아니다). */
export const isObjectiveOperation = (node: Pick<OperationNode, "type" | "pluginId">): boolean => node.type === "agent" && node.pluginId === null;

interface LegacyStep extends Omit<StoredStep, "member"> {
  readonly assign?: { readonly mode: "self" | "route" | "model"; readonly model?: string; readonly effort?: string };
  readonly operationId?: string;
}
interface LegacyObjective extends Omit<StoredObjective, "steps" | "members"> { readonly steps?: readonly LegacyStep[] }

/** 이전 단계별 담당을 구성원으로 올리고, 기록·선행·읽음 수는 그대로 둔다. */
function migrate(objective: LegacyObjective): StoredObjective {
  const members: StoredMember[] = [];
  const pending = new Map<string, string>();
  const steps = (objective.steps ?? []).map((step, index): StoredStep => {
    let member: string | undefined;
    if (step.operationId) {
      // 이미 떠 있는 담당은 임무 번호별 역할로 보존한다(동일 Operation 이 여러 임무를 맡았다면 같은 구성원).
      const previous = members.find((candidate) => candidate.operationId === step.operationId);
      member = previous?.id ?? randomUUID();
      if (!previous) members.push({ id: member, role: `담당 ${index + 1}`, by: "commander", operationId: step.operationId, ...(step.assign?.mode === "model" && step.assign.model ? { launch: { mode: "model", model: step.assign.model, ...(step.assign.effort ? { effort: step.assign.effort } : {}) } as const } : {}) });
    } else if (!step.done && (step.assign?.mode === "route" || step.assign?.mode === "model")) {
      const key = step.assign.mode === "route" ? "route" : `model:${JSON.stringify([step.assign.model, step.assign.effort])}`;
      member = pending.get(key);
      if (!member) {
        member = randomUUID();
        pending.set(key, member);
        members.push({ id: member, role: step.assign.mode === "route" ? "위임" : step.assign.model ?? "모델", by: step.assign.mode === "model" ? "human" : "commander", ...(step.assign.mode === "model" && step.assign.model ? { launch: { mode: "model", model: step.assign.model, ...(step.assign.effort ? { effort: step.assign.effort } : {}) } as const } : {}) });
      }
    }
    const { assign: _assign, operationId: _operationId, ...rest } = step;
    return { ...rest, ...(member ? { member } : {}), ...(step.assign?.mode === "model" ? { memberBy: "human" as const } : {}) };
  });
  return { ...objective, ...(members.length ? { members } : {}), steps };
}

function readState(file: string): StoredObjective[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ObjectivesFile> & { version?: number; objectives?: readonly LegacyObjective[] };
    if (parsed && Array.isArray(parsed.objectives)) {
      if (parsed.version === 3) return parsed.objectives.map((entry) => ({ ...bareRecord(entry.operationId), ...entry, steps: entry.steps ?? [] })) as StoredObjective[];
      if (parsed.version === 2) return parsed.objectives.map((entry) => migrate({ ...bareRecord(entry.operationId), ...entry }));
    }
  } catch (error) {
    // 없는 파일은 빈 보드다. 깨진 파일은 덮어쓰지 않고 .broken 으로 비켜 둔다.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
  }
  try { if (fs.existsSync(file)) fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
  return [];
}

function writeStateAtomic(file: string, objectives: readonly StoredObjective[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 3, objectives: objectives.map(compact) } satisfies ObjectivesFile, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** 기본값·빈 값은 쓰지 않는다 — 저장 모양에는 뜻이 있는 값만 남는다. */
function compact(objective: StoredObjective): StoredObjective {
  const out: Record<string, unknown> = { ...objective };
  for (const key of ["note", "cook", "dueDate", "addedBy", "followupHistory", "origin"] as const) if (!out[key]) delete out[key];
  if (!objective.followups?.length) delete out.followups;
  if (!objective.followupBatches?.length) delete out.followupBatches;
  for (const key of ["cooking", "criteriaOpen", "important", "today"] as const) if (out[key] !== true) delete out[key];
  if (!(objective.attachments?.length)) delete out.attachments;
  if (!(objective.criteria?.length)) delete out.criteria;
  if (!(objective.criteriaProposals?.length)) delete out.criteriaProposals;
  if (!objective.members?.length) delete out.members;
  else out.members = objective.members.map((member) => ({ ...member, ...(member.brief ? {} : { brief: undefined }), ...(member.launch ? {} : { launch: undefined }), ...(member.operationId ? {} : { operationId: undefined }), ...(member.subagents === true ? {} : { subagents: undefined }) }));
  if (!objective.edited) delete out.edited;
  if (!objective.done) delete out.done;
  out.steps = objective.steps.map((step) => {
    const next: Record<string, unknown> = { ...step };
    if (step.done !== true) delete next.done;
    if (!step.member) delete next.member;
    if (!step.records?.length) { delete next.records; delete next.seen; }
    else if (!step.seen) delete next.seen;
    next.after = step.after.map((edge) => (edge.why ? edge : { id: edge.id }));
    return next;
  });
  if (objective.steps.length === 0) delete out.steps;
  return out as unknown as StoredObjective;
}

export function createObjectiveStore(options: ObjectiveStoreOptions): ObjectiveStore {
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, StoredObjective[]>();

  const dirFor = (theaterId: string): string => {
    const dir = options.dirOf(theaterId);
    if (!dir) throw new ObjectiveStoreError("unknown_theater");
    return dir;
  };
  const load = (theaterId: string): StoredObjective[] => {
    let objectives = cache.get(theaterId);
    if (!objectives) {
      const dir = options.dirOf(theaterId);
      // 폴더를 풀 수 없는 Theater 는 빈 보드로 보이되 캐시하지 않는다 — 빈 목록을 붙들어 두면 폴더가 돌아온 뒤 첫 쓰기가
      // 그 빈 목록으로 기존 state.json 을 덮는다. 쓰기는 dirFor 가 unknown_theater 로 막는다.
      if (!dir) return [];
      objectives = readState(path.join(dir, STATE_FILE));
      cache.set(theaterId, objectives);
    }
    return objectives;
  };
  const theaterIds = (): readonly string[] => [...new Set([...options.operations.list().map((node) => node.theaterId), ...cache.keys()])];
  const attachmentFolder = (theaterId: string, operationId: string) => path.join(dirFor(theaterId), "attachments", safeSegment(operationId));
  const fileOf = (theaterId: string, operationId: string, attachment: Pick<ObjectiveAttachment, "id" | "type">) => path.join(attachmentFolder(theaterId, operationId), `${safeSegment(attachment.id)}.${ATTACHMENT_TYPES[attachment.type]}`);

  /** 화면 모양 — 저장 레코드와 지휘관 Operation 을 합친다. 담당 세션 이름은 담당 Operation 에서. */
  const project = (stored: StoredObjective, node: OperationNode): ObjectiveItem => {
    const launch = readOperationLaunch(node.payload);
    const addedBy = stored.addedBy ? { operationId: stored.addedBy, title: options.operations.get(stored.addedBy)?.title ?? null } : null;
    const members = (stored.members ?? []).map((member) => {
      const assignee = member.operationId ? options.operations.get(member.operationId) : null;
      const preset = assignee ? readOperationLaunch(assignee.payload) : null;
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
      ...(stored.cook ? { cook: stored.cook } : {}),
      cooking: stored.cooking === true,
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
      origin: stored.origin ? { itemId: stored.origin.itemId, title: options.operations.get(stored.origin.itemId)?.title ?? null, candidateId: stored.origin.candidateId, evidence: stored.origin.evidence.map(evidenceView) } : null,
      steps: stored.steps.map((step) => {
        const member = step.member ? byMember.get(step.member) : null;
        return {
          id: step.id,
          text: step.text,
          done: step.done === true,
          after: step.after.map((edge) => edge.id),
          why: Object.fromEntries(step.after.flatMap((edge) => (edge.why ? [[edge.id, edge.why]] : []))),
          member: member?.id ?? null,
          ...(step.memberBy ? { memberBy: step.memberBy } : {}),
          ...(step.unplaced ? { unplaced: true as const } : {}),
          operationId: member?.operationId ?? null,
          sessionName: member?.sessionName ?? null,
          ...(member?.launch.mode === "model" && member.model ? { model: member.model } : {}),
          ...(member?.launch.mode === "model" && member.effort ? { effort: member.effort } : {}),
          records: (step.records ?? []).map((record, index) => ({ ...record, kind: index === 0 ? "done" as const : "redone" as const })),
          seen: step.seen ?? 0,
        };
      }),
    };
  };
  /** 담당 Operation — 목표가 아니라 목표의 임무를 맡은 세션이다. */
  const assigneeIds = (objectives: readonly StoredObjective[]): ReadonlySet<string> => new Set(objectives.flatMap((entry) => (entry.members ?? []).flatMap((member) => (member.operationId ? [member.operationId] : []))));
  /** 목표가 되는 Operation 인가 — 이 Theater 의 에이전트 Operation 이고 다른 목표의 담당이 아니다. */
  const objectiveNode = (theaterId: string, operationId: string): OperationNode | null => {
    const node = options.operations.get(operationId);
    if (!node || node.theaterId !== theaterId || !isObjectiveOperation(node)) return null;
    return assigneeIds(load(theaterId)).has(operationId) ? null : node;
  };
  /** 지휘관 Operation 이 이 Theater 에 살아 있을 때만 화면에 선다. */
  const view = (theaterId: string, stored: StoredObjective): ObjectiveItem | null => {
    const node = objectiveNode(theaterId, stored.operationId);
    return node ? project(stored, node) : null;
  };
  /** 보드 순서 — 아직 레코드가 없는(따로 만든) Operation 이 새것부터 위에, 그 아래 레코드 순서. */
  const visible = (theaterId: string): readonly { readonly stored: StoredObjective; readonly node: OperationNode }[] => {
    const objectives = load(theaterId);
    const assignees = assigneeIds(objectives);
    const recorded = new Set(objectives.map((entry) => entry.operationId));
    const nodes = options.operations.list().filter((node) => node.theaterId === theaterId && isObjectiveOperation(node) && !assignees.has(node.id));
    const bare = nodes.filter((node) => !recorded.has(node.id)).sort((a, b) => b.ts.createdAt - a.ts.createdAt).map((node) => ({ stored: bareRecord(node.id), node }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return [...bare, ...objectives.flatMap((stored) => { const node = byId.get(stored.operationId); return node ? [{ stored, node }] : []; })];
  };

  /** 목표 하나 — 레코드가 없으면(따로 만든 Operation) 빈 목표이고 `at` 은 -1 이다. */
  const locate = (itemId: string): { theaterId: string; objectives: StoredObjective[]; at: number; stored: StoredObjective; node: OperationNode } => {
    const found = options.operations.get(itemId);
    const node = found ? objectiveNode(found.theaterId, itemId) : null;
    if (!node) throw new ObjectiveStoreError("unknown_item");
    const objectives = load(node.theaterId);
    const at = objectives.findIndex((entry) => entry.operationId === itemId);
    return { theaterId: node.theaterId, objectives, at, stored: at >= 0 ? objectives[at]! : bareRecord(itemId), node };
  };

  const commit = (theaterId: string, objectives: StoredObjective[], changed: StoredObjective | null, removedId?: string, reordered = false): ObjectiveItem | null => {
    writeStateAtomic(path.join(dirFor(theaterId), STATE_FILE), objectives);
    if (changed) {
      const item = view(theaterId, changed);
      if (item) options.emit({ op: "upsert", theaterId, itemId: item.id, item, ...(reordered ? { order: objectives.map((entry) => entry.operationId) } : {}) });
      return item;
    }
    if (removedId) options.emit({ op: "remove", theaterId, itemId: removedId });
    return null;
  };

  const update = (itemId: string, mutate: (stored: StoredObjective) => StoredObjective): ObjectiveItem => {
    const { theaterId, objectives, at, stored, node } = locate(itemId);
    const mutated = mutate(stored);
    if (mutated === stored) return project(stored, node);
    if (mutated.steps.length > MAX_STEPS) throw new ObjectiveStoreError("too_many_steps");
    if (hasCycle(graphOf(mutated.steps))) throw new ObjectiveStoreError("dependency_cycle");
    // 선행이 바뀌면 단계도 편성 순으로 다시 선다 — 목록·번호·지휘관 도구의 index 가 편성과 같은 순서를 말한다.
    const steps = lineupOrder(mutated.steps);
    const next = steps === mutated.steps ? mutated : { ...mutated, steps: [...steps] };
    // 따로 만든 Operation 의 첫 편집 — 여기서 레코드가 된다(보드에서 이미 맨 위 무리에 있으므로 레코드도 맨 위에).
    if (at >= 0) objectives[at] = next; else objectives.unshift(next);
    return commit(theaterId, objectives, next) ?? project(next, node);
  };

  const stepOf = (stored: StoredObjective, stepId: string): { at: number; step: StoredStep } => {
    const at = stored.steps.findIndex((step) => step.id === stepId);
    if (at < 0) throw new ObjectiveStoreError("unknown_step");
    return { at, step: stored.steps[at]! };
  };
  const replaceStep = (stored: StoredObjective, at: number, step: StoredStep): StoredObjective => {
    const steps = [...stored.steps];
    steps[at] = step;
    return { ...stored, steps };
  };
  /** 자리가 정해졌다 — 미분류 표시를 뗀다. */
  const placed = (step: StoredStep): StoredStep => (step.unplaced ? (({ unplaced: _unplaced, ...rest }) => rest)(step) : step);
  const withoutEdge = (step: StoredStep, id: string): StoredStep => ({ ...step, after: step.after.filter((edge) => edge.id !== id) });
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
    find: (itemId) => { try { const { stored, node } = locate(itemId); return project(stored, node); } catch { return null; } },
    assigneesOf(commanderId) {
      for (const theaterId of theaterIds()) {
        const stored = load(theaterId).find((entry) => entry.operationId === commanderId);
        if (stored) return (stored.members ?? []).flatMap((member) => (member.operationId ? [member.operationId] : []));
      }
      return [];
    },
    findAssignee(operationId) {
      for (const item of store.all()) {
        const member = item.members.find((candidate) => candidate.operationId === operationId);
        if (member) return { item, memberId: member.id, stepId: item.steps.find((step) => step.member === member.id)?.id ?? null };
      }
      return null;
    },

    adopt(operationId, init) {
      const node = options.operations.get(operationId);
      if (!node || !isObjectiveOperation(node)) throw new ObjectiveStoreError("unknown_operation");
      const objectives = load(node.theaterId);
      if (objectives.some((entry) => entry.operationId === operationId)) throw new ObjectiveStoreError("already_objective");
      const stepIds = (init.steps ?? []).map(() => randomUUID());
      const steps: StoredStep[] = (init.steps ?? []).map((step, ix) => ({
        id: stepIds[ix]!,
        text: step.text,
        after: (step.after ?? []).filter((index) => index >= 0 && index < ix).map((index) => ({ id: stepIds[index]! })),
      }));
      // 함께 받은 달성 기준은 같은 저장에 기본 요구사항(by "human")으로 남는다 — 한 건이라도 맞지 않으면 목표 자체를 세우지 않는다.
      const criteriaTexts = checkedCriteria(init);
      const stored: StoredObjective = {
        operationId,
        note: init.note ?? "",
        ...(init.important ? { important: true as const } : {}),
        ...(init.dueDate ? { dueDate: init.dueDate } : {}),
        ...(init.today ? { today: true as const } : {}),
        ...(init.addedBy ? { addedBy: init.addedBy } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
        ...(criteriaTexts.length ? { criteria: criteriaTexts.map((text) => ({ id: randomUUID(), text, by: "human" as const })) } : {}),
        steps: [...lineupOrder(steps)],
      };
      objectives.unshift(stored);
      return commit(node.theaterId, objectives, stored, undefined, true) ?? project(stored, node);
    },

    patch: (itemId, input) => update(itemId, (stored) => ({
      ...stored,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.cook !== undefined ? { cook: input.cook } : {}),
      ...(input.important !== undefined ? { important: input.important ? true as const : undefined } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? undefined } : {}),
      ...(input.today !== undefined ? { today: input.today ? true as const : undefined } : {}),
    })),

    refresh(operationId) {
      const node = options.operations.get(operationId);
      if (!node) return;
      if (objectiveNode(node.theaterId, operationId)) {
        const stored = load(node.theaterId).find((entry) => entry.operationId === operationId) ?? bareRecord(operationId);
        options.emit({ op: "upsert", theaterId: node.theaterId, itemId: operationId, item: project(stored, node) });
        return;
      }
      // 담당 Operation 이 바뀌었다(세션 이름 등) — 그 단계가 있는 목표를 다시 방송한다.
      for (const owner of load(node.theaterId)) {
        if (!(owner.members ?? []).some((member) => member.operationId === operationId)) continue;
        const item = view(node.theaterId, owner);
        if (item) options.emit({ op: "upsert", theaterId: node.theaterId, itemId: item.id, item });
      }
    },

    forget(operationId) {
      for (const theaterId of theaterIds()) {
        const objectives = load(theaterId);
        const at = objectives.findIndex((entry) => entry.operationId === operationId);
        if (at >= 0) {
          objectives.splice(at, 1);
          commit(theaterId, objectives, null, operationId);
          // 목표가 사라지면 붙인 이미지도 함께 — 남은 파일은 가리킬 곳이 없다.
          try { fs.rmSync(attachmentFolder(theaterId, operationId), { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ }
        }
        for (let ix = 0; ix < objectives.length; ix += 1) {
          const owner = objectives[ix]!;
          if (!(owner.members ?? []).some((member) => member.operationId === operationId)) continue;
          const next = { ...owner, members: owner.members?.map((member) => (member.operationId === operationId ? { ...member, operationId: undefined } : member)) };
          objectives[ix] = next;
          commit(theaterId, objectives, next);
        }
      }
    },

    move(itemId, anchor) {
      const { theaterId, objectives, stored, node } = locate(itemId);
      const anchorId = "beforeId" in anchor ? anchor.beforeId : anchor.afterId;
      if (anchorId === itemId) return project(stored, node);
      // 순서는 보이는 그대로 레코드가 된다 — 따로 만든 Operation 도 옮기는 순간 자리를 얻는다.
      const order = visible(theaterId).map((entry) => entry.stored).filter((entry) => entry.operationId !== itemId);
      const target = order.findIndex((entry) => entry.operationId === anchorId);
      if (target < 0) throw new ObjectiveStoreError("unknown_item");
      order.splice("beforeId" in anchor ? target : target + 1, 0, stored);
      // 보이지 않는 레코드(삭제 유예 중인 Operation)는 뒤에 그대로 둔다.
      const shown = new Set(order.map((entry) => entry.operationId));
      objectives.splice(0, objectives.length, ...order, ...objectives.filter((entry) => !shown.has(entry.operationId)));
      return commit(theaterId, objectives, stored, undefined, true) ?? project(stored, node);
    },

    // 완료는 상태이지 연결 해제가 아니다 — 담당 연결은 그대로 남아 묶음·이동이 살아 있다.
    complete: (itemId) => update(itemId, (stored) => {
      if (stored.done) return stored;
      // 남은 후보가 있으면 고르지 않은 완료도 후보 검토의 경계를 지난다 — 후보가 없는 목표의 완료는 지금 그대로다.
      if ((stored.followups ?? []).some((candidate) => candidate.state === "open")) assertReviewable(stored);
      return { ...stored, done: { at: now() }, cooking: undefined, criteriaOpen: undefined };
    }),
    reopen: (itemId) => update(itemId, (stored) => (stored.done ? { ...stored, done: undefined } : stored)),

    stepAdd: (itemId, input, addOptions) => update(itemId, (stored) => {
      const known = new Set(stored.steps.map((step) => step.id));
      const after = (input.after ?? []).filter((id) => known.has(id)).map((id): StoredEdge => ({ id }));
      // 선행을 함께 준 추가는 이미 자리가 있다 — 미분류는 선행 없이 더한 사람의 단계뿐이다.
      const unplaced = addOptions?.unplaced === true && input.after === undefined;
      if (input.member && !(stored.members ?? []).some((member) => member.id === input.member)) throw new ObjectiveStoreError("unknown_member");
      const step: StoredStep = { id: randomUUID(), text: input.text, after, ...(input.member ? { member: input.member } : {}), ...(addOptions?.by === "human" && input.member !== undefined ? { memberBy: "human" as const } : {}), ...(unplaced ? { unplaced: true as const } : {}) };
      // 새 일이 생겼다 — 앞선 충족 판단은 옛 보드에 대한 것이다.
      return withoutMet({ ...stored, steps: [...stored.steps, step] });
    }),

    stepPatch: (itemId, stepId, input, patchOptions) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      const known = new Set(stored.steps.map((candidate) => candidate.id));
      const why = (id: string) => input.why?.[id] ?? step.after.find((edge) => edge.id === id)?.why;
      // 선행을 정하면(빈 배열도) 자리가 정해진 것이다.
      const base = input.after !== undefined ? placed(step) : step;
      const after = input.after !== undefined
        ? input.after.filter((id) => known.has(id) && id !== stepId).map((id) => ({ id, ...(why(id) ? { why: why(id)! } : {}) }))
        : input.why ? step.after.map((edge) => ({ id: edge.id, ...(why(edge.id) ? { why: why(edge.id)! } : {}) })) : step.after;
      if (input.member && !(stored.members ?? []).some((member) => member.id === input.member)) throw new ObjectiveStoreError("unknown_member");
      const next: StoredStep = {
        ...base,
        after,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.done !== undefined ? { done: input.done ? true as const : undefined } : {}),
        ...(input.member !== undefined ? { member: input.member ?? undefined, memberBy: patchOptions?.by === "human" ? "human" as const : undefined } : {}),
      };
      const replaced = replaceStep(stored, at, next);
      // 끝난 단계를 되돌리면 새 일이다 — 충족 판단을 거둔다.
      return input.done === false && step.done ? withoutMet(replaced) : replaced;
    }),

    stepDone: (itemId, stepId, lines) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      const records = step.records ?? [];
      const record: StoredRecord = { id: randomUUID(), at: now(), lines: [...lines] };
      const kept = [...records, record].slice(-MAX_RECORDS);
      // 밀려난 기록만큼 읽은 수도 줄인다 — 남은 기록 중 안 읽은 것이 그대로 안 읽은 것으로 남는다.
      const seen = Math.max(0, Math.min(step.seen ?? 0, records.length) - (records.length + 1 - kept.length));
      return replaceStep(stored, at, { ...step, done: true, records: kept, seen });
    }),

    stepSeen: (itemId, stepId) => update(itemId, (stored) => {
      const { at, step } = stepOf(stored, stepId);
      const count = step.records?.length ?? 0;
      return (step.seen ?? 0) === count ? stored : replaceStep(stored, at, { ...step, seen: count });
    }),

    stepRemove: (itemId, stepId) => update(itemId, (stored) => {
      stepOf(stored, stepId);
      return { ...stored, steps: stored.steps.filter((step) => step.id !== stepId).map((step) => withoutEdge(step, stepId)) };
    }),

    memberAdd: (itemId, input, by) => update(itemId, (stored) => {
      if ((stored.members?.length ?? 0) >= MAX_STEPS) throw new ObjectiveStoreError("too_many_members");
      return { ...stored, members: [...(stored.members ?? []), { id: randomUUID(), role: input.role.trim(), ...(input.brief ? { brief: input.brief } : {}), ...(input.launch ? { launch: input.launch } : {}), ...(input.subagents === true ? { subagents: true as const } : {}), by }] };
    }),
    memberPatch: (itemId, memberId, patch) => update(itemId, (stored) => {
      if (!(stored.members ?? []).some((member) => member.id === memberId)) throw new ObjectiveStoreError("unknown_member");
      return { ...stored, members: stored.members!.map((member) => member.id === memberId ? {
        ...member, ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief || undefined } : {}),
        ...(patch.launch !== undefined ? { launch: patch.launch ?? undefined } : {}),
        ...(patch.subagents !== undefined ? { subagents: patch.subagents ? true as const : undefined } : {}),
      } : member) };
    }),
    memberRemove(itemId, memberId) {
      const found = locate(itemId).stored;
      const removed = (found.members ?? []).find((member) => member.id === memberId);
      if (!removed) throw new ObjectiveStoreError("unknown_member");
      const stepIds = found.steps.filter((step) => step.member === memberId).map((step) => step.id);
      const item = update(itemId, (stored) => ({ ...stored, members: stored.members?.filter((member) => member.id !== memberId), steps: stored.steps.map((step) => step.member === memberId ? { ...step, member: undefined, memberBy: undefined } : step) }));
      return { item, removed, stepIds };
    },
    setMemberOperation: (itemId, memberId, operationId) => update(itemId, (stored) => {
      if (!(stored.members ?? []).some((member) => member.id === memberId)) throw new ObjectiveStoreError("unknown_member");
      return { ...stored, members: stored.members!.map((member) => member.id === memberId ? { ...member, operationId: operationId ?? undefined } : member) };
    }),

    edgeToggle(itemId, from, to, why) {
      let linked = false;
      const item = update(itemId, (stored) => {
        stepOf(stored, from);
        const { at, step } = stepOf(stored, to);
        // 사람이 간선을 직접 이으면 양 끝 모두 자리가 정해진 것으로 본다 — 끊는 것은 자리를 되돌리지 않는다.
        if (step.after.some((edge) => edge.id === from)) { linked = false; return replaceStep(stored, at, withoutEdge(step, from)); }
        linked = true;
        const fromAt = stored.steps.findIndex((candidate) => candidate.id === from);
        const withFrom = replaceStep(stored, fromAt, placed(stored.steps[fromAt]!));
        return replaceStep(withFrom, at, { ...placed(step), after: [...step.after, { id: from, why: why ?? "human" }] });
      });
      return { item, linked };
    },

    edgesLinear: (itemId) => update(itemId, (stored) => ({
      ...stored,
      steps: stored.steps.map((step, ix) => ({ ...placed(step), after: ix === 0 ? [] : [{ id: stored.steps[ix - 1]!.id, why: "human" }] })),
    })),

    edgesClear: (itemId) => update(itemId, (stored) => ({ ...stored, steps: stored.steps.map((step) => ({ ...placed(step), after: [] })) })),

    plan: (itemId, input) => update(itemId, (stored) => {
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
      const kept = stored.steps.filter((step) => step.done || step.unplaced || !!step.records?.length || step.memberBy === "human");
      const keptIds = new Set(kept.map((step) => step.id));
      const freshIds = input.steps.map(() => randomUUID());
      const fresh: StoredStep[] = input.steps.map((step, ix) => {
        const after: StoredEdge[] = [];
        for (const edge of step.after ?? []) {
          // stepId 는 유지되는 기존 단계, index 는 이 계획 안의 순서.
          const targetId = edge.stepId && keptIds.has(edge.stepId) ? edge.stepId : edge.index !== undefined && edge.index !== ix ? freshIds[edge.index] : undefined;
          if (!targetId || after.some((entry) => entry.id === targetId)) continue;
          after.push({ id: targetId, ...(edge.why ? { why: edge.why } : {}) });
        }
        const member = resolve(step.member);
        return { id: freshIds[ix]!, text: step.text, after, ...(member ? { member } : {}) };
      });
      return withoutMet({ ...stored, members, criteriaProposals: proposals, steps: [...kept.map((step) => ({ ...step, after: step.after.filter((edge) => keptIds.has(edge.id)) })), ...fresh] });
    }),

    setCooking: (itemId, cooking) => update(itemId, (stored) => (!!stored.cooking === cooking ? stored : { ...stored, cooking: cooking ? true as const : undefined })),
    setCriteriaOpen: (itemId, open) => update(itemId, (stored) => (!!stored.criteriaOpen === open ? stored : { ...stored, criteriaOpen: open ? true as const : undefined })),
    clearMet: (itemId) => update(itemId, (stored) => withoutMet(stored)),

    setEdited(itemId, kinds) {
      return update(itemId, (stored) => {
        if (kinds === null) return stored.edited ? { ...stored, edited: undefined } : stored;
        if (kinds.length === 0) return stored;
        const merged = [...new Set([...(stored.edited?.kinds ?? []), ...kinds])];
        if (stored.edited && merged.length === stored.edited.kinds.length) return stored;
        return { ...stored, edited: { at: now(), kinds: merged } };
      });
    },

    criterionAdd: (itemId, text, by) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      if (criteria.length >= MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
      return { ...stored, criteria: [...criteria, { id: randomUUID(), text: text.trim(), by }] };
    }),
    criterionPatch: (itemId, criterionId, text) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      const target = criteria.find((entry) => entry.id === criterionId);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      if (target.text === text.trim()) return stored;
      // 문구가 바뀐 기준의 충족 근거는 옛 문구에 대한 것이다 — 그 기준만 미충족으로 돌린다.
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: text.trim(), by: entry.by } : entry)) };
    }),
    criterionRemove: (itemId, criterionId) => update(itemId, (stored) => {
      const criteria = stored.criteria ?? [];
      if (!criteria.some((entry) => entry.id === criterionId)) throw new ObjectiveStoreError("unknown_criterion");
      return { ...stored, criteria: criteria.filter((entry) => entry.id !== criterionId), criteriaProposals: stored.criteriaProposals?.filter((proposal) => proposal.target !== criterionId) };
    }),
    criterionMet: (itemId, criterionId, evidence) => update(itemId, (stored) => {
      if (stored.criteriaProposals?.length) throw new ObjectiveStoreError("criteria_pending");
      const criteria = stored.criteria ?? [];
      const target = criteria.find((entry) => entry.id === criterionId);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      const met = evidence?.trim() || undefined;
      if (target.met === met) return stored;
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: entry.text, by: entry.by, ...(met ? { met } : {}) } : entry)) };
    }),
    proposalApprove: (itemId, proposalId) => update(itemId, (stored) => {
      const proposal = stored.criteriaProposals?.find((entry) => entry.id === proposalId);
      if (!proposal) throw new ObjectiveStoreError("unknown_proposal");
      const next = approve(stored, proposal);
      return { ...next, criteriaProposals: stored.criteriaProposals?.filter((entry) => entry.id !== proposalId) };
    }),
    proposalsApproveAll: (itemId) => update(itemId, (stored) => {
      if (!stored.criteriaProposals?.length) return stored;
      const next = stored.criteriaProposals.reduce(approve, stored);
      return { ...next, criteriaProposals: undefined };
    }),
    proposalReject: (itemId, proposalId) => update(itemId, (stored) => {
      if (!stored.criteriaProposals?.some((entry) => entry.id === proposalId)) throw new ObjectiveStoreError("unknown_proposal");
      return { ...stored, criteriaProposals: stored.criteriaProposals.filter((entry) => entry.id !== proposalId) };
    }),
    proposalAnnotate: (itemId, proposalId, annotation) => update(itemId, (stored) => {
      if (!stored.criteriaProposals?.some((entry) => entry.id === proposalId)) throw new ObjectiveStoreError("unknown_proposal");
      if (annotation.length > 300) throw new ObjectiveStoreError("annotation_too_long");
      return { ...stored, criteriaProposals: stored.criteriaProposals.map((entry) => entry.id === proposalId ? { ...entry, annotation: annotation.trim() || undefined } : entry) };
    }),

    attachmentAdd(itemId, input) {
      const { theaterId, stored } = locate(itemId);
      if (stored.done) throw new ObjectiveStoreError("item_done");
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
      const file = fileOf(theaterId, itemId, attachment);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, input.data);
      fs.renameSync(tmp, file);
      try {
        const item = update(itemId, (current) => ({ ...current, attachments: [...(current.attachments ?? []), attachment] }));
        return { item, attachment };
      } catch (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        throw error;
      }
    },

    attachmentRemove(itemId, attachmentId) {
      const { theaterId, stored } = locate(itemId);
      const target = (stored.attachments ?? []).find((entry) => entry.id === attachmentId);
      if (!target) throw new ObjectiveStoreError("unknown_attachment");
      const item = update(itemId, (current) => ({ ...current, attachments: (current.attachments ?? []).filter((entry) => entry.id !== attachmentId) }));
      try { fs.rmSync(fileOf(theaterId, itemId, target), { force: true }); } catch { /* 이미 없으면 그만 */ }
      return item;
    },

    attachmentPath: (item, attachment) => fileOf(item.theaterId, item.id, attachment),

    followupAdd: (itemId, body) => update(itemId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("item_done");
      const followups = stored.followups ?? [];
      if (followups.filter((candidate) => candidate.state !== "discarded").length >= MAX_FOLLOWUPS) throw new ObjectiveStoreError("too_many_followups");
      const at = now();
      return { ...stored, followups: [...followups, { id: randomUUID(), rev: 1, state: "open", ...body, at, updatedAt: at }] };
    }),
    followupRevise: (itemId, candidateId, patch) => update(itemId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("item_done");
      const target = openFollowup(stored, candidateId);
      const next: StoredFollowup = { ...target, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), rev: target.rev + 1, updatedAt: now() };
      return { ...stored, followups: (stored.followups ?? []).map((candidate) => (candidate.id === candidateId ? next : candidate)) };
    }),
    followupWithdraw: (itemId, candidateId) => update(itemId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("item_done");
      openFollowup(stored, candidateId);
      return { ...stored, followups: (stored.followups ?? []).filter((candidate) => candidate.id !== candidateId) };
    }),
    followupDiscard: (itemId, candidateId) => update(itemId, (stored) => {
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

    completeWithFollowups(itemId, selection, reserve) {
      let fresh = false;
      const item = update(itemId, (stored) => {
        const batches = stored.followupBatches ?? [];
        if (stored.done) {
          if (batches.some((batch) => batch.id === selection.batchId)) return stored;
          throw new ObjectiveStoreError("item_done");
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
          done: { at: now() }, cooking: undefined, criteriaOpen: undefined,
          followups: (stored.followups ?? []).map((candidate) => (chosenIds.has(candidate.id) ? { ...candidate, state: "selected" as const, batchId: selection.batchId } : candidate)),
          followupBatches: [...batches, { id: selection.batchId, at: now(), launch: selection.launch, items }],
        });
      });
      return { item, fresh };
    },

    followupSettle: (itemId, batchId, candidateId, next) => update(itemId, (stored) => {
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
    followupRetry: (itemId, batchId, candidateId) => update(itemId, (stored) => {
      const { batch, entry } = batchItem(stored, batchId, candidateId);
      if (entry.state === "creating") return stored;
      if (entry.state !== "failed" && entry.state !== "confirming") throw new ObjectiveStoreError("followup_settled");
      const { error: _error, settledAt: _settled, ...rest } = entry;
      return { ...stored, followupBatches: replaceItem(stored, batch, { ...rest, state: "creating" }) };
    }),
    followupAbandon(itemId, batchId, candidateId) {
      const current = store.find(itemId);
      const entry = current?.followupBatches.find((batch) => batch.id === batchId)?.items.find((candidate) => candidate.candidateId === candidateId);
      if (!current || !entry) throw new ObjectiveStoreError("unknown_followup");
      if (entry.state === "abandoned") return current;
      // 결과가 확정되지 않은 항목(confirming)은 포기하지 않는다 — 만들어졌을 수 있다. 같은 키의 재조회만 한다.
      if (entry.state !== "failed") throw new ObjectiveStoreError("followup_not_failed");
      return store.followupSettle(itemId, batchId, candidateId, { state: "abandoned" });
    },
    followupBatch(itemId, batchId) {
      try { return locate(itemId).stored.followupBatches?.find((batch) => batch.id === batchId) ?? null; }
      catch { return null; }
    },
    recorded(operationId) {
      const node = options.operations.get(operationId);
      return !!node && load(node.theaterId).some((entry) => entry.operationId === operationId);
    },
  };

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
