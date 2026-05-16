import type { AgentToolCtx, AgentToolSpec } from "@sbluemin/fleet-core";
import { admiral } from "@sbluemin/fleet-core";

import { buildBriefingToolConfig } from "./tools/briefing.js";
import { buildDryDockToolConfig } from "./tools/drydock.js";
import { buildIngestToolConfig } from "./tools/ingest.js";
import { buildOrientToolConfig } from "./tools/orient.js";
import { buildQueryToolConfig } from "./tools/query.js";
import { buildReadToolConfig } from "./tools/read.js";
import { buildResolveToolConfig } from "./tools/resolve.js";

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
    ctx: { cwd: string },
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }>;
}

// ═══════════════════════════════════════
// Constants — build specs (uses hoisted function declarations below)
// ═══════════════════════════════════════

// fleet-wiki가 fleet-core agent tool registry에 self-register하는 tool ID의 SSoT.
// fleet-harness `registerFleetPiTools`가 host PI tool 등록 시 이 집합을 skip하여
// `registerFleetWiki`가 등록한 compact wiki UI가 generic core wrapper로 덮어쓰이지 않도록 한다.
export const FLEET_WIKI_AGENT_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

// 크로니클 전용: 위키 쓰기/린트 도구 (ingest, drydock)
const CHRONICLE_ONLY_EXECUTOR_TOOL = { allowedCarriers: ["chronicle"] } as const;

const registerChronicleExecutorTool = admiral.agent.tools.registerExecutorTool as (
  spec: AgentToolSpec,
  opts: { readonly allowedCarriers: readonly string[] },
) => void;
const registerGlobalExecutorTool = admiral.agent.tools.registerExecutorTool as (
  spec: AgentToolSpec,
) => void;

const briefingSpec = buildWikiBriefingSpec();
const dryDockSpec = buildWikiDryDockSpec();
const ingestSpec = buildWikiIngestSpec();
const orientSpec = buildWikiOrientSpec();
const querySpec = buildWikiQuerySpec();
const readSpec = buildWikiReadSpec();
const resolveSpec = buildWikiResolveSpec();

// Self-register into fleet-core agent tool registry AND executor MCP whitelist at module load time.
// 순수 읽기 도구 4종 (briefing/orient/read/resolve): 모든 캐리어가 위키 지식기반에 접근 가능하도록 글로벌 등록.
// 쓰기·stage 가능 도구 3종 (drydock/ingest/query): 크로니클 전용 (지식 무결성 보호).
// 참고: wiki_query는 mode="stage_answer_page" / save_good_answer=true에서 패치 큐에 stage하므로 read-only가 아님.
registerGlobalExecutorTool(briefingSpec);
registerChronicleExecutorTool(dryDockSpec, CHRONICLE_ONLY_EXECUTOR_TOOL);
registerChronicleExecutorTool(ingestSpec, CHRONICLE_ONLY_EXECUTOR_TOOL);
registerGlobalExecutorTool(orientSpec);
registerChronicleExecutorTool(querySpec, CHRONICLE_ONLY_EXECUTOR_TOOL);
registerGlobalExecutorTool(readSpec);
registerGlobalExecutorTool(resolveSpec);

// ═══════════════════════════════════════
// Functions
// ═══════════════════════════════════════

function buildWikiBriefingSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildBriefingToolConfig(), {
    whenToUse: [
      "Discover wiki entries by topic, tag, or keyword before deciding which to read in full",
      "Need a deterministic ranked list of matching entries without fetching full body content",
    ],
    whenNotToUse: [
      "Full entry body content is needed — use wiki_read instead",
      "Compact context-pack synthesis across multiple entries is needed — use wiki_resolve instead",
    ],
  });
}

function buildWikiDryDockSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildDryDockToolConfig(), {
    whenToUse: [
      "Audit wiki repository health: frontmatter, broken links, queue conflicts, and semantic issues",
      "Pre-write lint gate before staging or approving patches",
    ],
    whenNotToUse: [
      "Goal is content retrieval or search — drydock performs diagnostics only, no content is returned",
    ],
  });
}

function buildWikiIngestSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildIngestToolConfig(), {
    whenToUse: [
      "Stage durable Fleet Wiki knowledge as an approval-gated pending patch with captured raw source",
      "Need to create or update a PRD wiki entry without directly modifying approved wiki files",
    ],
    whenNotToUse: [
      "Only reading or searching existing wiki context is needed — use wiki_briefing, wiki_read, or wiki_resolve",
      "The user has not approved staging wiki changes for this task",
    ],
  });
}

function buildWikiOrientSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildOrientToolConfig(), {
    whenToUse: [
      "Start a wiki-aware task by checking schema, index, recent log, queue count, and drydock status",
      "Need a compact orientation snapshot before deciding which wiki tools to call next",
    ],
    whenNotToUse: [
      "A specific entry ID is already known and full content is needed — use wiki_read instead",
      "Only staging a patch is needed and current wiki context is already understood — use wiki_ingest instead",
    ],
  });
}

function buildWikiQuerySpec(): AgentToolSpec {
  return buildWikiToolSpec(buildQueryToolConfig(), {
    whenToUse: [
      "Answer a wiki-grounded question with evidence context and citations",
      "Stage an approval-gated answer or synthesis page from cited wiki context",
    ],
    whenNotToUse: [
      "The task requires final approval of pending patches — use the host-side approval flow instead",
      "Only a ranked list of candidate entries is needed — use wiki_briefing instead",
    ],
  });
}

function buildWikiReadSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildReadToolConfig(), {
    whenToUse: [
      "Fetch full body, link graph, or raw source for one or more specific wiki entry IDs",
      "Structured output needed: mode=diffable for frontmatter+body, mode=summary for first paragraph only",
    ],
    whenNotToUse: [
      "Entry IDs are unknown — run wiki_briefing first to discover matching entries",
      "Compact multi-entry context pack is needed — use wiki_resolve instead",
    ],
  });
}

function buildWikiResolveSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildResolveToolConfig(), {
    whenToUse: [
      "Compact context pack needed combining briefing and read results for a query topic",
      "Freshness filtering or neighbor expansion required alongside content synthesis",
    ],
    whenNotToUse: [
      "Full entry body with link graph or raw source is needed — use wiki_read instead",
      "Only a ranked hit list without content is needed — use wiki_briefing instead",
    ],
  });
}

function buildWikiToolSpec(
  config: WikiAgentToolConfig,
  usage: Pick<AgentToolSpec, "whenToUse" | "whenNotToUse">,
): AgentToolSpec {
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
    execute: async (args: unknown, ctx: AgentToolCtx) => {
      const { content } = await config.execute(
        "",
        args as Record<string, unknown>,
        ctx.signal,
        undefined,
        { cwd: ctx.cwd },
      );
      return { content, isError: false };
    },
  };
}
