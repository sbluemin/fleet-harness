export interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}

export interface AgentToolCtx {
  readonly cwd: string;
  readonly sessionLabel?: string;
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

export interface RegisterExecutorToolOptions {
  readonly allowedScopes?: readonly string[];
}
