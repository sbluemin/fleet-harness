/**
 * Persisted-document sanitizers the Anthropic and Gemini spend ledgers share. A ledger file is
 * user-editable JSON, so each ledger drops what it cannot read; the provider-specific document
 * shape and block rules stay in each ledger.
 */

/** 오류 본문 원문은 화면에 한 줄로 서므로 길이·개행만 다듬는다. 키·요청 본문은 오지 않는다. */
export const MAX_BLOCK_TEXT = 300;

/** 주 키 — 그 주 월요일의 달력 날짜("2026-11-16"). */
export const WEEK_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/;

export function clampText(value: string): string | undefined {
  const text = value.replace(/[\r\n]+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_BLOCK_TEXT ? `${text.slice(0, MAX_BLOCK_TEXT)}…` : text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function sanitizeAmounts(value: unknown, pattern: RegExp): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!pattern.test(key)) continue;
    if (typeof raw !== "string" || !/^\d{1,40}$/.test(raw)) continue;
    result[key] = raw;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
