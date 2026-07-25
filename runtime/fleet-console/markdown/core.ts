import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface RenderedMarkdown {
  html: string;
  toc: TocItem[];
}

export interface RenderMarkdownOptions {
  omitDuplicateTitle?: string;
  resolveWikiLink?: (id: string) => string | null;
  /** 코드블록 Copy 버튼 라벨. 기본값 `"Copy"`. */
  readonly copyLabel?: string;
  /** 코드블록 Copy 버튼 aria-label. 기본값 `(language) => \`Copy ${language} code\``. */
  readonly copyAriaLabel?: (language: string) => string;
}

interface FrontmatterEntry {
  key: string;
  value: string;
}

interface ExtractedFrontmatter {
  entries: FrontmatterEntry[];
  content: string;
}

// SSoT: packages/fleet-wiki/src/links.ts WIKI_LINK_PATTERN
// Inlined here because the client (Vite SPA) bundle cannot transitively pull
// fleet-wiki's Node-only modules (fs/path/crypto). Keep these two regexes in sync.
const WIKI_LINK_PATTERN = /\[\[wiki:([^\]]+)\]\]/g;

// Leading YAML frontmatter fence: `---` on the first line through a closing
// `---`. Without this, marked treats the closing `---` as a setext heading
// underline and folds the whole block into one <h2>. We strip it and render a
// dedicated metadata card instead. BOM-tolerant; CRLF-tolerant.
const FRONTMATTER_PATTERN = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
// A top-level `key: value` line inside the frontmatter block. Indented lines
// and list items (`- item`) are folded into the previous entry's value.
const FRONTMATTER_ENTRY_PATTERN = /^(\S[^:]*?):[ \t]*(.*)$/;

const marked = new Marked({
  gfm: true,
  breaks: false,
});
const sanitizeConfig = {
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[#/]|\.{0,2}\/|[^:]+$)/i,
  ADD_ATTR: ["target", "rel", "data-entry-id"],
};
const highlighter = configureHighlighter();

export function renderMarkdown(body: string, options: RenderMarkdownOptions = {}): RenderedMarkdown {
  const { entries, content } = extractFrontmatter(body);
  const bodyWithWikiLinks = renderWikiLinks(content, options.resolveWikiLink);
  const rawHtml = marked.parse(bodyWithWikiLinks, { async: false }) as string;
  const frontmatterHtml = renderFrontmatterCard(entries);
  const safeHtml = DOMPurify.sanitize(frontmatterHtml + rawHtml, sanitizeConfig);
  const document = new DOMParser().parseFromString(safeHtml, "text/html");
  removeDuplicateTitleHeading(document, options.omitDuplicateTitle);
  decorateHeadings(document);
  decorateCodeBlocks(document, {
    copyLabel: options.copyLabel ?? "Copy",
    copyAriaLabel: options.copyAriaLabel ?? ((language) => `Copy ${language} code`),
  });
  decorateLinks(document);
  const html = DOMPurify.sanitize(document.body.innerHTML, sanitizeConfig);
  return {
    html,
    toc: extractToc(document),
  };
}

export function encodeMermaidSource(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeMermaidSource(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function extractFrontmatter(body: string): ExtractedFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(body);
  if (!match) return { entries: [], content: body };
  const entries = parseFrontmatterEntries(match[1] ?? "");
  return { entries, content: body.slice(match[0].length) };
}

function parseFrontmatterEntries(block: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const entryMatch = FRONTMATTER_ENTRY_PATTERN.exec(line);
    if (entryMatch) {
      const [, key = "", value = ""] = entryMatch;
      entries.push({ key: key.trim(), value: value.trim() });
      continue;
    }
    // Indented continuation or list item: fold into the previous entry's value.
    const previous = entries[entries.length - 1];
    if (!previous) continue;
    const folded = line.trim();
    previous.value = previous.value ? `${previous.value} ${folded}` : folded;
  }
  return entries;
}

function renderFrontmatterCard(entries: FrontmatterEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map((entry) => `<dt>${escapeHtml(entry.key)}</dt><dd>${escapeHtml(entry.value)}</dd>`)
    .join("");
  return `<dl class="frontmatter">${rows}</dl>`;
}

function renderWikiLinks(body: string, resolveWikiLink?: (id: string) => string | null): string {
  return body.replace(WIKI_LINK_PATTERN, (_match, rawId: string) => {
    const id = rawId.trim();
    if (!id) return "";
    if (!resolveWikiLink) return escapeHtml(`[[wiki:${id}]]`);
    const href = resolveWikiLink(id);
    if (href === null) return escapeHtml(`[[wiki:${id}]]`);
    const label = escapeHtml(id);
    const encodedId = encodeURIComponent(id);
    return `<a href="${href}" data-entry-id="${encodedId}">${label}</a>`;
  });
}

function decorateHeadings(document: Document): void {
  const usedIds = new Map<string, number>();
  for (const heading of document.querySelectorAll("h2, h3")) {
    const text = heading.textContent?.trim() ?? "";
    const baseId = slugify(text || "section");
    const count = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, count + 1);
    heading.id = count === 0 ? baseId : `${baseId}-${count + 1}`;
  }
}

function removeDuplicateTitleHeading(document: Document, title: string | undefined): void {
  if (!title) return;
  const firstHeading = document.body.querySelector("h1, h2, h3, h4, h5, h6");
  if (!firstHeading || firstHeading.tagName.toLowerCase() !== "h1") return;
  if (normalizeHeadingText(firstHeading.textContent ?? "") !== normalizeHeadingText(title)) return;
  firstHeading.remove();
}

function decorateCodeBlocks(
  document: Document,
  labels: { readonly copyLabel: string; readonly copyAriaLabel: (language: string) => string },
): void {
  for (const code of document.querySelectorAll("pre > code")) {
    const language = languageFromClass(code.className);
    const rawCode = code.textContent ?? "";
    const pre = code.parentElement;
    if (!pre) continue;
    if (language === "mermaid") {
      const placeholder = document.createElement("div");
      placeholder.className = "diagram-block";
      // Base64-encode so DOMPurify does not strip the attribute when the
      // Mermaid source contains characters it treats as HTML-injection
      // markers (e.g. "-->" in flowchart edges).
      placeholder.setAttribute("data-mermaid-source", encodeMermaidSource(rawCode));
      placeholder.setAttribute("data-diagram-state", "pending");
      pre.replaceWith(placeholder);
      continue;
    }
    const highlighted = highlightCode(rawCode, language);
    code.innerHTML = highlighted;
    code.classList.add("hljs");
    pre.classList.add("code-block");
    pre.dataset.code = rawCode;
    pre.insertBefore(buildCodeToolbar(document, language || "text", labels), pre.firstChild);
  }
}

function buildCodeToolbar(
  document: Document,
  label: string,
  labels: { readonly copyLabel: string; readonly copyAriaLabel: (language: string) => string },
): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "code-block-toolbar";
  const dots = document.createElement("span");
  dots.className = "code-block-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index++) {
    dots.append(document.createElement("span"));
  }
  const lang = document.createElement("span");
  lang.className = "code-block-language";
  lang.textContent = label;
  const button = document.createElement("button");
  button.className = "copy-code";
  button.type = "button";
  button.dataset.action = "copy-code";
  button.setAttribute("aria-label", labels.copyAriaLabel(label));
  button.textContent = labels.copyLabel;
  toolbar.append(dots, lang, button);
  return toolbar;
}

function decorateLinks(document: Document): void {
  for (const link of document.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (isExternalLink(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
}

function extractToc(document: Document): TocItem[] {
  return [...document.querySelectorAll("h2, h3")].map((heading) => ({
    id: heading.id,
    text: heading.textContent?.trim() ?? heading.id,
    level: heading.tagName.toLowerCase() === "h2" ? 2 : 3,
  }));
}

function highlightCode(code: string, language: string | null): string {
  if (language && highlighter.getLanguage(language)) {
    return highlighter.highlight(code, { language }).value;
  }
  return highlighter.highlightAuto(code).value;
}

function configureHighlighter(): typeof hljs {
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("md", markdown);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("ts", typescript);
  return hljs;
}

function languageFromClass(className: string): string | null {
  const match = className.match(/language-([a-z0-9_-]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function isExternalLink(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(window.location.origin);
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function normalizeHeadingText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
