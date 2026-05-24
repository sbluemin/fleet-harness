import { languageLocale } from "../i18n/store";
import { t } from "../i18n/t";

export function formatAbsoluteDate(iso: string, locale?: string): string {
  try {
    return new Date(iso).toLocaleString(locale ?? languageLocale(), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { n: days });
  const months = Math.floor(days / 30);
  return t("time.monthsAgo", { n: months });
}
