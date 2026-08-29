// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({ Terminal: class Terminal {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class Unicode11Addon {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class WebglAddon {} }));

import { resolvePanelSurface, terminalFieldIsTranslucent } from "../client/shared/terminal-surface.js";

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

  /* 라이트 필드는 유리가 켜져 있어도 불투명 종이다(--glass-on-tint-terminal에 알파가 없다).
     여기서 allowTransparency가 켜지면 라이트 터미널 글자가 얇아지는 회귀가 재발한다. */
  it("keeps the light field opaque even while the glass gate is open", () => {
    openGlassGate();
    setTerminalTint("rgb(250, 249, 246)");
    setTerminalFloor("rgb(250, 249, 246)");
    expect(terminalFieldIsTranslucent(resolvePanelSurface("whites", "oklch(98.2% 0.004 100)"))).toBe(false);
  });

  it("keeps every field opaque once the glass gate is closed", () => {
    closeGlassGate();
    setTerminalTint("rgb(9, 15, 21)");
    expect(terminalFieldIsTranslucent(resolvePanelSurface("instrument", "oklch(16.5% 0.016 245)"))).toBe(false);
    setTerminalTint("rgb(250, 249, 246)");
    expect(terminalFieldIsTranslucent(resolvePanelSurface("whites", "oklch(98.2% 0.004 100)"))).toBe(false);
  });
});
