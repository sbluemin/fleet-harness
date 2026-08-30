import { describe, expect, it } from "vitest";

import {
  canSplit,
  clampPrimaryWidth,
  MIN_PANE_PX,
  PANE_DIVIDER_KEYBOARD_COARSE_STEP_PX,
  PANE_DIVIDER_KEYBOARD_STEP_PX,
  PANE_DIVIDER_PX,
  maxPrimaryWidth,
  paneSeparatorState,
  resizePrimaryWithKeyboard,
  type PaneSplitLimits,
} from "../core/client/src/pane/pane-geometry.js";

/**
 * 표면의 산수. 이 규칙들은 예전에 플러그인마다 따로 있었다(file-explorer의 `layout.ts`,
 * repository의 grid clamp) — 계약이 기하를 표면에 준 뒤로는 한 벌만 남는다.
 */

const limits = (surfaceWidth: number, minPrimary = 240, minDetail = 200): PaneSplitLimits => ({
  surfaceWidth,
  minPrimary,
  minDetail,
});

describe("표면 분할 기하", () => {
  it("primary 최대 폭은 detail 최소치와 분할선을 남긴다", () => {
    expect(maxPrimaryWidth(limits(800))).toBe(800 - 200 - PANE_DIVIDER_PX);
  });

  it("두 열이 각자의 최소폭을 못 가지면 분할선은 잠긴다", () => {
    // 240 + 200 + 4 = 444 — 그보다 좁으면 끌 자리가 없다.
    expect(canSplit(limits(444))).toBe(false);
    expect(canSplit(limits(445))).toBe(true);
  });

  it("드래그 결과를 양쪽 최소폭 사이로 자른다", () => {
    expect(clampPrimaryWidth(1000, limits(800))).toBe(596);
    expect(clampPrimaryWidth(10, limits(800))).toBe(240);
    expect(clampPrimaryWidth(320, limits(800))).toBe(320);
  });

  it("끌 자리가 없으면 남은 폭 전부를 primary로 보고한다", () => {
    // 잠긴 상태에서 최소폭을 돌려주면 화면과 어긋난 값을 aria가 말하게 된다.
    const narrow = limits(400);
    expect(clampPrimaryWidth(240, narrow)).toBe(maxPrimaryWidth(narrow));
  });

  it("표면 폭을 아직 재지 못한 프레임에서는 자르지 않는다", () => {
    // 첫 렌더는 언제나 여기 걸린다. 이때 클램프하면 남는 자리가 음수라 primary가 0px으로
    // 접혔다가 다음 프레임에 튀어나온다 — 사용자에게는 열이 한 번 깜빡이는 것으로 보인다.
    expect(clampPrimaryWidth(360, limits(0))).toBe(360);
    expect(canSplit(limits(0))).toBe(false);

    const pending = paneSeparatorState(360, limits(0));
    expect(pending.currentWidth).toBe(360);
    expect(pending.canResize).toBe(false);
    expect(pending.maxWidth).toBe(360);
  });

  it("separator 상태는 잠김을 tabIndex와 aria-disabled로 함께 말한다", () => {
    expect(paneSeparatorState(320, limits(800))).toEqual({
      currentWidth: 320,
      minWidth: 240,
      maxWidth: 596,
      canResize: true,
      tabIndex: 0,
      ariaDisabled: undefined,
    });

    const locked = paneSeparatorState(320, limits(400));
    expect(locked.canResize).toBe(false);
    expect(locked.tabIndex).toBe(-1);
    expect(locked.ariaDisabled).toBe(true);
    expect(locked.minWidth).toBe(locked.currentWidth);
    expect(locked.maxWidth).toBe(locked.currentWidth);
  });

  it("← 는 primary를 넓히고 → 는 좁힌다 — 레일 바깥 손잡이와 같은 방향", () => {
    expect(resizePrimaryWithKeyboard(320, "ArrowLeft", limits(800)))
      .toBe(320 + PANE_DIVIDER_KEYBOARD_STEP_PX);
    expect(resizePrimaryWithKeyboard(320, "ArrowRight", limits(800)))
      .toBe(320 - PANE_DIVIDER_KEYBOARD_STEP_PX);
  });

  it("Shift는 거친 스텝, Home/End는 경계로 간다", () => {
    expect(resizePrimaryWithKeyboard(320, "ArrowLeft", limits(800), true))
      .toBe(320 + PANE_DIVIDER_KEYBOARD_COARSE_STEP_PX);
    expect(resizePrimaryWithKeyboard(320, "Home", limits(800))).toBe(240);
    expect(resizePrimaryWithKeyboard(320, "End", limits(800))).toBe(596);
  });

  it("경계에서 더 눌러도 넘지 않고, 모르는 키는 폭을 건드리지 않는다", () => {
    expect(resizePrimaryWithKeyboard(596, "ArrowLeft", limits(800))).toBe(596);
    expect(resizePrimaryWithKeyboard(240, "ArrowRight", limits(800))).toBe(240);
    expect(resizePrimaryWithKeyboard(320, "Enter", limits(800))).toBe(320);
  });

  it("서술자가 최소폭을 말하지 않으면 호스트 기본값이 선다", () => {
    expect(maxPrimaryWidth(limits(800, MIN_PANE_PX, MIN_PANE_PX))).toBe(800 - MIN_PANE_PX - PANE_DIVIDER_PX);
  });
});
