import type { WikiEntry } from "./types.js";

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
