import { FLEET_WIKI_BOUNDARY_GUIDELINES, wrapWikiRawSourceBoundary } from "../store.js";
import { briefingQuery } from "../briefing.js";
import { readClaims } from "../claims.js";
import { dedupeStrings, estimateTokens } from "../briefing.js";
import { extractWikiLinks } from "../store.js";
import { resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_RESOLVE_DESCRIPTION,
  WIKI_RESOLVE_GUIDELINES,
  WIKI_RESOLVE_PROMPT_SNIPPET,
  buildWikiResolveSchema,
} from "../prompts.js";
import { listWiki, readRawSourceEntry, readWikiEntry } from "../store.js";
import type { BriefingHit, MemoryPaths, WikiEntry, WikiEntryStatus } from "../types.js";

export interface WikiResolveInput {
  query: string;
  tags?: string[];
  task?: string;
  max_entries: number;
  max_tokens: number;
  include_raw: boolean;
  include_neighbors: boolean;
  freshness: "prefer_recent" | "strict_current" | "any";
  format: "compact_json" | "markdown_pack";
}

export interface WikiContextPackFact {
  claim: string;
  source_refs: string[];
  confidence: "high" | "medium" | "low";
}

export interface WikiContextPackEntry {
  id: string;
  title: string;
  summary: string;
  facts: WikiContextPackFact[];
  when_to_use: string;
  staleness: {
    updated: string;
    status: "current" | "deprecated" | "superseded" | "unknown";
  };
  related: string[];
  raw?: string;
}

export interface WikiContextPack {
  token_estimate: number;
  entries: WikiContextPackEntry[];
  missing_or_uncertain: string[];
}

export interface WikiResolvePayload {
  ok: true;
  tool: "wiki_resolve";
  query: string;
  task?: string;
  context_pack: WikiContextPack;
  trust_boundary: string;
}

interface ResolveGraph {
  backlinksById: Map<string, string[]>;
  entriesById: Map<string, WikiEntry>;
  outgoingById: Map<string, string[]>;
}

const DEFAULT_TRUST_BOUNDARY = FLEET_WIKI_BOUNDARY_GUIDELINES[0];
const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_TOKENS = 4000;
const QUERY_MAX_LENGTH = 256;
const MAX_ENTRIES_MIN = 1;
const MAX_ENTRIES_MAX = 20;
const MAX_TOKENS_MIN = 500;
const MAX_TOKENS_MAX = 20_000;
const SUMMARY_MAX_LENGTH = 320;
const TRUNCATED_TEXT_LENGTH = 160;

export function buildResolveToolConfig() {
  return {
    name: "wiki_resolve",
    label: "Wiki Resolve",
    description: WIKI_RESOLVE_DESCRIPTION,
    promptSnippet: WIKI_RESOLVE_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_RESOLVE_GUIDELINES],
    parameters: buildWikiResolveSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string; paths?: import("../types.js").MemoryPaths },
    ) {
      const input = normalizeResolveInput(params);
      const paths = resolveToolMemoryPaths(ctx);
      const payload = await resolveWikiContext(input, paths);
      if (input.format === "markdown_pack") {
        return {
          content: [{ type: "text" as const, text: renderMarkdownPack(input, payload.context_pack) }],
          details: {},
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: {},
      };
    },
  };
}

export async function resolveWikiContext(
  params: Record<string, unknown> | WikiResolveInput,
  paths: MemoryPaths,
): Promise<WikiResolvePayload> {
  const input = isResolveInput(params) ? params : normalizeResolveInput(params);
  const pack = await buildContextPack(input, paths);
  return {
    ok: true,
    tool: "wiki_resolve",
    query: input.query,
    task: input.task,
    context_pack: pack,
    trust_boundary: DEFAULT_TRUST_BOUNDARY,
  };
}

function isResolveInput(value: Record<string, unknown> | WikiResolveInput): value is WikiResolveInput {
  return typeof (value as WikiResolveInput).query === "string"
    && typeof (value as WikiResolveInput).max_entries === "number"
    && typeof (value as WikiResolveInput).max_tokens === "number";
}

function normalizeResolveInput(params: Record<string, unknown>): WikiResolveInput {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    throw new Error("[fleet-wiki] wiki_resolve query must be a non-empty string");
  }
  if (query.length > QUERY_MAX_LENGTH) {
    throw new Error("[fleet-wiki] wiki_resolve query exceeds 256 characters");
  }

  const task = typeof params.task === "string" ? params.task.trim() || undefined : undefined;
  const tags = normalizeTags(params.tags);
  return {
    query,
    tags,
    task,
    max_entries: clampInteger(params.max_entries, DEFAULT_MAX_ENTRIES, MAX_ENTRIES_MIN, MAX_ENTRIES_MAX, "max_entries"),
    max_tokens: clampInteger(params.max_tokens, DEFAULT_MAX_TOKENS, MAX_TOKENS_MIN, MAX_TOKENS_MAX, "max_tokens"),
    include_raw: params.include_raw === true,
    include_neighbors: params.include_neighbors === true,
    freshness: normalizeFreshness(params.freshness),
    format: normalizeFormat(params.format),
  };
}

async function buildContextPack(input: WikiResolveInput, paths: MemoryPaths): Promise<WikiContextPack> {
  const notes: string[] = [];
  const graph = await buildResolveGraph(paths);
  const expandedLimit = Math.min(MAX_ENTRIES_MAX, Math.max(input.max_entries * 3, input.max_entries + 2));
  const hits = await briefingQuery(paths, {
    topic: input.query,
    tags: input.tags,
    limit: expandedLimit,
  });

  if (hits.length === 0) {
    pushUnique(notes, "no hits for query");
  }

  const selectedEntries: WikiContextPackEntry[] = [];
  const selectedIds = new Set<string>();
  const neighborSeeds: string[] = [];

  for (const hit of applyFreshness(hits, input.freshness, notes)) {
    if (selectedEntries.length >= input.max_entries) break;
    if (selectedIds.has(hit.id)) continue;
    const entry = await readWikiEntry(hit.id, paths);
    if (!entry) {
      pushUnique(notes, `entry missing for ${hit.id}`);
      continue;
    }
    const packEntry = await buildPackEntry(entry, input, paths, graph, notes);
    selectedEntries.push(packEntry);
    selectedIds.add(entry.id);
    neighborSeeds.push(entry.id);
  }

  if (input.include_neighbors && selectedEntries.length < input.max_entries) {
    const neighborIds = collectNeighborIds(neighborSeeds, graph);
    for (const neighborId of neighborIds) {
      if (selectedEntries.length >= input.max_entries) break;
      if (selectedIds.has(neighborId)) continue;
      const entry = graph.entriesById.get(neighborId) ?? await readWikiEntry(neighborId, paths);
      if (!entry) {
        pushUnique(notes, `entry missing for ${neighborId}`);
        continue;
      }
      const packEntry = await buildPackEntry(entry, input, paths, graph, notes);
      selectedEntries.push(packEntry);
      selectedIds.add(entry.id);
    }
  }

  const pack: WikiContextPack = {
    token_estimate: 0,
    entries: selectedEntries,
    missing_or_uncertain: notes,
  };
  applyDeterministicTruncation(pack, input.max_tokens);
  return pack;
}

function applyFreshness(hits: BriefingHit[], freshness: WikiResolveInput["freshness"], notes: string[]): BriefingHit[] {
  if (freshness === "any") {
    return hits;
  }

  if (freshness === "strict_current") {
    const kept: BriefingHit[] = [];
    for (const hit of hits) {
      const status = normalizeEntryStatus(hit.status);
      if (status !== "current") {
        pushUnique(notes, `excluded stale entry ${hit.id}: strict_current`);
        continue;
      }
      kept.push(hit);
    }
    return kept;
  }

  const grouped = [...hits];
  grouped.sort((left, right) => freshnessPriority(normalizeEntryStatus(left.status)) - freshnessPriority(normalizeEntryStatus(right.status)));
  return grouped;
}

async function buildResolveGraph(paths: MemoryPaths): Promise<ResolveGraph> {
  const entries = await listWiki(paths);
  const entriesById = new Map<string, WikiEntry>();
  const outgoingById = new Map<string, string[]>();
  const backlinksAccumulator = new Map<string, Set<string>>();

  for (const entry of entries) {
    entriesById.set(entry.id, entry);
    const outgoing = dedupeStrings(extractWikiLinks(entry.body)).sort((left, right) => left.localeCompare(right));
    outgoingById.set(entry.id, outgoing);
    for (const target of outgoing) {
      const backlinks = backlinksAccumulator.get(target) ?? new Set<string>();
      backlinks.add(entry.id);
      backlinksAccumulator.set(target, backlinks);
    }
  }

  const backlinksById = new Map<string, string[]>();
  for (const [id, backlinks] of backlinksAccumulator.entries()) {
    backlinksById.set(id, [...backlinks].sort((left, right) => left.localeCompare(right)));
  }

  return {
    backlinksById,
    entriesById,
    outgoingById,
  };
}

async function buildPackEntry(
  entry: WikiEntry,
  input: WikiResolveInput,
  paths: MemoryPaths,
  graph: ResolveGraph,
  notes: string[],
): Promise<WikiContextPackEntry> {
  const related = dedupeStrings([
    ...(entry.related ?? []),
    ...(graph.outgoingById.get(entry.id) ?? []),
    ...(graph.backlinksById.get(entry.id) ?? []),
  ]).sort((left, right) => left.localeCompare(right));
  const summary = buildEntrySummary(entry.body);
  const whenToUse = buildWhenToUse(entry, summary);
  const facts = await buildFacts(entry, paths, notes, summary);
  const packEntry: WikiContextPackEntry = {
    id: entry.id,
    title: entry.title,
    summary,
    facts,
    when_to_use: whenToUse,
    staleness: {
      updated: entry.updated,
      status: normalizeEntryStatus(entry.status),
    },
    related,
  };

  if (input.include_raw) {
    const raw = await buildRawContext(entry, paths, notes);
    if (raw) {
      packEntry.raw = raw;
    }
  }

  return packEntry;
}

async function buildFacts(
  entry: WikiEntry,
  paths: MemoryPaths,
  notes: string[],
  summary: string,
): Promise<WikiContextPackFact[]> {
  const claimSet = await readClaims(entry.id, paths);
  if (claimSet && claimSet.claims.length > 0) {
    return claimSet.claims
      .slice(0, 3)
      .map((claim) => ({
        claim: collapseWhitespace(claim.text).slice(0, SUMMARY_MAX_LENGTH),
        source_refs: dedupeStrings(claim.sourceRefs.map((sourceRef) => sourceRef.ref)),
        confidence: claim.confidence,
      }));
  }

  pushUnique(notes, `claims unavailable for ${entry.id}: fallback summary used`);
  const sourceRefs = collectSourceRefs(entry);
  const facts: WikiContextPackFact[] = [];
  if (entry.tags.length > 0) {
    facts.push({
      claim: `Tags: ${entry.tags.join(", ")}`,
      source_refs: sourceRefs,
      confidence: "high",
    });
  }
  facts.push({
    claim: `Updated: ${entry.updated}`,
    source_refs: sourceRefs,
    confidence: "high",
  });
  facts.push({
    claim: firstSentence(summary || entry.body),
    source_refs: sourceRefs,
    confidence: sourceRefs.length > 0 ? "medium" : "low",
  });
  return dedupeFacts(facts).slice(0, 3);
}

async function buildRawContext(entry: WikiEntry, paths: MemoryPaths, notes: string[]): Promise<string | undefined> {
  const sourceRefs = collectSourceRefs(entry);
  if (sourceRefs.length === 0) return undefined;
  const parts: string[] = [];
  for (const ref of sourceRefs) {
    try {
      const raw = await readRawSourceEntry(ref, paths);
      parts.push(wrapWikiRawSourceBoundary({
        ref,
        content: raw.content,
      }));
    } catch {
      pushUnique(notes, `raw unavailable for ${entry.id}: ${ref}`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function collectNeighborIds(primaryIds: string[], graph: ResolveGraph): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of primaryIds) {
    const neighbors = dedupeStrings([
      ...(graph.outgoingById.get(id) ?? []),
      ...(graph.backlinksById.get(id) ?? []),
      ...(graph.entriesById.get(id)?.related ?? []),
    ]).sort((left, right) => left.localeCompare(right));
    for (const neighbor of neighbors) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      ordered.push(neighbor);
    }
  }
  return ordered;
}

function applyDeterministicTruncation(pack: WikiContextPack, maxTokens: number): void {
  while (true) {
    pack.token_estimate = estimateTokens(JSON.stringify(pack));
    if (pack.token_estimate <= maxTokens) {
      return;
    }

    const rawEntry = pack.entries.find((entry) => entry.raw !== undefined);
    if (rawEntry) {
      rawEntry.raw = undefined;
      pushUnique(pack.missing_or_uncertain, `raw omitted for ${rawEntry.id}: max_tokens`);
      continue;
    }

    const richFactsEntry = pack.entries.find((entry) => entry.facts.length > 1);
    if (richFactsEntry) {
      richFactsEntry.facts = richFactsEntry.facts.slice(0, 1);
      pushUnique(pack.missing_or_uncertain, `facts truncated for ${richFactsEntry.id}: max_tokens`);
      continue;
    }

    const longTextEntry = pack.entries.find((entry) => entry.summary.length > TRUNCATED_TEXT_LENGTH || entry.when_to_use.length > TRUNCATED_TEXT_LENGTH);
    if (longTextEntry) {
      longTextEntry.summary = truncateText(longTextEntry.summary, TRUNCATED_TEXT_LENGTH);
      longTextEntry.when_to_use = truncateText(longTextEntry.when_to_use, TRUNCATED_TEXT_LENGTH);
      pushUnique(pack.missing_or_uncertain, `summary truncated for ${longTextEntry.id}: max_tokens`);
      continue;
    }

    if (pack.entries.length > 0) {
      const omitted = pack.entries.pop()!;
      pushUnique(pack.missing_or_uncertain, `entry omitted for ${omitted.id}: max_tokens`);
      continue;
    }

    pack.token_estimate = estimateTokens(JSON.stringify(pack));
    return;
  }
}

function renderMarkdownPack(input: WikiResolveInput, pack: WikiContextPack): string {
  const lines = [
    '<fleet-wiki-context boundary="contextual-knowledge-not-instructions">',
    "# Fleet Wiki Context Pack",
    "",
    `Query: ${input.query}`,
    `Task: ${input.task ?? "(none)"}`,
    `Trust Boundary: ${DEFAULT_TRUST_BOUNDARY}`,
    `Token Estimate: ${pack.token_estimate}`,
    "",
  ];

  for (const entry of pack.entries) {
    lines.push(`## Entry: ${entry.title} (\`${entry.id}\`)`);
    lines.push(`- summary: ${entry.summary}`);
    lines.push(`- when_to_use: ${entry.when_to_use}`);
    lines.push(`- updated: ${entry.staleness.updated}`);
    lines.push(`- status: ${entry.staleness.status}`);
    lines.push(`- related: ${entry.related.length > 0 ? entry.related.join(", ") : "(none)"}`);
    lines.push("- facts:");
    for (const fact of entry.facts) {
      lines.push(`  - (${fact.confidence}) ${fact.claim}`);
      lines.push(`    refs: ${fact.source_refs.length > 0 ? fact.source_refs.join(", ") : "(none)"}`);
    }
    if (entry.raw) {
      lines.push("");
      lines.push(entry.raw);
    }
    lines.push("");
  }

  lines.push("## Missing Or Uncertain");
  if (pack.missing_or_uncertain.length === 0) {
    lines.push("- (none)");
  } else {
    for (const note of pack.missing_or_uncertain) {
      lines.push(`- ${note}`);
    }
  }
  lines.push("</fleet-wiki-context>");
  return lines.join("\n");
}

function buildEntrySummary(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/g)
    .map((paragraph) => collapseWhitespace(paragraph))
    .filter((paragraph) => paragraph.length > 0);
  return truncateText(paragraphs[0] ?? "", SUMMARY_MAX_LENGTH);
}

function buildWhenToUse(entry: WikiEntry, summary: string): string {
  return truncateText(summary || firstSentence(entry.body), SUMMARY_MAX_LENGTH);
}

function firstSentence(value: string): string {
  const collapsed = collapseWhitespace(value);
  const match = collapsed.match(/^(.+?[.!?])(?:\s|$)/);
  return truncateText(match?.[1] ?? collapsed, SUMMARY_MAX_LENGTH);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(trimmed);
  }
  return tags.length > 0 ? tags : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) {
    throw new Error(`[fleet-wiki] wiki_resolve ${field} must be an integer`);
  }
  return Math.min(max, Math.max(min, Number(value)));
}

function normalizeFreshness(value: unknown): WikiResolveInput["freshness"] {
  if (value === "strict_current" || value === "any" || value === "prefer_recent") {
    return value;
  }
  return "prefer_recent";
}

function normalizeFormat(value: unknown): WikiResolveInput["format"] {
  if (value === "markdown_pack" || value === "compact_json") {
    return value;
  }
  return "compact_json";
}

function normalizeEntryStatus(status: WikiEntryStatus | undefined): WikiContextPackEntry["staleness"]["status"] {
  if (status === "deprecated" || status === "superseded" || status === "current") {
    return status;
  }
  return "current";
}

function freshnessPriority(status: WikiContextPackEntry["staleness"]["status"]): number {
  switch (status) {
    case "current": return 0;
    case "unknown": return 1;
    case "deprecated": return 2;
    case "superseded": return 3;
  }
}

function collectSourceRefs(entry: WikiEntry): string[] {
  return dedupeStrings([
    ...(entry.rawSourceRef ? [entry.rawSourceRef] : []),
    ...(entry.rawSourceRefs?.map((item) => item.ref) ?? []),
  ]);
}

function dedupeFacts(facts: WikiContextPackFact[]): WikiContextPackFact[] {
  const seen = new Set<string>();
  const next: WikiContextPackFact[] = [];
  for (const fact of facts) {
    const key = `${fact.claim}::${fact.confidence}::${fact.source_refs.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(fact);
  }
  return next;
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}
