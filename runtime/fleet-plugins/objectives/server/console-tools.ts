import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_TITLE } from "./types.js";
import { createBoardViews, refuse, text } from "./views.js";

/**
 * `console_objectives` — Console Use 의 목표 보드: 사람이 화면에서 하듯 목록·항목을 보고 목표를 더한다. 호출마다 보드 패널에
 * 제스처가 그려진다. 목표의 수행(계획·위임·완료·기준 충족)은 여기 없다 — 지휘관·담당의 작업 도구 `fleet-objectives` 의 것이다.
 * 목표 완료·메모는 사람만.
 */

const ids = z.string().min(1).max(128);
const MAX_ADD_PER_TURN = 10;
/** 수행 쪽으로 옮겨 간 인자 — 이 판 이전에 뜬 지휘관이 옛 설명대로 부르면 새 자리를 알려 준다. */
const MOVED_KEYS = ["step", "plan", "criterion", "review"] as const;

const argsSchema = z.object({
  theaterId: ids.optional(),
  view: z.enum(["groups", "items", "item"]).optional(),
  groupId: ids.optional(),
  itemId: ids.optional(),
  filter: z.enum(["today", "due", "all", "agent"]).optional(),
  add: z.object({ groupId: ids.nullable().optional(), title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), steps: z.array(z.string().trim().min(1).max(200)).max(40).optional(), after: z.array(z.array(z.number().int().min(0))).optional(), important: z.boolean().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().optional(),
}).strict();
type Args = z.output<typeof argsSchema>;

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  const { itemView, rowView, languageOf } = createBoardViews(ctx, store);
  const addBudget = new Map<string, { at: number; count: number }>();
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const callerKey = (caller: ConsoleCaller | undefined): string => (caller ? (caller.kind === "operation" ? `op:${caller.operationId}` : `plugin:${caller.pluginId}`) : "anonymous");

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "The Objectives board of a Theater, as the person sees it. Every agent Operation of the Theater is an objective — the objective id is its Commander Operation id — carried out by missions. Read with view groups | items (filter today|due|all|agent) | item (brief, attachments, missions, success criteria). Write with add (a new objective with optional missions; its Commander Operation is created dormant until the person presses Plan or Commence). Carrying an objective out — planning, mustering members, completing missions, marking criteria — belongs to its Commander through the fleet-objectives tools, not here. Completing an objective and writing the brief are the person's acts on the screen.",
    // 노출 스키마는 모르는 키를 막지 않는다 — 호스트가 이 스키마로 먼저 검사하므로, strict 이면 옛 인자가 execute 에 닿지 못해
    // 새 자리 안내(moved_to_fleet_objectives) 대신 invalid_arguments 로 끝난다. 엄격한 검사는 execute 가 안내 뒤에 한다.
    inputSchema: z.toJSONSchema(argsSchema.loose()),
    surface: {
      panelId: "objectives",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const found = args.itemId ? store.find(args.itemId) : null;
        const theaterId = args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `목표 추가 「${short(args.add.title)}」`, view: "items", gesture: "create" };
        return { theaterId, summary: args.view === "item" || (args.itemId && !args.view) ? `목표 봄 「${short(found?.title ?? "")}」` : args.view === "groups" ? "그룹 봄" : "목표 목록 봄", view: args.view ?? (args.itemId ? "item" : "items"), ...(found ? { path: found.id } : {}) };
      },
    },
    execute: async (raw, context) => {
      const moved = raw && typeof raw === "object" ? [...MOVED_KEYS.filter((key) => key in raw), ...((raw as { view?: unknown }).view === "mine" ? ["view: mine"] : [])] : [];
      if (moved.length > 0) return refuse("moved_to_fleet_objectives", { moved, hint: "Carrying out an objective moved to the fleet-objectives tools (mine, read, plan, add_mission, place_mission, muster, complete_mission, mark_criterion)." });
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
        const groupId = add.groupId === undefined ? (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null) : add.groupId;
        const item = await launch.create({
          theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}), ...(add.important !== undefined ? { important: add.important } : {}), ...(add.dueDate ? { dueDate: add.dueDate } : {}),
          steps: (add.steps ?? []).map((stepText, index) => ({ text: stepText, after: add.after?.[index] ?? [] })),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : {}),
        }, { language: languageOf(caller) });
        return text({ ok: true, item: itemView(item) });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code);
        return refuse("objectives_failed");
      }
    },
  };

  function read(args: Args, caller: ConsoleCaller | undefined) {
    if (args.view === "item" || (args.itemId && !args.view)) {
      const item = args.itemId ? store.find(args.itemId) : null;
      if (!item) throw new ObjectiveStoreError("unknown_item");
      return { item: itemView(item) };
    }
    const theaterId = args.theaterId ?? theaterOfCaller(caller);
    if (!theaterId) throw new ObjectiveStoreError("theater_required");
    if (args.view === "groups") { const items = store.list(theaterId); return { theaterId, groups: (ctx.host.operations.groups?.list(theaterId) ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color, open: items.filter((item) => !item.done && item.groupId === group.id).length })) }; }
    const today = new Date().toISOString().slice(0, 10);
    const items = store.list(theaterId).filter((item) => {
      if (args.groupId && item.groupId !== args.groupId) return false;
      if (args.filter === "today") return item.today && !item.done;
      if (args.filter === "due") return !!item.dueDate && !item.done;
      if (args.filter === "agent") return !!item.addedBy;
      return !item.done;
    });
    return { theaterId, today, items: items.map(rowView) };
  }

  return [tool];
}
