import type {
  CanonicalFunctionCallOutputItem,
  CanonicalInputContentPart,
  CanonicalInputMessage,
  CanonicalNativeTool,
  CanonicalNativeToolName,
  CanonicalReasoning,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalToolChoice,
  ReasoningEffort,
} from "./canonical.js";
import {
  clampReasoningEffort,
  normalizeCanonicalMessageContent,
  REASONING_EFFORTS,
} from "./canonical.js";
import { projectClaudeContextInputTokens } from "./claude-context.js";
import {
  gatewayProviderDefault,
  resolveGatewayModel,
  upstreamModelId,
} from "./models.js";
import type { GatewayModel } from "./models.js";

export const DEFAULT_CODEX_MODEL = upstreamModelId(gatewayProviderDefault("codex"));

export interface AnthropicSystemTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | {
        type: "base64";
        media_type: string;
        data: string;
      }
    | {
        type: "url";
        url: string;
      };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock | Record<string, unknown>>;
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  data?: string;
  signature?: string;
}

export type AnthropicMessageBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  // Claude Code는 스펙 문서와 달리 messages 안에 role:"system"을 실어 보낸다(실측).
  role: "user" | "assistant" | "system";
  content: string | AnthropicMessageBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
  defer_loading?: boolean;
  cache_control?: unknown;
}

/** Anthropic executes this tool server-side; there is deliberately no input_schema. */
export interface AnthropicWebSearchTool {
  type: "web_search_20250305";
  name: "web_search";
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_uses?: number;
  cache_control?: unknown;
}

export type AnthropicToolDefinition = AnthropicTool | AnthropicWebSearchTool;

export type AnthropicToolChoice =
  | {
      type: "auto" | "any" | "none";
      disable_parallel_tool_use?: boolean;
    }
  | {
      type: "tool";
      name: string;
      disable_parallel_tool_use?: boolean;
    };

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystemTextBlock[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  max_tokens: number;
  thinking?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
  context_management?: Record<string, unknown>;
  /** Claude Code는 일부 요청을 비스트리밍으로 보낸다. 없거나 false면 응답을 단일 JSON으로 돌려줘야 한다. */
  stream?: boolean;
}

export interface TranslateAnthropicRequestOptions {
  /** 지정하면 요청이 지목한 모델을 무시하고 이 값으로 고정한다. */
  model?: string;
  /** 게이트웨이가 discovery로 노출한 모델. 요청이 이 중 하나면 그대로 통과시킨다. */
  catalog?: readonly GatewayModel[];
  /** Provider-specific service tier selected by a catalog alias. */
  serviceTier?: "priority";
  /** Reasoning ladder supported by the selected upstream model. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** Provider-owned tools supported by the selected adapter. */
  nativeTools?: readonly CanonicalNativeToolName[];
}

export class UnsupportedAnthropicContentError extends TypeError {
  constructor(type: string) {
    super(`Unsupported Anthropic content block type: ${type}`);
    this.name = "UnsupportedAnthropicContentError";
  }
}

export function translateAnthropicRequest(
  request: AnthropicMessagesRequest,
  options: TranslateAnthropicRequestOptions = {}
): CanonicalResponseRequest {
  if (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0) {
    throw new TypeError("max_tokens must be a positive integer");
  }

  const canonical: CanonicalResponseRequest = {
    model: resolveGatewayModel(request.model, {
      ...(options.model ? { override: options.model } : {}),
      ...(options.catalog ? { catalog: options.catalog } : {}),
      fallback: DEFAULT_CODEX_MODEL,
    }),
    input: request.messages.flatMap(translateMessage),
    max_output_tokens: request.max_tokens,
    stream: true
  };

  if (request.system !== undefined) {
    canonical.instructions = request.system.map((block) => block.text).join("\n\n");
  }
  const translatedTools = translateAnthropicTools(request, options.nativeTools);
  if (translatedTools.functions.length > 0) {
    canonical.tools = translatedTools.functions;
  }
  if (translatedTools.native.length > 0) {
    canonical.native_tools = translatedTools.native;
  }
  if (request.tool_choice !== undefined) {
    const selectedToolName = request.tool_choice.type === "tool"
      ? request.tool_choice.name
      : undefined;
    const selectsNativeTool = selectedToolName !== undefined
      && translatedTools.native.some((tool) => tool.type === selectedToolName);
    if (!selectsNativeTool) {
      canonical.tool_choice = translateToolChoice(request.tool_choice);
      if (request.tool_choice.disable_parallel_tool_use !== undefined) {
        canonical.parallel_tool_calls = !request.tool_choice.disable_parallel_tool_use;
      }
    }
  }

  const reasoning = translateAnthropicReasoning(request, options.reasoningEfforts);
  if (reasoning !== undefined) {
    canonical.reasoning = reasoning;
  }

  const metadata = stringMetadata(request.metadata);
  if (metadata !== undefined) {
    canonical.metadata = metadata;
  }
  if (options.serviceTier) {
    canonical.service_tier = options.serviceTier;
  }

  return canonical;
}

interface TranslatedAnthropicTools {
  readonly functions: NonNullable<CanonicalResponseRequest["tools"]>;
  readonly native: CanonicalNativeTool[];
}

function translateAnthropicTools(
  request: Pick<AnthropicMessagesRequest, "tools" | "tool_choice">,
  supportedNativeTools: readonly CanonicalNativeToolName[] | undefined,
): TranslatedAnthropicTools {
  const supported = new Set(supportedNativeTools ?? []);
  const functions: NonNullable<CanonicalResponseRequest["tools"]> = [];
  const native: CanonicalNativeTool[] = [];

  for (const tool of request.tools ?? []) {
    if (isAnthropicFunctionTool(tool)) {
      functions.push({
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.input_schema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      });
      continue;
    }
    if (tool.type === "web_search_20250305" && tool.name === "web_search") {
      if (!supported.has("web_search")) {
        throw new TypeError("Selected adapter does not support Anthropic server tool web_search_20250305");
      }
      native.push({
        type: "web_search",
        ...validatedWebSearchDomains("allowed_domains", tool.allowed_domains),
        ...validatedWebSearchDomains("blocked_domains", tool.blocked_domains),
        ...validatedWebSearchMaxUses(tool.max_uses),
        ...(request.tool_choice?.type === "tool" && request.tool_choice.name === "web_search"
          ? { required: true }
          : {}),
      });
      continue;
    }
    const type = "type" in tool && typeof tool.type === "string" ? tool.type : "function";
    throw new TypeError(`Unsupported Anthropic tool definition: ${type}`);
  }

  return { functions, native };
}

function isAnthropicFunctionTool(tool: AnthropicToolDefinition): tool is AnthropicTool {
  return "input_schema" in tool && isRecord(tool.input_schema);
}

const WEB_SEARCH_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function validatedWebSearchDomains(
  field: "allowed_domains" | "blocked_domains",
  value: string[] | undefined,
): Partial<Pick<CanonicalNativeTool & Record<string, unknown>, typeof field>> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((domain) => (
    typeof domain !== "string" || !WEB_SEARCH_DOMAIN.test(domain)
  ))) {
    throw new TypeError(`${field} must contain only valid web search hostnames`);
  }
  return { [field]: [...value] };
}

function validatedWebSearchMaxUses(maxUses: number | undefined): { max_uses?: number } {
  if (maxUses === undefined) return {};
  if (!Number.isSafeInteger(maxUses) || maxUses <= 0) {
    throw new TypeError("web_search max_uses must be a positive integer");
  }
  return { max_uses: maxUses };
}

const REASONING_EFFORT_SET = new Set<unknown>(REASONING_EFFORTS);

/** Translate Claude Code's adaptive `/effort` wire into the Responses reasoning shape. */
export function translateAnthropicReasoning(
  request: Pick<AnthropicMessagesRequest, "thinking" | "output_config">,
  supportedEfforts?: readonly ReasoningEffort[],
): CanonicalReasoning | undefined {
  const thinking = isRecord(request.thinking) ? request.thinking : undefined;
  if (thinking?.type === "disabled") {
    return undefined;
  }

  const configuredEffort = reasoningEffortFromOutputConfig(request.output_config);
  if (thinking === undefined && configuredEffort === undefined) {
    return undefined;
  }

  const requestedEffort = configuredEffort ?? reasoningEffortFromThinkingBudget(thinking);
  const effort = requestedEffort === undefined
    ? undefined
    : clampReasoningEffort(requestedEffort, supportedEfforts);
  return {
    summary: "auto",
    ...(effort === undefined ? {} : { effort }),
  };
}

export function reasoningEffortFromOutputConfig(outputConfig: unknown): ReasoningEffort | undefined {
  if (!isRecord(outputConfig)) {
    return undefined;
  }
  const effort = outputConfig.effort;
  return REASONING_EFFORT_SET.has(effort) ? effort as ReasoningEffort : undefined;
}

function reasoningEffortFromThinkingBudget(
  thinking: Record<string, unknown> | undefined,
): ReasoningEffort | undefined {
  if (thinking?.type !== "enabled" || typeof thinking.budget_tokens !== "number") {
    return undefined;
  }
  if (thinking.budget_tokens <= 4_096) return "low";
  if (thinking.budget_tokens <= 16_384) return "medium";
  return "high";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function translateMessage(message: AnthropicMessage): CanonicalResponseRequest["input"] {
  const role = canonicalRole(message.role);
  if (typeof message.content === "string") {
    return [{ type: "message", role, content: message.content }];
  }

  const items: CanonicalResponseRequest["input"] = [];
  const parts: CanonicalInputContentPart[] = [];

  const flushParts = (): void => {
    if (parts.length === 0) {
      return;
    }
    items.push({
      type: "message",
      role,
      content: normalizeCanonicalMessageContent(parts.splice(0, parts.length)),
    });
  };

  for (const block of message.content) {
    switch (block.type) {
      case "text":
        if (block.text.length > 0) {
          parts.push({ type: "input_text", text: block.text });
        }
        break;
      case "image":
        parts.push(translateImageBlock(block));
        break;
      case "tool_use":
        flushParts();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input)
        });
        break;
      case "tool_result":
        flushParts();
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: toolResultText(block.content)
        });
        break;
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throw new UnsupportedAnthropicContentError(
          (block as { type?: unknown }).type === undefined
            ? "unknown"
            : String((block as { type: unknown }).type)
        );
    }
  }

  flushParts();
  return items;
}

function translateImageBlock(block: AnthropicImageBlock): CanonicalInputContentPart {
  const source: unknown = block.source;
  if (!isRecord(source) || typeof source.type !== "string") {
    throw new UnsupportedAnthropicContentError("image");
  }
  if (source.type === "base64") {
    if (
      typeof source.media_type !== "string"
      || typeof source.data !== "string"
      || !source.media_type.startsWith("image/")
      || source.data.length === 0
    ) {
      throw new UnsupportedAnthropicContentError("image");
    }
    return {
      type: "input_image",
      image_url: `data:${source.media_type};base64,${source.data}`,
      detail: "auto",
    };
  }
  if (source.type === "url") {
    if (typeof source.url !== "string" || source.url.length === 0) {
      throw new UnsupportedAnthropicContentError("image");
    }
    return {
      type: "input_image",
      image_url: source.url,
      detail: "auto",
    };
  }
  throw new UnsupportedAnthropicContentError(`image:${source.type}`);
}

function canonicalRole(role: AnthropicMessage["role"]): CanonicalInputMessage["role"] {
  return role === "system" ? "developer" : role;
}

function toolResultText(content: AnthropicToolResultBlock["content"]): string {
  if (content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "image") {
        return "[image]";
      }
      return JSON.stringify(block);
    })
    .join("");
}

function translateToolChoice(toolChoice: AnthropicToolChoice): CanonicalToolChoice {
  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: toolChoice.name };
  }
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const entries = Object.entries(metadata).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

interface OpenBlock {
  index: number;
  kind: "text" | "tool_use";
  accumulatedJson: string;
  closed: boolean;
}

export interface ClaudeResponseCompatibilityOptions {
  /** Picker-advertised window that decides whether Claude uses its 1M compatibility path. */
  readonly contextWindow?: number;
}

/** 비스트리밍 요청에 돌려줄 Anthropic Messages 응답 본문을 이벤트에서 조립한다. */
export async function collectAnthropicMessage(
  events: AsyncIterable<CanonicalResponseEvent>,
  fallbackModel: string,
  options: ClaudeResponseCompatibilityOptions = {},
): Promise<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  const toolArgs = new Map<string, { index: number; text: string }>();
  let id = "msg_gateway";
  let model = fallbackModel;
  let text = "";
  let stopReason = "end_turn";
  let outputTokens = 0;
  let inputTokens = 0;
  let upstreamContextWindow: number | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "response.created":
        id = event.response.id;
        model = event.response.model;
        inputTokens = event.response.usage?.input_tokens ?? 0;
        upstreamContextWindow = event.response.usage?.context_window;
        break;
      case "response.output_text.delta":
        text += event.delta;
        break;
      case "response.output_item.added":
        if (event.item.type === "function_call") {
          stopReason = "tool_use";
          const index = content.length;
          content.push({ type: "tool_use", id: event.item.call_id, name: event.item.name, input: {} });
          toolArgs.set(event.item.id, { index, text: "" });
        }
        break;
      case "response.function_call_arguments.delta": {
        const entry = toolArgs.get(event.item_id);
        if (entry) entry.text += event.delta;
        break;
      }
      case "response.function_call_arguments.done": {
        const entry = toolArgs.get(event.item_id);
        if (entry) entry.text = event.arguments;
        break;
      }
      case "response.completed":
        inputTokens = event.response.usage?.input_tokens ?? inputTokens;
        outputTokens = event.response.usage?.output_tokens ?? 0;
        upstreamContextWindow = event.response.usage?.context_window ?? upstreamContextWindow;
        break;
      case "response.failed":
        throw new Error(event.response.error.message);
      case "error":
        throw new Error(event.error.message);
      default:
        break;
    }
  }

  for (const entry of toolArgs.values()) {
    const block = content[entry.index];
    if (block) block.input = safeJson(entry.text);
  }
  if (text.length > 0) content.unshift({ type: "text", text });

  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: projectClaudeContextInputTokens(
        inputTokens,
        options.contextWindow,
        upstreamContextWindow,
      ),
      output_tokens: outputTokens,
    },
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function* encodeAnthropicSse(
  events: AsyncIterable<CanonicalResponseEvent>,
  options: ClaudeResponseCompatibilityOptions = {},
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const blocks = new Map<string, OpenBlock>();
  let nextBlockIndex = 0;
  let messageStarted = false;
  let messageStopped = false;
  let sawToolUse = false;

  const encode = (event: string, data: unknown): Uint8Array =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const startTextBlock = (key: string): Uint8Array | undefined => {
    if (blocks.has(key)) {
      return undefined;
    }
    const block: OpenBlock = {
      index: nextBlockIndex++,
      kind: "text",
      accumulatedJson: "",
      closed: false
    };
    blocks.set(key, block);
    return encode("content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: { type: "text", text: "" }
    });
  };

  const closeBlock = (key: string): Uint8Array | undefined => {
    const block = blocks.get(key);
    if (block === undefined || block.closed) {
      return undefined;
    }
    block.closed = true;
    return encode("content_block_stop", {
      type: "content_block_stop",
      index: block.index
    });
  };

  for await (const event of events) {
    switch (event.type) {
      case "response.created":
        if (!messageStarted) {
          messageStarted = true;
          yield encode("message_start", {
            type: "message_start",
            message: {
              id: event.response.id,
              type: "message",
              role: "assistant",
              content: [],
              model: event.response.model,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: projectClaudeContextInputTokens(
                  event.response.usage?.input_tokens ?? 0,
                  options.contextWindow,
                  event.response.usage?.context_window,
                ),
                output_tokens: 0
              }
            }
          });
        }
        break;
      case "response.content_part.added": {
        const key = textBlockKey(event.item_id, event.content_index);
        const start = startTextBlock(key);
        if (start !== undefined) {
          yield start;
        }
        break;
      }
      case "response.output_text.delta": {
        const key = textBlockKey(event.item_id, event.content_index);
        const start = startTextBlock(key);
        if (start !== undefined) {
          yield start;
        }
        const block = blocks.get(key);
        if (block !== undefined) {
          yield encode("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "text_delta", text: event.delta }
          });
        }
        break;
      }
      case "response.output_text.done": {
        const stop = closeBlock(textBlockKey(event.item_id, event.content_index));
        if (stop !== undefined) {
          yield stop;
        }
        break;
      }
      case "response.output_item.added":
        if (event.item.type === "function_call") {
          sawToolUse = true;
          const block: OpenBlock = {
            index: nextBlockIndex++,
            kind: "tool_use",
            accumulatedJson: "",
            closed: false
          };
          blocks.set(event.item.id, block);
          yield encode("content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: {
              type: "tool_use",
              id: event.item.call_id,
              name: event.item.name,
              input: {}
            }
          });
        }
        break;
      case "response.function_call_arguments.delta": {
        const block = requiredToolBlock(blocks, event.item_id);
        block.accumulatedJson += event.delta;
        yield encode("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: event.delta }
        });
        break;
      }
      case "response.function_call_arguments.done": {
        const block = requiredToolBlock(blocks, event.item_id);
        const remainder = remainingArguments(block.accumulatedJson, event.arguments);
        if (remainder.length > 0) {
          block.accumulatedJson += remainder;
          yield encode("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: remainder }
          });
        }
        const stop = closeBlock(event.item_id);
        if (stop !== undefined) {
          yield stop;
        }
        break;
      }
      case "response.output_item.done":
        if (event.item.type === "function_call") {
          let block = blocks.get(event.item.id);
          if (block === undefined) {
            const syntheticStart = functionCallStart(event.item, nextBlockIndex++);
            block = syntheticStart.block;
            blocks.set(event.item.id, block);
            sawToolUse = true;
            yield encode("content_block_start", syntheticStart.data);
          }
          const remainder = remainingArguments(block.accumulatedJson, event.item.arguments);
          if (remainder.length > 0) {
            block.accumulatedJson += remainder;
            yield encode("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: remainder }
            });
          }
          const stop = closeBlock(event.item.id);
          if (stop !== undefined) {
            yield stop;
          }
        }
        break;
      case "response.completed":
        for (const [key] of blocks) {
          const stop = closeBlock(key);
          if (stop !== undefined) {
            yield stop;
          }
        }
        yield encode("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: sawToolUse ? "tool_use" : "end_turn",
            stop_sequence: null
          },
          usage: {
            // Claude Code updates context occupancy from the terminal cumulative
            // usage frame. Sending output-only leaves Responses-backed models at
            // zero input usage even though Kimi's native Anthropic stream works.
            input_tokens: projectClaudeContextInputTokens(
              event.response.usage?.input_tokens ?? 0,
              options.contextWindow,
              event.response.usage?.context_window,
            ),
            output_tokens: event.response.usage?.output_tokens ?? 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          }
        });
        yield encode("message_stop", { type: "message_stop" });
        messageStopped = true;
        break;
      case "response.failed":
        yield encode("error", { type: "error", error: event.response.error });
        messageStopped = true;
        break;
      case "error":
        yield encode("error", { type: "error", error: event.error });
        messageStopped = true;
        break;
    }
  }

  if (messageStarted && !messageStopped) {
    throw new TypeError("OpenAI response stream ended before response.completed");
  }
}

function textBlockKey(itemId: string, contentIndex: number): string {
  return `${itemId}:${contentIndex}`;
}

function requiredToolBlock(blocks: Map<string, OpenBlock>, itemId: string): OpenBlock {
  const block = blocks.get(itemId);
  if (block === undefined || block.kind !== "tool_use") {
    throw new TypeError(`Function call delta arrived before its item: ${itemId}`);
  }
  return block;
}

function remainingArguments(accumulated: string, complete: string): string {
  return complete.startsWith(accumulated) ? complete.slice(accumulated.length) : "";
}

function functionCallStart(item: CanonicalFunctionCallOutputItem, index: number): {
  block: OpenBlock;
  data: unknown;
} {
  return {
    block: { index, kind: "tool_use", accumulatedJson: "", closed: false },
    data: {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: {}
      }
    }
  };
}
