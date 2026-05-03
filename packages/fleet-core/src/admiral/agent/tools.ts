import type { AgentToolCtx, AgentToolSpec, McpCallToolResult, ToolMetadata } from "./types.js";
import { buildCarrierJobsToolSpec } from "../carrier-jobs/tool-spec.js";
import { buildCarrierToolSpecs } from "../carrier/tool-spec.js";
import { buildSquadronToolSpec } from "../squadron/tool-spec.js";
import { buildTaskForceToolSpec } from "../taskforce/tool-spec.js";

const defaultTools = new Map<string, AgentToolSpec>();
const extraTools = new Map<string, Map<string, AgentToolSpec>>();
let defaultToolsBuilt = false;

export function registerDefaultTool(spec: AgentToolSpec): void {
  defaultTools.set(spec.name, spec);
}

export function list(): readonly ToolMetadata[] {
  ensureDefaultToolsRegistered();
  const metas: ToolMetadata[] = [];
  for (const spec of defaultTools.values()) {
    metas.push(specToMetadata(spec));
  }
  for (const scoped of extraTools.values()) {
    for (const spec of scoped.values()) {
      metas.push(specToMetadata(spec));
    }
  }
  return metas;
}

export function listSpecs(): readonly AgentToolSpec[] {
  ensureDefaultToolsRegistered();
  return [...defaultTools.values()];
}

export async function invoke(name: string, args: unknown, ctx?: Partial<AgentToolCtx>): Promise<McpCallToolResult> {
  ensureDefaultToolsRegistered();
  const fullCtx: AgentToolCtx = {
    cwd: ctx?.cwd ?? process.cwd(),
    toolCallId: ctx?.toolCallId,
    signal: ctx?.signal,
  };

  const spec = defaultTools.get(name) ?? findExtraTool(name);
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
    scoped.set(spec.name, spec);
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
  defaultTools.clear();
  defaultToolsBuilt = false;
}

export function clearAllExtraTools(): void {
  extraTools.clear();
}

function findExtraTool(name: string): AgentToolSpec | undefined {
  for (const scoped of extraTools.values()) {
    const spec = scoped.get(name);
    if (spec) return spec;
  }
  return undefined;
}

function ensureDefaultToolsRegistered(): void {
  if (defaultToolsBuilt) return;
  defaultToolsBuilt = true;
  for (const spec of buildDefaultToolSpecs()) {
    registerDefaultTool(spec);
  }
}

function buildDefaultToolSpecs(): readonly AgentToolSpec[] {
  const specs: AgentToolSpec[] = [];
  specs.push(...buildCarrierToolSpecs());
  const squadron = buildSquadronToolSpec();
  const taskForce = buildTaskForceToolSpec();

  if (squadron) specs.push(squadron);
  if (taskForce) specs.push(taskForce);
  specs.push(buildCarrierJobsToolSpec());

  return specs;
}

function specToMetadata(spec: AgentToolSpec): ToolMetadata {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
  };
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
