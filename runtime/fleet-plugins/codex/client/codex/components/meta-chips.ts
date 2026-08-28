import type { EntryFrontmatter, SearchEntry } from "../api";
import { getGlobalSettingsStoreState } from "../../global-settings-store.js";
import { formatDate, getT } from "../../i18n/index.js";
import { resolveConsoleLanguage } from "../../whatsnew-i18n.js";
import { escapeAttribute, escapeHtml } from "../utils";

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

export interface RenderMetaChipsOptions {
  /** true면 태그 칩이 카탈로그 태그 필터를 실행하는 버튼이 된다(기본 false = 정적 표기). */
  interactiveTags?: boolean;
}

// 태그가 이 수를 넘으면 앞쪽만 남기고 +N 토글로 접는다 — 좁은 분할 페인에서 칩이
// 여러 줄을 차지해 본문 도달을 밀어내는 것을 막는다(정확히 임계값이면 전부 표시).
const TAG_CLAMP_LIMIT = 4;
const TAG_CLAMP_VISIBLE = 3;

export function renderMetaChips(
  frontmatter: EntryFrontmatter | SearchEntry,
  options: RenderMetaChipsOptions = {},
): string {
  const locale = resolveActiveLocale();
  const t = getT(locale);
  const clamped = frontmatter.tags.length > TAG_CLAMP_LIMIT;
  const tags = frontmatter.tags
    .map((tag, index) => renderTagChip(tag, {
      interactive: options.interactiveTags === true,
      overflow: clamped && index >= TAG_CLAMP_VISIBLE,
      filterLabel: t("codex.nav.filterByTag", { tag }),
    }))
    .join("");
  const overflowCount = frontmatter.tags.length - TAG_CLAMP_VISIBLE;
  const moreToggle = clamped
    ? `<button type="button" class="chip chip-more" data-chips-toggle aria-expanded="false" aria-label="${escapeAttribute(t("codex.meta.moreTags", { count: overflowCount }))}">+${overflowCount}</button>`
    : "";
  const badge = renderStatusBadge(frontmatter);
  const updatedLabel = formatRelativeUpdated(frontmatter.updated);
  return `
    <div class="meta-chips"${clamped ? ' data-collapsed="true"' : ""}>
      ${tags}
      ${moreToggle}
      ${badge}
      <span class="chip" title="${escapeAttribute(formatDate(frontmatter.updated, locale))}">${escapeHtml(t("codex.meta.updated", { date: updatedLabel }))}</span>
    </div>
  `;
}

function renderTagChip(
  tag: string,
  opts: { interactive: boolean; overflow: boolean; filterLabel: string },
): string {
  const className = `chip chip-tag${opts.overflow ? " chip-tag--overflow" : ""}`;
  if (!opts.interactive) return `<span class="${className}">${escapeHtml(tag)}</span>`;
  // 카탈로그의 태그 칩과 같은 약속 — 칩 모양이면 눌러서 그 태그로 거른다.
  return `<button type="button" class="${className}" data-doc-tag="${escapeAttribute(tag)}" aria-label="${escapeAttribute(opts.filterLabel)}">${escapeHtml(tag)}</button>`;
}

/** 카탈로그·문서 헤더가 공유하는 갱신 시각 문법 — 일/달/년 단위 상대시간. */
export function formatRelativeUpdated(iso: string): string {
  const updated = new Date(iso);
  if (Number.isNaN(updated.getTime())) return iso;
  const now = new Date();
  const updatedDay = Date.UTC(updated.getFullYear(), updated.getMonth(), updated.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const t = getT(resolveActiveLocale());
  const elapsedDays = Math.max(0, Math.floor((today - updatedDay) / 86_400_000));
  if (elapsedDays === 0) return t("codex.nav.updatedToday");
  if (elapsedDays < 30) return t("codex.nav.updatedDaysAgo", { count: elapsedDays });
  if (elapsedDays < 365) return t("codex.nav.updatedMonthsAgo", { count: Math.floor(elapsedDays / 30) });
  return t("codex.nav.updatedYearsAgo", { count: Math.floor(elapsedDays / 365) });
}

export function renderTagChips(tags: string[]): string {
  return tags.map((tag) => `<span class="chip chip-muted">${escapeHtml(tag)}</span>`).join("");
}

function renderStatusBadge(frontmatter: EntryFrontmatter | SearchEntry): string {
  const badge = getEntryStatusBadge(frontmatter);
  if (!badge) return "";
  return `<span class="chip ${badge.tone === "deprecated" ? "chip-coral" : badge.tone === "stale" ? "chip-stale" : ""}" title="${escapeAttribute(badge.title)}">${escapeHtml(badge.label)}</span>`;
}

export function getEntryStatusBadge(frontmatter: EntryFrontmatter | SearchEntry, now: Date = new Date()): EntryStatusBadge | null {
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
  // current는 기본 상태다 — 배지는 예외(초안·폐기·낡음)에만 말을 얹는다.
  if (status === "draft") {
    return { label: status, tone: "neutral", title: status };
  }
  return null;
}
