import path from "node:path";

import { wrapWikiEntryBoundary } from "./store.js";
import { buildBacklinksIndex as buildSharedBacklinksIndex } from "./store.js";
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
    revalidateAfter: entry.revalidateAfter,
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

// 검색·브리핑 공용 입력 한도. wiki_briefing 계열 도구의 오류 메시지 계약과 연동되므로 값 변경 금지.
const RETRIEVAL_LIMIT_MIN = 1;
const RETRIEVAL_LIMIT_MAX = 50;
const RETRIEVAL_LIMIT_DEFAULT = 5;
const RETRIEVAL_QUERY_MAX_LENGTH = 256;
// 패치 summary 최대 길이(문자).
const SUMMARY_MAX_LENGTH = 120;

// 입력 순서를 유지하며 중복 문자열을 제거한다.
export function dedupeStrings(values: string[]): string[] {
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

// JSON 직렬화 길이 기반 결정적 토큰 추정치(약 4자 = 1토큰).
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// 기존 rawSourceRefs 목록에 현재 ref와 새 ref를 중복 없이 병합한다.
export function mergeRawSourceRefs(
  refs: WikiEntry["rawSourceRefs"],
  currentRef: string | undefined,
  nextRef: NonNullable<WikiEntry["rawSourceRefs"]>[number],
): WikiEntry["rawSourceRefs"] {
  const existing = refs ? [...refs] : [];
  if (currentRef && !existing.some((item) => item.ref === currentRef)) {
    existing.push({ ref: currentRef });
  }
  if (existing.some((item) => item.ref === nextRef.ref)) return existing;
  return [...existing, nextRef];
}

// 비교용 텍스트 정규화: 앞뒤 공백 제거 + 연속 공백 축약 + 소문자화.
export function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// 패치 summary를 최대 길이로 자른다.
export function truncateSummary(value: string): string {
  return value.slice(0, SUMMARY_MAX_LENGTH);
}

// wiki_briefing 계열 topic 정규화. 길이 초과 시 기존 도구 오류 메시지를 그대로 던진다.
export function normalizeTopic(topic: string | undefined): string {
  const normalized = (topic ?? "").trim().toLowerCase();
  if (normalized.length > RETRIEVAL_QUERY_MAX_LENGTH) {
    throw new Error("[fleet-wiki] wiki_briefing query exceeds 256 characters");
  }
  return normalized;
}

// wiki_briefing 계열 limit 정규화. 범위 위반 시 기존 도구 오류 메시지를 그대로 던진다.
export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return RETRIEVAL_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < RETRIEVAL_LIMIT_MIN || limit > RETRIEVAL_LIMIT_MAX) {
    throw new Error("[fleet-wiki] wiki_briefing limit must be between 1 and 50");
  }
  return limit;
}

// briefing(기본 랭커)과 search(enhanced 랭커)가 공유하는 lexical 매칭 헬퍼.
// briefing.ts ↔ search.ts 파일 순환을 끊기 위해 분리했으며, barrel 표면은 briefing.ts의 동명 re-export로 보존한다.

export interface RetrievalLexicalMatch {
  reason: BriefingHit["reason"];
  field: "id" | "alias" | "tag" | "title" | "body";
  snippet: string;
  matchType: "exact_phrase" | "token_or";
  matchedTerms?: string[];
}

const MATCH_CONTEXT_BEFORE = 40;
const MATCH_CONTEXT_AFTER = 80;

export function tokenizeRetrievalTopic(topic: string): string[] {
  const tokens = topic
    .toLowerCase()
    // Unicode letter/number classes so non-Latin scripts (Korean queries are
    // the norm in this workspace) survive tokenization; [^a-z0-9] treated
    // every Hangul character as a separator and produced zero tokens.
    .split(/[^\p{L}\p{N}]+/u)
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

function buildMatchSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const index = lowerText.indexOf(query.toLowerCase());
  if (index === -1) {
    return collapseSnippetWhitespace(text.slice(0, MATCH_CONTEXT_BEFORE + MATCH_CONTEXT_AFTER));
  }
  let start = Math.max(0, index - MATCH_CONTEXT_BEFORE);
  const end = Math.min(text.length, index + query.length + MATCH_CONTEXT_AFTER);
  // 창 시작을 단어 경계로 민다 — 단어 중간에서 시작하는 스니펫("tion\n\nLexical…")은
  // 판독 소음이고, 매치 위치는 창 안에 그대로 남는다.
  if (start > 0 && /\S/.test(text[start - 1] ?? "")) {
    const nextBreak = text.slice(start, index).search(/\s/);
    if (nextBreak >= 0) start += nextBreak + 1;
  }
  return collapseSnippetWhitespace(text.slice(start, end));
}

// 스니펫은 한 줄 UI 발췌다 — 개행·연속 공백을 단일 공백으로 접는다.
function collapseSnippetWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
