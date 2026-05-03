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

const marked = new Marked({
  gfm: true,
  breaks: false,
});
const sanitizeConfig = {
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[#/]|\.{0,2}\/|[^:]+$)/i,
  ADD_ATTR: ["target", "rel"],
};
const highlighter = configureHighlighter();

export function renderMarkdown(body: string): RenderedMarkdown {
  const rawHtml = marked.parse(body, { async: false }) as string;
  const safeHtml = DOMPurify.sanitize(rawHtml, sanitizeConfig);
  const document = new DOMParser().parseFromString(safeHtml, "text/html");
  decorateHeadings(document);
  decorateCodeBlocks(document);
  decorateLinks(document);
  const html = DOMPurify.sanitize(document.body.innerHTML, sanitizeConfig);
  return {
    html,
    toc: extractToc(document),
  };
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

function decorateCodeBlocks(document: Document): void {
  for (const code of document.querySelectorAll("pre > code")) {
    const language = languageFromClass(code.className);
    const rawCode = code.textContent ?? "";
    const highlighted = highlightCode(rawCode, language);
    code.innerHTML = highlighted;
    code.classList.add("hljs");
    const pre = code.parentElement;
    if (!pre) continue;
    pre.classList.add("code-block");
    pre.dataset.code = rawCode;
    pre.insertBefore(buildCodeToolbar(document, language || "text"), pre.firstChild);
  }
}

function buildCodeToolbar(document: Document, label: string): HTMLElement {
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
  button.textContent = "복사";
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
