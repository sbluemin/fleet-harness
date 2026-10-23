import type { PluginMcpTool } from "@fleet-console/sdk/mcp";
/** Wiki 도구 저작 메타데이터. 실행 엔진이나 MCP 서버를 포함하지 않는다. */
export interface WikiToolSpec {
  readonly id: string;
  readonly tag: string;
  readonly title: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly usageGuidelines: readonly string[];
  readonly parameters: object;
  readonly execute: PluginMcpTool["execute"];
}

import {
  buildBriefingToolConfig, buildDryDockToolConfig, buildCompileSourceToolConfig,
  buildIngestToolConfig, buildOrientToolConfig, buildEditToolConfig,
  buildQueryToolConfig, buildReadToolConfig, buildResolveToolConfig,
  buildSchemaCreateToolConfig, buildSchemaListToolConfig, buildSchemaReadToolConfig,
  type MemoryPaths, type WikiWorkspaceResolver, WikiKnowledgeUnavailableError,
} from "./wiki/index.js";

export interface WikiToolExecutionContext {
  readonly paths: MemoryPaths;
}

interface WikiAgentToolConfig {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: unknown;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: WikiToolExecutionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
}

// ═══════════════════════════════════════
// Constants — build specs (uses hoisted function declarations below)
// ═══════════════════════════════════════

// Codex가 Admiral에 제공하는 전역 Wiki 도구 목록.
export const FLEET_WIKI_AGENT_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_edit",
  "wiki_compile_source",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
  "wiki_schema_list",
  "wiki_schema_read",
  "wiki_schema_create",
] as const;

// ═══════════════════════════════════════
// Functions
// ═══════════════════════════════════════

export function getWikiToolSpecs(resolver?: WikiWorkspaceResolver): WikiToolSpec[] {
  return [
    buildWikiBriefingSpec(resolver), buildWikiDryDockSpec(resolver), buildWikiIngestSpec(resolver),
    buildWikiOrientSpec(resolver), buildWikiEditSpec(resolver),
    buildWikiCompileSourceSpec(resolver), buildWikiQuerySpec(resolver), buildWikiReadSpec(resolver), buildWikiResolveSpec(resolver),
    buildWikiSchemaListSpec(resolver), buildWikiSchemaReadSpec(resolver), buildWikiSchemaCreateSpec(resolver),
  ];
}

function buildWikiSchemaListSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildSchemaListToolConfig(), {
    whenToUse: ["Discover the workspace Wiki schema and available templates"],
    whenNotToUse: ["Reading a schema document — use wiki_schema_read"],
  }, resolver);
}

function buildWikiSchemaReadSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildSchemaReadToolConfig(), {
    whenToUse: ["Read the workspace Wiki schema or a named template"],
    whenNotToUse: ["Reading Wiki entries — use wiki_read"],
  }, resolver);
}

function buildWikiSchemaCreateSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildSchemaCreateToolConfig(), {
    whenToUse: ["Create a new custom Wiki schema template"],
    whenNotToUse: ["Updating, deleting, or overwriting templates"],
  }, resolver);
}

function buildWikiBriefingSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildBriefingToolConfig(), {
    whenToUse: [
      "Discover wiki entries by topic, tag, or keyword before deciding which to read in full",
      "Need a deterministic ranked list of matching entries without fetching full body content",
    ],
    whenNotToUse: [
      "Full entry body content is needed — use wiki_read instead",
      "Compact context-pack synthesis across multiple entries is needed — use wiki_resolve instead",
    ],
  }, resolver);
}

function buildWikiDryDockSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildDryDockToolConfig(), {
    whenToUse: [
      "Audit wiki repository health: frontmatter, broken links, schema, safety, and semantic issues",
      "Run after wiki writes to check links, schema, and safety",
    ],
    whenNotToUse: [
      "Goal is content retrieval or search — drydock performs diagnostics only, no content is returned",
    ],
  }, resolver);
}

function buildWikiIngestSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildIngestToolConfig(), {
    whenToUse: [
      "Write durable Fleet Wiki knowledge immediately with captured raw source",
      "Need to create or update a PRD wiki entry through host-only tools",
    ],
    whenNotToUse: [
      "Only reading or searching existing wiki context is needed — use wiki_briefing, wiki_read, or wiki_resolve",
      "The task did not ask to record knowledge in the wiki",
    ],
  }, resolver);
}

function buildWikiOrientSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildOrientToolConfig(), {
    whenToUse: [
      "Start a wiki-aware task by checking schema, index, recent log, and drydock status",
      "Need a compact orientation snapshot before deciding which wiki tools to call next",
    ],
    whenNotToUse: [
      "A specific entry ID is already known and full content is needed — use wiki_read instead",
      "Only writing an entry is needed and current wiki context is already understood — use wiki_ingest instead",
    ],
  }, resolver);
}

function buildWikiEditSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildEditToolConfig(), {
    whenToUse: ["Make an exact correction, delete an entry, inspect prior versions, or restore a snapshot"],
    whenNotToUse: ["Creating a new entry or replacing its complete body — use wiki_ingest"],
  }, resolver);
}

function buildWikiCompileSourceSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildCompileSourceToolConfig(), {
    whenToUse: [
      "A single source needs to be split into multiple wiki pages",
      "Multi-page writes from one source should be previewed or applied directly",
    ],
    whenNotToUse: [
      "Only one wiki entry needs to be written — use wiki_ingest instead",
      "A small exact correction to one existing entry — use wiki_edit",
    ],
  }, resolver);
}

function buildWikiQuerySpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildQueryToolConfig(), {
    whenToUse: [
      "Answer a wiki-grounded question with evidence context and citations",
      "Save an answer or synthesis page from cited wiki context",
    ],
    whenNotToUse: [
      "A small exact correction to one existing entry — use wiki_edit",
      "Only a ranked list of candidate entries is needed — use wiki_briefing instead",
    ],
  }, resolver);
}

function buildWikiReadSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildReadToolConfig(), {
    whenToUse: [
      "Fetch full body, link graph, or raw source for one or more specific wiki entry IDs",
      "Structured output needed: mode=diffable for frontmatter+body, mode=summary for first paragraph only",
    ],
    whenNotToUse: [
      "Entry IDs are unknown — run wiki_briefing first to discover matching entries",
      "Compact multi-entry context pack is needed — use wiki_resolve instead",
    ],
  }, resolver);
}

function buildWikiResolveSpec(resolver?: WikiWorkspaceResolver): WikiToolSpec {
  return buildWikiToolSpec(buildResolveToolConfig(), {
    whenToUse: [
      "Compact context pack needed combining briefing and read results for a query topic",
      "Freshness filtering or neighbor expansion required alongside content synthesis",
    ],
    whenNotToUse: [
      "Full entry body with link graph or raw source is needed — use wiki_read instead",
      "Only a ranked hit list without content is needed — use wiki_briefing instead",
    ],
  }, resolver);
}

function buildWikiToolSpec(
  config: WikiAgentToolConfig,
  usage: Pick<WikiToolSpec, "whenToUse" | "whenNotToUse">,
  resolver?: WikiWorkspaceResolver,
): WikiToolSpec {
  return {
    id: config.name,
    tag: config.name,
    title: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    whenToUse: usage.whenToUse,
    whenNotToUse: usage.whenNotToUse,
    usageGuidelines: config.promptGuidelines,
    parameters: config.parameters as Record<string, unknown>,
    execute: async (args: unknown, ctx: Parameters<PluginMcpTool["execute"]>[1]) => {
      // 위키는 호스트가 실어 준 사령관의 것뿐이다 — cwd나 모델 인자로 다른 위키를 고를 수 없다.
      let paths: MemoryPaths;
      try {
        if (!resolver || !ctx.commodoreId) throw new WikiKnowledgeUnavailableError();
        paths = resolver.resolve(ctx.commodoreId);
      } catch (error) {
        if (!(error instanceof WikiKnowledgeUnavailableError)) throw error;
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "knowledge_unavailable" }) }], isError: true };
      }
      const { content } = await config.execute("", args as Record<string, unknown>, ctx.signal, undefined, { paths });
      return { content, isError: false };
    },
  };
}

/**
 * 모델에 닿는 설명. MCP 등록이 싣는 것은 `description`뿐이므로, 쓰기·모드 의미·신뢰 경계처럼
 * 도구 계약에 속하는 문장을 여기서 한 문자열로 모은다.
 */
export function modelFacingWikiToolDescription(spec: Pick<WikiToolSpec, "description" | "promptSnippet" | "whenNotToUse" | "usageGuidelines">): string {
  const lines = [spec.description, spec.promptSnippet, ...spec.usageGuidelines, ...spec.whenNotToUse.map((line) => `Not for: ${line}.`)];
  // 같은 문장이 여러 목록에 실려 있으면 한 번만 싣는다.
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))].join("\n");
}

export function createCodexMcpTools(resolver?: WikiWorkspaceResolver): PluginMcpTool[] {
  return getWikiToolSpecs(resolver).map((spec) => ({
    name: spec.id, description: modelFacingWikiToolDescription(spec),
    inputSchema: spec.parameters as Record<string, unknown>, execute: spec.execute,
  }));
}
