// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { decodeMermaidSource, renderMarkdown } from "@fleet-console/markdown/core";

const resolveWikiLink = (id: string): string => `/entry/${encodeURIComponent(id)}`;

describe("security markdown", () => {

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
});
