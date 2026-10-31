import { nextRoutineAt } from "../shared/routines.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
import { z } from "zod";

import { decisionQuestionSchema, MAX_DECISION_ANSWER_INPUT, MAX_DECISION_HEADER_INPUT, MAX_DECISION_OPTIONS, MAX_DECISION_QUESTIONS, ownAnswer } from "../shared/contracts/questions.js";
import { refuse, text } from "./tool-results.js";
import { MAX_MEMORY_BODY, MAX_MEMORY_DESCRIPTION, MAX_MEMORY_LINKS, MAX_MEMORY_SOURCES, MAX_MEMORY_TITLE, memoryBranchSchema, memoryRefSchema, type MemoryEntry, type MemorySource } from "./memory.js";
import type { TaskforceStore } from "./taskforce/store.js";
import { MAX_TASKFORCE_TEXT, TASKFORCE_ID } from "../shared/contracts/taskforce.js";
import { askAnswerLines, type CommodoreStore } from "./store.js";
import { MEMORY_STALE_MS } from "../shared/contracts/memory-stale.js";
import { MAX_ASK_REASON, routineInputSchema, type CommodoreAsk, type CommodoreSource } from "../shared/contracts/types.js";

/**
 * 사령관 전용 도구 — `fleet-commodore` 묶음으로 사령관 세션에만 실린다. 다른 세션·Console Use 에는 없다.
 *
 * 설명·정보는 여기서만 읽힌다(시스템 프롬프트·깨움 턴에 싣지 않는다). Theater 는 Agent SDK 내장 도구(Bash·Glob·Grep·Read)로
 * 직접 다루고, 정보 출처의 이슈만 여기서 읽는다.
 */
const MAX_ISSUES = 100;
const COMMAND_TIMEOUT_MS = 20_000;
const COMMAND_BUFFER = 1024 * 1024;

export type CommandExecute = (file: "git" | "gh", args: readonly string[], options: { readonly cwd: string; readonly signal?: AbortSignal }) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const execute = promisify(execFile);
const defaultExecute: CommandExecute = async (file, args, options) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };
  delete env.GH_DEBUG;
  delete env.GH_FORCE_TTY;
  return execute(file, [...args], { cwd: options.cwd, env, signal: options.signal, timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_BUFFER, shell: false, windowsHide: true });
};

export interface CommodoreToolTheater { readonly theaterId: string; readonly label: string; readonly root: string | null }

export interface CommodoreToolsOptions {
  readonly cwd?: string;
  readonly commodoreId: string;
  /** `cwd` 가 없을 때 gh 명령이 도는 폴더. */
  readonly theaterRoot: string;
  readonly store: CommodoreStore;
  /** 이 Theater 의 목표 — 질문이 가리킬 목표를 확인한다. 없으면 목표를 가리키는 질문을 받지 않는다. */
  readonly objective?: (objectiveId: string) => { readonly id: string; readonly title: string } | null;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
  /** 지금 턴에 사람 메시지가 실렸는지 — 그 턴에 등록·수정한 루틴은 사람 요청 출처를 갖는다. 없으면 자율 턴으로 본다. */
  readonly hasPersonMessage?: () => boolean;
  /**
   * 속한 TaskForce 원장 — 판단 턴의 말하기·닫기 제안이 여기에 닿는다. 없으면 TF 도구를
   * 거절한다(판단 런타임이 없는 호스트).
   */
  readonly taskforce?: Pick<TaskforceStore, "append" | "proposeClose" | "read">;
}

export function createCommodoreTools(options: CommodoreToolsOptions): readonly ConsoleMcpTool[] {
  const now = options.now ?? Date.now;
  const run = options.execute ?? defaultExecute;
  const state = () => {
    const current = options.store.read(options.commodoreId);
    if (!current) throw new Error("theater_unavailable");
    return current;
  };
  const tool = <S extends z.ZodObject>(name: string, description: string, schema: S, body: (args: z.output<S>, context: Parameters<ConsoleMcpTool["execute"]>[1]) => Promise<unknown> | unknown): ConsoleMcpTool => ({
    name, description, inputSchema: z.toJSONSchema(schema),
    execute: async (raw, context) => {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return refuse("invalid_arguments");
      try { return text(await body(parsed.data, context)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "commodore_failed";
        return refuse(/^[a-z_]{1,64}$/.test(code) ? code : "commodore_failed");
      }
    },
  });

  const openCount = () => (state().asks ?? []).filter((ask) => !ask.settled).length;
  /** 질문 한 건 — 선택지는 이름으로, 답은 질문마다 고른 이름·직접 쓴 말·내 의견 표시로. */
  const askView = (ask: CommodoreAsk) => ({
    askId: ask.id, at: stamp(ask.at), reason: ask.reason, objectiveId: ask.objectiveId,
    state: ask.settled?.outcome ?? "open",
    questions: ask.questions.map((question) => ({ ...(question.header ? { header: question.header } : {}), text: question.text, options: question.options.map((option) => option.label), multiSelect: question.multiSelect })),
    ...(ask.settled ? { settledAt: stamp(ask.settled.at) } : {}),
    // 답 줄은 저장된 답의 순서다 — 내 의견(선택지를 모두 버리고 쓴 말) 표시는 같은 답에서 판정한다.
    ...(ask.settled?.outcome === "answered" ? { answers: askAnswerLines(ask).map((line, index) => {
      const answer = ask.settled!.answers![index]!;
      const question = ask.questions.find((entry) => entry.id === answer.questionId);
      return { ...line, ...(question && ownAnswer(question, answer) ? { own: true } : {}) };
    }) } : {}),
  });

  /** 출처 목표 — 이 Theater 보드의 목표만 받고, 제목은 저장 시점의 것을 남긴다. */
  const memorySources = (objectiveIds: readonly string[] | undefined): MemorySource[] | undefined => {
    if (objectiveIds === undefined) return undefined;
    return [...new Set(objectiveIds)].map((objectiveId) => {
      const objective = options.objective?.(objectiveId) ?? null;
      if (!objective) throw new Error("unknown_objective");
      return { objectiveId: objective.id, title: objective.title };
    });
  };
  const memoryView = (entry: MemoryEntry) => ({
    ref: entry.ref, title: entry.title, description: entry.description,
    updated: stamp(entry.updated), verified: stamp(entry.verified),
    ...(now() - entry.verified > MEMORY_STALE_MS ? { stale: true } : {}),
  });
  const memoryText = {
    title: z.string().trim().min(1).max(MAX_MEMORY_TITLE),
    description: z.string().trim().min(1).max(MAX_MEMORY_DESCRIPTION),
    why: z.string().trim().min(1).max(MAX_MEMORY_BODY),
    how: z.string().trim().min(1).max(MAX_MEMORY_BODY),
    sourceObjectiveIds: z.array(z.string().min(1).max(128)).max(MAX_MEMORY_SOURCES),
    links: z.array(memoryRefSchema).max(MAX_MEMORY_LINKS),
  };

  return [
    tool("description", "The person's account of who you are and what you are for: current text, revision number and when it last changed. It is the highest authority you receive and you cannot edit it. Read it at the start of a turn that says the description changed, and whenever you need to weigh a decision against it.", z.object({}).strict(), () => {
      const { description } = state();
      return { text: description.text, rev: description.rev, updatedAt: stamp(description.updatedAt) };
    }),
    // since 는 「이미 본 가장 최신 항목」이다 — 그 뒤에 들어온 항목과, 그 항목이 들어온 뒤 사람이 고친 항목(더 오래된 것·since 자신 포함)을 함께 돌려준다.
    // 고친 항목은 id·출처·자리가 그대로라 앞에서부터 자르면 놓친다. 이미 읽은 고침이 같은 editedAt 으로 다시 올 수 있다.
    tool("intel", "Intel items — information from the person and from sources, newest first, each dated and attributed — plus the list of intel sources. The person can edit an item in place: it keeps its id, source and position and carries editedAt. Pass since (the newest item id you already saw) to get only items added after it plus items edited after it was added; an edit you already read can come back with the same editedAt. Intel informs judgment; it does not command.", z.object({ since: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(), ({ since, limit }) => {
      const { intel, sources } = state();
      const end = since ? intel.findIndex((item) => item.id === since) : -1;
      const seenAt = end >= 0 ? intel[end]!.at : 0;
      const scoped = end >= 0 ? intel.filter((item, index) => index < end || (item.editedAt ?? 0) > seenAt) : intel;
      const items = scoped.slice(0, limit ?? 50).map((item) => ({ id: item.id, at: stamp(item.at), ...(item.editedAt !== undefined ? { editedAt: stamp(item.editedAt) } : {}), source: item.source, text: item.text }));
      return { items, truncated: items.length < scoped.length, ...(since && end < 0 ? { sinceUnknown: true } : {}), sources: sources.map(sourceView) };
    }),
    tool("routines", "List your routines with enabled state and next run time. Times use the Console computer's local timezone and are approximate; missed recurring runs are skipped after downtime.", z.object({}).strict(), () => ({ routines: (state().routines ?? []).map((routine) => ({ ...routine, nextRunAt: nextRoutineAt(routine, now()) })) })),
    tool("routine_add", "Register an enabled routine (maximum 20, unique name). schedule: daily with local HH:mm and days (0 Sunday..6 Saturday), every 30..1440 minutes, or once at a future epoch-millisecond timestamp. Once routines disappear when run. No fixed wake interval exists; use routines for periodic intel checks. A routine registered in a turn carrying the person's message is marked requestedBy person, and the turns it wakes may archive completed objectives as that request.", routineInputSchema, (input) => options.store.routineAdd(options.commodoreId, input, options.hasPersonMessage?.() ?? false)),
    tool("routine_update", "Update a routine. Enabling a routine paused by the person refuses with routine_paused_by_person; ask_person instead. Never bypass their pause by removing or recreating it. An update in a turn carrying the person's message marks the routine requestedBy person, even with unchanged fields; changing its name, task or schedule in any other turn clears that mark.", routineInputSchema.partial().extend({ routineId: z.string().min(1).max(128), enabled: z.boolean().optional() }).strict(), ({ routineId, ...input }) => ({ routines: options.store.routineUpdate(options.commodoreId, routineId, input, "commodore", options.hasPersonMessage?.() ?? false).routines })),
    tool("routine_remove", "Remove a routine that is no longer needed, stating why.", z.object({ routineId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(200) }).strict(), ({ routineId }) => ({ routines: options.store.routineRemove(options.commodoreId, routineId, "commodore").routines })),
    // 사람에게 묻기 — 보드 항목이 아닌 물음. 질문 모양과 상한은 지휘관의 결정 요청과 같다(멤버·임무 가리킴만 없다).
    tool("ask_person", `Ask the person something that is not a waiting board item (those you hand over with hand_to_person). Ask 1-${MAX_DECISION_QUESTIONS} questions. Each question has a header (a chip label of at most ${MAX_DECISION_HEADER_INPUT} characters), the question text, and either no options, when the person should write the answer, or 2-${MAX_DECISION_OPTIONS} distinct options: a concise label and an optional description; set multiSelect to allow more than one choice. The person can always write an answer of their own of up to ${MAX_DECISION_ANSWER_INPUT} characters, alongside a choice or instead of every option, so do not add an "Other" option. Their answer wakes you; read it with asks.`, z.object({
      questions: z.array(decisionQuestionSchema.omit({ missionId: true, memberId: true })).min(1).max(MAX_DECISION_QUESTIONS),
      reason: z.string().trim().min(1).max(MAX_ASK_REASON),
      objectiveId: z.string().min(1).max(128).optional(),
    }).strict(), ({ questions, reason, objectiveId }) => {
      const objective = objectiveId ? options.objective?.(objectiveId) ?? null : null;
      if (objectiveId && !objective) throw new Error("unknown_objective");
      const { ask, reused } = options.store.askAdd(options.commodoreId, { questions, reason, objective: objective ? { id: objective.id, title: objective.title } : null });
      return { askId: ask.id, reused, open: openCount() };
    }),
    tool("withdraw_ask", "Withdraw a question you asked the person that is still open (it no longer needs their answer).", z.object({ askId: z.string().min(1).max(128) }).strict(), ({ askId }) => {
      const { withdrawn } = options.store.askWithdraw(options.commodoreId, askId);
      return { askId, withdrawn, open: openCount() };
    }),
    tool("asks", "Your questions to the person: open ones, and answered or withdrawn ones with the person's answers, newest first. Reading an answer marks it read.", z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(), ({ limit }) => {
      const asks = [...(state().asks ?? [])].reverse().slice(0, limit ?? 20);
      const answered = asks.filter((ask) => ask.settled?.outcome === "answered" && ask.readAt === undefined).map((ask) => ask.id);
      if (answered.length) options.store.askRead(options.commodoreId, answered);
      return { asks: asks.map(askView), open: openCount() };
    }),
    // fleet-memory — 사령관만 쓰는 기억. 화면은 사람에게 읽기만 보여 준다. 쓰기마다 인덱스가 다시 만들어지고 다음 깨움에 실린다.
    tool("memory_view", "Your fleet-memory. Without ref: every entry as ref, title, description, updated and verified, with stale: true when it was last verified over 30 days ago. With ref (branch/topic/slug): the whole entry, including why, how, sources and links. An entry records what was true when written; confirm it before you rely on it.", z.object({ ref: memoryRefSchema.optional() }).strict(), ({ ref }) => {
      if (ref) {
        const entry = options.store.memory.read(options.commodoreId, ref);
        return { ...memoryView(entry), why: entry.why, how: entry.how, sources: entry.sources, links: entry.links, created: stamp(entry.created) };
      }
      return { entries: options.store.memory.list(options.commodoreId).map(memoryView) };
    }),
    tool("memory_save", "Save one new fact to your fleet-memory. branch: person (the person's preferences, decisions and ways of working), theater (facts about the Theater and its environment), lessons (what objectives taught) or crew (lineups, models and verification). topic groups related entries and is shown as written (letters, digits, spaces, . _ -). slug is the entry's lowercase-hyphen name, unique in its topic. why says why it matters, how says how to apply it. sourceObjectiveIds names this Theater's objectives it came from; links names related entries by ref. why and how are plain text: a line starting with '## ' is refused as memory_heading. An existing ref is refused as memory_exists: update it instead. Secrets anywhere, including the slug and links, are refused as memory_secret.", z.object({ branch: memoryBranchSchema, topic: z.string().min(1).max(40), slug: z.string().min(1).max(64), ...memoryText, sourceObjectiveIds: memoryText.sourceObjectiveIds.optional(), links: memoryText.links.optional() }).strict(), ({ branch, topic, slug, title, description, why, how, sourceObjectiveIds, links }) => {
      const sources = memorySources(sourceObjectiveIds);
      const entry = options.store.memory.save(options.commodoreId, { branch, topic, slug, title, description, why, how, ...(sources ? { sources } : {}), ...(links ? { links } : {}) });
      return memoryView(entry);
    }),
    tool("memory_update", "Change an entry of your fleet-memory by ref: the fields you pass replace the old ones, and its updated and verified times become now. Call it with ref alone to record that you checked the entry again and it still holds.", z.object({ ref: memoryRefSchema, title: memoryText.title.optional(), description: memoryText.description.optional(), why: memoryText.why.optional(), how: memoryText.how.optional(), sourceObjectiveIds: memoryText.sourceObjectiveIds.optional(), links: memoryText.links.optional() }).strict(), ({ ref, sourceObjectiveIds, ...fields }) => {
      const sources = memorySources(sourceObjectiveIds);
      const { entry, change } = options.store.memory.update(options.commodoreId, ref, { ...fields, ...(sources ? { sources } : {}) });
      return { ...memoryView(entry), change };
    }),
    tool("memory_delete", "Delete an entry of your fleet-memory that turned out wrong or no longer applies, with a one-line reason.", z.object({ ref: memoryRefSchema, reason: z.string().trim().min(1).max(200) }).strict(), ({ ref }) => {
      options.store.memory.remove(options.commodoreId, ref);
      return { ref, deleted: true };
    }),
    tool("issue_list", "List issues of a github-issues intel source (by its source id from intel): number, title, state, labels, updated date and url. Sources of kind url are read with WebFetch instead.", z.object({ sourceId: z.string().min(1).max(128), state: z.enum(["open", "closed", "all"]).optional(), limit: z.number().int().min(1).max(MAX_ISSUES).optional() }).strict(), async ({ sourceId, state: issueState, limit }, context) => {
      const source = state().sources.find((entry) => entry.id === sourceId);
      if (!source) throw new Error("unknown_source");
      if (source.kind !== "github-issues") return { source: sourceView(source), hint: "This source is a URL. Read it with WebFetch." };
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source.locator)) throw new Error("invalid_source");
      const args = ["issue", "list", "-R", source.locator, "--state", issueState ?? "open", "--limit", String(limit ?? 30), "--json", "number,title,state,updatedAt,labels,url"];
      const { stdout } = await run("gh", args, { cwd: options.cwd ?? options.theaterRoot, signal: context.signal }).catch((error: unknown) => { throw new Error(commandFailure(error, "gh_failed")); });
      const parsed = JSON.parse(stdout) as readonly { number?: number; title?: string; state?: string; updatedAt?: string; labels?: readonly { name?: string }[]; url?: string }[];
      return { source: sourceView(source), issues: parsed.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, updatedAt: issue.updatedAt, labels: (issue.labels ?? []).map((label) => label.name).filter((name): name is string => typeof name === "string"), url: issue.url })) };
    }),
    // TaskForce — 판단 턴의 말하기와 닫기 제안은 이 두 도구로만 한다. 침묵(호출 없음)은 흔적을 남기지 않는다.
    // 말은 공유 원장에만 닿고 1:1 기록에는 절대 쓰지 않는다.
    tool("taskforce_post", "Speak in a TaskForce you belong to. You are woken with the utterances you have not read yet; judge every one, and stay silent (call nothing) unless you have something worth saying to the group. Silence leaves no trace. Your words go only to the shared ledger, never to the person's 1:1 log. mentions names fellow members by id when your words are for them; it does not bypass the speaking limit.", z.object({
      taskforceId: z.string().regex(TASKFORCE_ID, "unknown_taskforce"),
      text: z.string().trim().min(1).max(MAX_TASKFORCE_TEXT),
      mentions: z.array(z.string().regex(TASKFORCE_ID, "invalid_request")).max(32).optional(),
    }).strict(), ({ taskforceId, text, mentions }) => {
      const taskforce = options.taskforce;
      if (!taskforce) throw new Error("taskforce_unavailable");
      const { entry } = taskforce.append(taskforceId, { speaker: { kind: "commodore", commodoreId: options.commodoreId }, text, ...(mentions ? { mentions } : {}) });
      return { taskforceId, seq: entry.seq };
    }),
    tool("taskforce_propose_close", "Propose closing a TaskForce you belong to, with your reason. Only the person can close it; a proposal alone changes nothing and wakes the other members to judge it.", z.object({
      taskforceId: z.string().regex(TASKFORCE_ID, "unknown_taskforce"),
      reason: z.string().trim().min(1).max(1000),
    }).strict(), ({ taskforceId, reason }) => {
      const taskforce = options.taskforce;
      if (!taskforce) throw new Error("taskforce_unavailable");
      const { entry } = taskforce.proposeClose(taskforceId, options.commodoreId, reason);
      return { taskforceId, seq: entry.seq };
    }),
  ];
}

const sourceView = (source: CommodoreSource) => ({ id: source.id, kind: source.kind, label: source.label, locator: source.locator });
const stamp = (ms: number) => new Date(ms).toISOString();

function commandFailure(error: unknown, fallback: string): string {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
  if (failure.code === "ENOENT") return "command_unavailable";
  if (failure.killed || failure.code === "ABORT_ERR") return "timeout";
  if (/gh auth login|not logged|authentication|bad credentials|GH_TOKEN/i.test(failure.stderr ?? "")) return "auth_required";
  if (/not a git repository/i.test(failure.stderr ?? "")) return "not_a_repository";
  return fallback;
}
