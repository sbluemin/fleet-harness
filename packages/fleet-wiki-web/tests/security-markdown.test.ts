// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../client/src/markdown/renderer";

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
});
