import { queueDetailPath, queuePath } from "../router";
import type { QueueListItem } from "../api";
import type { QueueState } from "../queue-state";
import { renderOpBadge } from "./op-badge";
import { escapeAttribute, escapeHtml } from "../utils/html";
import { relativeTime } from "../utils/time";

export function renderQueueList(state: QueueState): string {
  const { tab, items, pendingCount, archivedCount, loading, error } = state;

  if (loading && items.length === 0) {
    return `<div class="queue-view"><p class="loading">Loading patch queue</p></div>`;
  }
  if (error) {
    return `<div class="queue-view"><p class="error-box">Failed to load queue — ${escapeHtml(error)}</p></div>`;
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
        <h1 class="queue-title">Patch Queue</h1>
      </div>
      <div class="queue-tabs" role="tablist" aria-label="Queue tabs">
        <a class="queue-tab${tab === "pending" ? " active" : ""}"
           href="${escapeAttribute(queuePath("pending"))}"
           role="tab"
           aria-selected="${tab === "pending"}">
          Pending${pendingBadge}
        </a>
        <a class="queue-tab${tab === "archived" ? " active" : ""}"
           href="${escapeAttribute(queuePath("archived"))}"
           role="tab"
           aria-selected="${tab === "archived"}">
          Archived${archivedBadge}
        </a>
      </div>
      <div class="queue-list">
        ${body}
      </div>
    </div>
  `;
}

function renderQueueEmpty(tab: "pending" | "archived"): string {
  const label = tab === "pending" ? "No pending patches." : "No archived patches.";
  return `<p class="queue-empty">${label}</p>`;
}

function renderQueueCard(item: QueueListItem): string {
  const { id, meta, source, summary, op, target } = item;
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
  const opBadge = op ? renderOpBadge(op, true) : "";
  const summaryHtml = summary
    ? `<p class="queue-card-summary">${escapeHtml(summary)}</p>`
    : "";
  const targetHtml = target
    ? `<span class="queue-card-target">${escapeHtml(target)}</span>`
    : "";

  return `
    <a class="queue-card" href="${escapeAttribute(queueDetailPath(id))}">
      ${summaryHtml}
      <div class="queue-card-top">
        <span class="queue-card-id">${escapeHtml(id)}</span>
        ${statusDot}
      </div>
      <div class="queue-card-meta">
        ${opBadge}
        ${targetHtml}
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

