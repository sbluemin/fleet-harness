// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { findAccessibilityViolations, formatAccessibilityViolations } from "./helpers/accessibility-rules.js";

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * 이 규칙들은 실제로 출하됐던 결함에서 왔다. 각 케이스의 "before"는 리포지토리에 있던 구조 그대로다.
 */
describe("accessibility rules", () => {
  it("catches an activation target that holds more activation targets", () => {
    // 사이드바의 Theater 행과 Skills 피드백 도크가 정확히 이 모양이었다.
    const document = render(`
      <div role="button" tabindex="0">
        <span>Theater</span>
        <span role="group"><button type="button">Sort</button></span>
      </div>
    `);
    const violations = findAccessibilityViolations(document);
    expect(violations.map((violation) => violation.rule)).toContain("nested-interactive");
    expect(formatAccessibilityViolations(violations)).toContain("nested-interactive");
  });

  it("passes the same row once activation moves to a sibling button", () => {
    const document = render(`
      <div>
        <button type="button" class="side-bar-theater-activate"><span>Theater</span></button>
        <span role="group"><button type="button">Sort</button></span>
      </div>
    `);
    expect(findAccessibilityViolations(document)).toEqual([]);
  });

  it("catches a dialog that an aria-hidden backdrop removes from the tree", () => {
    // Skills의 SKILL.md 오버레이가 이 구조였다 — 닫기·복사 버튼까지 함께 사라졌다.
    const document = render(`
      <div class="skills-overlay-backdrop" aria-hidden="true">
        <div role="dialog" aria-modal="true"><button type="button">Close</button></div>
      </div>
    `);
    const rules = findAccessibilityViolations(document).map((violation) => violation.rule);
    expect(rules).toContain("hidden-from-assistive-tech");
  });

  it("passes once the backdrop stops hiding its own contents", () => {
    const document = render(`
      <div class="skills-overlay-backdrop">
        <div role="dialog" aria-modal="true"><button type="button">Close</button></div>
      </div>
    `);
    expect(findAccessibilityViolations(document)).toEqual([]);
  });

  it("catches a tab that announces selection with nothing attached", () => {
    const document = render(`
      <div role="tablist"><button role="tab" aria-selected="true">Installed</button></div>
      <div>content</div>
    `);
    expect(findAccessibilityViolations(document).map((violation) => violation.rule)).toContain("tab-without-panel");
  });

  it("catches a tab that points at a panel which is not there", () => {
    const document = render(`
      <div role="tablist"><button role="tab" aria-controls="gone">Installed</button></div>
    `);
    expect(findAccessibilityViolations(document)[0]?.detail).toContain("missing panel #gone");
  });

  it("passes a tab wired to its panel", () => {
    const document = render(`
      <div role="tablist"><button role="tab" id="t1" aria-controls="p1">Installed</button></div>
      <div role="tabpanel" id="p1" aria-labelledby="t1">content</div>
    `);
    expect(findAccessibilityViolations(document)).toEqual([]);
  });
});
