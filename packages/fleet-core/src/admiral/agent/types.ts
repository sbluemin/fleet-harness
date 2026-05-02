import type { TypeBoxSchema } from "../../services/tool-registry/types.js";
import type { McpCallToolResult } from "../_shared/mcp.js";

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

export interface AgentToolCtx {
  readonly cwd: string;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
}

export interface RenderEntry {
  label: string;
  text: string;
}

export interface ToolMetadata {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: TypeBoxSchema;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly displayHints?: {
    readonly icon?: string;
    readonly badgeColor?: string;
    previewExtractor?(args: unknown): readonly RenderEntry[];
  };
}

export interface AgentToolSpec {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: TypeBoxSchema;
  execute(args: unknown, ctx: AgentToolCtx): Promise<unknown>;
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
