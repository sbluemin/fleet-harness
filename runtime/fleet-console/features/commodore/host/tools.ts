import { nextRoutineAt } from "../shared/routines.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ConsoleMcpTool } from "../../execution/shared/tools.js";
import { defineConsoleTool } from "../../execution/shared/actions.js";
import { z } from "zod";

import { decisionQuestionSchema, MAX_DECISION_QUESTIONS, ownAnswer } from "../shared/contracts/questions.js";
import { commodoreSessionToolName } from "../shared/tool-names.js";
import { refuse, text } from "./tool-results.js";
import { MAX_MEMORY_BODY, MAX_MEMORY_DESCRIPTION, MAX_MEMORY_LINKS, MAX_MEMORY_SOURCES, MAX_MEMORY_TITLE, memoryBranchSchema, memoryRefSchema, type MemoryEntry, type MemorySource } from "./memory.js";
import { memorySearchInputSchema, searchCommodoreLedger, type MemorySearchTaskforce } from "./memory-search.js";

export type { MemorySearchTaskforce as CommodoreTaskforceLedger };
import { TaskforceStoreError } from "./taskforce/errors.js";
import { MAX_TASKFORCE_MEMBERS, MAX_TASKFORCE_POST_TEXT, MAX_TASKFORCE_TEXT, RECOMMENDED_TASKFORCE_POST_TEXT, TASKFORCE_ID } from "../shared/contracts/taskforce.js";
import { askAnswerLines, type CommodoreStore } from "./store.js";
import type { CommodoreDescriptionProposals } from "./description-proposals.js";
import type { CommodoreIntelProposals } from "./intel-proposals.js";
import { MEMORY_STALE_MS } from "../shared/contracts/memory-stale.js";
import { MAX_ASK_REASON, MAX_DESCRIPTION, MAX_INTEL_TEXT, routineScheduleSchema, type CommodoreAsk, type CommodoreSource } from "../shared/contracts/types.js";

/**
 * 사령관 전용 도구 — `fleet-commodore` 묶음으로 사령관 세션에만 실린다. 다른 세션·Console Use 에는 없다.
 *
 * 여덟 도구다: description·intel·memory·conversation·ask·routines·taskforce와
 * 사령관 연락·생성의 commodores(console-tools). 바꾸는 일은 같은 도구의
 * action 입력으로 고른다. 되돌리기 어려운 일(memory 지움)은 그 입력에 밝힌다.
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
  /**
   * 속한 TaskForce 원장 — 판단 턴의 말하기와 conversation의 읽기에 닿는다.
   * 없으면 TF 도구를 거절한다(판단 런타임이 없는 호스트).
   */
  readonly taskforce?: MemorySearchTaskforce;
  /**
   * 설명·정보 변경 제안. 있으면 제안·목록 도구가 붙는다. 승인·거절은 여기서 없다 — 사람은 라우트로만 답한다.
   * 기억은 제안이 아니다. memory save 가 그대로 쓴다.
   */
  readonly proposals?: CommodoreDescriptionProposals;
  readonly intelProposals?: CommodoreIntelProposals;
}

/** 같은 턴에 바로잡을 수 있게 거절 사유를 돌려준다 — TaskforceStoreError의 details가 힌트를 싣는다. */
const fail = (error: unknown) => {
  const code = error instanceof Error ? error.message : "commodore_failed";
  const details = error instanceof TaskforceStoreError ? error.details ?? {} : {};
  return refuse(/^[a-z_]{1,64}$/.test(code) ? code : "commodore_failed", details);
};

const parseFail = (parsed: { readonly error: string; readonly issues?: unknown }) =>
  refuse(parsed.error, { issues: parsed.issues });

const rename = (tool: ConsoleMcpTool): ConsoleMcpTool => {
  const name = commodoreSessionToolName(tool.name);
  return name === tool.name ? tool : { ...tool, name };
};

export function createCommodoreTools(options: CommodoreToolsOptions): readonly ConsoleMcpTool[] {
  const now = options.now ?? Date.now;
  const run = options.execute ?? defaultExecute;
  const caller = { caller: "commodore" } as const;
  const state = () => {
    const current = options.store.read(options.commodoreId);
    if (!current) throw new Error("theater_unavailable");
    return current;
  };

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
  const memoryFields = {
    title: z.string().trim().min(1).max(MAX_MEMORY_TITLE),
    description: z.string().trim().min(1).max(MAX_MEMORY_DESCRIPTION),
    why: z.string().trim().min(1).max(MAX_MEMORY_BODY).describe("Why it matters; no secrets."),
    how: z.string().trim().min(1).max(MAX_MEMORY_BODY).describe("How to apply it; no secrets, no ## headings."),
    sourceObjectiveIds: z.array(z.string().min(1).max(128)).max(MAX_MEMORY_SOURCES).describe("This Theater's objectives."),
    links: z.array(memoryRefSchema).max(MAX_MEMORY_LINKS).describe("Related entries by ref; no secrets."),
  };

  const proposals = options.proposals;
  const intelProposals = options.intelProposals;

  const memorySpec = defineConsoleTool({
    name: "console_memory",
    description: "Private fleet-memory: save durable facts absent from other records; recheck before relying on them. Commanders cannot read it; pass relevant context in remarks.",
    actions: {
      list: { kind: "read", callers: ["commodore"], input: z.object({}) },
      view: { kind: "read", callers: ["commodore"], input: z.object({ ref: memoryRefSchema.describe("Entry ref (branch/topic/slug). stale marks entries needing a recheck.") }) },
      save: { kind: "write", callers: ["commodore"], input: z.object({ branch: memoryBranchSchema.describe("person: preferences; theater: Theater facts; lessons: what objectives taught; crew: lineups."), topic: z.string().min(1).max(40).describe("Group name, as written."), slug: z.string().min(1).max(64).describe("Lowercase-hyphen name, unique in its topic; no secrets."), ...memoryFields, sourceObjectiveIds: memoryFields.sourceObjectiveIds.optional(), links: memoryFields.links.optional() }) },
      update: { kind: "write", callers: ["commodore"], input: z.object({ ref: memoryRefSchema.describe("Entry ref to change; alone records a recheck."), title: memoryFields.title.optional(), description: memoryFields.description.optional(), why: memoryFields.why.optional(), how: memoryFields.how.optional(), sourceObjectiveIds: memoryFields.sourceObjectiveIds.optional(), links: memoryFields.links.optional() }) },
      delete: { kind: "write", callers: ["commodore"], input: z.object({ ref: memoryRefSchema.describe("Entry ref to delete."), reason: z.string().trim().min(1).max(200).describe("Why it no longer applies. Deletion is permanent.") }) },
    },
  });
  const memory: ConsoleMcpTool = rename(memorySpec.plugin({
    execute: async (raw) => {
      const parsed = memorySpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      try {
        const call = parsed.call;
        if (call.action === "list") {
          return text({ entries: options.store.memory.list(options.commodoreId).map(memoryView) });
        }
        if (call.action === "view") {
          const entry = options.store.memory.read(options.commodoreId, call.ref);
          return text({ ...memoryView(entry), why: entry.why, how: entry.how, sources: entry.sources, links: entry.links, created: stamp(entry.created) });
        }
        if (call.action === "save") {
          const { branch, topic, slug, title, description, why, how, sourceObjectiveIds, links } = call;
          const sources = memorySources(sourceObjectiveIds);
          const entry = options.store.memory.save(options.commodoreId, { branch, topic, slug, title, description, why, how, ...(sources ? { sources } : {}), ...(links ? { links } : {}) });
          return text(memoryView(entry));
        }
        if (call.action === "update") {
          const { action: _dispatched, ref, sourceObjectiveIds, ...fields } = call;
          const sources = memorySources(sourceObjectiveIds);
          const { entry, change } = options.store.memory.update(options.commodoreId, ref, { ...fields, ...(sources ? { sources } : {}) });
          return text({ ...memoryView(entry), change });
        }
        options.store.memory.remove(options.commodoreId, call.ref);
        return text({ ref: call.ref, deleted: true });
      } catch (error) { return fail(error); }
    },
  }, caller));

  const searchShape = memorySearchInputSchema.shape;
  const anchorSchema = z.object({ source: z.string().min(1).max(128), seq: z.number().int().nonnegative() }).strict();
  const conversationSpec = defineConsoleTool({
    name: "console_conversation",
    description: "Reread retained conversation: your own record and joined TaskForces. Reads stored records only.",
    actions: {
      search: { kind: "read", callers: ["commodore"], input: z.object({ target: searchShape.target.describe("Default all."), taskforceId: searchShape.taskforceId.describe("Narrow to one TaskForce."), query: searchShape.query.describe("Literal case-insensitive substring. Omit for recent entries; in around results it only marks matches."), since: searchShape.since.describe("Entries at or after this epoch-ms time."), until: searchShape.until.describe("Entries at or before this epoch-ms time."), speaker: searchShape.speaker, limit: searchShape.limit.describe("Default 20; follow nextCursor."), cursor: searchShape.cursor.describe("Next page token. Never combine with a scan token."), scan: searchShape.scan.describe("nextScan token for older ledgers. Never combine with cursor.") }) },
      around: { kind: "read", callers: ["commodore"], input: z.object({ anchor: anchorSchema.describe("A search result's source and seq."), before: searchShape.before.describe("Default 5."), after: searchShape.after.describe("Default 5."), query: searchShape.query.describe("Literal case-insensitive substring. Omit for recent entries; in around results it only marks matches.") }) },
    },
  });
  const conversation: ConsoleMcpTool = rename(conversationSpec.plugin({
    execute: async (raw) => {
      const parsed = conversationSpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      try {
        const call = parsed.call;
        const entry = call.action === "search"
          ? searchCommodoreLedger(options.commodoreId, state().alias ?? null,
            { ...(call.target !== undefined ? { target: call.target } : {}), ...(call.taskforceId !== undefined ? { taskforceId: call.taskforceId } : {}), ...(call.query !== undefined ? { query: call.query } : {}), ...(call.since !== undefined ? { since: call.since } : {}), ...(call.until !== undefined ? { until: call.until } : {}), ...(call.speaker !== undefined ? { speaker: call.speaker } : {}), ...(call.limit !== undefined ? { limit: call.limit } : {}), ...(call.cursor !== undefined ? { cursor: call.cursor } : {}), ...(call.scan !== undefined ? { scan: call.scan } : {}) },
            { store: options.store, ...(options.taskforce ? { taskforce: options.taskforce } : {}) })
          : searchCommodoreLedger(options.commodoreId, state().alias ?? null,
            { anchor: call.anchor, ...(call.before !== undefined ? { before: call.before } : {}), ...(call.after !== undefined ? { after: call.after } : {}), ...(call.query !== undefined ? { query: call.query } : {}) },
            { store: options.store, ...(options.taskforce ? { taskforce: options.taskforce } : {}) });
        return text(entry);
      } catch (error) { return fail(error); }
    },
  }, caller));

  const descriptionSpec = defineConsoleTool({
    name: "console_description",
    description: proposals
      ? "The person's account of who you are and what you are for: current text and revision. You cannot edit it; propose changes for the person to approve."
      : "The person's account of who you are and what you are for: current text and revision. You cannot edit it.",
    actions: {
      read: { kind: "read", callers: ["commodore"], input: z.object({}) },
      propose: { kind: "write", callers: ["commodore"], input: z.object({ targetId: z.string().min(1).max(128).describe("Any Commodore's id, including your own. A new proposal replaces the previous one."), text: z.string().max(MAX_DESCRIPTION).describe("New description. Approving overwrites the current text; nothing changes until then.") }) },
      proposals: { kind: "read", callers: ["commodore"], input: z.object({}) },
      withdraw: { kind: "write", callers: ["commodore"], input: z.object({ id: z.string().uuid().describe("Proposal id from proposals; only your own.") }) },
    },
  });
  const description: ConsoleMcpTool = rename(descriptionSpec.plugin({
    execute: async (raw) => {
      const parsed = descriptionSpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      try {
        const call = parsed.call;
        if (call.action === "read") {
          const { description: current } = state();
          return text({ text: current.text, rev: current.rev, updatedAt: stamp(current.updatedAt) });
        }
        if (!proposals) throw new Error("proposal_unavailable");
        if (call.action === "propose") {
          const proposed = proposals.propose(call.targetId, call.text);
          return text({ id: proposed.id, targetId: call.targetId, status: proposed.status, createdAt: stamp(proposed.createdAt) });
        }
        if (call.action === "proposals") {
          return text({
            proposals: proposals.list().map((proposed) => {
              const payload = proposed.payload as { targetId: string; text: string };
              return { id: proposed.id, targetId: payload.targetId, text: payload.text, status: proposed.status, createdAt: stamp(proposed.createdAt) };
            }),
          });
        }
        const withdrawn = proposals.withdraw(call.id);
        return text({ id: withdrawn.id, status: withdrawn.status, ...(withdrawn.reason ? { reason: withdrawn.reason } : {}) });
      } catch (error) { return fail(error); }
    },
  }, caller));

  // since 는 「이미 본 가장 최신 항목」이다 — 그 뒤에 들어온 항목과, 그 항목이 들어온 뒤 사람이 고친 항목(더 오래된 것·since 자신 포함)을 함께 돌려준다.
  // 고친 항목은 id·출처·자리가 그대로라 앞에서부터 자르면 놓친다. 이미 읽은 고침이 같은 editedAt 으로 다시 올 수 있다.
  const intelSpec = defineConsoleTool({
    name: "console_intel",
    description: intelProposals
      ? "Intel: dated, attributed information, newest first, plus sources. It informs judgment; it does not command. You cannot write intel; propose changes."
      : "Intel: dated, attributed information, newest first, plus sources. It informs judgment; it does not command.",
    actions: {
      read: { kind: "read", callers: ["commodore"], input: z.object({ since: z.string().min(1).max(128).optional().describe("Newest item id you saw."), limit: z.number().int().min(1).max(200).optional().describe("Default 50 for read, 30 for issues.") }) },
      issues: { kind: "read", callers: ["commodore"], input: z.object({ sourceId: z.string().min(1).max(128).describe("Source id from read."), state: z.enum(["open", "closed", "all"]).optional().describe("Default open."), limit: z.number().int().min(1).max(MAX_ISSUES).optional().describe("Default 50 for read, 30 for issues.") }) },
      propose: { kind: "write", callers: ["commodore"], input: z.object({ kind: z.enum(["add", "edit", "remove"]), targetId: z.string().min(1).max(128).describe("Any Commodore, including yourself. A new proposal replaces the previous one."), intelId: z.string().min(1).max(128).optional().describe("Item id for edit/remove."), text: z.string().trim().min(1).max(MAX_INTEL_TEXT).optional().describe("New text. An add is attributed to you. Nothing is stored until approval.") }) },
      proposals: { kind: "read", callers: ["commodore"], input: z.object({}) },
      withdraw: { kind: "write", callers: ["commodore"], input: z.object({ id: z.string().uuid().describe("Proposal id from proposals; only your own.") }) },
    },
  });
  const intel: ConsoleMcpTool = rename(intelSpec.plugin({
    execute: async (raw, context) => {
      const parsed = intelSpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      try {
        const call = parsed.call;
        if (call.action === "read") {
          const { intel: items, sources } = state();
          const end = call.since ? items.findIndex((item) => item.id === call.since) : -1;
          const seenAt = end >= 0 ? items[end]!.at : 0;
          const scoped = end >= 0 ? items.filter((item, index) => index < end || (item.editedAt ?? 0) > seenAt) : items;
          const sliced = scoped.slice(0, call.limit ?? 50).map((item) => ({ id: item.id, at: stamp(item.at), ...(item.editedAt !== undefined ? { editedAt: stamp(item.editedAt) } : {}), source: item.source, text: item.text }));
          return text({ items: sliced, truncated: sliced.length < scoped.length, ...(call.since && end < 0 ? { sinceUnknown: true } : {}), sources: sources.map(sourceView) });
        }
        if (call.action === "issues") {
          const source = state().sources.find((entry) => entry.id === call.sourceId);
          if (!source) throw new Error("unknown_source");
          if (source.kind !== "github-issues") return text({ source: sourceView(source), hint: "This source is a URL. Read it with WebFetch." });
          if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source.locator)) throw new Error("invalid_source");
          const args = ["issue", "list", "-R", source.locator, "--state", call.state ?? "open", "--limit", String(call.limit ?? 30), "--json", "number,title,state,updatedAt,labels,url"];
          const { stdout } = await run("gh", args, { cwd: options.cwd ?? options.theaterRoot, signal: context.signal }).catch((error: unknown) => { throw new Error(commandFailure(error, "gh_failed")); });
          const listed = JSON.parse(stdout) as readonly { number?: number; title?: string; state?: string; updatedAt?: string; labels?: readonly { name?: string }[]; url?: string }[];
          return text({ source: sourceView(source), issues: listed.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, updatedAt: issue.updatedAt, labels: (issue.labels ?? []).map((label) => label.name).filter((name): name is string => typeof name === "string"), url: issue.url })) });
        }
        if (!intelProposals) throw new Error("proposal_unavailable");
        if (call.action === "proposals") {
          return text({
            proposals: intelProposals.list().map((proposed) => {
              const payload = proposed.payload as { kind: string; targetId: string; intelId?: string; text?: string };
              return { id: proposed.id, kind: payload.kind, targetId: payload.targetId, ...(payload.intelId ? { intelId: payload.intelId } : {}), ...(payload.text !== undefined ? { text: payload.text } : {}), status: proposed.status, createdAt: stamp(proposed.createdAt) };
            }),
          });
        }
        if (call.action === "withdraw") {
          const withdrawn = intelProposals.withdraw(call.id);
          return text({ id: withdrawn.id, status: withdrawn.status, ...(withdrawn.reason ? { reason: withdrawn.reason } : {}) });
        }
        if (call.kind === "add") {
          if (!call.text || call.intelId) throw new Error("invalid_request");
          const proposed = intelProposals.proposeAdd(call.targetId, call.text);
          return text({ id: proposed.id, kind: call.kind, targetId: call.targetId, status: proposed.status, createdAt: stamp(proposed.createdAt) });
        }
        if (!call.intelId || (call.kind === "edit" && !call.text) || (call.kind === "remove" && call.text)) throw new Error("invalid_request");
        const proposed = call.kind === "edit"
          ? intelProposals.proposeEdit(call.targetId, call.intelId, call.text ?? "")
          : intelProposals.proposeRemove(call.targetId, call.intelId);
        return text({ id: proposed.id, kind: call.kind, targetId: call.targetId, status: proposed.status, createdAt: stamp(proposed.createdAt) });
      } catch (error) { return fail(error); }
    },
  }, caller));

  // 사람에게 묻기 — 보드 항목이 아닌 물음. 질문 모양과 상한은 지휘관의 결정 요청과 같다(멤버·임무 가리킴만 없다).
  const askSpec = defineConsoleTool({
    name: "console_ask",
    description: "Ask the person what is not a waiting board item. List reads their answer and marks it read.",
    actions: {
      send: { kind: "write", callers: ["commodore"], input: z.object({ questions: z.array(decisionQuestionSchema.omit({ missionId: true, memberId: true })).min(1).max(MAX_DECISION_QUESTIONS).describe("Questions with header, text and options (or none). The person may always write their own answer."), reason: z.string().trim().min(1).max(MAX_ASK_REASON).describe("Why you ask."), objectiveId: z.string().min(1).max(128).optional().describe("This Theater objective the question is about.") }) },
      withdraw: { kind: "write", callers: ["commodore"], input: z.object({ askId: z.string().min(1).max(128).describe("Open question id to withdraw.") }) },
      list: { kind: "read", callers: ["commodore"], input: z.object({ limit: z.number().int().min(1).max(20).optional().describe("Default 20; reading marks answers read.") }) },
    },
  });
  const ask: ConsoleMcpTool = rename(askSpec.plugin({
    execute: async (raw) => {
      const parsed = askSpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      try {
        const call = parsed.call;
        if (call.action === "send") {
          const objective = call.objectiveId ? options.objective?.(call.objectiveId) ?? null : null;
          if (call.objectiveId && !objective) throw new Error("unknown_objective");
          const { ask: created, reused } = options.store.askAdd(options.commodoreId, { questions: call.questions, reason: call.reason, objective: objective ? { id: objective.id, title: objective.title } : null });
          return text({ askId: created.id, reused, open: openCount() });
        }
        if (call.action === "withdraw") {
          const { withdrawn } = options.store.askWithdraw(options.commodoreId, call.askId);
          return text({ askId: call.askId, withdrawn, open: openCount() });
        }
        const asks = [...(state().asks ?? [])].reverse().slice(0, call.limit ?? 20);
        const answered = asks.filter((entry) => entry.settled?.outcome === "answered" && entry.readAt === undefined).map((entry) => entry.id);
        if (answered.length) options.store.askRead(options.commodoreId, answered);
        return text({ asks: asks.map(askView), open: openCount() });
      } catch (error) { return fail(error); }
    },
  }, caller));

  const routineFields = {
    name: z.string().trim().min(1).max(60).describe("Unique name (maximum 20 routines)."),
    task: z.string().trim().min(1).max(1000),
    schedule: routineScheduleSchema.describe("Daily local HH:mm, every 30-1440 min, or once (epoch-ms)."),
  };
  const routinesSpec = defineConsoleTool({
    name: "console_routines",
    description: "Your routines with enabled state and next run time. Intel sources do not push updates; use a routine when periodic checks are needed.",
    actions: {
      list: { kind: "read", callers: ["commodore"], input: z.object({}) },
      add: { kind: "write", callers: ["commodore"], input: z.object(routineFields) },
      update: { kind: "write", callers: ["commodore"], input: z.object({ routineId: z.string().min(1).max(128).describe("Which routine."), name: routineFields.name.optional(), task: routineFields.task.optional(), schedule: routineFields.schedule.optional(), enabled: z.boolean().optional().describe("Person-paused routines cannot be enabled; do not bypass by removing or recreating.") }) },
      remove: { kind: "write", callers: ["commodore"], input: z.object({ routineId: z.string().min(1).max(128).describe("Which routine."), reason: z.string().trim().min(1).max(200).describe("Why it is no longer needed.") }) },
    },
  });
  const routines: ConsoleMcpTool = rename(routinesSpec.plugin({
    execute: async (raw) => {
      const parsed = routinesSpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      try {
        const call = parsed.call;
        if (call.action === "list") return text({ routines: (state().routines ?? []).map((routine) => ({ ...routine, nextRunAt: nextRoutineAt(routine, now()) })) });
        if (call.action === "add") return text(options.store.routineAdd(options.commodoreId, { name: call.name, task: call.task, schedule: call.schedule }));
        if (call.action === "update") {
          const { action: _dispatched, routineId, ...input } = call;
          return text({ routines: options.store.routineUpdate(options.commodoreId, routineId, input, "commodore").routines });
        }
        return text({ routines: options.store.routineRemove(options.commodoreId, call.routineId, "commodore").routines });
      } catch (error) { return fail(error); }
    },
  }, caller));

  // TaskForce — 판단 턴의 말하기는 이 도구로만 한다. 침묵(호출 없음)은 흔적을 남기지 않는다.
  // 말은 공유 원장에만 닿고 1:1 기록에는 절대 쓰지 않는다.
  const taskforceSpec = defineConsoleTool({
    name: "console_taskforce",
    description: "Speak only when useful in a TaskForce you belong to; otherwise make no call. Refer to speakers and gist, not hidden sequence IDs.",
    actions: {
      post: { kind: "write", callers: ["commodore"], input: z.object({ taskforceId: z.string().regex(TASKFORCE_ID, "unknown_taskforce").describe("Exact TaskForce id from context or tools; never guess."), text: z.string().trim().min(1).max(MAX_TASKFORCE_TEXT).describe("Conclusion only; over 2000 refused. Goes to the shared ledger, never the 1:1 log."), mentions: z.array(z.string().regex(TASKFORCE_ID, "invalid_request")).max(MAX_TASKFORCE_MEMBERS).optional().describe("Fellow member ids this is for.") }) },
    },
  });
  const taskforce: ConsoleMcpTool = rename(taskforceSpec.plugin({
    execute: async (raw) => {
      const parsed = taskforceSpec.parse(raw, caller);
      if (!parsed.ok) return parseFail(parsed);
      const call = parsed.call;
      try {
        const ledger = options.taskforce;
        if (!ledger) throw new Error("taskforce_unavailable");
        if (call.text.length > MAX_TASKFORCE_POST_TEXT) throw new TaskforceStoreError("taskforce_post_too_long", undefined, { limit: MAX_TASKFORCE_POST_TEXT, length: call.text.length, hint: `Shorten to the conclusion and what the others must judge (about ${RECOMMENDED_TASKFORCE_POST_TEXT} characters); move long reasoning to the objective brief or a document and link it.` });
        try {
          const { entry } = ledger.append(call.taskforceId, { speaker: { kind: "commodore", commodoreId: options.commodoreId }, text: call.text, ...(call.mentions ? { mentions: call.mentions } : {}) });
          return text({ taskforceId: call.taskforceId, seq: entry.seq });
        } catch (error) {
          // 원래 TF 깨움이 아닌 목표 후속 턴도 같은 도구를 쓴다 — 좌표를 확인하되 현재 권한 검사를 우회하지 않는다.
          if (error instanceof TaskforceStoreError && error.code === "unknown_taskforce") throw new TaskforceStoreError(error.code, undefined, { hint: "Check the exact TaskForce id against the TaskForce context or tools; never guess or shorten it." });
          if (error instanceof TaskforceStoreError && error.code === "invalid_request") throw new TaskforceStoreError(error.code, undefined, { hint: "mentions must be exact member ids from the TaskForce context or tools." });
          throw error;
        }
      } catch (error) { return fail(error); }
    },
  }, caller));

  return [description, intel, memory, conversation, ask, routines, taskforce];
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
