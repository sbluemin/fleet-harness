import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { formatAbsoluteDateTime, formatRelativeTime } from "../i18n/format.js";

// HTML 이스케이프 공용 유틸 — 클라이언트 컴포넌트 전체가 공유하는 단일 구현.
// escapeHtml은 텍스트 노드 컨텍스트용(&<> 3종), escapeAttribute는 속성 컨텍스트용(+쌍따옴표).

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function relativeTime(iso: string, locale: ConsoleLocale = "en"): string {
  const timestampMs = new Date(iso).getTime();
  if (Number.isNaN(timestampMs)) return iso;
  return formatRelativeTime(timestampMs, locale);
}
