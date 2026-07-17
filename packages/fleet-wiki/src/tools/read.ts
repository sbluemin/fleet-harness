import path from "node:path";

import { wrapWikiEntryBoundary, wrapWikiRawSourceBoundary, FLEET_WIKI_BOUNDARY_GUIDELINES } from "../boundaries.js";
import { dedupeStrings, estimateTokens } from "../internal-utils.js";
import { extractWikiLinks } from "../links.js";
import { resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_READ_DESCRIPTION,
  WIKI_READ_GUIDELINES,
  WIKI_READ_PROMPT_SNIPPET,
  buildWikiReadSchema,
} from "../prompts.js";
import { listWiki, readRawSourceEntry, readWikiEntry } from "../store.js";
import type {
  WikiEntryFrontmatter,
  MemoryPaths,
  WikiEntry,
  WikiReadEntryResult,
  WikiReadMissingResult,
  WikiReadMode,
  WikiReadRawSourceResult,
  WikiReadRelatedResult,
  WikiReadWarning,
} from "../types.js";

interface WikiReadInput {
  ids: string[];
  mode: WikiReadMode;
  includeRawSource: boolean;
  includeRelated: boolean;
  maxTokens?: number;
}

interface WikiReadPayload {
  ok: true;
  tool: "wiki_read";
  entries: Array<WikiReadEntryResult | WikiReadMissingResult>;
  tokenEstimate: number;
  truncated: boolean;
}

interface LinkGraph {
  allEntries: WikiEntry[];
  backlinksById: Map<string, string[]>;
  entriesById: Map<string, WikiEntry>;
  outgoingById: Map<string, string[]>;
}

interface RelatedCandidate {
  id: string;
  reason: WikiReadRelatedResult["reason"];
}

const DEFAULT_BOUNDARY = FLEET_WIKI_BOUNDARY_GUIDELINES[0];
const TRUNCATION_MARKER = "\n\n[truncated by wiki_read max_tokens]";
const MAX_QUERY_TOKENS_FLOOR = 1;

export function buildReadToolConfig() {
  return {
    name: "wiki_read",
    label: "Wiki Read",
    description: WIKI_READ_DESCRIPTION,
    promptSnippet: WIKI_READ_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_READ_GUIDELINES],
    parameters: buildWikiReadSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string; paths?: import("../types.js").MemoryPaths },
    ) {
      const input = normalizeReadInput(params);
      const paths = resolveToolMemoryPaths(ctx);
      const graph = await buildLinkGraph(paths);
      const entries: Array<WikiReadEntryResult | WikiReadMissingResult> = [];

      for (const id of input.ids) {
        const entry = await readWikiEntry(id, paths);
        if (!entry) {
          entries.push({ id, ok: false, error: "not_found" });
          continue;
        }
        entries.push(await buildReadEntryResult(entry, paths, graph, input));
      }

      const payload: WikiReadPayload = {
        ok: true,
        tool: "wiki_read",
        entries,
        tokenEstimate: 0,
        truncated: false,
      };

      applyReadTruncation(payload, input.maxTokens);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: {},
      };
    },
  };
}

function normalizeReadInput(params: Record<string, unknown>): WikiReadInput {
  if (!Array.isArray(params.ids) || params.ids.length === 0) {
    throw new Error("[fleet-wiki] wiki_read ids must be a non-empty array of strings");
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of params.ids) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("[fleet-wiki] wiki_read ids must be a non-empty array of strings");
    }
    const next = value.trim();
    if (!seen.has(next)) {
      seen.add(next);
      ids.push(next);
    }
  }

  const rawMode = typeof params.mode === "string" ? params.mode : "full";
  if (!isWikiReadMode(rawMode)) {
    throw new Error(`[fleet-wiki] wiki_read mode is invalid: ${String(params.mode)}`);
  }

  const maxTokens = normalizeMaxTokens(params.max_tokens);
  return {
    ids,
    mode: rawMode,
    includeRawSource: params.include_raw_source === true,
    includeRelated: params.include_related === true,
    maxTokens,
  };
}

async function buildLinkGraph(paths: MemoryPaths): Promise<LinkGraph> {
  const allEntries = await listWiki(paths);
  const outgoingById = new Map<string, string[]>();
  const backlinksAccum = new Map<string, Set<string>>();
  const entriesById = new Map<string, WikiEntry>();

  for (const entry of allEntries) {
    entriesById.set(entry.id, entry);
    const outgoing = dedupeStrings(extractWikiLinks(entry.body));
    outgoingById.set(entry.id, outgoing);
    for (const target of outgoing) {
      const backlinks = backlinksAccum.get(target) ?? new Set<string>();
      backlinks.add(entry.id);
      backlinksAccum.set(target, backlinks);
    }
  }

  const backlinksById = new Map<string, string[]>();
  for (const [id, backlinks] of backlinksAccum.entries()) {
    backlinksById.set(id, [...backlinks].sort((left, right) => left.localeCompare(right)));
  }

  return {
    allEntries,
    backlinksById,
    entriesById,
    outgoingById,
  };
}

async function buildReadEntryResult(
  entry: WikiEntry,
  paths: MemoryPaths,
  graph: LinkGraph,
  input: WikiReadInput,
): Promise<WikiReadEntryResult> {
  const rawSourceRefs = dedupeStrings([
    ...(entry.rawSourceRef ? [entry.rawSourceRef] : []),
    ...(entry.rawSourceRefs?.map((item) => item.ref) ?? []),
  ]);
  const outgoing = graph.outgoingById.get(entry.id) ?? [];
  const backlinks = graph.backlinksById.get(entry.id) ?? [];
  const result: WikiReadEntryResult = {
    id: entry.id,
    ok: true,
    frontmatter: toFrontmatter(entry),
    rawSourceRef: entry.rawSourceRef,
    rawSourceRefs,
    source: {
      path: path.join("wiki", `${entry.id}.md`),
      rawSourceRef: entry.rawSourceRef,
      rawSourceRefs,
    },
    links: {
      outgoing,
      backlinks,
    },
    tokenEstimate: 0,
    truncated: false,
    boundary: DEFAULT_BOUNDARY,
  };

  applyReadMode(result, entry, input.mode);

  if (input.includeRawSource && rawSourceRefs.length > 0) {
    const rawSourceResults: WikiReadRawSourceResult[] = [];
    const warnings: WikiReadWarning[] = [];
    for (const ref of rawSourceRefs) {
      try {
        const raw = await readRawSourceEntry(ref, paths);
        rawSourceResults.push({
          ref,
          sourceType: raw.sourceType,
          title: raw.title,
          tags: raw.tags,
          contentHash: raw.contentHash,
          content: wrapWikiRawSourceBoundary({
            ref,
            content: raw.content,
          }),
          boundary: "untrusted",
        });
      } catch {
        warnings.push({ ref, error: "raw_source_not_found" });
      }
    }
    if (rawSourceResults.length > 0) {
      result.rawSource = rawSourceResults[0];
      result.rawSources = rawSourceResults;
    }
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
  }

  if (input.includeRelated) {
    result.related = buildRelatedEntries(entry, graph);
  }

  result.tokenEstimate = estimateTokens(result);
  return result;
}

function applyReadMode(result: WikiReadEntryResult, entry: WikiEntry, mode: WikiReadMode): void {
  if (mode === "facts") {
    return;
  }

  if (mode === "full") {
    result.body = wrapWikiEntryBoundary({
      id: entry.id,
      updated: entry.updated,
      content: entry.body,
    });
    return;
  }

  if (mode === "summary") {
    result.body = wrapWikiEntryBoundary({
      id: entry.id,
      updated: entry.updated,
      content: extractSummaryParagraph(entry.body),
    });
    return;
  }

  result.content = wrapWikiEntryBoundary({
    id: entry.id,
    updated: entry.updated,
    content: serializeDiffableEntry(entry),
  });
}

function extractSummaryParagraph(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) return "";

  if (paragraphs[0]?.startsWith("# ")) {
    const nextParagraph = paragraphs.find((paragraph, index) => index > 0 && !paragraph.startsWith("#"));
    if (nextParagraph) return nextParagraph;
  }

  return paragraphs.find((paragraph) => !paragraph.startsWith("#")) ?? paragraphs[0] ?? "";
}

function serializeDiffableEntry(entry: WikiEntry): string {
  const frontmatterLines = [
    `id: ${serializeFrontmatterValue(entry.id)}`,
    `title: ${serializeFrontmatterValue(entry.title)}`,
    `tags: ${serializeFrontmatterValue(entry.tags)}`,
    `created: ${serializeFrontmatterValue(entry.created)}`,
    `updated: ${serializeFrontmatterValue(entry.updated)}`,
    `version: ${serializeFrontmatterValue(entry.version)}`,
  ];
  if (entry.rawSourceRef) frontmatterLines.push(`rawSourceRef: ${serializeFrontmatterValue(entry.rawSourceRef)}`);
  if (entry.aliases?.length) frontmatterLines.push(`aliases: ${serializeFrontmatterValue(entry.aliases)}`);
  if (entry.type) frontmatterLines.push(`type: ${serializeFrontmatterValue(entry.type)}`);
  if (entry.status) frontmatterLines.push(`status: ${serializeFrontmatterValue(entry.status)}`);
  if (entry.confidence) frontmatterLines.push(`confidence: ${serializeFrontmatterValue(entry.confidence)}`);
  if (entry.owner) frontmatterLines.push(`owner: ${serializeFrontmatterValue(entry.owner)}`);
  if (entry.language) frontmatterLines.push(`language: ${serializeFrontmatterValue(entry.language)}`);
  if (entry.revalidateAfter) frontmatterLines.push(`revalidateAfter: ${serializeFrontmatterValue(entry.revalidateAfter)}`);
  if (entry.supersedes?.length) frontmatterLines.push(`supersedes: ${serializeFrontmatterValue(entry.supersedes)}`);
  if (entry.related?.length) frontmatterLines.push(`related: ${serializeFrontmatterValue(entry.related)}`);
  if (entry.rawSourceRefs?.length) {
    frontmatterLines.push(`rawSourceRefs: ${serializeFrontmatterValue(JSON.stringify(entry.rawSourceRefs))}`);
  }
  return `---\n${frontmatterLines.join("\n")}\n---\n${entry.body}`;
}

function buildRelatedEntries(entry: WikiEntry, graph: LinkGraph): WikiReadRelatedResult[] {
  const relatedCandidates: RelatedCandidate[] = [
    ...(entry.related ?? []).map((id) => ({ id, reason: "frontmatter" as const })),
    ...(graph.outgoingById.get(entry.id) ?? []).map((id) => ({ id, reason: "outgoing" as const })),
    ...(graph.backlinksById.get(entry.id) ?? []).map((id) => ({ id, reason: "backlink" as const })),
  ];
  const deduped = new Map<string, WikiReadRelatedResult>();
  for (const candidate of relatedCandidates) {
    if (candidate.id === entry.id || deduped.has(candidate.id)) continue;
    const relatedEntry = graph.entriesById.get(candidate.id);
    if (!relatedEntry) continue;
    deduped.set(candidate.id, {
      id: relatedEntry.id,
      title: relatedEntry.title,
      path: path.join("wiki", `${relatedEntry.id}.md`),
      reason: candidate.reason,
    });
  }
  return [...deduped.values()];
}

function toFrontmatter(entry: WikiEntry): WikiEntryFrontmatter {
  return {
    id: entry.id,
    title: entry.title,
    tags: [...entry.tags],
    created: entry.created,
    updated: entry.updated,
    version: entry.version,
    rawSourceRef: entry.rawSourceRef,
    aliases: entry.aliases ? [...entry.aliases] : undefined,
    type: entry.type,
    status: entry.status,
    confidence: entry.confidence,
    owner: entry.owner,
    language: entry.language,
    revalidateAfter: entry.revalidateAfter,
    supersedes: entry.supersedes ? [...entry.supersedes] : undefined,
    related: entry.related ? [...entry.related] : undefined,
    rawSourceRefs: entry.rawSourceRefs
      ? entry.rawSourceRefs.map((item) => ({ ref: item.ref, title: item.title, hash: item.hash }))
      : undefined,
  };
}

function applyReadTruncation(payload: WikiReadPayload, maxTokens: number | undefined): void {
  payload.tokenEstimate = estimateTokens(payload);
  if (!maxTokens) return;
  if (payload.tokenEstimate <= maxTokens) return;

  let changed = true;
  while (payload.tokenEstimate > maxTokens && changed) {
    changed = false;
    for (const entry of payload.entries) {
      if (!entry.ok) continue;
      if (truncateReadEntry(entry)) {
        changed = true;
      }
      payload.tokenEstimate = estimateTokens(payload);
      if (payload.tokenEstimate <= maxTokens) break;
    }
  }

  payload.truncated = payload.entries.some((entry) => entry.ok && entry.truncated);
  payload.tokenEstimate = estimateTokens(payload);
}

function truncateReadEntry(entry: WikiReadEntryResult): boolean {
  if (entry.body && !entry.body.endsWith(TRUNCATION_MARKER)) {
    entry.body = truncateString(entry.body);
    entry.truncated = true;
    entry.tokenEstimate = estimateTokens(entry);
    return true;
  }
  if (entry.content && !entry.content.endsWith(TRUNCATION_MARKER)) {
    entry.content = truncateString(entry.content);
    entry.truncated = true;
    entry.tokenEstimate = estimateTokens(entry);
    return true;
  }
  if (entry.rawSource?.content && !entry.rawSource.content.endsWith(TRUNCATION_MARKER)) {
    entry.rawSource.content = truncateString(entry.rawSource.content);
    entry.truncated = true;
    entry.tokenEstimate = estimateTokens(entry);
    return true;
  }
  if (entry.rawSources?.length) {
    const rawSource = entry.rawSources.find((candidate) => !candidate.content.endsWith(TRUNCATION_MARKER));
    if (rawSource) {
      rawSource.content = truncateString(rawSource.content);
      if (entry.rawSource?.ref === rawSource.ref) {
        entry.rawSource.content = rawSource.content;
      }
      entry.truncated = true;
      entry.tokenEstimate = estimateTokens(entry);
      return true;
    }
  }
  if (entry.related && entry.related.length > 0) {
    entry.related.pop();
    entry.truncated = true;
    entry.tokenEstimate = estimateTokens(entry);
    return true;
  }
  return false;
}

function serializeFrontmatterValue(value: string | number | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => `"${escapeFrontmatterString(item)}"`).join(", ")}]`;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `"${escapeFrontmatterString(value)}"`;
}

function escapeFrontmatterString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function truncateString(value: string): string {
  const limit = Math.max(0, 512 - TRUNCATION_MARKER.length);
  return `${value.slice(0, limit)}${TRUNCATION_MARKER}`;
}

function normalizeMaxTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MAX_QUERY_TOKENS_FLOOR) {
    throw new Error("[fleet-wiki] wiki_read max_tokens must be a positive integer");
  }
  return value;
}

function isWikiReadMode(value: string): value is WikiReadMode {
  return value === "full" || value === "summary" || value === "facts" || value === "diffable";
}
