import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { TodoStoreError, type TodoStore } from "./store.js";
import { createItemSchema, patchItemSchema, planSchema, stepAddSchema, stepPatchSchema, type StepPatchInput, type TodoEditKind, type TodoItem } from "./types.js";

/**
 * 브라우저가 부르는 라우트. 전부 POST + JSON, 같은 origin 의 Console 만 지난다(`isTerminalAuthorized`).
 * 응답은 바뀐 항목 하나 — 화면은 응답이 아니라 `todo:item` 사건으로 갱신되므로 응답은 확인용이다.
 */

export interface TodoRoute {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly summary: string;
  readonly handler: RouteHandler;
}

const ids = z.string().min(1).max(128);
const language = z.enum(["en", "ko"]).optional();
const itemRef = z.object({ itemId: ids, language });
const stepRef = z.object({ itemId: ids, stepId: ids, language });

export function createTodoRoutes(ctx: FleetPluginServerContext, store: TodoStore, launch: LaunchService = createLaunchService(ctx, store)): readonly TodoRoute[] {
  const json = <S extends z.ZodTypeAny>(schema: S, run: (body: z.output<S>, req: http.IncomingMessage) => Promise<unknown> | unknown): RouteHandler => async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const value = await run(parsed.data, req);
      ctx.host.http.writeJson(res, 200, value ?? { ok: true });
    } catch (error) {
      if (error instanceof TodoStoreError) { ctx.host.http.writeJson(res, error.code === "unknown_item" || error.code === "unknown_step" ? 404 : 409, { error: error.code }); return true; }
      const code = error instanceof Error ? error.message : "todo_failed";
      ctx.host.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "todo_failed" });
    }
    return true;
  };

  const groupsOf = (theaterId: string) => ctx.host.operations.groups?.list(theaterId) ?? [];
  const item = (value: TodoItem) => ({ item: value });
  // 셰프가 일하는 동안에도 계속 잠기는 것 — 쿠킹·셰프 연결/교체·시작·제목과 일정·완료·삭제·일괄 재배선. 먼저 중단해야 한다.
  // 셰프 자신의 도구 경로(console-tools)는 이 문을 지나지 않는다.
  const unlessBusy = <A extends { itemId: string }, R>(run: (body: A) => R) => (body: A): R => { if (launch.busy(body.itemId)) throw new TodoStoreError("item_busy"); return run(body); };
  // 이 라우트들은 사람의 화면이다 — 셰프가 알아야 할 편집이면 항목에 쌓아 두고, 「시작」이 셰프에게 다시 읽으라고 알린다.
  const edited = async (kinds: readonly TodoEditKind[], run: () => Promise<TodoItem> | TodoItem) => {
    const next = await run();
    return item(kinds.length > 0 ? store.setEdited(next.id, kinds) : next);
  };
  const stepKinds = (patch: StepPatchInput): TodoEditKind[] => [
    ...(patch.text !== undefined || patch.done !== undefined || patch.result !== undefined ? ["steps" as const] : []),
    ...(patch.after !== undefined || patch.why !== undefined ? ["recipe" as const] : []),
    ...(patch.assign !== undefined ? ["assign" as const] : []),
  ];
  // 셰프가 일하는 동안에도 받는 사람의 편집 — 허용 조건을 지나야 한다. 기록은 위 edited 가 맡고(셰프가 있으면 쌓임), 쌓인 편집은 「스티어링」이 알린다.
  // 허용: 단계 추가 · 아직 시작 전(끝나지 않았고 담당이 없는) 단계의 문구·삭제·선행 · 메모.
  const steerable = <A extends { itemId: string }, R>(allowed: (body: A) => boolean, run: (body: A) => R) => (body: A): R => {
    if (launch.busy(body.itemId) && !allowed(body)) throw new TodoStoreError("item_busy");
    return run(body);
  };
  const notStarted = (itemId: string, stepId: string): boolean => {
    const target = store.find(itemId)?.steps.find((candidate) => candidate.id === stepId);
    return !!target && !target.done && !target.slot;
  };
  const only = (patch: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(patch).every((key) => keys.includes(key));

  return [
    { name: "state", method: "POST", summary: "Read the To-do items and groups of a Theater.", handler: json(z.object({ theaterId: ids, language }), ({ theaterId }) => ({ items: store.list(theaterId), groups: groupsOf(theaterId), launch: launch.describe() })) },
    { name: "item/create", method: "POST", summary: "Create a To-do item.", handler: json(createItemSchema, ({ language: _language, ...body }) => item(store.create({ ...body, author: { kind: "human" } }))) },
    { name: "item/patch", method: "POST", summary: "Edit a To-do item.", handler: json(itemRef.extend({ patch: patchItemSchema }), steerable(({ patch }) => only(patch, ["note"]), ({ itemId, patch }) => edited([...(patch.title !== undefined ? ["title" as const] : []), ...(patch.note !== undefined ? ["note" as const] : [])], () => store.patch(itemId, patch)))) },
    // 순서는 내용이 아니다 — 셰프가 일하는 동안에도 사람이 목록을 정리할 수 있게 busy 잠금을 지나지 않는다.
    { name: "item/move", method: "POST", summary: "Reorder a To-do item before or after another item of the same Theater.", handler: json(itemRef.extend({ beforeId: ids.optional(), afterId: ids.optional() }).refine((body) => (body.beforeId === undefined) !== (body.afterId === undefined)), ({ itemId, beforeId, afterId }) => item(store.move(itemId, beforeId !== undefined ? { beforeId } : { afterId: afterId! }))) },
    { name: "item/remove", method: "POST", summary: "Delete a To-do item (Operations stay).", handler: json(itemRef, unlessBusy(({ itemId }) => item(store.remove(itemId)))) },
    { name: "item/complete", method: "POST", summary: "Complete a To-do item and release its Operation slots.", handler: json(itemRef.extend({ undone: z.boolean().optional() }), unlessBusy(async ({ itemId, undone, language }) => item(undone ? store.reopen(itemId) : await launch.complete(itemId, "human", { language })))) },
    { name: "step/add", method: "POST", summary: "Add a step.", handler: json(itemRef.extend({ step: stepAddSchema }), steerable(({ step }) => step.assign === undefined, ({ itemId, step, language }) => edited(["steps"], () => launch.stepAdded(itemId, step, { language, by: "human" })))) },
    { name: "step/patch", method: "POST", summary: "Edit a step (text, done, dependencies).", handler: json(stepRef.extend({ patch: stepPatchSchema }), steerable(({ itemId, stepId, patch }) => only(patch, ["text"]) && notStarted(itemId, stepId), ({ itemId, stepId, patch, language }) => edited(stepKinds(patch), () => launch.stepPatched(itemId, stepId, patch, "human", { language })))) },
    { name: "step/remove", method: "POST", summary: "Remove a step.", handler: json(stepRef, steerable(({ itemId, stepId }) => notStarted(itemId, stepId), ({ itemId, stepId }) => edited(["steps"], () => store.stepRemove(itemId, stepId)))) },
    { name: "edge/toggle", method: "POST", summary: "Link or unlink two steps in the coordination graph.", handler: json(itemRef.extend({ from: ids, to: ids }), steerable(({ itemId, to }) => notStarted(itemId, to), ({ itemId, from, to }) => { const result = store.edgeToggle(itemId, from, to); return { item: store.setEdited(itemId, ["recipe"]), linked: result.linked }; })) },
    { name: "edge/linear", method: "POST", summary: "Chain all steps in order.", handler: json(itemRef, unlessBusy(({ itemId }) => edited(["recipe"], () => store.edgesLinear(itemId)))) },
    { name: "edge/clear", method: "POST", summary: "Remove all step dependencies.", handler: json(itemRef, unlessBusy(({ itemId }) => edited(["recipe"], () => store.edgesClear(itemId)))) },
    { name: "plan/request", method: "POST", summary: "Ask the Chef to cook the item (starts one when missing): it plans steps, prerequisites and delegation; nothing runs until Start. Optional context travels with the request and is kept on the item.", handler: json(itemRef.extend({ context: z.string().max(4000).optional() }), unlessBusy(({ itemId, language, context }) => { if (context !== undefined) store.patch(itemId, { cook: context }); return launch.requestPlan(itemId, { language }); })) },
    { name: "coordinator/stop", method: "POST", summary: "Interrupt the coordinator and every assignee Operation of an item (slots stay).", handler: json(itemRef, ({ itemId }) => launch.stop(itemId)) },
    { name: "coordinator/start", method: "POST", summary: "Start the coordinator and one named assignee session per open step, all at once.", handler: json(itemRef, unlessBusy(({ itemId, language }) => launch.startCoordinator(itemId, { language }))) },
    { name: "coordinator/steer", method: "POST", summary: "Tell the working Chef the person changed the board (one line) and clear the pending changes.", handler: json(itemRef, ({ itemId, language }) => launch.steer(itemId, { language }).then(item)) },
    { name: "coordinator/link", method: "POST", summary: "Put an existing Operation into the coordinator slot.", handler: json(itemRef.extend({ operationId: ids }), unlessBusy(({ itemId, operationId, language }) => launch.linkCoordinator(itemId, operationId, { language }))) },
    { name: "coordinator/unlink", method: "POST", summary: "Empty the coordinator slot (the Operation stays).", handler: json(itemRef, unlessBusy(({ itemId }) => item(store.setSlot(itemId, null, null)))) },
    { name: "step/unlink", method: "POST", summary: "Empty a step slot (the Operation stays).", handler: json(stepRef, async ({ itemId, stepId, language }) => item(await launch.unlinkStep(itemId, stepId, { language }))) },
    { name: "group/create", method: "POST", summary: "Create an Operation group (the To-do list).", handler: json(z.object({ theaterId: ids, language, name: z.string().trim().min(1).max(64), color: z.string().min(1).max(32) }), ({ theaterId, name, color }) => { const groups = ctx.host.operations.groups; if (!groups) throw new Error("groups_unavailable"); return { group: groups.create({ theaterId, name, color }) }; }) },
    { name: "palette-search", method: "POST", summary: "Search To-do items by title for the command palette.", handler: json(z.object({ theaterId: ids, language, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }), ({ theaterId, query, limit }) => {
      const needle = query.toLowerCase();
      const hits = store.list(theaterId).filter((candidate) => !candidate.done && candidate.title.toLowerCase().includes(needle)).slice(0, limit ?? 20);
      return { items: hits.map((candidate) => ({ id: candidate.id, title: candidate.title, groupId: candidate.groupId })) };
    }) },
    { name: "plan/apply", method: "POST", summary: "Replace the unassigned steps with a plan (coordinator tool path; also used by tests).", handler: json(itemRef.extend({ plan: planSchema }), async ({ itemId, plan, language }) => item(await launch.planApplied(itemId, plan, "human", { language }))) },
  ];
}
