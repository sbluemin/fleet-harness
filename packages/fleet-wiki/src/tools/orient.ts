import { readFile, stat } from "node:fs/promises";

import { FLEET_WIKI_BOUNDARY_GUIDELINES, wrapWikiEntryBoundary } from "../boundaries.js";
import { runDryDock } from "../drydock.js";
import { formatLogEntry, parseLog } from "../log.js";
import { listQueue } from "../patch.js";
import { getIndexMarkdownFile, resolveMemoryPaths } from "../paths.js";
import {
  WIKI_ORIENT_DESCRIPTION,
  WIKI_ORIENT_GUIDELINES,
  WIKI_ORIENT_PROMPT_SNIPPET,
  buildWikiOrientSchema,
} from "../prompts.js";
import { ensureWorkspaceSchema, readWorkspaceSchemaSummary } from "../schema.js";
import { pathExists } from "../store.js";

interface OrientInput {
  includeSchema: boolean;
  includeIndex: boolean;
  includeRecentLog: boolean;
  logLimit: number;
  maxTokens: number;
}

interface OrientPayload {
  ok: true;
  tool: "wiki_orient";
  schema_summary?: Record<string, unknown>;
  index_summary?: Record<string, unknown>;
  recent_log?: Record<string, unknown>;
  pending_queue_count: number;
  drydock_summary: Record<string, unknown>;
  usage_hints: string[];
  trust_boundary: readonly string[];
  token_estimate: {
    max_tokens: number;
    estimated_tokens: number;
    truncated: boolean;
    fields_truncated: string[];
  };
}

const DEFAULT_LOG_LIMIT = 5;
const DEFAULT_MAX_TOKENS = 12_000;
const MAX_TOKENS_FLOOR = 1_000;
const MAX_TOKENS_CEILING = 50_000;
const TRUNCATION_MARKER = "\n\n[truncated by wiki_orient max_tokens]";

export function buildOrientToolConfig() {
  return {
    name: "wiki_orient",
    label: "Wiki Orient",
    description: WIKI_ORIENT_DESCRIPTION,
    promptSnippet: WIKI_ORIENT_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_ORIENT_GUIDELINES],
    parameters: buildWikiOrientSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const input = normalizeInput(params);
      const paths = resolveMemoryPaths(ctx.cwd);
      await ensureWorkspaceSchema(paths);

      const pendingQueueCount = await loadPendingQueueCount(paths);
      const drydockReport = await runDryDock(paths);
      const schemaSummary = input.includeSchema ? await buildSchemaSummary(paths) : undefined;
      const indexSummary = input.includeIndex ? await buildIndexSummary(paths) : undefined;
      const recentLog = input.includeRecentLog ? await buildRecentLogSummary(paths, input.logLimit) : undefined;

      const payload: OrientPayload = {
        ok: true,
        tool: "wiki_orient",
        pending_queue_count: pendingQueueCount,
        drydock_summary: {
          ok: drydockReport.ok,
          issue_count: drydockReport.issues.length,
          error_count: drydockReport.issues.filter((issue) => issue.severity === "error").length,
          warning_count: drydockReport.issues.filter((issue) => issue.severity === "warning").length,
          top_issues: drydockReport.issues.slice(0, 5).map((issue) => ({
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
            path: issue.path,
          })),
        },
        usage_hints: [
          "Start with wiki_orient once per task to understand available wiki context.",
          "Use wiki_briefing for targeted lookup after orientation.",
          "Use wiki_patch_queue before assuming pending knowledge is accepted.",
          "Use wiki_drydock when orientation reports integrity issues.",
        ],
        trust_boundary: FLEET_WIKI_BOUNDARY_GUIDELINES,
        token_estimate: {
          max_tokens: input.maxTokens,
          estimated_tokens: 0,
          truncated: false,
          fields_truncated: [],
        },
      };

      if (schemaSummary) payload.schema_summary = schemaSummary;
      if (indexSummary) payload.index_summary = indexSummary;
      if (recentLog) payload.recent_log = recentLog;

      applyDeterministicTruncation(payload, input.maxTokens);

      const text = JSON.stringify(payload, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  };
}

function normalizeInput(params: Record<string, unknown>): OrientInput {
  return {
    includeSchema: normalizeBoolean(params.include_schema, true),
    includeIndex: normalizeBoolean(params.include_index, true),
    includeRecentLog: normalizeBoolean(params.include_recent_log, true),
    logLimit: clampInteger(params.log_limit, DEFAULT_LOG_LIMIT, 1, 20),
    maxTokens: clampInteger(params.max_tokens, DEFAULT_MAX_TOKENS, MAX_TOKENS_FLOOR, MAX_TOKENS_CEILING),
  };
}

async function loadPendingQueueCount(paths: ReturnType<typeof resolveMemoryPaths>): Promise<number> {
  try {
    return (await listQueue(paths)).length;
  } catch {
    return 0;
  }
}

async function buildSchemaSummary(paths: ReturnType<typeof resolveMemoryPaths>): Promise<Record<string, unknown>> {
  const schema = await readWorkspaceSchemaSummary(paths);
  return {
    version: 1,
    required_frontmatter: ["id", "title", "tags", "created", "updated", "version"],
    link_syntax: "[[wiki:<id>]]",
    notes: ["schema summary shape follows readWorkspaceSchemaSummary()"],
    exists: schema.exists,
    summary: schema.summary,
    required_sections: [...schema.requiredSections],
    missing_required_sections: schema.missingRequiredSections,
    templates: (schema.templates ?? []).map((template) => ({
      id: template.id,
      frontmatter: template.frontmatter,
      sections: template.sections,
    })),
  };
}

async function buildIndexSummary(paths: ReturnType<typeof resolveMemoryPaths>): Promise<Record<string, unknown>> {
  const filePath = getIndexMarkdownFile(paths);
  if (!(await pathExists(filePath))) {
    return {
      included: true,
      missing: true,
      truncated: false,
      content: "",
    };
  }
  return {
    included: true,
    missing: false,
    truncated: false,
    content: wrapWikiEntryBoundary({
      id: "index",
      updated: (await stat(filePath)).mtime.toISOString(),
      content: await readFile(filePath, "utf8"),
    }),
  };
}

async function buildRecentLogSummary(paths: ReturnType<typeof resolveMemoryPaths>, logLimit: number): Promise<Record<string, unknown>> {
  const entries = await parseLog(paths);
  // 최근 log는 운영 메타데이터이므로 지금은 boundary wrapper를 씌우지 않는다.
  // 이후 raw source 본문을 직접 포함하게 되면 untrusted boundary를 적용해야 한다.
  const latestEntries = entries.slice(-logLimit).reverse().map((entry) => formatLogEntry(entry).trimEnd());
  return {
    included: true,
    limit: logLimit,
    entries: latestEntries,
    truncated: false,
  };
}

function applyDeterministicTruncation(payload: OrientPayload, maxTokens: number): void {
  updateTokenEstimate(payload);
  if (payload.token_estimate.estimated_tokens <= maxTokens) {
    return;
  }

  truncateIndexSummary(payload);
  updateTokenEstimate(payload);

  while (payload.token_estimate.estimated_tokens > maxTokens) {
    const removed = truncateRecentLogEntries(payload);
    updateTokenEstimate(payload);
    if (!removed) break;
  }

  while (payload.token_estimate.estimated_tokens > maxTokens) {
    const shortened = shortenRecentLogEntry(payload);
    updateTokenEstimate(payload);
    if (!shortened) break;
  }

  payload.token_estimate.truncated = payload.token_estimate.fields_truncated.length > 0;
}

function truncateIndexSummary(payload: OrientPayload): void {
  if (!payload.index_summary || payload.token_estimate.fields_truncated.includes("index_summary.content")) {
    return;
  }
  const section = payload.index_summary as { content: string; truncated: boolean };
  section.content = truncateString(section.content);
  section.truncated = true;
  payload.token_estimate.fields_truncated.push("index_summary.content");
}

function truncateRecentLogEntries(payload: OrientPayload): boolean {
  if (!payload.recent_log) return false;
  const section = payload.recent_log as { entries: string[]; truncated: boolean };
  if (section.entries.length <= 1) return false;
  section.entries.pop();
  section.truncated = true;
  if (!payload.token_estimate.fields_truncated.includes("recent_log.entries")) {
    payload.token_estimate.fields_truncated.push("recent_log.entries");
  }
  return true;
}

function shortenRecentLogEntry(payload: OrientPayload): boolean {
  if (!payload.recent_log) return false;
  const section = payload.recent_log as { entries: string[]; truncated: boolean };
  if (section.entries.length === 0) return false;
  const lastIndex = section.entries.length - 1;
  const current = section.entries[lastIndex]!;
  if (current.endsWith(TRUNCATION_MARKER)) return false;
  section.entries[lastIndex] = truncateString(current);
  section.truncated = true;
  if (!payload.token_estimate.fields_truncated.includes(`recent_log.entries[${lastIndex}]`)) {
    payload.token_estimate.fields_truncated.push(`recent_log.entries[${lastIndex}]`);
  }
  return true;
}

function truncateString(value: string): string {
  const limit = Math.max(0, 512 - TRUNCATION_MARKER.length);
  return `${value.slice(0, limit)}${TRUNCATION_MARKER}`;
}

function updateTokenEstimate(payload: OrientPayload): void {
  payload.token_estimate.estimated_tokens = Math.ceil(JSON.stringify(payload).length / 4);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
