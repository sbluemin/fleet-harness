import type { AgentToolCtx, AgentToolSpec, McpCallToolResult, RegisterExecutorToolOptions } from "./spec.js";

export interface McpToolRegistry {
  registerAgentTool(spec: AgentToolSpec): void;
  registerExecutorTool(spec: AgentToolSpec, opts?: RegisterExecutorToolOptions): void;
  getAllAgentTools(): AgentToolSpec[];
  getExecutorMcpToolsForScope(
    scopeId?: string,
    metadataAllowedToolIds?: readonly string[],
  ): AgentToolSpec[];
  invoke(
    name: string,
    args: unknown,
    ctx?: Partial<AgentToolCtx>,
  ): Promise<McpCallToolResult>;
}

const TOOL_ID_PATTERN = /^[a-z0-9_]+$/;
const GLOBAL_EXECUTOR_SCOPE = "*";

export function createMcpToolRegistry(): McpToolRegistry {
  const agentToolOrder: string[] = [];
  const primaryToolSpecs = new Map<string, AgentToolSpec>();
  const executorToolScopes = new Map<string, Set<string>>([
    [GLOBAL_EXECUTOR_SCOPE, new Set()],
  ]);

  function addExecutorWhitelistEntry(scope: string, toolId: string): void {
    const scoped = executorToolScopes.get(scope) ?? new Set<string>();
    scoped.add(toolId);
    executorToolScopes.set(scope, scoped);
  }

  function assertUniqueTag(spec: AgentToolSpec): void {
    for (const existing of primaryToolSpecs.values()) {
      if (existing.id === spec.id) continue;
      if (existing.tag === spec.tag) {
        throw new Error(
          `Agent tool tag "${spec.tag}" is already registered by "${existing.id}"`,
        );
      }
    }
  }

  function registerToolSpec(spec: AgentToolSpec): void {
    assertToolId(spec.id, "id");
    assertToolId(spec.tag, "tag");
    assertUniqueTag(spec);
    primaryToolSpecs.set(spec.id, spec);
  }

  return {
    registerAgentTool(spec) {
      registerToolSpec(spec);
      if (!agentToolOrder.includes(spec.id)) {
        agentToolOrder.push(spec.id);
      }
    },
    registerExecutorTool(spec, opts) {
      registerToolSpec(spec);
      const scopes = opts?.allowedScopes != null
        ? opts.allowedScopes
        : [GLOBAL_EXECUTOR_SCOPE];
      for (const scope of scopes) {
        addExecutorWhitelistEntry(scope, spec.id);
      }
    },
    getAllAgentTools() {
      return agentToolOrder
        .map((id) => primaryToolSpecs.get(id))
        .filter((s): s is AgentToolSpec => s != null);
    },
    getExecutorMcpToolsForScope(scopeId, metadataAllowedToolIds = []) {
      const specs: AgentToolSpec[] = [];
      const ids = new Set<string>(executorToolScopes.get(GLOBAL_EXECUTOR_SCOPE));
      if (scopeId) {
        for (const id of executorToolScopes.get(scopeId) ?? []) {
          ids.add(id);
        }
        for (const id of metadataAllowedToolIds) {
          ids.add(id);
        }
      }
      for (const id of ids) {
        const spec = primaryToolSpecs.get(id);
        if (spec) specs.push(spec);
      }
      return specs;
    },
    async invoke(name, args, ctx) {
      const fullCtx: AgentToolCtx = {
        cwd: ctx?.cwd ?? process.cwd(),
        sessionLabel: ctx?.sessionLabel,
        toolCallId: ctx?.toolCallId,
        signal: ctx?.signal,
      };

      const spec = primaryToolSpecs.get(name);
      if (!spec) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const result = await spec.execute(args, fullCtx);
      return toMcpCallToolResult(result);
    },
  };
}

function assertToolId(value: string, field: "id" | "tag"): void {
  if (!TOOL_ID_PATTERN.test(value)) {
    throw new Error(`Invalid agent tool spec ${field}: "${value}"`);
  }
}

function toMcpCallToolResult(value: unknown): McpCallToolResult {
  if (isMcpCallToolResult(value)) {
    return value;
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }], isError: false };
  }
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError: false };
}

function isMcpCallToolResult(value: unknown): value is McpCallToolResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.content) && typeof obj.isError === "boolean";
}
