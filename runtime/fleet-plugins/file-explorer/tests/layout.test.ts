import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { getT } from "../client/i18n/index.js";
import {
  HOST_EXTRA_WIDTH_CLAMP_PX,
  DIVIDER_KEYBOARD_STEP_PX,
  DIVIDER_WIDTH_PX,
  MIN_VIEWER_PX,
  MIN_TREE_PX,
  buildSplitGridTemplate,
  canResizeTreePane,
  clampTreePaneWidth,
  countOverflowingChips,
  getTreePaneMaxWidth,
  getTreePaneSeparatorState,
  getTreePaneWidthForContainer,
  resizeTreePaneWithKeyboard,
  EXTRA_WIDTH_MAX_PX,
  resolveExtraWidth,
} from "../client/layout.js";
import { buildViewerMetaParts } from "../client/format.js";
import { canWrapLines, visibleLineWindow, WRAP_LINE_BUDGET } from "../client/viewer/code.js";

const t = getT("en");

describe("file explorer rail layout", () => {
  it("파일 선택 상태에서만 extra width를 요청한다", () => {
    expect(resolveExtraWidth(false, 1440)).toBeNull();
    expect(resolveExtraWidth(false, 800)).toBeNull();
  });

  it("extra width를 창 비율로 요청하되 남은 뷰포트를 넘지 않는다", () => {
    // 좁은 창: 남은 뷰포트가 곧 상한이다.
    expect(resolveExtraWidth(true, HOST_EXTRA_WIDTH_CLAMP_PX)).toBe(0);
    expect(resolveExtraWidth(true, 800)).toBe(800 - HOST_EXTRA_WIDTH_CLAMP_PX);
    // 보통 창: 창의 30%를 요청한다(고정 360px도, 남은 전부도 아니다).
    expect(resolveExtraWidth(true, 1280)).toBe(384);
    expect(resolveExtraWidth(true, 1440)).toBe(432);
    // 넓은 창: 상한 720px에서 멈춰 캔버스를 남긴다.
    expect(resolveExtraWidth(true, 2560)).toBe(EXTRA_WIDTH_MAX_PX);
    // 어떤 폭에서도 호스트 클램프를 넘겨 요청하지 않는다.
    for (const width of [640, 900, 1024, 1280, 1600, 2560]) {
      expect(resolveExtraWidth(true, width)).toBeLessThanOrEqual(Math.max(0, width - HOST_EXTRA_WIDTH_CLAMP_PX));
    }
  });

  it("트리 pane 폭을 드래그 범위 안으로 클램프한다", () => {
    expect(clampTreePaneWidth(248, 140, 700)).toBe(MIN_TREE_PX);
    expect(clampTreePaneWidth(248, -400, 700)).toBe(496);
    expect(clampTreePaneWidth(248, -80, 700)).toBe(328);
  });

  it("360px 컨테이너에서는 실제 156px 트리 폭을 보고하고 리사이즈를 비활성화한다", () => {
    expect(canResizeTreePane(360)).toBe(false);
    expect(clampTreePaneWidth(248, -80, 360)).toBe(248);
    expect(getTreePaneMaxWidth(360)).toBe(156);
    expect(getTreePaneWidthForContainer(248, 360)).toBe(156);
    expect(getTreePaneSeparatorState(248, 360)).toEqual({
      currentWidth: 156,
      minWidth: 156,
      maxWidth: 156,
      canResize: false,
      tabIndex: -1,
      ariaDisabled: true,
    });
  });

  it("저장된 트리 폭을 viewer 최소폭 보존 CSS clamp로 감싼다", () => {
    const preservedViewerWidth = MIN_VIEWER_PX + DIVIDER_WIDTH_PX;
    expect(buildSplitGridTemplate(468)).toBe(
      `minmax(0, 1fr) ${DIVIDER_WIDTH_PX}px minmax(0, min(468px, calc(100% - ${preservedViewerWidth}px)))`,
    );
  });

  it("키보드 화살표를 16px 물리 이동으로 변환해 동일한 폭 clamp에 적용한다", () => {
    expect(DIVIDER_KEYBOARD_STEP_PX).toBe(16);
    expect(resizeTreePaneWithKeyboard(248, "ArrowLeft", 700)).toBe(264);
    expect(resizeTreePaneWithKeyboard(248, "ArrowRight", 700)).toBe(232);
    expect(resizeTreePaneWithKeyboard(248, "Enter", 700)).toBe(248);
  });

  it("키보드 폭과 WAI separator 값을 최소·최대 경계에 클램프한다", () => {
    expect(getTreePaneMaxWidth(700)).toBe(496);
    expect(getTreePaneSeparatorState(248, 700)).toEqual({
      currentWidth: 248,
      minWidth: MIN_TREE_PX,
      maxWidth: 496,
      canResize: true,
      tabIndex: 0,
      ariaDisabled: undefined,
    });
    expect(getTreePaneWidthForContainer(900, 700)).toBe(496);
    expect(getTreePaneWidthForContainer(80, 700)).toBe(MIN_TREE_PX);
    expect(resizeTreePaneWithKeyboard(496, "ArrowLeft", 700)).toBe(496);
    expect(resizeTreePaneWithKeyboard(MIN_TREE_PX, "ArrowRight", 700)).toBe(MIN_TREE_PX);
    expect(resizeTreePaneWithKeyboard(248, "ArrowLeft", 360)).toBe(248);
  });

  it("칩 스트립 오버플로 개수는 완전히 보이지 않는 칩만 센다", () => {
    // 5×140 + 4×4 = 716 against a 466px strip (M8).
    expect(countOverflowingChips(466, 0, [140, 140, 140, 140, 140], 4)).toBe(2);
    expect(countOverflowingChips(716, 0, [140, 140, 140, 140, 140], 4)).toBe(0);
    expect(countOverflowingChips(466, 200, [140, 140, 140, 140, 140], 4)).toBe(3);
  });
});

describe("truncated viewer meta", () => {
  it("잘린 읽기는 슬라이스 크기와 전체 크기를 대조하고 줄 수를 파일 전체인 것처럼 말하지 않는다", () => {
    const content = "x".repeat(1024);
    expect(buildViewerMetaParts({ content, truncated: true, sizeBytes: 4 * 1024 * 1024 }, t)).toEqual([
      "First 1.0 KB of 4.0 MB",
      "1 lines loaded",
    ]);
  });

  it("잘리지 않은 읽기는 기존 메타를 유지한다", () => {
    expect(buildViewerMetaParts({ content: "a\nb\n", sizeBytes: 2048 }, t)).toEqual([
      "2.0 KB",
      "2 lines",
    ]);
  });
});

describe("code viewer window", () => {
  it("스크롤 높이는 실제 줄 수와 같고 보이는 창만 고른다", () => {
    const window = visibleLineWindow(0, 210, 60_000, 21, 8);
    expect(window.totalHeight).toBe(60_000 * 21);
    expect(window.start).toBe(0);
    expect(window.end).toBe(10 + 8);
    const mid = visibleLineWindow(21_000, 210, 60_000, 21, 8);
    expect(mid.start).toBe(1000 - 8);
    expect(mid.end).toBe(1000 + 10 + 8);
    expect(mid.offsetY).toBe((1000 - 8) * 21);
  });
});

describe("활성 칩 가시성", () => {
  it("띠 밖으로 걸친 활성 칩을 좌표로 끌어온다", () => {
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    // scrollIntoView는 "조금 걸친" 칩을 보이는 것으로 판정해 잘린 채 남긴다.
    expect(source).toContain("ensureActiveChipVisible");
    expect(source).not.toContain('scrollIntoView({ inline: "nearest"');
  });
});

describe("줄바꿈 가상화", () => {
  it("줄바꿈 모드는 창을 나누지 않는다 — 가변 높이를 고정 격자에 얹지 않기 위해", () => {
    const source = fs.readFileSync(new URL("../client/viewer/code.tsx", import.meta.url), "utf8");
    // 측정 추정으로 창을 유지하면 끝줄이 도달 불가가 된다(실측: 1,200줄에서 1039행 정지).
    expect(source).toContain("const wrapping = wrap && canWrapLines(lines.length)");
    expect(source).toContain("? { start: 0, end: lines.length, offsetY: 0, totalHeight: 0 }");
    expect(source).not.toContain("wrappedLineHeight");
  });

  it("줄바꿈 예산을 넘는 파일은 줄바꿈 컨트롤을 닫고 이유를 말한다", () => {
    expect(canWrapLines(WRAP_LINE_BUDGET)).toBe(true);
    expect(canWrapLines(WRAP_LINE_BUDGET + 1)).toBe(false);
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    expect(source).toContain("disabled={!wrapAvailable}");
    expect(source).toContain("fileExplorer.viewer.wrapUnavailable");
  });

  it("가상화 창은 자기 줄 높이 축으로만 계산한다", () => {
    const window = visibleLineWindow(0, 200, 100, 42);
    expect(window.totalHeight).toBe(4200);
    const scrolled = visibleLineWindow(420, 200, 100, 42);
    expect(scrolled.offsetY).toBe(scrolled.start * 42);
  });
});
