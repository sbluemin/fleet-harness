import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

const css = await fs.readFile(new URL("../client/repository.css", import.meta.url), "utf8");

interface CssRule {
  readonly selectors: readonly string[];
  readonly body: string;
}

// 주석 제거 후 중괄호 깊이를 추적하며 (셀렉터 목록, 본문) 쌍을 수집한다.
// at-rule(@media/@container) prelude는 규칙이 아니므로 건너뛰고 내부 규칙만 취한다.
function parseRules(source: string): readonly CssRule[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let buffer = "";
  let index = 0;
  while (index < stripped.length) {
    const ch = stripped[index]!;
    if (ch === "{") {
      const prelude = buffer.trim();
      buffer = "";
      if (prelude.startsWith("@")) {
        index += 1;
        continue;
      }
      const end = stripped.indexOf("}", index + 1);
      if (end < 0) throw new Error(`Unclosed CSS block after: ${prelude}`);
      rules.push({
        selectors: prelude.split(",").map((selector) => selector.replace(/\s+/g, " ").trim()),
        body: stripped.slice(index + 1, end),
      });
      index = end + 1;
      continue;
    }
    if (ch === "}") {
      buffer = "";
      index += 1;
      continue;
    }
    buffer += ch;
    index += 1;
  }
  return rules;
}

const rules = parseRules(css);

// 정확 매칭: 부분 문자열이 아니라 셀렉터 목록에 동일 문자열이 있어야 한다
// (.history-badge--tag:hover 같은 이웃 규칙 오인 방지).
function blocksOf(selector: string): readonly string[] {
  const matched = rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body);
  if (matched.length === 0) throw new Error(`Missing CSS rule for selector: ${selector}`);
  return matched;
}

function blockOf(selector: string): string {
  return blocksOf(selector)[0]!;
}

describe("Repository design grammar", () => {
  it("reserves brass for location while selections use neutral ink", () => {
    expect(blockOf(".repository-ref-row.is-current")).toContain("var(--text-primary)");
    expect(blockOf(".repository-ref-row.is-current")).not.toContain("var(--brass)");
    expect(blockOf(".repository-ref-row.is-current:hover")).not.toContain("var(--brass)");
    expect(blockOf(".repository-ref-row.is-current .repository-ref-sub")).toContain("var(--brass)");

    const selectedFile = blockOf(".repository-file-row.is-cur");
    expect(selectedFile).toContain("color-mix(in oklch, var(--ink-fog) 12%, transparent)");
    expect(selectedFile).toContain("inset 2px 0 0 var(--brass)");
    expect(blockOf(".repository-file-row.is-cur .repository-file-fn")).toContain("var(--text-primary)");

    const selectedCommit = blockOf(".history-commit-row.is-selected");
    expect(selectedCommit).toContain("var(--ink-fog) 12%");
    expect(selectedCommit).not.toContain("var(--brass) 14%");

    // 워크스페이스 트리의 활성(중앙 뷰) 행 — brass 스파인 + 옅은 wash + 1차 텍스트.
    const activeTreeRow = blockOf(".repository-ws-tree-row.is-active");
    expect(activeTreeRow).toContain("var(--text-primary)");
    expect(activeTreeRow).toContain("var(--brass) 7%");
    expect(activeTreeRow).toContain("inset 2px 0 0 var(--brass)");

    expect(blockOf(".history-badge--tag")).not.toContain("var(--brass)");
    expect(blockOf(".history-badge--head")).toContain("var(--brass)");
  });

  it("uses core surface tokens for panel material", () => {
    expect(css).not.toContain("background: var(--ink-deep)");

    for (const selector of [".repository-toolbar", ".repository-plugin-toolbar", ".history-toolbar", ".repository-compare-controls", ".repository-line-file-label", ".repository-discovery"]) {
      expect(blockOf(selector), selector).toContain("var(--surface-band) 55%");
    }
    for (const selector of [".repository-identity", ".repository-ws-tree"]) {
      expect(blockOf(selector), selector).toContain("var(--surface-band) 72%");
    }
    expect(css).not.toContain(".repository-scan-foot");
    expect(blockOf(".repository-ref-mark")).toContain("var(--brass)");
    expect(blockOf(".repository-ref-hl")).toContain("var(--brass)");
    // .history-detail-pane은 스택 레이아웃 재선언 포함 2개 규칙 — background를 선언하는 모든 규칙이 glass를 소비해야 한다.
    const detailPanes = blocksOf(".history-detail-pane").filter((body) => body.includes("background"));
    expect(detailPanes.length).toBeGreaterThanOrEqual(2);
    for (const body of detailPanes) expect(body).toContain("var(--surface-glass) 70%");

    for (const selector of [".repository-filter-input", ".history-filter-input", ".repository-view-toggle"]) {
      expect(blockOf(selector), selector).toContain("var(--ink-abyss) 35%");
    }
  });

  it("keeps workspace section header buttons within the interaction grammar", () => {
    const sectionHead = blockOf(".repository-ws-section-head");
    expect(sectionHead).toContain("display: flex");
    expect(sectionHead).toContain("width: 100%");
    expect(sectionHead).toContain("border: 0");
    expect(sectionHead).toContain("background: transparent");
    expect(sectionHead).toContain("color: var(--text-tertiary)");
    expect(sectionHead).toContain("font-family: var(--font-mono)");
    expect(sectionHead).toContain("cursor: pointer");
    expect(sectionHead).toContain("text-align: left");

    const sectionHeadHover = blockOf(".repository-ws-section-head:hover");
    expect(sectionHeadHover).toContain("background: color-mix(in oklch, var(--ink-fog) 9%, transparent)");
    expect(sectionHeadHover).toContain("color: var(--text-secondary)");

    const sectionHeadFocus = blockOf(".repository-ws-section-head:focus-visible");
    expect(sectionHeadFocus).toContain("outline: 1px solid var(--brass)");
    expect(sectionHeadFocus).toContain("outline-offset: -1px");

    const chevrons = blocksOf(".repository-folder-chevron");
    expect(chevrons[0]).toContain("width: 11px");
    expect(chevrons[0]).toContain("height: 11px");
    expect(chevrons[0]).toContain("color: var(--text-tertiary)");
    expect(chevrons[0]).toContain("transition: transform var(--duration-base) var(--ease-spring)");
    expect(chevrons.some((body) => body.includes("transition-duration: 0.01ms"))).toBe(true);
    expect(blockOf(".repository-ws-section.is-collapsed .repository-folder-chevron")).toContain("transform: rotate(-90deg)");
  });

  it("retires legacy compare ref select chrome", () => {
    expect(css).not.toMatch(/\.repository-compare-select\b/);
  });

  it("retires legacy scan depth select chrome", () => {
    expect(css).not.toMatch(/\.repository-scan-depth\b/);
  });

  it("keeps added and deleted rows monochromatic", () => {
    expect(blockOf(".repository-line-add .repository-line-code")).toContain("var(--text-primary) 72%");
    expect(blockOf(".repository-line-del .repository-line-code")).toContain("var(--text-primary) 60%");

    for (const row of ["add", "del"]) {
      for (const token of ["keyword", "string", "number", "type"]) {
        expect(blockOf(`.repository-line-${row} .repository-token-${token}`), `${row}/${token}`).toContain("inherit");
      }
    }
  });
});
