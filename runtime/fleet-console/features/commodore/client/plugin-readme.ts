import { decodeMermaidSource, renderMarkdown } from "@fleet-console/markdown/core";

/**
 * 플러그인 README 정화. 공유 markdown 렌더러는 채팅 등에서 `<style>` 을 허용하므로, 신뢰할 수 없는 README 만 여기서 한 번 더 거른다.
 * 문서 밖으로 새는 요소·속성은 빼고, 코드 하이라이트 class 만 남긴다.
 */

/** http(s) 만. 사용자·비밀번호가 섞인 주소와 상대 경로는 거절한다. */
export function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** 내용까지 버린다 — CSS·스크립트·문서 머리·미디어 플레이어·폼 컨트롤. */
const DROP = new Set([
  "style", "script", "link", "meta", "base", "title", "head", "html",
  "iframe", "object", "embed", "svg", "math", "noscript", "template",
  "button", "input", "textarea", "select", "option", "optgroup", "datalist",
  "output", "progress", "meter", "canvas", "video", "audio", "source", "track",
  "frame", "frameset", "applet", "marquee", "portal", "dialog", "slot",
]);

/** 이 밖은 태그만 벗기고 자식은 남긴다(form·label 안의 글). */
const ALLOWED = new Set([
  "a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code", "span", "div",
  "strong", "em", "b", "i", "del", "s", "ins", "mark", "sub", "sup",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "img",
  "dl", "dt", "dd", "kbd", "samp", "var", "abbr", "cite", "q", "small", "wbr",
  "details", "summary", "figure", "figcaption", "section",
]);

/** 하이라이트·코드 블록만. Console 레이아웃 class 는 남기지 않는다. */
const CLASS_OK = /^(?:hljs(?:-[a-z0-9_-]+)?|language-[a-z0-9_-]+|code-block(?:-toolbar|-dots|-language)?|copy-code|frontmatter)$/;

function scrubAttributes(element: Element): void {
  const tag = element.tagName.toLowerCase();
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name === "class") {
      const kept = attribute.value.split(/\s+/).filter((token) => CLASS_OK.test(token));
      if (kept.length) element.setAttribute("class", kept.join(" "));
      else element.removeAttribute(attribute.name);
      continue;
    }
    const keep = (tag === "a" && (name === "href" || name === "title"))
      || (tag === "img" && (name === "src" || name === "alt"))
      || ((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan"))
      || (tag === "ol" && name === "start");
    if (!keep) element.removeAttribute(attribute.name);
  }
}

function visit(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  for (const child of [...element.childNodes]) visit(child);
  const tag = element.tagName.toLowerCase();
  if (DROP.has(tag)) { element.remove(); return; }
  if (!ALLOWED.has(tag)) { element.replaceWith(...element.childNodes); return; }
  scrubAttributes(element);
  if (tag === "a") {
    const href = httpUrl(element.getAttribute("href") ?? "");
    if (!href) { element.replaceWith(...element.childNodes); return; }
    element.setAttribute("href", href);
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noopener noreferrer");
  }
  if (tag === "img") {
    const src = httpUrl(element.getAttribute("src") ?? "");
    if (!src) { element.remove(); return; }
    element.setAttribute("src", src);
  }
}

/** 렌더된 README 를 플러그인 상자 안에 가둔다. mermaid·OpenUI 는 실행하지 않고 코드로만 남긴다. */
export function pluginReadmeHtml(markdown: string): string {
  const doc = new DOMParser().parseFromString(renderMarkdown(markdown).html, "text/html");
  for (const block of [...doc.querySelectorAll(".diagram-block, .openui-block")]) {
    const encoded = block.getAttribute("data-mermaid-source") ?? block.getAttribute("data-openui-source");
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    try { code.textContent = encoded ? decodeMermaidSource(encoded) : ""; } catch { code.textContent = ""; }
    pre.append(code);
    block.replaceWith(pre);
  }
  for (const child of [...doc.body.childNodes]) visit(child);
  return doc.body.innerHTML;
}
