import path from "node:path";

import { wrapWikiEntryBoundary } from "./boundaries.js";
import { dedupeStrings, estimateTokens, normalizeLimit, normalizeTopic } from "./internal-utils.js";
import { collectRetrievalLexicalMatches, type RetrievalLexicalMatch } from "./lexical.js";
import { buildBacklinksIndex as buildSharedBacklinksIndex } from "./links.js";
import { enhancedSearch } from "./search.js";
import { listWiki } from "./store.js";
import type { BriefingHit, MemoryPaths, WikiEntry } from "./types.js";

// barrel 표면 보존을 위한 동명 re-export — 구현은 lexical.ts로 이동했다.
export { collectRetrievalLexicalMatches, tokenizeRetrievalTopic } from "./lexical.js";
export type { RetrievalLexicalMatch } from "./lexical.js";

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

const EXACT_ID_PRIORITY = 5;
const ALIAS_PRIORITY = 4;
const TAG_PRIORITY = 3;
const TITLE_PRIORITY = 2;
const BODY_PRIORITY = 1;
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

// 공유 backlink 역인덱스를 briefing 랭킹이 쓰는 정렬 배열 형태로 변환한다.
function buildBacklinksIndex(entries: WikiEntry[]): Map<string, string[]> {
  const normalized = new Map<string, string[]>();
  for (const [id, refs] of buildSharedBacklinksIndex(entries).entries()) {
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
