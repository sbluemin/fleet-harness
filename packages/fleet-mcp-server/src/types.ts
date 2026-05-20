export interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}

export interface AgentToolCtx {
  readonly cwd: string;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
}

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
  readonly parameters: unknown;
  execute(args: unknown, ctx: AgentToolCtx): Promise<unknown>;
}

export interface McpTool {
  name: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PendingToolCallState {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  emitted: boolean;
}

export interface McpSessionRoutingState {
  sessionKey: string;
  mcpSessionToken?: string;
  pendingToolCalls: PendingToolCallState[];
  pendingToolCallNotifier?: (() => void) | null;
}

export interface McpProviderRoutingState<TSession extends McpSessionRoutingState = McpSessionRoutingState> {
  sessions: Map<string, TSession>;
  toolCallToSessionKey: Map<string, string>;
}

export interface RegisterExecutorToolOptions {
  readonly allowedCarriers?: readonly string[];
}
