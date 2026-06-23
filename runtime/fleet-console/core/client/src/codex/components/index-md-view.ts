import { renderMarkdown } from "../markdown/renderer";

export function renderIndexMarkdownView(markdown: string): string {
  const rendered = renderMarkdown(markdown);
  return `
    <article class="document">
      <header class="document-header">
        <p class="eyebrow">MANIFEST · CODEX</p>
        <h1>Index</h1>
      </header>
      <div class="markdown-body">${rendered.html}</div>
    </article>
  `;
}
