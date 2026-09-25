import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { z } from "zod";

import type { LaunchService } from "./launch.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { criterionProposalSchema, followupBodySchema, followupReviseSchema, MAX_FOLLOWUPS, MAX_CRITERIA, MAX_EVIDENCE, MAX_RECORD_LINE, MAX_RECORD_LINES, recordLines, stepReady, type ObjectiveItem, type ObjectiveStep } from "./types.js";
import { createBoardViews, refuse, roleIn, text } from "./views.js";

/**
 * `fleet-objectives` — 목표를 수행하는 세션(지휘관·구성원)의 작업 도구. Console Use 토글과 무관하게 모든 Operation 에 실리므로
 * 권한은 호스트가 넘긴 호출자(`context.caller`)로 여기서 가른다: 읽기는 그 목표의 참여자만, 쓰기는 지휘관만.
 * 구성원은 읽기만 한다 — 결과는 지휘관에게 SendMessage 로 보고하고 지휘관이 기록한다. 화면 제스처는 없다.
 * 구상 중(「구상」을 누른 뒤 「개시」 전)에는 편성만 쓴다 — 임무 완료·기동은 거절한다.
 *
 * 문구 원칙 — 도구 설명·힌트·안내는 메타적으로 가볍게: 도구가 무엇인지와 사실·경계(권한·소유·비용·보드 일관성)만 말하고,
 * 절차·예시·권장 행동은 쓰지 않는다. 흐름은 지휘관 모델이 스스로 추론한다. 예시는 그대로 복제되는 경향이 있다.
 */

const ids = z.string().min(1).max(128);
const mission = { itemId: ids, stepId: ids.optional(), index: z.number().int().min(0).optional() };
const memberReference = z.string().trim().min(1).max(128);
const PLANNING_ONLY = "The objective is in planning: its lineup can change, but missions are not carried out and members are not launched until the person commences.";
const BOARD_CHANGED = "The person edited the objective after your last read.";
/** 이름 없는 지휘관 — 주소를 지어내지 않고, 이미 지원되는 회신 경로(받은 메시지의 from)만 사실로 알린다. */
const NO_FIXED_NAME = "No fixed session name. The from address on the Commander's latest message reaches that live session.";

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
      if (role?.role === "member") return refuse("not_commander", { hint: "This session is a member: it reads the objective but does not change it; the Commander receives reports and decisions to make by SendMessage to its session.", commander: { session: item.commander.sessionName, ...(item.commander.sessionName ? {} : { hint: NO_FIXED_NAME }) } });
      if (!role) return refuse("not_participant");
      return run(args, item, caller!);
    });

  return [
    tool("mine", "Your role in the objective this session belongs to (commander or member) and the board as that role sees it. An objective is a lineup of missions, each waiting on its prerequisites, carried out by the Commander and a roster of member sessions. Only the Commander changes the board; members read it and report to the Commander by SendMessage to commander.session. Carrying an objective out — planning, mustering members, completing missions, marking criteria — belongs to its Commander through the fleet-objectives tools. The from address on the Commander's latest message is also a reply address while that session is live; commander.session can be null when it has no fixed name. Members do not ask the person: a decision a member needs goes to the Commander the same way. planning: true means the person has asked for a lineup, not its execution. If the person edits the objective while you work, a short notice says so, quoting any words the person added; the board holds the change itself.", z.object({}).strict(), (_args, caller) => {
      if (caller?.kind !== "operation") return refuse("not_participant");
      const assigned = store.findAssignee(caller.operationId);
      if (assigned) {
        const member = assigned.item.members.find((candidate) => candidate.id === assigned.memberId)!;
        return text({ role: "member", access: "read-only", itemId: assigned.item.id,
          // 구성원이 보고·판단 요청을 보낼 주소 — 지휘관 세션 이름. 모르면 null 이다(따로 만든 Operation 이 지휘관인 목표).
          commander: { session: assigned.item.commander.sessionName, ...(assigned.item.commander.sessionName ? {} : { hint: NO_FIXED_NAME }) },
          member: { id: member.id, role: member.role, subagents: member.subagents, ...(member.brief ? { brief: member.brief } : {}) },
          missions: assigned.item.steps.flatMap((step, index) => step.member === member.id ? [{ index, stepId: step.id, text: step.text, ready: !step.done && stepReady(assigned.item.steps, step), done: step.done }] : []),
          item: itemView(assigned.item) });
      }
      const own = store.find(caller.operationId);
      if (!own) return refuse("not_participant");
      return text({ role: "commander", itemId: own.id, item: readView(own, caller) });
    }),
    tool("read", "The objective as it stands: the person's brief and attached image paths, the roster, missions with prerequisites, readiness, member and latest record, and the success criteria. Mission indexes follow the lineup and shift as it changes; stepIds do not.", z.object({ itemId: ids }).strict(), ({ itemId }, caller) => {
      const item = find(itemId);
      if (!roleIn(item, caller)) return refuse("not_participant");
      return text({ item: readView(item, caller) });
    }),
    commanderTool("plan", "Replace the open missions nobody has committed to yet. Finished, recorded, person-assigned and person-added (unplaced) missions stay and are referenced by stepId; restating one is refused as mission_kept. A step may name a roster member by id or role; none means the Commander. Roster members are accepted only while empty (members_exist). Only a person's explicit Plan request opens success-criterion proposals: criteria replaces all pending proposals, [] withdraws them, and omission keeps them. Use {text} to propose adding, {revise: criterion number or id, text} to revise, or {retire: criterion number or id, reason} to retire. Proposals require the person's approval and block commencement and steering until resolved (criteria_not_planning, criteria_pending). An objective is not a single pass: the person can add, rerun, reopen and rearrange missions at any time, and the same members absorb that later work, so a member lasts longer than any mission it is first given. A plan made on a board the person has since edited is refused as board_changed.",
      z.object({ itemId: ids, steps: z.array(z.object({ text: z.string().trim().min(1).max(200), after: z.array(z.object({ index: z.number().int().min(0).optional(), stepId: ids.optional(), why: z.string().max(300).optional() })).optional(), member: memberReference.optional() }).strict()).min(1).max(40), members: z.array(z.object({ role: z.string().trim().min(1).max(40), brief: z.string().max(300).optional() }).strict()).max(40).optional(), criteria: z.array(criterionProposalSchema).max(MAX_CRITERIA).optional() }).strict(),
      (args, item) => {
        if (args.criteria !== undefined && !item.criteriaOpen) return refuse("criteria_not_planning");
        if (item.edited) return refuse("board_changed", { hint: BOARD_CHANGED });
        // 완료·미분류·기록이 있는 임무를 같은 문구로 다시 만들면 보드에 두 벌이 선다.
        const same = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
        const repeated = item.steps.filter((step) => (step.done || step.unplaced || step.records.length > 0 || step.memberBy === "human") && args.steps.some((planned) => same(planned.text) === same(step.text)));
        if (repeated.length > 0) return refuse("mission_kept", { kept: repeated.map((step) => ({ stepId: step.id, text: step.text, ...(step.unplaced ? { unplaced: true } : {}) })), hint: "These missions already stay on the board and are referenced by stepId." });
        const planned = launch.planApplied(item.id, { steps: args.steps, ...(args.members ? { members: args.members } : {}), ...(args.criteria !== undefined ? { criteria: args.criteria } : {}) });
        return text({ ok: true, item: itemView(planned) });
      }),
    commanderTool("add_mission", "Append a mission, optionally naming its member by roster id or role; none means the Commander.", z.object({ itemId: ids, text: z.string().trim().min(1).max(200), member: memberReference.optional() }).strict(),
      (args, item) => text({ ok: true, item: itemView(launch.stepAdded(item.id, { text: args.text, ...(args.member ? { member: resolveMember(item, args.member) } : {}) })) })),
    commanderTool("place_mission", "Set an open mission's prerequisites by index ([] makes it ready) and optionally its member (null means the Commander). A member the person chose stays. Missions the person added stay unready until placed.",
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
    commanderTool("muster", "Bring every roster member to a live session: absent members launch waiting for a first message, dormant ones resume their own session, live ones stay as they are. A waiting session costs nothing until it receives a message; a session left idle after working can go dormant, and SendMessage and ListAgents reach only live sessions. A member knows only what it has been sent and what it has read, and keeps that across missions.",
      z.object({ itemId: ids }).strict(),
      async ({ itemId }, item) => {
        if (item.cooking) return refuse("planning_only", { hint: PLANNING_ONLY });
        return text({ members: await launch.muster(itemId) });
      }),
    commanderTool("complete_mission", `Mark a mission done with a record of 1–${MAX_RECORD_LINES} lines, conclusion first, each at most ${MAX_RECORD_LINE} characters. The person reads every record and the latest one is shown with the missions that follow; completing a mission again appends a record.`,
      z.object({ ...mission, summary: z.array(z.string().max(2000)).min(1).max(20) }).strict(),
      (args, item) => {
        if (item.cooking) return refuse("planning_only", { hint: PLANNING_ONLY });
        const target = missionOf(item, args);
        const lines = recordLines(args.summary);
        if (!lines) return refuse("summary_format", { hint: `A record is 1–${MAX_RECORD_LINES} lines, each at most ${MAX_RECORD_LINE} characters.` });
        const done = store.stepDone(item.id, target.id, lines);
        // 마지막 임무를 마쳤다 — 검토 대기로 넘어가기 전에 달성 기준을 스스로 다시 따지게 한다.
        const next = done.steps.every((step) => step.done) ? criteriaCheckPrompt(done) : undefined;
        return text({ ok: true, ...(next ? { next } : {}), item: itemView(done) });
      }),
    commanderTool("followup", `Follow-up candidates: findings outside this objective's scope, each with evidence. add a candidate {title, summary (one line), brief, criteria (1–10), evidence (1–5 of file {path relative to the Theater root, line?}, command {text}, artifact {path}, each with an optional note)}; revise {id, changed fields} or withdraw {id} while it is open. At most ${MAX_FOLLOWUPS} active per objective. When the person completes this objective they may pick candidates; each picked one becomes a dormant objective carrying that title, brief and criteria and no missions, and its evidence reaches that objective's Commander. A picked candidate is frozen; the person can also discard candidates.`,
      z.object({ itemId: ids, add: followupBodySchema.optional(), revise: followupReviseSchema.extend({ id: ids }).optional(), withdraw: z.object({ id: ids }).strict().optional() }).strict(),
      (args, item) => {
        const actions = [args.add, args.revise, args.withdraw].filter((value) => value !== undefined);
        if (actions.length !== 1) return refuse("invalid_arguments", { hint: "Exactly one of add, revise or withdraw." });
        if (args.add) return text({ ok: true, item: itemView(store.followupAdd(item.id, args.add)) });
        if (args.revise) { const { id, ...patch } = args.revise; return text({ ok: true, item: itemView(store.followupRevise(item.id, id, patch)) }); }
        return text({ ok: true, item: itemView(store.followupWithdraw(item.id, args.withdraw!.id)) });
      }),
    commanderTool("mark_criterion", "Mark success criterion n met with one line of evidence, or met: false to withdraw it. The objective reaches the person's review by itself once every mission is done and every criterion is met; the person completes it. New or reopened missions and the person's edits clear every mark. A mark made on a board the person has since edited is refused as board_changed.",
      z.object({ itemId: ids, n: z.number().int().min(1), met: z.boolean(), evidence: z.string().trim().max(MAX_EVIDENCE).optional() }).strict(),
      (args, item) => {
        if (item.criteriaProposals.length) return refuse("criteria_pending");
        if (item.edited) return refuse("board_changed", { hint: BOARD_CHANGED });
        const target = item.criteria[args.n - 1];
        if (!target) return refuse("unknown_criterion", { criteria: item.criteria.length });
        if (args.met && !args.evidence) return refuse("evidence_required", { hint: "A met mark carries one line of evidence." });
        const next = store.criterionMet(item.id, target.id, args.met ? args.evidence! : null);
        return text({ ok: true, ...(next.awaitingReview ? { next: IN_REVIEW } : {}), item: itemView(next) });
      }),
  ];
}

/** 모든 임무와 기준이 끝났다 — 목표는 사람의 검토로 넘어갔다. */
const IN_REVIEW = "Every mission is done and every criterion is met: the objective is with the person for review.";

/**
 * 달성 점검 — 마지막 임무를 마친 지휘관에게 도구 응답으로 돌려주는 사실. 지시 대신 판단의 무게(사람이 이 판단을 믿고
 * 다시 확인하지 않는다)를 말해 모델이 스스로 기준을 다시 따지게 한다. 기준이 모두 충족돼 있으면 이미 검토 대기다.
 */
export function criteriaCheckPrompt(item: ObjectiveItem): string {
  if (item.criteriaProposals.length) return "Success-criterion proposals await the person's decision; the objective cannot reach review yet.";
  const open = item.criteria.map((criterion, index) => ({ criterion, n: index + 1 })).filter(({ criterion }) => !criterion.met);
  if (open.length === 0) return IN_REVIEW;
  const list = open.map(({ criterion, n }) => `${n}. ${criterion.text}`).join("\n");
  return `Every mission is done. The objective goes to the person's review once each criterion below is marked met with evidence; the person relies on that judgment rather than re-checking, and a criterion that does not hold yet means the objective is not finished.\n\nCriteria not yet met:\n${list}`;
}
