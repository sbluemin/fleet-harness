import type { McpCallToolResult } from "../_shared/mcp.js";

// ═════════════════════════════════════════════════════════
// Types / Interfaces
// ═════════════════════════════════════════════════════════

export interface AgentToolCtx {
  readonly cwd: string;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
}

/**
 * doctrine(프롬프트 가이드) + execution(파라미터/실행)을 통합한 단일 도구 스펙.
 * doctrine 필드는 `renderAgentToolDoctrineTag()`로 `<fleet>` 태그 블록으로 렌더링된다.
 */
export interface AgentToolSpec {
  readonly id: string;
  readonly tag: string;
  readonly title: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly usageGuidelines: readonly string[];
  readonly guardrails?: readonly string[];
  readonly parameters: Record<string, unknown>;
  execute(args: unknown, ctx: AgentToolCtx): Promise<unknown>;
}

export interface SessionHandle {
  readonly sessionId: string;
}

/** sendMessage 요청 — fleet-core가 firstPromptSent 분기 + runtime context wrapping 자체 처리. */
export interface ConversationHistoryEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SendMessageRequest {
  readonly userRequest: string;
  readonly history?: readonly ConversationHistoryEntry[];
}

export type { McpCallToolResult };

export type AgentStreamEvent =
  | { type: "text"; sessionId: string; text: string }
  | { type: "thought"; sessionId: string; text: string }
  | { type: "toolCall"; sessionId: string; toolCallId: string; title: string; status: string }
  | { type: "toolCallUpdate"; sessionId: string; toolCallId: string; title: string; status: string }
  | { type: "mcpToolCall"; sessionId: string; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: "complete"; sessionId: string; done: "stop" | "toolUse" }
  | { type: "error"; sessionId: string; error: string }
  | { type: "exit"; sessionId: string };
