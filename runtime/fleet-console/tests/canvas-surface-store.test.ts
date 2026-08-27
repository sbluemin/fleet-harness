import { beforeEach, describe, expect, it } from "vitest";

import {
  closeCanvasSurface,
  getCanvasSurfaceEpoch,
  getCanvasSurfacePanelId,
  openCanvasSurface,
  toggleCanvasSurface,
} from "../core/client/src/canvas-surface-store.js";
import { collapseCodexReader, expandCodexReader, getState, openCodexReader } from "../core/client/src/store.js";

/**
 * 캔버스 열은 한 장이다. 두 면이 동시에 서면 위의 것이 아래의 것을 덮은 채 아래가 여전히
 * 살아 있고, 하나를 닫아도 캔버스가 `pointer-events:none`에 갇힌다.
 */
describe("canvas surface store", () => {
  beforeEach(() => {
    closeCanvasSurface();
    collapseCodexReader();
  });

  it("holds one surface at a time and toggles the same id shut", () => {
    openCanvasSurface("global-shell");
    expect(getCanvasSurfacePanelId()).toBe("global-shell");

    openCanvasSurface("other-panel");
    expect(getCanvasSurfacePanelId()).toBe("other-panel");

    toggleCanvasSurface("other-panel");
    expect(getCanvasSurfacePanelId()).toBeNull();
  });

  it("collapses an expanded Codex reader when a surface takes the canvas", () => {
    openCodexReader({ kind: "entry", entryId: "e1", theaterId: "t1" } as never);
    expandCodexReader();
    expect(getState().codexReaderExpanded).toBe(true);

    openCanvasSurface("global-shell");

    expect(getState().codexReaderExpanded).toBe(false);
    expect(getCanvasSurfacePanelId()).toBe("global-shell");
  });

  it("yields the canvas back when Codex expands over it", () => {
    openCanvasSurface("global-shell");
    openCodexReader({ kind: "entry", entryId: "e1", theaterId: "t1" } as never);

    expandCodexReader();

    expect(getCanvasSurfacePanelId()).toBeNull();
    expect(getState().codexReaderExpanded).toBe(true);
  });

  /**
   * 면의 신원은 열릴 때마다 새로 매겨진다. 같은 패널을 닫았다 다시 열어도 그때 것과 지금 것은
   * 다른 면이므로, 옛 면을 붙들고 있던 비동기 완료가 지금 면을 접어서는 안 된다.
   */
  it("gives every open its own epoch so a stale completion cannot close the current surface", () => {
    openCanvasSurface("global-shell");
    const first = getCanvasSurfaceEpoch();

    closeCanvasSurface();
    openCanvasSurface("global-shell");

    expect(getCanvasSurfaceEpoch()).toBeGreaterThan(first);
  });

  it("does not advance the epoch when nothing opened", () => {
    openCanvasSurface("global-shell");
    const epoch = getCanvasSurfaceEpoch();
    openCanvasSurface("global-shell");
    expect(getCanvasSurfaceEpoch()).toBe(epoch);
  });
});
