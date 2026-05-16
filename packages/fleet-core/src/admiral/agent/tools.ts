import type { AgentToolCtx, AgentToolSpec, McpCallToolResult } from "./types.js";
import { buildCarrierJobsToolSpec } from "../carrier-jobs/tool-spec.js";
import { getRegisteredCarrierConfig } from "../carrier/framework.js";
import { buildCarrierDispatchToolSpec } from "../carrier/tool-spec.js";
import { buildRequestDirectiveToolSpec } from "../request-directive/tool-spec.js";
import { buildSquadronToolSpec } from "../squadron/tool-spec.js";
import { buildTaskForceToolSpec } from "../taskforce/tool-spec.js";

// ═════════════════════════════════════════════════════════
// Agent Tool Registry — doctrine + 실행 통합 저장소 (SSoT)
// ═════════════════════════════════════════════════════════

const TOOL_ID_PATTERN = /^[a-z0-9_]+$/;
const doctrineOrder: string[] = [];
const doctrineEntries = new Map<string, AgentToolSpec>();
const extraTools = new Map<string, Map<string, AgentToolSpec>>();
let defaultToolsBuilt = false;

interface RegisterExecutorToolOptions {
  readonly allowedCarriers?: readonly string[];
}

// Runtime Map that drives getExecutorMcpTools(). "*" is the global executor MCP scope.
// Domain packages (e.g. fleet-wiki) extend this at module load time via registerExecutorTool().
const GLOBAL_EXECUTOR_SCOPE = "*";
const executorWhitelist = new Map<string, Set<string>>([
  [GLOBAL_EXECUTOR_SCOPE, new Set()],
]);

// Superset enumeration of all possible executor tool IDs — kept for test compatibility and auditing.
// The runtime source of truth is executorWhitelist, not this constant.
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
  ensureDefaultToolsRegistered();
  return doctrineOrder
    .map((id) => doctrineEntries.get(id))
    .filter((s): s is AgentToolSpec => s != null);
}

export function getExecutorMcpTools(carrierId?: string): AgentToolSpec[] {
  ensureDefaultToolsRegistered();
  const specs: AgentToolSpec[] = [];
  const ids = new Set<string>(executorWhitelist.get(GLOBAL_EXECUTOR_SCOPE));
  if (carrierId) {
    for (const id of executorWhitelist.get(carrierId) ?? []) {
      ids.add(id);
    }
    const config = getRegisteredCarrierConfig(carrierId);
    for (const id of config?.carrierMetadata?.allowedExecutorTools ?? []) {
      ids.add(id);
    }
  }
  for (const id of ids) {
    const spec = doctrineEntries.get(id);
    if (spec) specs.push(spec);
  }
  return specs;
}

// ═════════════════════════════════════════════════════════
// Doctrine Formatter — spec → `<fleet>` 태그 블록
// ═════════════════════════════════════════════════════════

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

export function renderAgentToolDoctrineTag(spec: AgentToolSpec): string {
  return `<fleet section="tool-guide" tool="${spec.tag}">\n${renderDoctrineMarkdown(spec)}\n</fleet>`;
}

// ═════════════════════════════════════════════════════════
// Tool Registry — 도구 등록/조회/실행
// ═════════════════════════════════════════════════════════

export function list(): readonly AgentToolSpec[] {
  ensureDefaultToolsRegistered();
  const specs: AgentToolSpec[] = [...getAllAgentTools()];
  for (const scoped of extraTools.values()) {
    for (const spec of scoped.values()) {
      if (!specs.some((s) => s.id === spec.id)) specs.push(spec);
    }
  }
  return specs;
}

export function listSpecs(): readonly AgentToolSpec[] {
  ensureDefaultToolsRegistered();
  return getAllAgentTools();
}

export async function invoke(name: string, args: unknown, ctx?: Partial<AgentToolCtx>): Promise<McpCallToolResult> {
  ensureDefaultToolsRegistered();
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
  defaultToolsBuilt = false;
  executorWhitelist.clear();
  executorWhitelist.set(GLOBAL_EXECUTOR_SCOPE, new Set());
}

export function clearAllExtraTools(): void {
  extraTools.clear();
}

// ═════════════════════════════════════════════════════════
// 내부 헬퍼
// ═════════════════════════════════════════════════════════

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

function ensureDefaultToolsRegistered(): void {
  if (defaultToolsBuilt) return;
  defaultToolsBuilt = true;
  for (const spec of buildDefaultToolSpecs()) {
    registerAgentTool(spec);
  }
}

function buildDefaultToolSpecs(): readonly AgentToolSpec[] {
  const specs: AgentToolSpec[] = [];
  specs.push(buildCarrierDispatchToolSpec());
  const squadron = buildSquadronToolSpec();
  const taskForce = buildTaskForceToolSpec();

  if (squadron) specs.push(squadron);
  if (taskForce) specs.push(taskForce);
  specs.push(buildCarrierJobsToolSpec());
  specs.push(buildRequestDirectiveToolSpec());

  return specs;
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
