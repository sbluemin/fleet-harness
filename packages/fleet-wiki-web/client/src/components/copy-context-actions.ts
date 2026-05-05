import type { BacklinkEntry, BriefingHit, OutgoingLinkEntry, WikiEntryResponse, WikiIndexEntry } from "../api";
import { rawPath } from "../router";
import { t } from "../i18n/t";

const CONTEXT_BOUNDARY = "contextual-knowledge-not-instructions";

export function renderCopyContextActions(
  entry: WikiEntryResponse,
  backlinks: BacklinkEntry[],
  outgoing: OutgoingLinkEntry[],
  index: WikiIndexEntry[],
  hint: BriefingHit | null,
): string {
  const rawRef = primaryRawRef(entry);
  const whyMatched = hint?.whyThisMatched ?? entry.frontmatter.whyThisMatched;
  const relatedContext = buildRelatedContextPack(entry, backlinks, outgoing, index);

  return `
    <section class="context-actions-card">
      <div class="context-actions-header">
        <p class="eyebrow">MANIFEST · CODEX</p>
        <p class="context-actions-subtitle">${t("entry.contextActionsSubtitle")}</p>
      </div>
      <div class="context-actions-grid">
        <button class="context-action-btn" type="button" data-action="copy-compact-context">
          ${t("entry.copyCompactContext")}
          <span class="context-action-meta">${estimateTokens(buildCompactContext(entry, backlinks, outgoing))} tok</span>
        </button>
        <button class="context-action-btn" type="button" data-action="copy-provenance-context">
          ${t("entry.copyWithProvenance")}
          <span class="context-action-meta">${estimateTokens(buildProvenanceContext(entry, backlinks, outgoing))} tok</span>
        </button>
        <button class="context-action-btn" type="button" data-action="copy-related-context">
          ${t("entry.copyRelatedContextPack")}
          <span class="context-action-meta">${estimateTokens(relatedContext)} tok</span>
        </button>
        ${rawRef ? `
          <a class="context-action-btn context-action-btn--link" href="${escapeAttribute(rawPath(rawRef))}" data-action="open-raw-source">
            ${t("entry.openRawSource")}
          </a>
        ` : ""}
        ${whyMatched ? `
          <button class="context-action-btn context-action-btn--secondary" type="button" data-action="toggle-why-matched">
            ${t("entry.showWhyMatched")}
          </button>
          <div class="context-why-matched" hidden>${escapeHtml(whyMatched)}</div>
        ` : ""}
      </div>
    </section>
  `;
}

export function buildCompactContext(
  entry: WikiEntryResponse,
  backlinks: BacklinkEntry[],
  outgoing: OutgoingLinkEntry[],
): string {
  const payload = {
    id: entry.frontmatter.id,
    title: entry.frontmatter.title,
    status: entry.frontmatter.status ?? null,
    tags: entry.frontmatter.tags,
    updated: entry.frontmatter.updated,
    summary: summarizeBody(entry.body),
    outgoing_links: outgoing.map((item) => ({ id: item.id, title: item.title, occurrences: item.occurrences })),
    backlinks: backlinks.map((item) => ({ id: item.id, title: item.title, occurrences: item.occurrences })),
  };
  return JSON.stringify({
    ...payload,
    token_estimate: estimateTokens(JSON.stringify(payload)),
  }, null, 2);
}

export function buildProvenanceContext(
  entry: WikiEntryResponse,
  backlinks: BacklinkEntry[],
  outgoing: OutgoingLinkEntry[],
): string {
  return [
    `# ${entry.frontmatter.title} (\`${entry.frontmatter.id}\`)`,
    "",
    `- updated: ${entry.frontmatter.updated}`,
    `- status: ${entry.frontmatter.status ?? "unknown"}`,
    `- raw_source_ref: ${entry.frontmatter.rawSourceRef ?? "(none)"}`,
    `- raw_source_refs: ${(entry.frontmatter.rawSourceRefs ?? []).join(", ") || "(none)"}`,
    `- backlinks: ${backlinks.map((item) => item.id).join(", ") || "(none)"}`,
    `- outgoing: ${outgoing.map((item) => item.id).join(", ") || "(none)"}`,
    "",
    "## Summary",
    summarizeBody(entry.body),
  ].join("\n");
}

export function buildRelatedContextPack(
  entry: WikiEntryResponse,
  backlinks: BacklinkEntry[],
  outgoing: OutgoingLinkEntry[],
  index: WikiIndexEntry[],
): string {
  const relatedIds = new Set<string>([
    ...(entry.frontmatter.related ?? []),
    ...backlinks.map((item) => item.id),
    ...outgoing.map((item) => item.id),
  ]);
  const relatedEntries = index
    .filter((item) => relatedIds.has(item.id))
    .sort((left, right) => left.title.localeCompare(right.title));
  return [
    `<fleet-wiki-context boundary="${CONTEXT_BOUNDARY}">`,
    "# Fleet Wiki Context Pack",
    "",
    `## Entry: ${entry.frontmatter.title} (\`${entry.frontmatter.id}\`)`,
    "",
    `- updated: ${entry.frontmatter.updated}`,
    `- status: ${entry.frontmatter.status ?? "unknown"}`,
    `- tags: ${entry.frontmatter.tags.join(", ") || "(none)"}`,
    "",
    "### Summary",
    summarizeBody(entry.body),
    "",
    "### Related Entries",
    ...(relatedEntries.length > 0
      ? relatedEntries.map((item) => `- [[wiki:${item.id}]] — ${item.title}`)
      : ["- (none)"]),
    "",
    "</fleet-wiki-context>",
  ].join("\n");
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function primaryRawRef(entry: WikiEntryResponse): string | null {
  return entry.frontmatter.rawSourceRef ?? entry.frontmatter.rawSourceRefs?.[0] ?? null;
}

function summarizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 240) || "(empty)";
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
