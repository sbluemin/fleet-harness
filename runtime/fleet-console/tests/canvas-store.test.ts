import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearMaximizedOperationId, getMaximizedOperationId, getSnapshot, loadForTheater, minimizeOperation, pruneOperations, setMaximizedOperationId, setOperationAccent, setOperationGeometry, setOperationOrder, type OperationGeometry } from "../core/client/src/canvas/canvas-store.js";

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
});

afterEach(() => {
  loadForTheater("theater-a");
  clearMaximizedOperationId();
  loadForTheater("theater-b");
  clearMaximizedOperationId();
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
