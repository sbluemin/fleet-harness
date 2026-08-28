/**
 * 로케일 날짜·상대시간 포매팅. 순수 함수이고 호스트 상태를 읽지 않으므로 SDK가 소유한다 —
 * 플러그인마다 Intl 옵션을 다시 고르면 같은 콘솔 안에서 같은 시각이 표면마다 다르게 읽힌다.
 */
import type { ConsoleLocale } from "./types.js";

const LOCALE_TAG: Record<ConsoleLocale, string> = {
  en: "en-US",
  ko: "ko-KR",
};

const RELATIVE_DIVISIONS = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: Number.POSITIVE_INFINITY, unit: "day" },
] as const;

export function formatRelativeTime(timestampMs: number, locale: ConsoleLocale, nowMs = Date.now()): string {
  const formatter = new Intl.RelativeTimeFormat(LOCALE_TAG[locale], { numeric: "auto" });
  let duration = (timestampMs - nowMs) / 1000;
  for (const division of RELATIVE_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return formatter.format(Math.round(duration), "day");
}

export function formatAbsoluteDateTime(value: Date | string | number, locale: ConsoleLocale): string {
  const date = toDate(value);
  if (!isValidDate(date)) return rawText(value);
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(value: Date | string | number, locale: ConsoleLocale): string {
  const date = toDate(value);
  if (!isValidDate(date)) return rawText(value);
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: "medium",
  }).format(date);
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

// 파싱할 수 없는 값은 Intl에 넘기면 RangeError가 나므로 원본을 그대로 돌려준다.
// 수기로 작성된 Wiki frontmatter처럼 형식이 보장되지 않는 입력이 화면을 깨뜨리지 않게 하는 계약이다.
function rawText(value: Date | string | number): string {
  return typeof value === "string" ? value : String(value);
}
