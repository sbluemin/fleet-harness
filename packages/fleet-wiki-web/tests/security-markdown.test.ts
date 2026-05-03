// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../client/src/markdown/renderer";

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

  it("keeps safe external links with noopener noreferrer", () => {
    const rendered = renderMarkdown("[safe](https://example.com)");
    expect(rendered.html).toContain("target=\"_blank\"");
    expect(rendered.html).toContain("rel=\"noopener noreferrer\"");
  });
});
