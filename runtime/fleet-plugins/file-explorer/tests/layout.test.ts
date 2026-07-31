import { describe, expect, it } from "vitest";

import {
  EXTRA_WIDTH,
  DIVIDER_KEYBOARD_STEP_PX,
  DIVIDER_WIDTH_PX,
  MIN_VIEWER_PX,
  MIN_TREE_PX,
  buildSplitGridTemplate,
  canResizeTreePane,
  clampTreePaneWidth,
  getTreePaneMaxWidth,
  getTreePaneSeparatorState,
  getTreePaneWidthForContainer,
  resizeTreePaneWithKeyboard,
  resolveExtraWidth,
} from "../client/layout.js";

describe("file explorer rail layout", () => {
  it("파일 선택 상태에서만 extra width를 요청한다", () => {
    expect(resolveExtraWidth(false)).toBeNull();
    expect(resolveExtraWidth(true)).toBe(EXTRA_WIDTH);
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
});
