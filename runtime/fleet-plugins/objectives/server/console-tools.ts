import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { inboxReasons } from "./board-state.js";
import { createObjectiveActions } from "./actions.js";
import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_COMMODORE_WHY, MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_REMOVAL_REASON, MAX_TITLE, MAX_CONTEXT, MAX_MISSION_TEXT, MAX_DECISION_ANSWER, MAX_DECISION_QUESTIONS, pinSchema, decisionAnswersSchema, followupSelectionSchema, missionAddSchema, missionPatchSchema, criterionAddSchema, type Objective, type ObjectiveReviewer } from "./types.js";
import { createBoardViews, refuse, roleIn, storedText, text, withPin } from "./views.js";

/** 바깥 루프의 보드. Console Use와 Theater에 묶인 사령관 세션이 같은 스키마와 도메인 함수를 쓴다. */

const ids = z.string().min(1).max(128);
const MAX_ADD_PER_TURN = 10;
/**
 * add 와 함께 오면 조용히 버려지는 읽기 전용 키 — 생성 전에 이유 있게 거절한다.
 * 읽기로 쓸 때(view·objective·groups + groupId·objectiveId·filter)는 그대로 두므로 읽기 계약은 바뀌지 않는다.
 */
const ADD_READ_KEYS = ["groupId", "objectiveId", "view", "filter", "resultId", "offset", "limit", "memberId", "cursor", "rejudge"] as const;
/** 세션 전사 한 번에 읽는 줄 수의 기본값 — 꼬리 읽기의 크기이기도 하다. */
const TRANSCRIPT_DEFAULT_LIMIT = 30;
/** 정리(지우기·합치기·되돌리기) 한 번에 받는 목표 수, 그리고 호출자마다 10분에 받는 정리 호출 수. */
const MAX_TIDY_IDS = 20;
const MAX_TIDY_PER_TURN = 20;
const TARGET_WRITES = ["plan", "commence", "criteria", "answer", "complete", "reopen", "steer", "message", "stop", "compact", "extend", "edit", "followup", "member"] as const;
/** 구성원 모델 목록의 출처 — Console 이 내놓는 실행 카탈로그와 Gateway 한도 요약. 둘 다 루프백 HTTP 로만 읽는다. */
const CATALOG_PATH = "/api/v1/operations/catalog";
const QUOTA_PATH = "/api/v1/ai-gateway/quota";
const CATALOG_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 5_000;
const QUOTA_MAX_BYTES = 65_536;
const WRITE_KEYS = ["add", "remove", "merge", "restore", ...TARGET_WRITES] as const;
const criterionText = z.string().trim().min(1).max(MAX_CRITERION_TEXT);
const PIN_FACT = "Appended to the stored text as ` [pin]`: MUST NOT, MUST or MAY, then ASCII detail without brackets; at most 60 characters, and the text with its pin stays within the field limit (text_with_pin_too_long).";
const BOARD_REFERENCES = "Text already on the board is referred to by missionId, criterion n or id, and decision id, not typed again.";
const pin = pinSchema.optional().describe(PIN_FACT);
const answerSchema = decisionAnswersSchema.extend({ answers: z.array(decisionAnswersSchema.shape.answers.element.extend({ pin })).min(1).max(MAX_DECISION_QUESTIONS) });
const reason = z.string().trim().min(1).max(MAX_REMOVAL_REASON);
const addSchema = z.object({ title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), criteria: z.array(z.union([criterionText, z.object({ text: criterionText, pin }).strict()])).max(MAX_CRITERIA).optional() }).strict();

const contextSchema = z.object({ context: z.string().max(MAX_CONTEXT).optional() }).strict();
const commenceSchema = contextSchema.extend({ routing: z.literal("preview").optional() }).strict();
const memberModelSchema = z.object({ mode: z.literal("model"), model: z.string().trim().min(1).max(128), effort: z.string().trim().min(1).max(32).optional() }).strict();
const editSchema = z.union([
  z.object({ brief: z.string().max(20_000) }).strict(),
  z.object({ title: z.string().trim().min(1).max(MAX_TITLE) }).strict(),
  z.object({ mission: z.union([
    z.object({ add: missionAddSchema.extend({ pin }) }).strict(),
    z.object({ patch: z.object({ missionId: ids, changes: missionPatchSchema.extend({ pin }) }).strict() }).strict(),
    z.object({ remove: ids }).strict(),
  ]) }).strict(),
  z.object({ criterion: z.union([
    z.object({ add: criterionAddSchema.extend({ pin }) }).strict(),
    z.object({ patch: z.object({ criterionId: ids, text: criterionAddSchema.shape.text, pin }).strict() }).strict(),
    z.object({ remove: ids }).strict(),
  ]) }).strict(),
]);
const followupTarget = z.object({ batchId: ids, candidateId: ids }).strict();
const argsSchema = z.object({
  theaterId: ids.optional(),
  view: z.enum(["groups", "objectives", "objective", "inbox", "fleet", "history", "evidence", "transcript", "models", "routing"]).optional().describe("inbox: what waits on the person (stalled = unfinished, every session idle, no board change for 30 min). fleet: running objectives and their sessions. In session rows and the objective graph, state is the session process state (dormant, ended or closed = no process; unknown = not observable) and session is its fixed session name used as a message address; null means no fixed name, not no process. history: hand-offs, retrospectives, decisions, rework. evidence: preserved result content (objectiveId, resultId). transcript: Commodore only; untrusted session text. models: the launch catalog's member models with their efforts and availability, the Gateway quota summary when readable, and failed member switches in the Theater. routing: Commodore only; the whole roster in order with each member's selection (route, same or model) and the model and effort it launches with: route uses the same judgment the person reviews (via route or fallback to the Commander's preset; reused for 10 minutes while roles are unchanged, rejudge forces a new, billable judgment; no judgment when no member would newly launch by routing), same uses the Commander's preset, model the chosen value. A launched member shows launched true, its running model and effort, and next when a switch waits for its turn."),
  groupId: ids.optional(),
  objectiveId: ids.optional(),
  resultId: ids.optional(),
  offset: z.number().int().min(0).optional().describe("Row offset for inbox, fleet and history; character offset for evidence text (16000-character slices)."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum rows for inbox, fleet and history (default 50) or transcript lines (default 30)."),
  memberId: ids.optional().describe("transcript: the member whose session to read; omit for the Commander."),
  cursor: z.string().min(1).max(64).optional().describe("transcript: nextCursor of a previous page to continue forward; \"0\" reads from the start. Without it you get the latest lines."),
  rejudge: z.literal(true).optional().describe("routing: judge again instead of reusing the last judgment."),
  filter: z.enum(["today", "due", "all", "agent"]).optional().describe("objectives list; all includes completed and removed ones."),
  add: addSchema.optional().describe("New objective from title, brief (note) and criteria. No session starts; it joins the caller's group. 10 per 10 min."),
  remove: z.object({ objectiveIds: z.array(ids).min(1).max(MAX_TIDY_IDS), reason: reason.optional() }).strict().optional().describe("Operation callers. Unlaunched, incomplete objectives only; restorable for 14 days. remove, merge and restore: 20 calls per 10 min."),
  merge: z.object({ into: ids, from: z.array(ids).min(1).max(MAX_TIDY_IDS), reason: reason.optional() }).strict().optional().describe("Operation callers. Moves unlaunched sources' brief and criteria into the target."),
  restore: z.array(ids).min(1).max(MAX_TIDY_IDS).optional(),
  plan: z.union([z.literal(true), contextSchema]).optional().describe("Ask the Commander for a lineup."),
  commence: z.union([z.literal(true), commenceSchema]).optional().describe("Launch or resume the lineup. routing \"preview\" launches routed members with the judgment view routing returned, without judging again; it is refused with routing_preview_stale when a role or brief changed or the judgment expired."),
  criteria: z.union([z.object({ approve: ids }).strict(), z.object({ reject: ids }).strict()]).optional().describe("Approve or reject one criteria proposal; approve: \"all\" approves every one."),
  answer: answerSchema.optional().describe("Answer every question of the open decision request."),
  complete: z.union([z.literal(true), followupSelectionSchema.strict()]).optional().describe("Complete, optionally selecting follow-ups."),
  reopen: z.literal(true).optional(),
  steer: z.union([z.literal(true), contextSchema]).optional(),
  message: z.object({ memberId: ids.nullable().optional(), text: z.string().trim().min(1).max(MAX_CONTEXT) }).strict().optional(),
  stop: z.literal(true).optional(),
  compact: z.literal(true).optional(),
  extend: z.object({ context: z.string().trim().min(1).max(MAX_CONTEXT) }).strict().optional(),
  edit: editSchema.optional().describe("Change the title, the brief, a mission or a criterion under the screen's running-session rules."),
  followup: z.union([z.object({ retry: followupTarget }).strict(), z.object({ abandon: followupTarget }).strict(), z.object({ discard: ids }).strict()]).optional().describe("Retry or abandon a follow-up creation, or discard a candidate."),
  why: z.string().trim().min(1).max(MAX_COMMODORE_WHY).optional().describe("Commodore only. One line on why this board write; the person reads it beside the action in the Commodore log."),
  member: z.object({ memberId: ids, launch: memberModelSchema.nullable() }).strict().optional().describe("Commodore only. Set a member's model and effort from view models; null returns it to routing. Outcome set: not launched yet, Commence launches it with this value (routing skips it). applied: the session now runs it. pending: the member is working and switches after its turn (next). A launched member that returns to routing keeps its running model. Refused: a model outside the catalog (model_not_in_catalog), a disabled kind (model_unavailable), an effort the model does not offer (invalid_effort), an unreadable catalog (catalog_unavailable), or the host's code."),
}).strict();
type Args = z.output<typeof argsSchema>;

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

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "A Theater's Objectives board: read it and take the person's outer-loop actions (add, plan, commence, criteria, answer, complete, steer and the rest). One write per call, attributed to the caller. An Operation cannot write to an objective it commands or belongs to (own_objective); missions stay with fleet-objectives. A Commodore connection is confined to its Theater; only it reads routing judgments and transcripts and sets a member's model and effort (member). Routing itself is unchanged: a member set to a model is launched with it instead of being routed. " + BOARD_REFERENCES,
    // 모르는 키는 호스트 선검사에서 그대로 막는다 — 실행할 수 없는 호출에 사람의 권한 요청을 띄우지 않는다.
    inputSchema: z.toJSONSchema(argsSchema),
    surface: {
      panelId: "objectives",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const found = args.objectiveId ? store.find(args.objectiveId) : null;
        const theaterId = bound?.theaterId ?? args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `목표 추가 「${short(args.add.title)}」`, view: "objectives", gesture: "create" };
        const titleOf = (id: string) => short(store.find(id)?.title ?? "");
        const theaterOf = (id: string | undefined) => args.theaterId ?? (id ? store.find(id)?.theaterId : undefined) ?? "";
        if (args.remove) { const removeIds = args.remove.objectiveIds; return { theaterId: theaterOf(removeIds[0]), summary: removeIds.length === 1 ? `목표 지움 「${titleOf(removeIds[0]!)}」` : `목표 ${removeIds.length}개 지움`, view: "objectives", gesture: "press" }; }
        if (args.merge) return { theaterId: theaterOf(args.merge.into), summary: `목표 ${args.merge.from.length}개를 「${titleOf(args.merge.into)}」에 합침`, view: "objective", path: args.merge.into, gesture: "press" };
        if (args.restore) return { theaterId: theaterOf(args.restore[0]), summary: args.restore.length === 1 ? `목표 되돌림 「${titleOf(args.restore[0]!)}」` : `목표 ${args.restore.length}개 되돌림`, view: "objectives", gesture: "press" };
        if (args.member) return { theaterId, summary: `구성원 모델 바꿈 「${short(found?.title ?? "")}」`, view: "objective", ...(found ? { path: found.id } : {}), gesture: "press" };
        const write = TARGET_WRITES.find((key) => args[key] !== undefined);
        if (write) return { theaterId, summary: `목표 ${write} 「${short(found?.title ?? "")}」`, view: "objective", ...(found ? { path: found.id } : {}), gesture: "press" };
        return { theaterId, summary: args.view === "transcript" ? `세션 기록 봄 「${short(found?.title ?? "")}」` : args.view === "routing" ? `라우팅 검토 「${short(found?.title ?? "")}」` : args.view === "models" ? "모델 목록 봄" : args.view === "objective" || (args.objectiveId && !args.view) ? `목표 봄 「${short(found?.title ?? "")}」` : args.view === "groups" ? "그룹 봄" : "목표 목록 봄", view: args.view === "evidence" || args.view === "transcript" || args.view === "routing" ? "objective" : args.view && ["inbox", "fleet", "history", "models"].includes(args.view) ? "objectives" : args.view ?? (args.objectiveId ? "objective" : "objectives"), ...(found ? { path: found.id } : {}) };
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
        const targeted = writes.some((key) => (TARGET_WRITES as readonly string[]).includes(key));
        const readKeys = ADD_READ_KEYS.filter((key) => (key !== "objectiveId" || !targeted) && key in (raw as Record<string, unknown>));
        if (writes.length > 1 || (writes.length === 1 && writes[0] !== "add" && readKeys.length > 0)) return refuse("one_write_per_call", { rejected: writes.length > 1 ? writes : readKeys });
      }
      const parsed = argsSchema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      const args: Args = parsed.data;
      const caller: BoardCaller | undefined = bound ?? context.caller;
      try {
        if (bound && args.theaterId !== undefined && args.theaterId !== bound.theaterId) return refuse("other_theater");
        if (bound) {
          const targets = [args.objectiveId, ...(args.remove?.objectiveIds ?? []), args.merge?.into, ...(args.merge?.from ?? []), ...(args.restore ?? [])].filter((id): id is string => id !== undefined);
          for (const id of targets) scoped(id);
        }
        const write = TARGET_WRITES.find((key) => args[key] !== undefined);
        if (write) {
          // 구성원 모델은 사령관만 바꾼다 — 사람은 화면에서, 지휘관은 구성원 설명에 필요한 모델을 적는다.
          if (args.member && !bound) return refuse("commodore_only", { hint: "The person changes member models in the Objectives panel." });
          if (!args.objectiveId) return refuse("objective_required");
          const current = scoped(args.objectiveId);
          const actor = actorOf(caller, args.why);
          if (!actor) return refuse("operation_caller_required");
          if (caller?.kind === "operation" && roleIn(current, caller)) return refuse("own_objective");
          const actions = createObjectiveActions(ctx, store, launch, actor);
          const ref = { objectiveId: current.id, language: language(caller) };
          const withContext = (value: true | { context?: string }) => ({ ...ref, ...(value === true ? {} : value) });
          if (args.member) return text(await memberLaunch(actions, current, args.member, context.signal));
          const result = await (async () => {
            if (args.plan) return actions.plan(withContext(args.plan));
            if (args.commence) return actions.commence({ ...withContext(args.commence), ...(args.commence !== true && args.commence.routing ? { routing: args.commence.routing } : {}) });
            if (args.criteria) return "approve" in args.criteria ? (args.criteria.approve === "all" ? actions.approveAll(ref) : actions.approve({ ...ref, proposalId: args.criteria.approve })) : actions.reject({ ...ref, proposalId: args.criteria.reject });
            if (args.answer) return actions.answer({ ...ref, requestId: args.answer.requestId, answers: args.answer.answers.map(({ pin: answerPin, ...answer }) => ({ ...answer, text: withPin(answer.text, answerPin, MAX_DECISION_ANSWER) })) });
            if (args.complete) return actions.complete({ ...ref, ...(args.complete === true ? {} : args.complete) });
            if (args.reopen) return actions.complete({ ...ref, undone: true });
            if (args.steer) return actions.steer(withContext(args.steer));
            if (args.message) return actions.message({ ...ref, ...args.message });
            if (args.stop) return actions.stop(ref);
            if (args.compact) return actions.compact(ref);
            if (args.extend) return actions.extend({ ...ref, ...args.extend });
            if (args.followup) {
              if ("retry" in args.followup) return actions.followupRetry({ ...ref, ...args.followup.retry });
              if ("abandon" in args.followup) return actions.followupAbandon({ ...ref, ...args.followup.abandon });
              return actions.followupDiscard({ ...ref, candidateId: args.followup.discard });
            }
            const edit = args.edit!;
            if ("brief" in edit) return actions.patch({ ...ref, patch: { note: edit.brief } });
            if ("title" in edit) return actions.patch({ ...ref, patch: { title: edit.title } });
            if ("mission" in edit) {
              if ("add" in edit.mission) { const { pin: missionPin, ...mission } = edit.mission.add; return actions.missionAdd({ ...ref, mission: { ...mission, text: withPin(mission.text, missionPin, MAX_MISSION_TEXT) } }); }
              if ("patch" in edit.mission) {
                const { pin: missionPin, ...changes } = edit.mission.patch.changes;
                if (missionPin !== undefined && changes.text === undefined) throw new ObjectiveStoreError("pin_needs_text");
                return actions.missionPatch({ ...ref, missionId: edit.mission.patch.missionId, patch: changes.text === undefined ? changes : { ...changes, text: withPin(changes.text, missionPin, MAX_MISSION_TEXT) } });
              }
              return actions.missionRemove({ ...ref, missionId: edit.mission.remove });
            }
            if ("add" in edit.criterion) return actions.criterionAdd({ ...ref, criterion: { text: withPin(edit.criterion.add.text, edit.criterion.add.pin, MAX_CRITERION_TEXT) } });
            if ("patch" in edit.criterion) return actions.criterionPatch({ ...ref, criterionId: edit.criterion.patch.criterionId, patch: { text: withPin(edit.criterion.patch.text, edit.criterion.patch.pin, MAX_CRITERION_TEXT) } });
            return actions.criterionRemove({ ...ref, criterionId: edit.criterion.remove });
          })();
          const { objective: updated, ...details } = result;
          const kept = store.find(updated.id);
          const fresh = <T extends { readonly id: string }>(now: readonly T[], then: readonly T[]) => now.find((entry) => !then.some((prior) => prior.id === entry.id));
          const edit = args.edit;
          const stored = !edit || !kept ? undefined
            : "title" in edit ? { title: kept.title }
            : "brief" in edit ? { brief: storedText(kept.note) }
            : "mission" in edit ? ((mission) => mission && { mission: { id: mission.id, text: storedText(mission.text) } })(kept.missions.find((entry) => entry.id === ("add" in edit.mission ? fresh(kept.missions, current.missions)?.id : "patch" in edit.mission ? edit.mission.patch.missionId : undefined)))
            : ((criterion) => criterion && { criterion: { id: criterion.id, text: storedText(criterion.text) } })(kept.criteria.find((entry) => entry.id === ("add" in edit.criterion ? fresh(kept.criteria, current.criteria)?.id : "patch" in edit.criterion ? edit.criterion.patch.criterionId : undefined)));
          const answers = args.answer ? store.storedAnswers(current.id, args.answer.requestId) : null;
          const echo = answers ? { answers: answers.map(({ questionId, selectedOptionIds, text: answered }) => ({ questionId, ...(selectedOptionIds.length ? { selectedOptionIds } : {}), ...(answered ? { text: storedText(answered) } : {}) })) } : stored;
          return text({ ok: true, objectiveId: updated.id, ...details, ...(echo ? { stored: echo } : {}) });
        }
        if (args.remove || args.merge || args.restore) {
          // 정리는 에이전트 Operation 이 한다 — 누가 지웠는지가 사람의 보드에 남아야 한다.
          if (caller?.kind !== "operation") return refuse("operation_caller_required");
          if (!spend(tidyBudget, callerKey(caller), MAX_TIDY_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_TIDY_PER_TURN });
          const actor = (why?: string) => ({ operationId: caller.operationId, title: ctx.host.operations.get(caller.operationId)?.title ?? null, ...(why ? { reason: why } : {}) });
          // 후속으로 태어난 목표면 원본의 배치 표시(생성됨·삭제됨)가 이 목표의 지운 표시에서 나온다 — 바뀐 목표마다 원본을 다시 방송한다.
          const touched = (ids: readonly string[]) => { for (const id of ids) launch.followupTargetChanged(id); };
          if (args.remove) { const removed = store.tidyRemove(args.remove.objectiveIds, actor(args.remove.reason)).map((objective) => objective.id); touched(removed); return text({ ok: true, removed }); }
          if (args.merge) { const target = store.tidyMerge(args.merge.into, args.merge.from, actor(args.merge.reason)); touched(args.merge.from); return text({ ok: true, objectiveId: target.id, merged: args.merge.from, criteria: target.criteria.length }); }
          // 되돌리기도 지우기·합치기처럼 전부 받을 수 있을 때만 바꾼다 — 일부만 되돌린 채 오류로 끝나지 않게.
          const restoreIds = [...new Set(args.restore!)];
          const refusals = restoreIds.flatMap((id) => { const found = store.find(id); return !found ? [{ objectiveId: id, reason: "unknown_objective" }] : !found.removed ? [{ objectiveId: id, reason: "not_removed" }] : []; });
          if (refusals.length) return refuse("tidy_refused", { refusals });
          const restored = restoreIds.map((id) => store.tidyRestore(id).id);
          touched(restored);
          return text({ ok: true, restored });
        }
        if (!args.add) {
          if (args.view === "evidence") {
            if (!args.objectiveId || !args.resultId) return refuse("evidence_target_required");
            scoped(args.objectiveId);
            const { data, metadata } = await store.evidenceRead(args.objectiveId, args.resultId);
            // 비동기 파일 읽기 뒤에도 같은 Theater에 속한 결과인지 확인한다.
            scoped(args.objectiveId);
            const details = { objectiveId: args.objectiveId, resultId: args.resultId, name: metadata.name, mediaType: metadata.mediaType, bytes: metadata.bytes, sha256: metadata.sha256 };
            if (metadata.mediaType === "text/plain") {
              const content = data.toString("utf8"), offset = args.offset ?? 0;
              const slice = content.slice(offset, offset + 16_000);
              return text({ ...details, text: slice, offset, totalCharacters: content.length, nextOffset: offset + slice.length < content.length ? offset + slice.length : null });
            }
            return { ...text(details), content: [...text(details).content, { type: "image", data: data.toString("base64"), mimeType: metadata.mediaType }] };
          }
          if (args.view === "models") return text(await models(args, caller, context.signal));
          if (args.view === "routing") {
            // 판단 한 번은 과금되는 Gateway 호출이다 — 사람의 확인 시트와 사령관만 부른다.
            if (!bound) return refuse("commodore_only", { hint: "The person reviews routing in the Objectives panel." });
            if (!args.objectiveId) return refuse("objective_required");
            const current = scoped(args.objectiveId);
            if (launch.busy(current.id)) return refuse("objective_busy");
            return text(await lineup(current, args.rejudge === true));
          }
          if (args.view === "transcript") {
            if (!bound) return refuse("commodore_only", { hint: "Operations read sessions with console_operation." });
            if (!args.objectiveId) return refuse("objective_required");
            return text(await transcript(scoped(args.objectiveId), args, context.signal));
          }
          return text(read(args, caller));
        }
        const add = args.add;
        const theaterId = args.theaterId ?? theaterOfCaller(caller);
        if (!theaterId) return refuse("theater_required");
        if (caller?.kind === "operation" && !spend(addBudget, callerKey(caller), MAX_ADD_PER_TURN)) return refuse("budget_exceeded", { limit: MAX_ADD_PER_TURN });
        // 그룹은 입력으로 받지 않는다 — 호출 Operation 의 그룹을 그대로 따른다.
        const groupId = caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null;
        const objective = await launch.create({
          theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}),
          // 달성 기준 문장은 검증된 순서 그대로 기본 요구사항으로 함께 저장된다 — 한 건이라도 맞지 않으면 위 스키마에서
          // 거절되므로 목표가 기준 없이 먼저 생기지 않는다. AI 생성 표시는 목표의 addedBy 로 남는다.
          ...(add.criteria?.length ? { criteria: add.criteria.map((criterion) => typeof criterion === "string" ? criterion : withPin(criterion.text, criterion.pin, MAX_CRITERION_TEXT)) } : {}),
          ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : caller?.kind === "commodore" ? { addedBy: { ...caller, ...(args.why ? { why: args.why } : {}) } } : {}),
        }, { language: language(caller), ...(actorOf(caller, args.why) ? { actor: actorOf(caller, args.why)! } : {}) });
        const kept = store.find(objective.id) ?? objective;
        return text({ ok: true, objectiveId: objective.id, stored: { title: kept.title, ...(kept.note ? { note: storedText(kept.note) } : {}), ...(kept.criteria.length ? { criteria: kept.criteria.map((criterion) => storedText(criterion.text)) } : {}) } });
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code, error.details ?? {});
        return refuse("objectives_failed");
      }
    },
  };

  /**
   * 사령관의 구성원 모델 선택 — 사람의 모델 칩과 같은 memberPatch 경로다(띄우기 전이면 선택만, 띄웠으면 #1417 의 지금·턴 뒤 전환).
   * 고른 값은 카탈로그에 있는 모델과 그 모델의 강도여야 하고, 카탈로그를 읽지 못하면 추측으로 통과시키지 않는다.
   */
  async function memberLaunch(actions: ReturnType<typeof createObjectiveActions>, objective: Objective, input: NonNullable<Args["member"]>, signal: AbortSignal | undefined) {
    if (!objective.members.some((member) => member.id === input.memberId)) throw new ObjectiveStoreError("unknown_member");
    if (input.launch) {
      const catalog = await loadCatalog(signal);
      if (!catalog) throw new ObjectiveStoreError("catalog_unavailable");
      const row = catalog.find((entry) => entry.model === input.launch!.model);
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

  async function models(args: Args, caller: BoardCaller | undefined, signal: AbortSignal | undefined) {
    const [catalog, quota] = await Promise.all([loadCatalog(signal), loadQuota(signal)]);
    if (!catalog) throw new ObjectiveStoreError("catalog_unavailable");
    const theaterId = args.theaterId ?? theaterOfCaller(caller);
    // 바꾸지 못한 턴 뒤 전환 — 그 모델로 다시 고르기 전에 볼 사유다.
    const failedSwitches = theaterId ? store.list(theaterId).filter((objective) => !objective.done && !objective.removed).flatMap((objective) => objective.members.flatMap((member) => member.next?.failed
      ? [{ objectiveId: objective.id, memberId: member.id, role: member.role, model: member.next.model, ...(member.next.effort ? { effort: member.next.effort } : {}), failed: member.next.failed }]
      : [])) : [];
    return { models: catalog, quota, failedSwitches };
  }

  /** 목표 세션의 전사 — 지휘관 또는 구성원. Theater 경계는 호출 전에 scoped 가 지켰고, 소유(이 플러그인이 띄운 세션)는 호스트가 지킨다. */
  async function transcript(objective: Objective, args: Args, signal: AbortSignal | undefined) {
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

  function read(args: Args, caller: BoardCaller | undefined) {
    if (args.view === "objective" || (args.objectiveId && !args.view)) {
      const objective = args.objectiveId ? scoped(args.objectiveId) : null;
      if (!objective) throw new ObjectiveStoreError("unknown_objective");
      return { objective: { ...objectiveView(objective), decisionRequest: objective.decisionRequest } };
    }
    const theaterId = args.theaterId ?? theaterOfCaller(caller);
    if (!theaterId) throw new ObjectiveStoreError("theater_required");
    if (args.view === "groups") { const objectives = store.list(theaterId); return { theaterId, groups: (ctx.host.operations.groups?.list(theaterId) ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color, open: objectives.filter((objective) => !objective.done && !objective.removed && objective.groupId === group.id).length })) }; }
    const page = <T,>(rows: readonly T[]) => {
      const offset = args.offset ?? 0, limit = args.limit ?? 50;
      return { theaterId, total: rows.length, offset, nextOffset: offset + limit < rows.length ? offset + limit : null, objectives: rows.slice(offset, offset + limit) };
    };
    const board = store.list(theaterId).filter((objective) => !objective.removed && (!args.groupId || objective.groupId === args.groupId));
    if (args.view === "inbox") {
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
    if (args.view === "fleet") return page(board.filter((objective) => !objective.done).flatMap((objective) => {
      const state = sessions(objective);
      const active = [state.commander, ...state.members].some((session) => ["running", "background", "awaiting"].includes(session.state));
      return objective.commenced || active ? [{ ...rowView(objective), planning: objective.planning, boardUpdatedAt: objective.boardUpdatedAt, sessions: state }] : [];
    }));
    if (args.view === "history") return page(board.filter((objective) => objective.done || objective.handoff || objective.extensions.length || (objective.actionCounts?.["hand-off"] ?? 0) > 0)
      .sort((a, b) => (b.boardUpdatedAt ?? b.createdAt) - (a.boardUpdatedAt ?? a.createdAt)).map(historyView));
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
    // 부른 세션이 목록에 목표로 서 있으면 그 줄을 self 로 가리킨다.
    const self = caller?.kind === "operation" ? caller.operationId : null;
    return { theaterId, today, objectives: objectives.map((objective) => (objective.id === self ? { ...rowView(objective), self: true } : rowView(objective))) };
  }

  return [tool];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** 카탈로그 묶음의 공급자 — native 는 Claude, gateway:<공급자>; 없으면 모델 id 의 접두. 한도 요약의 키와 같다. */
const providerOf = (groupId: string, model: string): string | null =>
  groupId === "native" ? "claude" : groupId.startsWith("gateway:") ? groupId.slice("gateway:".length) || null : !model.includes("--") ? "claude" : model.split("--", 1)[0] || null;
