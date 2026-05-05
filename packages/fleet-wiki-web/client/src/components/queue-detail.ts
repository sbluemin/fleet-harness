import { queuePath, rawPath } from "../router";
import type { PatchDetailResponse } from "../api";
import type { QueueState } from "../queue-state";
import { renderOpBadge } from "./op-badge";
import { renderMarkdown } from "../markdown/renderer";
import { formatAbsoluteDate, relativeTime } from "../utils/time";
import { t } from "../i18n/t";

const BACK_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M15 18 9 12l6-6" />
  </svg>
`;

const ARROW_ICON = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
`;

export function renderQueueDetail(state: QueueState): string {
  const { current, loading, error } = state;

  if (loading) {
    return `<div class="queue-detail-view"><p class="loading">${t("drydock.loadingPatch")}</p></div>`;
  }
  if (error) {
    return `<div class="queue-detail-view"><p class="error-box">${t("drydock.errorLoadPatch")} — ${escapeHtml(error)}</p></div>`;
  }
  if (!current) {
    return `<div class="queue-detail-view"><p class="empty-state">${t("drydock.notFound")}</p></div>`;
  }

  return renderPatchDetail(current, state);
}

function renderPatchDetail(detail: PatchDetailResponse, state: QueueState): string {
  const { patch, meta, wikiEntry, targetExists } = detail;
  const { frontmatter } = patch;
  const rendered = renderMarkdown(wikiEntry.body);
  const opBadge = renderOpBadge(frontmatter.op, targetExists);
  const rawRef = meta.rawSourceRef;

  return `
    <div class="queue-detail-view">
      <div class="queue-detail-layout">
        <div class="queue-detail-main">
          <a class="raw-back queue-back" href="${escapeAttribute(queuePath())}" aria-label="${t("drydock.ariaBackToDrydock")}">
            ${BACK_ICON}
            <span>Drydock</span>
          </a>
          <div class="queue-detail-header">
            <p class="drydock-eyebrow">MANIFEST · PATCH</p>
            <p class="queue-patch-id">${escapeHtml(meta.id)}</p>
            <h1 class="queue-summary">${escapeHtml(frontmatter.summary)}</h1>
            ${opBadge}
          </div>
          <article class="document">
            <div class="markdown-body">${rendered.html}</div>
          </article>
        </div>
        <aside class="queue-rail">
          ${renderPatchManifestCard(detail, rawRef)}
          ${renderPatchSetCard(detail)}
          ${renderQueueActionsCard(detail, state)}
        </aside>
      </div>
    </div>
  `;
}

function renderPatchManifestCard(detail: PatchDetailResponse, rawRef: string | undefined): string {
  const { patch, meta, targetExists } = detail;
  const { frontmatter } = patch;
  const opBadge = renderOpBadge(frontmatter.op, targetExists);
  const absoluteDate = formatAbsoluteDate(meta.createdAt);
  const relDate = relativeTime(meta.createdAt);
  const statusDot = renderStatusDot(meta.status);
  const warnings = meta.warnings ?? [];

  const rawRefHtml = rawRef
    ? `<dd class="queue-dl-value">
        <a class="manifest-link queue-raw-link" href="${escapeAttribute(rawPath(rawRef))}" data-raw-ref="${escapeAttribute(rawRef)}">
          <span class="manifest-ref">${escapeHtml(rawRef)}</span>
          <span class="manifest-arrow">${ARROW_ICON}</span>
        </a>
      </dd>`
    : `<dd class="queue-dl-value queue-dl-muted">${t("common.none")}</dd>`;

  const warningsHtml = warnings.length > 0
    ? `<dt class="queue-dl-key">${t("drydock.warnings")}</dt>
       <dd class="queue-dl-value">
         <div class="queue-card-chips">
           ${warnings.map((w) => `<span class="chip chip-muted">${escapeHtml(w)}</span>`).join("")}
         </div>
       </dd>`
    : "";

  return `
    <div class="queue-rail-card">
      <div class="queue-rail-header">
        <p class="drydock-eyebrow">MANIFEST · PATCH</p>
        <p class="queue-rail-subtitle">${t("drydock.patchManifestSubtitle")}</p>
      </div>
      <dl class="queue-dl">
        <dt class="queue-dl-key">${t("drydock.op")}</dt>
        <dd class="queue-dl-value">${opBadge}</dd>
        <dt class="queue-dl-key">${t("drydock.target")}</dt>
        <dd class="queue-dl-value queue-dl-mono">${escapeHtml(frontmatter.target)}</dd>
        <dt class="queue-dl-key">${t("drydock.proposer")}</dt>
        <dd class="queue-dl-value">${escapeHtml(frontmatter.proposer)}</dd>
        <dt class="queue-dl-key">${t("drydock.createdAt")}</dt>
        <dd class="queue-dl-value queue-dl-time">
          <time datetime="${escapeAttribute(meta.createdAt)}" title="${escapeAttribute(absoluteDate)}">
            ${escapeHtml(absoluteDate)}
            <span class="queue-dl-relative">(${escapeHtml(relDate)})</span>
          </time>
        </dd>
        <dt class="queue-dl-key">${t("drydock.status")}</dt>
        <dd class="queue-dl-value queue-dl-status">${statusDot}<span>${escapeHtml(meta.status)}</span></dd>
        <dt class="queue-dl-key">${t("drydock.rawSource")}</dt>
        ${rawRefHtml}
        ${warningsHtml}
      </dl>
    </div>
  `;
}

function renderQueueActionsCard(detail: PatchDetailResponse, state: QueueState): string {
  const { meta, source } = detail;
  if (meta.status !== "pending" || source !== "queue") return "";

  const { actionPending, actionError } = state;
  const disabledAttr = actionPending ? " disabled" : "";
  const safePatchId = escapeAttribute(meta.id);

  const errorHtml = actionError
    ? `<p class="queue-action-error">${escapeHtml(actionError)}</p>`
    : "";

  const spinnerHtml = actionPending
    ? `<span class="queue-action-spinner" aria-label="${t("queue.ariaProcessing")}"></span>`
    : "";

  return `
    <div class="queue-rail-card queue-actions-card">
      <div class="queue-rail-header">
        <p class="drydock-eyebrow">${t("queue.actionsTitle")}</p>
        <p class="queue-rail-subtitle">${t("queue.actionsSubtitle")}</p>
      </div>
      ${spinnerHtml}
      <div class="queue-action-buttons">
        <button class="queue-action-btn queue-action-btn--approve" type="button"
          data-action="queue-approve" data-patch-id="${safePatchId}"${disabledAttr}
          aria-label="${t("queue.ariaApprove")}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          ${t("queue.approve")}
        </button>
        <button class="queue-action-btn queue-action-btn--reject" type="button"
          data-action="queue-reject-toggle"${disabledAttr}
          aria-label="${t("queue.ariaReject")}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          ${t("queue.reject")}
        </button>
      </div>
      <form class="queue-reject-form" hidden data-action="queue-reject-submit" data-patch-id="${safePatchId}">
        <textarea class="queue-reject-textarea" name="reason" minlength="1" maxlength="256" required placeholder="${t("queue.rejectPlaceholder")}"></textarea>
        <div class="queue-action-buttons">
          <button class="queue-action-btn queue-action-btn--reject-submit" type="submit"${disabledAttr}>${t("common.confirm")}</button>
          <button class="queue-action-btn queue-action-btn--cancel" type="button" data-action="queue-reject-cancel"${disabledAttr}>${t("common.cancel")}</button>
        </div>
      </form>
      ${errorHtml}
    </div>
  `;
}

function renderPatchSetCard(detail: PatchDetailResponse): string {
  const patchSet = detail.patchSet;
  if (!patchSet || patchSet.members.length === 0) return "";
  return `
    <div class="queue-rail-card">
      <div class="queue-rail-header">
        <p class="drydock-eyebrow">MANIFEST · DRYDOCK</p>
        <p class="queue-rail-subtitle">${t("queue.patchSetSubtitle")}</p>
      </div>
      <p class="queue-patch-id">${escapeHtml(patchSet.id)}</p>
      <ul class="patch-set-list">
        ${patchSet.members.map((member) => `
          <li class="patch-set-item">
            <span class="patch-set-item-copy">
              <strong>${escapeHtml(member.summary ?? member.id)}</strong>
              <small>${escapeHtml(member.target ?? member.id)}</small>
            </span>
            <span class="chip ${member.status === "rejected" ? "chip-coral" : ""}">${escapeHtml(member.status ?? member.source)}</span>
          </li>
        `).join("")}
      </ul>
    </div>
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
