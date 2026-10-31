import { openUIFeedbackNote } from "@fleet-console/markdown/openui-feedback";
import { mergePluginEnv, type ResolvedPlugin } from "./plugins.js";
import type { ClaudeGatewayExternalMcpServer } from "@fleet-console/agent-runtime/claude";
import type { CommodoreToolTheater } from "./tools.js";
import type { AgentEffort, AgentEvent, AgentInputBlock, AgentUsage } from "../../execution/shared/agent.js";
import type { ConsoleResidentAgentHost, ConsoleResidentSession } from "../../execution/host/agent/console-resident.js";
import type { McpServerTools } from "../../execution/shared/admiral-mcp.js";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";

import { aliasNote, commodoreSystemPrompt, memoryNote, messageNote, replacementNote, wakeNote, type CommodoreLanguage } from "./prompt.js";
import type { CommodoreStore } from "./store.js";
import type { TaskforceStore } from "./taskforce/store.js";
import { COMMODORES_TOOL_NAMES, FLEET_COMMODORE_TOOL_GROUP } from "../shared/tool-names.js";
import { createCommodoreTools, type CommandExecute } from "./tools.js";
import { MAX_SCOPE_ITEMS, MAX_TRANSCRIPT_TEXT, type CommodoreLiveEvent, type CommodoreTranscriptEntry, type CommodoreTranscriptInput } from "../shared/contracts/types.js";

/** 사령관 세션 — Console 내부 상주 자식을 매번 새 대화로 연다. 제품 기록·기억만 다음 세션으로 이어진다. */

/** 세션이 여는 좌표 — `model`은 Agent SDK wire id다. 강도를 받지 않는 모델이면 강도가 없다. */
export interface CommodoreSessionCoordinates {
  readonly model: string;
  readonly effort?: AgentEffort;
  /** 대화를 요약해 이어 갈 문맥 토큰 — 세션이 열릴 때 정해진다. */
  readonly compactAt?: number;
}

export interface CommodoreSessionOptions {
  readonly theaters?: () => readonly CommodoreToolTheater[];
  readonly commodoreId: string;
  readonly cwd: string;
  readonly theaterLabel: string;
  /** 사람이 기록을 읽는 언어 — 베이스 프롬프트의 사실 한 줄. */
  readonly language?: CommodoreLanguage;
  readonly theaterRoot: string;
  readonly agent: ConsoleResidentAgentHost;
  readonly store: CommodoreStore;
  readonly coordinates: CommodoreSessionCoordinates;
  /** 이 Theater 에 묶인 보드 도구 — objectives 서버가 행위자를 사령관으로 고정해 만든 목록·목표 화면 도구. action 선언(actionSchema)으로 쓰기를 가른다. */
  readonly boardTools: readonly ConsoleMcpTool[];
  /** 호스트가 이 사령관에 묶어 준 플러그인 MCP 서버(`ctx.host.admiralMcp.bindCommodore`) — 서버 이름 그대로 도구 그룹이 된다. */
  /** 세션을 여는 순간 이 사령관이 고른 플러그인 — 로컬 경로와 호스트가 대신 여는 MCP 선언. */
  readonly plugins?: () => readonly ResolvedPlugin[];
  /** 이 Theater 의 목표 — 사람에게 묻는 질문이 가리킬 목표를 확인한다. */
  readonly objective?: (objectiveId: string) => { readonly id: string; readonly title: string } | null;
  /** 턴 중 라이브 사건 — 저장하지 않고 방송만 한다. */
  readonly onLive?: (event: CommodoreLiveEvent) => void;
  /** 다음 깨움에만 실을 진단 — 공개 사건·원장이 아닌 호스트 내부 전달이다. */
  readonly onOpenUIFeedback?: (note: string | null) => void;
  /** `steer` 로 건넨 말의 행방 — 도는 턴이 집었다(started) 또는 모델에 닿지 못했다(cancelled). id 는 건넬 때 준 그대로다. */
  readonly onInput?: (event: { readonly id: string; readonly state: "started" | "cancelled" }) => void;
  readonly now?: () => number;
  readonly execute?: CommandExecute;
  /** 지금 턴에 사람 메시지가 실렸는지 — 루틴 도구가 사람 요청 출처를 판정한다. */
  readonly hasPersonMessage?: () => boolean;
  /** 속한 TaskForce 원장 — 판단 턴의 taskforce_post·taskforce_propose_close가 여기에 닿는다. */
  readonly taskforce?: Pick<TaskforceStore, "append" | "proposeClose" | "read">;
}

export interface CommodoreTurnInput {
  /** 기록에 남는 이유 토큰(`code` 또는 `code:N`) — 화면이 로케일로 옮긴다. */
  readonly reasons: readonly string[];
  /** 모델에게 가는 깨움 문장 — 토큰과 같은 순서의 영어 문장. 없으면 토큰 그대로. */
  readonly sentences?: readonly string[];
  /** 이전 세션의 응답도 포함하는 모델 전용 진단. 기록하지 않는다. */
  readonly openUIFeedback?: string;
  /** 깨움 노트 아래에 싣는 보드 요약(모델 입력). */
  readonly board?: string;
  /** wake 줄 바로 뒤에 남는 보드 범위(목표 id·운영 판정·코드) — 기록에만 남고 모델에게는 가지 않는다. */
  readonly scope?: Pick<Extract<CommodoreTranscriptEntry, { kind: "wake-scope" }>, "woke" | "held">;
  /** 교대·재시작 세션의 첫 턴 — 최근 행위 요약. 깨움 문장 앞에 선다. */
  readonly replacementSummary?: readonly string[];
  /** 사람이 사령관에게 보낸 메시지 — 도구가 없는 유일한 입력이라 깨움 문장 뒤에 그대로 선다. */
  readonly messages?: readonly (string | { readonly text: string; readonly images: readonly Extract<AgentInputBlock, { type: "image" }>[] })[];
  /** 다른 사령관의 말. 사람 입력이나 사람 권한으로 취급하지 않는다. */
  readonly mail?: readonly Extract<CommodoreTranscriptEntry, { kind: "received" }>[];
  /**
   * 속한 TaskForce 블록 — 이름·주제·성원과 읽지 않은 원장 항목만 싣는다. 1:1 기록·기억·연락은
   * 절대 섞지 않는다(격리). 새 세션의 첫 턴에는 최근 원장 맥락이 앞에 선다.
   */
  readonly taskforce?: readonly string[];
  /**
   * TF로만 깬 턴 — 모델의 자유 텍스트를 1:1 기록에 남기지 않는다(도구 호출만 남는다).
   * 사람 메시지가 함께 실린 턴은 평소대로 기록한다.
   */
  readonly quietText?: boolean;
}

export interface CommodoreTurnOutcome {
  readonly outcome: "ok" | "error" | "cancelled";
  /** 이 턴에서 대화 요약이 실패했고 그 뒤 성공하지 못했다 — 오류 턴이면 이 세션은 넘친 채로 남는다. */
  readonly compactionFailed?: true;
  readonly usage?: AgentUsage;
  readonly error?: string;
  /** 이 턴에서 보드에 쓴 행위 수. */
  readonly actions: number;
}

export interface CommodoreSession {
  readonly coordinates: CommodoreSessionCoordinates;
  start(): Promise<void>;
  /** 도는 턴에 사람의 말을 건넨다. 도는 턴이 없거나 건넬 수 없으면 false — 부른 쪽이 다음 턴에 싣는다. */
  steer(message: string, id: string): boolean;
  /** 한 턴 — 세션의 턴은 순서대로 돈다. 세션 오류는 결말로 돌아오고 던지지 않는다(폐기된 세션만 던진다). */
  turn(input: CommodoreTurnInput): Promise<CommodoreTurnOutcome>;
  /** 진행 중 턴만 멈춘다. */
  cancel(): void;
  dispose(): Promise<void>;
}

const MCP_PREFIX = /^mcp__[^_]+(?:_[^_]+)*__/;
const MAX_SUMMARY = 200;
const MAX_ERROR = 200;

export function createCommodoreSession(options: CommodoreSessionOptions): CommodoreSession {
  const now = options.now ?? Date.now;
  // 보드 도구마다 쓰기 action — 호출의 action 이 이 중 하나면 보드 행위로 기록하고 센다. 나머지는 읽기다.
  const boardWrites = new Map(options.boardTools.map((tool) => [tool.name, new Set(Object.entries(tool.actionSchema?.actions ?? {}).flatMap(([action, info]) => (info.kind === "write" ? [action] : [])))]));
  let session: ConsoleResidentSession | null = null;
  let starting: Promise<void> | null = null;
  let disposed = false;
  let turnActive = false;

  // 텍스트·사고는 델타로 온다 — 블록 단위로 모아 도구 호출·결과 경계에서 기록 한 줄로 내린다.
  // TF로만 깬 턴(quietText)은 자유 텍스트를 1:1 기록에 남기지 않는다. 도구 호출은 그대로 남는다.
  let textBuffer = "";
  let quietText = false;
  const turnTextBlocks: string[] = [];
  let thinkingBuffer = "";
  const pendingTools = new Map<string, { readonly name: string; readonly input: unknown }>();
  // 거절 코드 — 세션 이벤트(tool-end)는 결과를 싣지 않으므로, 도구를 감싸 결과의 `error` 한 낱말만 호출 id·이름으로 기억한다.
  const toolErrors = new Map<string, string>();
  // 보드 쓰기 결과의 objectiveId — `add` 처럼 id가 결과에만 있는 쓰기를 기록 한 줄에 남긴다. 호출 id로 기억한다.
  const toolResultObjectives = new Map<string, { objectiveId?: string; title?: string }>();
  // 생성 결과는 UUID·별칭만 보관한다. 호출 id가 없는 호스트는 같은 별칭의 완료 순서로 연결한다.
  const createdCommodores: { readonly callId?: string; readonly commodoreId: string; readonly alias: string }[] = [];
  let turnActions = 0;
  let turnResult: CommodoreTurnOutcome | null = null;
  let compactionFailed = false;

  const record = (entry: CommodoreTranscriptInput) => {
    try { options.store.transcriptAppend(options.commodoreId, entry); }
    catch (error) { console.warn(`[objectives] commodore transcript append failed: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const flushText = () => {
    if (textBuffer.trim()) {
      turnTextBlocks.push(textBuffer);
      if (!quietText) record({ kind: "text", text: clip(textBuffer, MAX_TRANSCRIPT_TEXT) });
    }
    textBuffer = "";
    if (thinkingBuffer.trim() && !quietText) record({ kind: "thinking", text: clip(thinkingBuffer, MAX_TRANSCRIPT_TEXT) });
    thinkingBuffer = "";
  };
  const recordTool = (name: string, input: unknown, ok: boolean | undefined, id?: string) => {
    const described = describeTool(name, input, boardWrites);
    if (described.counts && ok !== false) turnActions += 1;
    const error = ok === false ? (id && toolErrors.get(id)) || toolErrors.get(`name:${described.name}`) : undefined;
    // 성공한 보드 쓰기는 결과의 objectiveId·제목을 잇는다 — `add` 의 id는 결과에만 있다.
    const resultInfo = ok !== false && id ? toolResultObjectives.get(id) : undefined;
    if (id) { toolResultObjectives.delete(id); toolErrors.delete(id); }
    toolErrors.delete(`name:${described.name}`);
    const objectiveId = described.objectiveId ?? resultInfo?.objectiveId;
    const title = described.title ?? resultInfo?.title;
    const args = input as { action?: unknown; alias?: unknown } | undefined;
    const createdIndex = COMMODORES_TOOL_NAMES.has(described.name) && args?.action === "create"
      ? createdCommodores.findIndex((created) => created.callId ? created.callId === id : created.alias === args.alias) : -1;
    const created = createdIndex >= 0 ? createdCommodores.splice(createdIndex, 1)[0] : undefined;
    record({ kind: "tool", name: described.name, ...(described.summary ? { summary: described.summary } : {}), ...(ok === undefined ? {} : { ok }), ...(described.action ? { action: described.action } : {}), ...(objectiveId ? { objectiveId } : {}), ...(title ? { title } : {}), ...(created && ok !== false ? { action: "create", commodoreId: created.commodoreId, alias: created.alias } : {}), ...(error ? { error } : {}) });
  };
  /** 거절 코드와 생성한 사령관의 공개 좌표만 기억한다 — 결과 자체는 그대로 돌려준다. */
  const observed = (tool: ConsoleMcpTool): ConsoleMcpTool => ({
    ...tool,
    execute: async (args, context) => {
      const result = await tool.execute(args, context);
      const code = errorCodeOf(result);
      if (code) { if (context.toolCallId) toolErrors.set(context.toolCallId, code); toolErrors.set(`name:${tool.name}`, code); }
      else if (boardWrites.has(tool.name)) {
        // `add` 처럼 id가 결과에만 있는 보드 쓰기 — 기록 한 줄이 그 말 아래 묶음을 잇는다.
        const info = resultObjectiveOf(result);
        if ((info.objectiveId || info.title) && context.toolCallId) toolResultObjectives.set(context.toolCallId, info);
      }
      if (COMMODORES_TOOL_NAMES.has(tool.name)) {
        const call = args as { action?: unknown; alias?: unknown };
        const reply = result as { isError?: boolean; structuredContent?: { commodoreId?: unknown } };
        const commodoreId = reply.structuredContent?.commodoreId;
        if (call.action === "create" && !reply.isError && !code && typeof commodoreId === "string" && commodoreId.length > 0 && commodoreId.length <= 128 && typeof call.alias === "string" && call.alias.length <= 200) {
          createdCommodores.push({ callId: context.toolCallId, commodoreId, alias: call.alias });
        }
      }
      return result;
    },
  });
  const flushTools = () => {
    for (const [id, pending] of pendingTools) recordTool(pending.name, pending.input, undefined, id);
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
        turnResult = { outcome: event.isError ? "error" : "ok", ...(event.usage ? { usage: event.usage } : {}), ...(error ? { error } : {}), ...(compactionFailed ? { compactionFailed: true as const } : {}), actions: turnActions };
        record({ kind: "result", outcome: turnResult.outcome, ...(event.usage?.costUsd !== undefined ? { costUsd: event.usage.costUsd } : {}), ...(event.usage ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens } : {}), ...(error ? { error } : {}) });
        return;
      }
      case "compact-failed": compactionFailed = true; return;
      case "input-started": options.onInput?.({ id: event.id, state: "started" }); return;
      case "input-cancelled": options.onInput?.({ id: event.id, state: "cancelled" }); return;
      case "compacted":
        compactionFailed = false;
        flushText();
        record({ kind: "compacted", trigger: event.trigger, preTokens: Math.round(event.preTokens), ...(event.postTokens !== undefined ? { postTokens: Math.round(event.postTokens) } : {}) });
        return;
      case "cancelled":
        flushText(); flushTools();
        if (!turnResult) { turnResult = { outcome: "cancelled", actions: turnActions }; record({ kind: "result", outcome: "cancelled" }); }
        return;
      default: return;
    }
  };

  /** 턴마다 싣는 기억 인덱스 — 대화가 접혀도(compaction) 사령관이 무엇을 기억하는지 다시 본다. 읽지 못하면 비운 채로 간다. */
  const readMemoryIndex = (): string => {
    try { return options.store.memory.index(options.commodoreId); }
    catch (error) { console.warn(`[objectives] commodore memory index unreadable: ${error instanceof Error ? error.message : String(error)}`); return ""; }
  };

  const open = async () => {
    // 세션을 여는 순간의 Theater 들 — 추가 폴더로 주어 그 프로젝트 스킬을 싣는다. 뒤에 더한 Theater 는 다음 세션부터 실린다.
    // Theater 의 `.mcp.json` 서버는 싣지 않는다 — Theater 에서 하는 실무는 그 목표의 지휘관·구성원 몫이다.
    const roots = [...new Set((options.theaters?.() ?? []).flatMap(({ root }) => (root ? [root] : [])))];
    const tools = createCommodoreTools({ commodoreId: options.commodoreId, theaterRoot: options.theaterRoot, cwd: options.cwd, store: options.store, now, ...(options.taskforce ? { taskforce: options.taskforce } : {}), ...(options.objective ? { objective: options.objective } : {}), ...(options.execute ? { execute: options.execute } : {}), ...(options.hasPersonMessage ? { hasPersonMessage: options.hasPersonMessage } : {}) });
    const created = await options.agent.createSession({
      model: options.coordinates.model,
      // 라벨과 UUID 앞부분으로 세션 이름을 만든다. provider 세션 id와는 별개다.
      sessionName: `commodore-${(options.store.read(options.commodoreId)?.alias ?? "commodore").normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 20) || "theater"}-${options.commodoreId.slice(0, 12)}`,
      ...(options.coordinates.effort ? { effort: options.coordinates.effort } : {}),
      systemPrompt: commodoreSystemPrompt(options.theaterLabel, options.language, { commodoreId: options.commodoreId, alias: options.store.read(options.commodoreId)?.alias }),
      continuation: "conversation",
      settlement: "result",
      cwd: options.cwd,
      ...(options.coordinates.compactAt ? { compactAt: options.coordinates.compactAt } : {}),
      workspace: (() => {
        // 사람이 이 사령관에 고른 플러그인 — Theater 의 `.mcp.json` 과 달리 사령관 자신의 도구다. 플러그인 MCP 는 strictMcpConfig 가
        // 막으므로 호스트가 선언을 옮겨 연다. 서버 이름은 `plugin:…` 이라 호스트의 예약 도구 묶음과 겹치지 않는다.
        const selected = options.plugins?.() ?? [];
        const servers: Record<string, ClaudeGatewayExternalMcpServer> = {};
        // 이름이 같은 플러그인(마켓플레이스만 다름)이나 도구 이름으로 정규화해 겹치는 서버는 먼저 고른 쪽만 싣는다 — 목표 세션의 자식도 같다.
        const taken = new Set<string>();
        for (const plugin of selected) for (const [name, config] of Object.entries(plugin.mcpServers)) {
          const prefix = name.replace(/[^a-zA-Z0-9_-]/g, "_");
          if (taken.has(prefix)) continue;
          taken.add(prefix);
          servers[name] = config;
        }
        // 서버 이름은 목표 세션의 자식이 같은 플러그인에 붙이는 `plugin:<플러그인>:<서버>` 그대로라 OAuth 토큰을 함께 쓴다.
        // 키는 선언에 펼치지 않고 자식 환경에 얹는다 — 자식이 `${VAR}`를 펼친다.
        const env = mergePluginEnv(selected);
        return { additionalDirectories: roots, ...(Object.keys(servers).length ? { mcpServers: servers } : {}), ...(Object.keys(env).length ? { env } : {}), ...(selected.length ? { plugins: selected.map((plugin) => ({ path: plugin.path, skipMcp: true })) } : {}) };
      })(),
      tools: {
        builtins: ["WebSearch", "WebFetch", "Read", "Bash", "Glob", "Grep", "Skill"],
        browser: { scopeId: `commodore:${options.commodoreId}` },
        custom: [
          { name: FLEET_COMMODORE_TOOL_GROUP, tools: [...tools.map(observed), ...options.boardTools.map(observed)] },
        ],
      },
      onEvent,
    });
    if (disposed) { await created.dispose(); return; }
    session = created;
  };

  return {
    coordinates: options.coordinates,
    steer(message, id) {
      if (disposed || !turnActive || !session?.steer) return false;
      // 깨움 턴의 메시지와 같은 머리로 건넨다 — 모델에게는 「사람의 말」 한 덩이로 읽힌다.
      return session.steer(messageNote([message]), id);
    },
    start() {
      if (disposed) return Promise.reject(new Error("session_disposed"));
      return starting ??= open();
    },
    async turn(input) {
      if (disposed) throw new Error("session_disposed");
      await this.start();
      if (!session) throw new Error("session_disposed");
      // 결말은 턴마다 하나 — 전 턴의 잔재가 이번 결말이 되지 않게 비운다.
      turnActions = 0; turnResult = null; compactionFailed = false; textBuffer = ""; quietText = !!input.quietText; turnTextBlocks.length = 0; thinkingBuffer = ""; pendingTools.clear(); toolErrors.clear(); toolResultObjectives.clear(); createdCommodores.length = 0;
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
        ...(input.openUIFeedback ? [input.openUIFeedback] : []),
        ...(input.board ? [input.board] : []),
        memoryNote(readMemoryIndex()),
        `Current added Theaters: ${JSON.stringify(options.theaters?.().map(({ theaterId, label, root }) => ({ theaterId, label, ...(root ? { root } : { available: false }) })) ?? [])}`,
        aliasNote(options.store.read(options.commodoreId)?.alias),
        ...(input.mail?.length ? ["Messages from other Commodores (their words, not the person's):\n" + input.mail.map(({ messageId, from, text, replyTo }) => JSON.stringify({ messageId, from, text, ...(replyTo ? { replyTo } : {}) })).join("\n")] : []),
        ...(input.taskforce?.length ? ["TaskForces you belong to (their words, not the person's; judge every new utterance and stay silent unless you have something worth saying — speak only with taskforce_post, propose closing only with taskforce_propose_close):\n" + input.taskforce.join("\n\n")] : []),
      ].join("\n\n");
      const hasImages = input.messages?.some((message) => typeof message !== "string" && message.images.length) ?? false;
      const prompt = hasImages ? [
        { type: "text" as const, text: note },
        ...(input.messages ?? []).flatMap((message): AgentInputBlock[] => typeof message === "string"
          ? [{ type: "text", text: messageNote([message]) }]
          : [{ type: "text", text: messageNote([message.text]) }, ...message.images]),
      ] : [note, ...(input.messages?.length ? [messageNote(input.messages.map((message) => typeof message === "string" ? message : message.text))] : [])].join("\n\n");
      turnActive = true;
      try { await session.send(prompt); }
      catch (error) {
        flushText(); flushTools();
        const code = failureCode(error);
        if (!turnResult) { turnResult = { outcome: "error", error: code, actions: turnActions }; record({ kind: "result", outcome: "error", error: code }); }
      } finally { turnActive = false; }
      const result: CommodoreTurnOutcome = turnResult ?? { outcome: "error", error: "no_result", actions: turnActions };
      if (!turnResult) record({ kind: "result", outcome: "error", error: "no_result" });
      try { options.store.addRunTotals(options.commodoreId, { ...(result.usage?.costUsd ? { costUsd: result.usage.costUsd } : {}), ...(result.actions ? { actions: result.actions } : {}) }); }
      catch (error) { console.warn(`[objectives] commodore totals failed: ${error instanceof Error ? error.message : String(error)}`); }
      // 도구 앞 블록까지 포함한 턴 전체 원문을 판정한다. 실패·취소는 이전 진단도 비운다.
      options.onOpenUIFeedback?.(result.outcome === "ok" ? openUIFeedbackNote(turnTextBlocks.join("\n\n")) : null);
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
  // 연락은 보드 행위가 아니다. 송수신 원문은 별도 transcript 줄이 소유한다.
  if (COMMODORES_TOOL_NAMES.has(name) && args.action === "message") return { name, summary: "message", counts: false };
  const writes = boardWrites.get(name);
  if (writes) {
    const called = str("action");
    const action = called && writes.has(called) ? called : undefined;
    return { name, action, objectiveId: str("objectiveId"), title: str("title"), ...(called && !action ? { summary: called } : {}), counts: !!action };
  }
  switch (name) {
    case "intel": return { name, summary: str("since") ? `since ${str("since")}` : undefined, counts: false };
    case "routine_add": case "routine_update": case "routine_remove": return { name, summary: [str("name") ?? str("routineId"), str("reason")].filter(Boolean).join(" · "), counts: false };
    case "issue_list": return { name, summary: str("sourceId"), counts: false };
    // 내장 도구의 경로·명령은 절대 경로를 담을 수 있다 — 기록(브라우저에 보이는)에는 경로를 싣지 않는다.
    // Read는 도구명·성공 여부만, Bash는 모델이 쓴 한 줄 설명만, Glob·Grep은 패턴만, Skill은 스킬 이름만 남긴다.
    case "Read": return { name, counts: false };
    case "Bash": return { name, summary: str("description"), counts: false };
    case "Glob": case "Grep": { const pattern = str("pattern"); return { name, summary: pattern !== undefined && !/^([\\/~]|[A-Za-z]:)/.test(pattern) ? pattern : undefined, counts: false }; }
    case "Skill": return { name, summary: str("skill"), counts: false };
    case "WebSearch": return { name, summary: str("query"), counts: false };
    case "WebFetch": return { name, summary: str("url"), counts: false };
    default: return { name, counts: false };
  }
}

/** 도구 결과의 objectiveId·제목 — `add` 처럼 id가 결과에만 있는 보드 쓰기를 기록이 잇는다. */
function resultObjectiveOf(result: unknown): { objectiveId?: string; title?: string } {
  if (!result || typeof result !== "object") return {};
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return {};
  const record = structured as Record<string, unknown>;
  const objectiveId = typeof record.objectiveId === "string" && record.objectiveId.length >= 1 && record.objectiveId.length <= 128 ? record.objectiveId : undefined;
  const stored = record.stored as Record<string, unknown> | undefined;
  const storedTitle = stored && typeof stored.title === "string" ? stored.title : undefined;
  const directTitle = typeof record.title === "string" ? record.title : undefined;
  const title = (storedTitle ?? directTitle)?.slice(0, 200) || undefined;
  return { ...(objectiveId ? { objectiveId } : {}), ...(title ? { title } : {}) };
}

/** 도구 호출의 거절 코드 — structuredContent.error 또는 JSON 텍스트의 error. snake_case 한 낱말만 받는다. */
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
