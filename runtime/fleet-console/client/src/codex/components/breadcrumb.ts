import type { WikiEntryResponse, WikiIndexEntry } from "../api";
import { homePath, indexMdPath } from "../router";
import { escapeAttribute, escapeHtml } from "../utils/html";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function renderBreadcrumb(entry: WikiEntryResponse, index: WikiIndexEntry[]): string {
  const items = buildBreadcrumbItems(entry, index);
  return `
    <nav class="breadcrumb" aria-label="Entry location">
      <ol>
        ${items.map((item, index_) => `
          <li>
            ${item.href ? `<a href="${escapeAttribute(item.href)}">${escapeHtml(item.label)}</a>` : `<span aria-current="${index_ === items.length - 1 ? "page" : "false"}">${escapeHtml(item.label)}</span>`}
          </li>
        `).join("")}
      </ol>
    </nav>
  `;
}

function buildBreadcrumbItems(entry: WikiEntryResponse, index: WikiIndexEntry[]): BreadcrumbItem[] {
  const indexedEntry = index.find((item) => item.id === entry.frontmatter.id);
  const primaryTag = entry.frontmatter.tags[0] ?? indexedEntry?.tags[0] ?? null;
  const items: BreadcrumbItem[] = [
    { label: "Codex", href: homePath() },
    { label: "Index", href: indexMdPath() },
  ];
  if (primaryTag) {
    items.push({ label: primaryTag });
  }
  items.push({ label: entry.frontmatter.title });
  return items;
}
