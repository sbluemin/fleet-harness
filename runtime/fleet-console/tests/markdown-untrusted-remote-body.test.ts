// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "@fleet-console/markdown/core";

/**
 * 개발자 노트는 원격에서 저작되는 본문이라 두 제약을 렌더 단계에서 강제해야 한다.
 * 두 제약은 서로 다른 곳에서 온다 — 이미지는 콘솔 CSP의 `img-src`가, 상대 링크는 마크다운
 * 허용 URI 정규식이 만든다. 어느 쪽도 마크다운 문법만 봐서는 드러나지 않는다.
 */
function render(body: string): string {
  return renderMarkdown(body, { untrustedRemoteBody: true, blockedImageLabel: "Image omitted" }).html;
}

describe("untrusted remote markdown body", () => {
  it("replaces an image with a labelled placeholder", () => {
    // CSP가 로드를 막으므로 그냥 두면 테두리만 남은 깨진 이미지가 된다.
    const html = render("![diagram](https://user-images.githubusercontent.com/1/a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("markdown-blocked-image");
    expect(html).toContain("Image omitted");
  });

  it("strips a root-relative link so it cannot navigate inside the console", () => {
    const html = render("[settings](/settings)");
    expect(html).not.toContain("<a");
    expect(html).toContain("settings");
  });

  it("strips a schemeless link", () => {
    const html = render("[here](console/operations)");
    expect(html).not.toContain("<a");
    expect(html).toContain("here");
  });

  it("keeps an absolute https link", () => {
    const html = render("[status](https://example.com/status)");
    expect(html).toContain('href="https://example.com/status"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("strips an http link", () => {
    expect(render("[insecure](http://example.com)")).not.toContain("<a");
  });

  it("leaves ordinary markdown structure intact", () => {
    const html = render("## Scope\n\n- one\n- two\n\n> quoted");
    expect(html).toContain("<h2");
    expect(html).toContain("<li>");
    expect(html).toContain("<blockquote>");
  });

  it("keeps a mermaid fence as readable code instead of a pending diagram", () => {
    // hydrator를 설치하지 않는 표면에서 mermaid 변환은 소스를 data 속성에 감춘 빈 pending
    // 상자만 남긴다 — 노트에서는 내용이 통째로 사라지는 것과 같다.
    const html = render("```mermaid\ngraph TD;\nA-->B;\n```");
    expect(html).not.toContain("diagram-block");
    expect(html).not.toContain("data-diagram-state");
    expect(html).toContain("graph TD");
  });

  it("still converts a mermaid fence when the option is off", () => {
    const html = renderMarkdown("```mermaid\ngraph TD;\nA-->B;\n```").html;
    expect(html).toContain("diagram-block");
  });

  it("leaves images and relative links alone when the option is off", () => {
    const html = renderMarkdown("![x](https://example.com/a.png)\n\n[y](/settings)").html;
    expect(html).toContain("<img");
    expect(html).toContain("<a");
  });
});
