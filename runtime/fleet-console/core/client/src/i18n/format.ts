import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

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
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(toDate(value));
}

export function formatDate(value: Date | string | number, locale: ConsoleLocale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    dateStyle: "medium",
  }).format(toDate(value));
}

export function formatTimeOfDay(value: Date | string | number, locale: ConsoleLocale): string {
  return new Intl.DateTimeFormat(LOCALE_TAG[locale], {
    hour: "2-digit",
    minute: "2-digit",
  }).format(toDate(value));
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}
