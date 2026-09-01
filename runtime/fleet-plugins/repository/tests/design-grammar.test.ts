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

// prefers-reduced-motion 블록들의 본문만 모은다 — 파일 뒤쪽에 같은 선언이 있으면 통과해 버리는
// slice(indexOf(...)) 방식은 "미디어 블록 안에 있음"을 증명하지 못한다.
function reducedMotionBodies(): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies: string[] = [];
  const prelude = "@media (prefers-reduced-motion: reduce)";
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
  if (bodies.length === 0) throw new Error("Missing prefers-reduced-motion block");
  return bodies.join("\n");
}

describe("Repository honesty grammar", () => {
  // 잘림·상한 고지는 "조용한 메모"가 아니라 상태다 — File Explorer(.fexp-truncated-badge)가 쓰는
  // warn 처리와 같은 급으로 말해야 같은 사실이 레일마다 다른 무게로 읽히지 않는다.
  it("speaks every cap on the warn channel", () => {
    for (const selector of [".repository-truncated-badge", ".history-truncated", ".repository-truncated-note", ".repository-scan-limit"]) {
      const body = blockOf(selector);
      expect(body).toContain("var(--warn-ink)");
      expect(body).toContain("var(--warn) 12%");
      expect(body).not.toContain("var(--ink-fog) 8%");
    }
  });

  // 로컬 상태를 다시 읽는 컨트롤은 쉬는 상태에서 위치 채널을 켜지 않는다 — brass는 hover/focus에만.
  it("rests the reload control on neutral ink and takes brass only on focus", () => {
    const rest = blockOf(".repository-reload-state");
    expect(rest).toContain("var(--text-tertiary)");
    expect(rest).not.toContain("var(--brass)");
    expect(blockOf(".repository-reload-state:focus-visible")).toContain("var(--brass)");
  });

  // 목록 220 + 디바이더 4 + diff 140 = 364px. 그 아래에서 좌우 분할을 유지하면 목록이 82px까지
  // 눌려 파일명 요소 폭이 0px가 된다(격리 콘솔 실측). 두 열이 못 서면 위아래로 세운다.
  it("stacks the staging split instead of imploding the file list", () => {
    const bodies = blocksOf(".repository-staging-root.has-hunk");
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const stacked = bodies.find((body) => body.includes("grid-template-rows"));
    expect(stacked).toBeDefined();
    expect(stacked).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).toContain("@container (width < 364px)");
    expect(blockOf(".repository-staging-root.has-hunk > .repository-divider")).toContain("display: none");
  });

  // 끌어서 정한 폭은 인라인 스타일이 아니라 변수로 들어와야 컨테이너 쿼리가 이긴다(독과 같은 이유).
  it("takes the dragged list width as a variable so the stack query can win", () => {
    expect(blockOf(".repository-staging-root.has-hunk")).toContain("var(--staging-list-width");
  });

  // 컨테이너 쿼리는 컨테이너 자신에게 적용되지 않는다. 조건을 지는 요소가 스테이징 루트이므로
  // 컨테이너는 그 부모여야 한다 — 루트가 컨테이너면 조건이 조상 폭으로 풀려 배치마다 달라진다.
  it("owns the stack container on the parent, not on the queried element", () => {
    expect(blockOf(".repository-staging")).toContain("container-type: inline-size");
    expect(blockOf(".repository-staging-root")).not.toContain("container-type");
  });
});

describe("Repository signal mixing", () => {
  // 두 hue를 섞는 자리에서 oklch는 원통 좌표의 먼 호를 돈다. 격리 콘솔 실측: 추가 글자 hue 109.6
  // (황록) · 삭제 글자 hue 64(호박) — Instrument·Maritime·Whites 모두. oklab은 150.6 / 29.6이다.
  it("mixes two-hue diff text in oklab so add and delete keep their signal", () => {
    expect(blockOf(".repository-line-add .repository-line-code")).toContain("color-mix(in oklab, var(--text-primary) 72%, var(--positive))");
    expect(blockOf(".repository-line-del .repository-line-code")).toContain("color-mix(in oklab, var(--text-primary) 60%, var(--coral))");
  });

  // 컨트롤은 좁아지면 눌리는 대신 줄을 바꾼다 — 실측에서 커밋 버튼은 31×89px 세로 글자기둥이 됐다.
  it("lets the commit row wrap instead of crushing its button", () => {
    expect(blockOf(".repository-commit-row")).toContain("flex-wrap: wrap");
    const button = blockOf(".repository-commit-button");
    expect(button).toContain("flex: none");
    expect(button).toContain("white-space: nowrap");
  });
});

describe("Repository design grammar", () => {
  // 2026-09-01 소프트 그래파이트 재가 — 선택은 스파인이 아니라 위치 채널(brass)의 저알파
  // 라운드 필이다. 스파인(inset 2px) 문법은 이 패널에서 퇴역했고, 필의 알파는 10%로 통일해
  // 선택 면이 hover(잉크 9%)보다 한 단 무거우면서도 신호 채널을 침범하지 않게 한다.
  it("paints selection as a low-alpha brass fill without spines", () => {
    expect(blockOf(".repository-ref-row.is-current")).toContain("var(--text-primary)");
    expect(blockOf(".repository-ref-row.is-current")).not.toContain("var(--brass)");
    expect(blockOf(".repository-ref-row.is-current:hover")).not.toContain("var(--brass)");
    expect(blockOf(".repository-ref-row.is-current .repository-ref-sub")).toContain("var(--brass-ink)");

    const selectedFile = blockOf(".repository-file-row.is-cur");
    expect(selectedFile).toContain("var(--brass) 10%");
    expect(selectedFile).not.toContain("inset 2px 0 0");
    expect(blockOf(".repository-file-row.is-cur .repository-file-fn")).toContain("var(--text-primary)");

    const selectedCommit = blockOf(".history-commit-row.is-selected");
    expect(selectedCommit).toContain("var(--brass) 10%");
    expect(selectedCommit).not.toContain("inset 2px 0 0");

    const activeTreeRow = blockOf(".repository-ws-tree-row.is-active");
    expect(activeTreeRow).toContain("var(--text-primary)");
    expect(activeTreeRow).toContain("var(--brass) 10%");
    expect(activeTreeRow).not.toContain("inset 2px 0 0");

    expect(blockOf(".history-badge--tag")).not.toContain("var(--brass)");
    expect(blockOf(".history-badge--head")).toContain("var(--brass)");
  });

  // 라운드 행 문법 — 행은 좌우 4px 인셋 위에서 라운드 필로 hover·선택을 말한다. 커밋 행은
  // 전 행이 같은 만큼 밀려야 그래프 레인의 세로 연속성이 유지되고, 높이는 ROW_HEIGHT와 동기다.
  it("keeps rows on the rounded inset grammar with the graph row height in sync", () => {
    for (const selector of [".repository-file-row", ".repository-folder-row", ".repository-ws-tree-row", ".history-commit-row"]) {
      const body = blockOf(selector);
      expect(body, selector).toContain("border-radius: var(--radius-xs)");
      expect(body, selector).toContain("margin: 0 4px");
      expect(body, selector).toContain("calc(100% - 8px)");
    }
    expect(blockOf(".history-commit-row")).toContain("height: 30px");
  });

  // rest는 침묵이 아니라 낮은 목소리다 — 주 동사와 보조 컨트롤은 쉬는 상태에서도
  // rest 채널 + 헤어라인의 2-cue로 몸을 알리고, 입력 필드는 우물 대신 field 채널로 떠오른다.
  it("gives every verb, control, and input a resting body", () => {
    const verb = blockOf(".repository-sync-button");
    expect(verb).toContain("background: var(--control-rest)");
    expect(verb).toContain("border: 1px solid var(--surface-rim)");
    expect(verb).not.toContain("background: transparent");
    for (const selector of [".history-order-toggle", ".repository-refresh-btn", ".repository-reload-state", ".repository-compare-swap", ".repository-stage-action"]) {
      expect(blockOf(selector), selector).toContain("var(--control-rest)");
    }
    for (const selector of [".repository-filter-input", ".repository-stash-popover-input"]) {
      expect(blockOf(selector), selector).toContain("var(--control-field)");
    }
    expect(blocksOf(".repository-commit-subject").concat(blocksOf(".repository-commit-body")).some((body) => body.includes("var(--control-field)"))).toBe(true);
    expect(css).not.toContain("var(--ink-abyss) 35%");
  });

  // 상태 글리프는 맨글자가 아니라 칩이다 — currentColor 틴트라 상태별 규칙 없이 신호 채널을 따른다.
  it("wraps status glyphs in currentColor-tinted chips", () => {
    const glyph = blockOf(".repository-status-glyph");
    expect(glyph).toContain("currentColor 14%");
    expect(glyph).toContain("width: 17px");
    expect(glyph).toContain("height: 17px");
  });

  // 2026-09-01 밴드 정합 재가 — 패널 안의 면은 하나다. 캡·툴바가 캔버스 톤(--surface-band)과
  // 유리(--surface-glass 70%)를 제각각 섞으면 창 하나가 명도가 다른 띠들로 갈라져 읽힌다
  // (identity "검은 띠" 실측 지적). 캡·툴바는 전부 같은 위스퍼 워시(--ink-fog 5%) 한 단만 얹고,
  // 스크롤을 가리는 스티키 헤더만 패널 채널을 쓴다.
  it("uses core surface tokens for panel material", () => {
    expect(css).not.toContain("background: var(--ink-deep)");
    // 캔버스 톤은 이 패널에서 퇴역했다 — 남은 언급은 독트린 주석뿐이어야 한다.
    expect(css).not.toContain("var(--surface-band)");

    for (const selector of [".repository-toolbar", ".repository-plugin-toolbar", ".history-toolbar", ".repository-line-file-label", ".repository-discovery", ".repository-identity", ".repository-checkout-tabs", ".repository-ws-peek"]) {
      expect(blockOf(selector), selector).toContain("var(--ink-fog) 5%");
    }
    expect(blockOf(".repository-ws-tree")).toContain("background: transparent");
    for (const selector of [".repository-hunk-head", ".repository-staging-head"]) {
      expect(blockOf(selector), selector).toContain("var(--glass-tint-panel)");
    }
    expect(css).not.toContain(".repository-scan-foot");
    expect(blockOf(".repository-ref-mark")).toContain("var(--brass-ink)");
    expect(blockOf(".repository-ref-hl")).toContain("var(--brass-ink)");
    // .history-inspector-shelf은 스택 레이아웃 재선언 포함 2개 규칙 — background를 선언하는 모든 규칙이 같은 면(투명)에 남아야 한다.
    const detailPanes = blocksOf(".history-inspector-shelf").filter((body) => body.includes("background"));
    expect(detailPanes.length).toBeGreaterThanOrEqual(2);
    for (const body of detailPanes) expect(body).toContain("background: transparent");

    for (const selector of [".repository-filter-input", ".history-filter-input"]) {
      expect(blockOf(selector), selector).toContain("var(--control-field)");
    }
    // 뷰 토글은 상자 없는 세그먼트다(Quiet Controls C′) — 선택은 워시+다텀이 말하고 그룹 경계는 간격이 진다.
    expect(blockOf(".repository-view-toggle")).not.toContain("background");
    expect(blockOf(".repository-toggle-btn.is-active")).toContain("var(--control-wash)");
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
    expect(reduced).toContain(".repository-identity .repository-sync-glyph { transition-duration: 1ms; }");
    expect(reduced).toContain(".repository-identity .repository-sync-hint { transition-duration: 1ms; }");
    expect(glyph).toContain("transition:");
  });

  // 2026-08-05 재가 — in-history compare 앵커와 수동 Sync 표면화의 신호 채널 문법.
  // pin/pick은 상태이므로 aurora(신호), 실패는 coral, 성공 요약은 positive — brass는 위치/포커스 전용으로 남는다.
  it("keeps the anchor-compare and sync surfaces on the signal channel, never brass", () => {
    const picked = blockOf(".history-commit-row.is-picked");
    expect(picked).toContain("var(--aurora) 12%");
    expect(picked).not.toContain("var(--brass)");
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

  // 확대 표면 슬롯 본문은 가로 flex다. 껍데기만 늘려 두고 화면 자신이 자리를 요구하지 않으면
  // 두 열 격자가 내용 폭(약 200px) 안에서 접혀, 넓은 캔버스가 통째로 비어 보인다.
  it("makes the repository screen claim the surface slot, not just its wrapper", () => {
    const wrapper = blockOf(".repository-surface-body");
    expect(wrapper).toContain("display: flex");
    expect(wrapper).toContain("flex: 1");
    expect(wrapper).toContain("min-width: 0");
    const screen = blockOf(".repository-surface-body > .repository-unified");
    expect(screen).toContain("flex: 1");
    expect(screen).toContain("min-width: 0");
  });

  it("keeps workspace section header buttons within the interaction grammar", () => {
    const sectionHead = blockOf(".repository-ws-section-head");
    expect(sectionHead).toContain("display: flex");
    expect(sectionHead).toContain("width: 100%");
    expect(sectionHead).toContain("border: 0");
    expect(sectionHead).toContain("background: transparent");
    expect(sectionHead).toContain("color: var(--text-tertiary)");
    expect(sectionHead).toContain("font-family: var(--font-body)");
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

  // 2026-08-07 재가, 2026-09-01 소프트 그래파이트 재조율 — Fork 문법의 ref 뱃지. 색조는
  // --badge-tone 한 채널로만 흐르고, 종류가 고정된 축만 CSS가 소유한다(체크아웃 위치=brass,
  // 태그=plum). 고알파 사각(82%/22%/bold)은 저알파 캡슐(45%/14%/medium)로 낮아졌다 —
  // 뱃지가 커밋 제목보다 큰 목소리를 내지 않게 하는 감쇠이며, radius-pill 소비는 규칙 옆
  // 독트린 주석에 기록된 상태 캡슐 축의 예외다.
  it("routes every ref badge color through one tone channel, with location on brass", () => {
    const badge = blockOf(".history-badge");
    expect(badge).toContain("--badge-tone:");
    for (const property of ["border", "background", "border-right"]) {
      expect(blocksOf(".history-badge").concat(blocksOf(".history-badge-mark")).some((body) => body.includes(`${property}:`) && body.includes("var(--badge-tone)")), property).toBe(true);
    }
    expect(badge).toContain("border-radius: var(--radius-pill)");
    expect(badge).toContain("font-family: var(--font-body)");
    expect(badge).toContain("font-size: var(--t-xs)");
    expect(badge).toContain("font-weight: var(--weight-medium)");
    expect(badge).toContain("var(--badge-tone) 45%");
    expect(badge).toContain("var(--badge-tone) 14%");
    expect(blockOf(".history-badge-mark")).toContain("var(--badge-tone) 40%");
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
