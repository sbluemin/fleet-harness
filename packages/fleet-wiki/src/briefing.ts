import path from "node:path";

import { wrapWikiEntryBoundary } from "./boundaries.js";
import { extractWikiLinks } from "./links.js";
import { enhancedSearch } from "./search.js";
import { listWiki } from "./store.js";
import type { BriefingHit, MemoryPaths, WikiEntry } from "./types.js";

interface BriefingQueryOptions {
  topic?: string;
  tags?: string[];
  limit?: number;
  graphBoost?: boolean;
  enhanced?: boolean;
}

interface RankedHit {
  hit: BriefingHit;
  basePriority: number;
  matchTypePriority: number;
  statusPriority: number;
  updatedPriority: number;
}

interface MatchDetail {
  field: string;
  snippet?: string;
  tagBoost?: number;
  matchTypePriority: number;
}

export interface RetrievalLexicalMatch {
  reason: BriefingHit["reason"];
  field: "id" | "alias" | "tag" | "title" | "body";
  snippet: string;
  matchType: "exact_phrase" | "token_or";
  matchedTerms?: string[];
}

const BRIEFING_LIMIT_MIN = 1;
const BRIEFING_LIMIT_MAX = 50;
const BRIEFING_QUERY_MAX_LENGTH = 256;
const EXACT_ID_PRIORITY = 5;
const ALIAS_PRIORITY = 4;
const TAG_PRIORITY = 3;
const TITLE_PRIORITY = 2;
const BODY_PRIORITY = 1;
const MATCH_CONTEXT_BEFORE = 40;
const MATCH_CONTEXT_AFTER = 80;
const CURRENT_STATUS_BOOST = 2;
const DEFAULT_STATUS_BOOST = 1;
const DEPRECATED_STATUS_BOOST = 0;
const EXPLICIT_TAG_FILTER_BOOST = 5;
const EXACT_PHRASE_PRIORITY = 2;
const TOKEN_OR_PRIORITY = 1;

export async function briefingQuery(paths: MemoryPaths, options: BriefingQueryOptions): Promise<BriefingHit[]> {
  if (options.enhanced === true) {
    return enhancedSearch(paths, options);
  }

  const topic = normalizeTopic(options.topic);
  const tags = (options.tags ?? []).map((tag) => tag.toLowerCase().trim()).filter((tag) => tag.length > 0);
  const limit = normalizeLimit(options.limit);
  const wikiEntries = await listWiki(paths);
  const backlinksById = buildBacklinksIndex(wikiEntries);
  const graphBoost = options.graphBoost === true;
  const hits: RankedHit[] = [];

  for (const entry of wikiEntries) {
    const matches = findMatches(entry, topic, tags);
    for (const match of matches) {
      hits.push(toRankedHit(entry, match.reason, match.detail, graphBoost, backlinksById));
    }
  }

  return dedupeHits(hits)
    .sort(compareRankedHits)
    .slice(0, limit)
    .map((item) => item.hit);
}

function normalizeTopic(topic: string | undefined): string {
  const normalized = (topic ?? "").trim().toLowerCase();
  if (normalized.length > BRIEFING_QUERY_MAX_LENGTH) {
    throw new Error("[fleet-wiki] wiki_briefing query exceeds 256 characters");
  }
  return normalized;
}

export function tokenizeRetrievalTopic(topic: string): string[] {
  const tokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 || /^[0-9]+$/.test(token));
  return dedupeStrings(tokens);
}

export function collectRetrievalLexicalMatches(
  entry: WikiEntry,
  topic: string,
  tags: string[],
): RetrievalLexicalMatch[] {
  const matches: RetrievalLexicalMatch[] = [];
  const topicTokens = tokenizeRetrievalTopic(topic);
  const lowerTags = entry.tags.map((tag) => tag.toLowerCase());

  if (topic && entry.id.toLowerCase() === topic) {
    matches.push({
      reason: "id",
      field: "id",
      snippet: entry.id,
      matchType: "exact_phrase",
      matchedTerms: [topic],
    });
  }

  if (tags.some((tag) => lowerTags.includes(tag))) {
    const matchedTag = tags.find((tag) => lowerTags.includes(tag)) ?? entry.tags[0] ?? "";
    matches.push({
      reason: "tag",
      field: "tag",
      snippet: matchedTag,
      matchType: "exact_phrase",
      matchedTerms: [matchedTag.toLowerCase()],
    });
  }

  const aliasMatch = findLexicalFieldMatch(entry.aliases ?? [], topic, topicTokens, "alias", "alias");
  if (aliasMatch) {
    matches.push(aliasMatch);
  }

  const titleMatch = findLexicalFieldMatch([entry.title], topic, topicTokens, "title", "title");
  if (titleMatch) {
    matches.push(titleMatch);
  }

  const bodyMatch = findLexicalFieldMatch([entry.body], topic, topicTokens, "body", "body");
  if (bodyMatch) {
    matches.push(bodyMatch);
  }

  return matches;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < BRIEFING_LIMIT_MIN || limit > BRIEFING_LIMIT_MAX) {
    throw new Error("[fleet-wiki] wiki_briefing limit must be between 1 and 50");
  }
  return limit;
}

function buildBacklinksIndex(entries: WikiEntry[]): Map<string, string[]> {
  const backlinks = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const linkedId of extractWikiLinks(entry.body)) {
      const targets = backlinks.get(linkedId) ?? new Set<string>();
      targets.add(entry.id);
      backlinks.set(linkedId, targets);
    }
  }

  const normalized = new Map<string, string[]>();
  for (const [id, refs] of backlinks.entries()) {
    normalized.set(id, [...refs].sort((left, right) => left.localeCompare(right)));
  }
  return normalized;
}

function findMatches(
  entry: WikiEntry,
  topic: string,
  tags: string[],
): Array<{ reason: BriefingHit["reason"]; detail: MatchDetail }> {
  const matches: Array<{ reason: BriefingHit["reason"]; detail: MatchDetail }> = [];
  for (const match of collectRetrievalLexicalMatches(entry, topic, tags)) {
    matches.push({
      reason: match.reason,
      detail: {
        field: match.field,
        snippet: match.snippet,
        tagBoost: match.reason === "tag" ? EXPLICIT_TAG_FILTER_BOOST : undefined,
        matchTypePriority: getMatchTypePriority(match.matchType),
      },
    });
  }
  return matches;
}

function toRankedHit(
  entry: WikiEntry,
  reason: BriefingHit["reason"],
  detail: MatchDetail,
  graphBoost: boolean,
  backlinksById: Map<string, string[]>,
): RankedHit {
  const basePriority = getBasePriority(reason);
  const statusPriority = getStatusPriority(entry.status);
  const matchedField = detail.field;
  const snippet = detail.snippet ?? inferFallbackSnippet(entry, reason);
  const excerpt = wrapWikiEntryBoundary({
    id: entry.id,
    updated: entry.updated,
    content: entry.body.slice(0, 160),
  });
  const matchedSnippets = snippet
    ? [{
        field: matchedField,
        snippet: wrapWikiEntryBoundary({
          id: entry.id,
          updated: entry.updated,
          content: snippet,
        }),
      }]
    : undefined;
  const graphScore = graphBoost ? (backlinksById.get(entry.id)?.length ?? 0) : 0;
  const related = entry.related?.length ? [...entry.related] : undefined;
  const hit: BriefingHit = {
    id: entry.id,
    title: entry.title,
    score: basePriority * 100 + statusPriority * 10 + graphScore + (detail.tagBoost ?? 0),
    reason,
    excerpt,
    path: path.join("wiki", `${entry.id}.md`),
    tags: entry.tags,
    updated: entry.updated,
    version: entry.version,
    rawSourceRef: entry.rawSourceRef,
    rawSourceRefs: entry.rawSourceRefs?.map((item) => item.ref),
    status: entry.status,
    confidence: entry.confidence,
    aliases: entry.aliases,
    type: entry.type,
    matchedFields: [matchedField],
    matchedSnippets,
    tokenEstimate: estimateTokens(excerpt),
    stale: isStale(entry.revalidateAfter),
    related,
    whyThisMatched: buildWhyThisMatched(reason, detail.snippet ?? matchedField, entry.status),
    boundary: excerpt,
  };

  return {
    hit,
    basePriority,
    matchTypePriority: detail.matchTypePriority,
    statusPriority,
    updatedPriority: Date.parse(entry.updated) || 0,
  };
}

function dedupeHits(hits: RankedHit[]): RankedHit[] {
  const byId = new Map<string, RankedHit>();
  for (const candidate of hits) {
    const existing = byId.get(candidate.hit.id);
    if (!existing) {
      byId.set(candidate.hit.id, candidate);
      continue;
    }

    const comparison = compareRankedHits(candidate, existing);
    if (comparison < 0) {
      mergeRankedHitMetadata(candidate, existing);
      byId.set(candidate.hit.id, candidate);
      continue;
    }
    mergeRankedHitMetadata(existing, candidate);
  }
  return [...byId.values()];
}

function mergeRankedHitMetadata(target: RankedHit, source: RankedHit): void {
  target.hit.matchedFields = dedupeStrings([...target.hit.matchedFields, ...source.hit.matchedFields]);
  const combinedSnippets = [...(target.hit.matchedSnippets ?? []), ...(source.hit.matchedSnippets ?? [])];
  target.hit.matchedSnippets = dedupeSnippets(combinedSnippets);
  target.hit.whyThisMatched = buildMergedWhyThisMatched(target.hit.matchedFields, target.hit.status);
  target.hit.tokenEstimate = estimateTokens(JSON.stringify(target.hit.matchedSnippets ?? []));
}

function compareRankedHits(left: RankedHit, right: RankedHit): number {
  return (
    right.basePriority - left.basePriority
    || right.matchTypePriority - left.matchTypePriority
    || right.statusPriority - left.statusPriority
    || right.hit.score - left.hit.score
    || right.updatedPriority - left.updatedPriority
    || left.hit.id.localeCompare(right.hit.id)
  );
}

function findLexicalFieldMatch(
  values: string[],
  topic: string,
  topicTokens: string[],
  reason: BriefingHit["reason"],
  field: RetrievalLexicalMatch["field"],
): RetrievalLexicalMatch | null {
  if (!topic) return null;

  for (const value of values) {
    const lowerValue = value.toLowerCase();
    if (lowerValue.includes(topic)) {
      return {
        reason,
        field,
        snippet: field === "title" || field === "body" ? buildMatchSnippet(value, topic) : value,
        matchType: "exact_phrase",
        matchedTerms: [topic],
      };
    }
  }

  if (topicTokens.length <= 1) {
    return null;
  }

  for (const token of topicTokens) {
    for (const value of values) {
      const valueTokens = tokenizeRetrievalTopic(value);
      if (!valueTokens.includes(token)) continue;
      return {
        reason,
        field,
        snippet: field === "title" || field === "body" ? buildMatchSnippet(value, token) : value,
        matchType: "token_or",
        matchedTerms: [token],
      };
    }
  }

  return null;
}

function getBasePriority(reason: BriefingHit["reason"]): number {
  if (reason === "id") return EXACT_ID_PRIORITY;
  if (reason === "alias") return ALIAS_PRIORITY;
  if (reason === "tag") return TAG_PRIORITY;
  if (reason === "title") return TITLE_PRIORITY;
  return BODY_PRIORITY;
}

function getStatusPriority(status: WikiEntry["status"]): number {
  if (status === "current") return CURRENT_STATUS_BOOST;
  if (status === "deprecated") return DEPRECATED_STATUS_BOOST;
  return DEFAULT_STATUS_BOOST;
}

function getMatchTypePriority(matchType: RetrievalLexicalMatch["matchType"]): number {
  if (matchType === "exact_phrase") return EXACT_PHRASE_PRIORITY;
  return TOKEN_OR_PRIORITY;
}

function buildMatchSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const index = lowerText.indexOf(query.toLowerCase());
  if (index === -1) {
    return text.slice(0, MATCH_CONTEXT_BEFORE + MATCH_CONTEXT_AFTER).trim();
  }
  const start = Math.max(0, index - MATCH_CONTEXT_BEFORE);
  const end = Math.min(text.length, index + query.length + MATCH_CONTEXT_AFTER);
  return text.slice(start, end).trim();
}

function inferFallbackSnippet(entry: WikiEntry, reason: BriefingHit["reason"]): string {
  if (reason === "title") return entry.title;
  if (reason === "tag") return entry.tags[0] ?? "";
  if (reason === "alias") return entry.aliases?.[0] ?? "";
  return entry.body.slice(0, 120).trim();
}

function isStale(revalidateAfter: string | undefined): boolean | undefined {
  if (!revalidateAfter) return undefined;
  const timestamp = Date.parse(revalidateAfter);
  if (Number.isNaN(timestamp)) return undefined;
  return timestamp < Date.now();
}

function buildWhyThisMatched(
  reason: BriefingHit["reason"],
  detail: string,
  status: WikiEntry["status"],
): string {
  const base =
    reason === "id" ? `Matched exact id "${detail}".`
      : reason === "alias" ? `Matched alias "${detail}".`
        : reason === "tag" ? `Matched tag "${detail}".`
          : reason === "title" ? `Matched title snippet "${detail}".`
            : `Matched body snippet "${detail}".`;
  if (status === "current") return `${base} Boosted by status current.`;
  if (status === "deprecated") return `${base} Penalized by status deprecated.`;
  return base;
}

function buildMergedWhyThisMatched(fields: string[], status: WikiEntry["status"]): string {
  const base = `Matched fields: ${fields.join(", ")}.`;
  if (status === "current") return `${base} Boosted by status current.`;
  if (status === "deprecated") return `${base} Penalized by status deprecated.`;
  return base;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      deduped.push(value);
    }
  }
  return deduped;
}

function dedupeSnippets(values: Array<{ field: string; snippet: string }>): Array<{ field: string; snippet: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ field: string; snippet: string }> = [];
  for (const value of values) {
    const key = `${value.field}:${value.snippet}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(value);
    }
  }
  return deduped;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
