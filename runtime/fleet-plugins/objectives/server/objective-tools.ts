import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import type { LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_EVIDENCE, MAX_RECORD_LINE, MAX_RECORD_LINES, assignModeOf, recordLines, type ObjectiveItem, type ObjectiveStep } from "./types.js";
import { createBoardViews, refuse, roleIn, text } from "./views.js";

/**
 * `fleet-objectives` — 목표를 수행하는 세션(지휘관·담당)의 작업 도구. Console Use 토글과 무관하게 모든 Operation 에 실리므로
 * 권한은 호스트가 넘긴 호출자(`context.caller`)로 여기서 가른다: 읽기는 그 목표의 참여자(지휘관·담당)만, 쓰기는 지휘관만.
 * 담당은 읽기만 한다 — 결과는 지휘관에게 SendMessage 로 보고하고 지휘관이 기록한다. 화면 제스처는 없다(Console Use 의 것).
 * 구상 중(「구상」을 누른 뒤 「개시」 전)에는 편성만 쓴다 — 임무 수행 쓰기(완료·위임)는 거절한다.
 */

const ids = z.string().min(1).max(128);
const mission = { itemId: ids, stepId: ids.optional(), index: z.number().int().min(0).optional() };
const assign = z.enum(["self", "route"]);

const ASSIGNEE_ACCESS = "The assignee can only read this objective (fleet-objectives mine/read). It reports to you by SendMessage; you record its result with complete_mission.";
const PLANNING_ONLY = "This objective is being planned, not carried out: lay the lineup out on the board (plan, add_mission, place_mission) and stop. Missions are done and delegated after the person presses Commence.";

export function createObjectiveMcpTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService): readonly PluginMcpTool[] {
  const { itemView, languageOf } = createBoardViews(ctx, store);
  const find = (itemId: string): ObjectiveItem => {
    const item = store.find(itemId);
    if (!item) throw new ObjectiveStoreError("unknown_item");
    return item;
  };
  const missionOf = (item: ObjectiveItem, ref: { stepId?: string; index?: number }): ObjectiveStep => {
    const found = ref.stepId ? item.steps.find((step) => step.id === ref.stepId) : ref.index !== undefined ? item.steps[ref.index] : undefined;
    if (!found) throw new ObjectiveStoreError("unknown_step");
    return found;
  };
  /** 지휘관이 제 목표를 읽었다 — 그 뒤의 계획·충족 판단은 사람의 변경을 다시 막지 않는다. */
  const readView = (item: ObjectiveItem, caller: ConsoleCaller | undefined) => itemView(roleIn(item, caller)?.role === "commander" ? store.setEdited(item.id, null) : item);

  const tool = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.output<S>, caller: ConsoleCaller | undefined) => Promise<unknown> | unknown): PluginMcpTool => ({
    name, description, inputSchema: z.toJSONSchema(schema),
    execute: async (raw, context) => {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      try { return await run(parsed.data, context.caller); }
      catch (error) { return refuse(error instanceof ObjectiveStoreError ? error.code : "objectives_failed"); }
    },
  });
  /** 쓰기의 문 — 지휘관만. 담당에게는 읽기 전용임을, 밖의 Operation 에게는 참여자가 아님을 말한다. */
  const commanderTool = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.output<S>, item: ObjectiveItem, caller: ConsoleCaller) => Promise<unknown> | unknown) =>
    tool(name, `Commander only. ${description}`, schema, (args, caller) => {
      const item = find((args as { itemId: string }).itemId);
      const role = roleIn(item, caller);
      if (role?.role === "assignee") return refuse("not_commander", { hint: "You are an assignee: you can read this objective but not change it. Report your result to the Commander by SendMessage." });
      if (!role) return refuse("not_participant");
      return run(args, item, caller!);
    });

  return [
    tool("mine", "Your objective and your role in it: commander or assignee. Start here. An objective is carried out by missions in a dependency lineup (after = prerequisite indexes; a mission is ready when they are done). The Commander plans, delegates, records results and marks the success criteria; assignees can only read and report to the Commander by SendMessage. planning: true means the person asked for a plan only — lay the lineup out on the board and stop. When the person edits the objective while you work, you receive one line saying it changed — read it again and continue from what it now says.", z.object({}).strict(), (_args, caller) => {
      if (caller?.kind !== "operation") return refuse("not_participant");
      const assigned = store.findAssignee(caller.operationId);
      if (assigned) {
        const stepIndex = assigned.item.steps.findIndex((step) => step.id === assigned.stepId);
        return text({ role: "assignee", access: "read-only", itemId: assigned.item.id, stepIndex, stepId: assigned.stepId, item: itemView(assigned.item) });
      }
      const own = store.find(caller.operationId);
      if (!own) return refuse("not_participant");
      return text({ role: "commander", itemId: own.id, item: readView(own, caller) });
    }),
    tool("read", "Read an objective you take part in: the person's brief (note) and image attachments ('image n' in the brief is attachment n; absolute paths — open with Read, and pass the path, not the image, to an assignee), missions with dependencies, assignment, readiness, assignee sessions and each mission's latest record, and the success criteria with met: your evidence or null. Indexes follow lineup order and shift when missions change — prefer stepId.", z.object({ itemId: ids }).strict(), ({ itemId }, caller) => {
      const item = find(itemId);
      if (!roleIn(item, caller)) return refuse("not_participant");
      return text({ item: readView(item, caller) });
    }),
    commanderTool("plan", "Replace the open, undelegated missions. steps: text, after (prerequisites by index or stepId, each with why), assign: self (you do it) | route (you intend to delegate). Missions that are done, delegated, or added by the person (unplaced: true) stay on the board — never repeat them in steps; refer to them by stepId in after, and place each unplaced one with place_mission. If the person already listed every mission, skip plan and just place them. criteria: propose success criteria only when there are none. Refused with board_changed if the person edited the objective since you last read it.",
      z.object({ itemId: ids, steps: z.array(z.object({ text: z.string().trim().min(1).max(200), after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).optional(), assign: assign.optional() })).min(1).max(40), criteria: z.array(z.string().trim().min(1).max(MAX_CRITERION_TEXT)).max(MAX_CRITERIA).optional() }).strict(),
      (args, item) => {
        if (item.edited) return refuse("board_changed", { hint: "The person changed this objective since you last read it. Read it again, then plan." });
        // 계획이 남기는 임무(완료·위임·사람이 더한 미분류)를 같은 문구로 다시 만들면 보드에 두 벌이 선다 — 거절하고 참조하게 한다.
        const same = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
        const repeated = item.steps.filter((step) => (step.done || step.operationId || step.unplaced) && args.steps.some((planned) => same(planned.text) === same(step.text)));
        if (repeated.length > 0) return refuse("mission_kept", { kept: repeated.map((step) => ({ stepId: step.id, text: step.text, ...(step.unplaced ? { unplaced: true } : {}) })), hint: "These missions already stay on the board. Leave them out of steps; refer to them by stepId in after, and place unplaced ones with place_mission." });
        // 달성 기준은 사람의 것이다 — 비어 있을 때만 지휘관이 제안한다. 스스로 정한 기준을 스스로 통과시키면 점검의 뜻이 옅어진다.
        const proposed = args.criteria ?? [];
        if (proposed.length > 0 && item.criteria.length > 0) return refuse("criteria_exist", { hint: "The person already wrote the success criteria; leave criteria out." });
        let planned = launch.planApplied(item.id, { steps: args.steps });
        for (const criterion of proposed) planned = store.criterionAdd(item.id, criterion, "commander");
        return text({ ok: true, item: itemView(planned) });
      }),
    commanderTool("add_mission", "Append a mission that became necessary, with assign: self | route. Place it with place_mission.", z.object({ itemId: ids, text: z.string().trim().min(1).max(200), assign: assign.optional() }).strict(),
      (args, item) => text({ ok: true, item: itemView(launch.stepAdded(item.id, { text: args.text, ...(args.assign ? { assign: { mode: args.assign } } : {}) })) })),
    commanderTool("place_mission", "Set one open mission's prerequisites: after = indexes ([] = it can start now), and optionally assign: self | route to record whether you intend to delegate it. Missions the person added arrive unplaced (unplaced: true, never ready) — place each before you continue, and rewire open missions that should now wait for it. A mission the person pinned to a model keeps that assignment.",
      z.object({ ...mission, after: z.array(z.number().int().min(0)).max(40), assign: assign.optional() }).strict(),
      (args, item) => {
        const target = missionOf(item, args);
        if (target.done) return refuse("step_done");
        const prerequisites = args.after.map((index) => item.steps[index]?.id);
        if (prerequisites.some((id) => !id)) return refuse("unknown_step");
        // 사람이 모델까지 골라 둔 배정은 지휘관이 덮지 않는다 — 위임 의도(self·route)만 적는다.
        const assignment = args.assign && assignModeOf(target) !== "model" ? { assign: { mode: args.assign } } : {};
        const next = launch.stepPatched(item.id, target.id, { after: prerequisites.filter((id): id is string => !!id && id !== target.id), ...assignment });
        return text({ ok: true, item: itemView(next) });
      }),
    commanderTool("delegate_mission", `Missions assigned self are your own work; whether to delegate one is your call when you reach it. Launch the mission's assignee session now. It starts empty: brief it by SendMessage with the full context — objective, exact mission text, prerequisites' latest records, constraints from the brief, paths, what not to touch, and the report you expect. ${ASSIGNEE_ACCESS}`,
      z.object(mission).strict(),
      async (args, item, caller) => {
        if (item.cooking) return refuse("planning_only", { hint: PLANNING_ONLY });
        const target = missionOf(item, args);
        const delegated = await launch.delegateStep(item.id, target.id, { language: languageOf(caller) });
        return text({ ok: true, assignee: { session: delegated.session, operationId: delegated.operationId, access: "read-only", note: ASSIGNEE_ACCESS }, item: itemView(delegated.item) });
      }),
    commanderTool("complete_mission", `Mark a mission done with its record. summary: 1–${MAX_RECORD_LINES} lines, conclusion first, each at most ${MAX_RECORD_LINE} characters — no paragraphs. The person reads every record; the next mission receives the latest. Completing again after rework adds a record. After the last mission you receive a criteria check.`,
      z.object({ ...mission, summary: z.array(z.string().max(2000)).min(1).max(20) }).strict(),
      (args, item) => {
        if (item.cooking) return refuse("planning_only", { hint: PLANNING_ONLY });
        const target = missionOf(item, args);
        const lines = recordLines(args.summary);
        if (!lines) return refuse("summary_format", { hint: `Pass summary as 1–${MAX_RECORD_LINES} lines, conclusion first, each at most ${MAX_RECORD_LINE} characters.` });
        const done = store.stepDone(item.id, target.id, lines);
        // 마지막 임무를 마쳤다 — 검토 대기로 넘어가기 전에 달성 기준을 스스로 다시 따지게 한다.
        const next = done.steps.every((step) => step.done) ? criteriaCheckPrompt(done) : undefined;
        return text({ ok: true, ...(next ? { next } : {}), item: itemView(done) });
      }),
    commanderTool("mark_criterion", "Mark success criterion n met with one line of evidence (mission records, test output, the files you changed), or met: false to withdraw it. Once every mission is done and every criterion is met, the objective goes to the person for review by itself — there is no other report; the person completes it. Adding or reopening a mission, or the person's change line, withdraws every met mark. Refused with board_changed if the person edited the objective since you last read it.",
      z.object({ itemId: ids, n: z.number().int().min(1), met: z.boolean(), evidence: z.string().trim().max(MAX_EVIDENCE).optional() }).strict(),
      (args, item) => {
        if (item.edited) return refuse("board_changed", { hint: "The person changed this objective since you last read it. Read it again and judge the criteria again." });
        const target = item.criteria[args.n - 1];
        if (!target) return refuse("unknown_criterion", { criteria: item.criteria.length });
        if (args.met && !args.evidence) return refuse("evidence_required", { hint: "Give one line of evidence that the criterion holds now." });
        const next = store.criterionMet(item.id, target.id, args.met ? args.evidence! : null);
        return text({ ok: true, ...(next.awaitingReview ? { next: "Every mission is done and every criterion is met — the objective is now awaiting the person's review. Stop here; the person completes it." } : {}), item: itemView(next) });
      }),
  ];
}

/**
 * 달성 점검 — 마지막 임무를 마친 지휘관에게 도구 응답으로 되묻는 문장. 기준마다 스스로 다시 따지고 근거와 함께 충족으로 표시하게 한다.
 * 첫 판단을 의심하라고 되묻는 것이 이 기능의 핵심이다. 기준이 모두 충족돼 있으면 이미 검토 대기다.
 */
export function criteriaCheckPrompt(item: ObjectiveItem): string {
  const open = item.criteria.map((criterion, index) => ({ criterion, n: index + 1 })).filter(({ criterion }) => !criterion.met);
  if (open.length === 0) return "Every mission is done — the objective is now awaiting the person's review. Stop here; the person completes it.";
  const list = open.map(({ criterion, n }) => `${n}. ${criterion.text}`).join("\n");
  return `Every mission is done. Before the objective goes to the person, run the criteria check — read each success criterion below again and decide on your own evidence (mission records, test output, the files you changed) whether it truly holds now. Doubt your first answer. If one does not hold, add the mission it needs and carry on. For each one that holds, mark it with mark_criterion { n, met: true, evidence } — once every criterion is met, the objective goes to review by itself.\n\nCriteria not yet met:\n${list}`;
}
