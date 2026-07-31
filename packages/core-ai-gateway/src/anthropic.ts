import type {
  CanonicalFunctionCallOutputItem,
  CanonicalResponseEvent,
  CanonicalResponseRequest,
  CanonicalToolChoice
} from "./canonical.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

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

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | Record<string, unknown>>;
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
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
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
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  max_tokens: number;
  thinking?: Record<string, unknown>;
  context_management?: Record<string, unknown>;
  stream: true;
}

export interface TranslateAnthropicRequestOptions {
  model?: string;
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
  if (request.stream !== true) {
    throw new TypeError("Anthropic Messages requests must use stream: true");
  }
  if (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0) {
    throw new TypeError("max_tokens must be a positive integer");
  }

  const canonical: CanonicalResponseRequest = {
    model: options.model ?? DEFAULT_OPENAI_MODEL,
    input: request.messages.flatMap(translateMessage),
    max_output_tokens: request.max_tokens,
    stream: true
  };

  if (request.system !== undefined) {
    canonical.instructions = request.system.map((block) => block.text).join("\n\n");
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    canonical.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.input_schema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict })
    }));
  }
  if (request.tool_choice !== undefined) {
    canonical.tool_choice = translateToolChoice(request.tool_choice);
    if (request.tool_choice.disable_parallel_tool_use !== undefined) {
      canonical.parallel_tool_calls = !request.tool_choice.disable_parallel_tool_use;
    }
  }

  const metadata = stringMetadata(request.metadata);
  if (metadata !== undefined) {
    canonical.metadata = metadata;
  }

  return canonical;
}

function translateMessage(message: AnthropicMessage): CanonicalResponseRequest["input"] {
  if (typeof message.content === "string") {
    return [{ type: "message", role: message.role, content: message.content }];
  }

  const items: CanonicalResponseRequest["input"] = [];
  let text = "";

  const flushText = (): void => {
    if (text.length === 0) {
      return;
    }
    items.push({ type: "message", role: message.role, content: text });
    text = "";
  };

  for (const block of message.content) {
    switch (block.type) {
      case "text":
        text += block.text;
        break;
      case "tool_use":
        flushText();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input)
        });
        break;
      case "tool_result":
        flushText();
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

  flushText();
  return items;
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

export async function* encodeAnthropicSse(
  events: AsyncIterable<CanonicalResponseEvent>
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
                input_tokens: event.response.usage?.input_tokens ?? 0,
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
            output_tokens: event.response.usage?.output_tokens ?? 0
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
