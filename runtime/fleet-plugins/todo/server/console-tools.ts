import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { TodoStoreError, type TodoStore } from "./store.js";
import { coordinatorMode, stepReady, type SlotBy, type TodoItem, type TodoStep } from "./types.js";

/**
 * `console_todo` — 한 도구. 읽기(view)는 게이트를 지난 누구나, 쓰기는 슬롯이 권한이다: 단계 완료·단계 추가·계획은
 * 그 할 일의 셰프(할 일 슬롯의 Operation)만. 단계 담당은 도구가 없다. 할 일 완료·메모·Operation 연결은 사람만 — 도구에 없다.
 * 호스트가 호출마다 화면에 제스처를 그린다 — describe 가 종류와 자리를 말한다.
 */

const ids = z.string().min(1).max(128);
const MAX_ADD_PER_TURN = 10;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: (value && typeof value === "object" && !Array.isArray(value) ? value : { value }) as Record<string, unknown>, isError: false };
}
function refuse(error: string, extra: Record<string, unknown> = {}) {
  return { ...text({ error, ...extra }), isError: true };
}

const argsSchema = z.object({
  theaterId: ids.optional(),
  view: z.enum(["mine", "groups", "items", "item"]).optional(),
  groupId: ids.optional(),
  itemId: ids.optional(),
  filter: z.enum(["today", "due", "all", "agent"]).optional(),
  add: z.object({ groupId: ids.nullable().optional(), title: z.string().trim().min(1).max(200), note: z.string().max(20_000).optional(), steps: z.array(z.string().trim().min(1).max(200)).max(40).optional(), after: z.array(z.array(z.number().int().min(0))).optional(), important: z.boolean().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().optional(),
  step: z.object({ itemId: ids, add: z.string().trim().min(1).max(200).optional(), delegate: z.boolean().optional(), index: z.number().int().min(0).optional(), stepId: ids.optional(), doneIndex: z.number().int().min(0).optional(), doneStepId: ids.optional(), result: z.string().trim().max(4000).optional() }).strict().optional(),
  review: z.object({ itemId: ids, summary: z.string().trim().min(1).max(2000) }).strict().optional(),
  plan: z.object({ itemId: ids, steps: z.array(z.object({ text: z.string().trim().min(1).max(200), after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).optional(), assign: z.enum(["self", "route"]).optional() })).min(1).max(40) }).strict().optional(),
}).strict();
type Args = z.output<typeof argsSchema>;
const WRITE_KEYS = ["add", "step", "plan", "review"] as const;

export function createTodoConsoleTools(ctx: FleetPluginServerContext, store: TodoStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  const addBudget = new Map<string, { at: number; count: number }>();
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const callerTitle = (caller: ConsoleCaller | undefined): string => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.title ?? caller.operationId : caller?.kind === "plugin" ? caller.pluginId : "");
  const slotBy = (caller: ConsoleCaller | undefined): SlotBy => (caller?.kind === "operation" ? { operationId: caller.operationId } : "human");
  const languageOf = (caller: ConsoleCaller | undefined): "en" | "ko" => {
    if (caller?.kind !== "operation") return "en";
    const flag = ctx.host.operations.get(caller.operationId)?.payload.consoleUse as { language?: unknown } | undefined;
    return flag?.language === "ko" ? "ko" : "en";
  };
  const isCoordinator = (item: TodoItem, caller: ConsoleCaller | undefined) => caller?.kind === "operation" && item.slot?.operationId === caller.operationId;
  const stepOf = (item: TodoItem, ref: { stepId?: string; stepIndex?: number; doneIndex?: number; doneStepId?: string }): TodoStep | null => {
    if (ref.stepId) return item.steps.find((step) => step.id === ref.stepId) ?? null;
    if (ref.doneStepId) return item.steps.find((step) => step.id === ref.doneStepId) ?? null;
    const index = ref.stepIndex ?? ref.doneIndex;
    return index !== undefined ? item.steps[index] ?? null : null;
  };
  const observe = (operationId: string) => {
    const node = ctx.host.operations.get(operationId);
    if (!node) return { operationId, title: null, state: "closed" as const };
    const observation = ctx.host.consoleControl?.observe(operationId) ?? null;
    const consoleUse = (node.payload.consoleUse as { enabled?: unknown } | undefined)?.enabled === true;
    return { operationId, title: node.title, state: observation ? (observation.lifecycle === "dormant" ? "dormant" : observation.activity) : "unknown", consoleUse };
  };
  const graph = (item: TodoItem) => ({
    chef: item.slot ? { ...observe(item.slot.operationId), session: item.slot.sessionName ?? null, mode: coordinatorMode(item) } : null,
    mode: coordinatorMode(item),
    steps: item.steps.map((step, index) => ({
      index, stepId: step.id, text: step.text, done: step.done,
      after: step.after.map((id) => item.steps.findIndex((candidate) => candidate.id === id)).filter((value) => value >= 0),
      why: step.why ?? {},
      ready: !step.done && stepReady(item, step),
      result: step.result ?? null,
      assignee: step.slot ? { ...observe(step.slot.operationId), session: step.slot.sessionName ?? null } : null,
    })),
  });
  const itemView = (item: TodoItem) => ({
    id: item.id, theaterId: item.theaterId, groupId: item.groupId, title: item.title, note: item.note, important: item.important, dueDate: item.dueDate, today: item.today,
    done: !!item.done, review: item.review ?? null, author: item.author, updatedAt: item.updatedAt, graph: graph(item),
  });
  const rowView = (item: TodoItem) => ({ id: item.id, groupId: item.groupId, title: item.title, done: !!item.done, important: item.important, dueDate: item.dueDate, today: item.today, steps: `${item.steps.filter((step) => step.done).length}/${item.steps.length}`, mode: coordinatorMode(item), coordinator: item.slot?.operationId ?? null, author: item.author.kind });

  const tool: PluginMcpTool = {
    name: "console_todo",
    description: "The To-do board of a Theater: intent items with steps (a dependency graph linked by after; a step is ready when all of its prerequisites are done), one Chef Operation per item, and an assignee session per step the Chef chooses to delegate. The Chef is a named CLI session; assignees are named CLI sessions too (todo-<item id prefix>-step-<n>, n = index + 1) and talk with the Chef through Claude Code cross-session messages (SendMessage / ListAgents). This tool only reads and updates the board. Read with view mine (the calling Operation's own item and role) | groups | items (filter today|due|all|agent) | item (steps, dependencies, readiness, assignee sessions, results, the person's note). Write one of: add (a new item with optional steps); plan (replace the open unassigned steps with steps + dependencies + why + assign: self for steps the Chef will do itself, route for steps it intends to delegate; done and assigned steps are kept; Chef only); step with delegate: true and index or stepId (launch that step's assignee session now — it starts with no prompt and knows nothing, so instruct it with SendMessage giving the full context: item, exact step text, results of prerequisites, constraints from the person's note, paths, what not to touch, and the report you expect; it reports back by SendMessage; Chef only); step with add (append a step that became necessary; Chef only); step with doneIndex or doneStepId and a short result (mark one step done — the result is what the next step receives; Chef only); review with summary (every step is done — hand the item to the person for review; the person completes it; Chef only). Steps assigned self are the Chef's own work; whether to delegate a step is the Chef's call at the moment it reaches that step. Completing an item, writing the note and linking or unlinking Operations are the person's acts on the screen and have no tool here.",
    inputSchema: z.toJSONSchema(argsSchema),
    surface: {
      panelId: "todo",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const itemId = args.itemId ?? args.step?.itemId ?? args.plan?.itemId ?? args.review?.itemId;
        const found = typeof itemId === "string" ? store.find(itemId) : null;
        const theaterId = args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `할 일 추가 「${short(args.add.title)}」`, view: "items", gesture: "create" };
        if (args.plan) return { theaterId, summary: `단계 ${args.plan.steps.length}개 계획`, view: "item", gesture: "create", ...(found ? { path: found.id } : {}) };
        if (args.review) return { theaterId, summary: "검토 요청", view: "item", gesture: "press", ...(found ? { path: found.id } : {}) };
        if (args.step) return { theaterId, summary: args.step.add ? `단계 추가 「${short(args.step.add)}」` : args.step.delegate ? "단계 위임 — 담당 세션 띄움" : "단계 완료", view: "item", gesture: "press", ...(found ? { path: found.id } : {}) };
        return { theaterId, summary: args.view === "item" ? `할 일 봄 「${short(found?.title ?? "")}」` : args.view === "mine" ? "내 할 일 봄" : args.view === "groups" ? "그룹 봄" : "할 일 목록 봄", view: args.view === "mine" ? "items" : args.view ?? "items", ...(found ? { path: found.id } : {}) };
      },
    },
    execute: async (raw, context) => {
      const parsed = argsSchema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      const args: Args = parsed.data;
      const caller = context.caller;
      const writes = WRITE_KEYS.filter((key) => args[key] !== undefined);
      if (writes.length > 1) return refuse("one_write_at_a_time", { writes });
      const language = languageOf(caller);
      try {
        if (writes.length === 0) return text(read(args, caller));
        const key = writes[0]!;
        if (key === "add") {
          const add = args.add!;
          const theaterId = args.theaterId ?? theaterOfCaller(caller);
          if (!theaterId) return refuse("theater_required");
          const budget = addBudget.get(callerKey(caller)) ?? { at: Date.now(), count: 0 };
          if (Date.now() - budget.at > 10 * 60_000) { budget.at = Date.now(); budget.count = 0; }
          if (budget.count >= MAX_ADD_PER_TURN) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN });
          budget.count += 1; addBudget.set(callerKey(caller), budget);
          const groupId = add.groupId === undefined ? (caller?.kind === "operation" ? (ctx.host.operations.get(caller.operationId) as { groupId?: string | null } | null)?.groupId ?? null : null) : add.groupId;
          const item = store.create({
            theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}), ...(add.important !== undefined ? { important: add.important } : {}), ...(add.dueDate ? { dueDate: add.dueDate } : {}),
            steps: (add.steps ?? []).map((stepText, index) => ({ text: stepText, after: add.after?.[index] ?? [] })),
            author: caller?.kind === "operation" ? { kind: "operation", operationId: caller.operationId, title: callerTitle(caller) } : { kind: "operation", title: callerTitle(caller) },
          });
          return text({ ok: true, item: itemView(store.find(item.id) ?? item) });
        }
        const targetId = (args[key] as { itemId: string }).itemId;
        const item = store.find(targetId);
        if (!item) return refuse("unknown_item");
        // 이 아래는 셰프만 — 슬롯이 곧 권한이다.
        if (!isCoordinator(item, caller)) return refuse("not_item_operation", { hint: "Only the Operation in this item's Chef slot may do this." });
        if (key === "step") {
          const stepArgs = args.step!;
          if (stepArgs.add) return text({ ok: true, item: itemView(await launch.stepAdded(item.id, { text: stepArgs.add }, { language })) });
          const target = stepOf(item, { ...stepArgs, stepIndex: stepArgs.index });
          if (!target) return refuse("unknown_step");
          if (stepArgs.delegate) {
            // 위임 — 이 단계의 담당 세션을 지금 띄운다. 이름을 돌려주면 셰프가 SendMessage 로 맥락을 담아 일을 시킨다.
            const delegated = await launch.delegateStep(item.id, target.id, { language });
            return text({ ok: true, session: delegated.session, operationId: delegated.operationId, item: itemView(delegated.item) });
          }
          const next = await launch.stepPatched(item.id, target.id, { done: true, ...(stepArgs.result ? { result: stepArgs.result } : {}) }, slotBy(caller), { language });
          return text({ ok: true, item: itemView(next) });
        }
        if (key === "plan") return text({ ok: true, item: itemView(await launch.planApplied(item.id, { steps: args.plan!.steps }, slotBy(caller), { language })) });
        if (key === "review") {
          // 가승인 — 완료가 아니다. 사람이 검토해 완료를 누른다. 열린 단계가 남았으면 거절한다.
          if (item.steps.some((step) => !step.done)) return refuse("steps_open", { open: item.steps.filter((step) => !step.done).length });
          return text({ ok: true, item: itemView(store.setReview(item.id, { summary: args.review!.summary })) });
        }
        return refuse("invalid_arguments");
      } catch (error) {
        if (error instanceof TodoStoreError) return refuse(error.code);
        return refuse("todo_failed");
      }
    },
  };

  function callerKey(caller: ConsoleCaller | undefined): string {
    return caller ? (caller.kind === "operation" ? `op:${caller.operationId}` : `plugin:${caller.pluginId}`) : "anonymous";
  }
  function read(args: Args, caller: ConsoleCaller | undefined) {
    // 「내 자리」 — 이 Operation 이 어느 항목의 셰프인지, 어느 단계의 담당인지. 시스템 지침은 항목을 모르므로 세션이 이걸로 시작한다.
    if (args.view === "mine") {
      if (caller?.kind !== "operation") throw new TodoStoreError("not_item_operation");
      for (const candidate of store.all()) {
        if (candidate.slot?.operationId === caller.operationId) return { role: "chef", itemId: candidate.id, item: itemView(candidate) };
        const index = candidate.steps.findIndex((step) => step.slot?.operationId === caller.operationId);
        if (index >= 0) return { role: "step", itemId: candidate.id, stepIndex: index, stepId: candidate.steps[index]!.id, item: itemView(candidate) };
      }
      throw new TodoStoreError("not_item_operation");
    }
    if (args.view === "item" || (args.itemId && !args.view)) {
      const item = args.itemId ? store.find(args.itemId) : null;
      if (!item) throw new TodoStoreError("unknown_item");
      return { item: itemView(item) };
    }
    const theaterId = args.theaterId ?? theaterOfCaller(caller);
    if (!theaterId) throw new TodoStoreError("theater_required");
    if (args.view === "groups") return { theaterId, groups: (ctx.host.operations.groups?.list(theaterId) ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color, open: store.list(theaterId).filter((item) => !item.done && item.groupId === group.id).length })) };
    const today = new Date().toISOString().slice(0, 10);
    const items = store.list(theaterId).filter((item) => {
      if (args.groupId && item.groupId !== args.groupId) return false;
      if (args.filter === "today") return item.today && !item.done;
      if (args.filter === "due") return !!item.dueDate && !item.done;
      if (args.filter === "agent") return item.author.kind === "operation";
      return !item.done;
    });
    return { theaterId, today, items: items.map(rowView) };
  }

  return [tool];
}
