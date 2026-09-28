import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_REMOVAL_REASON, MAX_TITLE } from "./types.js";
import { createBoardViews, refuse, text } from "./views.js";

/**
 * `console_objectives` — Console Use 의 목표 보드: 사람이 화면에서 하듯 목록·항목을 보고 목표를 더한다. 호출마다 보드 패널에
 * 제스처가 그려진다. 목표의 수행(계획·위임·완료·기준 충족)은 여기 없다 — 지휘관·담당의 작업 도구 `fleet-objectives` 의 것이다.
 * 목표 완료·메모는 사람만.
 */

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
const WRITE_KEYS = ["add", "remove", "merge", "restore"] as const;
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
const reason = z.string().trim().min(1).max(MAX_REMOVAL_REASON);
const addSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), criteria: z.array(criterionText).max(MAX_CRITERIA).optional() }).strict();

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
}).strict();
type Args = z.output<typeof argsSchema>;

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
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
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const callerKey = (caller: ConsoleCaller | undefined): string => (caller ? (caller.kind === "operation" ? `op:${caller.operationId}` : `plugin:${caller.pluginId}`) : "anonymous");

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "The Objectives board of a Theater, as the person sees it. Every agent Operation of the Theater is a virtual objective, while board-created objectives get a Commander Operation on first execution. Read with view groups | objectives | objective. objectives lists open objectives, or with filter today|due|agent|all (all includes completed ones); each row says kind (objective = the person treats it as an objective; session = an agent conversation not yet taken up as one), operation (whether a Commander or session Operation exists; false only for a board objective never launched), the brief's opening and the success-criterion texts. objective gives one in full (brief, attachments, missions, criteria = success criteria, members). Write with one of add, remove, merge or restore per call. add: title; optional note (the brief), criteria (success-criterion sentences); at most 10 adds per caller per 10 minutes. The new objective carries no missions and follows the calling Operation's group; importance, due dates and grouping stay the person's acts on the screen. The new objective does not create an Operation until the person presses Plan or Commence. Carrying an objective out — planning, mustering members, completing missions, marking criteria — belongs to its Commander through the fleet-objectives tools, not here. Completing an objective and editing its brief after creation are the person's acts on the screen. remove ({objectiveIds, reason}) and merge ({into, from: ids, reason}) accept only board objectives with operation false that are not completed; merge appends each source's brief under its title to the target's brief and moves its criteria there, and refuses sources carrying missions, members, attachments, results or follow-ups. A call with any objective it cannot accept changes nothing and lists each refusal with its reason. The optional reason is one line the person reads beside the removal. Removed and merged objectives stay on the person's board as removed by the calling Operation for 14 days and are then deleted for good; they leave the ordinary lists (filter all still shows them) and cannot be launched. The person, or restore (ids), brings one back, and restoring a merged source also takes its appended brief and moved criteria back out of the target. At most 20 of these calls per caller per 10 minutes.",
    // 모르는 키는 호스트 선검사에서 그대로 막는다 — 실행할 수 없는 호출에 사람의 권한 요청을 띄우지 않는다.
    inputSchema: z.toJSONSchema(argsSchema),
    surface: {
      panelId: "objectives",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const found = args.objectiveId ? store.find(args.objectiveId) : null;
        const theaterId = args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `목표 추가 「${short(args.add.title)}」`, view: "objectives", gesture: "create" };
        const titleOf = (id: string) => short(store.find(id)?.title ?? "");
        const theaterOf = (id: string | undefined) => args.theaterId ?? (id ? store.find(id)?.theaterId : undefined) ?? "";
        if (args.remove) { const removeIds = args.remove.objectiveIds; return { theaterId: theaterOf(removeIds[0]), summary: removeIds.length === 1 ? `목표 지움 「${titleOf(removeIds[0]!)}」` : `목표 ${removeIds.length}개 지움`, view: "objectives", gesture: "press" }; }
        if (args.merge) return { theaterId: theaterOf(args.merge.into), summary: `목표 ${args.merge.from.length}개를 「${titleOf(args.merge.into)}」에 합침`, view: "objective", path: args.merge.into, gesture: "press" };
        if (args.restore) return { theaterId: theaterOf(args.restore[0]), summary: args.restore.length === 1 ? `목표 되돌림 「${titleOf(args.restore[0]!)}」` : `목표 ${args.restore.length}개 되돌림`, view: "objectives", gesture: "press" };
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
        const readKeys = ADD_READ_KEYS.filter((key) => key in (raw as Record<string, unknown>));
        if (writes.length > 1 || (writes.length === 1 && writes[0] !== "add" && readKeys.length > 0)) return refuse("one_write_per_call", { rejected: writes.length > 1 ? writes : readKeys });
      }
      const parsed = argsSchema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      const args: Args = parsed.data;
      const caller = context.caller;
      try {
        if (args.remove || args.merge || args.restore) {
          // 정리는 에이전트 Operation 이 한다 — 누가 지웠는지가 사람의 보드에 남아야 한다.
          if (caller?.kind !== "operation") return refuse("operation_caller_required");
          if (!spend(tidyBudget, callerKey(caller), MAX_TIDY_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_TIDY_PER_TURN });
          const actor = (why?: string) => ({ operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null, ...(why ? { reason: why } : {}) });
          if (args.remove) return text({ ok: true, removed: store.tidyRemove(args.remove.objectiveIds, actor(args.remove.reason)).map((objective) => objective.id) });
          if (args.merge) { const target = store.tidyMerge(args.merge.into, args.merge.from, actor(args.merge.reason)); return text({ ok: true, objectiveId: target.id, merged: args.merge.from, criteria: target.criteria.length }); }
          // 되돌리기도 지우기·합치기처럼 전부 받을 수 있을 때만 바꾼다 — 일부만 되돌린 채 오류로 끝나지 않게.
          const restoreIds = [...new Set(args.restore!)];
          const refusals = restoreIds.flatMap((id) => { const found = store.find(id); return !found ? [{ objectiveId: id, reason: "unknown_objective" }] : !found.removed ? [{ objectiveId: id, reason: "not_removed" }] : []; });
          if (refusals.length) return refuse("tidy_refused", { refusals });
          return text({ ok: true, restored: restoreIds.map((id) => store.tidyRestore(id).id) });
        }
        if (!args.add) return text(read(args, caller));
        const add = args.add;
        const theaterId = args.theaterId ?? theaterOfCaller(caller);
        if (!theaterId) return refuse("theater_required");
        if (!spend(addBudget, callerKey(caller), MAX_ADD_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN });
        // 그룹은 입력으로 받지 않는다 — 호출 Operation 의 그룹을 그대로 따른다.
        const groupId = caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null;
        const objective = await launch.create({
          theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}),
          // 달성 기준 문장은 검증된 순서 그대로 기본 요구사항으로 함께 저장된다 — 한 건이라도 맞지 않으면 위 스키마에서
          // 거절되므로 목표가 기준 없이 먼저 생기지 않는다. AI 생성 표시는 목표의 addedBy 로 남는다.
          ...(add.criteria?.length ? { criteria: [...add.criteria] } : {}),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : {}),
        }, { language: languageOf(caller) });
        return text({ ok: true, objectiveId: objective.id });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, error.details ?? {});
        return refuse("objectives_failed");
      }
    },
  };

  function read(args: Args, caller: ConsoleCaller | undefined) {
    if (args.view === "objective" || (args.objectiveId && !args.view)) {
      const objective = args.objectiveId ? store.find(args.objectiveId) : null;
      if (!objective) throw new ObjectiveStoreError("unknown_objective");
      return { objective: objectiveView(objective) };
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
    // 부른 세션이 목록에 대화 세션으로 서 있으면 그 줄을 self 로 가리킨다.
    const self = caller?.kind === "operation" ? caller.operationId : null;
    return { theaterId, today, objectives: objectives.map((objective) => (objective.id === self ? { ...rowView(objective), self: true } : rowView(objective))) };
  }

  return [tool];
}
