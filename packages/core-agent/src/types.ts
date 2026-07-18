export interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}

/** Server-owned string values that are available only while invoking local MCP tools. */
export type AgentServerBindings = Readonly<Record<string, string>>;

export function snapshotAgentServerBindings(
  bindings: AgentServerBindings | undefined,
): AgentServerBindings | undefined {
  return bindings === undefined ? undefined : Object.freeze({ ...bindings });
}

export interface AgentToolCtx {
  readonly cwd: string;
  readonly sessionLabel?: string;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
  readonly serverBindings?: AgentServerBindings;
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

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcPayload = JsonRpcRequest | readonly JsonRpcRequest[];

export type JsonRpcResultPayload = JsonRpcResponse | readonly JsonRpcResponse[] | null;

export type TrackStatus = "queued" | "conn" | "stream" | "done" | "err" | "aborted";
