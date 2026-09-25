import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_TITLE } from "./types.js";
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
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
const addSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), criteria: z.array(criterionText).max(MAX_CRITERIA).optional() }).strict();

const argsSchema = z.object({
  theaterId: ids.optional(),
  view: z.enum(["groups", "objectives", "objective"]).optional(),
  groupId: ids.optional(),
  objectiveId: ids.optional(),
  filter: z.enum(["today", "due", "all", "agent"]).optional(),
  add: addSchema.optional(),
}).strict();
type Args = z.output<typeof argsSchema>;

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  const { objectiveView, rowView, languageOf } = createBoardViews(ctx, store);
  const addBudget = new Map<string, { at: number; count: number }>();
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const callerKey = (caller: ConsoleCaller | undefined): string => (caller ? (caller.kind === "operation" ? `op:${caller.operationId}` : `plugin:${caller.pluginId}`) : "anonymous");

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "The Objectives board of a Theater, as the person sees it. Every agent Operation of the Theater is an objective — the objective id is its Commander Operation id — carried out by missions. Read with view groups | objectives (filter today|due|all|agent) | objective (note = the brief, attachments, missions, criteria = success criteria, members). Write with add: title; optional note (the brief), criteria (success-criterion sentences); at most 10 adds per caller per 10 minutes. The new objective carries no missions and follows the calling Operation's group; importance, due dates and grouping stay the person's acts on the screen. The new objective's Commander Operation is created dormant until the person presses Plan or Commence. Carrying an objective out — planning, mustering members, completing missions, marking criteria — belongs to its Commander through the fleet-objectives tools, not here. Completing an objective and editing its brief after creation are the person's acts on the screen.",
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
        return { theaterId, summary: args.view === "objective" || (args.objectiveId && !args.view) ? `목표 봄 「${short(found?.title ?? "")}」` : args.view === "groups" ? "그룹 봄" : "목표 목록 봄", view: args.view ?? (args.objectiveId ? "objective" : "objectives"), ...(found ? { path: found.id } : {}) };
      },
    },
    execute: async (raw, context) => {
      const rawAdd = raw && typeof raw === "object" ? (raw as { add?: unknown }).add : null;
      // 생성 요청에 낀 읽기 전용 키는 조용히 버리는 대신 생성 전에 거절한다 — groupId 를 함께 줘도 호출 Operation 의
      // 그룹으로 생기므로, 착각한 채 만들지 않게 한다. 읽기(view·objective + groupId·objectiveId·filter)에는 닿지 않는다.
      if (rawAdd && typeof rawAdd === "object") {
        const readKeys = ADD_READ_KEYS.filter((key) => key in (raw as Record<string, unknown>));
        if (readKeys.length > 0) return refuse("add_brief_criteria_only", { rejected: readKeys, hint: "groupId, objectiveId, view and filter only shape reads; with add they would be silently ignored. The new objective always follows the calling Operation's group — add carries only the brief (title, note) and success criteria, so pass only add (and theaterId when the theater is ambiguous)." });
      }
      const parsed = argsSchema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      const args: Args = parsed.data;
      const caller = context.caller;
      try {
        if (!args.add) return text(read(args, caller));
        const add = args.add;
        const theaterId = args.theaterId ?? theaterOfCaller(caller);
        if (!theaterId) return refuse("theater_required");
        const budget = addBudget.get(callerKey(caller)) ?? { at: Date.now(), count: 0 };
        if (Date.now() - budget.at > 10 * 60_000) { budget.at = Date.now(); budget.count = 0; }
        if (budget.count >= MAX_ADD_PER_TURN) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN });
        budget.count += 1; addBudget.set(callerKey(caller), budget);
        // 그룹은 입력으로 받지 않는다 — 호출 Operation 의 그룹을 그대로 따른다.
        const groupId = caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null;
        const objective = await launch.create({
          theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}),
          // 달성 기준 문장은 검증된 순서 그대로 기본 요구사항으로 함께 저장된다 — 한 건이라도 맞지 않으면 위 스키마에서
          // 거절되므로 목표가 기준 없이 먼저 생기지 않는다. AI 생성 표시는 목표의 addedBy 로 남는다.
          ...(add.criteria?.length ? { criteria: [...add.criteria] } : {}),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : {}),
        }, { language: languageOf(caller) });
        return text({ ok: true, objective: objectiveView(objective) });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code);
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
    if (args.view === "groups") { const objectives = store.list(theaterId); return { theaterId, groups: (ctx.host.operations.groups?.list(theaterId) ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color, open: objectives.filter((objective) => !objective.done && objective.groupId === group.id).length })) }; }
    const today = new Date().toISOString().slice(0, 10);
    const objectives = store.list(theaterId).filter((objective) => {
      if (args.groupId && objective.groupId !== args.groupId) return false;
      if (args.filter === "today") return objective.today && !objective.done;
      if (args.filter === "due") return !!objective.dueDate && !objective.done;
      if (args.filter === "agent") return !!objective.addedBy;
      return !objective.done;
    });
    return { theaterId, today, objectives: objectives.map(rowView) };
  }

  return [tool];
}
