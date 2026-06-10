import { dedupeStrings } from "./internal-utils.js";
import type { BriefingHit, WikiEntry } from "./types.js";

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
    return text.slice(0, MATCH_CONTEXT_BEFORE + MATCH_CONTEXT_AFTER).trim();
  }
  const start = Math.max(0, index - MATCH_CONTEXT_BEFORE);
  const end = Math.min(text.length, index + query.length + MATCH_CONTEXT_AFTER);
  return text.slice(start, end).trim();
}
