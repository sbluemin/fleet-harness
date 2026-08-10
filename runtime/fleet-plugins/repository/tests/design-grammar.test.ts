import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { WORKSPACE_DOCK_DIVIDER_WIDTH, WORKSPACE_DOCK_MAIN_MIN_WIDTH, WORKSPACE_DOCK_SPLIT_MIN_WIDTH } from "../client/workspace-layout.js";

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
    expect(blockOf(".repository-ref-row.is-current .repository-ref-sub")).toContain("var(--brass-ink)");

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

    for (const selector of [".repository-toolbar", ".repository-plugin-toolbar", ".history-toolbar", ".repository-line-file-label", ".repository-discovery"]) {
      expect(blockOf(selector), selector).toContain("var(--surface-band) 55%");
    }
    for (const selector of [".repository-identity", ".repository-ws-tree"]) {
      expect(blockOf(selector), selector).toContain("var(--surface-band) 72%");
    }
    expect(css).not.toContain(".repository-scan-foot");
    expect(blockOf(".repository-ref-mark")).toContain("var(--brass-ink)");
    expect(blockOf(".repository-ref-hl")).toContain("var(--brass-ink)");
    // .history-detail-pane은 스택 레이아웃 재선언 포함 2개 규칙 — background를 선언하는 모든 규칙이 glass를 소비해야 한다.
    const detailPanes = blocksOf(".history-detail-pane").filter((body) => body.includes("background"));
    expect(detailPanes.length).toBeGreaterThanOrEqual(2);
    for (const body of detailPanes) expect(body).toContain("var(--surface-glass) 70%");

    for (const selector of [".repository-filter-input", ".history-filter-input", ".repository-view-toggle"]) {
      expect(blockOf(selector), selector).toContain("var(--ink-abyss) 35%");
    }
  });

  it("keeps the sync button spin animation reducible and omits the status strip", () => {
    expect(css).not.toContain(".repository-sync-status");
    expect(blocksOf(".repository-sync-button.is-syncing .repository-sync-icon").some((body) => body.includes("animation: none"))).toBe(true);
  });

  // 2026-08-05 재가 — in-history compare 앵커와 수동 Sync 표면화의 신호 채널 문법.
  // pin/pick은 상태이므로 aurora(신호), 실패는 coral, 성공 요약은 positive — brass는 위치/포커스 전용으로 남는다.
  it("keeps the anchor-compare and sync surfaces on the signal channel, never brass", () => {
    expect(blockOf(".history-commit-row.is-picked")).toContain("inset 2px 0 0 var(--aurora)");
    expect(blockOf(".history-row-compare")).toContain("var(--aurora)");
    expect(blockOf(".history-row-compare")).not.toContain("var(--brass)");
    expect(blockOf(".repository-sync-toast.is-error")).toContain("var(--coral)");
    expect(blockOf(".repository-sync-toast.is-success")).toContain("var(--positive)");
    expect(blockOf(".repository-sync-dot")).toContain("var(--coral)");
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

  // 2026-08-07 재가 — Fork 문법의 ref 뱃지. 색조는 --badge-tone 한 채널로만 흐르고, 종류가 고정된 축만
  // CSS가 소유한다(체크아웃 위치=brass, 태그=plum). 나머지는 커밋 행이 자기 레인 색을 주입한다.
  it("routes every ref badge color through one tone channel, with location on brass", () => {
    const badge = blockOf(".history-badge");
    expect(badge).toContain("--badge-tone:");
    for (const property of ["border", "background", "border-right"]) {
      expect(blocksOf(".history-badge").concat(blocksOf(".history-badge-mark")).some((body) => body.includes(`${property}:`) && body.includes("var(--badge-tone)")), property).toBe(true);
    }
    // 알약이 아니라 라운드 사각 + 볼드 sans — Fork가 뱃지를 라벨이 아닌 표식으로 읽히게 하는 축.
    expect(badge).not.toContain("border-radius: 999px");
    expect(badge).toContain("border-radius: var(--radius-xs)");
    expect(badge).toContain("font-family: var(--font-body)");
    expect(badge).toContain("font-size: 11px");
    expect(badge).toContain("font-weight: var(--weight-bold)");
    expect(badge).toContain("var(--badge-tone) 82%");
    expect(badge).toContain("var(--badge-tone) 22%");
    expect(blockOf(".history-badge-mark")).toContain("var(--badge-tone) 65%");
    expect(blockOf(".history-badge-remote-mark")).toContain("var(--badge-tone)");

    for (const selector of [".history-badge--head", ".history-badge.is-current"]) {
      expect(blockOf(selector), selector).toContain("var(--brass)");
    }
    expect(blockOf(".history-badge--tag")).toContain("var(--id-plum)");
    expect(blockOf(".history-badge--tag")).not.toContain("var(--brass)");
    // 인라인으로 주입되는 레인 색이 --badge-tone을 덮어쓰므로, 정의되지 않은 var 참조가 되지 않도록 기본값이 있어야 한다.
    expect(badge).toMatch(/--badge-tone:\s*var\(--ink-fog\)/);
  });

  it("raises only the Conventional Commit prefix, and demotes it with the rest off HEAD", () => {
    expect(blockOf(".history-commit-kind")).toContain("font-weight: var(--weight-bold)");
    expect(blockOf(".history-commit-kind")).toContain("color: var(--text-primary)");
    expect(css).toContain(".history-commit-row.is-off-head .history-commit-kind");
  });

  it("keeps commit subjects on one row at every container width", () => {
    const subjects = blocksOf(".history-commit-subject");
    // 행 높이는 그래프 gutter의 ROW_HEIGHT와 가상 스크롤 기하에 묶여 있다 — 줄바꿈은 둘 다 깨뜨린다.
    for (const body of subjects) {
      expect(body).not.toContain("line-clamp");
      expect(body).not.toContain("white-space: normal");
    }
    expect(subjects.some((body) => body.includes("white-space: nowrap") && body.includes("text-overflow: ellipsis"))).toBe(true);
  });

  it("keeps every visible ref badge whole while the subject yields panel width", () => {
    const badges = blockOf(".history-commit-badges");
    expect(badges).toContain("width: max-content");
    expect(badges).toContain("min-width: max-content");
    expect(badges).not.toContain("overflow: hidden");
    expect(css).not.toContain("max-width: 40cqw");
    // 콘텐츠 실측이나 극소 폭 경계가 반쪽 칩을 남기지 않고 배지 그룹 전체를 한 번에 뺀다.
    expect(blockOf(".history-commit-badges.is-overflowing")).toContain("display: none");
    expect(css).toContain("@container (max-width: 420px)");
    expect(blocksOf(".history-commit-badges").some((body) => body.includes("display: none"))).toBe(true);
  });

  it("resizes the inspector dock through an injected width variable, not an inline track list", () => {
    const [wide, stacked] = blocksOf(".repository-ws-dock");
    expect(wide).toContain("var(--ws-dock-files-width, 250px)");
    // 파일 열 · 4px 디바이더 · diff 열의 3트랙 문법.
    expect(wide).toMatch(/grid-template-columns:[^;]*\)\) 4px minmax\(0, 1fr\)/);
    // CSS 보정값과 JS 클램프가 어긋나면 한쪽만 diff 열을 지켜 준다.
    expect(wide).toContain(`calc(100% - ${WORKSPACE_DOCK_MAIN_MIN_WIDTH + WORKSPACE_DOCK_DIVIDER_WIDTH}px)`);
    // 좁은 독은 세로 스택으로 넘어가고, 그때 열 디바이더는 트랙 수를 어긋내므로 흐름에서 빠진다.
    expect(stacked).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(blockOf(".repository-ws-dock > .repository-ws-dock-divider")).toContain("display: none");
    // 스택 경계가 두 최소폭 합보다 좁으면 "보이는데 끌리지 않는" 디바이더 구간이 생긴다.
    expect(css).toContain(`@container (width < ${WORKSPACE_DOCK_SPLIT_MIN_WIDTH}px)`);
  });

  it("lets the file column actually shrink to its grid track", () => {
    // min-width/열 minmax가 빠지면 섹션이 min-content로 굳어 트랙을 무시하고 diff 열을 덮는다.
    const files = blockOf(".history-commit-files");
    expect(files).toContain("min-width: 0");
    expect(files).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("keeps the dock meta subject on one line", () => {
    const meta = blockOf(".repository-ws-dock-meta .history-inspector-subject");
    expect(meta).toContain("white-space: nowrap");
    expect(meta).toContain("text-overflow: ellipsis");
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
