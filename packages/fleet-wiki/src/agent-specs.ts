import {
  type AgentToolCtx,
  type AgentToolSpec,
} from "@sbluemin/fleet-mcp-server";

import { buildBriefingToolConfig } from "./tools/briefing.js";
import { buildCompileSourceToolConfig } from "./tools/compile-source.js";
import { buildDryDockToolConfig } from "./tools/drydock.js";
import { buildIngestToolConfig } from "./tools/ingest.js";
import { buildOrientToolConfig } from "./tools/orient.js";
import { buildPatchEditToolConfig } from "./tools/patch-edit.js";
import { buildPatchQueueToolConfig } from "./tools/patch-queue.js";
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

// fleet-wiki가 fleet-admiral agent tool registry에 self-register하는 tool ID의 SSoT.
// fleet-harness `registerFleetPiTools`가 host PI tool 등록 시 이 집합을 skip하여
// `registerFleetWiki`가 등록한 compact wiki UI가 generic core wrapper로 덮어쓰이지 않도록 한다.
export const FLEET_WIKI_AGENT_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_patch_edit",
  "wiki_patch_queue",
  "wiki_compile_source",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

// ═══════════════════════════════════════
// Functions
// ═══════════════════════════════════════

export function getWikiToolSpecs(): AgentToolSpec[] {
  return [
    buildWikiBriefingSpec(),
    buildWikiDryDockSpec(),
    buildWikiIngestSpec(),
    buildWikiOrientSpec(),
    buildWikiPatchEditSpec(),
    buildWikiPatchQueueSpec(),
    buildWikiCompileSourceSpec(),
    buildWikiQuerySpec(),
    buildWikiReadSpec(),
    buildWikiResolveSpec(),
  ];
}

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

function buildWikiPatchEditSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildPatchEditToolConfig(), {
    whenToUse: [
      "A pending Fleet Wiki patch needs a small exact body or metadata correction before approval",
      "Need to preserve the same patch_id while avoiding a second wiki_ingest queue item",
    ],
    whenNotToUse: [
      "The patch has already been approved or rejected",
      "The desired change requires approving wiki content — use wiki_patch_queue for approval",
    ],
  });
}

function buildWikiPatchQueueSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildPatchQueueToolConfig(), {
    whenToUse: [
      "Pending Fleet Wiki patches need human approval or rejection",
      "A patch set staged by wiki_compile_source needs batch approval",
    ],
    whenNotToUse: [
      "New wiki content needs to be staged — use wiki_ingest instead",
      "Existing approved wiki content needs to be read — use wiki_read instead",
    ],
  });
}

function buildWikiCompileSourceSpec(): AgentToolSpec {
  return buildWikiToolSpec(buildCompileSourceToolConfig(), {
    whenToUse: [
      "A single source needs to be split into multiple proposed wiki page patches",
      "Multi-page batch ingest from one source should be previewed or staged under one patch_set_id",
    ],
    whenNotToUse: [
      "Only one wiki entry needs to be staged — use wiki_ingest instead",
      "Pending patches need approval or rejection — use wiki_patch_queue instead",
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
