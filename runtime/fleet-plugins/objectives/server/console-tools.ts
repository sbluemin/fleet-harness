import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createObjectiveActions } from "./actions.js";
import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_REMOVAL_REASON, MAX_TITLE, MAX_CONTEXT, decisionAnswersSchema, followupSelectionSchema, missionAddSchema, missionPatchSchema, criterionAddSchema, type ObjectiveReviewer } from "./types.js";
import { createBoardViews, refuse, roleIn, text } from "./views.js";

/** 바깥 루프의 보드. Console Use와 Theater에 묶인 사령관 세션이 같은 스키마와 도메인 함수를 쓴다. */

const ids = z.string().min(1).max(128);
const MAX_ADD_PER_TURN = 10;
/**
 * add 와 함께 오면 조용히 버려지는 읽기 전용 키 — 생성 전에 이유 있게 거절한다.
 * 읽기로 쓸 때(view·objective·groups + groupId·objectiveId·filter)는 그대로 두므로 읽기 계약은 바뀌지 않는다.
 */
const ADD_READ_KEYS = ["groupId", "objectiveId", "view", "filter"] as const;
/** 정리(지우기·합치기·되돌리기) 한 번에 받는 목표 수, 그리고 호출자마다 10분에 받는 정리 호출 수. */
const MAX_TIDY_IDS = 20;
const MAX_TIDY_PER_TURN = 20;
const TARGET_WRITES = ["plan", "commence", "criteria", "answer", "complete", "reopen", "steer", "message", "stop", "compact", "extend", "edit", "followup"] as const;
const WRITE_KEYS = ["add", "remove", "merge", "restore", ...TARGET_WRITES] as const;
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
const reason = z.string().trim().min(1).max(MAX_REMOVAL_REASON);
const addSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), criteria: z.array(criterionText).max(MAX_CRITERIA).optional() }).strict();

const contextSchema = z.object({ context: z.string().max(MAX_CONTEXT).optional() }).strict();
const editSchema = z.union([
  z.object({ brief: z.string().max(20_000) }).strict(),
  z.object({ mission: z.union([
    z.object({ add: missionAddSchema }).strict(),
    z.object({ patch: z.object({ missionId: ids, changes: missionPatchSchema }).strict() }).strict(),
    z.object({ remove: ids }).strict(),
  ]) }).strict(),
  z.object({ criterion: z.union([
    z.object({ add: criterionAddSchema }).strict(),
    z.object({ patch: z.object({ criterionId: ids, text: criterionAddSchema.shape.text }).strict() }).strict(),
    z.object({ remove: ids }).strict(),
  ]) }).strict(),
]);
const followupTarget = z.object({ batchId: ids, candidateId: ids }).strict();
const argsSchema = z.object({
  theaterId: ids.optional(),
  view: z.enum(["groups", "objectives", "objective"]).optional(),
  groupId: ids.optional(),
  objectiveId: ids.optional(),
  filter: z.enum(["today", "due", "all", "agent"]).optional(),
  add: addSchema.optional(),
  remove: z.object({ objectiveIds: z.array(ids).min(1).max(MAX_TIDY_IDS), reason: reason.optional() }).strict().optional(),
  merge: z.object({ into: ids, from: z.array(ids).min(1).max(MAX_TIDY_IDS), reason: reason.optional() }).strict().optional(),
  restore: z.array(ids).min(1).max(MAX_TIDY_IDS).optional(),
  plan: z.union([z.literal(true), contextSchema]).optional(),
  commence: z.union([z.literal(true), contextSchema]).optional(),
  criteria: z.union([z.object({ approve: ids }).strict(), z.object({ reject: ids }).strict()]).optional(),
  answer: decisionAnswersSchema.optional(),
  complete: z.union([z.literal(true), followupSelectionSchema.strict()]).optional(),
  reopen: z.literal(true).optional(),
  steer: z.union([z.literal(true), contextSchema]).optional(),
  message: z.object({ memberId: ids.nullable().optional(), text: z.string().trim().min(1).max(MAX_CONTEXT) }).strict().optional(),
  stop: z.literal(true).optional(),
  compact: z.literal(true).optional(),
  extend: z.object({ context: z.string().trim().min(1).max(MAX_CONTEXT) }).strict().optional(),
  edit: editSchema.optional(),
  followup: z.union([z.object({ retry: followupTarget }).strict(), z.object({ abandon: followupTarget }).strict(), z.object({ discard: ids }).strict()]).optional(),
}).strict();
type Args = z.output<typeof argsSchema>;

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  return createBoardTools(ctx, store, launch);
}

/** 호스트가 호출자를 넣지 않는 사령관 전용 도구. Theater는 모델 입력이 아니라 생성 때 고정한다. */
export function createCommodoreBoardTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService, theaterId: string): readonly PluginMcpTool[] {
  return createBoardTools(ctx, store, launch, { kind: "commodore", theaterId });
}
type CommodoreCaller = { readonly kind: "commodore"; readonly theaterId: string };
type BoardCaller = ConsoleCaller | CommodoreCaller;
function createBoardTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService, bound?: CommodoreCaller): readonly PluginMcpTool[] {
  const { objectiveView, rowView, languageOf } = createBoardViews(ctx, store);
  const addBudget = new Map<string, { at: number; count: number }>();
  const tidyBudget = new Map<string, { at: number; count: number }>();
  /** 호출자마다 10분 창의 호출 수 — 넘치면 false. */
  const spend = (budgets: Map<string, { at: number; count: number }>, key: string, limit: number): boolean => {
    const budget = budgets.get(key) ?? { at: Date.now(), count: 0 };
    if (Date.now() - budget.at > 10 * 60_000) { budget.at = Date.now(); budget.count = 0; }
    if (budget.count >= limit) return false;
    budget.count += 1; budgets.set(key, budget);
    return true;
  };
  const theaterOfCaller = (caller: BoardCaller | undefined): string | null => caller?.kind === "commodore" ? caller.theaterId : caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null;
  const callerKey = (caller: BoardCaller | undefined): string => caller?.kind === "commodore" ? `commodore:${caller.theaterId}` : caller?.kind === "operation" ? `op:${caller.operationId}` : caller?.kind === "plugin" ? `plugin:${caller.pluginId}` : "anonymous";
  const actorOf = (caller: BoardCaller | undefined): ObjectiveReviewer | null => caller?.kind === "commodore" ? caller : caller?.kind === "operation" ? { kind: "operation", operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null } : null;
  const language = (caller: BoardCaller | undefined) => languageOf(caller?.kind === "commodore" ? undefined : caller);
  const scoped = (objectiveId: string) => {
    const found = store.find(objectiveId);
    if (!found) throw new ObjectiveStoreError("unknown_objective");
    if (bound && found.theaterId !== bound.theaterId) throw new ObjectiveStoreError("other_theater");
    return found;
  };

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "A Theater's Objectives board and its outer-loop actions. Reads: groups, objectives, objective; filters today, due, agent, all. One write per call. add carries title, brief (note) and criteria only; it creates no session and inherits the calling Operation's group. plan requests a lineup; commence launches or resumes it. criteria approves one proposal (or all with approve: all) or rejects one. answer submits all questions in one decision request. complete may select follow-ups; reopen, extend, steer, message, stop and compact use the board's session lifecycle. edit changes a brief, mission or criterion with the same running-session rules as the screen. followup retries, abandons or discards a candidate. Actions are attributed to their caller. An Operation cannot perform outer-loop writes on an objective it commands or belongs to (own_objective); mission execution remains with fleet-objectives. A Commodore connection is confined to its Theater. remove, merge and restore require an Operation caller; removal and merge accept only unlaunched, incomplete board objectives and retain a reversible trace for 14 days. Operation callers have 10 adds and 20 tidy calls per 10 minutes.",
    // 모르는 키는 호스트 선검사에서 그대로 막는다 — 실행할 수 없는 호출에 사람의 권한 요청을 띄우지 않는다.
    inputSchema: z.toJSONSchema(argsSchema),
    surface: {
      panelId: "objectives",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const found = args.objectiveId ? store.find(args.objectiveId) : null;
        const theaterId = bound?.theaterId ?? args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `목표 추가 「${short(args.add.title)}」`, view: "objectives", gesture: "create" };
        const titleOf = (id: string) => short(store.find(id)?.title ?? "");
        const theaterOf = (id: string | undefined) => args.theaterId ?? (id ? store.find(id)?.theaterId : undefined) ?? "";
        if (args.remove) { const removeIds = args.remove.objectiveIds; return { theaterId: theaterOf(removeIds[0]), summary: removeIds.length === 1 ? `목표 지움 「${titleOf(removeIds[0]!)}」` : `목표 ${removeIds.length}개 지움`, view: "objectives", gesture: "press" }; }
        if (args.merge) return { theaterId: theaterOf(args.merge.into), summary: `목표 ${args.merge.from.length}개를 「${titleOf(args.merge.into)}」에 합침`, view: "objective", path: args.merge.into, gesture: "press" };
        if (args.restore) return { theaterId: theaterOf(args.restore[0]), summary: args.restore.length === 1 ? `목표 되돌림 「${titleOf(args.restore[0]!)}」` : `목표 ${args.restore.length}개 되돌림`, view: "objectives", gesture: "press" };
        const write = TARGET_WRITES.find((key) => args[key] !== undefined);
        if (write) return { theaterId, summary: `목표 ${write} 「${short(found?.title ?? "")}」`, view: "objective", ...(found ? { path: found.id } : {}), gesture: "press" };
        return { theaterId, summary: args.view === "objective" || (args.objectiveId && !args.view) ? `목표 봄 「${short(found?.title ?? "")}」` : args.view === "groups" ? "그룹 봄" : "목표 목록 봄", view: args.view ?? (args.objectiveId ? "objective" : "objectives"), ...(found ? { path: found.id } : {}) };
      },
    },
    execute: async (raw, context) => {
      const rawAdd = raw && typeof raw === "object" ? (raw as { add?: unknown }).add : null;
      // 생성 요청에 낀 읽기 전용 키는 조용히 버리는 대신 생성 전에 거절한다 — groupId 를 함께 줘도 호출 Operation 의
      // 그룹으로 생기므로, 착각한 채 만들지 않게 한다. 읽기(view·objective + groupId·objectiveId·filter)에는 닿지 않는다.
      if (rawAdd && typeof rawAdd === "object") {
        const readKeys = ADD_READ_KEYS.filter((key) => key in (raw as Record<string, unknown>));
        if (readKeys.length > 0) return refuse("add_brief_criteria_only", { rejected: readKeys, hint: "groupId, objectiveId, view and filter only shape reads; with add they would be silently ignored. The new objective always follows the calling Operation's group — add carries the brief and success criteria, so pass only add (and theaterId when the theater is ambiguous)." });
      }
      // 쓰기는 한 호출에 하나 — 같이 온 읽기 키도 조용히 버리지 않는다.
      if (raw && typeof raw === "object") {
        const writes = WRITE_KEYS.filter((key) => key in (raw as Record<string, unknown>));
        const targeted = writes.some((key) => (TARGET_WRITES as readonly string[]).includes(key));
        const readKeys = ADD_READ_KEYS.filter((key) => (key !== "objectiveId" || !targeted) && key in (raw as Record<string, unknown>));
        if (writes.length > 1 || (writes.length === 1 && writes[0] !== "add" && readKeys.length > 0)) return refuse("one_write_per_call", { rejected: writes.length > 1 ? writes : readKeys });
      }
      const parsed = argsSchema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      const args: Args = parsed.data;
      const caller: BoardCaller | undefined = bound ?? context.caller;
      try {
        if (bound && args.theaterId !== undefined && args.theaterId !== bound.theaterId) return refuse("other_theater");
        if (bound) {
          const targets = [args.objectiveId, ...(args.remove?.objectiveIds ?? []), args.merge?.into, ...(args.merge?.from ?? []), ...(args.restore ?? [])].filter((id): id is string => id !== undefined);
          for (const id of targets) scoped(id);
        }
        const write = TARGET_WRITES.find((key) => args[key] !== undefined);
        if (write) {
          if (!args.objectiveId) return refuse("objective_required");
          const current = scoped(args.objectiveId);
          const actor = actorOf(caller);
          if (!actor) return refuse("operation_caller_required");
          if (caller?.kind === "operation" && roleIn(current, caller)) return refuse("own_objective");
          const actions = createObjectiveActions(ctx, store, launch, actor);
          const ref = { objectiveId: current.id, language: language(caller) };
          const withContext = (value: true | { context?: string }) => ({ ...ref, ...(value === true ? {} : value) });
          const result = await (async () => {
            if (args.plan) return actions.plan(withContext(args.plan));
            if (args.commence) return actions.commence(withContext(args.commence));
            if (args.criteria) return "approve" in args.criteria ? (args.criteria.approve === "all" ? actions.approveAll(ref) : actions.approve({ ...ref, proposalId: args.criteria.approve })) : actions.reject({ ...ref, proposalId: args.criteria.reject });
            if (args.answer) return actions.answer({ ...ref, ...args.answer });
            if (args.complete) return actions.complete({ ...ref, ...(args.complete === true ? {} : args.complete) });
            if (args.reopen) return actions.complete({ ...ref, undone: true });
            if (args.steer) return actions.steer(withContext(args.steer));
            if (args.message) return actions.message({ ...ref, ...args.message });
            if (args.stop) return actions.stop(ref);
            if (args.compact) return actions.compact(ref);
            if (args.extend) return actions.extend({ ...ref, ...args.extend });
            if (args.followup) {
              if ("retry" in args.followup) return actions.followupRetry({ ...ref, ...args.followup.retry });
              if ("abandon" in args.followup) return actions.followupAbandon({ ...ref, ...args.followup.abandon });
              return actions.followupDiscard({ ...ref, candidateId: args.followup.discard });
            }
            const edit = args.edit!;
            if ("brief" in edit) return actions.patch({ ...ref, patch: { note: edit.brief } });
            if ("mission" in edit) {
              if ("add" in edit.mission) return actions.missionAdd({ ...ref, mission: edit.mission.add });
              if ("patch" in edit.mission) return actions.missionPatch({ ...ref, missionId: edit.mission.patch.missionId, patch: edit.mission.patch.changes });
              return actions.missionRemove({ ...ref, missionId: edit.mission.remove });
            }
            if ("add" in edit.criterion) return actions.criterionAdd({ ...ref, criterion: edit.criterion.add });
            if ("patch" in edit.criterion) return actions.criterionPatch({ ...ref, criterionId: edit.criterion.patch.criterionId, patch: { text: edit.criterion.patch.text } });
            return actions.criterionRemove({ ...ref, criterionId: edit.criterion.remove });
          })();
          const { objective: updated, ...details } = result;
          return text({ ok: true, objectiveId: updated.id, ...details });
        }
        if (args.remove || args.merge || args.restore) {
          // 정리는 에이전트 Operation 이 한다 — 누가 지웠는지가 사람의 보드에 남아야 한다.
          if (caller?.kind !== "operation") return refuse("operation_caller_required");
          if (!spend(tidyBudget, callerKey(caller), MAX_TIDY_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_TIDY_PER_TURN });
          const actor = (why?: string) => ({ operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null, ...(why ? { reason: why } : {}) });
          // 후속으로 태어난 목표면 원본의 배치 표시(생성됨·삭제됨)가 이 목표의 지운 표시에서 나온다 — 바뀐 목표마다 원본을 다시 방송한다.
          const touched = (ids: readonly string[]) => { for (const id of ids) launch.followupTargetChanged(id); };
          if (args.remove) { const removed = store.tidyRemove(args.remove.objectiveIds, actor(args.remove.reason)).map((objective) => objective.id); touched(removed); return text({ ok: true, removed }); }
          if (args.merge) { const target = store.tidyMerge(args.merge.into, args.merge.from, actor(args.merge.reason)); touched(args.merge.from); return text({ ok: true, objectiveId: target.id, merged: args.merge.from, criteria: target.criteria.length }); }
          // 되돌리기도 지우기·합치기처럼 전부 받을 수 있을 때만 바꾼다 — 일부만 되돌린 채 오류로 끝나지 않게.
          const restoreIds = [...new Set(args.restore!)];
          const refusals = restoreIds.flatMap((id) => { const found = store.find(id); return !found ? [{ objectiveId: id, reason: "unknown_objective" }] : !found.removed ? [{ objectiveId: id, reason: "not_removed" }] : []; });
          if (refusals.length) return refuse("tidy_refused", { refusals });
          const restored = restoreIds.map((id) => store.tidyRestore(id).id);
          touched(restored);
          return text({ ok: true, restored });
        }
        if (!args.add) return text(read(args, caller));
        const add = args.add;
        const theaterId = args.theaterId ?? theaterOfCaller(caller);
        if (!theaterId) return refuse("theater_required");
        if (caller?.kind === "operation" && !spend(addBudget, callerKey(caller), MAX_ADD_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN });
        // 그룹은 입력으로 받지 않는다 — 호출 Operation 의 그룹을 그대로 따른다.
        const groupId = caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null;
        const objective = await launch.create({
          theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}),
          // 달성 기준 문장은 검증된 순서 그대로 기본 요구사항으로 함께 저장된다 — 한 건이라도 맞지 않으면 위 스키마에서
          // 거절되므로 목표가 기준 없이 먼저 생기지 않는다. AI 생성 표시는 목표의 addedBy 로 남는다.
          ...(add.criteria?.length ? { criteria: [...add.criteria] } : {}),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : {}),
        }, { language: language(caller), ...(actorOf(caller) ? { actor: actorOf(caller)! } : {}) });
        return text({ ok: true, objectiveId: objective.id });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, error.details ?? {});
        return refuse("objectives_failed");
      }
    },
  };

  function read(args: Args, caller: BoardCaller | undefined) {
    if (args.view === "objective" || (args.objectiveId && !args.view)) {
      const objective = args.objectiveId ? scoped(args.objectiveId) : null;
      if (!objective) throw new ObjectiveStoreError("unknown_objective");
      return { objective: { ...objectiveView(objective), decisionRequest: objective.decisionRequest } };
    }
    const theaterId = args.theaterId ?? theaterOfCaller(caller);
    if (!theaterId) throw new ObjectiveStoreError("theater_required");
    if (args.view === "groups") { const objectives = store.list(theaterId); return { theaterId, groups: (ctx.host.operations.groups?.list(theaterId) ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color, open: objectives.filter((objective) => !objective.done && !objective.removed && objective.groupId === group.id).length })) }; }
    const today = new Date().toISOString().slice(0, 10);
    const objectives = store.list(theaterId).filter((objective) => {
      if (args.groupId && objective.groupId !== args.groupId) return false;
      if (args.filter !== "all" && objective.removed) return false;
      if (args.filter === "today") return objective.today && !objective.done;
      if (args.filter === "due") return !!objective.dueDate && !objective.done;
      if (args.filter === "agent") return !!objective.addedBy;
      // 모두 — 완료한 목표와 지우거나 합친 목표까지. 필터가 없으면 끝나지 않은 목표만이다.
      if (args.filter === "all") return true;
      return !objective.done;
    });
    // 부른 세션이 목록에 목표로 서 있으면 그 줄을 self 로 가리킨다.
    const self = caller?.kind === "operation" ? caller.operationId : null;
    return { theaterId, today, objectives: objectives.map((objective) => (objective.id === self ? { ...rowView(objective), self: true } : rowView(objective))) };
  }

  return [tool];
}
