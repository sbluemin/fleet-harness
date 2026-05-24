import { renderMarkdown } from "../markdown/renderer";
import { t } from "../i18n/t";

export function renderIndexMarkdownView(markdown: string): string {
  const rendered = renderMarkdown(markdown);
  return `
    <article class="document">
      <header class="document-header">
        <p class="eyebrow">MANIFEST · CODEX</p>
        <h1>${t("indexMd.title")}</h1>
      </header>
      <div class="markdown-body">${rendered.html}</div>
    </article>
  `;
}
