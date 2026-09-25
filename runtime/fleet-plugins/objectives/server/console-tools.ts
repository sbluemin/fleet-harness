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
/** 수행 쪽으로 옮겨 간 인자 — 이 판 이전에 뜬 지휘관이 옛 설명대로 부르면 새 자리를 알려 준다. */
const MOVED_KEYS = ["step", "plan", "criterion", "review"] as const;
/**
 * 목표 추가에 넣을 수 없는 인자 — 임무 편성(steps·after·구성원)은 지휘관이 구상에서 짜고, 일정·중요 표시·오늘(today)은
 * 사람의 화면에서 다루며, 그룹은 호출 Operation 을 따른다. 옛 설명대로 부르면 invalid_arguments 가 아니라 아래
 * 역할 경계로 거절한다(무시하고 만들지 않는다).
 */
const ADD_REJECTED_KEYS = ["steps", "after", "members", "member", "important", "dueDate", "today", "groupId"] as const;
/** 금지 편성 키 거절에 붙는 이유 안내 — 중첩(add 안)과 최상위(생성 요청)가 같은 말을 쓴다. */
const ADD_BOUNDARY_HINT = "console_objectives add carries only the brief (title, note) and success criteria. The lineup — missions, prerequisites and members — is planned by its Commander through the fleet-objectives tools once the person asks for planning; importance, due dates and grouping stay the person's acts on the screen, and the group follows the calling Operation.";
/**
 * add 와 함께 오면 조용히 버려지는 읽기 전용 키 — 생성 전에 이유 있게 거절한다.
 * 읽기로 쓸 때(view·item·groups + groupId·itemId·filter)는 그대로 두므로 읽기 계약은 바뀌지 않는다.
 */
const ADD_READ_KEYS = ["groupId", "itemId", "view", "filter"] as const;
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
const addSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), criteria: z.array(criterionText).max(MAX_CRITERIA).optional() }).strict();

const argsSchema = z.object({
  theaterId: ids.optional(),
  view: z.enum(["groups", "items", "item"]).optional(),
  groupId: ids.optional(),
  itemId: ids.optional(),
  filter: z.enum(["today", "due", "all", "agent"]).optional(),
  add: addSchema.optional(),
}).strict();
type Args = z.output<typeof argsSchema>;
/**
 * 호스트 선검사에 내보내는 스키마 — 최상위와 add 모두 모르는 키를 통과시킨다. strict 인 add 가 그대로 나가면
 * 옛 추가 인자가 선검사에서 일반 invalid_arguments 로 막혀 execute 의 역할 경계 거절(add_brief_criteria_only)에
 * 닿지 못한다. 허용 입력의 엄격한 검사는 execute 가 안내 뒤에 한다(부작용 없는 거절 유지).
 */
const exposedSchema = argsSchema.extend({ add: addSchema.loose().optional() }).loose();

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  const { itemView, rowView, languageOf } = createBoardViews(ctx, store);
  const addBudget = new Map<string, { at: number; count: number }>();
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const callerKey = (caller: ConsoleCaller | undefined): string => (caller ? (caller.kind === "operation" ? `op:${caller.operationId}` : `plugin:${caller.pluginId}`) : "anonymous");

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "The Objectives board of a Theater, as the person sees it. Every agent Operation of the Theater is an objective — the objective id is its Commander Operation id — carried out by missions. Read with view groups | items (filter today|due|all|agent) | item (note = the brief, attachments, steps = missions, criteria = success criteria, members). Write with add: title; optional note (the brief), criteria (success-criterion sentences); at most 10 adds per caller per 10 minutes. The new objective carries no missions and follows the calling Operation's group; importance, due dates and grouping stay the person's acts on the screen. The new objective's Commander Operation is created dormant until the person presses Plan or Commence. Carrying an objective out — planning, mustering members, completing missions, marking criteria — belongs to its Commander through the fleet-objectives tools, not here. Completing an objective and editing its brief after creation are the person's acts on the screen.",
    // 노출 스키마는 최상위와 add 모두 모르는 키를 막지 않는다 — 호스트가 이 스키마로 먼저 검사하므로, strict 이면 옛 인자가
    // execute 에 닿지 못해 새 자리 안내(moved_to_fleet_objectives)·역할 경계 거절(add_brief_criteria_only) 대신
    // invalid_arguments 로 끝난다. 엄격한 검사는 execute 가 안내 뒤에 한다.
    inputSchema: z.toJSONSchema(exposedSchema),
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
      const rawAdd = raw && typeof raw === "object" ? (raw as { add?: unknown }).add : null;
      // 생성 요청에 낀 읽기 전용 키는 조용히 버리는 대신 생성 전에 거절한다 — groupId 를 함께 줘도 호출 Operation 의
      // 그룹으로 생기므로, 착각한 채 만들지 않게 한다. 읽기(view·item + groupId·itemId·filter)에는 닿지 않는다.
      if (rawAdd && typeof rawAdd === "object") {
        const readKeys = ADD_READ_KEYS.filter((key) => key in (raw as Record<string, unknown>));
        if (readKeys.length > 0) return refuse("add_brief_criteria_only", { rejected: readKeys, hint: "groupId, itemId, view and filter only shape reads; with add they would be silently ignored. The new objective always follows the calling Operation's group — pass only add (and theaterId when the theater is ambiguous)." });
        // 생성 요청 최상위에 섞인 금지 편성 키도 같은 이유 안내로 거절한다 — 미지 키 취급(invalid_arguments)이 아니다.
        // add 없이 읽기로 쓸 때는 기존 계약 그대로 두므로, 이 검사는 생성 요청에만 닿는다.
        const topRejected = ADD_REJECTED_KEYS.filter((key) => key !== "groupId" && key in (raw as Record<string, unknown>));
        if (topRejected.length > 0) return refuse("add_brief_criteria_only", { rejected: topRejected, hint: ADD_BOUNDARY_HINT });
      }
      // 옛 추가 인자는 엄격한 스키마 검사보다 먼저 역할 경계로 거절한다 — invalid_arguments 로 끝내지도, 빼고 만들지도 않는다.
      const rejected = raw && typeof raw === "object" && (raw as { add?: unknown }).add && typeof (raw as { add?: unknown }).add === "object"
        ? ADD_REJECTED_KEYS.filter((key) => key in ((raw as { add: Record<string, unknown> }).add))
        : [];
      if (rejected.length > 0) return refuse("add_brief_criteria_only", { rejected, hint: ADD_BOUNDARY_HINT });
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
        const item = await launch.create({
          theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}),
          // 달성 기준 문장은 검증된 순서 그대로 기본 요구사항으로 함께 저장된다 — 한 건이라도 맞지 않으면 위 스키마에서
          // 거절되므로 목표가 기준 없이 먼저 생기지 않는다. AI 생성 표시는 목표의 addedBy 로 남는다.
          ...(add.criteria?.length ? { criteria: [...add.criteria] } : {}),
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
