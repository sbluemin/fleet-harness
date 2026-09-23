import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_EVIDENCE, MAX_RECORD_LINE, MAX_RECORD_LINES, coordinatorMode, latestRecord, recordLines, stepReady, type SlotBy, type ObjectiveItem, type ObjectiveStep } from "./types.js";

/**
 * `console_objectives` — 한 도구. 읽기(view)는 게이트를 지난 누구나, 쓰기는 슬롯이 권한이다: 단계 완료·단계 추가·계획은
 * 그 목표의 지휘관(목표 슬롯의 Operation)만. 단계 담당은 도구가 없다. 목표 완료·메모·Operation 연결은 사람만 — 도구에 없다.
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
  step: z.object({ itemId: ids, add: z.string().trim().min(1).max(200).optional(), delegate: z.boolean().optional(), after: z.array(z.number().int().min(0)).max(40).optional(), index: z.number().int().min(0).optional(), stepId: ids.optional(), doneIndex: z.number().int().min(0).optional(), doneStepId: ids.optional(), summary: z.array(z.string().max(2000)).max(20).optional(),
    // 옛 인자 — 이 판 이전에 뜬 지휘관의 도구 설명에 있던 이름. 줄바꿈으로 나눠 summary 와 같은 검사를 거친다.
    result: z.string().max(4000).optional() }).strict().optional(),
  review: z.object({ itemId: ids, summary: z.string().trim().min(1).max(2000), criteria: z.array(z.object({ n: z.number().int().min(1), met: z.boolean(), evidence: z.string().max(MAX_EVIDENCE).optional() }).strict()).max(MAX_CRITERIA).optional() }).strict().optional(),
  plan: z.object({ itemId: ids, steps: z.array(z.object({ text: z.string().trim().min(1).max(200), after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).optional(), assign: z.enum(["self", "route"]).optional() })).min(1).max(40), criteria: z.array(z.string().trim().min(1).max(MAX_CRITERION_TEXT)).max(MAX_CRITERIA).optional() }).strict().optional(),
}).strict();
type Args = z.output<typeof argsSchema>;
const WRITE_KEYS = ["add", "step", "plan", "review"] as const;

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  const addBudget = new Map<string, { at: number; count: number }>();
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const callerTitle = (caller: ConsoleCaller | undefined): string => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.title ?? caller.operationId : caller?.kind === "plugin" ? caller.pluginId : "");
  const slotBy = (caller: ConsoleCaller | undefined): SlotBy => (caller?.kind === "operation" ? { operationId: caller.operationId } : "human");
  const languageOf = (caller: ConsoleCaller | undefined): "en" | "ko" => {
    if (caller?.kind !== "operation") return "en";
    const flag = ctx.host.operations.get(caller.operationId)?.payload.consoleUse as { language?: unknown } | undefined;
    return flag?.language === "ko" ? "ko" : "en";
  };
  const isCoordinator = (item: ObjectiveItem, caller: ConsoleCaller | undefined) => caller?.kind === "operation" && item.slot?.operationId === caller.operationId;
  const stepOf = (item: ObjectiveItem, ref: { stepId?: string; stepIndex?: number; doneIndex?: number; doneStepId?: string }): ObjectiveStep | null => {
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
  const graph = (item: ObjectiveItem) => ({
    commander: item.slot ? { ...observe(item.slot.operationId), session: item.slot.sessionName ?? null, mode: coordinatorMode(item) } : null,
    mode: coordinatorMode(item),
    steps: item.steps.map((step, index) => ({
      index, stepId: step.id, text: step.text, done: step.done,
      after: step.after.map((id) => item.steps.findIndex((candidate) => candidate.id === id)).filter((value) => value >= 0),
      why: step.why ?? {},
      ...(step.unplaced ? { unplaced: true } : {}),
      ready: !step.done && stepReady(item, step),
      // 다음 단계가 받는 것 — 가장 최근 기록과 기록 수. 앞선 기록은 사람이 화면에서 읽는다.
      record: ((latest) => (latest ? { lines: latest.lines, kind: latest.kind, at: latest.at ? new Date(latest.at).toISOString() : null } : null))(latestRecord(step)),
      records: step.records?.length ?? 0,
      assignee: step.slot ? { ...observe(step.slot.operationId), session: step.slot.sessionName ?? null } : null,
    })),
  });
  const itemView = (item: ObjectiveItem) => ({
    id: item.id, theaterId: item.theaterId, groupId: item.groupId, title: item.title, note: item.note,
    // 메모에 붙인 이미지 — 이미지 자체는 싣지 않고 이 기계의 절대 경로만. 필요할 때 Read 로 연다(브라우저에는 이 경로가 가지 않는다).
    attachments: (item.attachments ?? []).map((attachment) => ({ n: attachment.n, name: attachment.name, type: attachment.type, bytes: attachment.bytes, ...(attachment.width ? { width: attachment.width, height: attachment.height } : {}), path: store.attachmentPath(item, attachment) })),
    important: item.important, dueDate: item.dueDate, today: item.today,
    // 달성 기준 — n 은 1부터, 달성 보고에서 기준을 가리키는 번호. evidence 는 받아들여진 달성 보고의 근거(검토 대기 동안만 있다).
    criteria: (item.criteria ?? []).map((criterion, index) => ({ n: index + 1, id: criterion.id, text: criterion.text, by: criterion.by, ...(evidenceOf(item, criterion.id) ? { evidence: evidenceOf(item, criterion.id) } : {}) })),
    done: !!item.done, review: item.review ?? null, author: item.author, updatedAt: item.updatedAt, graph: graph(item),
  });
  const evidenceOf = (item: ObjectiveItem, criterionId: string): string | undefined => item.review?.criteria?.find((entry) => entry.id === criterionId)?.evidence;
  const rowView = (item: ObjectiveItem) => ({ id: item.id, groupId: item.groupId, title: item.title, done: !!item.done, important: item.important, dueDate: item.dueDate, today: item.today, steps: `${item.steps.filter((step) => step.done).length}/${item.steps.length}`, mode: coordinatorMode(item), coordinator: item.slot?.operationId ?? null, author: item.author.kind });

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "The Objectives board of a Theater. An objective is an intent the person wants achieved; it is carried out by missions (the tool calls them steps) that form a lineup — a dependency graph linked by after, where a mission is ready when all of its prerequisites are done. Each objective has one Commander Operation, plus an assignee session for each mission the Commander chooses to delegate. The Commander is a named CLI session; assignees are named CLI sessions too (objective-<objective id prefix>-mission-<n>, n = index + 1) and talk with the Commander through Claude Code cross-session messages (SendMessage / ListAgents). This tool only reads and updates the board. Missions are always listed in lineup order (earlier dependency columns first); any change to the missions or their dependencies can reorder them and shift indexes, so prefer stepId when you write, and an assignee session keeps the number it was launched with. Read with view mine (the calling Operation's own objective and role) | groups | items (filter today|due|all|agent) | item (missions, dependencies, readiness, assignee sessions, each mission's latest record and record count, the person's brief (note) and its attachments, and the success criteria — each with n, text and who wrote it). attachments are images the person attached to the brief ('image n' in the brief means n): each path is an absolute file on this machine — open it with Read when you need to see it, and pass the path (not the image) to an assignee in SendMessage. Write one of: add (a new objective with optional missions); plan (replace the open unassigned missions with steps + dependencies + why + assign: self for missions the Commander will carry out itself, route for missions it intends to delegate; when the objective has no success criteria you may propose them with criteria: [text] — the person writes them otherwise; done and assigned missions, and missions the person added that are still unplaced, are kept — refer to them by stepId; Commander only); step with delegate: true and index or stepId (launch that mission's assignee session now — it starts with no prompt and knows nothing, so instruct it with SendMessage giving the full context: objective, exact mission text, latest records of prerequisites, constraints from the person's brief, paths, what not to touch, and the report you expect; it reports back by SendMessage; Commander only); step with add (append a mission that became necessary; Commander only); step with index or stepId and after (the indexes of its prerequisites, [] = it can start now — sets the dependencies of one open mission; Commander only); step with doneIndex or doneStepId and summary (mark one mission done and leave its record — summary is 1–3 lines, conclusion first: line 1 is the outcome in one sentence, the rest are what backs it or what is left; each line at most 160 characters, no prose paragraphs; the person reads every record of the mission in time order and the next mission receives the latest one; marking a mission that is already done again, after you went back to rework it, adds another record; Commander only); review with summary (every mission is done — hand the objective to the person for review; the person completes it; Commander only). Success criteria sit below the missions: when the last mission is done you receive a criteria check — go through each criterion yourself, doubt your first answer, and add missions for any that do not hold yet; review is refused with criteria_unmet until you give criteria: [{ n, met: true, evidence }] for every criterion, each with one line of evidence. Missions assigned self are the Commander's own work; whether to delegate a mission is the Commander's call at the moment it reaches that mission. Missions the person added are unplaced (unplaced: true, never ready) — they only added the mission; placing it is your call: before you continue, give each one its prerequisites with step after (and rewire any open mission that should now wait for it); plan keeps them, so do not repeat them in a plan. A plan is refused with board_changed when the person changed the objective since you last read it — read it again, then plan. While you work, and after you hand the objective for review, the person may add or edit missions and the brief; you then receive one line saying the objective changed — read it again and continue from what it now says (a review is withdrawn when that line arrives; hand it again once the work is done). A review is refused with board_changed when the person changed the objective since you last read it. Completing an objective, writing the brief and linking or unlinking Operations are the person's acts on the screen and have no tool here.",
    inputSchema: z.toJSONSchema(argsSchema),
    surface: {
      panelId: "objectives",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const itemId = args.itemId ?? args.step?.itemId ?? args.plan?.itemId ?? args.review?.itemId;
        const found = typeof itemId === "string" ? store.find(itemId) : null;
        const theaterId = args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `목표 추가 「${short(args.add.title)}」`, view: "items", gesture: "create" };
        if (args.plan) return { theaterId, summary: `임무 ${args.plan.steps.length}개 구상`, view: "item", gesture: "create", ...(found ? { path: found.id } : {}) };
        if (args.review) return { theaterId, summary: "달성 보고", view: "item", gesture: "press", ...(found ? { path: found.id } : {}) };
        if (args.step) return { theaterId, summary: args.step.add ? `임무 추가 「${short(args.step.add)}」` : args.step.delegate ? "임무 위임 — 담당 세션 띄움" : args.step.after ? "임무 선행 정함" : "임무 완료", view: "item", gesture: "press", ...(found ? { path: found.id } : {}) };
        return { theaterId, summary: args.view === "item" ? `목표 봄 「${short(found?.title ?? "")}」` : args.view === "mine" ? "내 목표 봄" : args.view === "groups" ? "그룹 봄" : "목표 목록 봄", view: args.view === "mine" ? "items" : args.view ?? "items", ...(found ? { path: found.id } : {}) };
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
          const groupId = add.groupId === undefined ? (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.groupId ?? null : null) : add.groupId;
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
        // 이 아래는 지휘관만 — 슬롯이 곧 권한이다.
        if (!isCoordinator(item, caller)) return refuse("not_item_operation", { hint: "Only the Operation in this objective's Commander slot may do this." });
        if (key === "step") {
          const stepArgs = args.step!;
          if (stepArgs.add) return text({ ok: true, item: itemView(await launch.stepAdded(item.id, { text: stepArgs.add }, { language })) });
          const target = stepOf(item, { ...stepArgs, stepIndex: stepArgs.index });
          if (!target) return refuse("unknown_step");
          if (stepArgs.after) {
            // 자리 잡기 — 선행을 index 로 받아 id 로 바꾼다. 미분류가 풀리고, 순환은 스토어가 거절한다.
            if (target.done) return refuse("step_done");
            const prerequisites = stepArgs.after.map((index) => item.steps[index]?.id);
            if (prerequisites.some((id) => !id)) return refuse("unknown_step");
            const next = await launch.stepPatched(item.id, target.id, { after: prerequisites.filter((id): id is string => !!id && id !== target.id) }, slotBy(caller), { language });
            return text({ ok: true, item: itemView(next) });
          }
          if (stepArgs.delegate) {
            // 위임 — 이 단계의 담당 세션을 지금 띄운다. 이름을 돌려주면 지휘관이 SendMessage 로 맥락을 담아 일을 시킨다.
            const delegated = await launch.delegateStep(item.id, target.id, { language });
            return text({ ok: true, session: delegated.session, operationId: delegated.operationId, item: itemView(delegated.item) });
          }
          // 완료는 기록 한 건과 함께다 — 결론 먼저 1–3줄. 산문이면 거절해 지휘관이 줄여 다시 쓰게 한다.
          const lines = recordLines(stepArgs.summary ?? stepArgs.result ?? []);
          if (!lines) return refuse("summary_format", { hint: `Pass summary as 1–${MAX_RECORD_LINES} lines, conclusion first, each at most ${MAX_RECORD_LINE} characters. Rewrite it shorter; do not pack a paragraph into a line.` });
          const doneItem = store.stepDone(item.id, target.id, lines, slotBy(caller));
          // 마지막 임무를 마쳤다 — 달성 보고 전에 달성 기준을 스스로 다시 따지게 한다. 첫 판단을 의심하라고 되묻는 것이 이 기능의 핵심이다.
          const next = doneItem.steps.every((step) => step.done) ? criteriaCheckPrompt(doneItem) : undefined;
          return text({ ok: true, ...(next ? { next } : {}), item: itemView(doneItem) });
        }
        // 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것이 있으면(edited) 그 계획·검토 요청은 옛 보드로 한 것이다 — 사람의 편집을 덮거나 지나치지 않게 거절하고 다시 읽힌다.
        if ((key === "plan" || key === "review") && item.edited) return refuse("board_changed", { hint: `The person changed this item since you last read it. Read it again (view item or mine), then ${key === "plan" ? "plan" : "continue from what it now says"}.` });
        if (key === "plan") {
          // 달성 기준은 사람의 것이다 — 비어 있을 때만 지휘관이 제안할 수 있다. 스스로 정한 기준을 스스로 통과시키면 점검의 뜻이 옅어진다.
          const proposed = args.plan!.criteria ?? [];
          if (proposed.length > 0 && (item.criteria?.length ?? 0) > 0) return refuse("criteria_exist", { hint: "The person already wrote the success criteria. Leave criteria out of the plan; you may only propose them when there are none." });
          let planned = await launch.planApplied(item.id, { steps: args.plan!.steps }, slotBy(caller), { language });
          for (const criterion of proposed) planned = store.criterionAdd(item.id, criterion, "commander");
          return text({ ok: true, item: itemView(planned) });
        }
        if (key === "review") {
          // 가승인 — 완료가 아니다. 사람이 검토해 완료를 누른다. 열린 단계가 남았으면 거절한다.
          if (item.steps.some((step) => !step.done)) return refuse("steps_open", { open: item.steps.filter((step) => !step.done).length });
          // 달성 보고 — 달성 기준이 있으면 기준마다 「충족」과 근거 한 줄이 있어야 받는다. 하나라도 빠지면 그 번호를 돌려주고 다시 따지게 한다.
          const criteria = item.criteria ?? [];
          const judged = new Map((args.review!.criteria ?? []).map((entry) => [entry.n, entry]));
          const missing = criteria.map((_, index) => index + 1).filter((n) => { const entry = judged.get(n); return !entry || !entry.met || !entry.evidence?.trim(); });
          if (missing.length > 0) return refuse("criteria_unmet", { missing, hint: `Success criteria ${missing.join(", ")} are not shown to hold. For each, check it against what actually changed; if it does not hold yet, add the mission it needs and carry on. Report again only when every criterion is met, each with one line of evidence.` });
          const evidence = criteria.map((criterion, index) => ({ id: criterion.id, evidence: judged.get(index + 1)!.evidence!.trim() }));
          return text({ ok: true, item: itemView(store.setReview(item.id, { summary: args.review!.summary, ...(evidence.length ? { criteria: evidence } : {}) })) });
        }
        return refuse("invalid_arguments");
      } catch (error) {
        if (error instanceof ObjectiveStoreError) return refuse(error.code);
        return refuse("objectives_failed");
      }
    },
  };

  function callerKey(caller: ConsoleCaller | undefined): string {
    return caller ? (caller.kind === "operation" ? `op:${caller.operationId}` : `plugin:${caller.pluginId}`) : "anonymous";
  }
  function read(args: Args, caller: ConsoleCaller | undefined) {
    // 「내 자리」 — 이 Operation 이 어느 항목의 지휘관인지, 어느 단계의 담당인지. 시스템 지침은 항목을 모르므로 세션이 이걸로 시작한다.
    if (args.view === "mine") {
      if (caller?.kind !== "operation") throw new ObjectiveStoreError("not_item_operation");
      for (const candidate of store.all()) {
        if (candidate.slot?.operationId === caller.operationId) return { role: "commander", itemId: candidate.id, item: itemView(store.setEdited(candidate.id, null)) };
        const index = candidate.steps.findIndex((step) => step.slot?.operationId === caller.operationId);
        if (index >= 0) return { role: "step", itemId: candidate.id, stepIndex: index, stepId: candidate.steps[index]!.id, item: itemView(candidate) };
      }
      throw new ObjectiveStoreError("not_item_operation");
    }
    if (args.view === "item" || (args.itemId && !args.view)) {
      const item = args.itemId ? store.find(args.itemId) : null;
      if (!item) throw new ObjectiveStoreError("unknown_item");
      // 지휘관이 제 항목을 읽었다 — 그 뒤의 「시작」은 사람의 변경을 다시 알리지 않는다.
      return { item: itemView(isCoordinator(item, caller) ? store.setEdited(item.id, null) : item) };
    }
    const theaterId = args.theaterId ?? theaterOfCaller(caller);
    if (!theaterId) throw new ObjectiveStoreError("theater_required");
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

/**
 * 달성 점검 — 마지막 임무를 마친 지휘관에게 도구 응답으로 되묻는 문장. 달성 기준이 있으면 기준마다 스스로 다시 따지고 근거를 대게 한다.
 * 기준이 없으면 지금처럼 달성 보고로 넘기면 된다고만 말한다.
 */
export function criteriaCheckPrompt(item: ObjectiveItem): string {
  const criteria = item.criteria ?? [];
  if (criteria.length === 0) return "Every mission is done. When you have checked the work against the brief, report it with review (summary) so the person can review it.";
  const list = criteria.map((criterion, index) => `${index + 1}. ${criterion.text}`).join("\n");
  return `Every mission is done. Before you report, run the criteria check — read the success criteria again and, for each one, decide on your own evidence (mission records, test output, the files you changed) whether it truly holds now. Doubt your first answer. If any does not hold, add the mission it needs and carry on. Only when every criterion holds, report with review, giving criteria: [{ n, met: true, evidence }] for each.\n\nSuccess criteria:\n${list}`;
}
