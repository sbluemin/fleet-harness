/**
 * provider — Pi 호스트의 ACP/AI 어댑터 통합 모듈.
 *
 * 분할되어 있던 provider-stream / provider-runtime / thinking-level-patch 파일들을
 * 단일 모듈로 통합. 섹션 구분(═══)을 region 경계로 사용한다.
 *
 * 책임 영역:
 *   #region fleet-ai gateway     — @sbluemin/fleet-ai re-export (유일한 게이트웨이)
 *   #region streamAcp adapter    — admiral.agent 공개 API → Pi AssistantMessageEventStream 매핑
 *   #region thinking-level patch — Pi AgentSession prototype monkeypatch
 *   #region provider-runtime     — 호스트 주도 provider 등록 + 세션 라이프사이클 hook
 *
 * 주의:
 *   - upstream built-in provider auto-registration은 제거되었다.
 *   - 이 파일은 host-owned provider gateway만 담당한다.
 *   - host registration 이전에 piCompleteSimple을 호출해 발생하는
 *     "No API provider registered" 예외는 의도된 계약이다.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  AgentSession,
  type ExtensionAPI,
} from "@sbluemin/fleet-coding-agent";
import {
  completeSimple as piCompleteSimple,
  createAssistantMessageEventStream,
} from "@sbluemin/fleet-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingBudgets,
  ThinkingLevel as PiThinkingLevel,
  Tool as PiTool,
} from "@sbluemin/fleet-ai";
import {
  CLI_BACKENDS,
  getEffort,
  getModelsRegistry,
  type CliType,
} from "@sbluemin/fleet-unified-agent";
import type {
  AgentStreamEvent,
  ConversationHistoryEntry,
  FleetAdmiralServices,
  SelectableThinkingLevel,
  ToolResultEnvelope,
} from "@sbluemin/fleet-core";
import {
  admiral,
  infra,
  type AgentToolSpec,
} from "@sbluemin/fleet-core";

// ═══════════════════════════════════════════════════════════════════════════
// #region fleet-ai gateway (re-export)
// ═══════════════════════════════════════════════════════════════════════════

export { createAssistantMessageEventStream, piCompleteSimple as completeSimple };
export type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingBudgets,
  PiThinkingLevel as ThinkingLevel,
  PiTool as Tool,
};

// #endregion

// ═══════════════════════════════════════════════════════════════════════════
// #region streamAcp adapter — types / state
// ═══════════════════════════════════════════════════════════════════════════

export type SimpleStreamFn = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface StreamOptionsLike extends SimpleStreamOptions {
  cwd?: string;
  sessionId?: string;
  piSessionId?: string;
  conversationId?: string;
}

interface ModelEffort {
  supported: boolean;
  levels?: readonly string[];
  default?: string;
}

const SESSION_SCOPE_PREFIX = "session";
const MODEL_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);

/** sessionId → Pi turn event 핸들러 매핑 (host-local; fleet-core에 stream 객체 넣지 않음) */
const activeStreams = new Map<string, (event: AgentStreamEvent) => void>();

/** toolCallId → sessionId 매핑 — toolResult delivery 라우팅용 */
const toolCallToSessionId = new Map<string, string>();

let eventHandlerRegistered = false;

const {
  buildModelId,
  buildProviderId,
  getSelectableThinkingLevels,
  hashSystemPrompt,
  parseModelId,
} = admiral.agent.models;
const {
  deliverToolResults,
  ensure,
  sendMessage,
} = admiral.agent.session;
const {
  bindHostSession,
  shutdownAllSessions,
} = admiral.agent.lifecycle;
const { registerExtraTools } = admiral.agent.tools;
const { registerStreamHandler } = admiral.agent.events;

// ═══════════════════════════════════════════════════════════════════════════
// #region streamAcp adapter — public functions
// ═══════════════════════════════════════════════════════════════════════════

/** boot-time event 핸들러 1회 등록 — registerProviderRuntime에서 호출 */
export function initStreamEventHandler(): void {
  if (eventHandlerRegistered) return;
  eventHandlerRegistered = true;

  registerStreamHandler((event: AgentStreamEvent) => {
    const push = activeStreams.get(event.sessionId);
    if (!push) return;

    if (event.type === "mcpToolCall") {
      toolCallToSessionId.set(event.toolCallId, event.sessionId);
    }

    push(event);
  });
}

export function streamAcp(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const parsed = parseModelId(model.id, model.provider);
  if (!parsed) {
    return createErrorStream(`잘못된 ACP model ID: ${model.id}`);
  }

  const { cli, backendModel } = parsed;
  const streamOpts = options as StreamOptionsLike | undefined;
  const cwd = streamOpts?.cwd ?? process.cwd();

  let scopeKey: string;
  try {
    scopeKey = getScopeKey(streamOpts, cwd);
  } catch (err) {
    return createErrorStream(String(err));
  }

  const systemPrompt = context.systemPrompt ?? undefined;
  hashSystemPrompt(systemPrompt);
  const toolResults = extractAllToolResults(context);
  const isToolResultDelivery = toolResults.length > 0;
  const requestedEffort = options?.reasoning;
  const modelEffort = getModelEffort(cli, backendModel);
  const effort = requestedEffort && modelEffort.supported && modelEffort.levels?.includes(requestedEffort)
    ? requestedEffort
    : undefined;

  const piStream = createAssistantMessageEventStream();
  const piOutput = createAssistantOutput(model);
  const blockTracker = new BlockTracker();

  const turnHandler = (event: AgentStreamEvent): void => {
    mapEventToPiStream(event, piStream, piOutput, blockTracker);
  };

  if (isToolResultDelivery) {
    runToolResultDelivery(toolResults, turnHandler, options).catch((err) => {
      emitPiError(piStream, piOutput, String(err));
    });
  } else {
    runFreshQuery(
      cli,
      backendModel,
      scopeKey,
      cwd,
      context,
      systemPrompt,
      effort,
      context.tools,
      turnHandler,
      options,
    ).catch((err) => {
      emitPiError(piStream, piOutput, String(err));
    });
  }

  return piStream;
}

// ═══════════════════════════════════════════════════════════════════════════
// #region streamAcp adapter — case 1: fresh query
// ═══════════════════════════════════════════════════════════════════════════

async function runFreshQuery(
  cli: Parameters<typeof ensure>[0]["cli"],
  backendModel: string,
  scopeKey: string,
  cwd: string,
  context: Context,
  systemPrompt: string | undefined,
  effort: string | undefined,
  piTools: readonly PiTool[] | undefined,
  turnHandler: (event: AgentStreamEvent) => void,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  let userRequest = extractLatestUserMessage(context);
  if (!userRequest) userRequest = "Continue.";
  const history = extractConversationHistory(context);

  // host extra tools 등록 — ensure 전에. ensure 내부 toolHash 계산이 첫/이후 호출에서 일관되도록.
  if (piTools && piTools.length > 0) {
    registerExtraTools(scopeKey, piTools.map(piToolToAgentSpec));
  }

  const handle = await ensure({ cli, backendModel, scopeKey, cwd, systemPrompt, effort });

  activeStreams.set(handle.sessionId, turnHandler);

  const donePromise = new Promise<void>((resolve) => {
    const wrapped = (event: AgentStreamEvent): void => {
      turnHandler(event);
      if (event.type === "complete" || event.type === "error" || event.type === "exit") {
        activeStreams.delete(handle.sessionId);
        resolve();
      }
    };
    activeStreams.set(handle.sessionId, wrapped);
  });

  await sendMessage(handle, { userRequest, history }, options?.signal);

  await donePromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// #region streamAcp adapter — case 2: tool result delivery
// ═══════════════════════════════════════════════════════════════════════════

async function runToolResultDelivery(
  toolResults: ToolResultEnvelope[],
  turnHandler: (event: AgentStreamEvent) => void,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  const firstToolCallId = toolResults[0]?.toolCallId;
  if (!firstToolCallId) throw new Error("toolResult에 toolCallId가 없습니다");

  const sessionId = toolCallToSessionId.get(firstToolCallId);
  if (!sessionId) throw new Error("toolResult 라우팅 실패: toolCallId로 sessionId를 찾을 수 없습니다");

  for (const result of toolResults) {
    if (result.toolCallId) {
      const mapped = toolCallToSessionId.get(result.toolCallId);
      if (mapped && mapped !== sessionId) {
        throw new Error("서로 다른 ACP 세션의 toolResult가 한 턴에 섞였습니다");
      }
    }
  }

  const handle = { sessionId };

  const donePromise = new Promise<void>((resolve) => {
    const wrapped = (event: AgentStreamEvent): void => {
      turnHandler(event);
      if (event.type === "complete" || event.type === "error" || event.type === "exit") {
        activeStreams.delete(sessionId);
        resolve();
      }
    };
    activeStreams.set(sessionId, wrapped);
  });

  await deliverToolResults(handle, toolResults, options?.signal);

  await donePromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// #region streamAcp adapter — event → Pi stream mapping
// ═══════════════════════════════════════════════════════════════════════════

function mapEventToPiStream(
  event: AgentStreamEvent,
  piStream: AssistantMessageEventStream,
  piOutput: AssistantMessage,
  bt: BlockTracker,
): void {
  switch (event.type) {
    case "text":
      bt.ensureText(piStream, piOutput);
      bt.appendText(event.text, piStream, piOutput);
      break;
    case "thought":
      bt.closeText(piStream, piOutput);
      bt.ensureThinking(piStream, piOutput);
      bt.appendThinking(event.text, piStream, piOutput);
      break;
    case "toolCall":
    case "toolCallUpdate": {
      // ACP 분할 도착 UX: toolCall/toolCallUpdate 이벤트 자체는 출력하지 않는다.
      // event-normalizer.ts가 status=completed/error 도달 시 풍부 title을 `text` 이벤트로
      // 한 번 emit하므로, 1차 빈약 title("Read File", "grep" 등) 즉시 출력 + 4차 풍부 title
      // 추가 출력으로 인한 두 줄 표시를 방지한다.
      break;
    }
    case "mcpToolCall":
      bt.ensureStarted(piStream, piOutput);
      bt.closeText(piStream, piOutput);
      bt.closeThinking(piStream, piOutput);
      {
        const block = { type: "toolCall" as const, id: event.toolCallId, name: event.name, arguments: event.args };
        piOutput.content.push(block);
        const idx = piOutput.content.length - 1;
        piStream.push({ type: "toolcall_start", contentIndex: idx, partial: piOutput });
        piStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: piOutput });
        piOutput.stopReason = "toolUse";
        piStream.push({ type: "done", reason: "toolUse", message: piOutput });
        piStream.end();
      }
      break;
    case "complete":
      bt.ensureStarted(piStream, piOutput);
      bt.closeText(piStream, piOutput);
      bt.closeThinking(piStream, piOutput);
      if (event.done === "stop") {
        piOutput.stopReason = "stop";
        piStream.push({ type: "done", reason: "stop", message: piOutput });
        piStream.end();
      }
      break;
    case "error":
      bt.ensureStarted(piStream, piOutput);
      bt.closeText(piStream, piOutput);
      bt.closeThinking(piStream, piOutput);
      piOutput.stopReason = "error";
      piOutput.errorMessage = event.error;
      piStream.push({ type: "error", reason: "error", error: piOutput });
      piStream.end();
      break;
    case "exit":
      bt.ensureStarted(piStream, piOutput);
      bt.closeText(piStream, piOutput);
      bt.closeThinking(piStream, piOutput);
      piOutput.stopReason = "error";
      piStream.push({ type: "error", reason: "error", error: piOutput });
      piStream.end();
      break;
  }
}

class BlockTracker {
  private started = false;
  private textOpen = false;
  private textIdx = 0;
  private thinkingOpen = false;
  private thinkingIdx = 0;

  /** stream `start` 이벤트 1회 push — pi consumer가 streaming UI를 시작하는 트리거. */
  ensureStarted(stream: AssistantMessageEventStream, output: AssistantMessage): void {
    if (this.started) return;
    this.started = true;
    stream.push({ type: "start", partial: output });
  }

  ensureText(stream: AssistantMessageEventStream, output: AssistantMessage): void {
    this.ensureStarted(stream, output);
    if (this.textOpen) return;
    this.closeThinking(stream, output);
    const block = { type: "text" as const, text: "" };
    output.content.push(block);
    this.textIdx = output.content.length - 1;
    this.textOpen = true;
    stream.push({ type: "text_start", contentIndex: this.textIdx, partial: output });
  }

  appendText(text: string, stream: AssistantMessageEventStream, output: AssistantMessage): void {
    const block = output.content[this.textIdx] as { text: string };
    block.text += text;
    stream.push({ type: "text_delta", contentIndex: this.textIdx, delta: text, partial: output });
  }

  closeText(stream: AssistantMessageEventStream, output: AssistantMessage): void {
    if (!this.textOpen) return;
    this.textOpen = false;
    const block = output.content[this.textIdx];
    if (block && block.type === "text") {
      stream.push({ type: "text_end", contentIndex: this.textIdx, content: block.text ?? "", partial: output });
    }
  }

  ensureThinking(stream: AssistantMessageEventStream, output: AssistantMessage): void {
    this.ensureStarted(stream, output);
    if (this.thinkingOpen) return;
    this.closeText(stream, output);
    const block = { type: "thinking" as const, thinking: "" };
    output.content.push(block);
    this.thinkingIdx = output.content.length - 1;
    this.thinkingOpen = true;
    stream.push({ type: "thinking_start", contentIndex: this.thinkingIdx, partial: output });
  }

  appendThinking(text: string, stream: AssistantMessageEventStream, output: AssistantMessage): void {
    const block = output.content[this.thinkingIdx] as { thinking: string };
    block.thinking += text;
    stream.push({ type: "thinking_delta", contentIndex: this.thinkingIdx, delta: text, partial: output });
  }

  closeThinking(stream: AssistantMessageEventStream, output: AssistantMessage): void {
    if (!this.thinkingOpen) return;
    this.thinkingOpen = false;
    const block = output.content[this.thinkingIdx];
    if (block && block.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: this.thinkingIdx, content: block.thinking ?? "", partial: output });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// #region streamAcp adapter — internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function emitPiError(piStream: AssistantMessageEventStream, piOutput: AssistantMessage, message: string): void {
  piOutput.stopReason = "error";
  piOutput.errorMessage = message;
  piStream.push({ type: "error", reason: "error", error: piOutput });
  piStream.end();
}

function getScopeKey(options: StreamOptionsLike | undefined, cwd: string): string {
  if (options?.sessionId) return `${SESSION_SCOPE_PREFIX}:pi:${options.sessionId}`;
  if (options?.piSessionId) return `${SESSION_SCOPE_PREFIX}:pi-session:${options.piSessionId}`;
  if (options?.conversationId) return `${SESSION_SCOPE_PREFIX}:conversation:${options.conversationId}`;
  throw new Error(`ACP 세션 스코프 식별자가 없습니다 (cwd fallback 금지): ${cwd}`);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && (block as { type?: string }).type === "text" && (block as { text?: string }).text) {
        texts.push((block as { text: string }).text);
      }
    }
    return texts.join("\n");
  }
  return "";
}

/** fleet-core sendMessage에 전달할 user/assistant 히스토리만 추출. 마지막 user 메시지는 userRequest로 별도 전달되므로 제외. */
function extractConversationHistory(context: Context): ConversationHistoryEntry[] {
  const result: ConversationHistoryEntry[] = [];
  const historyMessages = context.messages.slice(0, -1);
  for (const msg of historyMessages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractMessageText(msg.content);
    if (!text) continue;
    result.push({ role: msg.role, text });
  }
  return result;
}

function extractLatestUserMessage(context: Context): string | null {
  const last = context.messages[context.messages.length - 1];
  if (!last || last.role !== "user") return null;
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    const texts: string[] = [];
    for (const block of last.content) {
      if (block.type === "text" && block.text) texts.push(block.text);
    }
    return texts.join("\n") || null;
  }
  return null;
}

function extractAllToolResults(context: Context): ToolResultEnvelope[] {
  const results: ToolResultEnvelope[] = [];
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "toolResult") {
      results.unshift({ content: msg.content, isError: (msg as any).isError, toolCallId: (msg as any).toolCallId });
    } else {
      break;
    }
  }
  return results;
}

function piToolToAgentSpec(tool: PiTool): AgentToolSpec {
  return {
    id: tool.name,
    tag: tool.name,
    title: tool.name,
    description: tool.description,
    promptSnippet: `${tool.name} — ${tool.description}`,
    whenToUse: [],
    whenNotToUse: [],
    usageGuidelines: [],
    parameters: tool.parameters as AgentToolSpec["parameters"],
    execute: async () => ({ content: [{ type: "text", text: "(host tool)" }] }),
  };
}

function createAssistantOutput(model: Model<any>): any {
  return {
    role: "assistant",
    content: [],
    api: model.provider,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createErrorStream(message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const errorOutput: any = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: message,
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: errorOutput });
    stream.end();
  });
  return stream;
}

// ═══════════════════════════════════════════════════════════════════════════
// #region thinking-level patch — Pi AgentSession prototype monkeypatch
// ═══════════════════════════════════════════════════════════════════════════

type PatchableModel = Pick<Model<any>, "id" | "provider" | "reasoning">;

type PatchableAgentSession = InstanceType<typeof AgentSession> & {
  getAvailableThinkingLevels(): SelectableThinkingLevel[];
  supportsXhighThinking(): boolean;
  model?: PatchableModel;
};

type PatchedThinkingLevelFn = (() => unknown) & {
  __fleetAcpThinkingLevelPatched?: boolean;
};

type OriginalGetAvailableThinkingLevels = (this: PatchableAgentSession) => SelectableThinkingLevel[];
type OriginalSupportsXhighThinking = (this: PatchableAgentSession) => boolean;

let acpThinkingLevelPatchInstalled = false;

export function installAcpThinkingLevelPatch(): void {
  if (acpThinkingLevelPatchInstalled) return;

  const prototype = AgentSession.prototype as PatchableAgentSession;
  const originalGetAvailableThinkingLevels: OriginalGetAvailableThinkingLevels = prototype.getAvailableThinkingLevels;
  const originalSupportsXhighThinking: OriginalSupportsXhighThinking = prototype.supportsXhighThinking;
  if (isPatchedThinkingLevelFn(originalGetAvailableThinkingLevels) || isPatchedThinkingLevelFn(originalSupportsXhighThinking)) {
    acpThinkingLevelPatchInstalled = true;
    return;
  }

  const getAvailableThinkingLevelsPatched: PatchedThinkingLevelFn = function getAvailableThinkingLevelsPatched(this: PatchableAgentSession): SelectableThinkingLevel[] {
    const override = getSelectableLevelsForModel(this.model);
    return override ?? Reflect.apply(originalGetAvailableThinkingLevels, this, []) as SelectableThinkingLevel[];
  };
  getAvailableThinkingLevelsPatched.__fleetAcpThinkingLevelPatched = true;
  prototype.getAvailableThinkingLevels = getAvailableThinkingLevelsPatched as PatchableAgentSession["getAvailableThinkingLevels"];

  const supportsXhighThinkingPatched: PatchedThinkingLevelFn = function supportsXhighThinkingPatched(this: PatchableAgentSession): boolean {
    const override = getSelectableLevelsForModel(this.model);
    if (override) return override.includes("xhigh");
    return Reflect.apply(originalSupportsXhighThinking, this, []) as boolean;
  };
  supportsXhighThinkingPatched.__fleetAcpThinkingLevelPatched = true;
  prototype.supportsXhighThinking = supportsXhighThinkingPatched as PatchableAgentSession["supportsXhighThinking"];

  acpThinkingLevelPatchInstalled = true;
}

function getSelectableLevelsForModel(model: PatchableModel | undefined): SelectableThinkingLevel[] | null {
  if (!model || !model.reasoning) return null;
  const parsed = parseModelId(model.id, model.provider);
  if (!parsed) return null;
  return getSelectableThinkingLevels(parsed.cli, parsed.backendModel);
}

function isPatchedThinkingLevelFn(value: unknown): value is PatchedThinkingLevelFn {
  return typeof value === "function" && (value as PatchedThinkingLevelFn).__fleetAcpThinkingLevelPatched === true;
}

// ═══════════════════════════════════════════════════════════════════════════
// #region provider-runtime — provider 등록 + session 라이프사이클
// ═══════════════════════════════════════════════════════════════════════════

type ProviderModels = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["models"]>;

const PROVIDER_REGISTRATIONS = Object.entries(getModelsRegistry().providers)
  .flatMap(([cliKey, provider]) => {
    const cli = cliKey as CliType;
    const models = buildProviderModels(cli, provider);
    if (models.length === 0) return [];
    return [{ providerId: buildProviderId(cli), models }];
  });

let activeStreamRef: SimpleStreamFn | null = null;

export function getActiveStreamRef(): SimpleStreamFn | null {
  return activeStreamRef;
}

export function setActiveStreamRef(stream: SimpleStreamFn): void {
  activeStreamRef = stream;
}

export function clearActiveStreamRef(stream?: SimpleStreamFn): void {
  if (!stream || activeStreamRef === stream) {
    activeStreamRef = null;
  }
}

/** provider 등록 + 세션 라이프사이클 바인딩 — agent/index.ts에서 호출 */
export function registerProviderRuntime(
  pi: ExtensionAPI,
  _fleetServices: FleetAdmiralServices,
  streamFn: SimpleStreamFn,
): void {
  const log = infra.log.getLogAPI();
  log.registerCategory({ id: "acp", label: "ACP Provider", description: "ACP 프로바이더 일반 로그" });
  log.registerCategory({ id: "acp-system-prompt", label: "ACP System Prompt", description: "시스템 프롬프트 전문 로그" });
  log.registerCategory({ id: "acp-stderr", label: "ACP Stderr", description: "ACP CLI stderr 출력" });

  installAcpThinkingLevelPatch();

  pi.on("session_start", (_event, ctx) => {
    // reason 분기 제거 — 모든 session_start에서 bindHostSession 호출.
    // restore 호출 누락 시 sessionStore의 mapFilePath가 null로 남아 store.set이 no-op되고
    // 다음 /resume에서 saved sessionId를 찾지 못해 fresh 세션이 생긴다.
    bindHostSession(ctx.sessionManager.getSessionId(), ctx.sessionManager);
  });

  pi.on("session_tree", (_event, ctx) => {
    bindHostSession(ctx.sessionManager.getSessionId(), ctx.sessionManager);
  });

  pi.on("session_shutdown", () => {
    shutdownAllSessions()
      .catch((err) => {
        console.error("[fleet-acp] session_shutdown 정리 실패:", err);
      })
      .finally(() => {
        clearActiveStreamRef(streamFn);
      });
  });

  if (!getActiveStreamRef()) {
    setActiveStreamRef(streamFn);

    for (const { providerId, models } of PROVIDER_REGISTRATIONS) {
      pi.registerProvider(providerId, {
        baseUrl: providerId,
        apiKey: "not-used",
        api: providerId,
        models,
        streamSimple: streamFn,
      });
    }
  }
}

function buildProviderModels(
  cli: CliType,
  provider: ReturnType<typeof getModelsRegistry>["providers"][CliType],
): ProviderModels {
  const backend = CLI_BACKENDS[cli];
  if (!backend) return [] as ProviderModels;

  return provider.models.map((m) => {
    const effort = getModelEffort(cli, m.modelId);
    const defaultThinkingLevel = isModelThinkingLevel(effort.default) ? effort.default : undefined;
    const thinkingLevelMap = buildThinkingLevelMap(effort);

    return {
      id: buildModelId(cli, m.modelId),
      name: m.name,
      reasoning: effort.supported,
      defaultThinkingLevel,
      thinkingLevelMap,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0 },
      maxTokens: backend.defaultMaxTokens,
    };
  }) as unknown as ProviderModels;
}

function getModelEffort(cli: CliType, modelId: string): ModelEffort {
  return getEffort(cli, modelId);
}

function buildThinkingLevelMap(effort: ModelEffort): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
  const levels = effort.levels?.filter(isModelThinkingLevel);
  if (!levels || levels.length === 0) return undefined;
  return Object.fromEntries(levels.map((level) => [level, level])) as NonNullable<Model<any>["thinkingLevelMap"]>;
}

function isModelThinkingLevel(value: string | undefined): value is NonNullable<Model<any>["defaultThinkingLevel"]> {
  return value !== undefined && MODEL_THINKING_LEVELS.has(value);
}

// 호환 별칭 — 이전 default export 사용처를 점진 정리하기 위해 유지
export default registerProviderRuntime;

// #endregion
