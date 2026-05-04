import { queueDetailPath, queuePath } from "../router";
import type { QueueListItem } from "../api";
import type { QueueState } from "../queue-state";
import { renderOpBadge } from "./op-badge";
import { t } from "../i18n/t";

export function renderQueueList(state: QueueState): string {
  const { tab, items, pendingCount, archivedCount, loading, error } = state;

  if (loading && items.length === 0) {
    return `<div class="queue-view"><p class="loading">${t("drydock.loadingQueue")}</p></div>`;
  }
  if (error) {
    return `<div class="queue-view"><p class="error-box">${t("drydock.errorLoadQueue")} — ${escapeHtml(error)}</p></div>`;
  }

  const body = items.length === 0
    ? renderQueueEmpty(tab)
    : items.map((item) => renderQueueCard(item)).join("");

  const pendingBadge = pendingCount > 0
    ? `<span class="queue-badge">${pendingCount}</span>`
    : "";
  const archivedBadge = archivedCount > 0
    ? `<span class="queue-badge queue-badge--muted">${archivedCount}</span>`
    : "";

  return `
    <div class="queue-view">
      <div class="queue-header">
        <p class="drydock-eyebrow">MANIFEST · DRYDOCK</p>
        <h1 class="queue-title">${t("drydock.queueTitle")}</h1>
      </div>
      <div class="queue-tabs" role="tablist" aria-label="${t("drydock.ariaQueueTabs")}">
        <a class="queue-tab${tab === "pending" ? " active" : ""}"
           href="${escapeAttribute(queuePath("pending"))}"
           role="tab"
           aria-selected="${tab === "pending"}">
          ${t("drydock.tabPending")}${pendingBadge}
        </a>
        <a class="queue-tab${tab === "archived" ? " active" : ""}"
           href="${escapeAttribute(queuePath("archived"))}"
           role="tab"
           aria-selected="${tab === "archived"}">
          ${t("drydock.tabArchived")}${archivedBadge}
        </a>
      </div>
      <div class="queue-list">
        ${body}
      </div>
    </div>
  `;
}

function renderQueueEmpty(tab: "pending" | "archived"): string {
  const label = tab === "pending" ? t("drydock.emptyPending") : t("drydock.emptyArchived");
  return `<p class="queue-empty">${label}</p>`;
}

function renderQueueCard(item: QueueListItem): string {
  const { id, meta, source } = item;
  const statusDot = renderStatusDot(meta.status);
  const relative = relativeTime(meta.createdAt);
  const warnings = meta.warnings ?? [];
  const warningChips = warnings.slice(0, 3).map(
    (w) => `<span class="chip chip-muted">${escapeHtml(w)}</span>`,
  ).join("");
  const moreChip = warnings.length > 3
    ? `<span class="chip chip-muted">+${warnings.length - 3}</span>`
    : "";
  const sourceChip = source === "archive"
    ? `<span class="chip">${escapeHtml(meta.status)}</span>`
    : "";

  return `
    <a class="queue-card" href="${escapeAttribute(queueDetailPath(id))}">
      <div class="queue-card-top">
        <span class="queue-card-id">${escapeHtml(id)}</span>
        ${statusDot}
      </div>
      <div class="queue-card-meta">
        <span class="queue-card-time">${escapeHtml(relative)}</span>
        ${sourceChip}
        <div class="queue-card-chips">
          ${warningChips}${moreChip}
        </div>
      </div>
    </a>
  `;
}

function renderStatusDot(status: string): string {
  const colorClass = status === "pending"
    ? "status-dot--pending"
    : status === "accepted"
      ? "status-dot--accepted"
      : "status-dot--rejected";
  return `<span class="status-dot ${colorClass}" aria-label="${escapeAttribute(status)}"></span>`;
}

function relativeTime(iso: string): string {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
