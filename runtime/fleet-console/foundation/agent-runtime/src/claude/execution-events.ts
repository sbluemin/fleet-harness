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
    }
  /**
   * 자식이 대화를 요약해 이어 갔다(`compact_boundary`). 턴 시작이든 도구 루프 중간이든 그 자리에서 온다.
   * 토큰은 자식이 말한 그대로다 — 게이트웨이 모델이면 게이트웨이가 투영한 Claude 좌표다.
   */
  | {
      readonly kind: "compacted";
      readonly trigger: "auto" | "manual";
      readonly preTokens: number;
      readonly postTokens?: number;
    };

export interface ClaudeExecutionUsage {
  /** 이 턴의 주 루프 호출들이 읽은 입력의 합(캐시 포함). 도구 루프가 돌면 호출마다 다시 더해진다. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
  /**
   * 이 턴의 마지막 주 루프 호출이 읽은 입력(캐시 포함) — 다음 턴이 이어받는 대화의 크기다. `inputTokens`는
   * 합이라 대화 크기로 읽으면 도구를 쓴 만큼 부풀고(실측: 40k+41k 호출이 81k), 압축 뒤의 줄어든 대화도 말하지 못한다.
   * 결과 전에 호출이 하나도 관찰되지 않으면 없다.
   */
  readonly contextTokens?: number;
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
  // 마지막 주 루프 호출의 입력. 서브에이전트(`parent_tool_use_id`)의 호출은 이 대화의 크기가 아니다.
  let contextTokens: number | null = null;
  return {
    decode(message: ClaudeGatewayMessage): readonly ClaudeExecutionEvent[] {
      if (!isRecord(message)) return [];
      if (message.type === "stream_event") return decodeStreamEvent(message);
      if (message.type === "assistant") {
        if (message.parent_tool_use_id == null) contextTokens = callInputTokens(record(message.message).usage) ?? contextTokens;
        return decodeAssistant(message, toolNames);
      }
      if (message.type === "user") return decodeUser(message, toolNames);
      if (message.type === "system" && message.subtype === "compact_boundary") {
        const event = decodeCompactBoundary(message);
        // 압축 뒤 호출이 아직 없으면 요약된 대화의 크기가 지금의 크기다.
        if (event?.kind === "compacted" && event.postTokens !== undefined) contextTokens = event.postTokens;
        return event ? [event] : [];
      }
      if (message.type === "result") return decodeResult(message, contextTokens);
      return [];
    },
  };
}

function decodeCompactBoundary(message: Record<string, unknown>): ClaudeExecutionEvent | null {
  const meta = record(message.compact_metadata);
  if (typeof meta.pre_tokens !== "number" || !Number.isFinite(meta.pre_tokens)) return null;
  return {
    kind: "compacted",
    trigger: meta.trigger === "manual" ? "manual" : "auto",
    preTokens: meta.pre_tokens,
    ...(typeof meta.post_tokens === "number" && Number.isFinite(meta.post_tokens) ? { postTokens: meta.post_tokens } : {}),
  };
}

/** 호출 하나의 입력 — 자식의 압축 판정과 같은 합(`input + cache_read + cache_creation`)이다. */
function callInputTokens(value: unknown): number | null {
  const usage = record(value);
  if (typeof usage.input_tokens !== "number") return null;
  return usage.input_tokens + numberOr(usage.cache_read_input_tokens) + numberOr(usage.cache_creation_input_tokens);
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

function decodeResult(message: Record<string, unknown>, contextTokens: number | null): readonly ClaudeExecutionEvent[] {
  const decoded = decodeUsage(message);
  const usage = decoded === null || contextTokens === null ? decoded : { ...decoded, contextTokens };
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
