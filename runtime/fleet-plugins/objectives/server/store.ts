import { missionDispatch } from "./signals.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { canonicalModelId } from "@fleet-console/sdk/models";
import { readOperationLaunch, type OperationNode, type OperationDescription } from "@fleet-console/sdk/operations";
import type { ConsoleTurnFailure } from "@fleet-console/sdk/mcp";

import { ATTACHMENT_TYPES, MAX_ATTACHMENTS } from "./attachments.js";
import { objectiveOperator } from "./board-state.js";
import { checkedResultInput, completionResultsSchema, patchedResultInput, prTarget, artifactTarget, resultIdentity, ResultValidationError, RESULT_LIMITS, storedResultsSchema, evidenceMetadataSchema, type CompletionResultInput, type EvidenceMetadata, type ObjectiveResult, type ResultInput, type ResultPatch, type PrObservation, prObservationSchema, storedEvidenceSchema } from "./results.js";
import { EVIDENCE_EXTENSIONS, type EvidenceBytes } from "./evidence.js";
import { deriveFailedOutcome } from "./views.js";
import {
  MAX_CRITERIA,
  MAX_OBJECTIVE_ACTIONS, objectiveActorSchema, objectiveActionSchema,
  type ObjectiveActor, type ObjectiveReviewer, type ObjectiveAction,
  MAX_CRITERION_TEXT,
  MAX_FOLLOWUPS,
  MAX_FOLLOWUP_BATCHES,
  MAX_FOLLOWUP_DISCARDED,
  MAX_RECORDS,
  MAX_MISSIONS,
  MAX_NOTE,
  MAX_REMOVAL_REASON,
  REMOVED_RETENTION_MS,
  COMMODORE_TIDY_PREFIX,
  awaitingHandoff,
  awaitingReview,
  evidenceView,
  followupSettled,
  graphOf,
  hasCycle,
  lineupOrder,
  observableEvidence,
  withValidHandoff,
  withoutMet,
  type CriterionProposalInput,
  type ObjectiveCriterionProposal,
  type ObjectiveAttachment,
  type ObjectiveEditKind,
  type Objective,
  type ObjectiveMemberFailure,
  type ObjectiveMemberUnreported,
  type SettledTurn,
  type ObjectiveEvent,
  OBJECTIVE_FILE,
  type MemberLaunch,
  type MemberProposal,
  type MemberNext,
  notAppliedFailure,
  heldNextOutcome,
  type HostCoordinates,
  type MemberRouted,
  type StoredMember,
  type StoredHandoff,
  type StoredMerge,
  type StoredRemoval,
  type PlanInput,
  type MissionAddInput,
  type MissionPatchInput,
  type StoredEdge,
  type StoredObjective,
  type PendingCommander,
  type StoredRecord,
  type StoredMission,
  type FollowupBodyInput,
  type FollowupEvidence,
  type FollowupHistory,
  type FollowupItemState,
  type FollowupReviseInput,
  type StoredFollowup,
  type StoredFollowupBatch,
  type StoredFollowupItem,
  type StoredOrigin,
  type Retrospective,
  type Decision,
  type DecisionAnswer,
  type DecisionAnswersInput,
  type DecisionQuestionInput,
  type DecisionRequest,
  storedDecisionFieldsSchema,
  storedExtensionsSchema,
  MAX_CONTEXT,
} from "./types.js";

/**
 * 목표 저장소 — Theater 의 목표 폴더(`workspaces/<프로젝트>/objectives`) 안에 목표마다 디렉터리 하나.
 *
 * ```
 * <objectiveId>/objective.json                        레코드 하나(보드 자리 rank 를 포함한다)
 * <objectiveId>/attachments/<attachmentId>.<확장자>     그 목표에 붙인 이미지
 * ```
 *
 * 디렉터리 이름과 레코드의 키는 목표 id 다. 첫 기동 전 제목·그룹·시각·프리셋은 `pending` 에 있고,
 * 지휘관이 태어난 뒤에는 Operation 이 진실이다. `pending` 없이 Operation 만 없으면 삭제 유예 중이라 숨긴다.
 * 삭제가 복원 불가로 확정될 때(`forget`) 디렉터리를 통째로 지운다.
 *
 * 목록은 폴더를 한 번 읽어 캐시에 올리고, Console 이 이 저장소의 유일한 쓰는 쪽이라 파일 잠금도 감시도 두지 않는다.
 * 모든 변경은 한 곳(`commit`)을 지나 **그 목표의 파일 한 건**에 tmp→rename 으로 쓰이고, 쓰기가 성공한 뒤에야 캐시가
 * 갈리고 마지막에 사건으로 방송된다 — 쓰기가 실패하면 캐시와 디스크가 함께 이전 상태로 남는다.
 */

export class ObjectiveStoreError extends Error {
  constructor(readonly code: string, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "ObjectiveStoreError";
  }
}

export interface ObjectiveStoreOptions {
  /** Theater 의 목표 디렉터리 — `workspaces/<프로젝트>/objectives`. Theater 경로를 모르면 null. */
  readonly dirOf: (theaterId: string) => string | null;
  readonly theaterIds?: () => readonly string[];
  readonly operations: { get(id: string): OperationNode | null; list(): readonly OperationNode[]; describe?(id: string): OperationDescription | null; readonly groups?: { get(id: string): { readonly theaterId: string } | null } };
  readonly emit: (event: ObjectiveEvent) => void;
  readonly now?: () => number;
  /** 떠 있는 채팅의 호스트 좌표 — 턴 뒤 예약이 적용됐는지 투영이 가른다. 떠 있는 채팅이 아니거나 모르면 null. */
  readonly coordinates?: (operationId: string) => HostCoordinates | null;
  /** 떠 있는 세션이 광고한 도구 이름 — 모르면 null(표시하지 않는다). */
  readonly advertisedTools?: (operationId: string) => readonly string[] | null;
  /** 호스트가 떠 있는 구성원의 모델을 바꿀 수 있다 — 메뉴가 「지금·이번 턴 뒤」를 말한다. */
  readonly liveSwitch?: boolean;
  /** 공개 콘솔 제어 관측 — 실패 outcome 및 상태 투영에 쓴다. */
  readonly observe?: (operationId: string) => { readonly lifecycle: string; readonly activity: string; readonly output?: { readonly outcome?: string } } | null;
  /** 임무에 담당 시각이 새로 남으면 — 무보고 감시를 걸 때 쓴다. */
  readonly onAssignment?: (objectiveId: string) => void;
}

/** 새 목표의 목표 고유값 — Operation 은 부르는 쪽이 먼저 만든다. */
export interface ObjectiveInit {
  readonly note?: string;
  readonly dueDate?: string | null;
  readonly today?: boolean;
  readonly missions?: readonly { readonly text: string; readonly prerequisites?: readonly number[] }[];
  /** Console Use 가 함께 받은 달성 기준 문장 — 저장될 때 기본 요구사항으로 by "human" 이 된다. */
  readonly criteria?: readonly string[];
  readonly by?: ObjectiveActor;
  readonly addedBy?: StoredObjective["addedBy"];
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

/** 정리한 에이전트 Operation 과 그때의 제목, 에이전트가 댄 이유. */
export interface TidyActor {
  readonly operationId: string;
  readonly title: string | null;
  readonly reason?: string;
}

export interface ObjectivePatch {
  readonly note?: string;
  readonly planRequest?: string;
  readonly planRequestBy?: ObjectiveActor;
  readonly dueDate?: string | null;
  readonly today?: boolean;
  readonly routingConfirm?: boolean;
}

export interface ObjectiveStore {
  list(theaterId: string): readonly Objective[];
  /** 알려진 모든 Theater 의 목표. */
  all(): readonly Objective[];
  find(objectiveId: string): Objective | null;
  /** 증거 공유 디렉터리 — 지휘관과 구성원이 같이 쓰고, 봉인은 이 안의 파일만 받는다. */
  sharedDir(theaterId: string, objectiveId: string): string;
  /** 지휘관의 담당 Operation 들 — 지휘관 Operation 이 이미 사라진 뒤에도 레코드에서 찾는다. */
  /** 이 Operation 이 맡은 목표와 구성원. */
  findMember(operationId: string): { readonly objective: Objective; readonly memberId: string; readonly missionId: string | null } | null;
  /** 새 목표 레코드를 세운다 — pending 이 없으면 기존 Operation 을 입양한다. */
  adopt(operationId: string, init: ObjectiveInit, pending?: PendingCommander): Objective;
  pending(objectiveId: string): PendingCommander | null;
  patchPending(objectiveId: string, patch: Partial<PendingCommander>): Objective;
  launched(objectiveId: string): Objective;
  removePending(objectiveId: string): void;
  /**
   * 에이전트의 정리 — 기동 전(Operation 없는) 보드 목표만 받는다. 지우기는 레코드를 남긴 채 표시만 하고, 합치기는 원본의 브리핑과
   * 기준을 받는 목표에 덧붙인 뒤 원본을 합친 표시로 둔다. 하나라도 받을 수 없으면 아무것도 바꾸지 않고 이유와 함께 거절한다.
   */
  tidyRemove(objectiveIds: readonly string[], by: TidyActor): readonly Objective[];
  tidyMerge(targetId: string, sourceIds: readonly string[], by: TidyActor): Objective;
  /** 사람이 보드에서 지운 기동 전 목표 — 에이전트의 정리와 같은 자리에 남아 되돌릴 수 있다. */
  trash(objectiveId: string): Objective;
  /**
   * 지우거나 합친 표시를 거둔다 — 합쳤던 원본이면 받은 목표에 덧붙인 구간과 옮긴 기준도 걷어 낸다. 그사이 사람이 고친 구간과
   * 기준은 받은 목표에 남긴다.
   */
  tidyRestore(objectiveId: string): Objective;
  /** 보관 기간이 지난 지운 목표를 영구 삭제하고 그 id 를 돌려준다. */
  purgeRemoved(): readonly string[];
  patch(objectiveId: string, input: ObjectivePatch): Objective;
  /** Operation 쪽 값(제목·그룹·모델)이 바뀌었다 — 저장은 그대로, 합친 화면 모양만 다시 방송한다. */
  refresh(operationId: string): void;
  /** 현재 세션의 실패 ledger — 모델 턴이나 영속 목표 기록과 별개다. */
  memberFailure(memberId: string): ObjectiveMemberFailure | undefined;
  settleMemberFailure(memberId: string, failure: ConsoleTurnFailure | null): ObjectiveMemberFailure | undefined;
  /** 마지막으로 정산한 구성원 턴 — 재시작 뒤에도 남아 같은 턴을 다시 알리지 않는다. */
  memberTurn(memberId: string): SettledTurn | undefined;
  setMemberTurn(memberId: string, turn: SettledTurn): void;
  /** 구성원이 마지막으로 메시지를 전달한 턴을 본 시각. */
  memberDelivered(memberId: string): number | undefined;
  setMemberDelivered(memberId: string, at: number): void;
  /** 지휘관의 세션 간 메시지가 이 구성원에게 닿았다(본문 없음). */
  recordDispatch(memberId: string, at: number): void;
  /** 그 구성원의 마지막 발주와 수신 — 발주가 없으면 null. */
  memberDispatch(memberId: string): { readonly at: number; readonly receivedAt: number | null } | null;
  recordReceipt(memberId: string, at: number): void;
  /** 무보고 통지를 이미 보낸 보고 기대 시각. */
  unreportedNoticeFor(memberId: string): number | undefined;
  setUnreportedNoticeFor(memberId: string, at: number): void;
  /** 실패 없이 닫힌 턴의 무보고 — 실패 ledger 와 같은 수명이다. null 이면 거둔다. */
  settleMemberUnreported(memberId: string, unreported: ObjectiveMemberUnreported | null): void;
  /** 지휘관의 명시적 재발주 — 실패와 무보고의 inbox 표시만 해소한다. */
  acknowledgeMemberFailure(memberId: string): void;
  recordMemberNotificationFailure(memberId: string, failure: NonNullable<ObjectiveMemberFailure["notificationFailure"]>, signal?: "failure" | "unreported"): void;
  /** 지휘관 Operation 이 복원 불가로 사라졌다 — 레코드와 첨부를 지운다. 담당이었다면 그 임무의 연결을 푼다. */
  forget(operationId: string): void;
  /** 순서만 바꾼다 — 같은 Theater 의 다른 항목 앞(before) 또는 뒤(after)로. */
  move(objectiveId: string, anchor: { readonly beforeId: string } | { readonly afterId: string }): Objective;
  complete(objectiveId: string, operationIntent?: StoredObjective["operationIntent"], by?: ObjectiveActor): Objective;
  reopen(objectiveId: string, operationIntent?: StoredObjective["operationIntent"], by?: ObjectiveActor): Objective;
  /** 완료 복원은 의도만 먼저 쓰고, 호스트가 복원한 뒤 회차를 시작한다. */
  extend(objectiveId: string, context: string, operationIntent?: StoredObjective["operationIntent"], by?: ObjectiveActor): Objective;
  operationIntent(objectiveId: string): StoredObjective["operationIntent"];
  acknowledgeOperationIntent(objectiveId: string, requestId: string): void;
  /** 인계 대기의 목표를 검토 대기로 넘긴다 — 인계 기록을 남긴다. 지휘관은 회고와 함께, 사람은 회고 없이. */
  handOff(objectiveId: string, input: { readonly by: "commander"; readonly retrospective: Retrospective } | { readonly by: ObjectiveReviewer }): Objective;
  /** `unplaced` — 사람이 선행 없이 더한 임무는 미분류로 들어간다(지휘관이 자리를 잡는다). */
  missionAdd(objectiveId: string, input: MissionAddInput, options?: { readonly unplaced?: boolean; readonly by?: ObjectiveActor }): Objective;
  missionPatch(objectiveId: string, missionId: string, input: MissionPatchInput, options?: { readonly by?: ObjectiveActor }): Objective;
  /** 기동으로 처음 선 담당의 임무에 배정 시각이 없으면 지금으로 남긴다. 이미 있으면 그대로 둔다. */
  noteAssignments(objectiveId: string, memberIds: readonly string[]): void;
  /** 이 침묵 시작 시각으로 이미 지휘관에게 알렸으면 그 시각. */
  reportWokenFor(objectiveId: string, missionId: string): number | undefined;
  /** 깨움을 보낸 침묵 시작 시각을 남긴다. 보드 변경 시각은 움직이지 않는다. */
  markReportWake(objectiveId: string, missionId: string, since: number): void;
  /** stop 을 보드 사실로 남기거나(true, 지금 시각) 지시가 다시 닿아 거둔다(false). 보드 변경 시각은 미루지 않는다. */
  setStopped(objectiveId: string, stopped: boolean): Objective;
  /** 지휘관의 완료 — 기록·완료·선택 결과물을 한 번에 저장한다. 결과물은 임무의 현재 연결로 남는다. */
  missionDone(objectiveId: string, missionId: string, lines: readonly string[], results?: readonly CompletionResultInput[]): Objective;
  /** 사람이 이 임무의 기록을 모두 읽었다. 이미 읽었으면 쓰지 않는다. */
  missionSeen(objectiveId: string, missionId: string): Objective;
  missionRemove(objectiveId: string, missionId: string): Objective;
  memberAdd(objectiveId: string, input: { readonly role: string; readonly brief?: string; readonly launch?: MemberLaunch; readonly proposal?: MemberProposal; readonly subagents?: boolean }, by: ObjectiveActor): Objective;
  memberPatch(objectiveId: string, memberId: string, patch: { readonly role?: string; readonly brief?: string | null; readonly launch?: MemberLaunch | null; readonly subagents?: boolean }): Objective;
  /**
   * 띄운 구성원의 기동 기록 — 기동 근거(routed)·이번 턴 뒤 예약(next)·예약을 취소할 때 돌아갈 선택(launch). 사람의 편집이 아니라
   * 기동 경로의 사실이라 편집 기록을 쌓지 않는다. null 은 지운다.
   */
  memberLaunchState(objectiveId: string, memberId: string, patch: { readonly routed?: MemberRouted | null; readonly next?: MemberNext | null; readonly launch?: MemberLaunch | null }): Objective;
  /** 저장된 구성원 그대로 — 예약의 실행값·이전 선택처럼 화면 모양에 싣지 않는 값을 기동 경로가 읽는다. 없으면 null. */
  storedMember(objectiveId: string, memberId: string): StoredMember | null;
  storedAnswers(objectiveId: string, requestId: string): readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[]; readonly text: string }[] | null;
  /** 직접 고른 모델(model)과 이미 그 선택인 구성원은 그대로 둔다. changed 는 실제로 바뀐 구성원 수다. */
  memberBatchLaunch(objectiveId: string, mode: "same" | "route", skip?: ReadonlySet<string>): { readonly objective: Objective; readonly changed: number };
  memberRemove(objectiveId: string, memberId: string): { readonly objective: Objective; readonly removed: StoredMember; readonly missionIds: readonly string[] };
  /** 간선 토글 — `from` 이 `to` 의 선행. 있으면 끊고 없으면 잇는다. */
  edgeToggle(objectiveId: string, from: string, to: string, why?: string, desired?: boolean): { readonly objective: Objective; readonly linked: boolean; readonly changed: boolean };
  plan(objectiveId: string, input: PlanInput): Objective;
  setPlanning(objectiveId: string, planning: boolean): Objective;
  /**
   * 구상·개시 단계를 기록한다 — 개시는 「진행 중」으로 올리고 되돌리지 않는다. `by` 를 주면 그 손을 행위 기록(plan·commence)에
   * 남기고, 개시면 `commencedBy` 로도 남긴다 — 요청이 지휘관에게 닿은 뒤에만 준다.
   */
  recordStage(objectiveId: string, stage: "planned" | "commenced", by?: ObjectiveActor): Objective;
  setCriteriaOpen(objectiveId: string, open: boolean): Objective;
  /**
   * 운영 주체를 사람이 정한다 — true 는 사령관에게 맡김, false 는 사람이 운영. 바뀔 때만 쓰고 행위 기록에 `edit` 한 줄을 남긴다.
   * 새 행위 종류를 만들지 않는 것은 옛 빌드가 모르는 종류가 든 레코드를 통째로 격리하기 때문이다(`invalid_stored_actions`).
   * 편집 종류(`kinds`) 없는 `edit` 는 이 기록뿐이다 — 화면의 출처가 그것을 맡기기·돌려받기로 읽는다(client/actors.ts `lastAct`).
   */
  setCommodoreOperated(objectiveId: string, operated: boolean, by: ObjectiveActor): Objective;
  /** 새 작업(스티어링)이 생겼다 — 앞선 충족 판단을 모두 거둔다. */
  clearMet(objectiveId: string, by?: ObjectiveActor): Objective;
  criterionAdd(objectiveId: string, text: string, by: ObjectiveActor): Objective;
  criterionPatch(objectiveId: string, criterionId: string, text: string): Objective;
  criterionRemove(objectiveId: string, criterionId: string): Objective;
  /** 지휘관이 기준 하나를 충족(근거와 함께) 또는 미충족으로 표시한다. */
  criterionMet(objectiveId: string, criterionId: string, evidence: string | null): Objective;
  proposalApprove(objectiveId: string, proposalId: string, by?: ObjectiveActor): Objective;
  proposalsApproveAll(objectiveId: string, by?: ObjectiveActor): Objective;
  proposalReject(objectiveId: string, proposalId: string, by?: ObjectiveActor): Objective;
  proposalAnnotate(objectiveId: string, proposalId: string, annotation: string, by?: ObjectiveActor): Objective;
  /** 사람의 편집을 쌓는다 · null 이면 지운다. 바뀐 것이 없으면 쓰지 않는다. */
  setEdited(objectiveId: string, kinds: readonly ObjectiveEditKind[] | null, by?: ObjectiveActor): Objective;
  resultUpdate(objectiveId: string, resultId: string, patch: ResultPatch): Objective;
  resultRemove(objectiveId: string, resultId: string): Objective;
  /** 조회를 시작한 대상이 그대로 있을 때만 사실을 갱신한다. 지휘관 편집 시각·충족 판단은 바꾸지 않는다. */
  resultObserved(objectiveId: string, resultId: string, url: string, observation: PrObservation): void;
  evidenceSeal(objectiveId: string, ownerOperationId: string, input: EvidenceBytes): EvidenceMetadata;
  evidenceRead(objectiveId: string, resultId: string): Promise<{ readonly data: Buffer; readonly metadata: EvidenceMetadata }>;
  evidenceCollect(): void;
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
  followupDiscard(objectiveId: string, candidateId: string, by?: ObjectiveActor): Objective;
  /** 고른 후보의 rev 를 검증하고 완료·배치·후보 잠금을 한 번에 쓴다. 같은 배치는 그대로 돌려준다. */
  completeWithFollowups(objectiveId: string, selection: FollowupSelection, operationIntent?: StoredObjective["operationIntent"], by?: ObjectiveActor): { readonly objective: Objective; readonly fresh: boolean };
  /** 배치 항목의 생성 결과를 기록한다. 끝난 항목(created·deleted)은 후보 목록에서 빠지고 배치에만 남는다. */
  followupSettle(objectiveId: string, batchId: string, candidateId: string, next: { readonly state: FollowupItemState; readonly operationId?: string; readonly error?: string; readonly attempted?: boolean }): Objective;
  /** failed·confirming 항목을 다시 creating 으로 — 같은 스냅샷·같은 키로 다시 확인하거나 만든다. */
  followupRetry(objectiveId: string, batchId: string, candidateId: string): Objective;
  /** failed 항목을 포기한다 — 후보는 같은 rev 의 open 으로 돌아간다. */
  followupAbandon(objectiveId: string, batchId: string, candidateId: string): Objective;
  /** 저장된 배치 그대로 — 동결된 기동 조건과 스냅샷 원형. 원본이 보이지 않으면 null. */
  followupBatch(objectiveId: string, batchId: string): StoredFollowupBatch | null;
  /** 이 id 에 목표 레코드가 있는가 — 후속 재시도의 중복 생성을 막는다. */
  recorded(operationId: string): boolean;
  /**
   * 개시 전 목표의 그룹과 후속 배치의 기동 그룹 가운데 지워진(또는 다른 Theater 의) 그룹을 가리키는 것을 미분류로 비우고 저장한다.
   * scope 를 주면 그 그룹만 — 그룹 삭제 사건이 부른다. 비운 목표 수.
   */
  releaseGroups(scope?: { readonly theaterId: string; readonly groupId: string }): number;
  /**
   * 지휘관의 결정 요청 — 현재 요청을 통째로 새 id 들로 대체한다. revision 이 다르거나 답을 보내는 중이면 거절한다. 아직 답이 없는
   * 현재 요청과 질문이 저장될 모양 그대로 같으면(순서·문장·선택지 이름과 설명·여러 개 고르기·임무·구성원) 대체하지 않고 그 요청을
   * 돌려준다(reused) — id·revision 이 그대로라 사람이 쓰던 답과 그 id 로 낸 답이 살아 있다.
   */
  decisionRequest(objectiveId: string, input: { readonly expectedRevision: number; readonly questions: readonly DecisionQuestionInput[] }): { readonly objective: Objective; readonly request: DecisionRequest; readonly replacedRequestId: string | null; readonly reused: boolean };
  /** 지휘관의 철회 — 그 요청이 지금 요청일 때만. 요청이 없으면 변화 없이 withdrawn false. */
  decisionWithdraw(objectiveId: string, requestId: string): { readonly objective: Objective; readonly withdrawn: boolean };
  /**
   * 사람의 답을 검증해 전달 중으로 둔다. 그 요청의 답이 이미 결정으로 남았으면 같은 답은 recorded, 다른 답은 거절한다.
   */
  decisionAccept(objectiveId: string, input: DecisionAnswersInput, by?: ObjectiveActor): { readonly recorded: true; readonly objective: Objective } | { readonly recorded: false; readonly objective: Objective; readonly request: DecisionRequest; readonly answers: readonly DecisionAnswer[] };
  /** 전달 결과 — 닿았으면 질문마다 결정을 쌓고 요청을 정리한다. 못 닿았으면 전달 중 표시만 거두고 요청은 남는다. */
  decisionSettle(objectiveId: string, requestId: string, delivered: boolean): Objective;
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
// 레코드 없는 목표(새 Operation·우클릭·Quick Launch 로 만든 세션)의 빈 모양 — 만들어진 순간부터 목표다.
const bareRecord = (operationId: string): StoredObjective => ({ operationId, rank: 0, note: "", enlisted: true, missions: [] });
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
  try { fs.renameSync(file, `${file}.broken-${Date.now()}-${randomUUID()}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
      if (parsed.boardUpdatedAt !== undefined && (!Number.isFinite(parsed.boardUpdatedAt) || parsed.boardUpdatedAt < 0)) throw new ObjectiveStoreError("invalid_stored_board_time");
      if (parsed.stoppedAt !== undefined && (typeof parsed.stoppedAt !== "number" || !Number.isFinite(parsed.stoppedAt) || parsed.stoppedAt < 0)) throw new ObjectiveStoreError("invalid_stored_board_time");
      if (Array.isArray(parsed.missions) && parsed.missions.some((mission) => { const row = mission as { assignmentTs?: unknown; quietWokenFor?: unknown }; const bad = (at: unknown) => at !== undefined && (typeof at !== "number" || !Number.isFinite(at) || at < 0); return bad(row.assignmentTs) || bad(row.quietWokenFor); })) throw new ObjectiveStoreError("invalid_stored_board_time");
      if (parsed.addedBy !== undefined && typeof parsed.addedBy !== "string" && (parsed.addedBy?.kind !== "commodore" || !objectiveActorSchema.safeParse(parsed.addedBy).success)) throw new ObjectiveStoreError("invalid_stored_actor");
      const intent = parsed.operationIntent;
      if (intent !== undefined && (!intent || typeof intent !== "object" || typeof intent.requestId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(intent.requestId) || (intent.action !== "archive" && intent.action !== "ensure-active"))) throw new ObjectiveStoreError("invalid_operation_intent");
      if (intent?.extensionContext !== undefined && (intent.action !== "ensure-active" || typeof intent.extensionContext !== "string" || !intent.extensionContext.trim() || intent.extensionContext.length > MAX_CONTEXT)) throw new ObjectiveStoreError("invalid_operation_intent");
      const actors = [parsed.done?.by, parsed.handoff?.by, parsed.planRequestBy, parsed.commencedBy, intent?.by,
        ...(parsed.edited?.actors ?? []), ...(parsed.members ?? []).map((row) => row.by),
        ...(parsed.criteria ?? []).map((row) => row.by), ...(parsed.criteriaProposals ?? []).map((row) => row.annotationBy),
        ...(parsed.missions ?? []).flatMap((row) => [row.by, row.memberBy]),
        ...(parsed.followups ?? []).map((row) => row.discardedBy), ...(parsed.followupBatches ?? []).map((row) => row.by)];
      if (actors.some((actor) => actor !== undefined && !objectiveActorSchema.safeParse(actor).success)) throw new ObjectiveStoreError("invalid_stored_actor");
      if (parsed.actions !== undefined && (!Array.isArray(parsed.actions) || parsed.actions.some((action) => !objectiveActionSchema.safeParse(action).success))) throw new ObjectiveStoreError("invalid_stored_actions");
      if (parsed.actionCounts !== undefined && (!parsed.actionCounts || typeof parsed.actionCounts !== "object" || Object.entries(parsed.actionCounts).some(([kind, count]) => !objectiveActionSchema.shape.kind.safeParse(kind).success || !Number.isSafeInteger(count) || count! < 0))) throw new ObjectiveStoreError("invalid_stored_actions");
      const extensions = storedExtensionsSchema.safeParse(parsed.extensions ?? []);
      if (!extensions.success || (parsed.extensionActive !== undefined && (parsed.extensionActive !== true || !extensions.data.length || parsed.done || parsed.handoff))) throw new ObjectiveStoreError("invalid_stored_extensions");
      const results = storedResultsSchema.safeParse(parsed.results === undefined ? [] : parsed.results);
      // 새 필드도 같은 손상 경계다. 아래 quarantine이 원본을 보존하며 다른 목표 읽기는 계속된다.
      if (!results.success) throw new ObjectiveStoreError("invalid_stored_results");
      const rawEvidence = parsed.evidence === undefined ? [] : parsed.evidence;
      if (!Array.isArray(rawEvidence) || rawEvidence.length > RESULT_LIMITS.evidenceCount + RESULT_LIMITS.pendingEvidence) throw new ObjectiveStoreError("invalid_stored_evidence");
      const evidence = rawEvidence.map((entry) => storedEvidenceSchema.safeParse(entry));
      if (evidence.some((entry) => !entry.success)) throw new ObjectiveStoreError("invalid_stored_evidence");
      const manifest = evidence.map((entry) => entry.data!);
      if (new Set(manifest.map((entry) => entry.evidenceId)).size !== manifest.length || manifest.reduce((sum, entry) => sum + entry.bytes, 0) > RESULT_LIMITS.totalEvidenceBytes) throw new ObjectiveStoreError("invalid_stored_evidence");
      if (results.data.some((entry) => entry.kind === "evidence" && !manifest.some((file) => file.evidenceId === entry.evidenceId && file.sha256 === entry.sha256 && file.bytes === entry.bytes && file.mediaType === entry.mediaType))) throw new ObjectiveStoreError("invalid_stored_evidence");
      if (!storedDecisionFieldsSchema.safeParse({ decisionRequest: parsed.decisionRequest, decisionRequestRevision: parsed.decisionRequestRevision, decisionDelivery: parsed.decisionDelivery, decisions: parsed.decisions }).success) throw new ObjectiveStoreError("invalid_stored_decisions");
      return { ...parsed, operationId: parsed.operationId, rank: Number.isFinite(parsed.rank) ? parsed.rank! : 0, note: typeof parsed.note === "string" ? parsed.note : "", missions: Array.isArray(parsed.missions) ? parsed.missions : [], results: results.data, evidence: manifest };
    }
  } catch { /* 깨진 JSON 또는 results/evidence 필드 — 원본을 격리하고 그 목표만 레코드 없음으로 본다. */ }
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

/** 구성원 기동 기록은 읽을 때 모양을 확인한다 — 어긋난 값은 없는 것으로 보고 화면에 싣지 않는다. */
const shortText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
function storedRouted(value: StoredMember["routed"]): MemberRouted | null {
  if (!value || typeof value !== "object") return null;
  if (value.via === "route" && shortText(value.because, 300)) return { via: "route", because: value.because };
  if (value.via === "fallback" && shortText(value.reason, 64)) return { via: "fallback", reason: value.reason, ...(shortText(value.detail, 300) ? { detail: value.detail } : {}) };
  return null;
}
/** 저장된 구성원 실패 — 모양이 어긋난 옛 값은 없는 것으로 읽는다. */
function storedFailure(value: StoredMember["failure"]): ObjectiveMemberFailure | undefined {
  return value && typeof value === "object" && typeof value.error === "string" && Number.isInteger(value.consecutiveFailures) && value.consecutiveFailures > 0 ? value : undefined;
}
function storedUnreported(value: StoredMember["unreported"]): ObjectiveMemberUnreported | undefined {
  return value && typeof value === "object" && Number.isFinite(value.at) && (value.reason === null || typeof value.reason === "object") ? value : undefined;
}
/** 보고 경로 없음 — 광고 목록을 알고, 그 목록에 보고 도구(SendMessage)가 없을 때만. 목록을 모르면(미기동·init 전) 판정하지 않는다. */
export function lacksReportTool(tools: readonly string[] | null): boolean {
  return tools !== null && !tools.includes(REPORT_TOOL);
}
/** 구성원이 지휘관에게 보고하는 도구 — 하네스가 광고하는 이름(Cursor 의 광고명 치환은 Gateway 안쪽이라 init 목록은 이 이름을 말한다). */
export const REPORT_TOOL = "SendMessage";
function storedTurn(value: StoredMember["settledTurn"]): SettledTurn | undefined {
  return value && typeof value === "object" && Number.isFinite(value.revision) && (value.generation === undefined || typeof value.generation === "string") ? value : undefined;
}
function storedNext(value: StoredMember["next"]): MemberNext | null {
  if (!value || typeof value !== "object" || !shortText(value.model, 128) || !value.from || typeof value.from !== "object") return null;
  // 「다음 재개」 시절의 표식(reservedWhile·reservedGeneration)은 더 뜻이 없다 — 읽을 때 버린다.
  const { reservedWhile: _while, reservedGeneration: _generation, ...rest } = value as MemberNext & { reservedWhile?: unknown; reservedGeneration?: unknown };
  // 예약 모델만 접는다. from은 예약 당시의 실행값이라 원문을 둔다.
  const cause = value.cause && typeof value.cause === "object" && typeof value.cause.message === "string"
    ? { message: value.cause.message, ...(typeof value.cause.name === "string" ? { name: value.cause.name } : {}), ...(typeof value.cause.code === "string" ? { code: value.cause.code } : {}),
      ...(typeof value.cause.errorClass === "string" ? { errorClass: value.cause.errorClass } : {}), ...(typeof value.cause.exitCode === "number" ? { exitCode: value.cause.exitCode } : {}), ...(typeof value.cause.signal === "string" ? { signal: value.cause.signal } : {}) } : undefined;
  return { ...rest, model: canonicalModelId(rest.model), ...(shortText(value.effort, 32) ? {} : { effort: undefined }), ...(shortText(value.failed, 64) ? {} : { failed: undefined }), cause: shortText(value.failed, 64) ? cause : undefined, ...(value.held === "host" || value.held === "plugin" ? {} : { held: undefined }) };
}

function canonicalStoredLaunch(launch: MemberLaunch | null | undefined): MemberLaunch | undefined {
  if (!launch || launch.mode !== "model") return launch ?? undefined;
  const model = canonicalModelId(launch.model);
  return model === launch.model ? launch : { ...launch, model };
}

function canonicalStoredNext(next: MemberNext | null | undefined): MemberNext | null | undefined {
  if (!next) return next;
  const model = canonicalModelId(next.model);
  return model === next.model ? next : { ...next, model };
}

/** 기본값·빈 값은 쓰지 않는다 — 저장 모양에는 뜻이 있는 값만 남는다. */
function compact(objective: StoredObjective): StoredObjective {
  const out: Record<string, unknown> = { ...objective };
  for (const key of ["note", "planRequest", "dueDate", "addedBy", "followupHistory", "origin", "removed"] as const) if (!out[key]) delete out[key];
  if (!objective.merged?.length) delete out.merged;
  if (!objective.actions?.length) delete out.actions;
  else out.actions = objective.actions.slice(-MAX_OBJECTIVE_ACTIONS);
  if (!objective.followups?.length) delete out.followups;
  if (!objective.followupBatches?.length) delete out.followupBatches;
  for (const key of ["planning", "criteriaOpen", "today", "commenced"] as const) if (out[key] !== true) delete out[key];
  if (typeof objective.enlisted !== "boolean") delete out.enlisted;
  if (objective.routingConfirm !== false) delete out.routingConfirm;
  if (!(objective.attachments?.length)) delete out.attachments;
  if (!objective.results?.length) delete out.results;
  if (!objective.evidence?.length) delete out.evidence;
  if (!(objective.criteria?.length)) delete out.criteria;
  if (!(objective.criteriaProposals?.length)) delete out.criteriaProposals;
  if (!objective.members?.length) delete out.members;
  else out.members = objective.members.map((member) => ({ id: member.id, role: member.role, by: member.by,
    ...(member.brief ? { brief: member.brief } : {}), ...(member.launch ? { launch: member.launch } : {}), ...(member.subagents === true ? { subagents: true } : {}),
    ...(member.routed ? { routed: member.routed } : {}), ...(member.next ? { next: member.next } : {}),
    // 구성원 수명 상태 — 재시작 뒤에도 실패·무보고 표시와 통지 중복 방지가 이어지도록 남긴다(메시지 본문은 싣지 않는다).
    ...(member.failure ? { failure: member.failure } : {}), ...(member.unreported ? { unreported: member.unreported } : {}),
    ...(member.settledTurn ? { settledTurn: member.settledTurn } : {}), ...(member.deliveredAt !== undefined ? { deliveredAt: member.deliveredAt } : {}),
    ...(member.dispatchedAt !== undefined ? { dispatchedAt: member.dispatchedAt } : {}), ...(member.receivedAt !== undefined ? { receivedAt: member.receivedAt } : {}),
    ...(member.unreportedNoticeFor !== undefined ? { unreportedNoticeFor: member.unreportedNoticeFor } : {}) }));
  if (!objective.edited) delete out.edited;
  if (!objective.done) delete out.done;
  if (!objective.handoff) delete out.handoff;
  if (!objective.decisionRequest) delete out.decisionRequest;
  if (!objective.decisionRequestRevision) delete out.decisionRequestRevision;
  if (!objective.decisionDelivery) delete out.decisionDelivery;
  if (!objective.decisions?.length) delete out.decisions;
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
  // 기록의 참조는 읽기 전용 describe로 푼다. 화면 조회가 Core access를 호출하지 않는다.
  const operationNode = (id: string): OperationNode | null => options.operations.describe
    ? options.operations.describe(id)?.operation ?? null
    : options.operations.get(id);
  const now = options.now ?? (() => Date.now());
  /**
   * 지금 이 프로세스가 지휘관에게 보내고 있는 답의 요청 id. 저장된 decisionDelivery 는 기동이 끊기면 결과를 모르는 채 남으므로,
   * 대체·철회·정리를 막는 것은 실제로 보내는 동안뿐이다. 남은 표시는 사람의 재전송이나 요청의 정리와 함께 거둔다.
   */
  const delivering = new Set<string>();
  /**
   * 결정 요청의 전제가 바뀌었다 — 요청을 정리하고 revision 을 올린다. 아직 읽지 않은 사람 편집이 남아 있으면 지휘관 도구의
   * board_changed 가 새 요청을 거절한다. 답을 보내는 중인 요청은 사람의 제출이 먼저 받아들여졌으므로 그대로 둔다. 정리된 요청은 결정이 되지 않는다.
   */
  const withoutDecisionRequest = (stored: StoredObjective): StoredObjective => {
    if (!stored.decisionRequest || delivering.has(stored.decisionRequest.id)) return stored;
    return { ...stored, decisionRequest: undefined, decisionDelivery: undefined, decisionRequestRevision: (stored.decisionRequestRevision ?? 0) + 1 };
  };
  /** 질문이 가리키던 임무·구성원이 보드에서 사라졌다 — 그 요청은 더는 같은 질문이 아니다. */
  const withLiveDecisionReferences = (stored: StoredObjective): StoredObjective => {
    const request = stored.decisionRequest;
    if (!request) return stored;
    const missions = new Set(stored.missions.map((mission) => mission.id));
    const members = new Set((stored.members ?? []).map((member) => member.id));
    const dangling = request.questions.some((question) => (question.missionId && !missions.has(question.missionId)) || (question.memberId && !members.has(question.memberId)));
    return dangling ? withoutDecisionRequest(stored) : stored;
  };
  /**
   * 그룹 id 가 이 Theater 의 살아 있는 그룹인가 — 아니면 미분류(null). 그룹을 모르는 호스트(구버전·테스트 스텁)에서는 그대로 둔다.
   * 개시 전 목표의 그룹은 저장 레코드에만 있어 코어의 그룹 삭제가 옮겨 주지 않는다.
   */
  const liveGroup = (theaterId: string, groupId: string | null): string | null => {
    if (!groupId || !options.operations.groups) return groupId;
    return options.operations.groups.get(groupId)?.theaterId === theaterId ? groupId : null;
  };
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
  const theaterIds = (): readonly string[] => [...new Set([...options.operations.list().map((node) => node.theaterId), ...cache.keys(), ...(options.theaterIds?.() ?? [])])];
  /** 첨부 한 자리 — 목표 디렉터리 안인지까지 확인한다(`attachments` 나 그 안의 파일이 링크로 밖을 가리키면 거절). */
  const fileOf = (theaterId: string, objectiveId: string, attachment: Pick<ObjectiveAttachment, "id" | "type">) =>
    containedFile(objectiveDir(theaterId, objectiveId), path.join("attachments", `${dirSegment(attachment.id)}.${ATTACHMENT_TYPES[attachment.type]}`));

  const evidenceDir = (theaterId: string, objectiveId: string) => {
    const dir = objectiveDir(theaterId, objectiveId);
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new ObjectiveStoreError("unsafe_path");
    const evidence = containedFile(dir, "evidence");
    if (fs.existsSync(evidence) && (!fs.lstatSync(evidence).isDirectory() || fs.lstatSync(evidence).isSymbolicLink())) throw new ObjectiveStoreError("unsafe_path");
    return evidence;
  };
  const evidenceFile = (theaterId: string, objectiveId: string, file: EvidenceMetadata) => {
    const candidate = containedFile(evidenceDir(theaterId, objectiveId), `${dirSegment(file.evidenceId)}.${EVIDENCE_EXTENSIONS[file.mediaType]}`);
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new ObjectiveStoreError("unsafe_path");
    return candidate;
  };

  /** 화면 모양 — 저장 레코드와 지휘관 Operation 을 합친다. 담당 세션 이름은 담당 Operation 에서. */
  const project = (stored: StoredObjective, node: OperationNode | null): Objective => {
    const pending = stored.pending;
    if (!node && !pending) throw new ObjectiveStoreError("unknown_objective");
    const launch = node ? readOperationLaunch(node.payload) : { sessionName: pending!.sessionName, model: pending!.model, effort: pending!.effort, viewMode: pending!.viewMode, started: false };
    const addedBy = typeof stored.addedBy === "string" ? { operationId: stored.addedBy, title: operationNode(stored.addedBy)?.title ?? null } : stored.addedBy ?? null;
    const members = (stored.members ?? []).map((member) => {
      const memberNode = node?.childSessions?.find((child) => child.id === member.id);
      const preset = memberNode ? readOperationLaunch(memberNode.payload) : null;
      // 실행값은 세션 좌표 하나다 — 턴 뒤 예약은 그 좌표를 고치지 않고, 「다음 재개」 시절의 옛 기록(held 없음)은 이미 그 좌표가 됐다.
      const stored = memberNode ? storedNext(member.next) : null;
      const legacy = !!stored && !stored.failed && !stored.held;
      // 호스트가 든 턴 뒤 예약은 호스트 좌표를 다시 읽어 아직·적용됨·적용되지 않음을 가른다(저장은 감시자가 한다). 호스트 좌표가 없으면
      // 그새 잠들었거나 터미널로 바뀌었다 — 감시자가 지금 상태에 맞게 다시 걸 때까지 아직이다.
      const host = stored && !stored.failed && stored.held === "host" ? options.coordinates?.(member.id) ?? null : null;
      const held = host ? heldNextOutcome(stored!, host) : null;
      const applied = legacy || held === "applied";
      const next = applied ? null : held === "not_applied" ? { ...stored!, ...notAppliedFailure(stored!, host!) } : stored;
      const memberOutcome = options.observe ? deriveFailedOutcome(options.observe(member.id)) : undefined;
      return { id: member.id, role: member.role, by: member.by, ...(member.brief ? { brief: member.brief } : {}), ...(member.proposal ? { proposal: member.proposal } : {}),
        subagents: member.subagents === true, launch: canonicalStoredLaunch(member.launch) ?? { mode: "route" as const },
        sessionName: preset?.sessionName ?? null, ...(preset?.model ? { model: canonicalModelId(preset.model) } : {}), ...(preset?.effort ? { effort: preset.effort } : {}),
        routed: memberNode && !applied ? storedRouted(member.routed) : null,
        switchesLive: options.liveSwitch === true,
        next: next ? { model: next.model, ...(next.effort ? { effort: next.effort } : {}), failed: next.failed ?? null, ...(next.failed && next.cause ? { cause: next.cause } : {}) } : null,
        ...(memberOutcome ? { outcome: memberOutcome } : {}),
        ...(storedFailure(member.failure) ? { failure: member.failure! } : {}),
        ...(storedUnreported(member.unreported) ? { unreported: member.unreported! } : {}),
        ...(memberNode && lacksReportTool(options.advertisedTools?.(member.id) ?? null) ? { noReportTool: true as const } : {}) };
    });
    const byMember = new Map(members.map((member) => [member.id, member]));
    const recorded = load(node?.theaterId ?? pending!.theaterId).has(stored.operationId);
    // 단계 기록이 생기기 전의 옛 레코드 — 개시 여부는 기동 흔적으로 읽는다. 에이전트 Operation 은 레코드가 있든 없든 모두 목표다.
    const legacy = recorded && !pending && typeof stored.enlisted !== "boolean";
    const commanderOutcome = options.observe ? deriveFailedOutcome(options.observe(stored.operationId)) : undefined;
    return {
      id: stored.operationId,
      theaterId: node?.theaterId ?? pending!.theaterId,
      groupId: node ? node.groupId ?? null : liveGroup(pending!.theaterId, pending!.groupId),
      title: node?.title ?? pending!.title,
      createdAt: node?.ts.createdAt ?? pending!.createdAt,
      commander: { sessionName: launch.sessionName, viewMode: launch.viewMode ?? "terminal", ...(launch.model ? { model: canonicalModelId(launch.model) } : {}), ...(launch.effort ? { effort: launch.effort } : {}), started: launch.started, ...(commanderOutcome ? { outcome: commanderOutcome } : {}) },
      note: stored.note,
      attachments: stored.attachments ?? [],
      results: stored.results ?? [],
      ...(stored.planRequest ? { planRequest: stored.planRequest, planRequestBy: stored.planRequestBy ?? "human" } : {}),
      planning: stored.planning === true,
      criteriaOpen: stored.criteriaOpen === true,
      ...(stored.edited ? { edited: stored.edited } : {}),
      dueDate: stored.dueDate ?? null,
      today: stored.today === true,
      addedBy,
      done: stored.done ? { ...stored.done, by: stored.done.by ?? "human" } : null,
      actions: stored.actions ?? [],
      actionCounts: stored.actionCounts ?? {},
      boardUpdatedAt: stored.boardUpdatedAt ?? node?.ts.createdAt ?? pending!.createdAt,
      stoppedAt: stored.stoppedAt ?? null,
      awaitingHandoff: awaitingHandoff(stored),
      awaitingReview: awaitingReview(stored),
      handoff: stored.handoff ? { by: stored.handoff.by, at: stored.handoff.at, retrospective: stored.handoff.by === "commander" ? stored.handoff.retrospective : null } : null,
      extensions: (stored.extensions ?? []).map((round) => ({ ...round, by: round.by ?? "human" })),
      extensionActive: stored.extensionActive === true,
      criteria: (stored.criteria ?? []).map((criterion) => ({ ...criterion })),
      criteriaProposals: (stored.criteriaProposals ?? []).map((proposal) => ({ ...proposal })),
      members,
      followups: (stored.followups ?? []).map((candidate) => ({
        id: candidate.id, rev: candidate.rev, state: candidate.state, title: candidate.title, summary: candidate.summary, userImpact: candidate.userImpact, fromMission: candidate.fromMission,
        brief: candidate.brief, criteria: [...candidate.criteria], evidence: candidate.evidence.map(evidenceView),
        at: candidate.at, updatedAt: candidate.updatedAt, batchId: candidate.batchId ?? null,
        discarded: candidate.state === "discarded" ? { at: candidate.discardedAt ?? candidate.updatedAt, by: candidate.discardedBy ?? "human" } : null,
      })),
      followupBatches: (stored.followupBatches ?? []).map((batch) => ({
        id: batch.id, at: batch.at, by: batch.by ?? "human",
        items: batch.items.map((entry) => ({
          candidateId: entry.candidateId, rev: entry.rev,
          snapshot: { title: entry.snapshot.title, summary: entry.snapshot.summary, userImpact: entry.snapshot.userImpact, fromMission: entry.snapshot.fromMission, brief: entry.snapshot.brief, criteria: [...entry.snapshot.criteria], evidence: entry.snapshot.evidence.map(evidenceView) },
          // 만든 뒤 사람이 지운 후속은 보기 시점에 「삭제됨」 — 저장은 created 그대로라 복원하면 돌아오고 누계·멱등성은 그대로다.
          state: entry.state === "created" && entry.operationId && !operationNode(entry.operationId) && !((created) => created?.pending && !created.removed)(load(node?.theaterId ?? pending!.theaterId).get(entry.operationId)) ? "deleted" as const : entry.state, operationId: entry.operationId ?? null, error: entry.error ?? null, attempts: entry.attempts, settledAt: entry.settledAt ?? null,
        })),
      })),
      followupHistory: stored.followupHistory ?? null,
      origin: stored.origin ? { objectiveId: stored.origin.objectiveId, title: operationNode(stored.origin.objectiveId)?.title ?? load(node?.theaterId ?? pending!.theaterId).get(stored.origin.objectiveId)?.pending?.title ?? null, candidateId: stored.origin.candidateId, userImpact: stored.origin.userImpact, evidence: stored.origin.evidence.map(evidenceView) } : null,
      decisionRequest: stored.decisionRequest ?? null,
      decisionRequestRevision: stored.decisionRequestRevision ?? 0,
      decisionDelivery: stored.decisionDelivery ? { requestId: stored.decisionDelivery.requestId, at: stored.decisionDelivery.at, by: stored.decisionDelivery.by ?? "human" } : null,
      decisions: (stored.decisions ?? []).map((decision) => ({ ...decision, by: decision.by ?? "human" })),
      recorded,
      removed: stored.removed ? { at: stored.removed.at, expiresAt: stored.removed.at + REMOVED_RETENTION_MS,
        by: stored.removed.by ? tidiedBy(stored.removed.by, stored.removed.byTitle) : null,
        reason: stored.removed.reason ?? null,
        mergedInto: stored.removed.mergedInto ? { id: stored.removed.mergedInto, title: operationNode(stored.removed.mergedInto)?.title ?? load(node?.theaterId ?? pending!.theaterId).get(stored.removed.mergedInto)?.pending?.title ?? null } : null } : null,
      merged: (stored.merged ?? []).map((entry) => ({ sourceId: entry.sourceId, title: entry.title, at: entry.at, by: tidiedBy(entry.by, entry.byTitle), criteriaIds: [...entry.criteriaIds],
        restorable: load(node?.theaterId ?? pending!.theaterId).get(entry.sourceId)?.removed?.mergedInto === stored.operationId })),
      commenced: stored.commenced === true || (legacy && launch.started && stored.planning !== true),
      ...(stored.commencedBy ? { commencedBy: stored.commencedBy } : {}),
      // 불린이 아닌 저장값은 손상이 아니라 「정하지 않음」으로 읽는다 — 이 값 하나로 목표를 격리하지 않는다.
      ...(typeof stored.commodoreOperated === "boolean" ? { commodoreOperated: stored.commodoreOperated } : {}),
      operator: objectiveOperator(stored, (id) => load(node?.theaterId ?? pending!.theaterId).get(id)),
      routingConfirm: stored.routingConfirm !== false,
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
          ...(mission.assignmentTs !== undefined ? { assignmentTs: mission.assignmentTs } : {}),
          ...(mission.unplaced ? { unplaced: true as const } : {}),
          ...(mission.by ? { by: mission.by } : {}),
          operationId: member && options.operations.get(member.id) ? member.id : null,
          sessionName: member?.sessionName ?? null,
          ...(member?.launch.mode === "model" && member.model ? { model: canonicalModelId(member.model) } : {}),
          ...(member?.launch.mode === "model" && member.effort ? { effort: member.effort } : {}),
          records: (mission.records ?? []).map((record, index) => ({ ...record, kind: index === 0 ? "done" as const : "redone" as const })),
          seen: mission.seen ?? 0,
          ...((dispatch) => (dispatch ? { dispatch } : {}))(missionDispatch(mission.assignmentTs, member ? stored.members?.find((entry) => entry.id === member.id) : undefined)),
        };
      }),
    };
  };
  /**
   * 에이전트가 정리할 수 없는 이유 — 기동 전 보드 목표만 받는다. Operation 이 있는 목표는 이미 누군가 일한 자리이고,
   * 완료했거나 이미 지운 목표는 정리할 것이 없다. 받을 수 있으면 null.
   */
  const tidyRefusal = (objectiveId: string): string | null => {
    let found: ReturnType<typeof locate>;
    try { found = locate(objectiveId); } catch { return "unknown_objective"; }
    if (!found.stored.pending) return "has_operation";
    if (found.stored.done) return "objective_done";
    if (found.stored.removed) return "objective_removed";
    return null;
  };
  const tidiedBy = (id: string, byTitle: string | undefined) => ({ operationId: id, title: operationNode(id)?.title ?? byTitle ?? null, ...(id.startsWith(COMMODORE_TIDY_PREFIX) ? { commodore: true as const } : {}) });
  const removal = (at: number, by: TidyActor): StoredRemoval => ({ at, by: by.operationId, ...(by.title ? { byTitle: by.title } : {}), ...(by.reason ? { reason: by.reason.slice(0, MAX_REMOVAL_REASON) } : {}) });
  /** 담당 Operation — 목표가 아니라 목표의 임무를 맡은 세션이다. */
  const memberIds = (objectives: Iterable<StoredObjective>): ReadonlySet<string> => new Set([...objectives].flatMap((entry) => (entry.members ?? []).map((member) => member.id)));
  /** 목표가 되는 Operation 인가 — 이 Theater 의 에이전트 Operation 이고 다른 목표의 담당이 아니다. */
  const objectiveNode = (theaterId: string, operationId: string): OperationNode | null => {
    const node = operationNode(operationId);
    if (!node || node.theaterId !== theaterId || !isObjectiveOperation(node)) return null;
    return memberIds(load(theaterId).values()).has(operationId) ? null : node;
  };
  /** 지휘관 Operation 또는 기동 전 pending 레코드가 있을 때 화면에 선다. */
  const view = (theaterId: string, stored: StoredObjective): Objective | null => {
    const node = objectiveNode(theaterId, stored.operationId);
    return node || stored.pending ? project(stored, node) : null;
  };
  /**
   * 보드 순서 — 레코드가 있든 없든 한 줄이다. 자리는 rank(레코드 없는 목표는 가상 자리) 오름차순, 동률은 만든 시각,
   * 그다음 id 로 가른다. 지휘관 Operation 도 pending 도 없는 레코드(삭제 유예 중)는 보이지 않는다.
   */
  type BoardEntry = { readonly stored: StoredObjective; readonly node: OperationNode | null; readonly bare: boolean; readonly rank: number };
  const visible = (theaterId: string): readonly BoardEntry[] => {
    const objectives = load(theaterId);
    const members = memberIds(objectives.values());
    const references = new Map(options.operations.list().map((node) => [node.id, node]));
    for (const stored of objectives.values()) {
      const node = operationNode(stored.operationId);
      if (node) references.set(node.id, node);
    }
    const present = [...references.values()]
      .filter((node) => node.theaterId === theaterId && isObjectiveOperation(node) && !members.has(node.id))
      .map((node) => {
        const stored = objectives.get(node.id);
        return { stored: stored ?? bareRecord(node.id), node, bare: !stored, rank: stored ? stored.rank : virtualRank(node) };
      });
    const pending = [...objectives.values()].filter((stored) => stored.pending?.theaterId === theaterId && !operationNode(stored.operationId)).map((stored) => ({ stored, node: null, bare: false, rank: stored.rank }));
    return [...present, ...pending].sort((a, b) => a.rank - b.rank || (a.node?.ts.createdAt ?? a.stored.pending?.createdAt ?? 0) - (b.node?.ts.createdAt ?? b.stored.pending?.createdAt ?? 0) || a.stored.operationId.localeCompare(b.stored.operationId));
  };
  /** 방송에 싣는 보드 줄 — 화면이 서버의 순서를 그대로 따를 수 있게 보이는 목표 전부를 싣는다. */
  const boardOrder = (theaterId: string): readonly string[] => visible(theaterId).map((entry) => entry.stored.operationId);

  /** 목표 하나 — 레코드가 없으면(따로 만든 Operation) 빈 목표이고 `recorded` 는 false 다. */
  const locate = (objectiveId: string): { theaterId: string; recorded: boolean; stored: StoredObjective; node: OperationNode | null } => {
    const found = operationNode(objectiveId);
    const node = found ? objectiveNode(found.theaterId, objectiveId) : null;
    const theaterId = node?.theaterId ?? theaterIds().find((id) => load(id).get(objectiveId)?.pending);
    if (!theaterId) throw new ObjectiveStoreError("unknown_objective");
    const stored = load(theaterId).get(objectiveId);
    return { theaterId, recorded: !!stored, stored: stored ?? bareRecord(objectiveId), node };
  };

  /** 자리가 바뀐 뒤의 방송 — 지금 캐시가 말하는 줄을 그대로 실어 화면이 서버와 같은 순서를 본다. */
  const announce = (theaterId: string, stored: StoredObjective): Objective | null => {
    const objective = view(theaterId, stored);
    if (objective) options.emit({ op: "upsert", theaterId, objectiveId: objective.id, objective, order: boardOrder(theaterId) });
    return objective;
  };

  /** 쓰기 한 곳 — 그 목표의 파일 한 건이 성공한 뒤에 캐시를 갈고, 마지막에 방송한다. */
  const commit = (theaterId: string, changed: StoredObjective, reordered = false, touch = true): Objective | null => {
    if (touch) changed = { ...changed, boardUpdatedAt: now() };
    writeObjectiveAtomic(objectiveDir(theaterId, changed.operationId), changed);
    load(theaterId).set(changed.operationId, changed);
    if (reordered) return announce(theaterId, changed);
    const objective = view(theaterId, changed);
    if (objective) options.emit({ op: "upsert", theaterId, objectiveId: objective.id, objective });
    return objective;
  };

  const action = (stored: StoredObjective, by: ObjectiveActor, kind: ObjectiveAction["kind"], details: Pick<ObjectiveAction, "targetId" | "proposal" | "kinds" | "handoff"> = {}): StoredObjective => ({
    ...stored,
    actions: [...(stored.actions ?? []), { id: randomUUID(), at: now(), by, kind, ...details }].slice(-MAX_OBJECTIVE_ACTIONS),
    actionCounts: { ...stored.actionCounts, [kind]: (stored.actionCounts?.[kind] ?? 0) + 1 },
  });

  /** 구성원을 담은 저장 목표 — 실패·턴 좌표 같은 구성원 상태를 그 목표 파일에 둔다. 없으면(제거됨) null. */
  const memberOwner = (memberId: string): StoredObjective | null => {
    for (const theaterId of theaterIds()) for (const stored of load(theaterId).values()) if ((stored.members ?? []).some((member) => member.id === memberId)) return stored;
    return null;
  };
  const locateStored = (objectiveId: string) => locate(objectiveId);
  const storedMemberOf = (memberId: string): StoredMember | undefined => memberOwner(memberId)?.members?.find((member) => member.id === memberId);
  /** 구성원 상태 쓰기 — 보드 변경 시각을 미루지 않는다(무보고 계산은 도메인 변경만 센다). 제거된 구성원이면 아무것도 쓰지 않는다. */
  const updateMember = (memberId: string, mutate: (member: StoredMember) => StoredMember) => {
    const owner = memberOwner(memberId);
    if (!owner) return;
    // 지휘관 Operation 이 이미 지워진 목표(정리 중)는 쓸 화면이 없다 — 구성원 상태를 거두는 호출이 정리를 막지 않게 건너뛴다.
    try { locateStored(owner.operationId); } catch (error) { if (error instanceof ObjectiveStoreError && error.code === "unknown_objective") return; throw error; }
    update(owner.operationId, (stored) => {
      const members = stored.members ?? [];
      const at = members.findIndex((member) => member.id === memberId);
      if (at < 0) return stored;
      const changed = mutate(members[at]!);
      if (changed === members[at] || JSON.stringify(changed) === JSON.stringify(members[at])) return stored;
      return { ...stored, members: members.map((member, ix) => (ix === at ? changed : member)) };
    }, false);
  };
  const update = (objectiveId: string, mutate: (stored: StoredObjective) => StoredObjective, touch = true): Objective => {
    const { theaterId, recorded, stored, node } = locate(objectiveId);
    // 인계 기록은 할 일이 끝난 동안에만 산다 — 기준 표시를 거두는 변경이 곧 인계를 거두고 목표를 진행 중으로 돌린다.
    const mutated = withLiveDecisionReferences(withValidHandoff(mutate(stored)));
    if (mutated === stored) return project(stored, node);
    if (mutated.missions.length > MAX_MISSIONS) throw new ObjectiveStoreError("too_many_missions");
    if (hasCycle(graphOf(mutated.missions))) throw new ObjectiveStoreError("dependency_cycle");
    // 선행이 바뀌면 임무도 편성 순으로 다시 선다 — 목록·번호·지휘관 도구의 n 이 편성과 같은 순서를 말한다.
    const missions = lineupOrder(mutated.missions);
    const sorted = missions === mutated.missions ? mutated : { ...mutated, missions: [...missions] };
    // 옛 레코드에서 구상 표시는 「개시 전」의 유일한 흔적이다 — 그것을 지우는 편집(개시·중지·완료)이 새 판 표지를 먼저 굳힌다.
    // 그러지 않으면 중지나 실패한 개시 뒤에 옛 판정(started && !planning)이 개시한 목표로 읽는다.
    // 옛 판(enlisted:false)으로 저장된 레코드는 편집하는 김에 새 판(true)으로 고쳐 쓴다 — 읽기는 이미 목표로 한다.
    const ordered = typeof stored.enlisted !== "boolean" && typeof sorted.enlisted !== "boolean" && stored.planning === true && sorted.planning !== true ? { ...sorted, enlisted: true }
      : sorted.enlisted === false ? { ...sorted, enlisted: true } : sorted;
    // 따로 만든 Operation 의 첫 편집 — 여기서 레코드가 된다. 지금 서 있는 가상 자리를 그대로 굳혀 자리가 흔들리지 않게
    // 하고, 그래도 화면이 서버와 어긋나지 않도록 보드 줄을 함께 방송한다.
    const next = recorded ? ordered : { ...ordered, rank: virtualRank(node!), enlisted: true };
    return commit(theaterId, next, !recorded, touch) ?? project(next, node);
  };

  const resultChecked = <T>(run: () => T): T => {
    try { return run(); }
    catch (error) { if (error instanceof ResultValidationError) throw new ObjectiveStoreError(error.code); throw error; }
  };
  const makeResult = (objectiveId: string, input: ResultInput, previous?: ObjectiveResult): ObjectiveResult => {
    const at = now();
    const common = { id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? at, updatedAt: at,
      ...(input.label ? { label: input.label } : {}), ...(input.note ? { note: input.note } : {}), ...(input.sourceMissionId ? { sourceMissionId: input.sourceMissionId } : {}) };
    switch (input.kind) {
      case "pr": return { ...common, kind: "pr", ...prTarget(input.url), observation: previous?.kind === "pr" && previous.url === input.url ? previous.observation : { state: "unchecked", checkedAt: null, stale: true } };
      case "artifact": return { ...common, kind: "artifact", ...artifactTarget(input.url) };
      case "evidence": {
        // label만 고칠 때는 이미 보존된 bytes를 다시 수입하지 않는다. 새 id는 seal 서비스가 확인한다.
        const metadata = previous?.kind === "evidence" && previous.evidenceId === input.evidenceId
          ? { evidenceId: previous.evidenceId, name: previous.name, mediaType: previous.mediaType, bytes: previous.bytes, sha256: previous.sha256, capturedAt: previous.capturedAt, ...(previous.width ? { width: previous.width } : {}), ...(previous.height ? { height: previous.height } : {}) }
          : (() => {
            const { theaterId, stored } = locate(objectiveId);
            const sealed = stored.evidence?.find((entry) => entry.evidenceId === input.evidenceId);
            if (!sealed) return null;
            const attached = stored.results?.some((entry) => entry.kind === "evidence" && entry.evidenceId === sealed.evidenceId);
            if (!attached && now() - sealed.capturedAt > RESULT_LIMITS.pendingEvidenceTtlMs) throw new ObjectiveStoreError("evidence_expired");
            const file = evidenceFile(theaterId, objectiveId, sealed);
            if (!fs.existsSync(file)) throw new ObjectiveStoreError("evidence_missing");
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== sealed.bytes) throw new ObjectiveStoreError("invalid_evidence");
            const { ownerOperationId: _owner, ...metadata } = sealed;
            return metadata;
          })();
        if (!metadata) throw new ObjectiveStoreError("unknown_evidence");
        const parsed = evidenceMetadataSchema.safeParse(metadata);
        if (!parsed.success || parsed.data.evidenceId !== input.evidenceId) throw new ObjectiveStoreError("invalid_evidence");
        return { ...common, kind: "evidence", ...parsed.data };
      }
    }
  };
  const checkedResults = (results: readonly ObjectiveResult[]): readonly ObjectiveResult[] => {
    if (results.length > RESULT_LIMITS.count) throw new ObjectiveStoreError("too_many_results");
    const evidence = results.filter((entry) => entry.kind === "evidence");
    if (evidence.length > RESULT_LIMITS.evidenceCount || evidence.reduce((total, entry) => total + entry.bytes, 0) > RESULT_LIMITS.totalEvidenceBytes) throw new ObjectiveStoreError("evidence_capacity");
    const parsed = storedResultsSchema.safeParse(results);
    if (!parsed.success) throw new ObjectiveStoreError("invalid_results");
    return parsed.data;
  };
  const assertResultTarget = (stored: StoredObjective, input: ResultInput | ObjectiveResult, replacing?: ObjectiveResult) => {
    if (stored.done) throw new ObjectiveStoreError("objective_done");
    // 기존 기록의 임무가 지워져도 결과물은 남는다. 새로 연결하는 임무만 현재 목표 안에서 확인한다.
    if (input.sourceMissionId && input.sourceMissionId !== replacing?.sourceMissionId && !stored.missions.some((mission) => mission.id === input.sourceMissionId)) throw new ObjectiveStoreError("unknown_mission");
    const duplicate = stored.results?.find((entry) => entry.id !== replacing?.id && resultIdentity(entry) === resultIdentity(input));
    if (duplicate) throw new ObjectiveStoreError("result_exists", undefined, { resultId: duplicate.id });
  };

  const sweepEvidence = (objectiveId: string) => {
    let { theaterId, stored } = locate(objectiveId);
    const recordDir = objectiveDir(theaterId, objectiveId);
    // 격리된 레코드가 참조하던 bytes는 고아로 단정하지 않는다. 복구 원본을 보존하고 그 목표의 새 seal만 닫는다.
    if (fs.existsSync(recordDir) && fs.readdirSync(recordDir).some((name) => name.startsWith(`${OBJECTIVE_FILE}.broken-`))) throw new ObjectiveStoreError("evidence_storage_quarantined");
    const linked = new Set((stored.results ?? []).flatMap((entry) => entry.kind === "evidence" ? [entry.evidenceId] : []));
    const retained = (stored.evidence ?? []).filter((entry) => linked.has(entry.evidenceId) || now() - entry.capturedAt <= RESULT_LIMITS.pendingEvidenceTtlMs);
    if (retained.length !== (stored.evidence ?? []).length) {
      update(objectiveId, (current) => ({ ...current, evidence: retained }), false);
      stored = locate(objectiveId).stored;
    }
    const dir = evidenceDir(theaterId, objectiveId);
    if (!fs.existsSync(dir)) return;
    const wanted = new Set((stored.evidence ?? []).map((entry) => path.basename(evidenceFile(theaterId, objectiveId, entry))));
    for (const entry of fs.readdirSync(dir)) {
      // 자체 UUID bytes와 중단된 exclusive-write tmp만 정리한다. 낯선 파일·디렉터리는 건드리지 않는다.
      if (wanted.has(entry) || !/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif|txt)(?:\.\d+-[a-f0-9-]{36}\.tmp)?$/.test(entry)) continue;
      const file = path.join(dir, entry);
      if (fs.lstatSync(file).isDirectory()) throw new ObjectiveStoreError("unsafe_path");
      fs.unlinkSync(file);
    }
  };
  const cleanEvidence = (objectiveId: string) => { try { sweepEvidence(objectiveId); } catch { console.warn("[objectives] evidence_cleanup_failed"); } };

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
  const placed = (mission: StoredMission): StoredMission => (mission.unplaced ? (({ unplaced: _unplaced, ...rest }) => ({ ...rest, by: mission.by ?? "human" }))(mission) : mission);
  const withoutAssignment = (mission: StoredMission): StoredMission => {
    if (mission.assignmentTs === undefined && mission.quietWokenFor === undefined) return mission;
    const { assignmentTs: _assignmentTs, quietWokenFor: _quietWokenFor, ...rest } = mission;
    return rest;
  };
  const assignmentNoted = (objectiveId: string) => { options.onAssignment?.(objectiveId); };
  const withoutEdge = (mission: StoredMission, id: string): StoredMission => ({ ...mission, prerequisites: mission.prerequisites.filter((edge) => edge.id !== id) });
  const proposalsOf = (stored: StoredObjective, input: readonly CriterionProposalInput[]): readonly ObjectiveCriterionProposal[] => {
    const criteria = stored.criteria ?? [];
    const added = input.filter((proposal) => "text" in proposal && !("revise" in proposal)).length;
    if (criteria.length + added > MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria");
    const targets = new Set<string>();
    return input.map((proposal): ObjectiveCriterionProposal => {
      const id = randomUUID();
      if (!("revise" in proposal) && !("retire" in proposal) && !("recheck" in proposal)) return { id, kind: "add", text: proposal.text };
      const reference = "revise" in proposal ? proposal.revise : "retire" in proposal ? proposal.retire : proposal.recheck;
      if ("recheck" in proposal && !stored.extensionActive) throw new ObjectiveStoreError("recheck_not_extension");
      const target = typeof reference === "number" ? criteria[reference - 1] : criteria.find((criterion) => criterion.id === reference);
      if (!target) throw new ObjectiveStoreError("unknown_criterion");
      if ("recheck" in proposal && (!target.met || !stored.extensions!.at(-1)!.criterionIds.includes(target.id))) throw new ObjectiveStoreError("criterion_not_recheckable");
      if (targets.has(target.id)) throw new ObjectiveStoreError("duplicate_criterion_proposal");
      targets.add(target.id);
      return "revise" in proposal
        ? { id, kind: "revise", target: target.id, text: proposal.text }
        : { id, kind: "retire" in proposal ? "retire" : "recheck", target: target.id, reason: proposal.reason };
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
      : criteria.map((criterion) => criterion.id === proposal.target ? (({ met: _met, ...rest }) => ({ ...rest, ...(proposal.kind === "revise" ? { text: proposal.text! } : {}) }))(criterion) : criterion) };
  };

  const extended = (stored: StoredObjective, context: string, by: ObjectiveActor = "human"): StoredObjective => {
    if (stored.removed) throw new ObjectiveStoreError("objective_removed");
    if (!stored.done && !awaitingReview(stored)) throw new ObjectiveStoreError("not_in_review");
    const request = context.trim();
    if (!request || request.length > MAX_CONTEXT) throw new ObjectiveStoreError("invalid_request");
    const extensions = stored.extensions ?? [];
    return { ...action(withoutDecisionRequest(stored), by, "extend"), done: undefined, handoff: undefined, operationIntent: undefined,
      planning: true, criteriaOpen: true, planRequest: request, planRequestBy: by, extensionActive: true,
      extensions: [...extensions, { n: extensions.length + 1, at: now(), by, context: request,
        missionIds: stored.missions.map((mission) => mission.id), criterionIds: (stored.criteria ?? []).map((criterion) => criterion.id), previousHandoff: stored.handoff ?? null }],
    };
  };

  const store: ObjectiveStore = {
    list: (theaterId) => visible(theaterId).map(({ stored, node }) => project(stored, node)),
    all: () => theaterIds().flatMap((theaterId) => store.list(theaterId)),
    find: (objectiveId) => { try { const { stored, node } = locate(objectiveId); return project(stored, node); } catch { return null; } },
    sharedDir(theaterId, objectiveId) {
      const dir = containedFile(objectiveDir(theaterId, objectiveId), "shared");
      // 증거의 신뢰 디렉터리는 목표가 소유한다 — 기동 환경과 무관하게, 처음 물을 때 만든다.
      try { if (fs.lstatSync(dir).isSymbolicLink()) throw new ObjectiveStoreError("unsafe_path"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      return realOf(dir);
    },
    findMember(operationId) {
      for (const objective of store.all()) {
        const member = objective.members.find((candidate) => candidate.id === operationId);
        if (member) return { objective, memberId: member.id, missionId: objective.missions.find((mission) => mission.member === member.id)?.id ?? null };
      }
      return null;
    },

    adopt(operationId, init, pending) {
      const node = operationNode(operationId);
      if (!pending && (!node || !isObjectiveOperation(node))) throw new ObjectiveStoreError("unknown_operation");
      const theaterId = pending?.theaterId ?? node!.theaterId;
      if (load(theaterId).has(operationId)) throw new ObjectiveStoreError("already_objective");
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
        rank: bottomRank(theaterId),
        ...(pending ? { pending: { ...pending, groupId: liveGroup(theaterId, pending.groupId) } } : {}),
        note: init.note ?? "",
        ...(init.dueDate ? { dueDate: init.dueDate } : {}),
        ...(init.today ? { today: true as const } : {}),
        ...(init.addedBy ? { addedBy: init.addedBy } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
        // 사령관이 고른 후속은 태어날 때 사령관 운영으로 적는다 — 원본이 영구 삭제되면 대체 판정(원본의 배치)을 더는 읽을 수 없다.
        ...(init.origin && typeof init.by === "object" && init.by.kind === "commodore" ? { commodoreOperated: true } : {}),
        ...(criteriaTexts.length ? { criteria: criteriaTexts.map((text) => ({ id: randomUUID(), text, by: init.by ?? "human" })) } : {}),
        enlisted: true,
        missions: [...lineupOrder(missions)],
      };
      return commit(theaterId, stored, true) ?? project(stored, node);
    },

    releaseGroups(scope) {
      let released = 0;
      for (const theaterId of scope ? [scope.theaterId] : theaterIds()) {
        const stale = (groupId: string | null | undefined): boolean => !!groupId && (scope ? groupId === scope.groupId : liveGroup(theaterId, groupId) === null);
        for (const stored of [...load(theaterId).values()]) {
          const batches = stored.followupBatches ?? [];
          const pendingStale = stale(stored.pending?.groupId);
          if (!pendingStale && !batches.some((batch) => stale(batch.launch.groupId))) continue;
          commit(theaterId, {
            ...stored,
            ...(pendingStale ? { pending: { ...stored.pending!, groupId: null } } : {}),
            ...(batches.length ? { followupBatches: batches.map((batch) => (stale(batch.launch.groupId) ? { ...batch, launch: { ...batch.launch, groupId: null } } : batch)) } : {}),
          });
          released += 1;
        }
      }
      return released;
    },

    pending(objectiveId) { try { return locate(objectiveId).stored.pending ?? null; } catch { return null; } },
    patchPending: (objectiveId, patch) => update(objectiveId, (stored) => {
      if (!stored.pending) throw new ObjectiveStoreError("unknown_objective");
      return { ...stored, pending: { ...stored.pending, ...patch } };
    }),
    launched: (objectiveId) => update(objectiveId, (stored) => {
      if (!stored.pending) return stored;
      const { pending: _pending, ...rest } = stored;
      return rest;
    }),
    removePending(objectiveId) {
      const { theaterId, stored, node } = locate(objectiveId);
      if (node || !stored.pending) throw new ObjectiveStoreError("unknown_objective");
      fs.rmSync(objectiveDir(theaterId, objectiveId), { recursive: true, force: true });
      load(theaterId).delete(objectiveId);
      options.emit({ op: "remove", theaterId, objectiveId });
      // 받은 목표의 되돌리기 가능 여부는 원본이 남아 있는지에서 나온다 — 비우기·보관 기한 어느 쪽으로 지워도 열린 보드가 곧바로 알게 다시 방송한다.
      for (const target of load(theaterId).values()) if (target.merged?.some((entry) => entry.sourceId === objectiveId)) announce(theaterId, target);
    },
    tidyRemove(objectiveIds, by) {
      const unique = [...new Set(objectiveIds)];
      const refusals = unique.flatMap((id) => { const reason = tidyRefusal(id); return reason ? [{ objectiveId: id, reason }] : []; });
      if (refusals.length) throw new ObjectiveStoreError("tidy_refused", undefined, { refusals });
      const at = now();
      return unique.map((id) => update(id, (stored) => ({ ...stored, removed: removal(at, by) })));
    },
    tidyMerge(targetId, sourceIds, by) {
      const sources = [...new Set(sourceIds)];
      if (sources.includes(targetId)) throw new ObjectiveStoreError("merge_into_self");
      const refusals: { objectiveId: string; reason: string; kinds?: readonly string[] }[] = [targetId, ...sources].flatMap((id) => { const reason = tidyRefusal(id); return reason ? [{ objectiveId: id, reason }] : []; });
      // 원본에만 있고 브리핑·기준으로 옮길 수 없는 것 — 합치면 사람의 보드에서 조용히 사라진다.
      // 합치기는 한 보드 안에서만 — 다른 Theater 의 목표를 옮기면 원본 보드가 받은 목표를 가리킬 수 없다.
      const targetTheater = refusals.some((entry) => entry.objectiveId === targetId) ? null : locate(targetId).theaterId;
      for (const id of sources) {
        if (refusals.some((entry) => entry.objectiveId === id)) continue;
        if (targetTheater && locate(id).theaterId !== targetTheater) { refusals.push({ objectiveId: id, reason: "other_theater" }); continue; }
        const stored = locate(id).stored;
        const kept = ([["missions", stored.missions.length], ["members", stored.members?.length ?? 0], ["attachments", stored.attachments?.length ?? 0], ["results", stored.results?.length ?? 0], ["followups", stored.followups?.length ?? 0], ["merged", stored.merged?.length ?? 0]] as const).filter(([, count]) => count > 0).map(([kind]) => kind);
        if (kept.length) refusals.push({ objectiveId: id, reason: "merge_would_drop", kinds: kept });
      }
      if (refusals.length) throw new ObjectiveStoreError("tidy_refused", undefined, { refusals });
      const at = now();
      const target = locate(targetId).stored;
      let note = target.note;
      const criteria = [...(target.criteria ?? [])];
      const merged: StoredMerge[] = [];
      for (const id of sources) {
        const { stored, node } = locate(id);
        const title = project(stored, node).title;
        // 출처가 보이게 제목을 머리에 두고 원본 브리핑을 그대로 잇는다 — 되돌릴 때 이 구간 그대로를 찾는다.
        const noteBlock = `${note ? "\n\n" : ""}---\n\n**${title}**${stored.note ? `\n\n${stored.note}` : ""}`;
        note += noteBlock;
        const criteriaIds: string[] = [];
        for (const criterion of stored.criteria ?? []) {
          if (criteria.some((existing) => existing.text === criterion.text)) continue;
          const moved = { id: randomUUID(), text: criterion.text, by: criterion.by };
          criteria.push(moved);
          criteriaIds.push(moved.id);
        }
        merged.push({ sourceId: id, title, at, by: by.operationId, ...(by.title ? { byTitle: by.title } : {}), noteBlock, criteriaIds });
      }
      if (note.length > MAX_NOTE) throw new ObjectiveStoreError("note_too_long", undefined, { limit: MAX_NOTE });
      if (criteria.length > MAX_CRITERIA) throw new ObjectiveStoreError("too_many_criteria", undefined, { limit: MAX_CRITERIA });
      const result = update(targetId, (stored) => ({ ...stored, note, criteria, merged: [...(stored.merged ?? []), ...merged] }));
      for (const id of sources) update(id, (stored) => ({ ...stored, removed: { ...removal(at, by), mergedInto: targetId } }));
      return result;
    },
    trash(objectiveId) {
      const { stored } = locate(objectiveId);
      if (!stored.pending || stored.removed) throw new ObjectiveStoreError("unknown_objective");
      return update(objectiveId, (current) => ({ ...current, removed: { at: now() } }));
    },
    purgeRemoved() {
      const purged: string[] = [];
      for (const theaterId of theaterIds()) {
        for (const stored of [...load(theaterId).values()]) {
          if (!stored.pending || !stored.removed || now() - stored.removed.at < REMOVED_RETENTION_MS) continue;
          try { store.removePending(stored.operationId); purged.push(stored.operationId); }
          catch { console.warn("[objectives] removed_purge_failed"); }
        }
      }
      return purged;
    },
    tidyRestore(objectiveId) {
      const { stored } = locate(objectiveId);
      if (!stored.removed) throw new ObjectiveStoreError("not_removed");
      const targetId = stored.removed.mergedInto;
      // 받은 목표가 아직 기동 전·미완료 보드 목표일 때 덧붙인 구간과 옮긴 기준을 걷어 낸다. 받은 목표도 지워져 있으면 그대로 걷어 두어,
      // 어느 쪽을 먼저 되돌려도 내용이 겹치지 않는다. 그사이 기동·완료됐으면 그대로 둔다.
      const target = targetId ? (() => { try { return locate(targetId); } catch { return null; } })() : null;
      if (target && target.stored.pending && !target.stored.done) {
        update(targetId!, (current) => {
          const entry = current.merged?.find((candidate) => candidate.sourceId === objectiveId);
          if (!entry) return current;
          const at = current.note.lastIndexOf(entry.noteBlock);
          const note = at >= 0 ? current.note.slice(0, at) + current.note.slice(at + entry.noteBlock.length) : current.note;
          // 옮긴 기준 가운데 원본과 같은 문장으로 남은 것만 걷는다 — 사람이 고친 기준은 받은 목표의 것이 됐다.
          // 아직 합쳐져 있는 다른 원본이 같은 문장을 가져왔으면(같은 문장은 한 번만 옮겨진다) 그 기준을 남기고 그 원본의 몫으로 넘긴다 —
          // 그 원본을 되돌릴 때 함께 걷히게.
          const moved = new Set(entry.criteriaIds);
          const original = new Set((stored.criteria ?? []).map((criterion) => criterion.text));
          const sourceTexts = (sourceId: string) => new Set((load(target.theaterId).get(sourceId)?.criteria ?? []).map((criterion) => criterion.text));
          let remaining = current.merged!.filter((candidate) => candidate !== entry);
          const criteria = (current.criteria ?? []).filter((criterion) => {
            if (!moved.has(criterion.id) || !original.has(criterion.text)) return true;
            const heir = remaining.find((other) => sourceTexts(other.sourceId).has(criterion.text));
            if (!heir) return false;
            remaining = remaining.map((other) => (other === heir ? { ...other, criteriaIds: [...other.criteriaIds, criterion.id] } : other));
            return true;
          });
          return { ...current, note, criteria, merged: remaining };
        });
      }
      return update(objectiveId, ({ removed: _removed, ...rest }) => rest);
    },
    patch: (objectiveId, input) => update(objectiveId, (stored) => ({
      ...stored,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.planRequest !== undefined ? { planRequest: input.planRequest, planRequestBy: input.planRequestBy ?? "human" } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? undefined } : {}),
      ...(input.today !== undefined ? { today: input.today ? true as const : undefined } : {}),
      ...(input.routingConfirm !== undefined ? { routingConfirm: input.routingConfirm ? undefined : false as const } : {}),
    })),

    memberFailure: (memberId) => storedFailure(storedMemberOf(memberId)?.failure),
    settleMemberFailure(memberId, failure) {
      let state: ObjectiveMemberFailure | undefined;
      updateMember(memberId, (member) => {
        const { failure: previous, ...rest } = member;
        if (!failure) return previous === undefined ? member : rest;
        state = { ...failure, consecutiveFailures: (storedFailure(previous)?.consecutiveFailures ?? 0) + 1 };
        return { ...rest, failure: state };
      });
      return state;
    },
    settleMemberUnreported(memberId, unreported) {
      updateMember(memberId, (member) => {
        const { unreported: previous, ...rest } = member;
        if (!unreported) return previous === undefined ? member : rest;
        return { ...rest, unreported };
      });
    },
    acknowledgeMemberFailure(memberId) {
      updateMember(memberId, (member) => ({
        ...member,
        ...(member.failure ? { failure: { ...member.failure, acknowledged: true as const } } : {}),
        ...(member.unreported ? { unreported: { ...member.unreported, acknowledged: true as const } } : {}),
      }));
    },
    recordMemberNotificationFailure(memberId, notificationFailure, signal = "failure") {
      updateMember(memberId, (member) => signal === "unreported"
        ? (member.unreported ? { ...member, unreported: { ...member.unreported, notificationFailure } } : member)
        : (member.failure ? { ...member, failure: { ...member.failure, notificationFailure } } : member));
    },
    memberTurn: (memberId) => storedTurn(storedMemberOf(memberId)?.settledTurn),
    setMemberTurn(memberId, turn) {
      updateMember(memberId, (member) => ({ ...member, settledTurn: { ...(turn.generation !== undefined ? { generation: turn.generation } : {}), revision: turn.revision } }));
    },
    memberDelivered: (memberId) => { const at = storedMemberOf(memberId)?.deliveredAt; return typeof at === "number" && Number.isFinite(at) ? at : undefined; },
    setMemberDelivered(memberId, at) {
      updateMember(memberId, (member) => ({ ...member, deliveredAt: at }));
    },
    recordDispatch(memberId, at) {
      updateMember(memberId, (member) => ({ ...member, dispatchedAt: at }));
    },
    memberDispatch(memberId) {
      const member = storedMemberOf(memberId);
      return member ? missionDispatch(undefined, member) : null;
    },
    unreportedNoticeFor: (memberId) => { const at = storedMemberOf(memberId)?.unreportedNoticeFor; return typeof at === "number" && Number.isFinite(at) ? at : undefined; },
    setUnreportedNoticeFor(memberId, at) {
      updateMember(memberId, (member) => ({ ...member, unreportedNoticeFor: at }));
    },
    recordReceipt(memberId, at) {
      updateMember(memberId, (member) => ({ ...member, receivedAt: at }));
    },
    refresh(operationId) {
      const node = operationNode(operationId);
      if (!node) {
        for (const theaterId of theaterIds()) {
          const stored = load(theaterId).get(operationId);
          if (stored?.pending) announce(theaterId, stored);
        }
        return;
      }
      if (objectiveNode(node.theaterId, operationId)) {
        const stored = load(node.theaterId).get(operationId) ?? bareRecord(operationId);
        options.emit({ op: "upsert", theaterId: node.theaterId, objectiveId: operationId, objective: project(stored, node) });
        return;
      }
      // 담당 Operation 이 바뀌었다(세션 이름 등) — 그 임무가 있는 목표를 다시 방송한다.
      for (const owner of load(node.theaterId).values()) {
        if (!(owner.members ?? []).some((member) => member.id === operationId)) continue;
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
        // 세션이 사라져도 구성원 id와 역할은 남는다. 다음 개시가 같은 id로 다시 만들 수 있다.
        for (const owner of objectives.values()) {
          if (!(owner.members ?? []).some((member) => member.id === operationId)) continue;
          const projected = view(theaterId, owner);
          if (projected) options.emit({ op: "upsert", theaterId, objectiveId: projected.id, objective: projected });
        }
      }
    },

    move(objectiveId, anchor) {
      const { theaterId, stored, node } = locate(objectiveId);
      const anchorId = "beforeId" in anchor ? anchor.beforeId : anchor.afterId;
      if (anchorId === objectiveId) return project(stored, node);
      const board = visible(theaterId).filter((entry) => entry.stored.operationId !== objectiveId);
      const target = board.findIndex((entry) => entry.stored.operationId === anchorId);
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
    complete: (objectiveId, operationIntent, by = "human") => update(objectiveId, (stored) => {
      if (stored.done) return stored;
      // 인계 대기는 넘기기를 거쳐야 완료된다. 남은 후보가 있으면 고르지 않은 완료도 후보 검토의 경계를 지난다 —
      // 그 밖의(진행 중이며 후보가 없는) 목표의 완료는 지금 그대로다.
      if (awaitingHandoff(stored) || (stored.followups ?? []).some((candidate) => candidate.state === "open")) assertReviewable(stored);
      return { ...action(withoutDecisionRequest(stored), by, "complete"), done: { at: now(), by }, planning: undefined, criteriaOpen: undefined, extensionActive: undefined, operationIntent };
    }),
    reopen: (objectiveId, operationIntent, by = "human") => update(objectiveId, (stored) => (stored.done ? { ...action(stored, by, "reopen"), done: undefined, operationIntent } : stored)),
    extend: (objectiveId, context, operationIntent, by = "human") => update(objectiveId, (stored) => {
      const next = extended(stored, context, by);
      // 완료 표시는 복원이 성공하기 전까지 남긴다. 재시작도 같은 의도를 적용한다.
      return operationIntent ? { ...stored, operationIntent: { ...operationIntent, extensionContext: context.trim(), by } } : next;
    }),
    operationIntent: (objectiveId) => { try { return locate(objectiveId).stored.operationIntent; } catch (error) { if (error instanceof ObjectiveStoreError && error.code === "unknown_objective") return undefined; throw error; } },
    acknowledgeOperationIntent(objectiveId, requestId) {
      update(objectiveId, (stored) => stored.operationIntent?.requestId === requestId
        ? stored.operationIntent.extensionContext !== undefined ? extended(stored, stored.operationIntent.extensionContext, stored.operationIntent.by) : { ...stored, operationIntent: undefined }
        : stored);
    },
    handOff: (objectiveId, input) => update(objectiveId, (stored) => {
      if (!awaitingHandoff(stored)) throw new ObjectiveStoreError("not_awaiting_handoff");
      const at = now();
      const handoff: StoredHandoff = input.by === "commander" ? { by: "commander", at, retrospective: input.retrospective } : { by: input.by, at };
      return { ...action(stored, input.by, "hand-off", { handoff }), extensionActive: undefined, handoff };
    }),

    missionAdd: (objectiveId, input, addOptions) => {
      const added = update(objectiveId, (stored) => {
      const known = new Set(stored.missions.map((mission) => mission.id));
      const prerequisites = (input.prerequisites ?? []).filter((id) => known.has(id)).map((id): StoredEdge => ({ id, ...(input.why?.[id] ? { why: input.why[id] } : {}) }));
      // 선행을 함께 준 추가는 이미 자리가 있다 — 미분류는 선행 없이 더한 사람의 임무뿐이다.
      const unplaced = addOptions?.unplaced === true && input.prerequisites === undefined;
      if (input.member && !(stored.members ?? []).some((member) => member.id === input.member)) throw new ObjectiveStoreError("unknown_member");
      const mission: StoredMission = { id: randomUUID(), text: input.text, prerequisites, ...(input.member ? { member: input.member, assignmentTs: now() } : {}), ...(addOptions?.by && input.member !== undefined ? { memberBy: addOptions.by } : {}), ...(unplaced ? { unplaced: true as const } : {}), ...(addOptions?.by ? { by: addOptions.by } : {}) };
      // 새 일이 생겼다 — 앞선 충족 판단은 옛 보드에 대한 것이다.
      return withoutMet({ ...stored, missions: [...stored.missions, mission] });
      });
      if (input.member) assignmentNoted(objectiveId);
      return added;
    },

    missionPatch: (objectiveId, missionId, input, patchOptions) => {
      let assigned = false;
      let reopened = false;
      const patched = update(objectiveId, (stored) => {
      const { at, mission } = missionOf(stored, missionId);
      const known = new Set(stored.missions.map((candidate) => candidate.id));
      const why = (id: string) => input.why?.[id] ?? mission.prerequisites.find((edge) => edge.id === id)?.why;
      // 선행을 정하면(빈 배열도) 자리가 정해진 것이다.
      const base = input.prerequisites !== undefined ? placed(mission) : mission;
      const prerequisites = input.prerequisites !== undefined
        ? input.prerequisites.filter((id) => known.has(id) && id !== missionId).map((id) => ({ id, ...(why(id) ? { why: why(id)! } : {}) }))
        : input.why ? mission.prerequisites.map((edge) => ({ id: edge.id, ...(why(edge.id) ? { why: why(edge.id)! } : {}) })) : mission.prerequisites;
      if (input.member && !(stored.members ?? []).some((member) => member.id === input.member)) throw new ObjectiveStoreError("unknown_member");
      const memberChanged = input.member !== undefined && (input.member ?? undefined) !== mission.member;
      const drafted: StoredMission = {
        ...base,
        prerequisites,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.done !== undefined ? { done: input.done ? true as const : undefined } : {}),
        ...(input.member !== undefined ? { member: input.member ?? undefined, memberBy: patchOptions?.by } : {}),
      };
      if (memberChanged && input.member) assigned = true;
      // 다시 연 배정 임무는 침묵이 새로 시작된다. 마지막 대상이 끝나 감시가 멈춘 뒤에도 깨움을 다시 건다.
      if (input.done === false && mission.done && (input.member !== undefined ? input.member : mission.member)) reopened = true;
      const next: StoredMission = !memberChanged ? drafted : input.member ? { ...withoutAssignment(drafted), assignmentTs: now() } : withoutAssignment(drafted);
      const replaced = replaceMission(stored, at, next);
      // 끝난 임무를 되돌리면 새 일이다 — 충족 판단을 거둔다.
      return input.done === false && mission.done ? withoutMet(action(replaced, patchOptions?.by ?? "commander", "mission-reopened", { targetId: missionId })) : replaced;
      });
      if (assigned || reopened) assignmentNoted(objectiveId);
      return patched;
    },

    noteAssignments(objectiveId, memberIds) {
      let stamped = false;
      const ids = new Set(memberIds);
      update(objectiveId, (stored) => {
        const at = now();
        let changed = false;
        const missions = stored.missions.map((mission) => {
          if (!mission.member || !ids.has(mission.member) || mission.assignmentTs !== undefined) return mission;
          changed = true;
          stamped = true;
          return { ...mission, assignmentTs: at };
        });
        return changed ? { ...stored, missions } : stored;
      }, false);
      if (stamped) assignmentNoted(objectiveId);
    },

    reportWokenFor(objectiveId, missionId) {
      try { return locate(objectiveId).stored.missions.find((mission) => mission.id === missionId)?.quietWokenFor; }
      catch { return undefined; }
    },
    setStopped: (objectiveId, stopped) => update(objectiveId, (stored) => {
      if (!stopped) return stored.stoppedAt === undefined ? stored : { ...stored, stoppedAt: undefined };
      return { ...stored, stoppedAt: now() };
    }, false),
    markReportWake(objectiveId, missionId, since) {
      update(objectiveId, (stored) => {
        const at = stored.missions.findIndex((mission) => mission.id === missionId);
        const mission = at < 0 ? undefined : stored.missions[at];
        if (!mission || mission.quietWokenFor === since) return stored;
        return replaceMission(stored, at, { ...mission, quietWokenFor: since });
      }, false);
    },

    missionDone: (objectiveId, missionId, lines, rawResults = []) => update(objectiveId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const { at, mission } = missionOf(stored, missionId);
      const parsed = completionResultsSchema.safeParse(rawResults);
      if (!parsed.success) throw new ObjectiveStoreError("invalid_arguments");
      const identities = new Set<string>();
      const added = parsed.data.map((raw) => {
        const input = resultChecked(() => checkedResultInput({ ...raw, sourceMissionId: missionId }));
        assertResultTarget(stored, input);
        const identity = resultIdentity(input);
        if (identities.has(identity)) throw new ObjectiveStoreError("result_exists");
        identities.add(identity);
        return resultChecked(() => makeResult(objectiveId, input));
      });
      const results = added.length ? checkedResults([...(stored.results ?? []), ...added]) : stored.results;
      const records = mission.records ?? [];
      const record: StoredRecord = { id: randomUUID(), at: now(), lines: [...lines] };
      const kept = [...records, record].slice(-MAX_RECORDS);
      // 밀려난 기록만큼 읽은 수도 줄인다 — 남은 기록 중 안 읽은 것이 그대로 안 읽은 것으로 남는다.
      const seen = Math.max(0, Math.min(mission.seen ?? 0, records.length) - (records.length + 1 - kept.length));
      return replaceMission({ ...stored, results }, at, { ...mission, done: true, records: kept, seen });
    }),

    missionSeen: (objectiveId, missionId) => update(objectiveId, (stored) => {
      const { at, mission } = missionOf(stored, missionId);
      const count = mission.records?.length ?? 0;
      return (mission.seen ?? 0) === count ? stored : replaceMission(stored, at, { ...mission, seen: count });
    }, false),

    missionRemove: (objectiveId, missionId) => update(objectiveId, (stored) => {
      missionOf(stored, missionId);
      return { ...stored, missions: stored.missions.filter((mission) => mission.id !== missionId).map((mission) => withoutEdge(mission, missionId)) };
    }),

    memberAdd: (objectiveId, input, by) => update(objectiveId, (stored) => {
      if ((stored.members?.length ?? 0) >= MAX_MISSIONS) throw new ObjectiveStoreError("too_many_members");
      const launch = canonicalStoredLaunch(input.launch);
      return { ...stored, members: [...(stored.members ?? []), { id: randomUUID(), role: input.role.trim(), ...(input.brief ? { brief: input.brief } : {}), ...(launch ? { launch } : {}), ...(input.proposal ? { proposal: input.proposal } : {}), ...(input.subagents === true ? { subagents: true as const } : {}), by }] };
    }),
    memberPatch: (objectiveId, memberId, patch) => update(objectiveId, (stored) => {
      if (!(stored.members ?? []).some((member) => member.id === memberId)) throw new ObjectiveStoreError("unknown_member");
      return { ...stored, members: stored.members!.map((member) => member.id === memberId ? {
        ...member, ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief || undefined } : {}),
        ...(patch.launch !== undefined ? { launch: canonicalStoredLaunch(patch.launch ?? undefined) } : {}),
        ...(patch.subagents !== undefined ? { subagents: patch.subagents ? true as const : undefined } : {}),
      } : member) };
    }),
    memberLaunchState: (objectiveId, memberId, patch) => update(objectiveId, (stored) => {
      const target = (stored.members ?? []).find((member) => member.id === memberId);
      if (!target) throw new ObjectiveStoreError("unknown_member");
      const { routed: _routed, next: _next, launch: _launch, ...rest } = target;
      const value = <K extends "launch" | "routed" | "next">(key: K) => (patch[key] !== undefined ? patch[key] : target[key]) ?? undefined;
      const launch = canonicalStoredLaunch(value("launch")), routed = value("routed"), next = canonicalStoredNext(value("next"));
      const changed: StoredMember = { ...rest, ...(launch ? { launch } : {}), ...(routed ? { routed } : {}), ...(next ? { next } : {}) };
      if (JSON.stringify(changed) === JSON.stringify(target)) return stored;
      return { ...stored, members: stored.members!.map((member) => (member.id === memberId ? changed : member)) };
    }),
    storedAnswers(objectiveId, requestId) {
      try {
        const { stored } = locate(objectiveId);
        if (stored.decisionDelivery?.requestId === requestId) return stored.decisionDelivery.answers;
        const decided = (stored.decisions ?? []).filter((decision) => decision.requestId === requestId);
        return decided.length ? decided.map((decision) => ({ questionId: decision.questionId, ...decision.answer })) : null;
      } catch { return null; }
    },
    storedMember(objectiveId, memberId) {
      try {
        const member = (locate(objectiveId).stored.members ?? []).find((candidate) => candidate.id === memberId);
        return member ? { ...member, ...(member.next ? { next: storedNext(member.next) ?? undefined } : {}) } : null;
      } catch { return null; }
    },
    memberBatchLaunch(objectiveId, mode, skip) {
      let changed = 0;
      const objective = update(objectiveId, (stored) => {
        const members = (stored.members ?? []).map((member) => {
          if (member.launch?.mode === "model" || skip?.has(member.id)) return member;
          if ((member.launch?.mode ?? "route") === mode) return member;
          changed += 1;
          if (mode === "route") {
            const { launch: _discarded, ...rest } = member;
            return rest;
          }
          return { ...member, launch: { mode: "same" as const } };
        });
        // 바뀐 구성원이 없으면 보드도 그대로다 — 저장도, 편집 기록도 남기지 않는다.
        return changed > 0 ? { ...stored, members } : stored;
      });
      return { objective, changed };
    },
    memberRemove(objectiveId, memberId) {
      const found = locate(objectiveId).stored;
      const removed = (found.members ?? []).find((member) => member.id === memberId);
      if (!removed) throw new ObjectiveStoreError("unknown_member");
      const missionIds = found.missions.filter((mission) => mission.member === memberId).map((mission) => mission.id);
      const objective = update(objectiveId, (stored) => ({ ...stored, members: stored.members?.filter((member) => member.id !== memberId), missions: stored.missions.map((mission) => mission.member === memberId ? { ...withoutAssignment(mission), member: undefined, memberBy: undefined } : mission) }));
      return { objective, removed, missionIds };
    },

    edgeToggle(objectiveId, from, to, why, desired) {
      let linked = false, changed = false;
      const objective = update(objectiveId, (stored) => {
        missionOf(stored, from);
        const { at, mission } = missionOf(stored, to);
        const exists = mission.prerequisites.some((edge) => edge.id === from);
        linked = desired ?? !exists;
        // 끌기의 잇기와 팝업의 끊기는 명시적 의도다. 오래된 화면·중복 요청도 반대 동작으로 바뀌지 않는다.
        if (linked === exists) return stored;
        changed = true;
        // 사람이 간선을 직접 이으면 양 끝 모두 자리가 정해진 것으로 본다 — 끊는 것은 자리를 되돌리지 않는다.
        if (!linked) return replaceMission(stored, at, withoutEdge(mission, from));
        const fromAt = stored.missions.findIndex((candidate) => candidate.id === from);
        const withFrom = replaceMission(stored, fromAt, placed(stored.missions[fromAt]!));
        return replaceMission(withFrom, at, { ...placed(mission), prerequisites: [...mission.prerequisites, { id: from, why: why ?? "human" }] });
      });
      return { objective, linked, changed };
    },

    plan: (objectiveId, input) => {
      const planned = update(objectiveId, (stored) => {
      if (input.criteria !== undefined && !stored.criteriaOpen) throw new ObjectiveStoreError("criteria_not_planning");
      // 검증과 편성 변경은 한 번의 update 안에서 끝난다 — 실패하면 기준 제안도 임무도 바뀌지 않는다.
      const proposals = input.criteria === undefined ? stored.criteriaProposals : proposalsOf(stored, input.criteria);
      if (input.members !== undefined && stored.members?.length) throw new ObjectiveStoreError("members_exist");
      const members = input.members?.length ? input.members.map((member): StoredMember => ({ id: randomUUID(), role: member.role, ...(member.brief ? { brief: member.brief } : {}), ...(member.proposal ? { proposal: member.proposal } : {}), by: "commander" })) : stored.members ?? [];
      const resolve = (reference: string | undefined): string | undefined => {
        if (!reference) return undefined;
        const byId = members.find((entry) => entry.id === reference);
        if (byId) return byId.id;
        // 같은 역할 이름의 구성원이 둘 이상이면 어느 쪽인지 고르지 않는다 — 첫 번째로 풀면 나머지는 임무를 받지 못한다.
        const byRole = members.filter((entry) => entry.role === reference);
        if (byRole.length > 1) throw new ObjectiveStoreError("ambiguous_member", undefined, { hint: "Members share this role; name one by id.", members: byRole.map((entry) => entry.id) });
        if (!byRole[0]) throw new ObjectiveStoreError("unknown_member");
        return byRole[0].id;
      };
      // 사람의 임무는 배치 뒤에도 보존한다. 옛 미분류 레코드도 이번 쓰기부터 출처를 굳힌다.
      const kept = stored.missions.filter((mission) => mission.done || mission.unplaced || (mission.by !== undefined && mission.by !== "commander") || !!mission.records?.length || (mission.memberBy !== undefined && mission.memberBy !== "commander"))
        .map((mission) => mission.unplaced && !mission.by ? { ...mission, by: "human" as const } : mission);
      const same = (text: string) => text.trim().toLowerCase();
      if (kept.some((mission) => input.missions.some((planned) => same(planned.text) === same(mission.text)))) throw new ObjectiveStoreError("mission_kept");
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
        return { id: freshIds[ix]!, text: mission.text, prerequisites, ...(member ? { member, assignmentTs: now() } : {}) };
      });
      return withoutMet({ ...stored, members, criteriaProposals: proposals, missions: [...kept.map((mission) => ({ ...mission, prerequisites: mission.prerequisites.filter((edge) => keptIds.has(edge.id)) })), ...fresh] });
      });
      if (input.missions.some((mission) => mission.member)) assignmentNoted(objectiveId);
      return planned;
    },

    setPlanning: (objectiveId, planning) => update(objectiveId, (stored) => (!!stored.planning === planning ? stored : { ...stored, planning: planning ? true as const : undefined })),
    recordStage: (objectiveId, stage, by) => update(objectiveId, (stored) => {
      const commenced = stage === "commenced" || stored.commenced === true;
      const staged = stored.enlisted === true && commenced === (stored.commenced === true) ? stored : { ...stored, enlisted: true, ...(commenced ? { commenced: true as const } : {}) };
      if (!by) return staged;
      return stage === "commenced" ? { ...action(staged, by, "commence"), commencedBy: by } : action(staged, by, "plan");
    }),
    setCommodoreOperated: (objectiveId, operated, by) => update(objectiveId, (stored) => (stored.commodoreOperated === operated ? stored : action({ ...stored, commodoreOperated: operated }, by, "edit"))),
    setCriteriaOpen: (objectiveId, open) => update(objectiveId, (stored) => (!!stored.criteriaOpen === open ? stored : { ...stored, criteriaOpen: open ? true as const : undefined })),
    clearMet: (objectiveId, by) => update(objectiveId, (stored) => withoutMet(by ? action(stored, by, "steer") : stored)),

    setEdited(objectiveId, kinds, by = "human") {
      return update(objectiveId, (stored) => {
        if (kinds === null) return stored.edited ? { ...stored, edited: undefined } : stored;
        if (kinds.length === 0) return stored;
        // 사람이 보드 내용을 고쳤다 — 앞선 결정 요청은 옛 보드를 전제로 한 질문이다.
        const next = withoutDecisionRequest(stored);
        const merged = [...new Set([...(stored.edited?.kinds ?? []), ...kinds])];
        const actors = stored.edited ? stored.edited.actors ?? ["human" as const] : [];
        // 편집자 목록은 누가 고쳤는지만 말한다 — 행위마다 다른 근거(why)로 같은 사령관이 여러 번 서지 않게 걷는다.
        const editor: ObjectiveActor = typeof by === "object" && by.kind === "commodore" ? { kind: "commodore", theaterId: by.theaterId } : by;
        const sameActor = actors.some((actor) => JSON.stringify(actor) === JSON.stringify(editor));
        return { ...action(next, by, "edit", { kinds }), edited: { at: now(), kinds: merged, actors: sameActor ? actors : [...actors, editor] } };
      }, kinds !== null);
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
      // 회차가 끝날 때까지 옛 기준의 충족은 사람이 승인한 recheck로만 풀린다 — 구상 뒤 수행 중에도 같다.
      if (!met && target.met && stored.extensionActive &&stored.extensions?.at(-1)?.criterionIds.includes(criterionId)) throw new ObjectiveStoreError("recheck_approval_required");
      if (target.met === met) return stored;
      return { ...stored, criteria: criteria.map((entry) => (entry.id === criterionId ? { id: entry.id, text: entry.text, by: entry.by, ...(met ? { met } : {}) } : entry)) };
    }),
    proposalApprove: (objectiveId, proposalId, by = "human") => update(objectiveId, (stored) => {
      const proposal = stored.criteriaProposals?.find((entry) => entry.id === proposalId);
      if (!proposal) throw new ObjectiveStoreError("unknown_proposal");
      const next = action(withoutDecisionRequest(approve(stored, proposal)), by, "criteria-approved", { targetId: proposal.id, proposal });
      return { ...next, criteriaProposals: stored.criteriaProposals?.filter((entry) => entry.id !== proposalId) };
    }),
    proposalsApproveAll: (objectiveId, by = "human") => update(objectiveId, (stored) => {
      if (!stored.criteriaProposals?.length) return stored;
      const next = withoutDecisionRequest(stored.criteriaProposals.reduce((current, proposal) => action(approve(current, proposal), by, "criteria-approved", { targetId: proposal.id, proposal }), stored));
      return { ...next, criteriaProposals: undefined };
    }),
    proposalReject: (objectiveId, proposalId, by = "human") => update(objectiveId, (stored) => {
      const proposal = stored.criteriaProposals?.find((entry) => entry.id === proposalId);
      if (!proposal) throw new ObjectiveStoreError("unknown_proposal");
      return { ...action(stored, by, "criteria-rejected", { targetId: proposalId, proposal }), criteriaProposals: stored.criteriaProposals!.filter((entry) => entry.id !== proposalId) };
    }),
    proposalAnnotate: (objectiveId, proposalId, annotation, by = "human") => update(objectiveId, (stored) => {
      if (!stored.criteriaProposals?.some((entry) => entry.id === proposalId)) throw new ObjectiveStoreError("unknown_proposal");
      if (annotation.length > 300) throw new ObjectiveStoreError("annotation_too_long");
      return { ...stored, criteriaProposals: stored.criteriaProposals.map((entry) => entry.id === proposalId ? { ...entry, annotation: annotation.trim() || undefined, annotationBy: annotation.trim() ? by : undefined } : entry) };
    }),

    resultUpdate(objectiveId, resultId, patch) {
      const objective = update(objectiveId, (stored) => {
        if (stored.done) throw new ObjectiveStoreError("objective_done");
        const previous = stored.results?.find((entry) => entry.id === resultId);
        if (!previous) throw new ObjectiveStoreError("unknown_result");
        const input = resultChecked(() => patchedResultInput(previous, patch));
        const changed = resultChecked(() => makeResult(objectiveId, input, previous));
        assertResultTarget(stored, changed, previous);
        const retired = previous.kind === "evidence" && changed.kind === "evidence" && previous.evidenceId !== changed.evidenceId ? previous.evidenceId : null;
        return { ...stored, ...(retired ? { evidence: stored.evidence?.filter((entry) => entry.evidenceId !== retired) } : {}), results: checkedResults(stored.results!.map((entry) => entry.id === resultId ? changed : entry)) };
      });
      cleanEvidence(objectiveId);
      return objective;
    },
    resultRemove(objectiveId, resultId) {
      const objective = update(objectiveId, (stored) => {
        if (stored.done) throw new ObjectiveStoreError("objective_done");
        const previous = stored.results?.find((entry) => entry.id === resultId);
        if (!previous) throw new ObjectiveStoreError("unknown_result");
        return { ...stored, ...(previous.kind === "evidence" ? { evidence: stored.evidence?.filter((entry) => entry.evidenceId !== previous.evidenceId) } : {}), results: stored.results!.filter((entry) => entry.id !== resultId) };
      });
      cleanEvidence(objectiveId);
      return objective;
    },

    resultObserved(objectiveId, resultId, url, raw) {
      const parsed = prObservationSchema.safeParse(raw);
      if (!parsed.success) throw new ObjectiveStoreError("invalid_pr_observation");
      try {
        update(objectiveId, (stored) => {
          const previous = stored.results?.find((entry) => entry.id === resultId);
          if (previous?.kind !== "pr" || previous.url !== url || JSON.stringify(previous.observation) === JSON.stringify(parsed.data)) return stored;
          return { ...stored, results: stored.results!.map((entry) => entry.id === resultId ? { ...previous, observation: parsed.data } : entry) };
        }, false);
      } catch (error) {
        // 조회 중 사라진 목표를 되살리거나 그 레코드를 새로 만들지 않는다.
        if (!(error instanceof ObjectiveStoreError && error.code === "unknown_objective")) throw error;
      }
    },

    evidenceSeal(objectiveId, ownerOperationId, input) {
      sweepEvidence(objectiveId);
      const { theaterId, stored } = locate(objectiveId);
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const manifest = stored.evidence ?? [];
      const linked = new Set((stored.results ?? []).flatMap((entry) => entry.kind === "evidence" ? [entry.evidenceId] : []));
      if (manifest.filter((entry) => !linked.has(entry.evidenceId)).length >= RESULT_LIMITS.pendingEvidence || manifest.reduce((sum, entry) => sum + entry.bytes, 0) + input.data.length > RESULT_LIMITS.totalEvidenceBytes) throw new ObjectiveStoreError("evidence_capacity");
      const { data, ...details } = input;
      const parsed = storedEvidenceSchema.safeParse({ ...details, evidenceId: randomUUID(), capturedAt: now(), ownerOperationId });
      if (!parsed.success || parsed.data.bytes !== data.length || parsed.data.sha256 !== createHash("sha256").update(data).digest("hex")) throw new ObjectiveStoreError("invalid_evidence");
      const evidence = parsed.data;
      const file = evidenceFile(theaterId, objectiveId, evidence);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileExclusive(evidenceFile(theaterId, objectiveId, evidence), data);
      try { update(objectiveId, (current) => ({ ...current, evidence: [...(current.evidence ?? []), evidence] })); }
      catch (error) { try { fs.unlinkSync(file); } catch { /* 다음 GC가 자체 고아 bytes를 정리한다. */ } throw error; }
      const { ownerOperationId: _owner, ...metadata } = evidence;
      return metadata;
    },
    async evidenceRead(objectiveId, resultId) {
      const { theaterId, stored } = locate(objectiveId);
      const result = stored.results?.find((entry) => entry.id === resultId);
      if (result?.kind !== "evidence") throw new ObjectiveStoreError("unknown_evidence");
      const metadata = stored.evidence?.find((entry) => entry.evidenceId === result.evidenceId);
      if (!metadata) throw new ObjectiveStoreError("unknown_evidence");
      const file = evidenceFile(theaterId, objectiveId, metadata);
      const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(metadata.bytes)) throw new ObjectiveStoreError("invalid_evidence");
        const data = Buffer.alloc(metadata.bytes);
        let offset = 0;
        while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) throw new ObjectiveStoreError("invalid_evidence"); offset += bytesRead; }
        const after = await handle.stat({ bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || createHash("sha256").update(data).digest("hex") !== metadata.sha256) throw new ObjectiveStoreError("invalid_evidence");
        // 응답 전에 참조가 바뀌면 옛 bytes를 새 결과물의 파일인 것처럼 보내지 않는다.
        const current = locate(objectiveId).stored.results?.find((entry) => entry.id === resultId);
        if (current?.kind !== "evidence" || current.evidenceId !== metadata.evidenceId) throw new ObjectiveStoreError("unknown_evidence");
        const { ownerOperationId: _owner, ...publicMetadata } = metadata;
        return { data, metadata: publicMetadata };
      } finally { await handle.close(); }
    },
    evidenceCollect() { for (const objective of store.all()) cleanEvidence(objective.id); },

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
      assertMission(stored, body.fromMission);
      assertObservable(body.evidence);
      const at = now();
      return { ...stored, followups: [...followups, { id: randomUUID(), rev: 1, state: "open", ...body, at, updatedAt: at }] };
    }),
    followupRevise: (objectiveId, candidateId, patch) => update(objectiveId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const target = openFollowup(stored, candidateId);
      if (patch.fromMission !== undefined) assertMission(stored, patch.fromMission);
      if (patch.evidence !== undefined) assertObservable(patch.evidence);
      const next: StoredFollowup = { ...target, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), rev: target.rev + 1, updatedAt: now() };
      return { ...stored, followups: (stored.followups ?? []).map((candidate) => (candidate.id === candidateId ? next : candidate)) };
    }),
    followupWithdraw: (objectiveId, candidateId) => update(objectiveId, (stored) => {
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      openFollowup(stored, candidateId);
      return { ...stored, followups: (stored.followups ?? []).filter((candidate) => candidate.id !== candidateId) };
    }),
    followupDiscard: (objectiveId, candidateId, by = "human") => update(objectiveId, (stored) => {
      const target = (stored.followups ?? []).find((candidate) => candidate.id === candidateId);
      if (!target) throw new ObjectiveStoreError("unknown_followup");
      if (target.state === "discarded") return stored;
      if (target.state !== "open") throw new ObjectiveStoreError("followup_locked");
      const at = now();
      // 흔적은 제목·요약·시각만 — 브리핑·기준·근거는 남기지 않는다. 넘치면 오래된 흔적부터 정리한다.
      const trace: StoredFollowup = { id: target.id, rev: target.rev, state: "discarded", title: target.title, summary: target.summary, userImpact: "", fromMission: target.fromMission, brief: "", criteria: [], evidence: [], at: target.at, updatedAt: at, discardedAt: at, discardedBy: by };
      let followups = (stored.followups ?? []).map((candidate) => (candidate.id === candidateId ? trace : candidate));
      const traces = followups.filter((candidate) => candidate.state === "discarded");
      if (traces.length > MAX_FOLLOWUP_DISCARDED) {
        const drop = new Set(traces.sort((a, b) => (a.discardedAt ?? 0) - (b.discardedAt ?? 0)).slice(0, traces.length - MAX_FOLLOWUP_DISCARDED).map((candidate) => candidate.id));
        followups = followups.filter((candidate) => !drop.has(candidate.id));
      }
      return { ...action(stored, by, "followup-discarded", { targetId: candidateId }), followups };
    }),

    completeWithFollowups(objectiveId, selection, operationIntent, by = "human") {
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
        const items: StoredFollowupItem[] = chosen.map((candidate) => ({
          candidateId: candidate.id, rev: candidate.rev,
          snapshot: { title: candidate.title, summary: candidate.summary, userImpact: candidate.userImpact, fromMission: candidate.fromMission, brief: candidate.brief, criteria: [...candidate.criteria], evidence: [...candidate.evidence] },
          state: "creating", attempts: 0,
        }));
        const chosenIds = new Set(ids);
        fresh = true;
        return foldBatches({
          ...action(action(withoutDecisionRequest(stored), by, "complete"), by, "followup-selected", { targetId: selection.batchId }),
          done: { at: now(), by }, planning: undefined, criteriaOpen: undefined, extensionActive: undefined, operationIntent,
          followups: (stored.followups ?? []).map((candidate) => (chosenIds.has(candidate.id) ? { ...candidate, state: "selected" as const, batchId: selection.batchId } : candidate)),
          followupBatches: [...batches, { id: selection.batchId, at: now(), by, launch: selection.launch, items }],
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
      const node = operationNode(operationId);
      return !!node && load(node.theaterId).has(operationId) || theaterIds().some((id) => !!load(id).get(operationId)?.pending);
    },

    decisionRequest(objectiveId, input) {
      let request!: DecisionRequest;
      let replacedRequestId: string | null = null;
      let reused = false;
      const objective = update(objectiveId, (stored) => {
        if (stored.done) throw new ObjectiveStoreError("objective_done");
        // 사람의 답이 지휘관에게 가는 중이다 — 그 요청을 덮으면 답이 어느 질문의 것인지 흐려진다.
        if (stored.decisionRequest && delivering.has(stored.decisionRequest.id)) throw new ObjectiveStoreError("decision_delivering");
        if ((stored.decisionRequestRevision ?? 0) !== input.expectedRevision) throw new ObjectiveStoreError("decision_request_changed", undefined, { decisionRequestRevision: stored.decisionRequestRevision ?? 0 });
        for (const question of input.questions) {
          if (question.missionId && !stored.missions.some((mission) => mission.id === question.missionId)) throw new ObjectiveStoreError("unknown_mission");
          if (question.memberId && !(stored.members ?? []).some((member) => member.id === question.memberId)) throw new ObjectiveStoreError("unknown_member");
        }
        // 저장될 모양 그대로 — 정규화하지 않는다. 같은 질문을 다시 물은 것이면 지금 요청을 그대로 둔다.
        const questions = input.questions.map((question) => ({
          text: question.text,
          options: question.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
          multiSelect: question.options.length > 0 && question.multiSelect === true,
          ...(question.missionId ? { missionId: question.missionId } : {}),
          ...(question.memberId ? { memberId: question.memberId } : {}),
        }));
        const current = stored.decisionRequest;
        const asked = current?.questions.map(({ id: _question, options, ...question }) => ({ ...question, options: options.map(({ id: _option, ...option }) => option) }));
        if (current && isDeepStrictEqual(asked, questions)) { request = current; reused = true; return stored; }
        replacedRequestId = current?.id ?? null;
        request = {
          id: randomUUID(), createdAt: now(),
          questions: questions.map((question) => ({ id: randomUUID(), ...question, options: question.options.map((option) => ({ id: randomUUID(), ...option })) })),
        };
        return { ...stored, decisionRequest: request, decisionDelivery: undefined, decisionRequestRevision: (stored.decisionRequestRevision ?? 0) + 1 };
      });
      return { objective, request, replacedRequestId, reused };
    },

    decisionWithdraw(objectiveId, requestId) {
      let withdrawn = false;
      const objective = update(objectiveId, (stored) => {
        const current = stored.decisionRequest;
        if (!current) return stored;
        if (current.id !== requestId) throw new ObjectiveStoreError("decision_request_changed", undefined, { requestId: current.id });
        if (delivering.has(current.id)) throw new ObjectiveStoreError("decision_delivering");
        withdrawn = true;
        return { ...stored, decisionRequest: undefined, decisionDelivery: undefined, decisionRequestRevision: (stored.decisionRequestRevision ?? 0) + 1 };
      });
      return { objective, withdrawn };
    },

    decisionAccept(objectiveId, input, by = "human") {
      const { stored, node } = locate(objectiveId);
      // 이미 결정으로 남은 요청 — 같은 답의 재전송은 그 결과를, 다른 답은 덮지 않고 거절한다.
      const recorded = (stored.decisions ?? []).filter((decision) => decision.requestId === input.requestId);
      if (recorded.length > 0) {
        const same = input.answers.length === recorded.length && input.answers.every((answer) => {
          const decision = recorded.find((entry) => entry.questionId === answer.questionId);
          return !!decision && decision.answer.text === answer.text && decision.answer.selectedOptionIds.length === answer.selectedOptionIds.length && answer.selectedOptionIds.every((id) => decision.answer.selectedOptionIds.includes(id));
        });
        if (!same) throw new ObjectiveStoreError("decision_already_submitted");
        return { recorded: true, objective: project(stored, node) };
      }
      if (stored.done) throw new ObjectiveStoreError("objective_done");
      const request = stored.decisionRequest;
      if (!request || request.id !== input.requestId) throw new ObjectiveStoreError("decision_request_changed");
      // 모든 질문에 정확히 한 번 — 고른 것은 그 질문의 선택지여야 하고, 하나 고르기는 하나까지, 빈 답은 받지 않는다.
      const byQuestion = new Map(input.answers.map((answer) => [answer.questionId, answer]));
      if (byQuestion.size !== input.answers.length || input.answers.length !== request.questions.length) throw new ObjectiveStoreError("invalid_answers");
      const answers: DecisionAnswer[] = request.questions.map((question) => {
        const answer = byQuestion.get(question.id);
        if (!answer) throw new ObjectiveStoreError("invalid_answers");
        const picked = new Set(answer.selectedOptionIds);
        if (picked.size !== answer.selectedOptionIds.length || [...picked].some((id) => !question.options.some((option) => option.id === id)) || (!question.multiSelect && picked.size > 1)) throw new ObjectiveStoreError("invalid_answers");
        if (picked.size === 0 && !answer.text.trim()) throw new ObjectiveStoreError("invalid_answers");
        return { questionId: question.id, selectedOptionIds: question.options.filter((option) => picked.has(option.id)).map((option) => option.id), text: answer.text };
      });
      if (delivering.has(request.id)) throw new ObjectiveStoreError("decision_delivering");
      const objective = update(objectiveId, (current) => ({ ...current, decisionDelivery: { requestId: request.id, answers, at: now(), by } }));
      delivering.add(request.id);
      return { recorded: false, objective, request, answers };
    },

    decisionSettle: (objectiveId, requestId, delivered) => {
      // 보내기는 끝났다 — 기록이 실패해도 이 요청을 더는 「보내는 중」으로 붙들지 않는다.
      delivering.delete(requestId);
      return update(objectiveId, (stored) => {
      const delivery = stored.decisionDelivery;
      if (!delivery || delivery.requestId !== requestId) return stored;
      const request = stored.decisionRequest?.id === requestId ? stored.decisionRequest : null;
      if (!delivered || !request) return { ...stored, decisionDelivery: undefined };
      // 지휘관에게 닿았다 — 질문마다 답한 순간의 사본으로 결정 한 건. 요청은 정리된다.
      const decisions: Decision[] = request.questions.map((question) => {
        const answer = delivery.answers.find((entry) => entry.questionId === question.id)!;
        return {
          id: randomUUID(), requestId, questionId: question.id,
          question: { text: question.text, options: question.options.map((option) => ({ ...option })), multiSelect: question.multiSelect },
          answer: { selectedOptionIds: [...answer.selectedOptionIds], text: answer.text },
          at: delivery.at, by: delivery.by ?? "human",
          ...(question.missionId ? { missionId: question.missionId } : {}),
          ...(question.memberId ? { memberId: question.memberId } : {}),
        };
      });
      return { ...stored, decisionDelivery: undefined, decisionRequest: undefined, decisionRequestRevision: (stored.decisionRequestRevision ?? 0) + 1, decisions: [...(stored.decisions ?? []), ...decisions] };
      });
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
  function respread(theaterId: string, board: readonly BoardEntry[], at: number, moved: StoredObjective, node: OperationNode | null): Objective {
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
    const commander = operationNode(stored.operationId);
    const started = !!commander && readOperationLaunch(commander.payload).started;
    if (started && stored.edited?.kinds.length) throw new ObjectiveStoreError("steer_required");
    if (!awaitingReview(stored)) throw new ObjectiveStoreError("not_in_review");
  }
  /** 후보의 출처 임무 — 이 목표에 있는 임무여야 한다. */
  function assertMission(stored: StoredObjective, missionId: string): void {
    if (!stored.missions.some((mission) => mission.id === missionId)) throw new ObjectiveStoreError("unknown_mission");
  }
  /** 근거 가운데 하나 이상은 관찰할 수 있어야 한다 — 줄 번호가 있는 파일 또는 명령. */
  function assertObservable(evidence: readonly FollowupEvidence[]): void {
    if (!evidence.some(observableEvidence)) throw new ObjectiveStoreError("evidence_not_observable");
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
