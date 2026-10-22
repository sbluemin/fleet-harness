import type { MarkdownLinkTarget } from "./link-activation.js";
import { siteIconName, siteIconSvg } from "./site-icons.js";
import { Marked, type Token, type Tokens } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
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
  resolveLink?: (href: string) => MarkdownLinkTarget | null;
  /** 코드블록 Copy 버튼 라벨. 기본값 `"Copy"`. */
  readonly copyLabel?: string;
  /** 코드블록 Copy 버튼 aria-label. 기본값 `(language) => \`Copy ${language} code\``. */
  readonly copyAriaLabel?: (language: string) => string;
  /**
   * 외부 http(s) 링크를 「사이트 아이콘 + 밑줄 이름」 인라인 링크로 그린다(AI 응답 본문 전용).
   * 맨 주소·`<주소>`는 호스트와 줄인 경로로 접고, 원문은 title에 둔다. 아이콘은 번들 글리프뿐이라 네트워크 요청이 없다.
   */
  readonly siteLinks?: boolean;
  /**
   * 스트리밍 중 아직 닫히지 않은 마지막 mermaid 펜스는 다이어그램 자리표시자로 바꾸지 않고 코드 블록으로 둔다.
   * 미완성 원문을 델타마다 렌더하거나 파서 오류를 깜빡이지 않게 한다. 이미 닫힌 펜스는 그대로 자리표시자가 된다.
   */
  readonly deferUnclosedMermaid?: boolean;
  /**
   * `openui-lang`(별칭 `openui`) 펜스를 OpenUI 자리표시자(`.openui-block`)로 감싼다. 안에는 평소의 코드 블록이 그대로 있어
   * 그리지 못하면 그 코드 블록이 폴백이 된다. 그림은 `installOpenUIHydrator`가 그린다. 기본은 꺼짐(지금과 같은 코드 블록)이다.
   * `deferUnclosedMermaid`(흐르는 중)와 함께 켜면 아직 닫히지 않은 마지막 OpenUI 펜스는 미확정(`data-openui-final="0"`)으로 둔다.
   */
  readonly openui?: boolean;
}

/** OpenUI 펜스 언어 — 정식 이름은 업스트림 inline mode 관례인 `openui-lang`, `openui`는 별칭이다. */
const OPENUI_LANGUAGES: ReadonlySet<string> = new Set(["openui-lang", "openui"]);

interface FrontmatterEntry {
  key: string;
  value: string;
}

interface ExtractedFrontmatter {
  entries: FrontmatterEntry[];
  content: string;
}

// 정본: runtime/fleet-plugins/codex/server/wiki/store.ts WIKI_LINK_PATTERN
// 브라우저 번들에 Node 전용 저장 모듈을 포함하지 않도록 인라인한다. 두 정규식을 함께 유지한다.
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
// `src/x.ts:10:9`처럼 콜론 좌표가 붙은 파일 참조는 URL 스킴(`x.ts:`)처럼 보여 기본 허용식에서 지워진다.
// 경로 쪽에 `.`이나 `/`가 있고 콜론 뒤가 숫자 좌표뿐인 형태만 통과시킨다 — 실제 스킴 이름(javascript 등)은
// 점·슬래시가 없으므로 이 갈래로 들어오지 못한다. 호스트가 분류하지 않으면 decorateLinks가 href를 거둔다.
const FILE_COORDINATE_HREF = /^(?=[^:]*[./])[^:]+:\d+(?::\d+)?$/;
// marked가 역슬래시를 %5C로 바꾼 경우도 드라이브 경로다. 다른 스킴의 허용 범위는 늘리지 않는다.
const WINDOWS_DRIVE_HREF = /^[a-z]:(?:[/\\]|%2f|%5c)/i;
const sanitizeConfig = {
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[a-z]:(?:[/\\]|%2f|%5c)|[#/]|\.{0,2}\/|[^:]+$|(?=[^:]*[./])[^:]+:\d+(?::\d+)?$)/i,
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
  }, options.deferUnclosedMermaid === true ? bodyWithWikiLinks : undefined, options.openui === true);
  decorateLinks(document, options.resolveLink, options.siteLinks === true);
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
  deferUnclosedMermaidSource?: string,
  openui = false,
): void {
  const codes = [...document.querySelectorAll("pre > code")];
  // marked가 아직 닫지 않은 마지막 mermaid 펜스만 코드로 남긴다. 앞선 닫힌 펜스는 그대로 그린다.
  let trailingOpenMermaid: Element | null = null;
  if (deferUnclosedMermaidSource !== undefined && trailingFenceOpen(deferUnclosedMermaidSource, isMermaidLanguage)) {
    for (const code of codes) {
      if (languageFromClass(code.className) === "mermaid") trailingOpenMermaid = code;
    }
  }
  // OpenUI는 미완성 원문도 그 자리에서 자라며 그려진다 — 닫히지 않은 마지막 펜스는 자리표시자로 두되 미확정으로 표시한다.
  let trailingOpenOpenUI: Element | null = null;
  if (openui && deferUnclosedMermaidSource !== undefined && trailingFenceOpen(deferUnclosedMermaidSource, isOpenUILanguage)) {
    for (const code of codes) {
      if (OPENUI_LANGUAGES.has(languageFromClass(code.className) ?? "")) trailingOpenOpenUI = code;
    }
  }
  for (const code of codes) {
    const language = languageFromClass(code.className);
    const rawCode = code.textContent ?? "";
    const pre = code.parentElement;
    if (!pre) continue;
    if (language === "mermaid" && code !== trailingOpenMermaid) {
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
    if (openui && language !== null && OPENUI_LANGUAGES.has(language)) {
      // 원문은 base64 속성으로만 싣는다(Mermaid와 같은 이유) — 원문이 HTML로 해석되는 경로는 없다.
      const block = document.createElement("div");
      block.className = "openui-block";
      block.setAttribute("data-openui-source", encodeMermaidSource(rawCode));
      block.setAttribute("data-openui-final", code === trailingOpenOpenUI ? "0" : "1");
      pre.replaceWith(block);
      block.append(pre);
    }
  }
}

function isMermaidLanguage(language: string | undefined): boolean {
  return language?.trim().split(/\s+/)[0]?.toLowerCase() === "mermaid";
}

function isOpenUILanguage(language: string | undefined): boolean {
  return OPENUI_LANGUAGES.has(language?.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
}

/** marked가 낸 마지막 해당 언어 코드 토큰의 raw에 닫는 펜스가 없으면, 스트리밍 중인 미완성 원문이다. */
function trailingFenceOpen(source: string, matches: (language: string | undefined) => boolean): boolean {
  const last = lastFencedCode(marked.lexer(source), matches);
  if (!last) return false;
  return !fenceClosed(last.raw);
}

function lastFencedCode(tokens: readonly Token[], matches: (language: string | undefined) => boolean): Tokens.Code | null {
  let found: Tokens.Code | null = null;
  const visit = (list: readonly Token[] | undefined): void => {
    if (!list) return;
    for (const token of list) {
      if (token.type === "code" && "lang" in token && matches(token.lang)) found = token as Tokens.Code;
      if ("tokens" in token && token.tokens) visit(token.tokens);
      if (token.type === "list") {
        for (const item of token.items) visit(item.tokens);
      }
    }
  };
  visit(tokens);
  return found;
}

function fenceClosed(raw: string): boolean {
  const opening = /^(?: {0,3})(`{3,}|~{3,})/.exec(raw);
  const marker = opening?.[1];
  if (!opening || !marker) return true;
  const closer = new RegExp(`(?:^|\\n) {0,3}\\${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`);
  return closer.test(raw.slice(opening[0].length));
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

function decorateLinks(document: Document, resolveLink: RenderMarkdownOptions["resolveLink"], siteLinks: boolean): void {
  for (const link of document.querySelectorAll("a")) {
    for (const attribute of [...link.attributes]) {
      if (attribute.name.startsWith("data-md-")) link.removeAttribute(attribute.name);
    }
    const href = link.getAttribute("href") ?? "";
    const target = href ? resolveLink?.(href) : null;
    if (target) {
      link.setAttribute("href", "#");
      link.removeAttribute("target");
      link.setAttribute("role", "link");
      link.setAttribute("tabindex", "0");
      link.dataset.mdLinkKind = target.kind;
      for (const [key, value] of Object.entries(target.data)) {
        if (key !== "linkKind" && /^[a-z][a-zA-Z0-9]*$/.test(key)) {
          link.dataset[`md${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value;
        }
      }
      link.dataset.mdLinkData = JSON.stringify(target.data);
      continue;
    }
    if (FILE_COORDINATE_HREF.test(href) || WINDOWS_DRIVE_HREF.test(href)) {
      // 호스트가 분류하지 않은 파일 주소는 브라우저의 낯선 스킴으로 열지 않는다.
      link.removeAttribute("href");
      continue;
    }
    if (isExternalLink(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      if (siteLinks) decorateSiteLink(link, href);
    }
  }
}

// 사이트 링크 — 아이콘은 앞에 선다(흐르는 글의 캐럿이 끝 요소의 ::after를 쓰므로). 주소에서 온 값은 텍스트와 속성으로만
// 들어가고 아이콘 마크업은 번들 문자열이다. 장식 뒤에도 문서 전체가 한 번 더 sanitize를 지난다.
function decorateSiteLink(link: HTMLAnchorElement, href: string): void {
  let url: URL;
  try { url = new URL(href); } catch { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const label = link.textContent ?? "";
  if (isBareAutolink(label, href)) link.textContent = shortLinkLabel(url);
  if (!link.hasAttribute("title")) link.setAttribute("title", safeDecodeUri(href));
  link.classList.add("md-site-link");
  const icon = siteIconSvg(siteIconName(url.hostname));
  // 아이콘은 atomic inline이라 Chromium이 단어 결합자(U+2060)와 무관하게 그 뒤에서 줄을 나눈다. 아이콘과 이름의 첫 글자를
  // nowrap 래퍼 하나에 묶어 아이콘만 윗줄 끝에 남지 않게 한다. 첫 글자만 묶으므로 긴 이름의 줄바꿈은 그대로다.
  // 이름이 강조·코드 등 요소로 시작하면 래퍼는 그 요소 전체를 감싼다 — 아이콘이 코드 상자나 굵은 글자색 안으로 들어가지 않고
  // 링크 잉크를 따른다. 글자가 없으면(이미지 링크) 아이콘만 앞에 둔다.
  const first = firstLabelNode(link);
  const lead = link.ownerDocument.createElement("span");
  lead.className = "md-site-lead";
  lead.insertAdjacentHTML("afterbegin", icon);
  if (first?.nodeType === 3) {
    const text = (first as Text).data;
    const leadLength = /^\s*/.exec(text)![0].length + firstGraphemeLength(text.trimStart());
    lead.append(text.slice(0, leadLength));
    (first as Text).data = text.slice(leadLength);
    first.before(lead);
    return;
  }
  if (first && first.textContent?.trim()) {
    first.before(lead);
    lead.append(first);
    return;
  }
  link.insertAdjacentHTML("afterbegin", icon);
}

// 링크 안에서 글자를 여는 첫 자식 — 공백뿐인 텍스트는 건너뛴다.
function firstLabelNode(link: Element): ChildNode | null {
  for (const node of link.childNodes) {
    if (node.nodeType === 3 && !(node as Text).data.trim()) continue;
    return node;
  }
  return null;
}

function firstGraphemeLength(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next();
    if (!segment.done) return segment.value.segment.length;
  }
  return String.fromCodePoint(text.codePointAt(0) ?? 0).length;
}

// gfm 맨 주소·`<주소>`는 글자가 곧 주소다(www.는 http://가 붙는다, 비ASCII 경로는 href만 인코딩된다).
function isBareAutolink(label: string, href: string): boolean {
  const text = label.trim();
  return text === href || text === safeDecodeUri(href) || `http://${text}` === href;
}

const SHORT_LINK_MAX = 40;
const SHORT_SEGMENT_MAX = 24;

function shortLinkLabel(url: URL): string {
  const host = url.host.replace(/^www\./i, "");
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => safeDecodeComponent(segment));
  if (segments.length === 0) return host;
  const full = `${host}/${segments.join("/")}`;
  if (full.length <= SHORT_LINK_MAX) return full;
  const last = segments[segments.length - 1]!;
  const tail = last.length > SHORT_SEGMENT_MAX ? `${last.slice(0, SHORT_SEGMENT_MAX - 1)}…` : last;
  return segments.length === 1 ? `${host}/${tail}` : `${host}/…/${tail}`;
}

function safeDecodeUri(value: string): string {
  try { return decodeURI(value); } catch { return value; }
}

function safeDecodeComponent(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function extractToc(document: Document): TocItem[] {
  return [...document.querySelectorAll("h2, h3")].map((heading) => ({
    id: heading.id,
    text: heading.textContent?.trim() ?? heading.id,
    level: heading.tagName.toLowerCase() === "h2" ? 2 : 3,
  }));
}

/** 상한 있는 코드 발췌에도 Markdown의 언어 등록부와 정화된 강조 팔레트를 재사용한다. */
export function highlightCodeSnippet(code: string, language: string | null): string {
  if (!language || !highlighter.getLanguage(language)) return escapeHtml(code);
  return DOMPurify.sanitize(highlighter.highlight(code, { language }).value, { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] });
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
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("xml", xml);
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

/** 헤딩 ID 슬러그 — decorateHeadings와 diff 재배정(reading-controller)이 같은 규칙을 공유한다. */
export function slugifyHeading(value: string): string {
  return slugify(value);
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
