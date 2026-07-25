import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { formatAbsoluteDateTime, formatRelativeTime } from "../../i18n/format.js";

export function formatAbsoluteDate(iso: string, locale: ConsoleLocale = "en"): string {
  try {
    return formatAbsoluteDateTime(iso, locale);
  } catch {
    return iso;
  }
}

export function relativeTime(iso: string, locale: ConsoleLocale = "en"): string {
  const timestampMs = new Date(iso).getTime();
  if (Number.isNaN(timestampMs)) return iso;
  return formatRelativeTime(timestampMs, locale);
}
