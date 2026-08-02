import path from "node:path";

import { wrapWikiEntryBoundary } from "./store.js";
import { normalizeLimit, normalizeTopic } from "./briefing.js";
import { collectRetrievalLexicalMatches, tokenizeRetrievalTopic } from "./briefing.js";
import { buildBacklinksIndex } from "./store.js";
import { listWiki, loadIndex } from "./store.js";
import type { BriefingHit, MemoryPaths, WikiEntry, WikiEntryStatus } from "./types.js";

export interface EnhancedSearchOptions {
  topic?: string;
  tags?: string[];
  limit?: number;
  now?: Date;
  graphBoost?: boolean;
}

export type EnhancedSearchHit = BriefingHit;

interface EnhancedRankedHit {
  hit: EnhancedSearchHit;
  enhancedScore: number;
  updatedPriority: number;
}

interface MatchSignals {
  legacyReason: BriefingHit["reason"] | null;
  matchedFields: string[];
  matchedSnippets: Array<{ field: string; snippet: string }>;
  lexicalScore: number;
  bm25Score: number;
  graphBoost: number;
  freshnessBoost: number;
  statusBoost: number;
  aliasBoost: number;
  tagBoost: number;
  titleBoost: number;
  bodyBoost: number;
  stale: boolean;
}

const EXACT_ID_PRIORITY = 500;
const EXACT_ALIAS_PRIORITY = 420;
const TAG_PRIORITY = 320;
const TITLE_PRIORITY = 220;
const BODY_PRIORITY = 120;
const TYPE_PRIORITY = 90;
const STATUS_PRIORITY = 80;
const HIGH_CONFIDENCE_BOOST = 35;
const CURRENT_STATUS_BOOST = 25;
const DEPRECATED_STATUS_BOOST = -10;
const SUPERSEDED_STATUS_BOOST = -20;
const STALE_PENALTY = -18;
const GRAPH_BOOST_FACTOR = 8;
const RELATED_BOOST_FACTOR = 4;

export async function enhancedSearch(paths: MemoryPaths, options: EnhancedSearchOptions): Promise<EnhancedSearchHit[]> {
  const topic = normalizeTopic(options.topic);
  const tags = normalizeTags(options.tags);
  const limit = normalizeLimit(options.limit);
  const now = options.now ?? new Date();
  const entries = await listWiki(paths);
  const index = await loadIndex(paths);
  const backlinks = buildBacklinksIndex(entries);
  const documentFrequency = buildDocumentFrequency(entries);
  const averageLength = computeAverageBodyLength(entries);
  const rankedHits: EnhancedRankedHit[] = [];

  for (const entry of entries) {
    if (!index[entry.id]) {
      index[entry.id] = {
        path: path.join("wiki", `${entry.id}.md`),
        title: entry.title,
        tags: entry.tags,
        updated: entry.updated,
      };
    }
  }

  for (const entry of entries) {
    const signals = computeMatchSignals({
      entry,
      topic,
      tags,
      now,
      backlinks,
      documentFrequency,
      averageLength,
      graphBoostEnabled: options.graphBoost !== false,
      documentCount: entries.length,
    });
    if (!signals.legacyReason) {
      continue;
    }
    rankedHits.push({
      hit: toEnhancedHit(entry, signals),
      enhancedScore: signals.lexicalScore + signals.bm25Score + signals.graphBoost + signals.freshnessBoost + signals.statusBoost,
      updatedPriority: Date.parse(entry.updated) || 0,
    });
  }

  return rankedHits
    .sort(compareEnhancedHits)
    .slice(0, limit)
    .map((item) => item.hit);
}

function normalizeTags(tags: string[] | undefined): string[] {
  return (tags ?? []).map((tag) => tag.toLowerCase().trim()).filter((tag) => tag.length > 0);
}

function buildDocumentFrequency(entries: WikiEntry[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const entry of entries) {
    const uniqueTerms = new Set(tokenizeRetrievalTopic([entry.title, entry.body, ...(entry.aliases ?? []), ...(entry.tags ?? [])].join(" ")));
    for (const term of uniqueTerms) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  return frequency;
}

function computeAverageBodyLength(entries: WikiEntry[]): number {
  if (entries.length === 0) return 1;
  const totalLength = entries.reduce((sum, entry) => sum + Math.max(tokenizeRetrievalTopic(entry.body).length, 1), 0);
  return totalLength / entries.length;
}

function computeMatchSignals(input: {
  entry: WikiEntry;
  topic: string;
  tags: string[];
  now: Date;
  backlinks: Map<string, Set<string>>;
  documentFrequency: Map<string, number>;
  averageLength: number;
  graphBoostEnabled: boolean;
  documentCount: number;
}): MatchSignals {
  const { entry, topic, tags, now, backlinks, documentFrequency, averageLength, graphBoostEnabled, documentCount } = input;
  const matchedFields = new Set<string>();
  const matchedSnippets: Array<{ field: string; snippet: string }> = [];
  const topicTerms = tokenizeRetrievalTopic(topic);
  const lowerType = entry.type?.toLowerCase() ?? "";
  const lowerStatus = entry.status?.toLowerCase() ?? "";
  let legacyReason: BriefingHit["reason"] | null = null;
  let lexicalScore = 0;
  let aliasBoost = 0;
  let tagBoost = 0;
  let titleBoost = 0;
  let bodyBoost = 0;

  for (const lexicalMatch of collectRetrievalLexicalMatches(entry, topic, tags)) {
    legacyReason = chooseLegacyReason(legacyReason, lexicalMatch.reason);
    matchedFields.add(lexicalMatch.field);
    matchedSnippets.push(makeSnippet(entry, lexicalMatch.field, lexicalMatch.snippet));
    if (lexicalMatch.reason === "id") lexicalScore += EXACT_ID_PRIORITY;
    if (lexicalMatch.reason === "alias") aliasBoost += EXACT_ALIAS_PRIORITY;
    if (lexicalMatch.reason === "tag") tagBoost += TAG_PRIORITY;
    if (lexicalMatch.reason === "title") titleBoost += TITLE_PRIORITY;
    if (lexicalMatch.reason === "body") bodyBoost += BODY_PRIORITY;
  }

  if (topic && lowerType && lowerType.includes(topic)) {
    legacyReason = chooseLegacyReason(legacyReason, legacyReason ?? "title");
    lexicalScore += TYPE_PRIORITY;
    matchedFields.add("type");
    matchedSnippets.push(makeSnippet(entry, "type", entry.type ?? ""));
  }

  if (topic && lowerStatus && lowerStatus.includes(topic)) {
    legacyReason = chooseLegacyReason(legacyReason, legacyReason ?? "body");
    lexicalScore += STATUS_PRIORITY;
    matchedFields.add("status");
    matchedSnippets.push(makeSnippet(entry, "status", entry.status ?? ""));
  }

  const bm25Score = computeBm25Score(entry, topicTerms, documentFrequency, averageLength, documentCount);
  if (bm25Score > 0) {
    legacyReason = chooseLegacyReason(legacyReason, legacyReason ?? "body");
    matchedFields.add("bm25");
  }

  const graphBoost = graphBoostEnabled ? computeGraphBoost(entry, backlinks) : 0;
  if (graphBoost > 0) {
    matchedFields.add("graph");
  }

  const stale = isStale(entry.revalidateAfter, now);
  const freshnessBoost = stale ? STALE_PENALTY : 0;
  if (stale) {
    matchedFields.add("freshness");
  }

  const statusBoost = computeStatusBoost(entry.status, entry.confidence);
  if (entry.status) {
    matchedFields.add("status_rank");
  }
  if (entry.confidence) {
    matchedFields.add("confidence");
  }

  lexicalScore += aliasBoost + tagBoost + titleBoost + bodyBoost;

  return {
    legacyReason,
    matchedFields: [...matchedFields],
    matchedSnippets: dedupeSnippets(matchedSnippets),
    lexicalScore,
    bm25Score,
    graphBoost,
    freshnessBoost,
    statusBoost,
    aliasBoost,
    tagBoost,
    titleBoost,
    bodyBoost,
    stale,
  };
}

function toEnhancedHit(entry: WikiEntry, signals: MatchSignals): EnhancedSearchHit {
  const excerpt = wrapWikiEntryBoundary({
    id: entry.id,
    updated: entry.updated,
    content: entry.body.slice(0, 160),
  });
  const enhancedScore = roundScore(
    signals.lexicalScore + signals.bm25Score + signals.graphBoost + signals.freshnessBoost + signals.statusBoost,
  );
  return {
    id: entry.id,
    title: entry.title,
    score: enhancedScore,
    reason: signals.legacyReason ?? "body",
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
    matchedFields: signals.matchedFields,
    matchedSnippets: signals.matchedSnippets,
    stale: signals.stale,
    related: entry.related?.length ? [...entry.related] : undefined,
    whyThisMatched: buildWhyThisMatched(signals),
    boundary: excerpt,
    enhanced_score: enhancedScore,
    graph_boost: roundScore(signals.graphBoost),
  };
}

function chooseLegacyReason(
  current: BriefingHit["reason"] | null,
  next: BriefingHit["reason"],
): BriefingHit["reason"] {
  if (!current) return next;
  return legacyPriority(next) > legacyPriority(current) ? next : current;
}

function legacyPriority(reason: BriefingHit["reason"]): number {
  switch (reason) {
    case "id": return 5;
    case "alias": return 4;
    case "tag": return 3;
    case "title": return 2;
    case "body": return 1;
  }
}

function makeSnippet(entry: WikiEntry, field: string, content: string): { field: string; snippet: string } {
  return {
    field,
    snippet: wrapWikiEntryBoundary({
      id: entry.id,
      updated: entry.updated,
      content,
    }),
  };
}

function computeBm25Score(
  entry: WikiEntry,
  topicTerms: string[],
  documentFrequency: Map<string, number>,
  averageLength: number,
  documentCount: number,
): number {
  if (topicTerms.length === 0) return 0;
  const bodyTerms = tokenizeRetrievalTopic(entry.body);
  const titleTerms = tokenizeRetrievalTopic(entry.title);
  const aliasTerms = tokenizeRetrievalTopic((entry.aliases ?? []).join(" "));
  const termFrequency = new Map<string, number>();
  for (const term of [...bodyTerms, ...titleTerms, ...aliasTerms]) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }

  const k1 = 1.2;
  const b = 0.75;
  const documentLength = Math.max(bodyTerms.length + titleTerms.length + aliasTerms.length, 1);
  let score = 0;
  for (const term of topicTerms) {
    const tf = termFrequency.get(term) ?? 0;
    if (tf === 0) continue;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (documentLength / averageLength))));
  }
  return roundScore(score * 40);
}

function computeGraphBoost(entry: WikiEntry, backlinks: Map<string, Set<string>>): number {
  const backlinkScore = (backlinks.get(entry.id)?.size ?? 0) * GRAPH_BOOST_FACTOR;
  const relatedScore = (entry.related?.length ?? 0) * RELATED_BOOST_FACTOR;
  return backlinkScore + relatedScore;
}

function computeStatusBoost(status: WikiEntryStatus | undefined, confidence: WikiEntry["confidence"]): number {
  let boost = 0;
  if (status === "current") boost += CURRENT_STATUS_BOOST;
  if (status === "deprecated") boost += DEPRECATED_STATUS_BOOST;
  if (status === "superseded") boost += SUPERSEDED_STATUS_BOOST;
  if (status === "current" && confidence === "high") boost += HIGH_CONFIDENCE_BOOST;
  return boost;
}

function isStale(revalidateAfter: string | undefined, now: Date): boolean {
  if (!revalidateAfter) return false;
  const timestamp = Date.parse(revalidateAfter);
  return Number.isFinite(timestamp) && timestamp < now.getTime();
}

function buildWhyThisMatched(signals: MatchSignals): string {
  const reasons = [
    `Matched fields: ${signals.matchedFields.join(", ") || "none"}`,
    `Legacy reason: ${signals.legacyReason ?? "none"}`,
    `BM25: ${roundScore(signals.bm25Score)}`,
    `Graph boost: ${roundScore(signals.graphBoost)}`,
    `Freshness boost: ${roundScore(signals.freshnessBoost)}`,
    `Status boost: ${roundScore(signals.statusBoost)}`,
  ];
  return reasons.join(" | ");
}

function dedupeSnippets(snippets: Array<{ field: string; snippet: string }>): Array<{ field: string; snippet: string }> {
  const seen = new Set<string>();
  const deduped: Array<{ field: string; snippet: string }> = [];
  for (const snippet of snippets) {
    const key = `${snippet.field}\u0000${snippet.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(snippet);
  }
  return deduped;
}

function compareEnhancedHits(left: EnhancedRankedHit, right: EnhancedRankedHit): number {
  return (
    right.enhancedScore - left.enhancedScore
    || right.hit.score - left.hit.score
    || right.updatedPriority - left.updatedPriority
    || left.hit.id.localeCompare(right.hit.id)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
