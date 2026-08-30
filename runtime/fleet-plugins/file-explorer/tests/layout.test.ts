import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { getT } from "../client/i18n/index.js";
import { countOverflowingChips } from "../client/layout.js";
import { buildViewerMetaParts } from "../client/format.js";
import { canWrapLines, visibleLineWindow, WRAP_LINE_BUDGET } from "../client/viewer/code.js";

const t = getT("en");

// 열의 폭·분할선·최소폭은 이제 표면(호스트)이 소유한다 — 그 산수는
// `runtime/fleet-console/tests/pane-geometry.test.ts`가 지킨다. 여기 남은 것은 칩 띠처럼
// 페인 본문 안에서만 뜻이 있는 계산이다.
describe("file explorer rail layout", () => {
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
    const source = fs.readFileSync(new URL("../client/document-pane.tsx", import.meta.url), "utf8");
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
    const source = fs.readFileSync(new URL("../client/document-pane.tsx", import.meta.url), "utf8");
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
