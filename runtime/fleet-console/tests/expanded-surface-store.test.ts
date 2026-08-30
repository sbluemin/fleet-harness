import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindExpandedSurfaceCloseNotifier,
  closeAllExpandedSurfaces,
  closeExpandedSurfacesOf,
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

  it("reuses a surface's pane instead of stacking one per document", () => {
    const first = openExpandedSurface({ surfaceId: "codex:reader", params: { entryId: "a" } });
    const second = openExpandedSurface({ surfaceId: "codex:reader", params: { entryId: "b" } });

    expect(second).toBe(first);
    const state = getExpandedSurfaceState();
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0]?.params).toEqual({ entryId: "b" });
    expect(state.focusedInstanceId).toBe(first);
  });

  it("opens a second pane for the same surface only when split is asked for", () => {
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

  it("has no pane cap", () => {
    for (let index = 0; index < 12; index += 1) {
      openExpandedSurface({ surfaceId: `plugin:surface-${index}` });
    }
    expect(getExpandedSurfaceState().instances).toHaveLength(12);
  });

  it("gives a new pane the average of the widths already set", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });
    // 사용자가 첫 슬롯을 3배로 넓혀 둔 상태.
    setExpandedSurfaceWeights([900, 300]);

    openExpandedSurface({ surfaceId: "c" });

    const weights = getExpandedSurfaceState().instances.map((instance) => instance.weight);
    expect(weights).toEqual([900, 300, 600]);
  });

  it("inserts at a requested pane index", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });
    openExpandedSurface({ surfaceId: "c", paneIndex: 1 });

    expect(getExpandedSurfaceState().instances.map((i) => i.surfaceId)).toEqual(["a", "c", "b"]);
  });

  it("hands focus to the right-hand neighbour when the focused pane closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });
    const c = openExpandedSurface({ surfaceId: "c" });
    focusExpandedSurface(b);

    closeExpandedSurface(b);

    expect(getExpandedSurfaceState().focusedInstanceId).toBe(c);
    expect(getExpandedSurfaceState().instances.map((i) => i.instanceId)).toEqual([a, c]);
  });

  it("falls back to the left neighbour when the last pane closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });
    focusExpandedSurface(b);

    closeExpandedSurface(b);

    expect(getExpandedSurfaceState().focusedInstanceId).toBe(a);
  });

  it("clears focus when the last pane closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    closeExpandedSurface(a);
    expect(getExpandedSurfaceState().focusedInstanceId).toBeNull();
    expect(getExpandedSurfaceState().instances).toEqual([]);
  });

  it("keeps a non-focused pane's focus when a sibling closes", () => {
    const a = openExpandedSurface({ surfaceId: "a" });
    const b = openExpandedSurface({ surfaceId: "b" });
    focusExpandedSurface(a);

    closeExpandedSurface(b);

    expect(getExpandedSurfaceState().focusedInstanceId).toBe(a);
  });

  it("refuses weights that do not match the pane count", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });

    setExpandedSurfaceWeights([100]);

    expect(getExpandedSurfaceState().instances.map((i) => i.weight)).toEqual([1, 1]);
  });

  it("ignores non-positive weights rather than collapsing a pane to nothing", () => {
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

  it("reports and moves focus by pane index", () => {
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

  it("closes every pane at once", () => {
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });

    closeAllExpandedSurfaces();

    expect(getExpandedSurfaceState().instances).toEqual([]);
    expect(getExpandedSurfaceState().focusedInstanceId).toBeNull();
  });
});

describe("expanded surface close notification", () => {
  // 닫기는 호스트가 소유하지만, "내가 확대되어 있다"를 함께 들고 있는 표면은 그 사실을
  // 되돌릴 기회가 필요하다. 통보가 없으면 슬롯은 사라졌는데 표면은 확대 중이라 믿어,
  // 축소 화면도 슬롯도 없는 막다른 골목이 된다(Codex Expand 복귀 불가).
  it("tells the surface which instance the host closed", () => {
    const closed = vi.fn();
    bindExpandedSurfaceCloseNotifier(closed);
    const instanceId = openExpandedSurface({ surfaceId: "codex", params: { entryId: "tide-model" } });

    closeExpandedSurface(instanceId);

    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith({
      surfaceId: "codex",
      instanceId,
      params: { entryId: "tide-model" },
    });
  });

  it("has already removed the pane by the time the surface hears about it", () => {
    let openAtNotice: number | null = null;
    bindExpandedSurfaceCloseNotifier(() => {
      openAtNotice = getExpandedSurfaceState().instances.length;
    });
    const instanceId = openExpandedSurface({ surfaceId: "codex" });

    closeExpandedSurface(instanceId);

    expect(openAtNotice).toBe(0);
  });

  it("announces every pane when the host closes them all", () => {
    const closed = vi.fn();
    bindExpandedSurfaceCloseNotifier(closed);
    openExpandedSurface({ surfaceId: "codex" });
    openExpandedSurface({ surfaceId: "shell" });

    closeAllExpandedSurfaces();

    expect(closed.mock.calls.map(([ctx]) => ctx.surfaceId).sort()).toEqual(["codex", "shell"]);
  });

  it("keeps one surface's failure from swallowing the next pane's notice", () => {
    const seen: string[] = [];
    bindExpandedSurfaceCloseNotifier((ctx) => {
      seen.push(ctx.surfaceId);
      if (ctx.surfaceId === "codex") throw new Error("surface blew up");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    openExpandedSurface({ surfaceId: "codex" });
    openExpandedSurface({ surfaceId: "shell" });

    closeAllExpandedSurfaces();

    expect(seen).toEqual(["codex", "shell"]);
  });

  it("stays quiet when the instance was already gone", () => {
    const closed = vi.fn();
    bindExpandedSurfaceCloseNotifier(closed);

    closeExpandedSurface("codex#404");

    expect(closed).not.toHaveBeenCalled();
  });
});

describe("closing a surface by its own id", () => {
  // 플러그인은 자기 인스턴스 id를 들고 있지 않다. 표면 id를 `closeExpandedSurface`에
  // 넘기면 인스턴스 id(`codex#1`)와 맞지 않아 조용히 아무 일도 일어나지 않아, 빈 슬롯이
  // 캔버스에 남는다 — Codex의 접기가 실제로 이 함정에 빠져 있었다.
  it("closes the pane that the instance-keyed door leaves standing", () => {
    openExpandedSurface({ surfaceId: "codex", params: { entryId: "tide-model" } });

    closeExpandedSurface("codex");
    expect(getExpandedSurfaceState().instances).toHaveLength(1);

    closeExpandedSurfacesOf("codex");
    expect(getExpandedSurfaceState().instances).toHaveLength(0);
  });

  it("leaves every other surface where it stands", () => {
    openExpandedSurface({ surfaceId: "codex" });
    const shell = openExpandedSurface({ surfaceId: "shell" });

    closeExpandedSurfacesOf("codex");

    expect(getExpandedSurfaceState().instances.map((instance) => instance.instanceId)).toEqual([shell]);
    expect(getExpandedSurfaceState().focusedInstanceId).toBe(shell);
  });

  it("announces each pane it closed", () => {
    const closed = vi.fn();
    bindExpandedSurfaceCloseNotifier(closed);
    openExpandedSurface({ surfaceId: "codex", params: { entryId: "a" } });
    openExpandedSurface({ surfaceId: "codex", params: { entryId: "b" }, mode: "split" });

    closeExpandedSurfacesOf("codex");

    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when that surface has no pane", () => {
    const closed = vi.fn();
    bindExpandedSurfaceCloseNotifier(closed);
    const shell = openExpandedSurface({ surfaceId: "shell" });

    closeExpandedSurfacesOf("codex");

    expect(getExpandedSurfaceState().instances.map((instance) => instance.instanceId)).toEqual([shell]);
    expect(closed).not.toHaveBeenCalled();
  });
});
