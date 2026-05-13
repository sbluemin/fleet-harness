import type { AgentToolCtx, AgentToolSpec } from "@sbluemin/fleet-core";
import { admiral } from "@sbluemin/fleet-core";

import { buildBriefingToolConfig } from "./tools/briefing.js";
import { buildDryDockToolConfig } from "./tools/drydock.js";
import { buildReadToolConfig } from "./tools/read.js";
import { buildResolveToolConfig } from "./tools/resolve.js";

// ═══════════════════════════════════════
// Constants — build specs (uses hoisted function declarations below)
// ═══════════════════════════════════════

// fleet-wiki가 fleet-core agent tool registry에 self-register하는 read-only tool ID의 SSoT.
// fleet-harness `registerFleetPiTools`가 host PI tool 등록 시 이 집합을 skip하여
// `registerFleetWiki`가 등록한 compact wiki UI가 generic core wrapper로 덮어쓰이지 않도록 한다.
export const FLEET_WIKI_AGENT_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_read",
  "wiki_resolve",
] as const;

const briefingSpec = buildWikiBriefingSpec();
const dryDockSpec = buildWikiDryDockSpec();
const readSpec = buildWikiReadSpec();
const resolveSpec = buildWikiResolveSpec();

// Self-register into fleet-core agent tool registry AND executor MCP whitelist at module load time
admiral.agent.tools.registerExecutorTool(briefingSpec);
admiral.agent.tools.registerExecutorTool(dryDockSpec);
admiral.agent.tools.registerExecutorTool(readSpec);
admiral.agent.tools.registerExecutorTool(resolveSpec);

// ═══════════════════════════════════════
// Functions
// ═══════════════════════════════════════

function buildWikiBriefingSpec(): AgentToolSpec {
  const config = buildBriefingToolConfig();
  return {
    id: config.name,
    tag: config.name,
    title: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    whenToUse: [
      "Discover wiki entries by topic, tag, or keyword before deciding which to read in full",
      "Need a deterministic ranked list of matching entries without fetching full body content",
    ],
    whenNotToUse: [
      "Full entry body content is needed — use wiki_read instead",
      "Compact context-pack synthesis across multiple entries is needed — use wiki_resolve instead",
    ],
    usageGuidelines: config.promptGuidelines,
    parameters: config.parameters,
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

function buildWikiDryDockSpec(): AgentToolSpec {
  const config = buildDryDockToolConfig();
  return {
    id: config.name,
    tag: config.name,
    title: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    whenToUse: [
      "Audit wiki repository health: frontmatter, broken links, queue conflicts, and semantic issues",
      "Pre-write lint gate before staging or approving patches",
    ],
    whenNotToUse: [
      "Goal is content retrieval or search — drydock performs diagnostics only, no content is returned",
    ],
    usageGuidelines: config.promptGuidelines,
    parameters: config.parameters,
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

function buildWikiReadSpec(): AgentToolSpec {
  const config = buildReadToolConfig();
  return {
    id: config.name,
    tag: config.name,
    title: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    whenToUse: [
      "Fetch full body, link graph, or raw source for one or more specific wiki entry IDs",
      "Structured output needed: mode=diffable for frontmatter+body, mode=summary for first paragraph only",
    ],
    whenNotToUse: [
      "Entry IDs are unknown — run wiki_briefing first to discover matching entries",
      "Compact multi-entry context pack is needed — use wiki_resolve instead",
    ],
    usageGuidelines: config.promptGuidelines,
    parameters: config.parameters,
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

function buildWikiResolveSpec(): AgentToolSpec {
  const config = buildResolveToolConfig();
  return {
    id: config.name,
    tag: config.name,
    title: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    whenToUse: [
      "Compact context pack needed combining briefing and read results for a query topic",
      "Freshness filtering or neighbor expansion required alongside content synthesis",
    ],
    whenNotToUse: [
      "Full entry body with link graph or raw source is needed — use wiki_read instead",
      "Only a ranked hit list without content is needed — use wiki_briefing instead",
    ],
    usageGuidelines: config.promptGuidelines,
    parameters: config.parameters,
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
