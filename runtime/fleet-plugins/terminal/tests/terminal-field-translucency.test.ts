// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class Unicode11Addon {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class WebglAddon {} }));

import { resolvePanelSurface, terminalFieldIsTranslucent, terminalFontWeightsFor, terminalForegroundFor } from "../client/shared/terminal-surface.js";

/* 유리 게이트를 CSS 채널 계산값으로만 연다 — 제품과 같은 판정 경로를 타야 의미가 있다. */
const openGlassGate = () => document.documentElement.style.setProperty("--glass-backdrop-strong", "blur(24px) saturate(1.7)");
const closeGlassGate = () => document.documentElement.style.setProperty("--glass-backdrop-strong", "none");
const setTerminalTint = (value: string) => document.documentElement.style.setProperty("--glass-tint-terminal", value);
const setTerminalFloor = (value: string) => document.documentElement.style.setProperty("--glass-tint-terminal-floor", value);

afterEach(() => {
  document.documentElement.style.removeProperty("--glass-backdrop-strong");
  document.documentElement.style.removeProperty("--glass-tint-terminal");
  document.documentElement.style.removeProperty("--glass-tint-terminal-floor");
});

describe("terminalFieldIsTranslucent", () => {
  it("reads the alpha channel of a normalized rgba() field", () => {
    expect(terminalFieldIsTranslucent("rgba(0, 0, 0, 0)")).toBe(true);
    expect(terminalFieldIsTranslucent("rgba(17, 24, 33, 0.620)")).toBe(true);
    expect(terminalFieldIsTranslucent("rgba(250, 249, 246, 1.000)")).toBe(false);
    expect(terminalFieldIsTranslucent("rgb(9, 15, 21)")).toBe(false);
  });

  /* 알파를 못 읽는 환경은 불투명으로 읽어야 한다 — 그 환경의 xterm도 알파를 파싱하지 못하므로,
     투명으로 넘기면 글리프만 감마 미보정 경로로 보내고 얻는 것이 없다. */
  it("treats an unresolvable color as opaque", () => {
    expect(terminalFieldIsTranslucent("oklch(98.2% 0.004 100)")).toBe(false);
    expect(terminalFieldIsTranslucent("oklch(13% .015 245 / 62%)")).toBe(false);
    expect(terminalFieldIsTranslucent("")).toBe(false);
  });
});

describe("resolved terminal field drives allowTransparency", () => {
  /* 알파가 실제로 필요한 유일한 조합이다 — 여기서만 xterm이 투명 위에 글리프를 그려야
     컨테이너의 유리 틴트 한 겹이 그대로 비친다. */
  it("keeps the dark field translucent while the glass gate is open", () => {
    openGlassGate();
    setTerminalTint("rgb(17, 24, 33)");
    setTerminalFloor("rgb(7, 19, 29)");
    expect(terminalFieldIsTranslucent(resolvePanelSurface("instrument", "oklch(16.5% 0.016 245)"))).toBe(true);
  });

  /* 비운 필드의 RGB는 검정이 아니라 유리 톤이어야 한다 — xterm이 dim(SGR 2) 셀에 그리는 배경
     사각형은 알파를 1로 강제하므로, RGB가 (0,0,0)이면 그 셀만 순수 검정으로 칠해진다. */
  it("clears the dark field to the glass floor color, not to black", () => {
    openGlassGate();
    setTerminalTint("rgb(17, 24, 33)");
    setTerminalFloor("rgb(7, 19, 29)");
    const cleared = resolvePanelSurface("instrument", "oklch(16.5% 0.016 245)");
    expect(cleared).toBe("rgba(7, 19, 29, 0)");
    expect(terminalFieldIsTranslucent(cleared)).toBe(true);
  });

  /* 독립 Shell은 blur가 선명한 terminal tint를 실제 배경으로 삼으므로, 투명 필드의 RGB도 그 tint를
     써야 dim 셀만 panel floor 색으로 내려앉지 않는다. */
  it("clears the shell field to the terminal tint while its blur is active", () => {
    openGlassGate();
    setTerminalTint("rgb(17, 24, 33)");
    setTerminalFloor("rgb(7, 19, 29)");
    expect(resolvePanelSurface("instrument", "oklch(16.5% 0.016 245)", "shell"))
      .toBe("rgba(17, 24, 33, 0)");
  });

  /* floor를 못 읽는 환경(토큰 부재·프로브 없음)은 완전 투명으로 물러난다 — 알파가 살아 있어야
     필드가 유리를 통과시키고, 색을 지어내지 않는다. */
  it("falls back to a fully transparent field when the floor token is missing", () => {
    openGlassGate();
    setTerminalTint("rgb(17, 24, 33)");
    expect(resolvePanelSurface("instrument", "oklch(16.5% 0.016 245)")).toBe("rgba(0, 0, 0, 0)");
  });

  /* 필드 분기는 테마 극성이 아니라 게이트 상태가 정한다 — 라이트도 게이트가 열려 있으면 다크와
     같은 경로로 비워지고, floor RGB만 유리 톤으로 남아 dim 사각형을 덮는다. JS에 테마 분기를
     남기면 CSS 채널과 진실이 두 벌이 된다. */
  it("clears the light field the same way once the glass gate is open", () => {
    openGlassGate();
    setTerminalTint("rgba(250, 249, 246, 0.6)");
    setTerminalFloor("rgb(246, 245, 241)");
    const cleared = resolvePanelSurface("whites", "oklch(98.2% 0.004 100)");
    expect(cleared).toBe("rgba(246, 245, 241, 0)");
    expect(terminalFieldIsTranslucent(cleared)).toBe(true);
  });

  it("keeps every field opaque once the glass gate is closed", () => {
    closeGlassGate();
    setTerminalTint("rgb(9, 15, 21)");
    expect(terminalFieldIsTranslucent(resolvePanelSurface("instrument", "oklch(16.5% 0.016 245)"))).toBe(false);
    setTerminalTint("rgb(250, 249, 246)");
    expect(terminalFieldIsTranslucent(resolvePanelSurface("whites", "oklch(98.2% 0.004 100)"))).toBe(false);
  });
});

/* 서브픽셀 AA 보정의 게이트. 손실은 **세 조건이 동시에 설 때만** 생기므로, 하나라도 빠지면 보정도
   빠져야 한다 — 걸린 채로 남으면 과보정이고, 그건 손실만큼이나 눈에 띈다.
   실측(같은 배경, 렌더러만 교체): 라이트 WebGL은 DOM보다 획 잉크 9.5%가 적고, 웨이트 500을
   물리면 그 차이가 1.5%로 줄어든다. 유리를 끄면 보정 없는 불투명 기준값으로 정확히 돌아온다.
   다크는 부호가 반대(WebGL이 DOM보다 4.0% 많음)라 같은 보정을 걸면 더 두꺼워지기만 한다. */
describe("terminalFontWeightsFor", () => {
  const DEFAULTS = { fontWeight: "normal", fontWeightBold: "bold" };

  it("compensates only light + translucent field + webgl", () => {
    expect(terminalFontWeightsFor("whites", true, "webgl")).toEqual({ fontWeight: 600, fontWeightBold: 900 });
  });

  it("leaves every other combination on the font's own weights", () => {
    // DOM은 실제 배경 위에 그려 서브픽셀 AA가 살아 있다 — 여기에 걸면 이중 보정이다.
    expect(terminalFontWeightsFor("whites", true, "dom")).toEqual(DEFAULTS);
    // 불투명 필드는 아틀라스가 배경을 알고 굽는다 — 잃은 것이 없으므로 되돌릴 것도 없다.
    expect(terminalFontWeightsFor("whites", false, "webgl")).toEqual(DEFAULTS);
    // 다크는 같은 왜곡이 반대 부호라 보정이 악화시킨다.
    for (const theme of ["instrument", "maritime", "carbon"] as const) {
      expect(terminalFontWeightsFor(theme, true, "webgl")).toEqual(DEFAULTS);
    }
  });

  /* 웨이트는 기본 웨이트보다 위여야 보정이고, 볼드는 그보다 위여야 볼드가 볼드로 남는다. */
  it("keeps the compensated weights above the defaults and ordered", () => {
    const { fontWeight, fontWeightBold } = terminalFontWeightsFor("whites", true, "webgl");
    expect(fontWeight).toBeGreaterThan(400);
    expect(fontWeightBold).toBeGreaterThan(Number(fontWeight));
  });
});

/* 농도 보정은 웨이트와 같은 게이트를 써야 한다 — 한쪽만 걸리면 색과 굵기가 어긋난 조합이 생긴다. */
describe("terminalForegroundFor", () => {
  const BASE = "oklch(24% 0.012 95)";

  it("darkens the ink only on light + translucent field + webgl", () => {
    expect(terminalForegroundFor("whites", BASE, true, "webgl")).not.toBe(BASE);
  });

  it("leaves every other combination on the theme's own foreground", () => {
    expect(terminalForegroundFor("whites", BASE, true, "dom")).toBe(BASE);
    expect(terminalForegroundFor("whites", BASE, false, "webgl")).toBe(BASE);
    for (const theme of ["instrument", "maritime", "carbon"] as const) {
      expect(terminalForegroundFor(theme, BASE, true, "webgl")).toBe(BASE);
    }
  });
});
