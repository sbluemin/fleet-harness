import { renderMarkdown } from "../markdown/renderer";
import { logPath } from "../router";
import type { LogResponse } from "../api";
import { t } from "../i18n/t";

export function renderLogView(log: LogResponse): string {
  const markdown = log.entries.join("\n\n");
  const rendered = renderMarkdown(markdown);
  const limits = [10, 20, 50, 100];
  return `
    <article class="document">
      <header class="document-header">
        <p class="eyebrow">MANIFEST · DRYDOCK</p>
        <h1>${t("log.title")}</h1>
        <div class="log-controls">
          ${limits.map((limit) => `
            <a class="chip ${limit === log.limit ? "chip-tag" : ""}" href="${logPath(limit)}">${limit}</a>
          `).join("")}
        </div>
      </header>
      <p class="empty-state">${t("log.summary", { total: log.totalEntries, limit: log.limit })}</p>
      <div class="markdown-body">${rendered.html}</div>
    </article>
  `;
}
