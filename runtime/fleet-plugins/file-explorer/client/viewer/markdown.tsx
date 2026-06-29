import { useMemo } from "react";

interface MarkdownViewerProps {
  readonly content: string;
  readonly truncated?: boolean;
}

export function MarkdownViewer({ content, truncated }: MarkdownViewerProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div className="fexp-md-wrap">
      {truncated && <div className="fexp-truncated-badge">File is too large — showing a partial preview</div>}
      <div
        className="fexp-md-body v-md"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 펜스 코드 블록
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        codeLines.push(escapeHtml(lines[i]!));
        i++;
      }
      const langAttr = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
      out.push(`<pre class="fexp-md-pre"><code${langAttr}>${codeLines.join("\n")}</code></pre>`);
      i++;
      continue;
    }

    // 제목
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      out.push(`<h${level} class="fexp-md-h${level}">${inlineMarkdown(headingMatch[2]!)}</h${level}>`);
      i++;
      continue;
    }

    // 수평선
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      out.push(`<hr class="fexp-md-hr" />`);
      i++;
      continue;
    }

    // 비순서 목록
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^(\s*)[-*+]\s+(.*)/)) {
        const m = lines[i]!.match(/^(\s*)[-*+]\s+(.*)/)!;
        items.push(`<li>${inlineMarkdown(m[2]!)}</li>`);
        i++;
      }
      out.push(`<ul class="fexp-md-ul">${items.join("")}</ul>`);
      continue;
    }

    // 순서 목록
    const olMatch = line.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.match(/^\d+\.\s+(.*)/)) {
        const m = lines[i]!.match(/^\d+\.\s+(.*)/)!;
        items.push(`<li>${inlineMarkdown(m[1]!)}</li>`);
        i++;
      }
      out.push(`<ol class="fexp-md-ol">${items.join("")}</ol>`);
      continue;
    }

    // 인용
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        quoteLines.push(lines[i]!.slice(1).trim());
        i++;
      }
      out.push(`<blockquote class="fexp-md-bq"><p>${inlineMarkdown(quoteLines.join(" "))}</p></blockquote>`);
      continue;
    }

    // 빈 줄
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 단락
    const paraLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("#") && !lines[i]!.startsWith("```") && !lines[i]!.startsWith(">")) {
      paraLines.push(lines[i]!);
      i++;
    }
    if (paraLines.length > 0) {
      out.push(`<p class="fexp-md-p">${inlineMarkdown(paraLines.join(" "))}</p>`);
    }
  }

  return out.join("\n");
}

function inlineMarkdown(text: string): string {
  // 먼저 HTML escape
  let result = escapeHtml(text);
  // 코드 인라인 (`code`)
  result = result.replace(/`([^`]+)`/g, (_, code) => `<code class="fexp-md-code">${code}</code>`);
  // 굵게 (**bold**)
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, b) => `<strong>${b}</strong>`);
  // 기울임 (*italic*)
  result = result.replace(/\*([^*]+)\*/g, (_, e) => `<em>${e}</em>`);
  // 링크 [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<span class="fexp-md-link">${t}</span>`);
  return result;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
