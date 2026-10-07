import type { ConsoleCaller, PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import path from "node:path";

import { z } from "zod";

import type { LaunchService } from "./launch.js";
import type { PrStatusService } from "./pr-status.js";
import { completionResultsSchema, resultPatchSchema, RESULT_LIMITS } from "./results.js";
import { EvidenceError, readSharedEvidence } from "./evidence.js";
import { ObjectiveStoreError, type ObjectiveStore } from "./store.js";
import { criterionProposalSchema, memberAddSchema, MAX_MISSIONS, MAX_MISSION_TEXT, MAX_CRITERION_TEXT, MAX_DECISION_QUESTION, pinSchema, decisionQuestionSchema, followupBodySchema, MAX_DECISION_OPTIONS, MAX_DECISION_QUESTIONS, followupReviseSchema, MAX_FOLLOWUPS, MAX_CRITERIA, MAX_EVIDENCE, MAX_RECORD_LINE, MAX_RECORD_LINES, MAX_RETRO_PAIRS, MAX_RETRO_TEXT, recordLines, missionReady, ownAnswer, retrospectiveSchema, type Objective, type ObjectiveMission } from "./types.js";
import { createBoardViews, refuse, roleIn, storedText, text, withPin } from "./views.js";

/**
 * `fleet-objectives` — 목표를 수행하는 세션(지휘관·구성원)의 작업 도구. Console Use 토글과 무관하게 모든 Operation 에 실리므로
 * 권한은 호스트가 넘긴 호출자(`context.caller`)로 여기서 가른다: 읽기는 그 목표의 참여자만, 쓰기는 지휘관만.
 * 구성원은 보드를 읽고 자기 root의 증거만 보존할 수 있다 — 결과물 연결·보드 기록은 지휘관이 한다. 화면 제스처는 없다.
 * 구상 중(「구상」을 누른 뒤 「개시」 전)에는 편성만 쓴다 — 임무 완료·기동은 거절한다.
 *
 * 문구 원칙 — 도구 설명·힌트·안내는 메타적으로 가볍게: 도구가 무엇인지와 사실·경계(권한·소유·비용·보드 일관성)만 말하고,
 * 절차·예시·권장 행동은 쓰지 않는다. 흐름은 지휘관 모델이 스스로 추론한다. 예시는 그대로 복제되는 경향이 있다.
 */

const ids = z.string().min(1).max(128);
/** 임무를 가리키는 두 길 — 변하지 않는 missionId, 또는 지휘관 번호표의 1-based 번호 n. */
const missionRef = { objectiveId: ids, missionId: ids.optional(), n: z.number().int().min(1).optional() };
/** 선행 한 칸 — 번호 n 이나 missionId, 그리고 이유. */
const prerequisiteRef = z.object({ n: z.number().int().min(1).optional(), missionId: ids.optional(), why: z.string().max(300).optional() }).strict();
const memberReference = z.string().trim().min(1).max(128);
const PIN_FACT = "Appended to the stored text as ` [pin]`: MUST NOT, MUST or MAY, then ASCII detail without brackets; at most 60 characters, and the text with its pin stays within the field limit (text_with_pin_too_long).";
const BOARD_REFERENCES = "Text already on the board is referred to by missionId, criterion n or id, and decision id, not typed again.";
const pin = pinSchema.optional().describe(PIN_FACT);
const [proposeAdd, proposeRevise, ...proposeRest] = criterionProposalSchema.options;
const criterionProposalInput = z.union([proposeAdd.extend({ pin }), proposeRevise.extend({ pin }), proposeRest[0]!, proposeRest[1]!]);
const PLANNING_ONLY = "The objective is in planning: its lineup can change, but missions are not carried out and members are not launched until the person commences.";
const BOARD_CHANGED = "The person edited the objective after your last read.";
/** 이름 없는 지휘관 — 주소를 지어내지 않고, 이미 지원되는 회신 경로(받은 메시지의 from)만 사실로 알린다. */
const NO_FIXED_NAME = "No fixed session name. The from address on the Commander's latest message reaches that live session.";
/** read·mine 설명의 한 줄 — 후속 후보는 언제든 담을 수 있다. */
const FOLLOWUP_ANYTIME = "Follow-up candidates can be placed on the objective at any time with the Commander's followup tool.";
/** read·mine 설명의 한 줄 — 결정 요청과 결정이 보드에 있다는 사실. */
const DECISIONS_ON_BOARD = "Sessions launched for an objective start without AskUserQuestion; a session that was already running when it joined keeps the tools it was launched with until it next starts, and an AskUserQuestion prompt shows only in that session's own panel. The board holds the current decisionRequest and decisionRequestRevision, and decisions: the person's answers recorded after successful delivery, each with the question, the labels of the options chosen (selected), any words written (text), and own: true when the person discarded every offered option and gave their own answer instead. Only the person's board submissions create decision records; there is no model write tool for them, the Commander and members read them, and they survive reruns. The person may not be watching the Commander's panel text. Reading does not clear a request or change a decision.";
const DECISION_DELIVERING = "The person's answers have been accepted, but delivery and recording are not yet finalized. The current request cannot be replaced or withdrawn.";
const RETROSPECTIVE_FORMAT = `A retrospective is wentWell: 1–${MAX_RETRO_PAIRS} {point, because} and fellShort: 1–${MAX_RETRO_PAIRS} {point, ifOnly}, each field one line of at most ${MAX_RETRO_TEXT} characters.`;

/** request_decision 이 사람의 답을 기다리는 최대 시간. 그 뒤의 답은 프롬프트로 간다. */
export const DECISION_WAIT_MS = 5 * 60_000;

export function createObjectiveMcpTools(ctx: FleetPluginServerContext, store: ObjectiveStore, launch: LaunchService, prStatus?: PrStatusService, options?: { readonly decisionWaitMs?: number }): readonly PluginMcpTool[] {
  const decisionWaitMs = options?.decisionWaitMs ?? DECISION_WAIT_MS;
  const { objectiveView: boardView } = createBoardViews(ctx, store);
  const objectiveView = (objective: Objective) => { prStatus?.refresh(objective.id); return boardView(store.find(objective.id) ?? objective); };
  /** 쓰기 응답은 확인과 새로 생긴 가리킴만 — 보드 전체는 read·mine 이 준다. 결과물이 바뀌면 PR 관측만 앞당긴다. */
  const added = <T extends { readonly id: string }>(before: readonly T[], after: readonly T[]): T | undefined => after.find((entry) => !before.some((prior) => prior.id === entry.id));
  const storedMission = (objectiveId: string, missionId: string) => {
    const stored = store.find(objectiveId)?.missions.find((entry) => entry.id === missionId);
    return stored ? { stored: { text: storedText(stored.text) } } : {};
  };
  const find = (objectiveId: string): Objective => {
    const objective = store.find(objectiveId);
    if (!objective) throw new ObjectiveStoreError("unknown_objective");
    return objective;
  };
  /**
   * 지휘관의 번호표 — 마지막으로 읽은(read·mine·plan) 편성 순의 missionId. 임무를 더하거나 선행을 바꾸면 편성 순이 다시 서지만,
   * 지휘관이 다시 읽기 전까지 그의 n 은 이 번호표를 가리킨다(실모델 실측: 밀린 번호로 다른 임무를 배치·완료했다). 그 뒤 더한 임무는
   * 다음 번호를 받는다. 번호표는 이 서버의 메모리에만 있다 — 재시작 뒤 이어진 지휘관의 옛 n 을 지금 편성 순으로 풀면 다른 임무로
   * 가므로, 이 서버에서 아직 읽지 않았으면 n 을 거절하고 다시 읽게 한다(missionId 는 그대로 받는다).
   */
  const numbered = new Map<string, readonly string[]>();
  const renumber = (objective: Objective) => numbered.set(objective.id, objective.missions.map((mission) => mission.id));
  const numbering = (objective: Objective): readonly string[] => {
    const shown = numbered.get(objective.id);
    if (!shown) throw new ObjectiveStoreError("numbering_unread", undefined, { hint: "Mission numbers n refer to the Commander's latest read, and there has been none in this Console run; read returns the current numbers. missionIds are accepted as they are." });
    return shown;
  };
  const missionOf = (objective: Objective, ref: { missionId?: string; n?: number }): ObjectiveMission => {
    const id = ref.missionId ?? (ref.n !== undefined ? numbering(objective)[ref.n - 1] : undefined);
    const found = id ? objective.missions.find((mission) => mission.id === id) : undefined;
    if (!found) throw new ObjectiveStoreError("unknown_mission");
    return found;
  };
  /** 선행 목록을 missionId 로 — 모르는 임무가 하나라도 있으면 거절한다. */
  const prerequisitesOf = (objective: Objective, refs: readonly (number | z.output<typeof prerequisiteRef>)[]) => {
    const edges = refs.map((ref) => (typeof ref === "number" ? { mission: missionOf(objective, { n: ref }) } : { mission: missionOf(objective, ref), why: ref.why }));
    return { ids: edges.map((edge) => edge.mission.id), why: Object.fromEntries(edges.flatMap((edge) => (edge.why ? [[edge.mission.id, edge.why]] : []))) };
  };
  /** id 가 먼저, 그다음 역할 이름. 같은 역할 이름이 둘 이상이면 어느 구성원인지 고르지 않고 거절한다. */
  const resolveMember = (objective: Objective, reference: string): string => {
    const byId = objective.members.find((candidate) => candidate.id === reference);
    if (byId) return byId.id;
    const byRole = objective.members.filter((candidate) => candidate.role === reference);
    if (byRole.length > 1) throw new ObjectiveStoreError("ambiguous_member", undefined, { hint: "Members share this role; name one by id.", members: byRole.map((member) => member.id) });
    if (!byRole[0]) throw new ObjectiveStoreError("unknown_member");
    return byRole[0].id;
  };
  /**
   * 지휘관이 제 목표를 읽었다 — 그 뒤의 계획·충족 판단은 사람의 변경을 다시 막지 않는다.
   */
  const readView = (objective: Objective, caller: ConsoleCaller | undefined) => {
    if (roleIn(objective, caller)?.role !== "commander") return objectiveView(objective);
    const read = store.setEdited(objective.id, null);
    renumber(read);
    return objectiveView(read);
  };

  /** 짧은 목표 이름은 인증된 참여 범위 안에서만 푼다. 정확한 id와 기존 권한 판정은 그대로 둔다. */
  const resolveObjectiveId = (reference: string, caller: ConsoleCaller | undefined): string => {
    if (store.find(reference) || caller?.kind !== "operation") return reference;
    const matches = store.all().filter((objective) => objective.id.startsWith(reference) && roleIn(objective, caller));
    return matches.length === 1 ? matches[0]!.id : reference;
  };
  const tool = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.output<S>, caller: ConsoleCaller | undefined, context: Parameters<PluginMcpTool["execute"]>[1]) => Promise<unknown> | unknown): PluginMcpTool => ({
    name, description, inputSchema: z.toJSONSchema(schema),
    execute: async (raw, context) => {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      try {
        const args = parsed.data;
        return await run(typeof args.objectiveId === "string" ? { ...args, objectiveId: resolveObjectiveId(args.objectiveId, context.caller) } : args, context.caller, context);
      }
      catch (error) {
        if (error instanceof EvidenceError) {
          const reason = error.reason ?? (error.code === "evidence_outside_dir" ? "Paths outside this objective's evidence directory, including Theater paths, are not read." : undefined);
          return refuse(error.code, reason ? { reason } : {});
        }
        return error instanceof ObjectiveStoreError ? refuse(error.code, error.code === "decision_delivering" ? { hint: DECISION_DELIVERING } : error.code === "unknown_objective" ? { hint: "Use mine to read this session's objective and its full objectiveId." } : error.details) : refuse("objectives_failed");
      }
    },
  });
  /** 쓰기의 문 — 지휘관만. 담당에게는 읽기 전용임을, 밖의 Operation 에게는 참여자가 아님을 말한다. */
  const commanderTool = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.output<S>, objective: Objective, caller: ConsoleCaller, context: Parameters<PluginMcpTool["execute"]>[1]) => Promise<unknown> | unknown) =>
    tool(name, `Commander only. ${description}`, schema, (args, caller, context) => {
      const objective = find((args as { objectiveId: string }).objectiveId);
      const role = roleIn(objective, caller);
      if (role?.role === "member") return refuse("not_commander", { hint: "This session is a member: it can read the board and seal evidence, but only the Commander changes the board. Reports, sealed evidenceIds and decisions to make reach the Commander by SendMessage to its session.", commander: { session: objective.commander.sessionName, ...(objective.commander.sessionName ? {} : { hint: NO_FIXED_NAME }) } });
      if (!role) return refuse("not_participant");
      return run(args, objective, caller!, context);
    });

  return [
    tool("mine", `Your role in the objective this session belongs to (commander or member) and the board as that role sees it. An objective is a lineup of missions, each waiting on its prerequisites, carried out by the Commander and a roster of member sessions. Only the Commander changes the board; members read it, can seal evidence from the objective's evidence directory, and report to the Commander by SendMessage to commander.session. Carrying an objective out — planning, mustering members, completing missions, marking criteria — belongs to its Commander through the fleet-objectives tools. The from address on the Commander's latest message is also a reply address while that session is live; commander.session can be null when it has no fixed name. Members do not ask the person: a decision a member needs goes to the Commander the same way. A directive that reads as reversed in meaning or unreadable goes to the Commander before it is carried out. A pin states a directive's polarity in ASCII at the end of its text; a directive whose prose contradicts its pin is put to the Commander and not carried out. planning: true means the person has asked for a lineup, not its execution. If the person edits the objective while you work, a short notice says so, quoting any words the person added; the board holds the change itself. ${DECISIONS_ON_BOARD} ${FOLLOWUP_ANYTIME} At hand-off the Commander asks members for a retrospective and the resources they created for this objective.`, z.object({}).strict(), (_args, caller) => {
      if (caller?.kind !== "operation") return refuse("not_participant");
      const assigned = store.findMember(caller.operationId);
      if (assigned) {
        const member = assigned.objective.members.find((candidate) => candidate.id === assigned.memberId)!;
        return text({ role: "member", access: "read-only", objectiveId: assigned.objective.id,
          // 구성원이 보고·판단 요청을 보낼 주소 — 지휘관 세션 이름. 모르면 null 이다(따로 만든 Operation 이 지휘관인 목표).
          commander: { session: assigned.objective.commander.sessionName, ...(assigned.objective.commander.sessionName ? {} : { hint: NO_FIXED_NAME }) },
          member: { id: member.id, role: member.role, subagents: member.subagents, ...(member.brief ? { brief: member.brief } : {}) },
          missions: assigned.objective.missions.flatMap((mission, index) => mission.member === member.id ? [{ n: index + 1, missionId: mission.id, text: mission.text, done: mission.done, ...(mission.done ? {} : { ready: missionReady(assigned.objective.missions, mission) }) }] : []),
          objective: objectiveView(assigned.objective) });
      }
      const own = store.find(caller.operationId);
      if (!own) return refuse("not_participant");
      return text({ role: "commander", objectiveId: own.id, objective: readView(own, caller) });
    }),
    tool("read", `The objective as it stands: the person's brief and attached image paths, the roster, missions with prerequisites, readiness, member and latest record, and the success criteria. Only that objective's Commander and its members can read it; any other session, including another objective's Commander, is refused as not_participant, so this tool cannot supply another objective's board or retrospective to a mission. Mission numbers n count from 1 in lineup order as of the Commander's latest read (read or mine) or plan; the Commander's n keep pointing at those missions while it writes, missions it adds take the next numbers, and its next read renumbers them. missionIds never change. extensions records each scope-extension round, its request, the board ids at its start and the previous round's hand-off with retrospective; extension on a mission or criterion is the round that added it. Tools that change the board return only what they created, not the board. ${DECISIONS_ON_BOARD} ${FOLLOWUP_ANYTIME}`, z.object({ objectiveId: ids }).strict(), ({ objectiveId }, caller) => {
      const objective = find(objectiveId);
      if (!roleIn(objective, caller)) return refuse("not_participant");
      return text({ objective: readView(objective, caller) });
    }),
    tool("evidence_dir", "The objective's evidence directory: one directory the Commander and every member share, and the only place seal_evidence_from_path reads from. Its path is returned only through MCP, not to the browser. The Theater working directory, a session's system-prompt Scratchpad directory and Bash temporary directories are not this root.", z.object({ objectiveId: ids }).strict(), ({ objectiveId }, caller) => {
      const objective = find(objectiveId);
      if (!roleIn(objective, caller)) return refuse("not_participant");
      return text({ root: store.sharedDir(objective.theaterId, objective.id), note: "Only files under root can be sealed." });
    }),
    tool("seal_evidence_from_path", `Copy a file from this objective's evidence directory (evidence_dir) into this objective's evidence store. Relative paths resolve there, not in the Theater or the session's working directory. Files copied from the Theater or elsewhere into this directory are subject to the same sealing checks as files created here; sealing does not read or compare the originals outside it. PNG, JPEG, WebP and GIF images are limited to ${RESULT_LIMITS.imageBytes / 1024 / 1024} MiB; UTF-8 MD, TXT, LOG and JSON text to ${RESULT_LIMITS.textBytes / 1024 / 1024} MiB. Symlinks, hardlinks, non-regular files, paths outside the evidence directory and files changed during reading are refused. The Commander and members can seal files. The returned evidenceId identifies an immutable copy, not an attached result. Only the Commander can attach it through complete_mission or replace existing evidence through update_result. Unattached copies expire after ${RESULT_LIMITS.pendingEvidenceTtlMs / 3_600_000} hours; this expiry does not apply while attached.`, z.object({ objectiveId: ids, path: z.string().min(1).max(RESULT_LIMITS.sourcePath) }).strict(), async ({ objectiveId, path: source }, caller, context) => {
      const objective = find(objectiveId);
      if (!roleIn(objective, caller)) return refuse("not_participant");
      const root = store.sharedDir(objective.theaterId, objective.id);
      const bytes = await readSharedEvidence(path.isAbsolute(source) ? source : path.join(root, source), root, context.signal);
      // 읽기를 기다리는 동안 명단이 바뀌었다면 그 목표에 bytes를 남기지 않는다.
      if (!roleIn(find(objectiveId), caller) || caller?.kind !== "operation") return refuse("not_participant");
      const sealed = store.evidenceSeal(objectiveId, caller.operationId, bytes);
      return text({ evidenceId: sealed.evidenceId, name: sealed.name, bytes: sealed.bytes, expiresAt: new Date(sealed.capturedAt + RESULT_LIMITS.pendingEvidenceTtlMs).toISOString() });
    }),
    commanderTool("update_result", "Correct an existing result without changing its resultId or kind. Omitted fields stay; null clears label, note, or sourceMissionId. PR and Artifact URLs can change within their kind. A changed PR URL resets its server observation to unchecked. Artifact links are not fetched or observed; unlike sealed evidence, no content copy is preserved. Replacing evidence with a different evidenceId requires one sealed for this objective; the previous evidenceId then becomes unavailable, while its source file is unchanged. Mission records are unchanged. Once the person completes the objective, changes are refused as objective_done.",
      z.object({ objectiveId: ids, resultId: ids, patch: resultPatchSchema }).strict(),
      ({ resultId, patch }, objective) => { store.resultUpdate(objective.id, resultId, patch); prStatus?.refresh(objective.id); return text({ ok: true }); }),
    commanderTool("detach_result", "Remove a result and its mission link from the objective. A detached evidenceId becomes unavailable; the source file, PR and linked Artifact are unchanged. Mission records and completion states are unchanged. Unknown resultIds are refused as unknown_result; changes after the person completes the objective are refused as objective_done.",
      z.object({ objectiveId: ids, resultId: ids }).strict(),
      ({ resultId }, objective) => { store.resultRemove(objective.id, resultId); return text({ ok: true }); }),
    commanderTool("plan", "Replace the open missions nobody has committed to yet. Finished, recorded, person-assigned and person-added missions (including after placement) stay and are referenced by missionId; restating one is refused as mission_kept. A mission's prerequisites are numbers n counting from 1 over this plan's own missions, or the missionId of a mission that stays. A mission may name a roster member by id or role; none means the Commander. Roster members are accepted only while empty (members_exist); enlist adds them later. Only a person's explicit Plan request opens success-criterion proposals: criteria replaces all pending proposals, [] withdraws them, and omission keeps them. Use {text} to propose adding, {revise: criterion number or id, text} to revise, or {retire: criterion number or id, reason} to retire. A criterion that depends on an earlier verdict or an A/B branch must state that premise and the evidence that stands when it fails, in a {text} proposal and in a revise of one on the board; an unconditional criterion needs neither. In an extension round, existing met criteria are preserved; {recheck: criterion number or id, reason} proposes rechecking one old met criterion, and only the person's approval clears it. extensions holds the numbered rounds, the person's scope request, starting mission/criterion ids and previous hand-off retrospectives. Proposals require the person's approval and block commencement and steering until resolved (criteria_not_planning, criteria_pending). An objective is not a single pass: the person can add, rerun, reopen and rearrange missions at any time, and the same members absorb that later work, so a member lasts longer than any mission it is first given. A plan made on a board the person has since edited is refused as board_changed. " + BOARD_REFERENCES,
      z.object({ objectiveId: ids, missions: z.array(z.object({ text: z.string().trim().min(1).max(MAX_MISSION_TEXT), pin, prerequisites: z.array(z.object({ n: z.number().int().min(1).optional(), missionId: ids.optional(), why: z.string().max(300).optional() })).optional(), member: memberReference.optional() }).strict()).min(1).max(40), members: z.array(z.object({ role: z.string().trim().min(1).max(40), brief: z.string().max(300).optional() }).strict()).max(40).optional(), criteria: z.array(criterionProposalInput).max(MAX_CRITERIA).optional() }).strict(),
      (args, objective) => {
        if (args.criteria !== undefined && !objective.criteriaOpen) return refuse("criteria_not_planning");
        if (objective.edited) return refuse("board_changed", { hint: BOARD_CHANGED });
        const planMissions = args.missions.map(({ pin: missionPin, ...mission }) => ({ ...mission, text: withPin(mission.text, missionPin, MAX_MISSION_TEXT) }));
        const planCriteria = args.criteria?.map((proposal) => { if (!("text" in proposal)) return proposal; const { pin: criterionPin, ...rest } = proposal; return { ...rest, text: withPin(rest.text, criterionPin, MAX_CRITERION_TEXT) }; });
        // 완료·미분류·기록이 있는 임무를 같은 문구로 다시 만들면 보드에 두 벌이 선다.
        const same = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
        const repeated = objective.missions.filter((mission) => (mission.done || mission.unplaced || (mission.by !== undefined && mission.by !== "commander") || mission.records.length > 0 || (mission.memberBy !== undefined && mission.memberBy !== "commander")) && planMissions.some((planned) => same(planned.text) === same(mission.text)));
        if (repeated.length > 0) return refuse("mission_kept", { kept: repeated.map((mission) => ({ missionId: mission.id, text: mission.text, ...(mission.unplaced ? { unplaced: true } : {}) })), hint: "These missions already stay on the board and are referenced by missionId." });
        const planned = launch.planApplied(objective.id, { missions: planMissions, ...(args.members ? { members: args.members } : {}), ...(planCriteria !== undefined ? { criteria: planCriteria } : {}) });
        renumber(planned);
        const stored = store.find(objective.id) ?? planned;
        return text({ ok: true, missions: stored.missions.map((mission, index) => ({ n: index + 1, missionId: mission.id, text: storedText(mission.text) })),
          ...(args.criteria !== undefined || args.members ? { stored: {
            ...(args.criteria !== undefined ? { criteria: stored.criteriaProposals.map(({ id, kind, target, text: proposed, reason }) => ({ id, kind, ...(target ? { target } : {}), ...(proposed !== undefined ? { text: storedText(proposed) } : {}), ...(reason ? { reason: storedText(reason) } : {}) })) } : {}),
            ...(args.members ? { members: stored.members.map(({ id, role, brief }) => ({ id, role, ...(brief ? { brief: storedText(brief) } : {}) })) } : {}),
          } } : {}) });
      }),
    commanderTool("add_mission", "Add a mission with its prerequisites — each the n or missionId of a mission on the board, finished or not, with an optional why — and optionally its member by roster id or role; none means the Commander. A mission added without prerequisites is ready at once and stands in the lineup's first column, ahead of missions that wait on others. The returned n is its number until the Commander's next read. " + BOARD_REFERENCES,
      z.object({ objectiveId: ids, text: z.string().trim().min(1).max(MAX_MISSION_TEXT), pin, prerequisites: z.array(prerequisiteRef).max(40).optional(), member: memberReference.optional() }).strict(),
      (args, objective) => {
        const prerequisites = prerequisitesOf(objective, args.prerequisites ?? []);
        const known = numbered.get(objective.id);
        const next = launch.missionAdded(objective.id, { text: withPin(args.text, args.pin, MAX_MISSION_TEXT), prerequisites: prerequisites.ids, ...(Object.keys(prerequisites.why).length ? { why: prerequisites.why } : {}), ...(args.member ? { member: resolveMember(objective, args.member) } : {}) });
        const mission = added(objective.missions, next.missions);
        if (!mission) return text({ ok: true });
        if (!known) return text({ ok: true, missionId: mission.id, ...storedMission(objective.id, mission.id) });
        numbered.set(objective.id, [...known, mission.id]);
        return text({ ok: true, missionId: mission.id, n: known.length + 1, ...storedMission(objective.id, mission.id) });
      }),
    commanderTool("place_mission", "Replace an open mission's prerequisites — each a mission number n, or {n or missionId, why} — ([] makes it ready), and optionally set its member (null means the Commander). A member the person chose stays. Missions the person added stay unready until placed.",
      z.object({ ...missionRef, prerequisites: z.array(z.union([z.number().int().min(1), prerequisiteRef])).max(40), member: memberReference.nullable().optional() }).strict(),
      (args, objective) => {
        const target = missionOf(objective, args);
        if (target.done) return refuse("mission_done");
        const prerequisites = prerequisitesOf(objective, args.prerequisites);
        const assignment = args.member !== undefined && (target.memberBy === undefined || target.memberBy === "commander") ? { member: args.member === null ? null : resolveMember(objective, args.member) } : {};
        launch.missionPatched(objective.id, target.id, { prerequisites: prerequisites.ids.filter((id) => id !== target.id), ...(Object.keys(prerequisites.why).length ? { why: prerequisites.why } : {}), ...assignment });
        return text({ ok: true, missionId: target.id });
      }),
    commanderTool("request_decision", `Place a decision request on the Objectives surfaces the person sees: questions the person answers there, not a notice that clears when read or when a session is opened. Storage limits are 1–${MAX_DECISION_QUESTIONS} questions per request and either no options or 2–${MAX_DECISION_OPTIONS} per question; the person can always write an answer of their own. The board always adds an "Answer in my own words" row to every question that has options, so do not include an "Other" or "Write my own" option. The person sends every answer at once. An objective holds one current request; a new request replaces all of the previous one. missionId and memberId are optional context per question. expectedRevision is the board's decisionRequestRevision; a different value is refused as decision_request_changed. Once the answers reach the Commander, the request clears and each answer stays in decisions, which members read too, and stays through reruns. A request cleared by the person's board edits, by a referenced mission or member leaving the board, by withdrawal or by replacement becomes no decision. A request and its answers are not tool permission and do not mark criteria met. After placing the request the call waits up to ${DECISION_WAIT_MS / 60_000} minutes: answers given in that time return in the result (answered: true, answers) and are recorded as decisions; own: true on an answer means the person discarded every offered option and gave their own answer in text; a request cleared meanwhile returns cleared: true; otherwise the result says answered: false and answers given later arrive in this session as input. While the call waits, messages from members arrive only after it returns. ${BOARD_REFERENCES}`,
      z.object({ objectiveId: ids, expectedRevision: z.number().int().min(0), questions: z.array(decisionQuestionSchema.extend({ pin })).min(1).max(MAX_DECISION_QUESTIONS) }).strict(),
      async ({ expectedRevision, questions }, objective, _caller, context) => {
        if (objective.edited) return refuse("board_changed", { hint: BOARD_CHANGED });
        const placed = store.decisionRequest(objective.id, { expectedRevision, questions: questions.map(({ pin: questionPin, ...question }) => ({ ...question, text: withPin(question.text, questionPin, MAX_DECISION_QUESTION) })) });
        const kept = store.find(objective.id)?.decisionRequest;
        const head = { ok: true, requestId: placed.request.id, replacedRequestId: placed.replacedRequestId,
          ...(kept?.id === placed.request.id ? { stored: { questions: kept.questions.map((question) => ({ id: question.id, text: storedText(question.text), ...(question.options.length ? { options: question.options.map((option) => storedText(option.label)) } : {}) })) } } : {}) };
        const outcome = await launch.awaitDecision(objective.id, placed.request.id, decisionWaitMs, context.signal);
        const revision = store.find(objective.id)?.decisionRequestRevision ?? placed.objective.decisionRequestRevision;
        if (outcome === null) return text({ ...head, decisionRequestRevision: revision, answered: false });
        if (outcome === "cleared") return text({ ...head, decisionRequestRevision: revision, answered: false, cleared: true });
        // 사람이 보드에서 고른 것 — 질문 문장과 고른 선택지 이름, 직접 쓴 말. 선택지를 모두 버린 답은 own 으로 가른다.
        const decisions = store.find(objective.id)?.decisions ?? [];
        const answers = outcome.map((answer) => {
          const by = decisions.find((decision) => decision.requestId === placed.request.id && decision.questionId === answer.questionId)?.by ?? "human";
          const question = placed.request.questions.find((candidate) => candidate.id === answer.questionId);
          const selected = answer.selectedOptionIds.flatMap((id) => question?.options.filter((option) => option.id === id).map((option) => option.label) ?? []);
          return { question: question?.text ?? "", by, ...(selected.length ? { selected } : {}), ...(answer.text ? { text: answer.text } : {}), ...(question && ownAnswer(question, answer) ? { own: true } : {}) };
        });
        return text({ ...head, decisionRequestRevision: revision, answered: true, answers });
      }),
    commanderTool("withdraw_decision_request", "Withdraw the current decision request named by requestId. With no current request nothing changes; a different current request is refused as decision_request_changed. A withdrawal is not the person's answer, so it leaves no decision; decisions, missions and criteria stay as they are.",
      z.object({ objectiveId: ids, requestId: ids }).strict(),
      ({ requestId }, objective) => {
        const withdrawn = store.decisionWithdraw(objective.id, requestId);
        return text({ ok: true, withdrawn: withdrawn.withdrawn, decisionRequestRevision: withdrawn.objective.decisionRequestRevision });
      }),
    commanderTool("enlist", "Add members to the roster, each a role and an optional brief; plan accepts members only while the roster is empty. A new member has no session until muster brings it up.",
      z.object({ objectiveId: ids, members: z.array(memberAddSchema.pick({ role: true, brief: true })).min(1).max(MAX_MISSIONS) }).strict(),
      ({ members }, objective) => {
        // 한 명씩 저장하므로 상한을 넘길 요청은 아무도 더하기 전에 거절한다 — 일부만 남은 채 실패로 답하지 않는다.
        if (objective.members.length + members.length > MAX_MISSIONS) return refuse("too_many_members");
        const before = new Set(objective.members.map((member) => member.id));
        let current = objective;
        for (const member of members) current = store.memberAdd(objective.id, member, "commander");
        return text({ ok: true, members: current.members.filter((member) => !before.has(member.id)).map((member) => ({ id: member.id, role: member.role })) });
      }),
    commanderTool("muster", "Bring every roster member to a live session: absent members launch waiting for a first message, dormant ones resume their own session, live ones stay as they are. A waiting session costs nothing until it receives a message; a session left idle after working can go dormant, and SendMessage and ListAgents reach only live sessions. A member knows only what it has been sent and what it has read, and keeps that across missions. Its results reach the board only when it reports them to the Commander by SendMessage and the Commander completes the mission, so the first message to each member says so. Replies to the Commander go to commander.session; when that session has no fixed name, the from address on the Commander's latest message is the reply address. A member whose launch or resume the host refuses comes back as state failed with its error code; the others proceed.",
      z.object({ objectiveId: ids }).strict(),
      async ({ objectiveId }, objective) => {
        if (objective.planning) return refuse("planning_only", { hint: PLANNING_ONLY });
        return text({ members: (await launch.muster(objectiveId)).map(({ operationId: _operationId, ...member }) => member) });
      }),
    commanderTool("complete_mission", `Mark a mission done with a text record and optional PR, sealed-file or Artifact-link results the person can open from the objective. A file mentioned in summary is not an attached result. Results are linked automatically to this mission, not to an individual record. Repeating completion appends a record and adds results; omitted or empty results preserve existing results. Duplicate normalized PR or Artifact URLs, or evidenceIds, within the request or already attached, are refused as result_exists. A refused result leaves this completion's record, results and mission state unchanged. The objective holds at most ${RESULT_LIMITS.count} results, including ${RESULT_LIMITS.evidenceCount} evidence files totaling at most ${RESULT_LIMITS.totalEvidenceBytes / 1024 / 1024} MiB. Calls that add results return their new resultIds in input order. Results alone do not establish that a success criterion is met. Once the person completes the objective, calls with or without results are refused as objective_done.`,
      z.object({ ...missionRef,
        summary: z.array(z.string().max(2000)).min(1).max(20).describe(`The stored record is 1–${MAX_RECORD_LINES} lines, conclusion first, each at most ${MAX_RECORD_LINE} characters. Retained records are visible to the person; the latest is shown with the missions that follow.`),
        results: completionResultsSchema.optional().describe("Optional new results: github.com PR URLs, evidenceIds produced by seal_evidence_from_path for this objective, or claude.ai Artifact links. Evidence accepts neither file paths nor URLs. PR status is server-observed, not caller-supplied. Artifact links accept only https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<uuid>. The server does not fetch or observe Artifact links; unlike sealed evidence, no content copy is preserved. Artifact links count toward the total result limit, not the evidence limits."),
      }).strict(),
      (args, objective) => {
        if (objective.planning) return refuse("planning_only", { hint: PLANNING_ONLY });
        const target = missionOf(objective, args);
        const lines = recordLines(args.summary);
        if (!lines) return refuse("summary_format", { hint: `A record is 1–${MAX_RECORD_LINES} lines, each at most ${MAX_RECORD_LINE} characters.` });
        const done = store.missionDone(objective.id, target.id, lines, args.results);
        const resultIds = done.results.slice(objective.results.length).map((result) => result.id);
        if (resultIds.length) prStatus?.refresh(objective.id);
        // 마지막 임무를 마쳤다 — 인계 대기로 넘어갔으면 인계를, 아니면 달성 기준을 스스로 다시 따지게 한다. 이미 넘긴 목표에는 붙이지 않는다.
        const next = done.awaitingHandoff ? handoffPrompt(done) : done.missions.every((mission) => mission.done) && !done.awaitingReview ? criteriaCheckPrompt(done) : undefined;
        const record = store.find(objective.id)?.missions.find((entry) => entry.id === target.id)?.records.at(-1);
        return text({ ok: true, missionId: target.id, ...(record ? { stored: { record: record.lines.map(storedText) } } : {}), ...(resultIds.length ? { resultIds } : {}), ...(next ? { next } : {}) });
      }),
    commanderTool("followup", `Follow-up candidates: findings outside this objective's scope, each with evidence. A candidate holds an improvement to the product features of the project worked on, as its users experience them; a finding with no user impact is not placed on the objective and stays only in the Commander's final report. Candidates can be added at any time until the objective is complete. add a candidate {title, summary (one line), userImpact (one line: what a user experiences differently), fromMission (the missionId of this objective's mission it came from), brief, criteria (1–10), evidence (1–5 of file {path relative to the Theater root, line?}, command {text}, artifact {path}, each with an optional note; at least one is a file with a line or a command)}; revise {id, changed fields} or withdraw {id} while it is open. At most ${MAX_FOLLOWUPS} active per objective. When the person completes this objective they may pick candidates; each picked one becomes a dormant objective carrying that title, brief and criteria and no missions, and its evidence reaches that objective's Commander. A picked candidate is frozen; the person can also discard candidates.`,
      z.object({ objectiveId: ids, add: followupBodySchema.optional(), revise: followupReviseSchema.extend({ id: ids }).optional(), withdraw: z.object({ id: ids }).strict().optional() }).strict(),
      (args, objective) => {
        const actions = [args.add, args.revise, args.withdraw].filter((value) => value !== undefined);
        if (actions.length !== 1) return refuse("invalid_arguments", { hint: "Exactly one of add, revise or withdraw." });
        if (args.add) { const candidate = added(objective.followups, store.followupAdd(objective.id, args.add).followups); return text({ ok: true, ...(candidate ? { id: candidate.id } : {}) }); }
        if (args.revise) { const { id, ...patch } = args.revise; store.followupRevise(objective.id, id, patch); return text({ ok: true, id }); }
        store.followupWithdraw(objective.id, args.withdraw!.id);
        return text({ ok: true, id: args.withdraw!.id });
      }),
    // 회고 형식이 어긋나면 invalid_arguments 대신 형식을 말하는 거절로 — 입력 스키마는 모델에게 온전한 모양을 보인다.
    { ...commanderTool("hand_off", `Hand an objective awaiting hand-off to the person's review with a retrospective: the Commander's synthesis of the members' retrospectives and its own. ${RETROSPECTIVE_FORMAT} because and ifOnly point at instructions, skills, tools or approaches; whoever maintains those reads each pair on its own, without this objective's context. The retrospective stays on the objective as a record and does not become work. A hand-off does not depend on the number of follow-up candidates. Refused as not_awaiting_handoff, with the open mission and unmet criterion numbers, unless every mission is done, every criterion is met and it has not been handed off; a hand-off on a board the person has since edited is refused as board_changed.`,
      z.object({ objectiveId: ids, retrospective: z.unknown() }).strict(),
      (args, objective) => {
        if (objective.criteriaProposals.length) return refuse("criteria_pending");
        if (objective.edited) return refuse("board_changed", { hint: BOARD_CHANGED });
        if (!objective.awaitingHandoff) return refuse("not_awaiting_handoff", notAwaitingHandoff(objective, numbered.get(objective.id) ?? []));
        const retrospective = retrospectiveSchema.safeParse(args.retrospective);
        if (!retrospective.success) return refuse("retrospective_format", { hint: RETROSPECTIVE_FORMAT });
        store.handOff(objective.id, { by: "commander", retrospective: retrospective.data });
        return text({ ok: true });
      }), inputSchema: z.toJSONSchema(z.object({ objectiveId: ids, retrospective: retrospectiveSchema }).strict()) },
    commanderTool("mark_criterion", "Mark success criterion n met with one line of evidence, or met: false to withdraw it. The evidence line is text only: it neither resolves evidenceIds nor attaches results. PRs, sealed files and Artifact links are optional results of complete_mission; attaching them does not mark a criterion met. Once every mission is done and every criterion is met, the objective awaits hand-off; it reaches the person's review only when handed off, and the person completes it. New or reopened missions clear the earlier marks and any hand-off; in an active extension round, old criterion marks stay until its hand-off: withdrawing one is refused as recheck_approval_required, and only a planning recheck the person approves clears it. The previous hand-off stays in the extension history. A mark made on a board the person has since edited is refused as board_changed.",
      z.object({ objectiveId: ids, n: z.number().int().min(1), met: z.boolean(), evidence: z.string().trim().max(MAX_EVIDENCE).optional() }).strict(),
      (args, objective) => {
        if (objective.criteriaProposals.length) return refuse("criteria_pending");
        if (objective.edited) return refuse("board_changed", { hint: BOARD_CHANGED });
        const target = objective.criteria[args.n - 1];
        if (!target) return refuse("unknown_criterion", { criteria: objective.criteria.length });
        if (args.met && !args.evidence) return refuse("evidence_required", { hint: "A met mark carries one line of evidence." });
        const next = store.criterionMet(objective.id, target.id, args.met ? args.evidence! : null);
        const kept = store.find(objective.id)?.criteria.find((entry) => entry.id === target.id);
        return text({ ok: true, n: args.n, met: args.met, ...(kept ? { stored: { text: storedText(kept.text), ...(kept.met ? { evidence: storedText(kept.met) } : {}) } } : {}), ...(next.awaitingHandoff ? { next: handoffPrompt(next) } : {}) });
      }),
  ];
}

/** 인계 대기가 아닌 이유 — 남은 임무·미충족 기준 번호, 이미 넘겼거나 완료된 목표. */
function notAwaitingHandoff(objective: Objective, numbering: readonly string[]) {
  return {
    ...(objective.done ? { done: true } : objective.handoff ? { handedOff: true } : {}),
    // 지휘관의 번호표로 — 번호표에 없는(사람이 그 뒤 더한) 임무는 missionId 로.
    openMissions: objective.missions.flatMap((mission) => (mission.done ? [] : [numbering.indexOf(mission.id) + 1 || mission.id])),
    unmetCriteria: objective.criteria.flatMap((criterion, index) => (criterion.met ? [] : [index + 1])),
    ...(objective.missions.length === 0 ? { missions: 0 } : {}),
  };
}

function handoffInventory(objective: Objective): string {
  const candidates = objective.followups.filter((candidate) => candidate.state === "open").length;
  const results = objective.results.length;
  return `The objective holds ${candidates} follow-up ${candidates === 1 ? "candidate" : "candidates"} and ${results} attached ${results === 1 ? "result" : "results"}. Hand-off has no minimum result count.`;
}

/**
 * 인계 전환 — 할 일이 끝나 인계 대기로 넘어간 지휘관에게 돌려주는 사실. 목표를 넘어 남는 것(후보)과 목표와 함께 끝나는 것
 * (기록·메시지), 지금 후보·결과물 수, 인계의 단계만 말한다. 상한은 말하지 않고, 후보 0건도 인계가 된다는 사실을 함께 둔다 —
 * 판단을 요구할 뿐 등록을 요구하지 않는다.
 */
export function handoffPrompt(objective: Objective): string {
  const members = objective.members.length > 0;
  return [
    "Every mission is done and every criterion is met: the objective awaits hand-off, and it reaches the person's review only through hand_off.",
    `Only follow-up candidates carry beyond this objective; mission records and messages end with it, so a finding that is not a candidate reaches no later objective. ${handoffInventory(objective)} A hand-off with no follow-up candidates is valid.`,
    members
      ? "The hand-off step: the Commander requests each member's retrospective by SendMessage, gathers them, and synthesizes them with its own into the retrospective that hand_off carries. Members also report the worktrees, branches and isolated processes they created for this objective and whether they are still in use. Before hand_off, the Commander removes those it has confirmed as this objective's that no session still uses, except one holding unmerged work the person has not authorized discarding; it records why each kept one stays. One only its creator may remove goes back to that member. Resources of other sessions or objectives, or of uncertain ownership, stay untouched. SendMessage reaches only live sessions; muster brings dormant members back."
      : "The hand-off step: the Commander writes the retrospective that hand_off carries.",
  ].join("\n\n");
}

/**
 * 달성 점검 — 마지막 임무를 마친 지휘관에게 도구 응답으로 돌려주는 사실. 지시 대신 판단의 무게(사람이 이 판단을 믿고
 * 다시 확인하지 않는다)를 말해 모델이 스스로 기준을 다시 따지게 한다. 기준이 모두 충족돼 있으면 이미 검토 대기다.
 */
export function criteriaCheckPrompt(objective: Objective): string {
  if (objective.criteriaProposals.length) return "Success-criterion proposals await the person's decision; the objective cannot reach review yet.";
  const open = objective.criteria.map((criterion, index) => ({ criterion, n: index + 1 })).filter(({ criterion }) => !criterion.met);
  if (open.length === 0) return handoffPrompt(objective);
  const list = open.map(({ criterion, n }) => `${n}. ${criterion.text}`).join("\n");
  return `Every mission is done. The objective awaits hand-off once each criterion below is marked met with evidence; the person relies on that judgment rather than re-checking, and a criterion that does not hold yet means the objective is not finished.\n\n${handoffInventory(objective)}\n\nCriteria not yet met:\n${list}`;
}
