import type { ClaudeGatewayMessage } from "./contracts.js";

export type ClaudeExecutionEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool-start";
      readonly id?: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool-end";
      readonly id?: string;
      readonly name?: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: "result";
      readonly isError: boolean;
      readonly detail?: string;
      readonly source: "message" | "incomplete" | "watchdog";
      /** 자식이 보고한 턴의 사용량. 결과 메시지가 싣지 않으면 없다. */
      readonly usage?: ClaudeExecutionUsage;
    };

export interface ClaudeExecutionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface ClaudeExecutionEventDecoder {
  decode(message: ClaudeGatewayMessage): readonly ClaudeExecutionEvent[];
}

/**
 * 자식이 흘리는 메시지를 정규화한다.
 *
 * 모양은 실측으로 고정했다. 답변 텍스트와 사고가 같은 `content_block_delta` 자리로 오되
 * `text_delta`와 `thinking_delta`로 갈리며, 도구는 assistant의 `tool_use`로 시작해 user의
 * `tool_result`로 끝난다. 이름은 앞쪽에만 실려 있어 id로 짝짓는다. 한 디코더의 짝짓기는
 * 그 인스턴스 수명 동안만 유효하다.
 */
export function createClaudeExecutionEventDecoder(): ClaudeExecutionEventDecoder {
  const toolNames = new Map<string, string>();
  return {
    decode(message: ClaudeGatewayMessage): readonly ClaudeExecutionEvent[] {
      if (!isRecord(message)) return [];
      if (message.type === "stream_event") return decodeStreamEvent(message);
      if (message.type === "assistant") return decodeAssistant(message, toolNames);
      if (message.type === "user") return decodeUser(message, toolNames);
      if (message.type === "result") return decodeResult(message);
      return [];
    },
  };
}

function decodeStreamEvent(message: Record<string, unknown>): readonly ClaudeExecutionEvent[] {
  const inner = record(message.event);
  if (inner.type !== "content_block_delta") return [];
  const delta = record(inner.delta);
  if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
    return [{ kind: "text", text: delta.text }];
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
    return [{ kind: "thinking", text: delta.thinking }];
  }
  return [];
}

function decodeAssistant(
  message: Record<string, unknown>,
  toolNames: Map<string, string>,
): readonly ClaudeExecutionEvent[] {
  const events: ClaudeExecutionEvent[] = [];
  for (const block of blocks(message.message)) {
    if (block.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "tool";
    const id = typeof block.id === "string" ? block.id : undefined;
    if (id !== undefined) toolNames.set(id, name);
    events.push({
      kind: "tool-start",
      ...(id === undefined ? {} : { id }),
      name,
      input: block.input,
    });
  }
  return events;
}

function decodeUser(
  message: Record<string, unknown>,
  toolNames: Map<string, string>,
): readonly ClaudeExecutionEvent[] {
  const events: ClaudeExecutionEvent[] = [];
  for (const block of blocks(message.message)) {
    if (block.type !== "tool_result") continue;
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const name = id === undefined ? undefined : toolNames.get(id);
    events.push({
      kind: "tool-end",
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      isError: block.is_error === true,
    });
  }
  return events;
}

function decodeResult(message: Record<string, unknown>): readonly ClaudeExecutionEvent[] {
  const usage = decodeUsage(message);
  return [{
    kind: "result",
    isError: message.is_error === true,
    ...(typeof message.result === "string" ? { detail: message.result } : {}),
    source: "message",
    ...(usage === null ? {} : { usage }),
  }];
}

/** `usage.input_tokens/output_tokens`와 `total_cost_usd`만 읽는다 — 그 밖의 집계는 원장의 몫이다. */
function decodeUsage(message: Record<string, unknown>): ClaudeExecutionUsage | null {
  const usage = record(message.usage);
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  // 캐시로 읽은 입력도 입력이다 — 빼면 "토큰 235에 $0.05"처럼 수와 값이 서로 설명하지 못한다.
  const cached = numberOr(usage.cache_read_input_tokens) + numberOr(usage.cache_creation_input_tokens);
  const cost = message.total_cost_usd;
  return {
    inputTokens: inputTokens + cached,
    outputTokens,
    ...(typeof cost === "number" && Number.isFinite(cost) ? { costUsd: cost } : {}),
  };
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function blocks(message: unknown): readonly Record<string, unknown>[] {
  const content = record(message).content;
  return Array.isArray(content) ? content.map(record) : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
