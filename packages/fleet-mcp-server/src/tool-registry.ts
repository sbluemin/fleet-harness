import type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
  RegisterExecutorToolOptions,
} from "./types.js";

export interface McpToolRegistry {
  registerAgentTool(spec: AgentToolSpec): void;
  registerExecutorTool(spec: AgentToolSpec, opts?: RegisterExecutorToolOptions): void;
  getAllAgentTools(): AgentToolSpec[];
  getExecutorMcpToolsForCarrier(
    carrierId?: string,
    metadataAllowedToolIds?: readonly string[],
  ): AgentToolSpec[];
  renderAgentToolDoctrineTag(spec: AgentToolSpec): string;
  list(): readonly AgentToolSpec[];
  listSpecs(): readonly AgentToolSpec[];
  invoke(
    name: string,
    args: unknown,
    ctx?: Partial<AgentToolCtx>,
  ): Promise<McpCallToolResult>;
  registerExtraTools(scopeKey: string, tools: readonly AgentToolSpec[]): void;
  unregisterExtraTools(scopeKey: string, names: readonly string[]): void;
  clearAllDefaultTools(): void;
  clearAllExtraTools(): void;
}

const TOOL_ID_PATTERN = /^[a-z0-9_]+$/;
const GLOBAL_EXECUTOR_SCOPE = "*";

export function createMcpToolRegistry(): McpToolRegistry {
  const doctrineOrder: string[] = [];
  const primaryToolSpecs = new Map<string, AgentToolSpec>();
  const scopedToolSpecs = new Map<string, Map<string, AgentToolSpec>>();
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

  function findExtraTool(name: string): AgentToolSpec | undefined {
    for (const scoped of scopedToolSpecs.values()) {
      const spec = scoped.get(name);
      if (spec) return spec;
    }
    return undefined;
  }

  return {
    registerAgentTool(spec) {
      assertToolId(spec.id, "id");
      assertToolId(spec.tag, "tag");
      assertUniqueTag(spec);

      if (!primaryToolSpecs.has(spec.id)) {
        doctrineOrder.push(spec.id);
      }

      primaryToolSpecs.set(spec.id, spec);
    },
    registerExecutorTool(spec, opts) {
      this.registerAgentTool(spec);
      const scopes = opts?.allowedCarriers != null
        ? opts.allowedCarriers
        : [GLOBAL_EXECUTOR_SCOPE];
      for (const scope of scopes) {
        addExecutorWhitelistEntry(scope, spec.id);
      }
    },
    getAllAgentTools() {
      return doctrineOrder
        .map((id) => primaryToolSpecs.get(id))
        .filter((s): s is AgentToolSpec => s != null);
    },
    getExecutorMcpToolsForCarrier(carrierId, metadataAllowedToolIds = []) {
      const specs: AgentToolSpec[] = [];
      const ids = new Set<string>(executorToolScopes.get(GLOBAL_EXECUTOR_SCOPE));
      if (carrierId) {
        for (const id of executorToolScopes.get(carrierId) ?? []) {
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
    renderAgentToolDoctrineTag(spec) {
      return `<fleet section="tool-guide" tool="${spec.tag}">\n${renderDoctrineMarkdown(spec)}\n</fleet>`;
    },
    list() {
      const specs: AgentToolSpec[] = [...this.getAllAgentTools()];
      for (const scoped of scopedToolSpecs.values()) {
        for (const spec of scoped.values()) {
          if (!specs.some((s) => s.id === spec.id)) specs.push(spec);
        }
      }
      return specs;
    },
    listSpecs() {
      return this.getAllAgentTools();
    },
    async invoke(name, args, ctx) {
      const fullCtx: AgentToolCtx = {
        cwd: ctx?.cwd ?? process.cwd(),
        toolCallId: ctx?.toolCallId,
        signal: ctx?.signal,
      };

      const spec = primaryToolSpecs.get(name) ?? findExtraTool(name);
      if (!spec) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const result = await spec.execute(args, fullCtx);
      return toMcpCallToolResult(result);
    },
    registerExtraTools(scopeKey, tools) {
      const scoped = scopedToolSpecs.get(scopeKey) ?? new Map();
      for (const spec of tools) {
        scoped.set(spec.id, spec);
      }
      scopedToolSpecs.set(scopeKey, scoped);
    },
    unregisterExtraTools(scopeKey, names) {
      const scoped = scopedToolSpecs.get(scopeKey);
      if (!scoped) return;
      for (const name of names) {
        scoped.delete(name);
      }
      if (scoped.size === 0) {
        scopedToolSpecs.delete(scopeKey);
      }
    },
    clearAllDefaultTools() {
      doctrineOrder.length = 0;
      primaryToolSpecs.clear();
      executorToolScopes.clear();
      executorToolScopes.set(GLOBAL_EXECUTOR_SCOPE, new Set());
    },
    clearAllExtraTools() {
      scopedToolSpecs.clear();
    },
  };
}

export function renderAgentToolDoctrineTag(spec: AgentToolSpec): string {
  return `<fleet section="tool-guide" tool="${spec.tag}">\n${renderDoctrineMarkdown(spec)}\n</fleet>`;
}

function renderList(items: readonly string[]): string {
  return items
    .map((item) => {
      if (/^\s*(?:\d+\.\s|- )/.test(item)) {
        return item;
      }
      return `- ${item}`;
    })
    .join("\n");
}

function renderDoctrineMarkdown(spec: AgentToolSpec): string {
  const sections = [
    `# ${spec.title}`,
    spec.description,
    `## When to use\n${renderList(spec.whenToUse)}`,
    `## Usage guidelines\n${renderList(spec.usageGuidelines)}`,
  ];

  if (spec.whenNotToUse.length > 0) {
    sections.splice(3, 0, `## When NOT to use\n${renderList(spec.whenNotToUse)}`);
  }

  if (spec.guardrails && spec.guardrails.length > 0) {
    sections.push(`## Guardrails\n${renderList(spec.guardrails)}`);
  }

  return sections.join("\n\n");
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
