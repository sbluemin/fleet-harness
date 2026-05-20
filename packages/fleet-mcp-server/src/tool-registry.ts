import type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
  RegisterExecutorToolOptions,
} from "./types.js";

const TOOL_ID_PATTERN = /^[a-z0-9_]+$/;
const GLOBAL_EXECUTOR_SCOPE = "*";

const doctrineOrder: string[] = [];
const doctrineEntries = new Map<string, AgentToolSpec>();
const extraTools = new Map<string, Map<string, AgentToolSpec>>();
const executorWhitelist = new Map<string, Set<string>>([
  [GLOBAL_EXECUTOR_SCOPE, new Set()],
]);

export const EXECUTOR_MCP_TOOL_IDS = [
  "carrier_jobs",
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

export function registerAgentTool(spec: AgentToolSpec): void {
  assertToolId(spec.id, "id");
  assertToolId(spec.tag, "tag");
  assertUniqueTag(spec);

  if (!doctrineEntries.has(spec.id)) {
    doctrineOrder.push(spec.id);
  }

  doctrineEntries.set(spec.id, spec);
}

export function registerExecutorTool(spec: AgentToolSpec, opts?: RegisterExecutorToolOptions): void {
  registerAgentTool(spec);
  const scopes = opts?.allowedCarriers?.length ? opts.allowedCarriers : [GLOBAL_EXECUTOR_SCOPE];
  for (const scope of scopes) {
    addExecutorWhitelistEntry(scope, spec.id);
  }
}

export function getAllAgentTools(): AgentToolSpec[] {
  return doctrineOrder
    .map((id) => doctrineEntries.get(id))
    .filter((s): s is AgentToolSpec => s != null);
}

export function getExecutorMcpToolsForCarrier(
  carrierId?: string,
  metadataAllowedToolIds: readonly string[] = [],
): AgentToolSpec[] {
  const specs: AgentToolSpec[] = [];
  const ids = new Set<string>(executorWhitelist.get(GLOBAL_EXECUTOR_SCOPE));
  if (carrierId) {
    for (const id of executorWhitelist.get(carrierId) ?? []) {
      ids.add(id);
    }
    for (const id of metadataAllowedToolIds) {
      ids.add(id);
    }
  }
  for (const id of ids) {
    const spec = doctrineEntries.get(id);
    if (spec) specs.push(spec);
  }
  return specs;
}

export function renderAgentToolDoctrineTag(spec: AgentToolSpec): string {
  return `<fleet section="tool-guide" tool="${spec.tag}">\n${renderDoctrineMarkdown(spec)}\n</fleet>`;
}

export function list(): readonly AgentToolSpec[] {
  const specs: AgentToolSpec[] = [...getAllAgentTools()];
  for (const scoped of extraTools.values()) {
    for (const spec of scoped.values()) {
      if (!specs.some((s) => s.id === spec.id)) specs.push(spec);
    }
  }
  return specs;
}

export function listSpecs(): readonly AgentToolSpec[] {
  return getAllAgentTools();
}

export async function invoke(
  name: string,
  args: unknown,
  ctx?: Partial<AgentToolCtx>,
): Promise<McpCallToolResult> {
  const fullCtx: AgentToolCtx = {
    cwd: ctx?.cwd ?? process.cwd(),
    toolCallId: ctx?.toolCallId,
    signal: ctx?.signal,
  };

  const spec = doctrineEntries.get(name) ?? findExtraTool(name);
  if (!spec) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const result = await spec.execute(args, fullCtx);
  return toMcpCallToolResult(result);
}

export function registerExtraTools(scopeKey: string, tools: readonly AgentToolSpec[]): void {
  const scoped = extraTools.get(scopeKey) ?? new Map();
  for (const spec of tools) {
    scoped.set(spec.id, spec);
  }
  extraTools.set(scopeKey, scoped);
}

export function unregisterExtraTools(scopeKey: string, names: readonly string[]): void {
  const scoped = extraTools.get(scopeKey);
  if (!scoped) return;
  for (const name of names) {
    scoped.delete(name);
  }
  if (scoped.size === 0) {
    extraTools.delete(scopeKey);
  }
}

export function clearAllDefaultTools(): void {
  doctrineOrder.length = 0;
  doctrineEntries.clear();
  executorWhitelist.clear();
  executorWhitelist.set(GLOBAL_EXECUTOR_SCOPE, new Set());
}

export function clearAllExtraTools(): void {
  extraTools.clear();
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

function findExtraTool(name: string): AgentToolSpec | undefined {
  for (const scoped of extraTools.values()) {
    const spec = scoped.get(name);
    if (spec) return spec;
  }
  return undefined;
}

function addExecutorWhitelistEntry(scope: string, toolId: string): void {
  const scoped = executorWhitelist.get(scope) ?? new Set<string>();
  scoped.add(toolId);
  executorWhitelist.set(scope, scoped);
}

function assertToolId(value: string, field: "id" | "tag"): void {
  if (!TOOL_ID_PATTERN.test(value)) {
    throw new Error(`Invalid agent tool spec ${field}: "${value}"`);
  }
}

function assertUniqueTag(spec: AgentToolSpec): void {
  for (const existing of doctrineEntries.values()) {
    if (existing.id === spec.id) continue;
    if (existing.tag === spec.tag) {
      throw new Error(
        `Agent tool tag "${spec.tag}" is already registered by "${existing.id}"`,
      );
    }
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
