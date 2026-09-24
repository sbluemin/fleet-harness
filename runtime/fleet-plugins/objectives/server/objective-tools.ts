import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import type { LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { MAX_CRITERIA, MAX_CRITERION_TEXT, MAX_EVIDENCE, MAX_RECORD_LINE, MAX_RECORD_LINES, recordLines, stepReady, type ObjectiveItem, type ObjectiveStep } from "./types.js";
import { createBoardViews, refuse, roleIn, text } from "./views.js";

/**
 * `fleet-objectives` — 목표를 수행하는 세션(지휘관·구성원)의 작업 도구. Console Use 토글과 무관하게 모든 Operation 에 실리므로
 * 권한은 호스트가 넘긴 호출자(`context.caller`)로 여기서 가른다: 읽기는 그 목표의 참여자만, 쓰기는 지휘관만.
 * 구성원은 읽기만 한다 — 결과는 지휘관에게 SendMessage 로 보고하고 지휘관이 기록한다. 화면 제스처는 없다.
 * 구상 중(「구상」을 누른 뒤 「개시」 전)에는 편성만 쓴다 — 임무 완료·기동은 거절한다.
 */

const ids = z.string().min(1).max(128);
const mission = { itemId: ids, stepId: ids.optional(), index: z.number().int().min(0).optional() };
const memberReference = z.string().trim().min(1).max(128);
const PLANNING_ONLY = "This objective is being planned, not carried out: lay the lineup out on the board (plan, add_mission, place_mission) and stop. Missions are carried out and members launched after the person presses Commence.";

export function createObjectiveMcpTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService): readonly PluginMcpTool[] {
  const { itemView } = createBoardViews(ctx, store);
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
  const resolveMember = (item: ObjectiveItem, reference: string): string => {
    const member = item.members.find((candidate) => candidate.id === reference || candidate.role === reference);
    if (!member) throw new ObjectiveStoreError("unknown_member");
    return member.id;
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
      if (role?.role === "member") return refuse("not_commander", { hint: "Members can read this objective but cannot change it. Report to the Commander by SendMessage." });
      if (!role) return refuse("not_participant");
      return run(args, item, caller!);
    });

  return [
    tool("mine", "Your objective and your role in it: commander or member. Start here. An objective is carried out by missions in a dependency lineup (after = prerequisite indexes; a mission is ready when they are done); each mission names the member who does it, or none when the Commander does it. The Commander plans, briefs members, records results and marks the success criteria; members only read — a member sees its role, brief and assigned missions — and report to the Commander by SendMessage. planning: true means the person asked for a plan only — lay the lineup out on the board and stop. When the person edits the objective while you work, you receive one line saying it changed — read it again and continue from what it now says.", z.object({}).strict(), (_args, caller) => {
      if (caller?.kind !== "operation") return refuse("not_participant");
      const assigned = store.findAssignee(caller.operationId);
      if (assigned) {
        const member = assigned.item.members.find((candidate) => candidate.id === assigned.memberId)!;
        return text({ role: "member", access: "read-only", itemId: assigned.item.id,
          member: { id: member.id, role: member.role, ...(member.brief ? { brief: member.brief } : {}) },
          missions: assigned.item.steps.flatMap((step, index) => step.member === member.id ? [{ index, stepId: step.id, text: step.text, ready: !step.done && stepReady(assigned.item.steps, step), done: step.done }] : []),
          item: itemView(assigned.item) });
      }
      const own = store.find(caller.operationId);
      if (!own) return refuse("not_participant");
      return text({ role: "commander", itemId: own.id, item: readView(own, caller) });
    }),
    tool("read", "Read an objective you take part in: the person's brief and image attachment paths, roster, missions and their member assignments, dependencies, readiness, latest records, and success criteria. Indexes shift when missions change; stepId is stable. Members have read-only access and report by SendMessage.", z.object({ itemId: ids }).strict(), ({ itemId }, caller) => {
      const item = find(itemId);
      if (!roleIn(item, caller)) return refuse("not_participant");
      return text({ item: readView(item, caller) });
    }),
    commanderTool("plan", "Replace open missions without records or human-owned assignments. steps: text, after (prerequisites by index or stepId, each with why), optional member (roster id or role; omitted means Commander). Done, unplaced, recorded, and human-assigned missions stay on the board; refer to them by stepId. members proposes roles and briefs only when the roster is empty (otherwise members_exist). An objective loops rather than running once: the person can add missions, rerun or reopen finished ones and change the lineup at any time, and the same members take that later work, so name each member by the kind of work it does (research, review) and write its brief for that kind of work across missions, not for one mission. criteria proposes success criteria only when none exist. A person's later edit causes board_changed until you read again.",
      z.object({ itemId: ids, steps: z.array(z.object({ text: z.string().trim().min(1).max(200), after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).optional(), member: memberReference.optional() }).strict()).min(1).max(40), members: z.array(z.object({ role: z.string().trim().min(1).max(40), brief: z.string().max(300).optional() }).strict()).max(40).optional(), criteria: z.array(z.string().trim().min(1).max(MAX_CRITERION_TEXT)).max(MAX_CRITERIA).optional() }).strict(),
      (args, item) => {
        if (item.edited) return refuse("board_changed", { hint: "The person changed this objective since you last read it. Read it again, then plan." });
        // 완료·미분류·기록이 있는 임무를 같은 문구로 다시 만들면 보드에 두 벌이 선다.
        const same = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
        const repeated = item.steps.filter((step) => (step.done || step.unplaced || step.records.length > 0 || step.memberBy === "human") && args.steps.some((planned) => same(planned.text) === same(step.text)));
        if (repeated.length > 0) return refuse("mission_kept", { kept: repeated.map((step) => ({ stepId: step.id, text: step.text, ...(step.unplaced ? { unplaced: true } : {}) })), hint: "These missions already stay on the board. Leave them out of steps; refer to them by stepId in after, and place unplaced ones with place_mission." });
        // 달성 기준은 사람의 것이다 — 비어 있을 때만 지휘관이 제안한다. 스스로 정한 기준을 스스로 통과시키면 점검의 뜻이 옅어진다.
        const proposed = args.criteria ?? [];
        if (proposed.length > 0 && item.criteria.length > 0) return refuse("criteria_exist", { hint: "The person already wrote the success criteria; leave criteria out." });
        let planned = launch.planApplied(item.id, { steps: args.steps, ...(args.members ? { members: args.members } : {}) });
        for (const criterion of proposed) planned = store.criterionAdd(item.id, criterion, "commander");
        return text({ ok: true, item: itemView(planned) });
      }),
    commanderTool("add_mission", "Append a mission with optional member (roster id or role; omitted means Commander).", z.object({ itemId: ids, text: z.string().trim().min(1).max(200), member: memberReference.optional() }).strict(),
      (args, item) => text({ ok: true, item: itemView(launch.stepAdded(item.id, { text: args.text, ...(args.member ? { member: resolveMember(item, args.member) } : {}) })) })),
    commanderTool("place_mission", "Set an open mission's prerequisites: after = indexes ([] = ready now). Optional member is a roster id or role, null means Commander; a human-assigned member is preserved. The person's unplaced missions are not ready until placed.",
      z.object({ ...mission, after: z.array(z.number().int().min(0)).max(40), member: memberReference.nullable().optional() }).strict(),
      (args, item) => {
        const target = missionOf(item, args);
        if (target.done) return refuse("step_done");
        const prerequisites = args.after.map((index) => item.steps[index]?.id);
        if (prerequisites.some((id) => !id)) return refuse("unknown_step");
        const assignment = args.member !== undefined && target.memberBy !== "human" ? { member: args.member === null ? null : resolveMember(item, args.member) } : {};
        const next = launch.stepPatched(item.id, target.id, { after: prerequisites.filter((id): id is string => !!id && id !== target.id), ...assignment });
        return text({ ok: true, item: itemView(next) });
      }),
    commanderTool("muster", "Launch every missing member as a waiting session without a first message, resume dormant members in their existing sessions, and leave live members unchanged. Waiting sessions have no model cost until their first message. SendMessage and ListAgents reach live sessions; worked sessions may become dormant after 60 minutes idle. A newly launched member starts with no context: brief it by SendMessage with the objective, the exact mission text, prerequisites' latest records, constraints from the brief, paths, what not to touch and the report you expect. A member retains context across missions and can read this objective with mine/read but cannot write it; reports travel by SendMessage.",
      z.object({ itemId: ids }).strict(),
      async ({ itemId }, item) => {
        if (item.cooking) return refuse("planning_only", { hint: PLANNING_ONLY });
        return text({ members: await launch.muster(itemId) });
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
