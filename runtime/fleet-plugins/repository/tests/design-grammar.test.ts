import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { WORKSPACE_DOCK_DIVIDER_WIDTH, WORKSPACE_DOCK_MAIN_MIN_WIDTH, WORKSPACE_DOCK_SPLIT_MIN_WIDTH } from "../client/workspace-layout.js";

const css = await fs.readFile(new URL("../client/repository.css", import.meta.url), "utf8");
const railPanelSource = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
const graphSource = await fs.readFile(new URL("../client/graph.tsx", import.meta.url), "utf8");

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

// prefers-reduced-motion 블록들의 본문만 모은다 — 파일 뒤쪽에 같은 선언이 있으면 통과해 버리는
// slice(indexOf(...)) 방식은 "미디어 블록 안에 있음"을 증명하지 못한다.
function reducedMotionBodies(): string {
  return atRuleBodies("@media (prefers-reduced-motion: reduce)");
}

// 임의 at-rule(@media/@container) prelude에 속한 규칙 본문들을 정규화해 모은다 —
// 컨테이너 쿼리 단계 계약이 "블록 안에 있음"을 증명하는 데 같은 파서를 쓴다.
function atRuleBodies(prelude: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = stripped.indexOf(prelude, from);
    if (start === -1) break;
    const open = stripped.indexOf("{", start);
    if (open === -1) break;
    let depth = 0;
    let index = open;
    for (; index < stripped.length; index += 1) {
      if (stripped[index] === "{") depth += 1;
      else if (stripped[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(stripped.slice(open + 1, index));
    from = index + 1;
  }
  if (bodies.length === 0) throw new Error(`Missing at-rule block: ${prelude}`);
  // 본문 규칙 사이 공백을 한 칸으로 정규화해 부분 문자열 단언이 안정적으로 붙게 한다.
  return bodies.join("\n").replace(/\s+/g, " ");
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

  // 2026-08-15 재가 — "이미 최신 상태"는 배너를 쓰지 않는다. 아이콘 슬롯과 말풍선이 그 결과를 진다.
  it("keeps the up-to-date result on the icon slot and hint, with motion reducible but state intact", () => {
    // 글리프 교체가 아니라 겹친 슬롯이어야 버튼 폭이 흔들리지 않는다.
    const iconSlot = blockOf(".repository-identity .repository-sync-icon");
    expect(iconSlot).toContain("position: relative");
    expect(iconSlot).toContain("width: 13px");
    const glyph = blockOf(".repository-identity .repository-sync-glyph");
    expect(glyph).toContain("position: absolute");
    expect(glyph).toContain("opacity: 0");
    // 말풍선은 아래로만, 오른쪽 정렬로, 접히지 않는 너비로 열린다.
    // `.repository-identity span`(0,1,1)이 자손 span 전부에 brass·mono·ellipsis를 걸어 두므로
    // 상태 문면 규칙은 반드시 같은 스코프로 선언해야 한다 — 클래스 하나면 위치 채널로 칠해진다.
    const hint = blockOf(".repository-identity .repository-sync-hint");
    expect(hint).toContain("top: calc(100% + 6px)");
    expect(hint).toContain("right: 0");
    expect(hint).toContain("width: max-content");
    expect(hint).toContain("pointer-events: none");
    expect(hint).toContain("color: var(--text-primary)");
    expect(hint).toContain("overflow: visible");
    expect(hint).toContain("font-family: inherit");
    expect(hint).toContain("white-space: normal");
    // 자동 노출이 끝난 뒤에도 hover·포커스로 다시 열려야 한다.
    expect(css).toContain(".repository-sync-button:hover .repository-sync-hint");
    expect(css).toContain(".repository-sync-button:focus-visible .repository-sync-hint");
    // 동작 줄이기에서는 전이 연출만 걷고 상태는 남긴다 — opacity/transform 규칙을 지우면 안 된다.
    const reduced = reducedMotionBodies();
    expect(reduced).toContain(".repository-identity .repository-sync-glyph { transition-duration: 1ms; }".replace(/\s+/g, " "));
    expect(reduced).toContain(".repository-identity .repository-sync-hint { transition-duration: 1ms; }".replace(/\s+/g, " "));
    expect(glyph).toContain("transition:");
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

  // 2026-08-20 재가 — 동사 결과도 말풍선을 쓴다. 실패는 신호 채널(coral)로 갈리고 화살표까지 같이 물든다.
  // 실패 문면은 한 마디가 아니라 조치 문장이라 동사 버튼에서만 한 뼘 넓게 선다.
  it("splits the verb outcome hint by signal channel and widens it for actionable failures", () => {
    const errorHint = blockOf(".repository-identity .repository-sync-hint.is-error");
    expect(errorHint).toContain("var(--coral)");
    expect(errorHint).not.toContain("var(--brass)");
    const arrow = blockOf(".repository-identity .repository-sync-hint.is-error::before");
    expect(arrow).toContain("border-top-color");
    expect(arrow).toContain("border-left-color");
    expect(blockOf(".repository-identity .repository-verb-button .repository-sync-hint")).toContain("max-width: 264px");
    // 묶음이 span이라 `.repository-identity span`의 overflow:hidden을 물려받는다 — 같은 스코프로 되돌리지
    // 않으면 버튼 아래로 여는 말풍선이 버튼 줄에서 잘려 결과가 아예 보이지 않는다(실측 확인된 회귀).
    expect(blockOf(".repository-identity .repository-verb-cluster")).toContain("overflow: visible");
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
    expect(badge).not.toContain("border-radius: var(--radius-pill)");
    expect(badge).toContain("border-radius: var(--radius-xs)");
    expect(badge).toContain("font-family: var(--font-body)");
    expect(badge).toContain("font-size: var(--t-xs)");
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

  // 2026-08-21 재가 — 축소 순서 계약(identity 축). 패널이 좁아지면 동사 라벨이 먼저 양보하고
  // 글리프+계수(ahead/behind 실질)가 남는다. 라벨 span은 `.repository-identity span`(0,1,1)의
  // brass·mono·t-2xs를 물려받으므로 버튼 스코프의 되돌림 규칙이 반드시 함께 있어야 한다.
  it("collapses verb labels before glyphs under the shrink-order contract", () => {
    const label = blockOf(".repository-verb-button .repository-verb-label");
    expect(label).toContain("color: inherit");
    expect(label).toContain("font-family: inherit");
    expect(label).toContain("font-size: inherit");
    const base = blockOf(".repository-verb-label");
    expect(base).toContain("white-space: nowrap");
    expect(base).toContain("text-overflow: ellipsis");
    const collapsed = rules
      .filter((rule) => rule.selectors.includes(".repository-verb-label") && rule.body.includes("display: none"));
    expect(collapsed).toHaveLength(1);
    // Sync 버튼은 수납에서 제외 — 글리프만으로 이미 최소형이다.
    expect(css).not.toMatch(/\.repository-sync-button\s+\.repository-verb-label/);
  });

  // 2026-08-21 재가 — 축소 순서 계약(history 축). 최종 단계에서 gutter+subject만 남고,
  // subject 보장폭(minmax 96px)은 어느 단계에서도 유지된다. gutter는 뷰포트 축소가 아니라
  // 오버플 클립으로 줄어든다 — width만 줄이면 viewBox 종횡비가 그림을 세로로 눌러 레인 선이 끊긴다.
  it("keeps a final commit-row stage where only gutter and subject survive", () => {
    const finalStage = atRuleBodies("(max-width: 320px)");
    expect(finalStage).toContain(".history-commit-row-main { grid-template-columns: auto minmax(96px, 1fr);");
    expect(finalStage).toContain(".history-graph-gutter { width: 14px; overflow: hidden; }");
    // SVG 자체는 축소하지 않는다 — 뷰포트 축소는 viewBox 종횡비로 그림을 세로로 눌러 레인 선을 끊는다.
    // lane>0 행의 노드는 왼쪽 고정 클립으로 잃어버리므로, compact 모드의 음수 margin이 현재
    // 레인을 14px 창 안으로 민다(graph.tsx GraphGutter).
    expect(finalStage).not.toMatch(/\.history-graph-gutter svg \{[^}]*(^|[^-])width:/);
    expect(graphSource).toContain("compact && node.lane > 0 ? { marginLeft: `-${node.lane * LANE_WIDTH}px` }");
    // 본문 마커도 양보해야 hasBody 커밋에서 최종 단계가 성립한다.
    expect(finalStage).toContain(".history-commit-body-mark { display: none; }");
    // 이전 단계(420px)의 badges 소멸과 공존한다 — 사다리를 대체하지 않는다.
    const badgeStage = atRuleBodies("(max-width: 420px)");
    expect(badgeStage).toContain(".history-commit-badges { display: none; }");
  });

  // 접힌 동사 라벨은 display:none이라 접근성 트리에서 빠진다 — 접근성 이름은 라벨과 계수를
  // 직접 합성해 어느 폭에서도 "Pull 3↓" 전체가 낭독된다.
  it("composes the verb accessible name from label and count", () => {
    expect(railPanelSource).toContain("aria-label={[label, countText].filter(Boolean).join(\" \")}");
    expect(railPanelSource).toContain("countText={workstate?.behind ? `${workstate.behind}↓` : null}");
    expect(railPanelSource).toContain("countText={workstate?.ahead ? `${workstate.ahead}↑` : null}");
  });

  // 체크아웃 탭 라벨도 identity 축의 2단으로 양보한다.
  it("shortens checkout tab labels as the identity axis yields", () => {
    const tabStage = atRuleBodies("(max-width: 380px)");
    expect(tabStage).toContain(".repository-checkout-tab-label { max-width: 10ch; }");
  });
});
