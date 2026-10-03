import type { AgentEvent, AgentHost, AgentSession, AgentUsage } from "@fleet-console/sdk/agent";
import { CONSOLE_READ_TOOLS } from "@fleet-console/sdk/mcp";

import { commodoreSystemPrompt, replacementNote, wakeNote } from "./prompt.js";
import type { CommodoreStore } from "./store.js";
import { COMMODORE_TOOL_GROUP, createCommodoreTools, type CommandExecute } from "./tools.js";
import { MAX_TRANSCRIPT_TEXT, type CommodoreCoordinates, type CommodoreTranscriptInput } from "./types.js";

/**
 * 사령관 세션 — `ctx.host.agent.createSession` 으로 연 플러그인 소유 세션 하나. Operation 이 아니다.
 *
 * 시스템 프롬프트는 베이스뿐이고(replace), 도구는 사령관 전용 `commodore` + Console Use(읽기 도구 + 기여된 `console_objectives`,
 * 호출자는 이 플러그인) + WebSearch·WebFetch 다. 턴은 깨움 이유만 싣는다. 세션의 onEvent 는 여기서 정제돼 Theater 의 기록
 * (`transcript.jsonl`)에 쌓이고 같은 길로 방송된다 — 도구 입력 전체·원시 오류·경로는 기록에 들어가지 않는다.
 */

export interface CommodoreSessionOptions {
  readonly theaterId: string;
  readonly theaterLabel: string;
  readonly theaterRoot: string;
  readonly agent: AgentHost;
  readonly store: CommodoreStore;
  readonly coordinates: CommodoreCoordinates;
  /** 호출마다 — 자율 운영과 실험 기능이 모두 켜져 있을 때만 Console Use 가 답한다. */
  readonly enabled: () => boolean;
  readonly onNextWake: (at: number, reason: string) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
}

export interface CommodoreTurnInput {
  readonly reasons: readonly string[];
  /** 교대·재시작 세션의 첫 턴 — 최근 행위 요약. 깨움 문장 앞에 선다. */
  readonly replacementSummary?: readonly string[];
}

export interface CommodoreTurnOutcome {
  readonly outcome: "ok" | "error" | "cancelled";
  readonly usage?: AgentUsage;
  readonly error?: string;
  /** 이 턴에서 보드에 쓴 행위 수. */
  readonly actions: number;
}

export interface CommodoreSession {
  readonly coordinates: CommodoreCoordinates;
  start(): Promise<void>;
  /** 한 턴 — 세션의 턴은 순서대로 돈다. 세션 오류는 결말로 돌아오고 던지지 않는다(폐기된 세션만 던진다). */
  turn(input: CommodoreTurnInput): Promise<CommodoreTurnOutcome>;
  /** 진행 중 턴만 멈춘다. */
  cancel(): void;
  dispose(): Promise<void>;
}

const CONSOLE_USE_SERVER_PREFIX = "mcp__fleet-console-use__";
const MCP_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;
/** 보드 행위로 세지 않는 console_objectives 동작 — 읽기. */
const READ_ACTIONS = new Set(["read", "view", "inbox", "fleet", "history", "list", "get", "mine", "evidence"]);
const MAX_SUMMARY = 200;
const MAX_ERROR = 200;

export function createCommodoreSession(options: CommodoreSessionOptions): CommodoreSession {
  const now = options.now ?? Date.now;
  let session: AgentSession | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  let turnActive = false;

  // 텍스트·사고는 델타로 온다 — 블록 단위로 모아 도구 호출·결과 경계에서 기록 한 줄로 내린다.
  let textBuffer = "";
  let thinkingBuffer = "";
  const pendingTools = new Map<string, { readonly name: string; readonly input: unknown }>();
  let turnActions = 0;
  let turnResult: CommodoreTurnOutcome | null = null;

  const record = (entry: CommodoreTranscriptInput) => {
    try { options.store.transcriptAppend(options.theaterId, entry); }
    catch (error) { console.warn(`[objectives] commodore transcript append failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const flushText = () => {
    if (textBuffer.trim()) record({ kind: "text", text: clip(textBuffer, MAX_TRANSCRIPT_TEXT) });
    textBuffer = "";
    if (thinkingBuffer.trim()) record({ kind: "thinking", text: clip(thinkingBuffer, MAX_TRANSCRIPT_TEXT) });
    thinkingBuffer = "";
  };
  const recordTool = (name: string, input: unknown, ok: boolean | undefined) => {
    const described = describeTool(name, input);
    if (described.counts && ok !== false) turnActions += 1;
    record({ kind: "tool", name: described.name, ...(described.summary ? { summary: described.summary } : {}), ...(ok === undefined ? {} : { ok }), ...(described.action ? { action: described.action } : {}), ...(described.objectiveId ? { objectiveId: described.objectiveId } : {}), ...(described.title ? { title: described.title } : {}) });
  };
  const flushTools = () => {
    for (const [, pending] of pendingTools) recordTool(pending.name, pending.input, undefined);
    pendingTools.clear();
  };
  const onEvent = (event: AgentEvent) => {
    switch (event.kind) {
      case "text": textBuffer += event.text; return;
      case "thinking": thinkingBuffer += event.text; return;
      case "tool-start":
        flushText();
        if (event.id) pendingTools.set(event.id, { name: event.name, input: event.input });
        else recordTool(event.name, event.input, undefined);
        return;
      case "tool-end": {
        flushText();
        const pending = event.id ? pendingTools.get(event.id) : undefined;
        if (event.id) pendingTools.delete(event.id);
        recordTool(pending?.name ?? event.name ?? "tool", pending?.input, !event.isError);
        return;
      }
      case "result": {
        flushText(); flushTools();
        const error = event.isError ? clip(event.detail ?? event.source, MAX_ERROR) : undefined;
        turnResult = { outcome: event.isError ? "error" : "ok", ...(event.usage ? { usage: event.usage } : {}), ...(error ? { error } : {}), actions: turnActions };
        record({ kind: "result", outcome: turnResult.outcome, ...(event.usage?.costUsd !== undefined ? { costUsd: event.usage.costUsd } : {}), ...(event.usage ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } : {}), ...(error ? { error } : {}) });
        return;
      }
      case "cancelled":
        flushText(); flushTools();
        if (!turnResult) { turnResult = { outcome: "cancelled", actions: turnActions }; record({ kind: "result", outcome: "cancelled" }); }
        return;
      default: return;
    }
  };

  const open = async () => {
    const tools = createCommodoreTools({ theaterId: options.theaterId, theaterRoot: options.theaterRoot, store: options.store, onNextWake: options.onNextWake, now, ...(options.execute ? { execute: options.execute } : {}) });
    const created = await options.agent.createSession({
      model: options.coordinates.model,
      effort: options.coordinates.effort,
      systemPrompt: commodoreSystemPrompt(options.theaterLabel),
      continuation: "conversation",
      settlement: "result",
      tools: {
        builtins: ["WebSearch", "WebFetch"],
        custom: [{ name: COMMODORE_TOOL_GROUP, tools }],
        // 읽기 도구만 요청한다 — 보드 쓰기는 기여된 console_objectives 가 맡고, 호출자는 이 플러그인으로 바인딩된다.
        consoleUse: { tools: CONSOLE_READ_TOOLS, allowControl: true, enabled: options.enabled },
      },
      onEvent,
    });
    if (disposed) { await created.dispose(); return; }
    session = created;
  };

  return {
    coordinates: options.coordinates,
    start() {
      if (disposed) return Promise.reject(new Error("session_disposed"));
      return starting ??= open();
    },
    async turn(input) {
      if (disposed) throw new Error("session_disposed");
      await this.start();
      if (!session) throw new Error("session_disposed");
      // 결말은 턴마다 하나 — 전 턴의 잔재가 이번 결말이 되지 않게 비운다.
      turnActions = 0; turnResult = null; textBuffer = ""; thinkingBuffer = ""; pendingTools.clear();
      record({ kind: "wake", reasons: input.reasons });
      const note = [...(input.replacementSummary ? [replacementNote(input.replacementSummary)] : []), wakeNote(new Date(now()), input.reasons)].join("\n\n");
      turnActive = true;
      try { await session.send(note); }
      catch (error) {
        flushText(); flushTools();
        const code = failureCode(error);
        if (!turnResult) { turnResult = { outcome: "error", error: code, actions: turnActions }; record({ kind: "result", outcome: "error", error: code }); }
      } finally { turnActive = false; }
      const result: CommodoreTurnOutcome = turnResult ?? { outcome: "error", error: "no_result", actions: turnActions };
      if (!turnResult) record({ kind: "result", outcome: "error", error: "no_result" });
      try { options.store.addRunTotals(options.theaterId, { ...(result.usage?.costUsd ? { costUsd: result.usage.costUsd } : {}), ...(result.actions ? { actions: result.actions } : {}) }); }
      catch (error) { console.warn(`[objectives] commodore totals failed: ${error instanceof Error ? error.message : String(error)}`); }
      return result;
    },
    cancel() { if (turnActive) session?.cancel(); },
    async dispose() {
      disposed = true;
      await starting?.catch(() => undefined);
      await session?.dispose();
      session = null;
    },
  };
}

interface ToolDescription {
  readonly name: string;
  readonly summary?: string;
  readonly action?: string;
  readonly objectiveId?: string;
  readonly title?: string;
  /** 보드 행위로 센다. */
  readonly counts: boolean;
}

/** 도구 호출을 기록 한 줄로 — 이름과 사람이 읽을 한 조각만. 입력 전체는 싣지 않는다. */
function describeTool(rawName: string, input: unknown): ToolDescription {
  const name = rawName.startsWith(CONSOLE_USE_SERVER_PREFIX) ? rawName.slice(CONSOLE_USE_SERVER_PREFIX.length) : rawName.replace(MCP_PREFIX, "");
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const str = (key: string) => (typeof args[key] === "string" ? clip(args[key] as string, MAX_SUMMARY) : undefined);
  if (name === "console_objectives") {
    const action = str("action");
    return { name, action, objectiveId: str("objectiveId"), title: str("title"), ...(str("view") ? { summary: `view ${str("view")}` } : {}), counts: !!action && !READ_ACTIONS.has(action) };
  }
  switch (name) {
    case "intel": return { name, summary: str("since") ? `since ${str("since")}` : undefined, counts: false };
    case "next_wake": return { name, summary: [typeof args.inMinutes === "number" ? `${args.inMinutes}m` : undefined, str("reason")].filter(Boolean).join(" · "), counts: false };
    case "read_file": case "git_log": return { name, summary: str("path"), counts: false };
    case "issue_list": return { name, summary: str("sourceId"), counts: false };
    case "WebSearch": return { name, summary: str("query"), counts: false };
    case "WebFetch": return { name, summary: str("url"), counts: false };
    default: return { name, counts: false };
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/disposed/i.test(message)) return "session_disposed";
  if (/rate|429|overloaded|limit/i.test(message)) return "rate_limited";
  if (/ECONN|ENOTFOUND|network|fetch failed|socket|timeout/i.test(message)) return "network";
  if (/^[a-z_]{1,64}$/.test(message)) return message;
  return "turn_failed";
}
