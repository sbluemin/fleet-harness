import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { arrangeOperations, calculateGridSlots, clearFormationView, clearMaximizedOperationId, getFormationView, getMaximizedOperationId, getSnapshot, hasArrangeSnapshot, loadForTheater, minimizeOperation, pruneOperations, setMaximizedOperationId, setOperationAccent, setOperationGeometry, setOperationOrder, toggleFormationView, undoArrange, type OperationGeometry } from "../core/client/src/canvas/canvas-store.js";

const GEOMETRY: OperationGeometry = { x: 0, y: 0, width: 100, height: 100, zIndex: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    cancelAnimationFrame: vi.fn(),
    clearTimeout,
    localStorage: createStorage(),
    matchMedia: vi.fn().mockReturnValue({ matches: false }),
    requestAnimationFrame: vi.fn(),
    setTimeout,
  });
  window.localStorage.clear();
  loadForTheater("theater-a");
  clearMaximizedOperationId();
  clearFormationView();
});

afterEach(() => {
  loadForTheater("theater-a");
  clearMaximizedOperationId();
  clearFormationView();
  loadForTheater("theater-b");
  clearMaximizedOperationId();
  clearFormationView();
  loadForTheater(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("canvas store", () => {
  it("restores maximizedOperationId independently for each Theater", () => {
    setMaximizedOperationId("op-a");

    loadForTheater("theater-b");
    expect(getMaximizedOperationId()).toBeNull();
    setMaximizedOperationId("op-b");

    loadForTheater("theater-a");
    expect(getMaximizedOperationId()).toBe("op-a");

    loadForTheater("theater-b");
    expect(getMaximizedOperationId()).toBe("op-b");
  });

  it("does not clear another Theater's maximized Operation when pruning the active Theater", () => {
    setMaximizedOperationId("op-a");

    loadForTheater("theater-b");
    setMaximizedOperationId("missing");
    pruneOperations([]);
    expect(getMaximizedOperationId()).toBeNull();

    loadForTheater("theater-a");
    expect(getMaximizedOperationId()).toBe("op-a");
  });

  it("minimizes non-maximized Operations when a panel is maximized", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setOperationGeometry("op-c", { ...GEOMETRY });

    setMaximizedOperationId("op-b");

    expect(getMaximizedOperationId()).toBe("op-b");
    expect(getSnapshot().minimized).toEqual(["op-a", "op-c"]);
  });

  it("restores a minimized Operation when it becomes maximized", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-b");

    setMaximizedOperationId("op-b");

    expect(getMaximizedOperationId()).toBe("op-b");
    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("stores explicit Operation order and prunes stale Operation ids", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setOperationOrder(["op-b", "op-a", "op-b", "missing"]);

    expect(getSnapshot().operationOrder).toEqual(["op-b", "op-a", "missing"]);

    pruneOperations(["op-a"]);

    expect(getSnapshot().operationOrder).toEqual(["op-a"]);
  });

  it("sets, clears, and normalizes Operation accent metadata", () => {
    setOperationAccent("op-a", "blue");
    setOperationAccent("op-b", "");

    expect(getSnapshot().operationAccent).toEqual({ "op-a": "blue" });

    setOperationAccent("op-a", null);
    expect(getSnapshot().operationAccent).toEqual({});

    window.localStorage.setItem("fleet-console.canvas.theater-restore", JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      operations: { "op-a": GEOMETRY },
      operationOrder: ["op-a"],
      operationAccent: {
        "op-a": "rose",
        "op-b": 12,
        "op-c": null,
      },
      minimized: [],
    }));
    loadForTheater("theater-restore");

    expect(getSnapshot().operationAccent).toEqual({ "op-a": "rose" });
  });

  it("calculates balanced grid slots with minimum-size clamping and configured gaps", () => {
    const slots = calculateGridSlots({ x: 10, y: 20, width: 100, height: 100 }, 3, 320, 200, 16, 24);

    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({ x: 34, y: 44, width: 320, height: 200 });
    expect(slots[1]?.x).toBe(370);
    expect(slots[2]?.y).toBe(260);
  });

  it("stretches the last row across the full width so no empty cell remains", () => {
    const slots = calculateGridSlots({ x: 0, y: 0, width: 1000, height: 800 }, 3, 100, 100, 10, 0);

    expect(slots[0]).toEqual({ x: 0, y: 0, width: 495, height: 395 });
    expect(slots[1]).toEqual({ x: 505, y: 0, width: 495, height: 395 });
    expect(slots[2]).toEqual({ x: 0, y: 405, width: 1000, height: 395 });
  });

  it("arranges in one batch without changing relative z-order and undoes exact geometry", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 12, y: 14, width: 420, height: 260 });
    setOperationGeometry("op-b", { ...GEOMETRY, x: 80, y: 90, width: 500, height: 300 });
    const before = getSnapshot().operations;

    arrangeOperations(["op-b", "op-a"], { x: 0, y: 0, width: 1200, height: 800 });

    expect(getSnapshot().operations["op-a"]?.zIndex).toBe(before["op-a"]?.zIndex);
    expect(getSnapshot().operations["op-b"]?.zIndex).toBe(before["op-b"]?.zIndex);
    expect(hasArrangeSnapshot()).toBe(true);

    undoArrange();

    expect(getSnapshot().operations).toEqual(before);
    expect(hasArrangeSnapshot()).toBe(false);
  });

  it("keeps Formation view independent per Theater without modifying saved geometry", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 48, y: 72 });
    const beforeFormation = getSnapshot().operations;

    toggleFormationView();
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().operations).toEqual(beforeFormation);

    loadForTheater("theater-b");
    expect(getFormationView()).toBe(false);
    toggleFormationView();
    expect(getFormationView()).toBe(true);

    loadForTheater("theater-a");
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().operations).toEqual(beforeFormation);
  });
});

function createStorage(): Storage {
  let values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values = new Map();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}
