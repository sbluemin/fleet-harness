import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { LaunchOptions, LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import type { DecisionAnswersInput, MemberLaunch, MemberPatchInput, MissionAddInput, MissionPatchInput, Objective, ObjectiveEditKind, ObjectiveReviewer, PatchObjectiveInput } from "./types.js";

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
  const edited = async (kinds: readonly ObjectiveEditKind[], run: () => Promise<Objective> | Objective) => {
    const next = await run();
    return objective(kinds.length ? store.setEdited(next.id, kinds, actor) : next);
  };
  const markEdited = (id: string, kinds: readonly ObjectiveEditKind[]) => store.setEdited(id, kinds, actor);
  const notStarted = (objectiveId: string, missionId: string) => {
    const mission = store.find(objectiveId)?.missions.find((entry) => entry.id === missionId);
    return !!mission && !mission.done;
  };
  const only = (patch: object, keys: readonly string[]) => Object.keys(patch).every((key) => keys.includes(key));
  const missionKinds = (patch: MissionPatchInput): ObjectiveEditKind[] => [
    ...(patch.text !== undefined || patch.done !== undefined ? ["missions" as const] : []),
    ...(patch.prerequisites !== undefined || patch.why !== undefined ? ["lineup" as const] : []),
    ...(patch.member !== undefined ? ["member" as const] : []),
  ];
  return {
    // 첨부 등 바이트를 받는 경계도 같은 실행 중 편집 규칙과 귀속을 쓴다.
    unlessBusy, steerable, edited, markEdited,
    patch: steerable(({ patch }: Ref & { patch: PatchObjectiveInput }) => only(patch, ["note", "routingConfirm"]), ({ objectiveId, patch }) => edited([
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
    })),
    complete: unlessBusy(async (body: CompleteAction) => {
      if (body.undone) return objective(await launch.reopen(body.objectiveId, options(body)));
      if (!body.followups?.length) return objective(await launch.complete(body.objectiveId, options(body)));
      if (!body.batchId) throw new ObjectiveStoreError("invalid_request");
      return objective(await launch.completeWithFollowups(body.objectiveId, { batchId: body.batchId, followups: body.followups }, options(body)));
    }),
    extend: unlessBusy((body: Ref & { context: string }) => launch.extend(body.objectiveId, body.context, options(body))),
    handOff: unlessBusy(({ objectiveId }: Ref) => objective(store.handOff(objectiveId, { by: actor }))),
    plan: unlessBusy((body: ContextRef) => {
      if (body.context !== undefined) store.patch(body.objectiveId, { planRequest: body.context, planRequestBy: actor });
      return launch.requestPlan(body.objectiveId, options(body));
    }),
    commence: (body: ContextRef & { routing?: "preview" }) => {
      if (store.find(body.objectiveId)?.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
      return unlessBusy((value: typeof body) => launch.startCommander(value.objectiveId, { ...options(value), ...(value.routing ? { routing: value.routing } : {}) }))(body);
    },
    answer: (body: Ref & DecisionAnswersInput) => launch.answerDecision(body.objectiveId, { requestId: body.requestId, answers: body.answers }, options(body)).then(objective),
    steer: (body: ContextRef) => launch.steer(body.objectiveId, options(body)).then(objective),
    message: (body: Ref & { memberId?: string | null; text: string }) => launch.message(body.objectiveId, body.memberId ?? null, body.text, options(body)),
    stop: ({ objectiveId }: Ref) => launch.stop(objectiveId),
    compact: ({ objectiveId }: Ref) => launch.compact(objectiveId),
    followupDiscard: ({ objectiveId, candidateId }: Ref & { candidateId: string }) => objective(store.followupDiscard(objectiveId, candidateId, actor)),
    followupRetry: ({ objectiveId, batchId, candidateId }: Ref & { batchId: string; candidateId: string }) => objective(launch.retryFollowup(objectiveId, batchId, candidateId)),
    followupAbandon: ({ objectiveId, batchId, candidateId }: Ref & { batchId: string; candidateId: string }) => objective(store.followupAbandon(objectiveId, batchId, candidateId)),
    memberAdd: steerable(() => true, ({ objectiveId, member }: Ref & { member: { role: string; brief?: string; launch?: MemberLaunch; subagents?: boolean } }) => edited(["members"], () => store.memberAdd(objectiveId, member, actor))),
    memberPatch: steerable(() => true, ({ objectiveId, memberId, patch }: Ref & { memberId: string; patch: MemberPatchInput }) => {
      const reservation = only(patch, ["launch"]) && !!(ctx.host.operations.describe ? ctx.host.operations.describe(memberId) : ctx.host.operations.get(memberId));
      return edited(reservation ? [] : ["members"], () => launch.memberPatched(objectiveId, memberId, patch));
    }),
    memberBatchLaunch: steerable(() => true, async ({ objectiveId, mode }: Ref & { mode: "same" | "route" }) => {
      const result = await launch.memberBatchLaunch(objectiveId, mode);
      const body = result.edits > 0 ? await edited(["members"], () => result.objective) : objective(result.objective);
      return { ...body, changed: result.changed, preserved: result.preserved };
    }),
    memberRemove: steerable(() => true, async ({ objectiveId, memberId }: Ref & { memberId: string }) => {
      const result = await launch.memberRemoved(objectiveId, memberId);
      return objective(markEdited(objectiveId, ["members", ...(result.missionIds.length ? ["member" as const] : [])]));
    }),
    missionAdd: steerable(() => true, ({ objectiveId, mission }: Ref & { mission: MissionAddInput }) => edited(["missions", ...(mission.member !== undefined ? ["member" as const] : [])], () => store.missionAdd(objectiveId, mission, { unplaced: mission.prerequisites === undefined, by: actor }))),
    missionPatch: steerable(({ objectiveId, missionId, patch }: MissionRef & { patch: MissionPatchInput }) => only(patch, ["text", "member"]) && notStarted(objectiveId, missionId), ({ objectiveId, missionId, patch }) => edited(missionKinds(patch), () => store.missionPatch(objectiveId, missionId, patch, { by: actor }))),
    missionRemove: steerable(({ objectiveId, missionId }: MissionRef) => notStarted(objectiveId, missionId), ({ objectiveId, missionId }) => edited(["missions"], () => store.missionRemove(objectiveId, missionId))),
    edge: steerable(({ objectiveId, to }: Ref & { from: string; to: string; linked?: boolean }) => notStarted(objectiveId, to), ({ objectiveId, from, to, linked }) => {
      const result = store.edgeToggle(objectiveId, from, to, undefined, linked);
      return { objective: result.changed ? markEdited(objectiveId, ["lineup"]) : result.objective, linked: result.linked };
    }),
    criterionAdd: steerable(() => true, ({ objectiveId, criterion }: Ref & { criterion: { text: string } }) => edited(["criteria"], () => store.criterionAdd(objectiveId, criterion.text, actor))),
    criterionPatch: steerable(() => true, ({ objectiveId, criterionId, patch }: Ref & { criterionId: string; patch: { text: string } }) => edited(["criteria"], () => store.criterionPatch(objectiveId, criterionId, patch.text))),
    criterionRemove: steerable(() => true, ({ objectiveId, criterionId }: Ref & { criterionId: string }) => edited(["criteria"], () => store.criterionRemove(objectiveId, criterionId))),
    approve: ({ objectiveId, proposalId }: Ref & { proposalId: string }) => objective(store.proposalApprove(objectiveId, proposalId, actor)),
    approveAll: ({ objectiveId }: Ref) => objective(store.proposalsApproveAll(objectiveId, actor)),
    reject: ({ objectiveId, proposalId }: Ref & { proposalId: string }) => objective(store.proposalReject(objectiveId, proposalId, actor)),
    annotate: ({ objectiveId, proposalId, annotation }: Ref & { proposalId: string; annotation: string }) => objective(store.proposalAnnotate(objectiveId, proposalId, annotation, actor)),
  };
}
