import type { AgentEffort, AgentEvent, AgentHost, AgentSession, AgentUsage } from "@fleet-console/sdk/agent";
import type { PluginMcpTool } from "@fleet-console/sdk/mcp";

import { commodoreSystemPrompt, messageNote, replacementNote, wakeNote, type CommodoreLanguage } from "./prompt.js";
import type { CommodoreStore } from "./store.js";
import { COMMODORE_TOOL_GROUP, createCommodoreTools, type CommandExecute } from "./tools.js";
import { MAX_SCOPE_ITEMS, MAX_TRANSCRIPT_TEXT, type CommodoreLiveEvent, type CommodoreTranscriptEntry, type CommodoreTranscriptInput } from "./types.js";

/**
 * 사령관 세션 — `ctx.host.agent.createSession` 으로 연 플러그인 소유 세션 하나. Operation 이 아니다.
 *
 * 시스템 프롬프트는 베이스뿐이고(replace), 도구는 사령관 전용 `commodore` + 이 Theater 에 묶인 보드 도구(`console_objectives`·
 * `console_objectives_detail`, 행위자는 `{ kind: "commodore", theaterId }` 로 고정) + WebSearch·WebFetch 다. Console Use 연결은 쓰지 않는다 — 플러그인
 * 호출자는 Theater 를 모르므로 다른 Theater 의 보드에 손이 닿는다. 턴은 깨움 이유만 싣는다. 세션의 onEvent 는 여기서 정제돼 Theater 의 기록
 * (`transcript.jsonl`)에 쌓이고 같은 길로 방송된다 — 도구 입력 전체·원시 오류·경로는 기록에 들어가지 않는다.
 */

/** 세션이 여는 좌표 — `model`은 Agent SDK wire id다. 강도를 받지 않는 모델이면 강도가 없다. */
export interface CommodoreSessionCoordinates {
  readonly model: string;
  readonly effort?: AgentEffort;
}

export interface CommodoreSessionOptions {
  readonly theaterId: string;
  readonly theaterLabel: string;
  /** 사람이 기록을 읽는 언어 — 베이스 프롬프트의 사실 한 줄. */
  readonly language?: CommodoreLanguage;
  readonly theaterRoot: string;
  readonly agent: AgentHost;
  readonly store: CommodoreStore;
  readonly coordinates: CommodoreSessionCoordinates;
  /** 이 Theater 에 묶인 보드 도구 — objectives 서버가 행위자를 사령관으로 고정해 만든 목록·목표 화면 도구. action 선언(actionSchema)으로 쓰기를 가른다. */
  readonly boardTools: readonly PluginMcpTool[];
  readonly onNextWake: (at: number, reason: string) => void;
  /** 턴 중 라이브 사건 — 저장하지 않고 방송만 한다. */
  readonly onLive?: (event: CommodoreLiveEvent) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
}

export interface CommodoreTurnInput {
  /** 기록에 남는 이유 토큰(`code` 또는 `code:N`) — 화면이 로케일로 옮긴다. */
  readonly reasons: readonly string[];
  /** 모델에게 가는 깨움 문장 — 토큰과 같은 순서의 영어 문장. 없으면 토큰 그대로. */
  readonly sentences?: readonly string[];
  /** wake 줄 바로 뒤에 남는 보드 범위(목표 id·운영 판정·코드) — 기록에만 남고 모델에게는 가지 않는다. */
  readonly scope?: Pick<Extract<CommodoreTranscriptEntry, { kind: "wake-scope" }>, "woke" | "held">;
  /** 교대·재시작 세션의 첫 턴 — 최근 행위 요약. 깨움 문장 앞에 선다. */
  readonly replacementSummary?: readonly string[];
  /** 사람이 사령관에게 보낸 메시지 — 도구가 없는 유일한 입력이라 깨움 문장 뒤에 그대로 선다. */
  readonly messages?: readonly string[];
}

export interface CommodoreTurnOutcome {
  readonly outcome: "ok" | "error" | "cancelled";
  readonly usage?: AgentUsage;
  readonly error?: string;
  /** 이 턴에서 보드에 쓴 행위 수. */
  readonly actions: number;
}

export interface CommodoreSession {
  readonly coordinates: CommodoreSessionCoordinates;
  start(): Promise<void>;
  /** 한 턴 — 세션의 턴은 순서대로 돈다. 세션 오류는 결말로 돌아오고 던지지 않는다(폐기된 세션만 던진다). */
  turn(input: CommodoreTurnInput): Promise<CommodoreTurnOutcome>;
  /** 진행 중 턴만 멈춘다. */
  cancel(): void;
  dispose(): Promise<void>;
}

export const BOARD_TOOL_GROUP = "console";
const MCP_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;
const MAX_SUMMARY = 200;
const MAX_ERROR = 200;

export function createCommodoreSession(options: CommodoreSessionOptions): CommodoreSession {
  const now = options.now ?? Date.now;
  // 보드 도구마다 쓰기 action — 호출의 action 이 이 중 하나면 보드 행위로 기록하고 센다. 나머지는 읽기다.
  const boardWrites = new Map(options.boardTools.map((tool) => [tool.name, new Set(Object.entries(tool.actionSchema?.actions ?? {}).flatMap(([action, info]) => (info.kind === "write" ? [action] : [])))]));
  let session: AgentSession | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  let turnActive = false;

  // 텍스트·사고는 델타로 온다 — 블록 단위로 모아 도구 호출·결과 경계에서 기록 한 줄로 내린다.
  let textBuffer = "";
  let thinkingBuffer = "";
  const pendingTools = new Map<string, { readonly name: string; readonly input: unknown }>();
  // 거절 코드 — 세션 이벤트(tool-end)는 결과를 싣지 않으므로, 도구를 감싸 결과의 `error` 한 낱말만 호출 id·이름으로 기억한다.
  const toolErrors = new Map<string, string>();
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
  const recordTool = (name: string, input: unknown, ok: boolean | undefined, id?: string) => {
    const described = describeTool(name, input, boardWrites);
    if (described.counts && ok !== false) turnActions += 1;
    const error = ok === false ? (id && toolErrors.get(id)) || toolErrors.get(`name:${described.name}`) : undefined;
    if (id) toolErrors.delete(id);
    toolErrors.delete(`name:${described.name}`);
    record({ kind: "tool", name: described.name, ...(described.summary ? { summary: described.summary } : {}), ...(ok === undefined ? {} : { ok }), ...(described.action ? { action: described.action } : {}), ...(described.objectiveId ? { objectiveId: described.objectiveId } : {}), ...(described.title ? { title: described.title } : {}), ...(error ? { error } : {}) });
  };
  /** 결과의 `error` 코드만 기억하는 감싸기 — 결과 자체는 그대로 돌려준다. */
  const observed = (tool: PluginMcpTool): PluginMcpTool => ({
    ...tool,
    execute: async (args, context) => {
      const result = await tool.execute(args, context);
      const code = errorCodeOf(result);
      if (code) { if (context.toolCallId) toolErrors.set(context.toolCallId, code); toolErrors.set(`name:${tool.name}`, code); }
      return result;
    },
  });
  const flushTools = () => {
    for (const [, pending] of pendingTools) recordTool(pending.name, pending.input, undefined);
    pendingTools.clear();
  };
  const onEvent = (event: AgentEvent) => {
    if (disposed) return;
    switch (event.kind) {
      case "text": textBuffer += event.text; if (event.text) options.onLive?.({ kind: "text-delta", text: event.text }); return;
      case "thinking": thinkingBuffer += event.text; return;
      case "tool-start":
        flushText();
        if (event.id) pendingTools.set(event.id, { name: event.name, input: event.input });
        else recordTool(event.name, event.input, undefined);
        options.onLive?.({ kind: "tool-start", name: event.name.replace(MCP_PREFIX, "") });
        return;
      case "tool-end": {
        flushText();
        const pending = event.id ? pendingTools.get(event.id) : undefined;
        if (event.id) pendingTools.delete(event.id);
        recordTool(pending?.name ?? event.name ?? "tool", pending?.input, !event.isError, event.id);
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
      ...(options.coordinates.effort ? { effort: options.coordinates.effort } : {}),
      systemPrompt: commodoreSystemPrompt(options.theaterLabel, options.language),
      continuation: "conversation",
      settlement: "result",
      tools: {
        builtins: ["WebSearch", "WebFetch"],
        custom: [{ name: COMMODORE_TOOL_GROUP, tools: tools.map(observed) }, ...(options.boardTools.length ? [{ name: BOARD_TOOL_GROUP, tools: options.boardTools.map(observed) }] : [])],
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
      turnActions = 0; turnResult = null; textBuffer = ""; thinkingBuffer = ""; pendingTools.clear(); toolErrors.clear();
      record({ kind: "wake", reasons: input.reasons });
      if (input.scope) {
        // 한 쪽이 상한을 넘으면 앞부분만 싣고 나머지는 수로 — 줄 하나가 스키마에 걸려 통째로 빠지지 않게.
        const { woke, held } = input.scope;
        record({ kind: "wake-scope", woke: woke.slice(0, MAX_SCOPE_ITEMS), held: held.slice(0, MAX_SCOPE_ITEMS),
          ...(woke.length > MAX_SCOPE_ITEMS ? { wokeMore: woke.length - MAX_SCOPE_ITEMS } : {}), ...(held.length > MAX_SCOPE_ITEMS ? { heldMore: held.length - MAX_SCOPE_ITEMS } : {}) });
      }
      const note = [
        ...(input.replacementSummary ? [replacementNote(input.replacementSummary)] : []),
        wakeNote(new Date(now()), input.sentences ?? input.reasons),
        ...(input.messages?.length ? [messageNote(input.messages)] : []),
      ].join("\n\n");
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
function describeTool(rawName: string, input: unknown, boardWrites: ReadonlyMap<string, ReadonlySet<string>>): ToolDescription {
  const name = rawName.replace(MCP_PREFIX, "");
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const str = (key: string) => (typeof args[key] === "string" ? clip(args[key] as string, MAX_SUMMARY) : undefined);
  const writes = boardWrites.get(name);
  if (writes) {
    const called = str("action");
    const action = called && writes.has(called) ? called : undefined;
    return { name, action, objectiveId: str("objectiveId"), title: str("title"), ...(called && !action ? { summary: called } : {}), counts: !!action };
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

/** 도구 결과의 거절 코드 — structuredContent.error 또는 JSON 텍스트의 error. snake_case 한 낱말만 받는다. */
function errorCodeOf(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const structured = (result as { structuredContent?: { error?: unknown } }).structuredContent;
  let code = typeof structured?.error === "string" ? structured.error : undefined;
  if (!code) {
    const first = (result as { content?: readonly { type?: string; text?: string }[] }).content?.find((item) => item.type === "text" && typeof item.text === "string");
    try { const parsed = first ? JSON.parse(first.text!) as { error?: unknown } : null; if (typeof parsed?.error === "string") code = parsed.error; } catch { /* 코드 없음 */ }
  }
  return code && /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined;
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
