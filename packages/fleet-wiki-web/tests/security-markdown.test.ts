// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { decodeMermaidSource, renderMarkdown } from "../client/src/markdown/renderer";

describe("security markdown", () => {
  it("renders canonical wiki links as internal SPA anchors", () => {
    const rendered = renderMarkdown("See [[wiki:alpha]].");
    expect(rendered.html).toContain("href=\"/entry/alpha\"");
    expect(rendered.html).toContain("data-entry-id=\"alpha\"");
    expect(rendered.html).not.toContain("[[wiki:alpha]]");
  });

  it("removes script tags and event handlers", () => {
    const rendered = renderMarkdown("<script>alert(1)</script><img src=\"x\" onerror=\"alert(1)\">");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).not.toContain("onerror");
    expect(rendered.html).toContain("<img");
  });

  it("removes javascript links", () => {
    const rendered = renderMarkdown("[bad](javascript:alert(1)) [ok](alpha.md)");
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).toContain("href=\"alpha.md\"");
  });

  it("removes data links", () => {
    const rendered = renderMarkdown("[bad](data:text/html;base64,SGVsbG8=)");
    expect(rendered.html).not.toContain("data:text/html");
  });

  it("keeps safe external links with noopener noreferrer", () => {
    const rendered = renderMarkdown("[safe](https://example.com)");
    expect(rendered.html).toContain("target=\"_blank\"");
    expect(rendered.html).toContain("rel=\"noopener noreferrer\"");
  });

  it("escapes attribute-breaking ids in canonical wiki links", () => {
    const rendered = renderMarkdown("See [[wiki:alpha\\\"<tag>]].");
    expect(rendered.html).toContain("data-entry-id=\"alpha%5C%22%3Ctag%3E\"");
    expect(rendered.html).not.toContain("data-entry-id=\"alpha\\&quot;<tag>\"");
  });

  it("emits inert .diagram-block placeholders for mermaid fences", () => {
    const rendered = renderMarkdown("```mermaid\ngraph TD\nA[문서 수집] --> B[검증 완료]\n```");
    expect(rendered.html).toContain("class=\"diagram-block\"");
    expect(rendered.html).toContain("data-mermaid-source=");
    expect(rendered.html).toContain("data-diagram-state=\"pending\"");
    expect(rendered.html).not.toContain("code-block");
    expect(rendered.html).not.toContain("hljs");
    expect(rendered.html).not.toContain("language-mermaid");
    const fragment = document.createElement("div");
    fragment.innerHTML = rendered.html;
    const diagram = fragment.querySelector(".diagram-block");
    const source = decodeMermaidSource(diagram?.getAttribute("data-mermaid-source") ?? "");
    expect(source).toContain("문서 수집");
    expect(source).toContain("검증 완료");
    expect(source).toContain("-->");
  });

  it("keeps code-block markup for non-mermaid fences", () => {
    const rendered = renderMarkdown("```js\nconst a = 1;\n```");
    expect(rendered.html).toContain("code-block");
    expect(rendered.html).not.toContain("diagram-block");
  });

  it("keeps mermaid payload inert and escaped in the data attribute", () => {
    const rendered = renderMarkdown("```mermaid\n<script>alert(1)</script>\nclick A onclick=\"alert(1)\"\n```");
    const fragment = document.createElement("div");
    fragment.innerHTML = rendered.html;
    const diagram = fragment.querySelector(".diagram-block");
    expect(diagram).not.toBeNull();
    expect(fragment.querySelector("script")).toBeNull();
    const outer = diagram?.outerHTML ?? "";
    expect(outer).not.toMatch(/<script[\s>]/i);
    expect(outer).not.toMatch(/\sonclick=/i);
    expect(outer).not.toContain("alert(1)");
    const decoded = decodeMermaidSource(diagram?.getAttribute("data-mermaid-source") ?? "");
    expect(decoded).toContain("<script>alert(1)</script>");
    expect(decoded).toContain("onclick=");
  });
});
