import fs from "node:fs";
import type http from "node:http";

import { IDENTITY_TONES } from "@fleet-console/sdk/operations/identity-tones";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { RouteHandler } from "@fleet-console/sdk/routing";
import { z } from "zod";

import { attachmentName, imageInfo, MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { createItemSchema, followupSelectionSchema, criterionAddSchema, criterionPatchSchema, MAX_CONTEXT, memberAddSchema, memberPatchSchema, patchItemSchema, planSchema, stepAddSchema, stepPatchSchema, type StepPatchInput, type ObjectiveEditKind, type ObjectiveItem } from "./types.js";

/**
 * 브라우저가 부르는 라우트. 전부 POST + JSON, 같은 origin 의 Console 만 지난다(`isTerminalAuthorized`).
 * 응답은 바뀐 항목 하나 — 화면은 응답이 아니라 `objectives:item` 사건으로 갱신되므로 응답은 확인용이다.
 */

export interface ObjectiveRoute {
  readonly name: string;
  readonly method: "GET" | "POST";
  readonly summary: string;
  readonly handler: RouteHandler;
}

const ids = z.string().min(1).max(128);
const language = z.enum(["en", "ko"]).optional();
const itemRef = z.object({ itemId: ids, language });
const stepRef = z.object({ itemId: ids, stepId: ids, language });
/** 사람이 지휘관에게 덧붙이는 말 — 구상·개시·스티어링이 같은 상한을 쓴다. */
const context = z.string().max(MAX_CONTEXT).optional();
/** 그룹 — 사이드바 그룹 그 자체. 색은 정체성 톤 키여야 영속 상태에 남는다(목록 밖 색의 그룹은 불러올 때 버려진다). */
const groupName = z.string().trim().min(1).max(64);
const groupColor = z.enum(IDENTITY_TONES);

export function createObjectiveRoutes(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly ObjectiveRoute[] {
  const json = <S extends z.ZodTypeAny>(schema: S, run: (body: z.output<S>, req: http.IncomingMessage) => Promise<unknown> | unknown): RouteHandler => async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const body = await ctx.host.http.readJsonBody<unknown>(req);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const value = await run(parsed.data, req);
      ctx.host.http.writeJson(res, 200, value ?? { ok: true });
    } catch (error) { fail(res, error); }
    return true;
  };
  const fail = (res: http.ServerResponse, error: unknown) => {
    if (error instanceof ObjectiveStoreError) { ctx.host.http.writeJson(res, ["unknown_item", "unknown_step", "unknown_member", "unknown_attachment", "unknown_criterion", "unknown_proposal", "unknown_group", "unknown_followup"].includes(error.code) ? 404 : 409, { error: error.code }); return; }
    const code = error instanceof Error ? error.message : "todo_failed";
    ctx.host.http.writeJson(res, 500, { error: code.length <= 64 && /^[a-z_]+$/.test(code) ? code : "todo_failed" });
  };
  const query = (req: http.IncomingMessage) => new URL(req.url ?? "/", "http://localhost").searchParams;
  /** 이미지 바이트를 한도까지 읽는다 — 넘으면 나머지는 흘려보내고 null. JSON 본문 한도(1MB)를 피하려고 원시 본문으로 받는다. */
  const readBytes = (req: http.IncomingMessage, limit: number): Promise<Buffer | null> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => { total += chunk.length; if (total > limit) { over = true; chunks.length = 0; return; } if (!over) chunks.push(chunk); });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });

  // 메모 첨부 — 올리기(원시 이미지 바이트, 형식은 머리 바이트로 판정)·받기(id 로, 경로는 브라우저에 나가지 않는다)·지우기.
  const attachmentAdd: RouteHandler = async ({ req, res }) => {
    if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    const itemId = params.get("itemId");
    if (!itemId || itemId.length > 128) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return true; }
    try {
      const data = await readBytes(req, MAX_ATTACHMENT_BYTES);
      if (!data) { ctx.host.http.writeJson(res, 413, { error: "attachment_too_large" }); return true; }
      const info = imageInfo(data);
      if (!info) { ctx.host.http.writeJson(res, 415, { error: "attachment_type" }); return true; }
      // 첨부는 메모의 일부다 — 지휘관이 일하는 동안에도 받고, 지휘관이 있으면 「메모」 편집으로 쌓인다.
      const add = steerable(() => true, ({ itemId: target }: { itemId: string }) => store.attachmentAdd(target, { name: attachmentName(params.get("name"), info.type), type: info.type, data, ...(info.width ? { width: info.width } : {}), ...(info.height ? { height: info.height } : {}) }));
      const result = await add({ itemId });
      ctx.host.http.writeJson(res, 200, { item: store.setEdited(itemId, ["note"]), attachmentId: result.attachment.id });
    } catch (error) { fail(res, error); }
    return true;
  };
  const attachmentFile: RouteHandler = async ({ req, res }) => {
    if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" }); return true; }
    if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return true; }
    const params = query(req);
    const found = store.find(params.get("itemId") ?? "");
    const attachment = found?.attachments?.find((entry) => entry.id === params.get("attachmentId"));
    if (!found || !attachment) { ctx.host.http.writeJson(res, 404, { error: "unknown_attachment" }); return true; }
    try {
      const data = await fs.promises.readFile(store.attachmentPath(found, attachment));
      res.writeHead(200, { "Content-Type": attachment.type, "Content-Length": data.length, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'" });
      res.end(data);
    } catch { ctx.host.http.writeJson(res, 404, { error: "unknown_attachment" }); }
    return true;
  };

  const groupsOf = (theaterId: string) => ctx.host.operations.groups?.list(theaterId) ?? [];
  const item = (value: ObjectiveItem) => ({ item: value });
  const syncSidebarOrder = (moved: ObjectiveItem) => {
    const reorder = ctx.host.operations.reorder;
    if (!reorder) return;
    const members = ctx.host.operations.list().filter((node) => node.theaterId === moved.theaterId && (node.groupId ?? null) === moved.groupId);
    const memberIds = new Set(members.map((node) => node.id));
    const boardIds = store.list(moved.theaterId).filter((entry) => entry.groupId === moved.groupId && memberIds.has(entry.id)).map((entry) => entry.id);
    const objectives = new Set(boardIds);
    // 목표가 차지한 자리만 재배열한다. 터미널·담당 Operation 은 기존 자리에 그대로 둔다.
    const slots = members.map((node) => node.id);
    let index = 0;
    const desired = slots.map((id) => objectives.has(id) ? boardIds[index++]! : id);
    if (desired.every((id, at) => id === slots[at])) return;
    // 호스트 포트는 한 덩어리를 삽입하므로 앞에서부터 목표 하나씩 제자리로 옮긴다.
    // 앞 멤버를 anchor 로 쓰면 이미 정렬된 접두부와 비목표 Operation 의 자리를 보존한다.
    const current = [...slots];
    for (let at = 0; at < desired.length; at += 1) {
      const id = desired[at]!;
      if (!objectives.has(id) || current[at] === id) continue;
      reorder({ theaterId: moved.theaterId, groupId: moved.groupId, operationIds: [id], position: at === 0 ? "first" : { after: desired[at - 1]! } });
      current.splice(current.indexOf(id), 1);
      current.splice(at, 0, id);
    }
  };
  // 지휘관이 일하는 동안에도 계속 잠기는 것 — 구상·시작·제목과 일정·완료·삭제·일괄 재배선. 먼저 중단해야 한다.
  // 지휘관 자신의 도구 경로(console-tools)는 이 문을 지나지 않는다.
  const unlessBusy = <A extends { itemId: string }, R>(run: (body: A) => R) => (body: A): R => { if (launch.busy(body.itemId)) throw new ObjectiveStoreError("item_busy"); return run(body); };
  // 이 라우트들은 사람의 화면이다 — 지휘관이 알아야 할 편집이면 항목에 쌓아 두고, 「시작」이 지휘관에게 다시 읽으라고 알린다.
  const edited = async (kinds: readonly ObjectiveEditKind[], run: () => Promise<ObjectiveItem> | ObjectiveItem) => {
    const next = await run();
    return item(kinds.length > 0 ? store.setEdited(next.id, kinds) : next);
  };
  const stepKinds = (patch: StepPatchInput): ObjectiveEditKind[] => [
    ...(patch.text !== undefined || patch.done !== undefined ? ["steps" as const] : []),
    ...(patch.after !== undefined || patch.why !== undefined ? ["recipe" as const] : []),
    ...(patch.member !== undefined ? ["assign" as const] : []),
  ];
  // 지휘관이 일하는 동안에도 받는 사람의 편집 — 허용 조건을 지나야 한다. 기록은 위 edited 가 맡고(지휘관이 있으면 쌓임), 쌓인 편집은 「스티어링」이 알린다.
  // 허용: 단계 추가 · 끝나지 않은 단계의 문구·삭제·선행·담당 · 명단 · 메모.
  const steerable = <A extends { itemId: string }, R>(allowed: (body: A) => boolean, run: (body: A) => R) => (body: A): R => {
    if (launch.busy(body.itemId) && !allowed(body)) throw new ObjectiveStoreError("item_busy");
    return run(body);
  };
  const notStarted = (itemId: string, stepId: string): boolean => {
    const target = store.find(itemId)?.steps.find((candidate) => candidate.id === stepId);
    return !!target && !target.done;
  };
  const only = (patch: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(patch).every((key) => keys.includes(key));

  return [
    { name: "state", method: "POST", summary: "Read the objectives and groups of a Theater.", handler: json(z.object({ theaterId: ids, language }), ({ theaterId }) => ({ items: store.list(theaterId), groups: groupsOf(theaterId), launch: launch.describe() })) },
    // 따로 만든 Operation 도 목표다 — 화면이 처음 보는 에이전트 Operation 을 목표 모양으로 받아 간다.
    { name: "item/get", method: "POST", summary: "Read one objective (any agent Operation of the Theater).", handler: json(itemRef, ({ itemId }) => { const found = store.find(itemId); if (!found) throw new ObjectiveStoreError("unknown_item"); return item(found); }) },
    // 목표를 만들면 지휘관 Operation 이 dormant 로 함께 태어난다 — 깨우는 것은 「구상」·「시작」이다.
    { name: "item/create", method: "POST", summary: "Create an objective together with its dormant Commander Operation.", handler: json(createItemSchema, async ({ language, theaterId, title, groupId, note, important, dueDate, today, steps, viewMode }) => item(await launch.create({ theaterId, title, groupId: groupId ?? null, note, important, dueDate, today, steps, viewMode }, { language }))) },
    { name: "item/patch", method: "POST", summary: "Edit an objective (its title and group are its Commander Operation's).", handler: json(itemRef.extend({ patch: patchItemSchema }), steerable(({ patch }) => only(patch, ["note"]), ({ itemId, patch }) => edited([...(patch.title !== undefined ? ["title" as const] : []), ...(patch.note !== undefined ? ["note" as const] : [])], () => {
      const { title, groupId, launch: preset, ...own } = patch;
      if (title !== undefined) launch.rename(itemId, title);
      if (groupId !== undefined) launch.regroup(itemId, groupId);
      if (preset) launch.setPreset(itemId, preset);
      if (Object.keys(own).length > 0) return store.patch(itemId, own);
      const current = store.find(itemId);
      if (!current) throw new ObjectiveStoreError("unknown_item");
      return current;
    }))) },
    // 순서는 내용이 아니다 — 지휘관이 일하는 동안에도 사람이 목록을 정리할 수 있게 busy 잠금을 지나지 않는다.
    { name: "item/move", method: "POST", summary: "Reorder an objective before or after another objective of the same Theater.", handler: json(itemRef.extend({ beforeId: ids.optional(), afterId: ids.optional() }).refine((body) => (body.beforeId === undefined) !== (body.afterId === undefined)), ({ itemId, beforeId, afterId }) => {
      const moved = store.move(itemId, beforeId !== undefined ? { beforeId } : { afterId: afterId! });
      // 보드의 저장은 이미 끝났다. 호스트 동기화 실패가 성공한 카드 이동을 실패로 보이게 해서는 안 된다.
      try { syncSidebarOrder(moved); } catch (error) { console.warn(`[objectives] sidebar reorder failed: ${error instanceof Error ? error.message : String(error)}`); }
      return item(moved);
    }) },
    // 목표를 지우면 지휘관 Operation 이 닫힌다(삭제 유예 동안 복원할 수 있고, 담당도 함께 닫힌다).
    { name: "item/remove", method: "POST", summary: "Delete an objective by closing its Commander Operation (restorable during the undo window).", handler: json(itemRef, unlessBusy(({ itemId }) => item(launch.remove(itemId)))) },
    // 후속 후보를 고른 완료는 새 경계다 — 검토 대기·스티어링 우선·제안 대기를 서버가 원자적으로 다시 따진다. 고른 것이 없으면 지금 완료 그대로.
    { name: "item/complete", method: "POST", summary: "Complete an objective and put its Operations to sleep, or reopen it with undone. With followups (and a batchId), the chosen follow-up candidates become dormant objectives.", handler: json(itemRef.extend({ undone: z.boolean().optional(), batchId: followupSelectionSchema.shape.batchId.optional(), followups: followupSelectionSchema.shape.followups.optional() }), unlessBusy(({ itemId, undone, batchId, followups, language }) => {
      if (undone) return item(store.reopen(itemId));
      if (!followups?.length) return item(launch.complete(itemId));
      if (!batchId) throw new ObjectiveStoreError("invalid_request");
      return item(launch.completeWithFollowups(itemId, { batchId, followups }, { language }));
    })) },
    // 후속 후보에 대한 사람의 판단 — 지휘관이 알아야 할 보드 편집이 아니므로 edited 를 쌓지 않는다(기준 제안의 거절과 같다).
    { name: "followup/discard", method: "POST", summary: "Discard an open follow-up candidate; its title and summary stay as a trace.", handler: json(itemRef.extend({ candidateId: ids }), ({ itemId, candidateId }) => item(store.followupDiscard(itemId, candidateId))) },
    { name: "followup/retry", method: "POST", summary: "Re-check or re-create a failed or unconfirmed follow-up with the same snapshot and key.", handler: json(itemRef.extend({ batchId: ids, candidateId: ids }), ({ itemId, batchId, candidateId }) => item(launch.retryFollowup(itemId, batchId, candidateId))) },
    { name: "followup/abandon", method: "POST", summary: "Give up a failed follow-up; the candidate returns to open.", handler: json(itemRef.extend({ batchId: ids, candidateId: ids }), ({ itemId, batchId, candidateId }) => item(store.followupAbandon(itemId, batchId, candidateId))) },
    { name: "member/add", method: "POST", summary: "Add a member to the roster.", handler: json(itemRef.extend({ member: memberAddSchema }), steerable(() => true, ({ itemId, member }) => edited(["members"], () => store.memberAdd(itemId, member, "human")))) },
    { name: "member/patch", method: "POST", summary: "Edit a member's role, brief, launch selection, or subagent opt-in.", handler: json(itemRef.extend({ memberId: ids, patch: memberPatchSchema }), steerable(() => true, ({ itemId, memberId, patch }) => edited(["members"], () => launch.memberPatched(itemId, memberId, patch)))) },
    { name: "member/remove", method: "POST", summary: "Remove a member and return its mission ids for undo.", handler: json(itemRef.extend({ memberId: ids }), steerable(() => true, ({ itemId, memberId }) => {
      const result = launch.memberRemoved(itemId, memberId);
      // 맡던 임무는 지휘관 직접으로 돌아간다 — 되돌리기는 없다(다시 더하고 배정한다).
      return item(store.setEdited(itemId, ["members", ...(result.stepIds.length ? ["assign" as const] : [])]));
    })) },
    { name: "step/add", method: "POST", summary: "Add a mission.", handler: json(itemRef.extend({ step: stepAddSchema }), steerable(() => true, ({ itemId, step }) => edited(["steps", ...(step.member !== undefined ? ["assign" as const] : [])], () => store.stepAdd(itemId, step, { unplaced: step.after === undefined, by: "human" })))) },
    { name: "step/patch", method: "POST", summary: "Edit a mission (text, done, dependencies, member).", handler: json(stepRef.extend({ patch: stepPatchSchema }), steerable(({ itemId, stepId, patch }) => only(patch, ["text", "member"]) && notStarted(itemId, stepId), ({ itemId, stepId, patch }) => edited(stepKinds(patch), () => store.stepPatch(itemId, stepId, patch, { by: "human" })))) },
    // 읽음은 편집이 아니다 — 지휘관이 일하는 동안에도 받고, 지휘관에게 알릴 것도 없다.
    { name: "step/seen", method: "POST", summary: "Mark every record of a mission as read by the person.", handler: json(stepRef, ({ itemId, stepId }) => item(store.stepSeen(itemId, stepId))) },
    { name: "step/remove", method: "POST", summary: "Remove a mission.", handler: json(stepRef, steerable(({ itemId, stepId }) => notStarted(itemId, stepId), ({ itemId, stepId }) => edited(["steps"], () => store.stepRemove(itemId, stepId)))) },
    { name: "edge/toggle", method: "POST", summary: "Link or unlink two missions in the lineup.", handler: json(itemRef.extend({ from: ids, to: ids }), steerable(({ itemId, to }) => notStarted(itemId, to), ({ itemId, from, to }) => { const result = store.edgeToggle(itemId, from, to); return { item: store.setEdited(itemId, ["recipe"]), linked: result.linked }; })) },
    { name: "edge/linear", method: "POST", summary: "Chain all missions in order.", handler: json(itemRef, unlessBusy(({ itemId }) => edited(["recipe"], () => store.edgesLinear(itemId)))) },
    { name: "edge/clear", method: "POST", summary: "Remove all mission dependencies.", handler: json(itemRef, unlessBusy(({ itemId }) => edited(["recipe"], () => store.edgesClear(itemId)))) },
    { name: "plan/request", method: "POST", summary: "Ask the Commander to plan the objective (starts one when missing): it lays out missions, prerequisites and delegation; nothing runs until Commence. Optional context travels with the request and is kept on the item.", handler: json(itemRef.extend({ context }), unlessBusy(({ itemId, language, context }) => { if (context !== undefined) store.patch(itemId, { cook: context }); return launch.requestPlan(itemId, { language }); })) },
    { name: "coordinator/stop", method: "POST", summary: "Interrupt the Commander and every member Operation of an objective (roster stays).", handler: json(itemRef, ({ itemId }) => launch.stop(itemId)) },
    { name: "coordinator/start", method: "POST", summary: "Commence: launch or resume every member before sending the Commander's first turn. Optional context from the person is quoted under it once.", handler: json(itemRef.extend({ context }), (body) => {
      if (store.find(body.itemId)?.criteriaProposals.length) throw new ObjectiveStoreError("criteria_pending");
      if (launch.busy(body.itemId)) throw new ObjectiveStoreError("item_busy");
      return launch.startCoordinator(body.itemId, { language: body.language, context: body.context });
    }) },
    { name: "coordinator/steer", method: "POST", summary: "Tell the Commander (working or awaiting review) the person changed the board (one line, with the person's optional context quoted), clear the pending changes and the criteria it had judged met.", handler: json(itemRef.extend({ context }), ({ itemId, language, context: note }) => launch.steer(itemId, { language, context: note }).then(item)) },
    { name: "group/create", method: "POST", summary: "Create an Operation group (the Objectives list).", handler: json(z.object({ theaterId: ids, language, name: groupName, color: groupColor }), ({ theaterId, name, color }) => { const groups = ctx.host.operations.groups; if (!groups) throw new Error("groups_unavailable"); return { group: groups.create({ theaterId, name, color }) }; }) },
    // 목표 표면의 그룹 메뉴 — 이름과 색만 바꾼다(사람의 사이드바 PATCH 와 같은 길: 영속 + group:changed). 해제·삭제는 사이드바의 몫이다.
    { name: "group/patch", method: "POST", summary: "Rename or recolor an Operation group (the Objectives list).", handler: json(z.object({ groupId: ids, language, name: groupName.optional(), color: groupColor.optional() }).refine((body) => body.name !== undefined || body.color !== undefined), ({ groupId, name, color }) => {
      const groups = ctx.host.operations.groups;
      if (!groups) throw new Error("groups_unavailable");
      const group = groups.patch(groupId, { ...(name !== undefined ? { name } : {}), ...(color !== undefined ? { color } : {}) });
      if (!group) throw new ObjectiveStoreError("unknown_group");
      return { group };
    }) },
    { name: "palette-search", method: "POST", summary: "Search objectives by title for the command palette.", handler: json(z.object({ theaterId: ids, language, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }), ({ theaterId, query, limit }) => {
      const needle = query.toLowerCase();
      const hits = store.list(theaterId).filter((candidate) => !candidate.done && candidate.title.toLowerCase().includes(needle)).slice(0, limit ?? 20);
      return { items: hits.map((candidate) => ({ id: candidate.id, title: candidate.title, groupId: candidate.groupId })) };
    }) },
    // 달성 기준 — 브리핑처럼 지휘관이 일하는 동안에도 받고, 지휘관이 있으면 「달성 기준」 편집으로 쌓여 스티어링이 알린다.
    { name: "criterion/add", method: "POST", summary: "Add a success criterion below the missions.", handler: json(itemRef.extend({ criterion: criterionAddSchema }), steerable(() => true, ({ itemId, criterion }) => edited(["criteria"], () => store.criterionAdd(itemId, criterion.text, "human")))) },
    { name: "criterion/patch", method: "POST", summary: "Edit a success criterion.", handler: json(itemRef.extend({ criterionId: ids, patch: criterionPatchSchema }), steerable(() => true, ({ itemId, criterionId, patch }) => edited(["criteria"], () => store.criterionPatch(itemId, criterionId, patch.text)))) },
    { name: "criterion/remove", method: "POST", summary: "Remove a success criterion.", handler: json(itemRef.extend({ criterionId: ids }), steerable(() => true, ({ itemId, criterionId }) => edited(["criteria"], () => store.criterionRemove(itemId, criterionId)))) },
    // 제안에 대한 사람의 판단·어노테이션은 지휘관 자신의 제안에 대한 답이라 edited 종류를 쌓지 않는다.
    { name: "criterion/approve", method: "POST", summary: "Approve one proposed success criterion change.", handler: json(itemRef.extend({ proposalId: ids }), ({ itemId, proposalId }) => item(store.proposalApprove(itemId, proposalId))) },
    { name: "criterion/approve-all", method: "POST", summary: "Approve all proposed success criterion changes.", handler: json(itemRef, ({ itemId }) => item(store.proposalsApproveAll(itemId))) },
    { name: "criterion/reject", method: "POST", summary: "Reject one proposed success criterion change.", handler: json(itemRef.extend({ proposalId: ids }), ({ itemId, proposalId }) => item(store.proposalReject(itemId, proposalId))) },
    { name: "criterion/annotate", method: "POST", summary: "Annotate a proposed success criterion change (empty text removes the annotation).", handler: json(itemRef.extend({ proposalId: ids, annotation: z.string().max(300) }), ({ itemId, proposalId, annotation }) => item(store.proposalAnnotate(itemId, proposalId, annotation))) },
    { name: "attachment/add", method: "POST", summary: "Attach an image to an objective's brief (raw PNG/JPEG/WebP/GIF body, up to 10 MB, 20 per objective).", handler: attachmentAdd },
    { name: "attachment/file", method: "GET", summary: "Read an attached image by id.", handler: attachmentFile },
    { name: "attachment/remove", method: "POST", summary: "Remove an image from an objective's brief.", handler: json(itemRef.extend({ attachmentId: ids }), steerable(() => true, ({ itemId, attachmentId }) => edited(["note"], () => store.attachmentRemove(itemId, attachmentId)))) },
    { name: "plan/apply", method: "POST", summary: "Replace the unassigned missions with a plan (Commander tool path; also used by tests).", handler: json(itemRef.extend({ plan: planSchema.omit({ criteria: true }) }), ({ itemId, plan }) => item(launch.planApplied(itemId, plan))) },
  ];
}
