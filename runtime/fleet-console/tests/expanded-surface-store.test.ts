import { beforeEach, describe, expect, it } from "vitest";

import {
  closeAllExpandedSurfaces,
  closeExpandedSurface,
  focusExpandedSurface,
  focusExpandedSurfaceByIndex,
  focusedExpandedSurfaceIndex,
  getExpandedSurfaceState,
  openExpandedSurface,
  replaceExpandedSurfaceParams,
  resetExpandedSurfacesForTest,
  setExpandedSurfaceWeights,
  subscribeExpandedSurfaces,
} from "../core/client/src/expanded-surface/store.js";

beforeEach(() => {
  resetExpandedSurfacesForTest();
});

describe("expanded surface store", () => {
  it("starts empty so the layer paints nothing", () => {
    expect(getExpandedSurfaceState().instances).toEqual([]);
    expect(getExpandedSurfaceState().focusedInstanceId).toBeNull();
  });

  it("reuses a surface's slot instead of stacking one per document", () => {
    const first = openExpandedSurface({ surfaceId: "codex:reader", params: { entryId: "a" } });
    const second = openExpandedSurface({ surfaceId: "codex:reader", params: { entryId: "b" } });

    expect(second).toBe(first);
    const state = getExpandedSurfaceState();
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]?.params).toEqual({ entryId: "b" });
    expect(state.focusedInstanceId).toBe(first);
  });

  it("opens a second slot for the same surface only when split is asked for", () => {
    const first = openExpandedSurface({ surfaceId: "codex:reader", params: { entryId: "a" } });
    const second = openExpandedSurface({
      surfaceId: "codex:reader",
      params: { entryId: "b" },
      mode: "split",
    });

    expect(second).not.toBe(first);
    expect(getExpandedSurfaceState().instances).toHaveLength(2);
    expect(getExpandedSurfaceState().focusedInstanceId).toBe(second);
  });

  it("has no slot cap", () => {
    for (let index = 0; index < 12; index += 1) {
      openExpandedSurface({ surfaceId: `plugin:surface-${index}` });
    }
    expect(getExpandedSurfaceState().instances).toHaveLength(12);
  });

  it("gives a new slot the average of the widths already set", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });
    // 사용자가 첫 슬롯을 3배로 넓혀 둔 상태.
    setExpandedSurfaceWeights([900, 300]);

    openExpandedSurface({ surfaceId: "c" });

    const weights = getExpandedSurfaceState().instances.map((instance) => instance.weight);
    expect(weights).toEqual([900, 300, 600]);
  });

  it("inserts at a requested slot index", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });
    openExpandedSurface({ surfaceId: "c", slotIndex: 1 });

    expect(getExpandedSurfaceState().instances.map((i) => i.surfaceId)).toEqual(["a", "c", "b"]);
  });

  it("hands focus to the right-hand neighbour when the focused slot closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });
    const c = openExpandedSurface({ surfaceId: "c" });
    focusExpandedSurface(b);

    closeExpandedSurface(b);

    expect(getExpandedSurfaceState().focusedInstanceId).toBe(c);
    expect(getExpandedSurfaceState().instances.map((i) => i.instanceId)).toEqual([a, c]);
  });

  it("falls back to the left neighbour when the last slot closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });
    focusExpandedSurface(b);

    closeExpandedSurface(b);

    expect(getExpandedSurfaceState().focusedInstanceId).toBe(a);
  });

  it("clears focus when the last slot closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    closeExpandedSurface(a);
    expect(getExpandedSurfaceState().focusedInstanceId).toBeNull();
    expect(getExpandedSurfaceState().instances).toEqual([]);
  });

  it("keeps a non-focused slot's focus when a sibling closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });
    focusExpandedSurface(a);

    closeExpandedSurface(b);

    expect(getExpandedSurfaceState().focusedInstanceId).toBe(a);
  });

  it("refuses weights that do not match the slot count", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });

    setExpandedSurfaceWeights([100]);

    expect(getExpandedSurfaceState().instances.map((i) => i.weight)).toEqual([1, 1]);
  });

  it("ignores non-positive weights rather than collapsing a slot to nothing", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });

    setExpandedSurfaceWeights([0, -5]);

    expect(getExpandedSurfaceState().instances.map((i) => i.weight)).toEqual([1, 1]);
  });

  it("notifies subscribers only when something actually changed", () => {
    let notifications = 0;
    subscribeExpandedSurfaces(() => {
      notifications += 1;
    });

    const a = openExpandedSurface({ surfaceId: "a", params: { k: "v" } });
    expect(notifications).toBe(1);

    // 같은 params로 다시 열면 상태가 그대로다.
    openExpandedSurface({ surfaceId: "a", params: { k: "v" } });
    expect(notifications).toBe(1);

    replaceExpandedSurfaceParams(a, { k: "v" });
    expect(notifications).toBe(1);

    replaceExpandedSurfaceParams(a, { k: "w" });
    expect(notifications).toBe(2);

    focusExpandedSurface(a);
    expect(notifications).toBe(2);
  });

  it("reports and moves focus by slot index", () => {
    openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });

    expect(focusedExpandedSurfaceIndex()).toBe(1);

    focusExpandedSurfaceByIndex(0);
    expect(focusedExpandedSurfaceIndex()).toBe(0);

    // 없는 슬롯은 포커스를 흔들지 않는다.
    focusExpandedSurfaceByIndex(9);
    expect(focusedExpandedSurfaceIndex()).toBe(0);
    expect(getExpandedSurfaceState().instances[1]?.instanceId).toBe(b);
  });

  it("closes every slot at once", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });

    closeAllExpandedSurfaces();

    expect(getExpandedSurfaceState().instances).toEqual([]);
    expect(getExpandedSurfaceState().focusedInstanceId).toBeNull();
  });
});
