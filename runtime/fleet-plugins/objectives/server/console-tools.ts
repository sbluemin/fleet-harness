import { type ConsoleCaller, type ConsoleUseCallTarget, type PluginMcpTool } from "@fleet-console/sdk/mcp";
import { defineConsoleTool, type ConsoleToolFilter } from "@fleet-console/sdk/mcp/actions";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { inboxReasons } from "./board-state.js";
import { createModelCatalog } from "./catalog.js";
import { createObjectiveActions } from "./actions.js";
import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { COMMODORE_TIDY_PREFIX, MAX_REMOVAL_REASON, MAX_TITLE, MAX_DECISION_QUESTIONS, decisionAnswersSchema, followupSelectionSchema, type Objective, type ObjectiveReviewer } from "./types.js";
import { createBoardViews, refuse, roleIn, storedText, text } from "./views.js";
import { consoleObjectivePage, createConsoleBoardViews, OBJECTIVE_READ_SECTIONS } from "./console-views.js";

/**
 * 바깥 루프의 보드 — 화면 둘. `console_objectives` 는 목표 목록 화면(그룹·목록·확인 필요·진행 중·이력·모델, 추가·정리)이고
 * `console_objectives_detail` 은 목표 하나의 화면(읽기·증거, 사람의 행위)이다. Console Use 와 Theater 에 묶인 사령관 세션이
 * 같은 정의·같은 action 을 쓴다 — 호출자는 행위의 귀속과 사령관의 Theater 경계만 가른다.
 *
 * 목표는 제목과 브리핑으로만 태어난다 — 임무·달성 기준·구성원(모델 포함)은 지휘관의 구상에서 나오고, 기준은 지휘관의 제안을
 * 승인·거절해 바뀐다. 두 화면이 쓰는 것은 목표의 행위(구상·개시·스티어링·메시지·중단·결정 응답·기준 제안 판단·검토로 인계·완료·확장)와
 * 제목·브리핑 편집뿐이다. 지휘관에게 건네는 말은 짧은 첨언으로 상한을 둔다.
 */

const ids = z.string().min(1).max(128);
const MAX_ADD_PER_TURN = 10;
/** 일하는 세션이 있어도 전사를 읽을 수 있는 대기 사유 — 바깥의 판단을 기다리거나 막힌 목표다. */
const TRANSCRIPT_REASONS: ReadonlySet<string> = new Set(["decision", "stalled", "member-failed", "review"]);
/** 세션 전사 한 번에 읽는 줄 수의 기본값 — 꼬리 읽기의 크기이기도 하다. */
const TRANSCRIPT_DEFAULT_LIMIT = 30;
/** 정리(지우기·합치기·되돌리기) 한 번에 받는 목표 수, 그리고 호출자마다 10분에 받는 정리 호출 수. */
const MAX_TIDY_IDS = 20;
const MAX_TIDY_PER_TURN = 20;
const reason = z.string().trim().min(1).max(MAX_REMOVAL_REASON).optional();
/** 지휘관에게 건네는 말(구상·개시·스티어링·확장의 context, 메시지)의 상한 — 첨언이 업무 지시서로 자라지 않게 한다. */
export const MAX_REMARK = 600;
const REMARK = "A remark: what you judged and why. The Commander decides missions, method and evidence.";
const remark = z.string().trim().min(1).max(MAX_REMARK).describe(REMARK);
const context = z.string().max(MAX_REMARK).optional().describe(REMARK);
const answers = z.array(decisionAnswersSchema.shape.answers.element).min(1).max(MAX_DECISION_QUESTIONS);
/** 조각 읽기의 위치 — 목표 구역(UTF-16 문자, 8000바이트 예산)과 증거(16000자) 모두 nextOffset 을 따라간다. */
const sliceOffset = z.number().int().min(0).optional().describe("Slice offset: follow nextOffset until null; restart at 0 if revision changes.");
/** 거절의 뜻은 거절 응답에 싣는다 — 도구 설명에 미리 싣지 않는다. */
const HINTS: Readonly<Record<string, string>> = {
  own_objective: "An Operation cannot act on an objective it commands or belongs to.",
  objective_working: "A session is working and the objective waits on nothing; judge it by its results on the board.",
  budget_exceeded: "Too many calls in 10 minutes; wait before calling again.",
  routing_preview_stale: "Judge with routing first; commence launches routed members with the models it showed.",
  followup_changed: "That candidate was revised since you read it; read the board again and name it with its current rev.",
};

const scope = { theaterId: ids.optional() };
const rows = { ...scope, groupId: ids.optional(), offset: z.number().int().min(0).optional().describe("Follow nextOffset with the same action and filter until null; an 8000-byte budget can return fewer rows than limit."), limit: z.number().int().min(1).max(100).optional() };
const tidyIds = z.array(ids).min(1).max(MAX_TIDY_IDS).describe("Unlaunched, incomplete objectives; removed ones stay restorable for 14 days.");
const listTool = defineConsoleTool({
  name: "console_objectives",
  description: "A Theater's Objectives list: groups, objectives, what waits on the person (inbox), running ones (fleet), history, member models; add and tidy objectives.",
  actions: {
    groups: { kind: "read", input: z.object(scope) },
    list: { kind: "read", input: z.object({ ...rows, filter: z.enum(["today", "due", "all", "agent"]).optional().describe("all adds completed and removed objectives.") }) },
    inbox: { kind: "read", input: z.object(rows) },
    fleet: { kind: "read", input: z.object(rows) },
    history: { kind: "read", input: z.object(rows) },
    models: { kind: "read", input: z.object(scope) },
    add: { kind: "write", input: z.object({ ...scope, title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional().describe("The brief: the person's request and its purpose. Missions, method and evidence come from the Commander's plan.") }) },
    remove: { kind: "write", input: z.object({ objectiveIds: tidyIds, reason }) },
    merge: { kind: "write", input: z.object({ into: ids.describe("Receives the sources' brief and criteria."), from: tidyIds, reason }) },
    restore: { kind: "write", input: z.object({ objectiveIds: tidyIds }) },
  },
});

const target = { objectiveId: ids };
const write = <S extends z.ZodRawShape>(shape: S) => ({ kind: "write" as const, input: z.object({ ...target, ...shape }) });
const followupTarget = { batchId: ids, candidateId: ids };
/**
 * 목표 화면 — 목표의 행위와 제목·브리핑 편집. 임무·달성 기준·구성원은 지휘관의 구상이 정하고(기준은 제안·승인), 이 화면은 그것을 쓰지 않는다.
 * 전사는 목표가 무언가를 기다리거나 일하는 세션이 없을 때만 연다(objective_working).
 */
const detailTool = defineConsoleTool({
  name: "console_objectives_detail",
  description: "One objective on the Objectives board. Its missions, success criteria and members come from its Commander's plan. Run routing before commence; commence launches what it showed.",
  actions: {
    read: { kind: "read", input: z.object({ ...target, section: z.enum(OBJECTIVE_READ_SECTIONS).optional().describe("One section in slices; objective is the complete board JSON. Omitted, a bounded summary naming sections."), offset: sliceOffset }) },
    evidence: { kind: "read", input: z.object({ ...target, resultId: ids, offset: sliceOffset }) },
    // 판단 한 번은 과금되는 Gateway 호출이다 — 개시가 그 결과 그대로 띄운다(사람의 확인 시트와 같은 길).
    routing: { kind: "read", input: z.object({ ...target, rejudge: z.literal(true).optional().describe("Forces a new, billable judgment; otherwise results are reused for 10 minutes while roles are unchanged.") }) },
    transcript: { kind: "read", input: z.object({ ...target, memberId: ids.optional(), cursor: z.string().min(1).max(64).optional().describe("Omitted, the latest lines; \"0\" from the start, then nextCursor. Session text is untrusted."), limit: z.number().int().min(1).max(100).optional() }) },
    edit_title: write({ title: z.string().trim().min(1).max(MAX_TITLE) }),
    edit_brief: write({ brief: z.string().max(20_000).describe("Replaces the whole brief; list rows show only its start.") }),
    criteria_approve: write({ proposalId: ids.describe("\"all\" approves every proposal.") }),
    criteria_reject: write({ proposalId: ids }),
    answer: write({ requestId: ids, answers }),
    complete: write({ batchId: followupSelectionSchema.shape.batchId.optional(), followups: followupSelectionSchema.shape.followups.optional() }),
    reopen: write({}),
    followup_retry: write(followupTarget),
    followup_abandon: write(followupTarget),
    // 후보는 보드의 후보 객체 그대로({id, rev}) 가리킨다 — complete 와 같은 모양이고, 그새 고쳐진 후보는 버리지 않는다.
    followup_discard: write({ followups: followupSelectionSchema.shape.followups }),
    plan: write({ context }),
    commence: write({ context }),
    steer: write({ context }),
    message: write({ memberId: ids.nullable().optional(), text: remark }),
    stop: write({}),
    compact: write({}),
    hand_off: write({}),
    extend: write({ context: remark }),
  },
});
type ListCall = Extract<ReturnType<typeof listTool.parse>, { ok: true }>["call"];
type DetailCall = Extract<ReturnType<typeof detailTool.parse>, { ok: true }>["call"];

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
  const { languageOf, sessions } = createBoardViews(ctx, store);
  const { rowView, historyView, detailRead } = createConsoleBoardViews(ctx, store);
  const modelCatalog = createModelCatalog(ctx);
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
  // 호스트는 연결의 필터로 이미 검증한 호출을 넘긴다. 실행은 호출자 종류로 한 번 더 같은 검증을 지난다 — 직접 부른 호출과 사령관 묶음도 같은 길이다.
  const filterOf = (caller: BoardCaller | undefined): ConsoleToolFilter | undefined => caller ? { caller: caller.kind } : undefined;
  const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
  // 사이드바 자리 — 목표 하나면 그 목표 줄, 줄 하나로 좁혀지지 않는 목록·생성·지움은 그 Theater(groupId 가 있으면 그 그룹)의 묶음 머리.
  // 레일 아이콘은 호스트가 따로 감싼다. 인자로 Theater 를 모르면 비워 두고, 호스트가 호출자 Operation 의 Theater 로 채운다.
  const rowAt = (id: string | undefined, rowTheaterId: string): { readonly target?: ConsoleUseCallTarget } => (id ? { target: { kind: "cluster", clusterId: id, theaterId: rowTheaterId } } : {});
  const listAt = (listTheaterId: string, groupId: unknown): { readonly target?: ConsoleUseCallTarget } => ({ target: { kind: "clusters", theaterId: listTheaterId, ...(typeof groupId === "string" ? { groupId } : {}) } });
  const titleOf = (id: string) => short(store.find(id)?.title ?? "");
  const stringIds = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const refusal = (parsed: { readonly error: string; readonly issues?: readonly unknown[] }) => refuse(parsed.error, parsed.issues ? { issues: parsed.issues } : {});

  const list: PluginMcpTool = listTool.plugin({
    surface: {
      panelId: "objectives",
      describe: (args) => {
        const action = typeof args.action === "string" ? args.action : null;
        if (!action || !(action in listTool.actions)) return null;
        const argTheater = typeof args.theaterId === "string" ? args.theaterId : undefined;
        const theaterId = bound?.theaterId ?? argTheater ?? "";
        const theaterOf = (id: string | undefined) => bound?.theaterId ?? argTheater ?? (id ? store.find(id)?.theaterId : undefined) ?? "";
        if (action === "add") return { theaterId, summary: `목표 추가 「${short(typeof args.title === "string" ? args.title : "")}」`, view: "objectives", gesture: "create", ...listAt(theaterId, args.groupId) };
        if (action === "remove") { const removeIds = stringIds(args.objectiveIds); const removeTheaterId = theaterOf(removeIds[0]); return { theaterId: removeTheaterId, summary: removeIds.length === 1 ? `목표 지움 「${titleOf(removeIds[0]!)}」` : `목표 ${removeIds.length}개 지움`, view: "objectives", gesture: "press", ...listAt(removeTheaterId, undefined) }; }
        if (action === "merge") { const into = typeof args.into === "string" ? args.into : ""; const mergeTheaterId = theaterOf(into); return { theaterId: mergeTheaterId, summary: `목표 ${stringIds(args.from).length}개를 「${titleOf(into)}」에 합침`, view: "objective", path: into, gesture: "press", ...rowAt(into || undefined, mergeTheaterId) }; }
        if (action === "restore") { const restoreIds = stringIds(args.objectiveIds); const restoreTheaterId = theaterOf(restoreIds[0]); return { theaterId: restoreTheaterId, summary: restoreIds.length === 1 ? `목표 되돌림 「${titleOf(restoreIds[0]!)}」` : `목표 ${restoreIds.length}개 되돌림`, view: "objectives", gesture: "press", ...(restoreIds.length === 1 ? rowAt(restoreIds[0], restoreTheaterId) : listAt(restoreTheaterId, undefined)) }; }
        // 읽기 — 목표 목록류(목록·그룹·확인 필요·진행 중·이력)면 묶음 머리. 모델 목록은 목표와 무관해 레일에만 선다.
        return { theaterId, summary: action === "models" ? "모델 목록 봄" : action === "groups" ? "그룹 봄" : "목표 목록 봄", view: "objectives", ...(action === "models" ? {} : listAt(theaterId, args.groupId)) };
      },
    },
    execute: async (raw, context) => {
      const caller: BoardCaller | undefined = bound ?? context.caller;
      const parsed = listTool.parse(raw, filterOf(caller));
      if (!parsed.ok) return refusal(parsed);
      const call = parsed.call as ListCall;
      try {
        if (call.action === "remove" || call.action === "merge" || call.action === "restore") {
          // 정리는 에이전트 Operation 이나 사령관이 한다 — 누가 지웠는지가 사람의 보드에 남아야 한다. 사령관은 자기 Theater 목표만 정리한다.
          if (caller?.kind !== "operation" && caller?.kind !== "commodore") return refuse("operation_caller_required");
          if (bound) for (const id of call.action === "merge" ? [call.into, ...call.from] : call.objectiveIds) scoped(id);
          if (!spend(tidyBudget, callerKey(caller), MAX_TIDY_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_TIDY_PER_TURN, hint: HINTS.budget_exceeded });
          const actor = (why?: string) => ({ ...(caller.kind === "commodore" ? { operationId: `${COMMODORE_TIDY_PREFIX}${caller.theaterId}`, title: null } : { operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null }), ...(why ? { reason: why } : {}) });
          // 후속으로 태어난 목표면 원본의 배치 표시(생성됨·삭제됨)가 이 목표의 지운 표시에서 나온다 — 바뀐 목표마다 원본을 다시 방송한다.
          const touched = (changed: readonly string[]) => { for (const id of changed) launch.followupTargetChanged(id); };
          if (call.action === "remove") { const removed = store.tidyRemove(call.objectiveIds, actor(call.reason)).map((objective) => objective.id); touched(removed); return text({ ok: true, removed }); }
          if (call.action === "merge") { const target = store.tidyMerge(call.into, call.from, actor(call.reason)); touched(call.from); return text({ ok: true, objectiveId: target.id, merged: call.from, criteria: target.criteria.length }); }
          // 되돌리기도 지우기·합치기처럼 전부 받을 수 있을 때만 바꾼다 — 일부만 되돌린 채 오류로 끝나지 않게.
          const restoreIds = [...new Set(call.objectiveIds)];
          const refusals = restoreIds.flatMap((id) => { const found = store.find(id); return !found ? [{ objectiveId: id, reason: "unknown_objective" }] : !found.removed ? [{ objectiveId: id, reason: "not_removed" }] : []; });
          if (refusals.length) return refuse("tidy_refused", { refusals });
          const restored = restoreIds.map((id) => store.tidyRestore(id).id);
          touched(restored);
          return text({ ok: true, restored });
        }
        const asked = "theaterId" in call ? call.theaterId : undefined;
        // 사령관은 자기 Theater 에 묶여 있다 — 다른 Theater 를 가리키면 거절한다.
        if (bound && asked !== undefined && asked !== bound.theaterId) return refuse("other_theater");
        const theaterId = bound?.theaterId ?? asked ?? theaterOfCaller(caller);
        if (call.action === "models") return text(await models(theaterId, context.signal));
        if (call.action !== "add") {
          if (!theaterId) return refuse("theater_required");
          return text(read(call, theaterId, caller));
        }
        if (!theaterId) return refuse("theater_required");
        if (caller?.kind === "operation" && !spend(addBudget, callerKey(caller), MAX_ADD_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN, hint: HINTS.budget_exceeded });
        // 그룹은 입력으로 받지 않는다 — 호출 Operation 의 그룹을 그대로 따른다.
        const groupId = caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null;
        // 목표는 제목과 브리핑으로만 태어난다 — 달성 기준·임무·구성원은 지휘관의 구상이 제안한다. AI 생성 표시는 목표의 addedBy 로 남는다.
        const objective = await launch.create({
          theaterId, groupId, title: call.title, ...(call.note ? { note: call.note } : {}),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : caller?.kind === "commodore" ? { addedBy: caller } : {}),
        }, { language: language(caller), ...(actorOf(caller) ? { actor: actorOf(caller)! } : {}) });
        const kept = store.find(objective.id) ?? objective;
        return text({ ok: true, objectiveId: objective.id, stored: { title: kept.title, ...(kept.note ? { note: storedText(kept.note) } : {}) } });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, { ...(HINTS[error.code] ? { hint: HINTS[error.code] } : {}), ...error.details });
        return refuse("objectives_failed");
      }
    },
  }, bound ? { caller: "commodore" } : undefined);

  const detail: PluginMcpTool = detailTool.plugin({
    surface: {
      panelId: "objectives",
      describe: (args) => {
        const action = typeof args.action === "string" ? args.action : null;
        if (!action || !(action in detailTool.actions)) return null;
        const found = typeof args.objectiveId === "string" ? store.find(args.objectiveId) : null;
        const theaterId = bound?.theaterId ?? found?.theaterId ?? "";
        const at = { view: "objective", ...(found ? { path: found.id } : {}), ...rowAt(found?.id, theaterId) };
        const title = short(found?.title ?? "");
        if (detailTool.actions[action]?.kind === "write") return { theaterId, summary: `목표 ${action} 「${title}」`, gesture: "press", ...at };
        return { theaterId, summary: action === "transcript" ? `세션 기록 봄 「${title}」` : action === "evidence" ? `증거 봄 「${title}」` : `목표 봄 「${title}」`, ...at };
      },
    },
    execute: async (raw, context) => {
      const caller: BoardCaller | undefined = bound ?? context.caller;
      const parsed = detailTool.parse(raw, filterOf(caller));
      if (!parsed.ok) return refusal(parsed);
      const call = parsed.call as DetailCall;
      try {
        const current = scoped(call.objectiveId);
        if (call.action === "read") return text(detailRead(current, call.section, call.offset));
        if (call.action === "evidence") {
          const { data, metadata } = await store.evidenceRead(current.id, call.resultId);
          // 비동기 파일 읽기 뒤에도 같은 Theater에 속한 결과인지 확인한다.
          scoped(current.id);
          const details = { objectiveId: current.id, resultId: call.resultId, name: metadata.name, mediaType: metadata.mediaType, bytes: metadata.bytes, sha256: metadata.sha256 };
          if (metadata.mediaType === "text/plain") {
            const content = data.toString("utf8"), offset = call.offset ?? 0;
            const slice = content.slice(offset, offset + 16_000);
            return text({ ...details, text: slice, offset, totalCharacters: content.length, nextOffset: offset + slice.length < content.length ? offset + slice.length : null });
          }
          return { ...text(details), content: [...text(details).content, { type: "image", data: data.toString("base64"), mimeType: metadata.mediaType }] };
        }
        if (call.action === "transcript") return text(await transcript(current, call, context.signal));
        if (call.action === "routing") {
          if (launch.busy(current.id)) return refuse("objective_busy");
          return text(await routingView(current, call.rejudge === true));
        }
        const actor = actorOf(caller);
        if (!actor) return refuse("operation_caller_required");
        if (caller?.kind === "operation" && roleIn(current, caller)) return refuse("own_objective", { hint: HINTS.own_objective });
        const actions = createObjectiveActions(ctx, store, launch, actor);
        const ref = { objectiveId: current.id, language: language(caller) };
        if (call.action === "complete" && (call.batchId === undefined) !== (call.followups === undefined)) return refuse("invalid_arguments", { issues: [{ path: [call.batchId === undefined ? "batchId" : "followups"], code: "invalid_type" }] });
        const result = await (async () => {
          switch (call.action) {
            case "plan": return actions.plan({ ...ref, ...(call.context !== undefined ? { context: call.context } : {}) });
            // 개시는 마지막 routing 결과 그대로 띄운다 — 판단하지 않은 채, 또는 그새 낡은 결과로는 띄우지 않는다(routing_preview_stale).
            case "commence": return actions.commence({ ...ref, ...(call.context !== undefined ? { context: call.context } : {}), routing: "preview" });
            case "criteria_approve": return call.proposalId === "all" ? actions.approveAll(ref) : actions.approve({ ...ref, proposalId: call.proposalId });
            case "criteria_reject": return actions.reject({ ...ref, proposalId: call.proposalId });
            case "answer": return actions.answer({ ...ref, requestId: call.requestId, answers: call.answers });
            case "complete": return actions.complete({ ...ref, ...(call.batchId !== undefined && call.followups ? { batchId: call.batchId, followups: call.followups } : {}) });
            case "reopen": return actions.complete({ ...ref, undone: true });
            case "steer": return actions.steer({ ...ref, ...(call.context !== undefined ? { context: call.context } : {}) });
            case "message": return actions.message({ ...ref, text: call.text, ...(call.memberId !== undefined ? { memberId: call.memberId } : {}) });
            case "stop": return actions.stop(ref);
            case "hand_off": return actions.handOff(ref);
            case "compact": return actions.compact(ref);
            case "extend": return actions.extend({ ...ref, context: call.context });
            case "followup_retry": return actions.followupRetry({ ...ref, batchId: call.batchId, candidateId: call.candidateId });
            case "followup_abandon": return actions.followupAbandon({ ...ref, batchId: call.batchId, candidateId: call.candidateId });
            case "followup_discard": {
              // 전부 버릴 수 있을 때만 버린다 — 일부만 버린 채 오류로 끝나지 않게, 저장소의 거절 사유를 먼저 본다.
              for (const { id: candidateId, rev } of call.followups) {
                const candidate = current.followups.find((entry) => entry.id === candidateId);
                if (!candidate) throw new ObjectiveStoreError("unknown_followup");
                if (candidate.state === "selected") throw new ObjectiveStoreError("followup_locked");
                if (candidate.state === "open" && candidate.rev !== rev) throw new ObjectiveStoreError("followup_changed");
              }
              let discarded = { objective: current };
              for (const { id: candidateId } of call.followups) discarded = actions.followupDiscard({ ...ref, candidateId });
              return discarded;
            }
            case "edit_title": return actions.patch({ ...ref, patch: { title: call.title } });
            case "edit_brief": return actions.patch({ ...ref, patch: { note: call.brief } });
          }
        })();
        const { objective: updated, ...details } = result;
        const kept = store.find(updated.id);
        const stored = !kept ? undefined
          : call.action === "edit_title" ? { title: kept.title }
          : call.action === "edit_brief" ? { brief: storedText(kept.note) }
          : undefined;
        const answered = call.action === "answer" ? store.storedAnswers(current.id, call.requestId) : null;
        const echo = answered ? { answers: answered.map(({ questionId, selectedOptionIds, text: answer }) => ({ questionId, ...(selectedOptionIds.length ? { selectedOptionIds } : {}), ...(answer ? { text: storedText(answer) } : {}) })) } : stored;
        return text({ ok: true, objectiveId: updated.id, ...details, ...(echo ? { stored: echo } : {}) });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, { ...(HINTS[error.code] ? { hint: HINTS[error.code] } : {}), ...error.details });
        return refuse("objectives_failed");
      }
    },
  }, bound ? { caller: "commodore" } : undefined);


  async function models(theaterId: string | null, signal: AbortSignal | undefined) {
    const [catalog, quota] = await Promise.all([modelCatalog.load(signal), modelCatalog.quota(signal)]);
    if (!catalog) throw new ObjectiveStoreError("catalog_unavailable");
    // 바꾸지 못한 전환(곧바로든 턴 뒤든) — 그 모델로 다시 고르기 전에 볼 사유다. cause 는 자식이 거절하며 던진 원문이다.
    const failedSwitches = theaterId ? store.list(theaterId).filter((objective) => !objective.done && !objective.removed).flatMap((objective) => objective.members.flatMap((member) => member.next?.failed
      ? [{ objectiveId: objective.id, memberId: member.id, role: member.role, model: member.next.model, ...(member.next.effort ? { effort: member.next.effort } : {}), failed: member.next.failed, ...(member.next.cause ? { cause: member.next.cause } : {}) }]
      : [])) : [];
    return { models: catalog, quota, failedSwitches };
  }

  /**
   * 개시 전 라우팅 — 라우팅으로 새로 띄울 구성원마다 AI Gateway 판단(모델·강도·근거, 폴백이면 지휘관 프리셋)과 그 결과가 개시에 쓰이는 기한.
   * 사람의 확인 시트와 같은 판단(routingPreview)이고, 개시는 이 결과 그대로 띄운다. 새로 띄울 라우팅 구성원이 없으면 판단하지 않는다.
   */
  async function routingView(objective: Objective, rejudge: boolean) {
    const preview = await launch.routingPreview(objective.id, rejudge ? { rejudge: true } : undefined);
    const roles = new Map(scoped(objective.id).members.map((member) => [member.id, member.role]));
    return { objectiveId: objective.id, judged: preview.judged, at: preview.at, expiresAt: preview.expiresAt, members: preview.members.map((member) => ({ role: roles.get(member.id) ?? null, ...member })) };
  }

  /**
   * 목표 세션의 전사 — 지휘관 또는 구성원. Theater 경계는 호출 전에 scoped 가 지켰고, 소유(이 플러그인이 띄운 세션)는 호스트가 지킨다.
   * 진행 중인 일은 보드의 결과로 판단한다 — 전사는 목표가 판단을 기다릴 때(결정·정체·구성원 턴 실패·검토 대기)나
   * 일하는 세션이 없을 때(재시작 뒤 휴면 포함)만 연다. 일하는 중의 생각을 읽고 끼어드는 길을 닫는다.
   */
  async function transcript(objective: Objective, args: { readonly memberId?: string | undefined; readonly cursor?: string | undefined; readonly limit?: number | undefined }, signal: AbortSignal | undefined) {
    const member = args.memberId ? objective.members.find((candidate) => candidate.id === args.memberId) : null;
    if (args.memberId && !member) throw new ObjectiveStoreError("unknown_member");
    const waiting = inboxReasons(objective, { now: Date.now(), observe: (id) => ctx.host.consoleControl?.observe(id) }).some((reason) => TRANSCRIPT_REASONS.has(reason));
    const state = sessions(objective);
    const working = [state.commander, ...state.members].some((session) => session.state === "running" || session.state === "background");
    if (working && !waiting) throw new ObjectiveStoreError("objective_working");
    if (!member && store.pending(objective.id)) throw new ObjectiveStoreError("not_started");
    const read = ctx.host.consoleControl?.transcript;
    if (!read) throw new ObjectiveStoreError("capability_unavailable");
    const operationId = member ? member.id : objective.id;
    const page = await read(operationId, { limit: args.limit ?? TRANSCRIPT_DEFAULT_LIMIT, ...(args.cursor ? { cursor: args.cursor } : { tail: true }) }, signal);
    if ("error" in page) throw new ObjectiveStoreError(page.error === "unknown_operation" ? "session_unavailable" : page.error);
    const session = member ? { kind: "member", memberId: member.id, role: member.role } : { kind: "commander" };
    return { objectiveId: objective.id, session, source: page.source, latest: !args.cursor, entries: page.entries, nextCursor: page.nextCursor, truncated: page.truncated };
  }

  function read(args: Extract<ListCall, { action: "groups" | "list" | "inbox" | "fleet" | "history" }>, theaterId: string, caller: BoardCaller | undefined) {
    if (args.action === "groups") { const objectives = store.list(theaterId); return { theaterId, groups: (ctx.host.operations.groups?.list(theaterId) ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color, open: objectives.filter((objective) => !objective.done && !objective.removed && objective.groupId === group.id).length })) }; }
    const page = (rows: readonly ReturnType<typeof rowView>[], today?: string) => consoleObjectivePage(rows, { theaterId, offset: args.offset, limit: args.limit, today });
    const board = store.list(theaterId).filter((objective) => !objective.removed && (!args.groupId || objective.groupId === args.groupId));
    if (args.action === "inbox") {
      const now = Date.now();
      return page(board.flatMap((objective) => {
        const reasons = inboxReasons(objective, { now, observe: (id) => ctx.host.consoleControl?.observe(id) });
        return reasons.length ? [{ ...rowView(objective), reasons, boardUpdatedAt: objective.boardUpdatedAt, sessions: sessions(objective),
          criteriaProposals: objective.criteriaProposals, decisionRequest: objective.decisionRequest, decisionDelivery: objective.decisionDelivery,
          handoff: objective.handoff, followups: objective.followups.filter((candidate) => candidate.state === "open"),
          followupBatches: objective.followupBatches.filter((batch) => batch.items.some((item) => item.state === "failed" || item.state === "confirming")),
        }] : [];
      }));
    }
    if (args.action === "fleet") return page(board.filter((objective) => !objective.done).flatMap((objective) => {
      const state = sessions(objective);
      const active = [state.commander, ...state.members].some((session) => ["running", "background", "awaiting"].includes(session.state));
      return objective.commenced || active ? [{ ...rowView(objective), planning: objective.planning, boardUpdatedAt: objective.boardUpdatedAt, sessions: state }] : [];
    }));
    if (args.action === "history") return page(board.filter((objective) => objective.done || objective.handoff || objective.extensions.length || (objective.actionCounts?.["hand-off"] ?? 0) > 0)
      .sort((a, b) => (b.boardUpdatedAt ?? b.createdAt) - (a.boardUpdatedAt ?? a.createdAt)).map(historyView));
    const today = new Date().toISOString().slice(0, 10);
    const objectives = store.list(theaterId).filter((objective) => {
      if (args.groupId && objective.groupId !== args.groupId) return false;
      const filter = args.action === "list" ? args.filter : undefined;
      if (filter !== "all" && objective.removed) return false;
      if (filter === "today") return objective.today && !objective.done;
      if (filter === "due") return !!objective.dueDate && !objective.done;
      if (filter === "agent") return !!objective.addedBy;
      // 모두 — 완료한 목표와 지우거나 합친 목표까지. 필터가 없으면 끝나지 않은 목표만이다.
      if (filter === "all") return true;
      return !objective.done;
    });
    // 부른 세션이 목록에 목표로 서 있으면 그 줄을 self 로 가리킨다.
    const self = caller?.kind === "operation" ? caller.operationId : null;
    return page(objectives.map((objective) => (objective.id === self ? { ...rowView(objective), self: true } : rowView(objective))), today);
  }

  return [list, detail];
}
