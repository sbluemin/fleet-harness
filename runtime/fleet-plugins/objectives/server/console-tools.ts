import { type ConsoleCaller, type ConsoleUseCallTarget, type PluginMcpTool } from "@fleet-console/sdk/mcp";
import { defineConsoleTool, type ConsoleToolFilter } from "@fleet-console/sdk/mcp/actions";
import { canonicalModelId } from "@fleet-console/sdk/models";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { inboxReasons } from "./board-state.js";
import { createObjectiveActions } from "./actions.js";
import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_SHORT_INPUT, MAX_CRITERIA, MAX_REMOVAL_REASON, MAX_TITLE, MAX_CONTEXT, MAX_MISSION_TEXT, MAX_CRITERION_TEXT, MAX_DECISION_QUESTIONS, pinSchema, decisionAnswersSchema, followupSelectionSchema, missionAddSchema, missionPatchSchema, criterionAddSchema, type Objective, type ObjectiveReviewer } from "./types.js";
import { createBoardViews, refuse, roleIn, storedText, text, withPin } from "./views.js";

/**
 * 바깥 루프의 보드 — 화면 둘. `console_objectives` 는 목표 목록 화면(그룹·목록·확인 필요·진행 중·이력·모델, 추가·정리)이고
 * `console_objectives_detail` 은 목표 하나의 화면(읽기·증거, 사람의 행위)이다. Console Use 와 Theater 에 묶인 사령관 세션이
 * 같은 도메인 함수를 쓰고, 사령관 묶음은 호출자 필터(commodore)와 사령관 전용 필드(why)를 얹은 정의를 쓴다.
 */

const ids = z.string().min(1).max(128);
const MAX_ADD_PER_TURN = 10;
/** 세션 전사 한 번에 읽는 줄 수의 기본값 — 꼬리 읽기의 크기이기도 하다. */
const TRANSCRIPT_DEFAULT_LIMIT = 30;
/** 정리(지우기·합치기·되돌리기) 한 번에 받는 목표 수, 그리고 호출자마다 10분에 받는 정리 호출 수. */
const MAX_TIDY_IDS = 20;
const MAX_TIDY_PER_TURN = 20;
/** 구성원 모델 목록의 출처 — Console 이 내놓는 실행 카탈로그와 Gateway 한도 요약. 둘 다 루프백 HTTP 로만 읽는다. */
const CATALOG_PATH = "/api/v1/operations/catalog";
const QUOTA_PATH = "/api/v1/ai-gateway/quota";
const CATALOG_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 5_000;
const QUOTA_MAX_BYTES = 65_536;
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
const pin = pinSchema.optional();
const reason = z.string().trim().min(1).max(MAX_REMOVAL_REASON).optional();
const context = z.string().max(MAX_CONTEXT).optional();
const prerequisiteWhy = z.record(ids, z.string().max(MAX_SHORT_INPUT)).optional();
const memberModelSchema = z.object({ mode: z.literal("model"), model: z.string().trim().min(1).max(128), effort: z.string().trim().min(1).max(32).optional() }).strict();
const answers = z.array(decisionAnswersSchema.shape.answers.element.extend({ pin })).min(1).max(MAX_DECISION_QUESTIONS);
/** 사령관 쓰기에만 붙는 한 줄 — 사람이 사령관 기록에서 그 행위 옆에 읽는다. */
const signed = { why: z.string().trim().min(1).max(MAX_SHORT_INPUT).optional() };

const PIN_FACT = "pin is appended to the stored text as ` [pin]`: MUST NOT, MUST or MAY, then ASCII detail without brackets; at most 60 characters, and the text with its pin stays within the field limit (text_with_pin_too_long).";
const SESSION_FACT = "Session state is the session process state (dormant, ended or closed = no process; unknown = not observable); session is its fixed session name used as a message address, null meaning no fixed name.";
const WHY_FACT = "why (writes): one line the person reads beside the action in the Commodore log.";

/** 사령관 묶음의 필터 — 사령관 전용이 아닌 정리(remove·merge·restore)는 빠지고, Theater 는 생성 때 고정되므로 받지 않는다. */
const COMMODORE: ConsoleToolFilter = { caller: "commodore", omit: ["theaterId"] };

type Signed = typeof signed | Record<never, never>;

function listActions<W extends Signed>(why: W) {
  const scope = { theaterId: ids.optional() };
  const rows = { ...scope, groupId: ids.optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() };
  const tidy = { kind: "write" as const, callers: ["operation" as const], refusal: "operation_caller_required" };
  return {
    groups: { kind: "read" as const, input: z.object(scope) },
    list: { kind: "read" as const, input: z.object({ ...scope, groupId: ids.optional(), filter: z.enum(["today", "due", "all", "agent"]).optional() }) },
    inbox: { kind: "read" as const, input: z.object(rows) },
    fleet: { kind: "read" as const, input: z.object(rows) },
    history: { kind: "read" as const, input: z.object(rows) },
    models: { kind: "read" as const, input: z.object(scope) },
    add: { kind: "write" as const, input: z.object({ ...scope, title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), criteria: z.array(z.union([criterionText, z.object({ text: criterionText, pin }).strict()])).max(MAX_CRITERIA).optional(), ...why }) },
    remove: { ...tidy, input: z.object({ objectiveIds: z.array(ids).min(1).max(MAX_TIDY_IDS), reason }) },
    merge: { ...tidy, input: z.object({ into: ids, from: z.array(ids).min(1).max(MAX_TIDY_IDS), reason }) },
    restore: { ...tidy, input: z.object({ objectiveIds: z.array(ids).min(1).max(MAX_TIDY_IDS) }) },
  };
}

function detailActions<W extends Signed>(why: W) {
  const target = { objectiveId: ids };
  const write = <S extends z.ZodRawShape>(shape: S) => ({ kind: "write" as const, input: z.object({ ...target, ...shape, ...why }) });
  const commodoreOnly = { callers: ["commodore" as const], refusal: "commodore_only" };
  const missionFields = { prerequisites: missionAddSchema.shape.prerequisites, prerequisiteWhy, member: missionAddSchema.shape.member, pin };
  const followupTarget = { batchId: ids, candidateId: ids };
  return {
    read: { kind: "read" as const, input: z.object(target) },
    evidence: { kind: "read" as const, input: z.object({ ...target, resultId: ids, offset: z.number().int().min(0).optional() }) },
    transcript: { kind: "read" as const, ...commodoreOnly, input: z.object({ ...target, memberId: ids.optional(), cursor: z.string().min(1).max(64).optional(), limit: z.number().int().min(1).max(100).optional() }) },
    // 판단 한 번은 과금되는 Gateway 호출이다 — 사람의 확인 시트와 사령관만 부른다.
    routing: { kind: "read" as const, ...commodoreOnly, input: z.object({ ...target, rejudge: z.literal(true).optional() }) },
    member: { ...write({ memberId: ids, launch: memberModelSchema.nullable() }), ...commodoreOnly },
    edit_title: write({ title: z.string().trim().min(1).max(MAX_TITLE) }),
    edit_brief: write({ brief: z.string().max(20_000) }),
    mission_add: write({ text: missionAddSchema.shape.text, ...missionFields }),
    mission_patch: write({ missionId: ids, text: missionPatchSchema.shape.text, done: missionPatchSchema.shape.done, ...missionFields }),
    mission_remove: write({ missionId: ids }),
    criterion_add: write({ text: criterionAddSchema.shape.text, pin }),
    criterion_patch: write({ criterionId: ids, text: criterionAddSchema.shape.text, pin }),
    criterion_remove: write({ criterionId: ids }),
    criteria_approve: write({ proposalId: ids }),
    criteria_reject: write({ proposalId: ids }),
    answer: write({ requestId: ids, answers }),
    complete: write({ batchId: followupSelectionSchema.shape.batchId.optional(), followups: followupSelectionSchema.shape.followups.optional() }),
    reopen: write({}),
    followup_retry: write(followupTarget),
    followup_abandon: write(followupTarget),
    followup_discard: write({ candidateId: ids }),
    plan: write({ context }),
    commence: write({ context, usePreview: z.literal(true).optional() }),
    steer: write({ context }),
    message: write({ memberId: ids.nullable().optional(), text: z.string().trim().min(1).max(MAX_CONTEXT) }),
    stop: write({}),
    compact: write({}),
    extend: write({ context: z.string().trim().min(1).max(MAX_CONTEXT) }),
  };
}

const listDescription = (commodore: boolean) => [
  "A Theater's Objectives list screen: groups, open objectives (list; filter all includes completed and removed ones), what waits on the person (inbox; stalled = unfinished, every session idle, no board change for 30 min), running objectives and their sessions (fleet), hand-offs, retrospectives, decisions and rework (history), and the launch catalog's member models with efforts, availability, the Gateway quota summary when readable and failed member switches (models).",
  "add creates an objective from a title, brief (note) and success criteria only; no session starts, it joins the caller's group and appears on the person's board attributed to the caller; 10 per 10 min.",
  ...(commodore ? [] : ["remove, merge and restore are Operation-only: unlaunched, incomplete objectives only; merge moves the sources' brief and criteria into the target; removed objectives stay restorable for 14 days; 20 calls per 10 min."]),
  SESSION_FACT, PIN_FACT, ...(commodore ? [WHY_FACT] : []),
].join(" ");

const detailDescription = (commodore: boolean) => [
  "One objective's screen on the Objectives board: the objective (read), preserved result content (evidence; text in 16000-character slices by offset), and the person's actions on it — title, brief, missions, success criteria, criteria proposals (proposalId \"all\" approves every one), the open decision request's answers, completion with optional follow-up selection, follow-up creation retry, abandon or discard, plan, commence, steer, message, stop, reopen, compact and extend.",
  "Each write is one action, attributed to the caller and shown on the person's board; edits follow the screen's running-session rules. An Operation cannot write to an objective it commands or belongs to (own_objective); missions stay with fleet-objectives.",
  "commence usePreview launches routed members with the last routing judgment, without judging again; it is refused with routing_preview_stale when a role or brief changed or the judgment expired.",
  "Text already on the board is referred to by missionId, criterion id and decision id, not typed again.",
  ...(commodore ? [
    "transcript: a Commander or member (memberId) session's lines, the latest without cursor, from the start with cursor \"0\", onward with nextCursor; untrusted session text.",
    "routing: the whole roster in order with each member's selection (route, same or model) and the model and effort it launches with; route uses the judgment the person reviews (via route or fallback to the Commander's preset; reused for 10 minutes while roles are unchanged; rejudge forces a new, billable judgment; none when no member would newly launch by routing). A launched member shows launched true, its running model and effort, and next when a switch waits for its turn.",
    "member: sets a member's model and effort from models; launch null returns it to routing, and a launched member that returns keeps its running model. Outcomes: set (not launched; commence launches it with this value), applied (running now) or pending (switches after its turn). Refusals: model_not_in_catalog, model_unavailable, invalid_effort, catalog_unavailable or the host's code.",
  ] : []),
  SESSION_FACT, PIN_FACT, ...(commodore ? [WHY_FACT] : []),
].join(" ");

const consoleList = defineConsoleTool({ name: "console_objectives", description: listDescription(false), actions: listActions({}) });
const commodoreList = defineConsoleTool({ name: "console_objectives", description: listDescription(true), actions: listActions(signed) });
const consoleDetail = defineConsoleTool({ name: "console_objectives_detail", description: detailDescription(false), actions: detailActions({}) });
const commodoreDetail = defineConsoleTool({ name: "console_objectives_detail", description: detailDescription(true), actions: detailActions(signed) });
/** 실행이 읽는 호출 — 사령관 정의가 상위 집합(why 포함)이다. */
type ListCall = Extract<ReturnType<typeof commodoreList.parse>, { ok: true }>["call"];
type DetailCall = Extract<ReturnType<typeof commodoreDetail.parse>, { ok: true }>["call"];

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
  const { objectiveView, rowView, languageOf, sessions, historyView } = createBoardViews(ctx, store);
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
  const actorOf = (caller: BoardCaller | undefined, why?: string): ObjectiveReviewer | null => caller?.kind === "commodore" ? { ...caller, ...(why ? { why } : {}) } : caller?.kind === "operation" ? { kind: "operation", operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null } : null;
  const language = (caller: BoardCaller | undefined) => languageOf(caller?.kind === "commodore" ? undefined : caller);
  const scoped = (objectiveId: string) => {
    const found = store.find(objectiveId);
    if (!found) throw new ObjectiveStoreError("unknown_objective");
    if (bound && found.theaterId !== bound.theaterId) throw new ObjectiveStoreError("other_theater");
    return found;
  };
  // 호스트는 연결의 필터로 이미 검증한 호출을 넘긴다. 실행은 호출자 종류로 한 번 더 같은 검증을 지난다 — 직접 부른 호출과 사령관 묶음도 같은 길이다.
  const filterOf = (caller: BoardCaller | undefined): ConsoleToolFilter | undefined => bound ? COMMODORE : caller ? { caller: caller.kind } : undefined;
  const listTool = bound ? commodoreList : consoleList;
  const detailTool = bound ? commodoreDetail : consoleDetail;
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
          // 정리는 에이전트 Operation 이 한다 — 누가 지웠는지가 사람의 보드에 남아야 한다.
          if (caller?.kind !== "operation") return refuse("operation_caller_required");
          if (!spend(tidyBudget, callerKey(caller), MAX_TIDY_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_TIDY_PER_TURN });
          const actor = (why?: string) => ({ operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null, ...(why ? { reason: why } : {}) });
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
        const theaterId = bound?.theaterId ?? ("theaterId" in call ? call.theaterId : undefined) ?? theaterOfCaller(caller);
        if (call.action === "models") return text(await models(theaterId, context.signal));
        if (call.action !== "add") {
          if (!theaterId) return refuse("theater_required");
          return text(read(call, theaterId, caller));
        }
        if (!theaterId) return refuse("theater_required");
        if (caller?.kind === "operation" && !spend(addBudget, callerKey(caller), MAX_ADD_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN });
        const why = "why" in call ? call.why : undefined;
        // 그룹은 입력으로 받지 않는다 — 호출 Operation 의 그룹을 그대로 따른다.
        const groupId = caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null;
        const objective = await launch.create({
          theaterId, groupId, title: call.title, ...(call.note ? { note: call.note } : {}),
          // 달성 기준 문장은 검증된 순서 그대로 기본 요구사항으로 함께 저장된다 — 한 건이라도 맞지 않으면 스키마에서
          // 거절되므로 목표가 기준 없이 먼저 생기지 않는다. AI 생성 표시는 목표의 addedBy 로 남는다.
          ...(call.criteria?.length ? { criteria: call.criteria.map((criterion) => typeof criterion === "string" ? criterion : withPin(criterion.text, criterion.pin, MAX_CRITERION_TEXT)) } : {}),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : caller?.kind === "commodore" ? { addedBy: { ...caller, ...(why ? { why } : {}) } } : {}),
        }, { language: language(caller), ...(actorOf(caller, why) ? { actor: actorOf(caller, why)! } : {}) });
        const kept = store.find(objective.id) ?? objective;
        return text({ ok: true, objectiveId: objective.id, stored: { title: kept.title, ...(kept.note ? { note: storedText(kept.note) } : {}), ...(kept.criteria.length ? { criteria: kept.criteria.map((criterion) => storedText(criterion.text)) } : {}) } });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, error.details ?? {});
        return refuse("objectives_failed");
      }
    },
  }, bound ? COMMODORE : undefined);

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
        if (action === "member") return { theaterId, summary: `구성원 모델 바꿈 「${title}」`, gesture: "press", ...at };
        if (detailTool.actions[action]?.kind === "write") return { theaterId, summary: `목표 ${action} 「${title}」`, gesture: "press", ...at };
        return { theaterId, summary: action === "transcript" ? `세션 기록 봄 「${title}」` : action === "routing" ? `라우팅 검토 「${title}」` : action === "evidence" ? `증거 봄 「${title}」` : `목표 봄 「${title}」`, ...at };
      },
    },
    execute: async (raw, context) => {
      const caller: BoardCaller | undefined = bound ?? context.caller;
      const parsed = detailTool.parse(raw, filterOf(caller));
      if (!parsed.ok) return refusal(parsed);
      const call = parsed.call as DetailCall;
      try {
        // 사령관 전용 — 사람은 화면에서 라우팅을 검토하고 구성원 모델을 바꾸며, Operation 은 세션을 console_operation 으로 읽는다.
        if ((call.action === "transcript" || call.action === "routing" || call.action === "member") && !bound) return refuse("commodore_only");
        const current = scoped(call.objectiveId);
        if (call.action === "read") return text({ objective: { ...objectiveView(current), decisionRequest: current.decisionRequest } });
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
        if (call.action === "routing") {
          if (launch.busy(current.id)) return refuse("objective_busy");
          return text(await lineup(current, call.rejudge === true));
        }
        if (call.action === "transcript") return text(await transcript(current, call, context.signal));
        const why = "why" in call ? call.why : undefined;
        const actor = actorOf(caller, why);
        if (!actor) return refuse("operation_caller_required");
        if (caller?.kind === "operation" && roleIn(current, caller)) return refuse("own_objective");
        const actions = createObjectiveActions(ctx, store, launch, actor);
        const ref = { objectiveId: current.id, language: language(caller) };
        if (call.action === "member") return text(await memberLaunch(actions, current, call, context.signal));
        if (call.action === "complete" && (call.batchId === undefined) !== (call.followups === undefined)) return refuse("invalid_arguments", { issues: [{ path: [call.batchId === undefined ? "batchId" : "followups"], code: "invalid_type" }] });
        const missionText = (value: string, missionPin: string | undefined) => withPin(value, missionPin, MAX_MISSION_TEXT);
        const result = await (async () => {
          switch (call.action) {
            case "plan": return actions.plan({ ...ref, ...(call.context !== undefined ? { context: call.context } : {}) });
            case "commence": return actions.commence({ ...ref, ...(call.context !== undefined ? { context: call.context } : {}), ...(call.usePreview ? { routing: "preview" as const } : {}) });
            case "criteria_approve": return call.proposalId === "all" ? actions.approveAll(ref) : actions.approve({ ...ref, proposalId: call.proposalId });
            case "criteria_reject": return actions.reject({ ...ref, proposalId: call.proposalId });
            case "answer": return actions.answer({ ...ref, requestId: call.requestId, answers: call.answers.map(({ pin: answerPin, ...answer }, index) => ({ ...answer, text: withPin(answer.text, answerPin, MAX_SHORT_INPUT, `answers[${index}].text`) })) });
            case "complete": return actions.complete({ ...ref, ...(call.batchId !== undefined && call.followups ? { batchId: call.batchId, followups: call.followups } : {}) });
            case "reopen": return actions.complete({ ...ref, undone: true });
            case "steer": return actions.steer({ ...ref, ...(call.context !== undefined ? { context: call.context } : {}) });
            case "message": return actions.message({ ...ref, text: call.text, ...(call.memberId !== undefined ? { memberId: call.memberId } : {}) });
            case "stop": return actions.stop(ref);
            case "compact": return actions.compact(ref);
            case "extend": return actions.extend({ ...ref, context: call.context });
            case "followup_retry": return actions.followupRetry({ ...ref, batchId: call.batchId, candidateId: call.candidateId });
            case "followup_abandon": return actions.followupAbandon({ ...ref, batchId: call.batchId, candidateId: call.candidateId });
            case "followup_discard": return actions.followupDiscard({ ...ref, candidateId: call.candidateId });
            case "edit_title": return actions.patch({ ...ref, patch: { title: call.title } });
            case "edit_brief": return actions.patch({ ...ref, patch: { note: call.brief } });
            case "mission_add": return actions.missionAdd({ ...ref, mission: { text: missionText(call.text, call.pin), ...(call.prerequisites ? { prerequisites: call.prerequisites } : {}), ...(call.prerequisiteWhy ? { why: call.prerequisiteWhy } : {}), ...(call.member !== undefined ? { member: call.member } : {}) } });
            case "mission_patch": {
              if (call.pin !== undefined && call.text === undefined) throw new ObjectiveStoreError("pin_needs_text");
              const patch = { ...(call.text !== undefined ? { text: missionText(call.text, call.pin) } : {}), ...(call.done !== undefined ? { done: call.done } : {}), ...(call.prerequisites ? { prerequisites: call.prerequisites } : {}), ...(call.prerequisiteWhy ? { why: call.prerequisiteWhy } : {}), ...(call.member !== undefined ? { member: call.member } : {}) };
              return actions.missionPatch({ ...ref, missionId: call.missionId, patch });
            }
            case "mission_remove": return actions.missionRemove({ ...ref, missionId: call.missionId });
            case "criterion_add": return actions.criterionAdd({ ...ref, criterion: { text: withPin(call.text, call.pin, MAX_CRITERION_TEXT) } });
            case "criterion_patch": return actions.criterionPatch({ ...ref, criterionId: call.criterionId, patch: { text: withPin(call.text, call.pin, MAX_CRITERION_TEXT) } });
            case "criterion_remove": return actions.criterionRemove({ ...ref, criterionId: call.criterionId });
          }
        })();
        const { objective: updated, ...details } = result;
        const kept = store.find(updated.id);
        const fresh = <T extends { readonly id: string }>(now: readonly T[], then: readonly T[]) => now.find((entry) => !then.some((prior) => prior.id === entry.id));
        const missionEcho = (id: string | undefined) => ((mission) => mission && { mission: { id: mission.id, text: storedText(mission.text) } })(kept?.missions.find((entry) => entry.id === id));
        const criterionEcho = (id: string | undefined) => ((criterion) => criterion && { criterion: { id: criterion.id, text: storedText(criterion.text) } })(kept?.criteria.find((entry) => entry.id === id));
        const stored = !kept ? undefined
          : call.action === "edit_title" ? { title: kept.title }
          : call.action === "edit_brief" ? { brief: storedText(kept.note) }
          : call.action === "mission_add" ? missionEcho(fresh(kept.missions, current.missions)?.id)
          : call.action === "mission_patch" ? missionEcho(call.missionId)
          : call.action === "criterion_add" ? criterionEcho(fresh(kept.criteria, current.criteria)?.id)
          : call.action === "criterion_patch" ? criterionEcho(call.criterionId)
          : undefined;
        const answered = call.action === "answer" ? store.storedAnswers(current.id, call.requestId) : null;
        const echo = answered ? { answers: answered.map(({ questionId, selectedOptionIds, text: answer }) => ({ questionId, ...(selectedOptionIds.length ? { selectedOptionIds } : {}), ...(answer ? { text: storedText(answer) } : {}) })) } : stored;
        return text({ ok: true, objectiveId: updated.id, ...details, ...(echo ? { stored: echo } : {}) });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, error.details ?? {});
        return refuse("objectives_failed");
      }
    },
  }, bound ? COMMODORE : undefined);


  /**
   * 사령관의 구성원 모델 선택 — 사람의 모델 칩과 같은 memberPatch 경로다(띄우기 전이면 선택만, 띄웠으면 #1417 의 지금·턴 뒤 전환).
   * 고른 값은 카탈로그에 있는 모델과 그 모델의 강도여야 하고, 카탈로그를 읽지 못하면 추측으로 통과시키지 않는다.
   */
  async function memberLaunch(actions: ReturnType<typeof createObjectiveActions>, objective: Objective, input: { readonly memberId: string; readonly launch: z.output<typeof memberModelSchema> | null }, signal: AbortSignal | undefined) {
    if (!objective.members.some((member) => member.id === input.memberId)) throw new ObjectiveStoreError("unknown_member");
    if (input.launch) {
      const catalog = await loadCatalog(signal);
      if (!catalog) throw new ObjectiveStoreError("catalog_unavailable");
      // bare·scoped 표기도 같은 정준 좌표의 카탈로그 행으로 찾는다.
      const wanted = canonicalModelId(input.launch.model);
      const row = catalog.find((entry) => canonicalModelId(entry.model) === wanted);
      if (!row) throw new ObjectiveStoreError("model_not_in_catalog");
      if (!row.available) throw new ObjectiveStoreError("model_unavailable", undefined, row.reason ? { reason: row.reason } : {});
      if (input.launch.effort !== undefined && !row.efforts.includes(input.launch.effort)) throw new ObjectiveStoreError("invalid_effort", undefined, { efforts: row.efforts });
    }
    const launched = !!(ctx.host.operations.describe ? ctx.host.operations.describe(input.memberId) : ctx.host.operations.get(input.memberId));
    const { objective: updated } = await actions.memberPatch({ objectiveId: objective.id, memberId: input.memberId, patch: { launch: input.launch } });
    const member = updated.members.find((entry) => entry.id === input.memberId);
    const outcome = !launched ? "set" : member?.next && !member.next.failed ? "pending" : "applied";
    return { ok: true, objectiveId: updated.id, memberId: input.memberId, outcome, launch: member?.launch ?? null, model: member?.model ?? null, effort: member?.effort ?? null, next: member?.next ?? null };
  }

  /**
   * 개시 전 라인업 — 로스터 전원을 순서대로, 띄울 때 쓸 모델·강도와 함께. 라우팅 구성원은 사람의 확인 시트와 같은 판단(routingPreview)이고
   * 폴백이면 지휘관 프리셋, same 은 지휘관 프리셋, model 은 고른 값이다. 띄운 구성원은 실행값과 턴 뒤 예약이다. 새로 띄울 라우팅 구성원이
   * 없으면 판단하지 않는다.
   */
  async function lineup(objective: Objective, rejudge: boolean) {
    const launched = (id: string) => !!(ctx.host.operations.describe ? ctx.host.operations.describe(id) : ctx.host.operations.get(id));
    const routing = objective.members.some((member) => member.launch.mode === "route" && !launched(member.id));
    const preview = routing ? await launch.routingPreview(objective.id, rejudge ? { rejudge: true } : undefined) : null;
    const current = scoped(objective.id);
    const decisions = new Map(preview?.members.map((entry) => [entry.id, entry]) ?? []);
    const commander = { ...(current.commander.model ? { model: current.commander.model } : {}), ...(current.commander.effort ? { effort: current.commander.effort } : {}) };
    const members = current.members.map((member) => {
      const row = { id: member.id, role: member.role, selection: member.launch.mode };
      if (launched(member.id)) return { ...row, launched: true, ...(member.model ? { model: member.model } : {}), ...(member.effort ? { effort: member.effort } : {}), ...(member.next ? { next: member.next } : {}) };
      if (member.launch.mode === "model") return { ...row, launched: false, model: member.launch.model, ...(member.launch.effort ? { effort: member.launch.effort } : {}) };
      if (member.launch.mode === "same") return { ...row, launched: false, ...commander };
      const { id: _id, ...decision } = decisions.get(member.id) ?? { id: member.id, via: "fallback" as const, reason: "routing_failed", ...commander };
      return { ...row, launched: false, ...decision };
    });
    return { objectiveId: current.id, judged: preview?.judged ?? false, ...(preview ? { at: preview.at, expiresAt: preview.expiresAt } : {}), members };
  }

  /** Console 의 루프백 GET — origin 이 없거나 실패·시간 초과면 null. */
  async function loopback(pathname: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    const origin = ctx.host.server.origin();
    if (!origin) return null;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${origin}${pathname}`, { method: "GET", headers: { origin, accept: "application/json" }, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) return null;
      const body = await response.text();
      return body.length > 0 ? JSON.parse(body) as unknown : null;
    } catch { return null; }
  }

  /** 실행 카탈로그의 모델 행 — 화면의 모델 메뉴(loadLaunchGroups)와 같은 해석이다: 변형 행의 launch.model, 강도는 그 행의 칩. 처음 나온 모델이 이긴다. */
  async function loadCatalog(signal: AbortSignal | undefined) {
    const body = await loopback(CATALOG_PATH, CATALOG_TIMEOUT_MS, signal);
    if (!isRecord(body) || !Array.isArray(body.plugins)) return null;
    const rows: { model: string; label: string; provider: string | null; efforts: string[]; available: boolean; reason?: string; quotaScope?: string; quotaPool?: string }[] = [];
    const seen = new Set<string>();
    for (const plugin of body.plugins) {
      if (!isRecord(plugin) || !Array.isArray(plugin.kinds)) continue;
      for (const kind of plugin.kinds) {
        if (!isRecord(kind)) continue;
        const available = kind.disabled !== true;
        const reason = !available && typeof kind.disabledReason === "string" ? kind.disabledReason.slice(0, 200) : undefined;
        for (const group of readLaunchVariantGroups(kind.variants)) {
          for (const row of group.rows) {
            const model = row.launch.model;
            if (!model || seen.has(model)) continue;
            seen.add(model);
            const efforts = (row.chips ?? []).flatMap((chip) => (chip.launch.effort ? [chip.launch.effort] : []));
            rows.push({ model, label: row.label, provider: providerOf(group.id, model), efforts, available, ...(reason ? { reason } : {}), ...(row.quotaScope ? { quotaScope: row.quotaScope } : {}), ...(row.quotaPool ? { quotaPool: row.quotaPool } : {}) });
          }
        }
      }
    }
    return rows;
  }

  /** Gateway 한도 요약(공급자별 창의 사용률) — 읽지 못하면 null 이고 목록은 그대로 낸다. */
  async function loadQuota(signal: AbortSignal | undefined) {
    const body = await loopback(`${QUOTA_PATH}?stale=1`, QUOTA_TIMEOUT_MS, signal);
    const providers = isRecord(body) && isRecord(body.providers) ? body.providers : null;
    if (!providers || JSON.stringify(providers).length > QUOTA_MAX_BYTES) return null;
    const quota: Record<string, { status: string; windows?: { id: string; label?: string; usedPercent: number; resetsAt?: number; scope?: string; isAggregate?: boolean }[] }> = {};
    for (const [provider, entry] of Object.entries(providers)) {
      if (!isRecord(entry) || typeof entry.status !== "string") continue;
      const windows = Array.isArray(entry.windows) ? entry.windows.flatMap((window) => isRecord(window) && typeof window.id === "string" && typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
        ? [{ id: window.id, ...(typeof window.label === "string" ? { label: window.label.slice(0, 80) } : {}), usedPercent: window.usedPercent, ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}), ...(typeof window.scope === "string" ? { scope: window.scope } : {}), ...(typeof window.isAggregate === "boolean" ? { isAggregate: window.isAggregate } : {}) }]
        : []) : [];
      quota[provider] = { status: entry.status, ...(windows.length ? { windows } : {}) };
    }
    return Object.keys(quota).length ? quota : null;
  }

  async function models(theaterId: string | null, signal: AbortSignal | undefined) {
    const [catalog, quota] = await Promise.all([loadCatalog(signal), loadQuota(signal)]);
    if (!catalog) throw new ObjectiveStoreError("catalog_unavailable");
    // 바꾸지 못한 턴 뒤 전환 — 그 모델로 다시 고르기 전에 볼 사유다.
    const failedSwitches = theaterId ? store.list(theaterId).filter((objective) => !objective.done && !objective.removed).flatMap((objective) => objective.members.flatMap((member) => member.next?.failed
      ? [{ objectiveId: objective.id, memberId: member.id, role: member.role, model: member.next.model, ...(member.next.effort ? { effort: member.next.effort } : {}), failed: member.next.failed }]
      : [])) : [];
    return { models: catalog, quota, failedSwitches };
  }

  /** 목표 세션의 전사 — 지휘관 또는 구성원. Theater 경계는 호출 전에 scoped 가 지켰고, 소유(이 플러그인이 띄운 세션)는 호스트가 지킨다. */
  async function transcript(objective: Objective, args: { readonly memberId?: string | undefined; readonly cursor?: string | undefined; readonly limit?: number | undefined }, signal: AbortSignal | undefined) {
    const member = args.memberId ? objective.members.find((candidate) => candidate.id === args.memberId) : null;
    if (args.memberId && !member) throw new ObjectiveStoreError("unknown_member");
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
    const page = <T,>(rows: readonly T[]) => {
      const offset = "offset" in args ? args.offset ?? 0 : 0, limit = "limit" in args ? args.limit ?? 50 : 50;
      return { theaterId, total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, objectives: rows.slice(offset, offset + limit) };
    };
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
    return { theaterId, today, objectives: objectives.map((objective) => (objective.id === self ? { ...rowView(objective), self: true } : rowView(objective))) };
  }

  return [list, detail];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** 카탈로그 묶음의 공급자 — native 는 Claude, gateway:<공급자>; 없으면 모델 id 의 접두. 한도 요약의 키와 같다. */
const providerOf = (groupId: string, model: string): string | null =>
  groupId === "native" ? "claude" : groupId.startsWith("gateway:") ? groupId.slice("gateway:".length) || null : !model.includes("--") ? "claude" : model.split("--", 1)[0] || null;
