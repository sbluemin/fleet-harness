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
});
