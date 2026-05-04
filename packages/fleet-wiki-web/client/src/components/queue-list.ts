import { queueDetailPath, queuePath } from "../router";
import type { QueueListItem } from "../api";
import type { QueueState } from "../queue-state";
import { renderOpBadge } from "./op-badge";

export function renderQueueList(state: QueueState): string {
  const { tab, items, pendingCount, archivedCount, loading, error } = state;

  if (loading && items.length === 0) {
    return `<div class="queue-view"><p class="loading">패치 큐를 불러오는 중</p></div>`;
  }
  if (error) {
    return `<div class="queue-view"><p class="error-box">큐를 불러오지 못했습니다 — ${escapeHtml(error)}</p></div>`;
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
        <h1 class="queue-title">패치 큐 정렬소</h1>
      </div>
      <div class="queue-tabs" role="tablist" aria-label="큐 탭">
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
  const label = tab === "pending" ? "대기 중인 패치가 없습니다." : "아카이브된 패치가 없습니다.";
  return `<p class="queue-empty">${label}</p>`;
}

function renderQueueCard(item: QueueListItem): string {
  const { id, meta, source } = item;
  const op = meta as { status: string; createdAt: string; warnings?: string[] } & typeof meta;
  // patch frontmatter는 meta에 없으므로 summary/target은 meta 외부에서 올 수 없음
  // → 카드에는 id(patchId), status, createdAt, warnings만 표시
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
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  return `${months}개월 전`;
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
