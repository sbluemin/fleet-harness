import { isDeepStrictEqual } from "node:util";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { livePersonHold } from "./board-state.js";
import type { BriefAttachmentInput } from "./attachments.js";
import type { LaunchOptions, LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import type { DecisionAnswersInput, MemberLaunch, MemberPatchInput, MissionAddInput, MissionPatchInput, Objective, ObjectiveEditKind, ObjectivePersonHold, ObjectiveReviewer, PatchObjectiveInput, PersonHoldTarget } from "./types.js";

type Ref = { readonly objectiveId: string; readonly language?: "en" | "ko" };
type ContextRef = Ref & { readonly context?: string };
type MissionRef = Ref & { readonly missionId: string };
export interface CompleteAction extends Ref {
  readonly undone?: boolean;
  readonly batchId?: string;
  readonly followups?: readonly { readonly id: string; readonly rev: number }[];
}

/** 화면과 보드 도구의 바깥 루프. 행위자는 호출 경계에서 정하고 입력 JSON에서는 받지 않는다. */
export function createObjectiveActions(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService, actor: ObjectiveReviewer) {
  const objective = (value: Objective) => ({ objective: value });
  const options = (body: ContextRef): LaunchOptions => ({ actor, language: body.language, context: body.context });
  const unlessBusy = <A extends Ref, R>(run: (body: A) => R) => (body: A): R => {
    if (launch.busy(body.objectiveId)) throw new ObjectiveStoreError("objective_busy");
    return run(body);
  };
  const steerable = <A extends Ref, R>(allowed: (body: A) => boolean, run: (body: A) => R) => (body: A): R => {
    if (launch.busy(body.objectiveId) && !allowed(body)) throw new ObjectiveStoreError("objective_busy");
    return run(body);
  };
  // 저장소의 읽기/쓰기 응답은 매번 새 투영이다. 기록 시각·결정 요청·실행 좌표가 아닌 보드 내용으로 비교한다.
  const boardContent = (value: Objective | null) => value && ({
    title: value.title, note: value.note, attachments: value.attachments, criteria: value.criteria,
    members: value.members.map(({ id, role, brief, launch, subagents }) => ({ id, role, brief, launch, subagents })),
    // memberBy 는 누가 정한 배정인지다 — 다시 계획할 때 남길 임무를 가르므로 같은 담당의 재지정도 보드 변경이다.
    missions: value.missions.map(({ id, text, done, prerequisites, why, member, memberBy, unplaced }) => ({ id, text, done, prerequisites, why, member, memberBy, unplaced })),
  });
  const edited = async (objectiveId: string, kinds: readonly ObjectiveEditKind[], run: () => Promise<Objective> | Objective) => {
    const before = boardContent(store.find(objectiveId));
    const next = await run();
    return objective(kinds.length && !isDeepStrictEqual(before, boardContent(next)) ? store.setEdited(next.id, kinds, actor) : next);
  };
  const markEdited = (id: string, kinds: readonly ObjectiveEditKind[]) => store.setEdited(id, kinds, actor);
  const notStarted = (objectiveId: string, missionId: string) => {
    const mission = store.find(objectiveId)?.missions.find((entry) => entry.id === missionId);
    return !!mission && !mission.done;
  };
  const only = (patch: object, keys: readonly string[]) => Object.keys(patch).every((key) => keys.includes(key));
  const commodore = typeof actor === "object" && actor.kind === "commodore";
  const liveHolds = (objectiveId: string, targets: readonly PersonHoldTarget[]): ObjectivePersonHold[] => {
    const found = store.find(objectiveId);
    return found ? targets.flatMap((target) => livePersonHold(found, target) ?? []) : [];
  };
  /**
   * 사람에게 넘긴 항목의 경계 — 사령관은 넘긴 항목을 처리하는 행위(답·승인·거절·완료·확장·스티어링·후속 폐기)를 하지 못한다.
   * 사람 쪽(사람·Console Use Operation)의 같은 행위가 그 항목을 끝내면 넘김은 「사람이 답함」으로 남아 사령관을 깨운다.
   */
  const holding = <A extends Ref, R>(targets: (body: A) => readonly PersonHoldTarget[], run: (body: A) => Promise<R> | R, settles = true, ended?: (body: A) => readonly PersonHoldTarget[]) => async (body: A): Promise<R> => {
    const held = liveHolds(body.objectiveId, targets(body));
    if (commodore) {
      if (held[0]) throw new ObjectiveStoreError("held_for_person", undefined, { target: held[0].target, reason: held[0].reason });
      return run(body);
    }
    const result = await run(body);
    if (settles && held.length) store.personHoldsAnswered(body.objectiveId, held, actor, ended?.(body));
    return result;
  };
  const missionKinds = (patch: MissionPatchInput): ObjectiveEditKind[] => [
    ...(patch.text !== undefined || patch.done !== undefined ? ["missions" as const] : []),
    ...(patch.prerequisites !== undefined || patch.why !== undefined ? ["lineup" as const] : []),
    ...(patch.member !== undefined ? ["member" as const] : []),
  ];
  return {
    // 첨부 등 바이트를 받는 경계도 같은 실행 중 편집 규칙과 귀속을 쓴다.
    unlessBusy, steerable, edited, markEdited,
    // 제목·브리핑 편집은 옛 보드를 전제로 한 결정 요청을 거둔다 — 사령관은 사람에게 넘긴 질문을 그렇게 지우지 못한다. 사람의 편집은 답이 아니다.
    patch: holding(({ patch }: Ref & { patch: PatchObjectiveInput }) => (patch.title !== undefined || patch.note !== undefined ? ["decision"] : []), steerable(({ patch }: Ref & { patch: PatchObjectiveInput }) => only(patch, ["title", "note"]), ({ objectiveId, patch }) => edited(objectiveId, [
      ...(patch.title !== undefined ? ["title" as const] : []), ...(patch.note !== undefined ? ["note" as const] : []),
    ], async () => {
      const { title, groupId, launch: preset, ...own } = patch;
      if (title !== undefined) await launch.rename(objectiveId, title);
      if (groupId !== undefined) await launch.regroup(objectiveId, groupId);
      if (preset) await launch.setPreset(objectiveId, preset);
      if (Object.keys(own).length) return store.patch(objectiveId, { ...own, ...(own.planRequest !== undefined ? { planRequestBy: actor } : {}) });
      const found = store.find(objectiveId);
      if (!found) throw new ObjectiveStoreError("unknown_objective");
      return found;
    })), false),
    editBrief: holding(() => ["decision"], steerable(() => true, ({ objectiveId, brief, attachments }: Ref & { brief: string; attachments: readonly BriefAttachmentInput[] }) =>
      objective(store.briefEdit(objectiveId, brief, attachments, actor))), false),
    // 빈 선택 완료도 후속 선택을 끝낸다 — 완료된 목표에서는 더 이상 후속을 고르지 못하므로 넘긴 후속 선택을 함께 지키고,
    // 사람의 완료는 고르지 않은 후보가 남아도 그 선택을 「사람이 답함」으로 끝낸다.
    // 완료·확장·기준 승인은 서 있는 결정 요청을 거둔다 — 사람에게 넘긴 결정이 그렇게 지워지지 않게 함께 지킨다.
    complete: holding((body: CompleteAction) => (body.undone ? [] : ["review", "followup", "decision"]), unlessBusy(async (body: CompleteAction) => {
      if (body.undone) return objective(await launch.reopen(body.objectiveId, options(body)));
      if (!body.followups?.length) return objective(await launch.complete(body.objectiveId, options(body)));
      if (!body.batchId) throw new ObjectiveStoreError("invalid_request");
      return objective(await launch.completeWithFollowups(body.objectiveId, { batchId: body.batchId, followups: body.followups }, options(body)));
    }), true, (body: CompleteAction) => (body.undone ? [] : ["followup"])),
    extend: holding(() => ["review", "decision"], unlessBusy((body: Ref & { context: string }) => launch.extend(body.objectiveId, body.context, options(body)))),
    handOff: unlessBusy(({ objectiveId }: Ref) => objective(store.handOff(objectiveId, { by: actor }))),
    // 새 구상은 기준 제안을 갈아 끼운다 — 사람에게 넘긴 제안이 서 있는 동안 사령관은 청하지 못한다.
    plan: holding(() => ["criteria"], unlessBusy((body: ContextRef) => {
      if (body.context !== undefined) store.patch(body.objectiveId, { planRequest: body.context, planRequestBy: actor });
      return launch.requestPlan(body.objectiveId, options(body));
    })),
    commence: (body: ContextRef & { routing?: "preview" }) => {
      if (store.find(body.objectiveId)?.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
      // 지휘관 턴 중에는 개시하지 않는다(쓰고 있는 계획·기준과 겹친다). 대신 언제 다시 부르면 되는지와 지금 상태를 말한다 —
      // 다시 부를지는 호출자가 정하고, 여기서 예약하거나 다시 부르지 않는다.
      if (launch.busy(body.objectiveId)) {
        const state = ctx.host.consoleControl?.observe(body.objectiveId)?.activity;
        throw new ObjectiveStoreError("objective_busy", undefined, { retryWhen: "commander_turn_end", ...(state ? { commander: { state } } : {}) });
      }
      return launch.startCommander(body.objectiveId, { ...options(body), ...(body.routing ? { routing: body.routing } : {}) });
    },
    answer: holding(() => ["decision"], (body: Ref & DecisionAnswersInput) => launch.answerDecision(body.objectiveId, { requestId: body.requestId, answers: body.answers }, options(body)).then(objective)),
    // 스티어링은 달성 표시를 거둬 검토 대기를 끝낸다.
    steer: holding(() => ["review"], (body: ContextRef) => launch.steer(body.objectiveId, options(body)).then(objective)),
    message: (body: Ref & { memberId?: string | null; text: string; attachmentIds?: readonly string[] }) => launch.message(body.objectiveId, body.memberId ?? null, body.text, options(body), body.attachmentIds),
    stop: ({ objectiveId }: Ref) => launch.stop(objectiveId),
    compact: ({ objectiveId }: Ref) => launch.compact(objectiveId),
    followupDiscard: holding(() => ["followup"], ({ objectiveId, candidateId }: Ref & { candidateId: string }) => objective(store.followupDiscard(objectiveId, candidateId, actor))),
    followupRetry: ({ objectiveId, batchId, candidateId }: Ref & { batchId: string; candidateId: string }) => objective(launch.retryFollowup(objectiveId, batchId, candidateId)),
    followupAbandon: ({ objectiveId, batchId, candidateId }: Ref & { batchId: string; candidateId: string }) => objective(store.followupAbandon(objectiveId, batchId, candidateId)),
    memberAdd: steerable(() => true, ({ objectiveId, member }: Ref & { member: { role: string; brief?: string; launch?: MemberLaunch; subagents?: boolean } }) => edited(objectiveId, ["members"], () => store.memberAdd(objectiveId, member, actor))),
    memberPatch: steerable(() => true, ({ objectiveId, memberId, patch }: Ref & { memberId: string; patch: MemberPatchInput }) => {
      const reservation = only(patch, ["launch"]) && !!(ctx.host.operations.describe ? ctx.host.operations.describe(memberId) : ctx.host.operations.get(memberId));
      return edited(objectiveId, reservation ? [] : ["members"], () => launch.memberPatched(objectiveId, memberId, patch));
    }),
    memberBatchLaunch: steerable(() => true, async ({ objectiveId, mode }: Ref & { mode: "same" | "route" }) => {
      const result = await launch.memberBatchLaunch(objectiveId, mode);
      const body = objective(result.edits > 0 ? markEdited(objectiveId, ["members"]) : result.objective);
      return { ...body, changed: result.changed, preserved: result.preserved };
    }),
    memberRemove: steerable(() => true, async ({ objectiveId, memberId }: Ref & { memberId: string }) => {
      const result = await launch.memberRemoved(objectiveId, memberId);
      return objective(markEdited(objectiveId, ["members", ...(result.missionIds.length ? ["member" as const] : [])]));
    }),
    missionAdd: steerable(() => true, ({ objectiveId, mission }: Ref & { mission: MissionAddInput }) => edited(objectiveId, ["missions", ...(mission.member !== undefined ? ["member" as const] : [])], () => store.missionAdd(objectiveId, mission, { unplaced: mission.prerequisites === undefined, by: actor }))),
    missionPatch: steerable(({ objectiveId, missionId, patch }: MissionRef & { patch: MissionPatchInput }) => only(patch, ["text", "member"]) && notStarted(objectiveId, missionId), ({ objectiveId, missionId, patch }) => edited(objectiveId, missionKinds(patch), () => store.missionPatch(objectiveId, missionId, patch, { by: actor }))),
    missionRemove: steerable(({ objectiveId, missionId }: MissionRef) => notStarted(objectiveId, missionId), ({ objectiveId, missionId }) => edited(objectiveId, ["missions"], () => store.missionRemove(objectiveId, missionId))),
    edge: steerable(({ objectiveId, to }: Ref & { from: string; to: string; linked?: boolean }) => notStarted(objectiveId, to), ({ objectiveId, from, to, linked }) => {
      const result = store.edgeToggle(objectiveId, from, to, undefined, linked);
      return { objective: result.changed ? markEdited(objectiveId, ["lineup"]) : result.objective, linked: result.linked };
    }),
    criterionAdd: steerable(() => true, ({ objectiveId, criterion }: Ref & { criterion: { text: string } }) => edited(objectiveId, ["criteria"], () => store.criterionAdd(objectiveId, criterion.text, actor))),
    criterionPatch: steerable(() => true, ({ objectiveId, criterionId, patch }: Ref & { criterionId: string; patch: { text: string } }) => edited(objectiveId, ["criteria"], () => store.criterionPatch(objectiveId, criterionId, patch.text))),
    criterionRemove: steerable(() => true, ({ objectiveId, criterionId }: Ref & { criterionId: string }) => edited(objectiveId, ["criteria"], () => store.criterionRemove(objectiveId, criterionId))),
    approve: holding(() => ["criteria", "decision"], ({ objectiveId, proposalId }: Ref & { proposalId: string }) => objective(store.proposalApprove(objectiveId, proposalId, actor))),
    approveAll: holding(() => ["criteria", "decision"], ({ objectiveId }: Ref) => objective(store.proposalsApproveAll(objectiveId, actor))),
    reject: holding(() => ["criteria"], ({ objectiveId, proposalId }: Ref & { proposalId: string }) => objective(store.proposalReject(objectiveId, proposalId, actor))),
    // 사령관이 넘기기 — 사령관 행위자만. 사람에게는 돌려주기(`personHoldReturn`)가 있다.
    handToPerson: ({ objectiveId, target, reason }: Ref & { target: PersonHoldTarget; reason: string }) => {
      if (typeof actor !== "object" || actor.kind !== "commodore") throw new ObjectiveStoreError("commodore_caller_required");
      return objective(store.personHold(objectiveId, { target, reason, by: actor }));
    },
    returnToCommodore: ({ objectiveId, target }: Ref & { target: PersonHoldTarget }) => {
      if (commodore) throw new ObjectiveStoreError("person_caller_required");
      return objective(store.personHoldReturn(objectiveId, target, actor));
    },
    annotate: ({ objectiveId, proposalId, annotation }: Ref & { proposalId: string; annotation: string }) => objective(store.proposalAnnotate(objectiveId, proposalId, annotation, actor)),
  };
}
