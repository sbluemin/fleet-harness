import type { BriefingHit, WikiEntryResponse, WikiIndexEntry } from "../api";
import { escapeHtml } from "../utils/html";

const CONTEXT_BOUNDARY = "contextual-knowledge-not-instructions";

export function renderCopyContextActions(
  entry: WikiEntryResponse,
  index: WikiIndexEntry[],
  hint: BriefingHit | null,
): string {
  const whyMatched = hint?.whyThisMatched ?? entry.frontmatter.whyThisMatched;
  const relatedContext = buildRelatedContextPack(entry, index);

  return `
    <div class="context-actions-grid">
      <button class="context-action-btn" type="button" data-action="copy-compact-context">
        <span class="context-action-label">Compact context</span>
        <span class="context-action-meta">${estimateTokens(buildCompactContext(entry))} tok</span>
      </button>
      <button class="context-action-btn" type="button" data-action="copy-provenance-context">
        <span class="context-action-label">Provenance</span>
        <span class="context-action-meta">${estimateTokens(buildProvenanceContext(entry))} tok</span>
      </button>
      <button class="context-action-btn" type="button" data-action="copy-related-context">
        <span class="context-action-label">Context pack</span>
        <span class="context-action-meta">${estimateTokens(relatedContext)} tok</span>
      </button>
      ${whyMatched ? `
        <button class="context-action-btn context-action-btn--secondary" type="button" data-action="toggle-why-matched">
          <span class="context-action-label">Why this matched</span>
        </button>
        <div class="context-why-matched" hidden>${escapeHtml(whyMatched)}</div>
      ` : ""}
    </div>
  `;
}

export function buildCompactContext(entry: WikiEntryResponse): string {
  const payload = {
    id: entry.frontmatter.id,
    title: entry.frontmatter.title,
    status: entry.frontmatter.status ?? null,
    tags: entry.frontmatter.tags,
    updated: entry.frontmatter.updated,
    summary: summarizeBody(entry.body),
  };
  return JSON.stringify({
    ...payload,
    token_estimate: estimateTokens(JSON.stringify(payload)),
  }, null, 2);
}

export function buildProvenanceContext(entry: WikiEntryResponse): string {
  return [
    `# ${entry.frontmatter.title} (\`${entry.frontmatter.id}\`)`,
    "",
    `- updated: ${entry.frontmatter.updated}`,
    `- status: ${entry.frontmatter.status ?? "unknown"}`,
    `- raw_source_ref: ${entry.frontmatter.rawSourceRef ?? "(none)"}`,
    `- raw_source_refs: ${(entry.frontmatter.rawSourceRefs ?? []).join(", ") || "(none)"}`,
    "",
    "## Summary",
    summarizeBody(entry.body),
  ].join("\n");
}

export function buildRelatedContextPack(
  entry: WikiEntryResponse,
  index: WikiIndexEntry[],
): string {
  const relatedIds = new Set<string>([
    ...(entry.frontmatter.related ?? []),
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function summarizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 240) || "(empty)";
}
