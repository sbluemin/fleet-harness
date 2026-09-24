import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import { createLaunchService, type LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_EVIDENCE, MAX_RECORD_LINE, MAX_RECORD_LINES, MAX_TITLE, coordinatorMode, latestRecord, recordLines, stepReady, type ObjectiveItem, type ObjectiveStep } from "./types.js";

/**
 * `console_objectives` — 한 도구. 읽기(view)는 게이트를 지난 누구나, 쓰기는 지휘관만이다: 목표가 곧 지휘관 Operation 이므로
 * 호출한 Operation 이 그 목표 자신일 때만 단계 완료·단계 추가·계획·기준 충족을 쓴다. 단계 담당은 쓰기가 없다.
 * 목표 완료·메모는 사람만 — 도구에 없다. 검토 대기는 쓰지 않는다: 모든 임무와 기준이 끝나면 저절로 된다.
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
  add: z.object({ groupId: ids.nullable().optional(), title: z.string().trim().min(1).max(MAX_TITLE), note: z.string().max(20_000).optional(), steps: z.array(z.string().trim().min(1).max(200)).max(40).optional(), after: z.array(z.array(z.number().int().min(0))).optional(), important: z.boolean().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().optional(),
  step: z.object({ itemId: ids, add: z.string().trim().min(1).max(200).optional(), delegate: z.boolean().optional(), after: z.array(z.number().int().min(0)).max(40).optional(), index: z.number().int().min(0).optional(), stepId: ids.optional(), doneIndex: z.number().int().min(0).optional(), doneStepId: ids.optional(), summary: z.array(z.string().max(2000)).max(20).optional() }).strict().optional(),
  criterion: z.object({ itemId: ids, n: z.number().int().min(1), met: z.boolean(), evidence: z.string().trim().max(MAX_EVIDENCE).optional() }).strict().optional(),
  plan: z.object({ itemId: ids, steps: z.array(z.object({ text: z.string().trim().min(1).max(200), after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).optional(), assign: z.enum(["self", "route"]).optional() })).min(1).max(40), criteria: z.array(z.string().trim().min(1).max(MAX_CRITERION_TEXT)).max(MAX_CRITERIA).optional() }).strict().optional(),
}).strict();
type Args = z.output<typeof argsSchema>;
const WRITE_KEYS = ["add", "step", "plan", "criterion"] as const;

export function createObjectiveConsoleTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService = createLaunchService(ctx, store)): readonly PluginMcpTool[] {
  const addBudget = new Map<string, { at: number; count: number }>();
  const theaterOfCaller = (caller: ConsoleCaller | undefined): string | null => (caller?.kind === "operation" ? ctx.host.operations.get(caller.operationId)?.theaterId ?? null : null);
  const languageOf = (caller: ConsoleCaller | undefined): "en" | "ko" => {
    if (caller?.kind !== "operation") return "en";
    const flag = ctx.host.operations.get(caller.operationId)?.payload.consoleUse as { language?: unknown } | undefined;
    return flag?.language === "ko" ? "ko" : "en";
  };
  const isCoordinator = (item: ObjectiveItem, caller: ConsoleCaller | undefined) => caller?.kind === "operation" && item.id === caller.operationId;
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
    commander: { ...observe(item.id), session: item.commander.sessionName },
    mode: coordinatorMode(item.steps),
    steps: item.steps.map((step, index) => ({
      index, stepId: step.id, text: step.text, done: step.done,
      after: step.after.map((id) => item.steps.findIndex((candidate) => candidate.id === id)).filter((value) => value >= 0),
      why: step.why,
      ...(step.unplaced ? { unplaced: true } : {}),
      ready: !step.done && stepReady(item.steps, step),
      // 다음 단계가 받는 것 — 가장 최근 기록과 기록 수. 앞선 기록은 사람이 화면에서 읽는다.
      record: ((latest) => (latest ? { lines: latest.lines, kind: latest.kind, at: latest.at ? new Date(latest.at).toISOString() : null } : null))(latestRecord(step)),
      records: step.records.length,
      assignee: step.operationId ? { ...observe(step.operationId), session: step.sessionName } : null,
    })),
  });
  const itemView = (item: ObjectiveItem) => ({
    id: item.id, theaterId: item.theaterId, groupId: item.groupId, title: item.title, note: item.note,
    // 메모에 붙인 이미지 — 이미지 자체는 싣지 않고 이 기계의 절대 경로만. 필요할 때 Read 로 연다(브라우저에는 이 경로가 가지 않는다).
    attachments: (item.attachments ?? []).map((attachment) => ({ n: attachment.n, name: attachment.name, type: attachment.type, bytes: attachment.bytes, ...(attachment.width ? { width: attachment.width, height: attachment.height } : {}), path: store.attachmentPath(item, attachment) })),
    important: item.important, dueDate: item.dueDate, today: item.today,
    // 달성 기준 — n 은 1부터, criterion 쓰기에서 기준을 가리키는 번호. met 은 지휘관이 충족으로 표시한 근거(없으면 미충족).
    criteria: item.criteria.map((criterion, index) => ({ n: index + 1, id: criterion.id, text: criterion.text, by: criterion.by, met: criterion.met ?? null })),
    done: !!item.done, awaitingReview: item.awaitingReview, addedBy: item.addedBy, graph: graph(item),
  });
  const rowView = (item: ObjectiveItem) => ({ id: item.id, groupId: item.groupId, title: item.title, done: !!item.done, awaitingReview: item.awaitingReview, important: item.important, dueDate: item.dueDate, today: item.today, steps: `${item.steps.filter((step) => step.done).length}/${item.steps.length}`, mode: coordinatorMode(item.steps), addedBy: item.addedBy?.operationId ?? null });

  const tool: PluginMcpTool = {
    name: "console_objectives",
    description: "The Objectives board of a Theater. Every agent Operation of the Theater is an objective — the objective is its Commander Operation (the objective id is that Operation id), so an Operation created anywhere in the Console appears here, and creating an objective (add) creates its Commander Operation dormant until the person presses Plan or Commence. An objective is carried out by missions (the tool calls them steps) that form a lineup — a dependency graph linked by after, where a mission is ready when all of its prerequisites are done. The Commander may delegate a mission to an assignee session: a named CLI session (<Commander session>-mission-<n>, n = index + 1) that talks with the Commander through Claude Code cross-session messages (SendMessage / ListAgents). This tool only reads and updates the board. Missions are always listed in lineup order (earlier dependency columns first); any change to the missions or their dependencies can reorder them and shift indexes, so prefer stepId when you write, and an assignee session keeps the number it was launched with. Read with view mine (the calling Operation's own objective and role) | groups | items (filter today|due|all|agent) | item (missions, dependencies, readiness, assignee sessions, each mission's latest record and record count, the person's brief (note) and its attachments, and the success criteria — each with n, text, who wrote it and met: the evidence you gave, or null). attachments are images the person attached to the brief ('image n' in the brief means n): each path is an absolute file on this machine — open it with Read when you need to see it, and pass the path (not the image) to an assignee in SendMessage. Write one of: add (a new objective with optional missions; its dormant Commander Operation is created with it); plan (replace the open undelegated missions with steps + dependencies + why + assign: self for missions the Commander will carry out itself, route for missions it intends to delegate; when the objective has no success criteria you may propose them with criteria: [text] — the person writes them otherwise; done and delegated missions, and missions the person added that are still unplaced, are kept — refer to them by stepId; Commander only); step with delegate: true and index or stepId (launch that mission's assignee session now — it starts with no prompt and knows nothing, so instruct it with SendMessage giving the full context: objective, exact mission text, latest records of prerequisites, constraints from the person's brief, paths, what not to touch, and the report you expect; it reports back by SendMessage; Commander only); step with add (append a mission that became necessary; Commander only); step with index or stepId and after (the indexes of its prerequisites, [] = it can start now — sets the dependencies of one open mission; Commander only); step with doneIndex or doneStepId and summary (mark one mission done and leave its record — summary is 1–3 lines, conclusion first: line 1 is the outcome in one sentence, the rest are what backs it or what is left; each line at most 160 characters, no prose paragraphs; the person reads every record of the mission in time order and the next mission receives the latest one; marking a mission that is already done again, after you went back to rework it, adds another record; Commander only); criterion with n, met and evidence (mark one success criterion met with one line of evidence, or met: false to withdraw it; Commander only). There is no write for review: the objective goes to the person for review by itself once every mission is done and every success criterion is marked met — the person then completes it. When the last mission is done you receive a criteria check — go through each criterion yourself, doubt your first answer, add missions for any that do not hold yet, and mark each one that holds with criterion. Adding a mission, reopening one, or the person's change line withdraws every met mark, so check the criteria again when the work is done. Missions assigned self are the Commander's own work; whether to delegate a mission is the Commander's call at the moment it reaches that mission. Missions the person added are unplaced (unplaced: true, never ready) — they only added the mission; placing it is your call: before you continue, give each one its prerequisites with step after (and rewire any open mission that should now wait for it); plan keeps them, so do not repeat them in a plan. A plan or criterion write is refused with board_changed when the person changed the objective since you last read it — read it again, then continue. While you work, the person may add or edit missions, the brief and the criteria; you then receive one line saying the objective changed — read it again and continue from what it now says. Completing an objective and writing the brief are the person's acts on the screen and have no tool here.",
    inputSchema: z.toJSONSchema(argsSchema),
    surface: {
      panelId: "objectives",
      describe: (raw) => {
        const parsed = argsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const args = parsed.data;
        const itemId = args.itemId ?? args.step?.itemId ?? args.plan?.itemId ?? args.criterion?.itemId;
        const found = typeof itemId === "string" ? store.find(itemId) : null;
        const theaterId = args.theaterId ?? found?.theaterId ?? "";
        const short = (value: string) => (value.length > 32 ? `${value.slice(0, 31)}…` : value);
        if (args.add) return { theaterId, summary: `목표 추가 「${short(args.add.title)}」`, view: "items", gesture: "create" };
        if (args.plan) return { theaterId, summary: `임무 ${args.plan.steps.length}개 구상`, view: "item", gesture: "create", ...(found ? { path: found.id } : {}) };
        if (args.criterion) return { theaterId, summary: args.criterion.met ? `달성 기준 ${args.criterion.n} 충족` : `달성 기준 ${args.criterion.n} 거둠`, view: "item", gesture: "press", ...(found ? { path: found.id } : {}) };
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
          const item = await launch.create({
            theaterId, groupId, title: add.title, ...(add.note ? { note: add.note } : {}), ...(add.important !== undefined ? { important: add.important } : {}), ...(add.dueDate ? { dueDate: add.dueDate } : {}),
            steps: (add.steps ?? []).map((stepText, index) => ({ text: stepText, after: add.after?.[index] ?? [] })),
            ...(caller?.kind === "operation" ? { addedBy: caller.operationId } : {}),
          }, { language });
          return text({ ok: true, item: itemView(item) });
        }
        const targetId = (args[key] as { itemId: string }).itemId;
        const item = store.find(targetId);
        if (!item) return refuse("unknown_item");
        // 이 아래는 지휘관만 — 슬롯이 곧 권한이다.
        if (!isCoordinator(item, caller)) return refuse("not_item_operation", { hint: "Only the objective's own Commander Operation may do this." });
        if (key === "step") {
          const stepArgs = args.step!;
          if (stepArgs.add) return text({ ok: true, item: itemView(launch.stepAdded(item.id, { text: stepArgs.add })) });
          const target = stepOf(item, { ...stepArgs, stepIndex: stepArgs.index });
          if (!target) return refuse("unknown_step");
          if (stepArgs.after) {
            // 자리 잡기 — 선행을 index 로 받아 id 로 바꾼다. 미분류가 풀리고, 순환은 스토어가 거절한다.
            if (target.done) return refuse("step_done");
            const prerequisites = stepArgs.after.map((index) => item.steps[index]?.id);
            if (prerequisites.some((id) => !id)) return refuse("unknown_step");
            const next = launch.stepPatched(item.id, target.id, { after: prerequisites.filter((id): id is string => !!id && id !== target.id) });
            return text({ ok: true, item: itemView(next) });
          }
          if (stepArgs.delegate) {
            // 위임 — 이 단계의 담당 세션을 지금 띄운다. 이름을 돌려주면 지휘관이 SendMessage 로 맥락을 담아 일을 시킨다.
            const delegated = await launch.delegateStep(item.id, target.id, { language });
            return text({ ok: true, session: delegated.session, operationId: delegated.operationId, item: itemView(delegated.item) });
          }
          // 완료는 기록 한 건과 함께다 — 결론 먼저 1–3줄. 산문이면 거절해 지휘관이 줄여 다시 쓰게 한다.
          const lines = recordLines(stepArgs.summary ?? []);
          if (!lines) return refuse("summary_format", { hint: `Pass summary as 1–${MAX_RECORD_LINES} lines, conclusion first, each at most ${MAX_RECORD_LINE} characters. Rewrite it shorter; do not pack a paragraph into a line.` });
          const doneItem = store.stepDone(item.id, target.id, lines);
          // 마지막 임무를 마쳤다 — 검토 대기로 넘어가기 전에 달성 기준을 스스로 다시 따지게 한다. 첫 판단을 의심하라고 되묻는 것이 이 기능의 핵심이다.
          const next = doneItem.steps.every((step) => step.done) ? criteriaCheckPrompt(doneItem) : undefined;
          return text({ ok: true, ...(next ? { next } : {}), item: itemView(doneItem) });
        }
        // 지휘관이 마지막으로 읽은 뒤 사람이 바꾼 것이 있으면(edited) 그 계획·충족 판단은 옛 보드로 한 것이다 — 사람의 편집을 덮거나 지나치지 않게 거절하고 다시 읽힌다.
        if ((key === "plan" || key === "criterion") && item.edited) return refuse("board_changed", { hint: `The person changed this item since you last read it. Read it again (view item or mine), then ${key === "plan" ? "plan" : "judge the criteria again"}.` });
        if (key === "plan") {
          // 달성 기준은 사람의 것이다 — 비어 있을 때만 지휘관이 제안할 수 있다. 스스로 정한 기준을 스스로 통과시키면 점검의 뜻이 옅어진다.
          const proposed = args.plan!.criteria ?? [];
          if (proposed.length > 0 && item.criteria.length > 0) return refuse("criteria_exist", { hint: "The person already wrote the success criteria. Leave criteria out of the plan; you may only propose them when there are none." });
          let planned = launch.planApplied(item.id, { steps: args.plan!.steps });
          for (const criterion of proposed) planned = store.criterionAdd(item.id, criterion, "commander");
          return text({ ok: true, item: itemView(planned) });
        }
        if (key === "criterion") {
          // 충족은 근거 한 줄과 함께다 — 근거 없는 「충족」은 받지 않는다. 모든 임무와 기준이 끝나면 검토 대기는 저절로 된다.
          const judged = args.criterion!;
          const target = item.criteria[judged.n - 1];
          if (!target) return refuse("unknown_criterion", { criteria: item.criteria.length });
          if (judged.met && !judged.evidence) return refuse("evidence_required", { hint: "Give one line of evidence (mission records, test output, the files you changed) that the criterion holds now." });
          const next = store.criterionMet(item.id, target.id, judged.met ? judged.evidence! : null);
          return text({ ok: true, ...(next.awaitingReview ? { next: "Every mission is done and every criterion is met — the objective is now awaiting the person's review. Stop here; the person completes it." } : {}), item: itemView(next) });
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
      // 담당이면 그 단계, 아니면 이 Operation 자신이 목표다(목표 = 지휘관 Operation).
      const assigned = store.findAssignee(caller.operationId);
      if (assigned) {
        const index = assigned.item.steps.findIndex((step) => step.id === assigned.stepId);
        return { role: "step", itemId: assigned.item.id, stepIndex: index, stepId: assigned.stepId, item: itemView(assigned.item) };
      }
      const own = store.find(caller.operationId);
      if (!own) throw new ObjectiveStoreError("not_item_operation");
      return { role: "commander", itemId: own.id, item: itemView(store.setEdited(own.id, null)) };
    }
    if (args.view === "item" || (args.itemId && !args.view)) {
      const item = args.itemId ? store.find(args.itemId) : null;
      if (!item) throw new ObjectiveStoreError("unknown_item");
      // 지휘관이 제 항목을 읽었다 — 그 뒤의 「시작」은 사람의 변경을 다시 알리지 않는다.
      return { item: itemView(isCoordinator(item, caller) ? store.setEdited(item.id, null) : item) };
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

/**
 * 달성 점검 — 마지막 임무를 마친 지휘관에게 도구 응답으로 되묻는 문장. 달성 기준이 있으면 기준마다 스스로 다시 따지고 근거와 함께
 * 충족으로 표시하게 한다 — 모든 기준이 충족되면 검토 대기는 저절로 된다. 기준이 없으면 이미 검토 대기다.
 */
export function criteriaCheckPrompt(item: ObjectiveItem): string {
  const open = item.criteria.map((criterion, index) => ({ criterion, n: index + 1 })).filter(({ criterion }) => !criterion.met);
  if (open.length === 0) return "Every mission is done — the objective is now awaiting the person's review. Stop here; the person completes it.";
  const list = open.map(({ criterion, n }) => `${n}. ${criterion.text}`).join("\n");
  return `Every mission is done. Before the objective goes to the person, run the criteria check — read each success criterion below again and decide on your own evidence (mission records, test output, the files you changed) whether it truly holds now. Doubt your first answer. If one does not hold, add the mission it needs and carry on. For each one that holds, mark it with criterion: { n, met: true, evidence } — once every criterion is met, the objective goes to review by itself.\n\nCriteria not yet met:\n${list}`;
}
