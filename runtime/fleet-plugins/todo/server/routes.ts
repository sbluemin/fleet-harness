import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { TodoStoreError, type TodoStore } from "./store.js";
import { createItemSchema, patchItemSchema, planSchema, stepAddSchema, stepPatchSchema, type TodoItem } from "./types.js";

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
  // 조율자가 일하는 동안 사람의 편집은 잠긴다 — 먼저 중단해야 한다. 조율자 자신의 도구 경로(console-tools)는 이 문을 지나지 않는다.
  const unlessBusy = <A extends { itemId: string }, R>(run: (body: A) => R) => (body: A): R => { if (launch.busy(body.itemId)) throw new TodoStoreError("item_busy"); return run(body); };

  return [
    { name: "state", method: "POST", summary: "Read the To-do items and groups of a Theater.", handler: json(z.object({ theaterId: ids, language }), ({ theaterId }) => ({ items: store.list(theaterId), groups: groupsOf(theaterId), launch: launch.describe() })) },
    { name: "item/create", method: "POST", summary: "Create a To-do item.", handler: json(createItemSchema, ({ language: _language, ...body }) => item(store.create({ ...body, author: { kind: "human" } }))) },
    { name: "item/patch", method: "POST", summary: "Edit a To-do item.", handler: json(itemRef.extend({ patch: patchItemSchema }), unlessBusy(({ itemId, patch }) => item(store.patch(itemId, patch)))) },
    { name: "item/remove", method: "POST", summary: "Delete a To-do item (Operations stay).", handler: json(itemRef, unlessBusy(({ itemId }) => item(store.remove(itemId)))) },
    { name: "item/complete", method: "POST", summary: "Complete a To-do item and release its Operation slots.", handler: json(itemRef.extend({ undone: z.boolean().optional() }), unlessBusy(async ({ itemId, undone, language }) => item(undone ? store.reopen(itemId) : await launch.complete(itemId, "human", { language })))) },
    { name: "step/add", method: "POST", summary: "Add a step.", handler: json(itemRef.extend({ step: stepAddSchema }), unlessBusy(async ({ itemId, step, language }) => item(await launch.stepAdded(itemId, step, { language })))) },
    { name: "step/patch", method: "POST", summary: "Edit a step (text, done, dependencies).", handler: json(stepRef.extend({ patch: stepPatchSchema }), unlessBusy(async ({ itemId, stepId, patch, language }) => item(await launch.stepPatched(itemId, stepId, patch, "human", { language })))) },
    { name: "step/remove", method: "POST", summary: "Remove a step.", handler: json(stepRef, unlessBusy(({ itemId, stepId }) => item(store.stepRemove(itemId, stepId)))) },
    { name: "edge/toggle", method: "POST", summary: "Link or unlink two steps in the coordination graph.", handler: json(itemRef.extend({ from: ids, to: ids }), unlessBusy(({ itemId, from, to }) => { const result = store.edgeToggle(itemId, from, to); return { item: result.item, linked: result.linked }; })) },
    { name: "edge/linear", method: "POST", summary: "Chain all steps in order.", handler: json(itemRef, unlessBusy(({ itemId }) => item(store.edgesLinear(itemId)))) },
    { name: "edge/clear", method: "POST", summary: "Remove all step dependencies.", handler: json(itemRef, unlessBusy(({ itemId }) => item(store.edgesClear(itemId)))) },
    { name: "plan/request", method: "POST", summary: "Ask the Chef to cook the item (starts one when missing): it plans steps, prerequisites and delegation; nothing runs until Start. Optional context travels with the request and is kept on the item.", handler: json(itemRef.extend({ context: z.string().max(4000).optional() }), ({ itemId, language, context }) => { if (context !== undefined) store.patch(itemId, { cook: context }); return launch.requestPlan(itemId, { language }); }) },
    { name: "coordinator/stop", method: "POST", summary: "Interrupt the coordinator and every assignee Operation of an item (slots stay).", handler: json(itemRef, ({ itemId }) => launch.stop(itemId)) },
    { name: "coordinator/start", method: "POST", summary: "Start the coordinator and one named assignee session per open step, all at once.", handler: json(itemRef, ({ itemId, language }) => launch.startCoordinator(itemId, { language })) },
    { name: "coordinator/link", method: "POST", summary: "Put an existing Operation into the coordinator slot.", handler: json(itemRef.extend({ operationId: ids }), ({ itemId, operationId, language }) => launch.linkCoordinator(itemId, operationId, { language })) },
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
