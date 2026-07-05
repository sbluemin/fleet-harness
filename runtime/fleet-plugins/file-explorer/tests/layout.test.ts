import { describe, expect, it } from "vitest";

import {
  EXTRA_WIDTH,
  MIN_TREE_PX,
  canResizeTreePane,
  clampTreePaneWidth,
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

  it("컨테이너가 최소폭 합보다 좁으면 드래그를 no-op으로 처리한다", () => {
    expect(canResizeTreePane(360)).toBe(false);
    expect(clampTreePaneWidth(248, -80, 360)).toBe(248);
  });
});
