// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { decorateEvidenceHtml } from "./analysis-evidence.js";

describe("evidence citation decoration", () => {
  it("wraps prose [eN] tokens as data-carrying buttons and leaves code and links alone", () => {
    const html = '<p>Backoff added [e1][e2].</p><pre><code>const x = "[e3]";</code></pre><a href="#">[e4]</a>';
    const out = decorateEvidenceHtml(html, "cited");
    const doc = new DOMParser().parseFromString(out, "text/html");
    const chips = [...doc.querySelectorAll("button.session-analyst__ev")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["e1", "e2"]);
    expect(chips.map((chip) => chip.getAttribute("data-analysis-evidence"))).toEqual(["e1", "e2"]);
    expect(chips.every((chip) => (chip as HTMLButtonElement).type === "button" && chip.getAttribute("title") === "cited")).toBe(true);
    expect(doc.querySelector("code")?.textContent).toBe('const x = "[e3]";');
    expect(doc.querySelector("a")?.textContent).toBe("[e4]");
  });

  it("returns the input untouched when no token exists", () => {
    expect(decorateEvidenceHtml("<p>plain</p>", "t")).toBe("<p>plain</p>");
  });

  it("promotes intact cite elements and escaped cite residue to the same evidence chips", () => {
    // 온전한 <cite>는 DOMPurify 기본 허용목록을 통과해 요소로 살아남고, 깨진 형태는
    // 텍스트 잔해로 남는다 — 두 경로 모두 같은 칩으로 승격되어야 한다(2026-09-01 라이브 실측).
    const html = "<p>Started from the request <cite>e1</cite> and confirmed the build <em>e12&lt;/cite&gt;</em>.</p><pre><cite>e9</cite></pre>";
    const out = decorateEvidenceHtml(html, "cited");
    const doc = new DOMParser().parseFromString(out, "text/html");
    const chips = [...doc.querySelectorAll("button.session-analyst__ev")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["e1", "e12"]);
    expect(chips.map((chip) => chip.getAttribute("data-analysis-evidence"))).toEqual(["e1", "e12"]);
    // 코드 블록 안의 cite는 저작물 본문이므로 그대로 남는다.
    expect(doc.querySelector("pre cite")?.textContent).toBe("e9");
    // 이스케이프된 잔해 원문은 더 이상 텍스트로 노출되지 않는다.
    expect(out).not.toContain("&lt;/cite&gt;");
    expect(doc.querySelector("em")?.textContent).toBe("e12");
  });

  it("leaves non-reference cite elements as authored", () => {
    const html = "<p>See <cite>The Art of Computer Programming</cite> for context.</p>";
    expect(decorateEvidenceHtml(html, "t")).toContain("<cite>The Art of Computer Programming</cite>");
  });

  it("decorates inputs that carry only escaped cite residue", () => {
    // 온전한 <cite>나 [eN]이 하나도 없어도 사전 프로브가 이스케이프 잔해를 잡아야 한다 —
    // 다른 트리거가 프로브를 대신 만족시켜 주는 우연에 기대면 이 입력은 원문으로 샌다.
    const out = decorateEvidenceHtml("<p><em>e12&lt;/cite&gt;</em> and &lt;cite&gt;e14&lt;/cite&gt;</p>", "cited");
    const doc = new DOMParser().parseFromString(out, "text/html");
    const chips = [...doc.querySelectorAll("button.session-analyst__ev")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["e12", "e14"]);
    expect(out).not.toContain("&lt;/cite&gt;");
  });
});
