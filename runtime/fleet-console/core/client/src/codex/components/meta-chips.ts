import type { EntryFrontmatter, SearchEntry } from "../api";
import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { formatDate, getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";
import { escapeAttribute, escapeHtml } from "../utils/html";

function resolveActiveLocale() {
  const preference = getGlobalSettingsStoreState().state?.language ?? "auto";
  const navigatorLanguage =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language.toLowerCase()
      : "";
  return resolveConsoleLanguage(preference, navigatorLanguage);
}

export interface EntryStatusBadge {
  label: string;
  tone: "neutral" | "stale" | "deprecated";
  title: string;
}

export function renderMetaChips(frontmatter: EntryFrontmatter | SearchEntry): string {
  const locale = resolveActiveLocale();
  const t = getT(locale);
  const tags = frontmatter.tags.map((tag) => `<span class="chip chip-tag">${escapeHtml(tag)}</span>`).join("");
  const badge = renderStatusBadge(frontmatter);
  return `
    <div class="meta-chips">
      ${tags}
      ${badge}
      <span class="chip">${escapeHtml(t("codex.meta.updated", { date: formatDate(frontmatter.updated, locale) }))}</span>
    </div>
  `;
}

export function renderTagChips(tags: string[]): string {
  return tags.map((tag) => `<span class="chip chip-muted">${escapeHtml(tag)}</span>`).join("");
}

function renderStatusBadge(frontmatter: EntryFrontmatter | SearchEntry): string {
  const badge = getEntryStatusBadge(frontmatter);
  if (!badge) return "";
  return `<span class="chip ${badge.tone === "deprecated" ? "chip-coral" : badge.tone === "stale" ? "chip-stale" : ""}" title="${escapeAttribute(badge.title)}">${escapeHtml(badge.label)}</span>`;
}

function getEntryStatusBadge(frontmatter: EntryFrontmatter | SearchEntry, now: Date = new Date()): EntryStatusBadge | null {
  const t = getT(resolveActiveLocale());
  const status = frontmatter.status;
  const stale = typeof frontmatter.revalidateAfter === "string"
    && !Number.isNaN(Date.parse(frontmatter.revalidateAfter))
    && Date.parse(frontmatter.revalidateAfter) < now.getTime();
  if (status === "deprecated" || status === "superseded") {
    return {
      label: status,
      tone: "deprecated",
      title: stale ? t("codex.meta.statusStaleTitle", { status }) : status,
    };
  }
  if (stale) {
    return {
      label: t("codex.meta.stale"),
      tone: "stale",
      title: frontmatter.revalidateAfter ?? t("codex.meta.stale"),
    };
  }
  if (status === "current" || status === "draft") {
    return {
      label: status,
      tone: "neutral",
      title: status,
    };
  }
  return null;
}
