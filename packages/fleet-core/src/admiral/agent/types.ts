export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
} from "@sbluemin/fleet-mcp-server";

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

export type AgentStreamEvent =
  | { type: "text"; sessionId: string; text: string }
  | { type: "thought"; sessionId: string; text: string }
  | { type: "toolCall"; sessionId: string; toolCallId: string; title: string; status: string }
  | { type: "toolCallUpdate"; sessionId: string; toolCallId: string; title: string; status: string }
  | { type: "mcpToolCall"; sessionId: string; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: "complete"; sessionId: string; done: "stop" | "toolUse" }
  | { type: "error"; sessionId: string; error: string }
  | { type: "exit"; sessionId: string };
