import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateGridSlots, clearFormationView, clearMaximizedOperationId, getFormationView, getMaximizedOperationId, getSnapshot, loadForTheater, minimizeOperation, pruneOperations, setMaximizedOperationId, setOperationAccent, setOperationGeometry, setOperationOrder, toggleFormationView, type OperationGeometry } from "../core/client/src/canvas/canvas-store.js";

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

  it("keeps maximize-docked Operations minimized when entering open-panel Formation", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setOperationGeometry("op-c", { ...GEOMETRY });
    setMaximizedOperationId("op-b");

    toggleFormationView();

    expect(getFormationView()).toBe(true);
    expect(getMaximizedOperationId()).toBeNull();
    expect(getSnapshot().minimized).toEqual(["op-a", "op-c"]);
  });

  it("restores maximize-docked Operations when entering Formation with restoreMinimized", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setOperationGeometry("op-c", { ...GEOMETRY });
    setMaximizedOperationId("op-b");

    toggleFormationView({ restoreMinimized: true });

    expect(getFormationView()).toBe(true);
    expect(getMaximizedOperationId()).toBeNull();
    expect(getSnapshot().minimized).toEqual([]);
  });

  it("keeps manually minimized Operations minimized when entering Formation", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-b");

    toggleFormationView();

    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["op-b"]);
  });

  it("restores every minimized Operation when entering Formation with restoreMinimized", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-b");

    toggleFormationView({ restoreMinimized: true });

    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual([]);
  });

  it("adds minimized Operations to active Formation when restoreMinimized is requested", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-b");
    toggleFormationView();

    toggleFormationView({ restoreMinimized: true });

    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual([]);
  });

  it("exits active Formation when restoreMinimized is requested with no minimized Operations", () => {
    toggleFormationView();

    toggleFormationView({ restoreMinimized: true });

    expect(getFormationView()).toBe(false);
  });

  it("exits active Formation when toggled without options", () => {
    toggleFormationView();

    toggleFormationView();

    expect(getFormationView()).toBe(false);
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

  it("calculates balanced grid slots with configured gap and padding", () => {
    const slots = calculateGridSlots({ x: 10, y: 20, width: 100, height: 100 }, 3, 320, 200, 16, 24);

    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({ x: 34, y: 44, width: 18, height: 18 });
    expect(slots[1]?.x).toBe(68);
    expect(slots[2]).toEqual({ x: 34, y: 78, width: 52, height: 18 });
  });

  it("stretches the last row across the full width so no empty cell remains", () => {
    const slots = calculateGridSlots({ x: 0, y: 0, width: 1000, height: 800 }, 3, 100, 100, 10, 0);

    expect(slots[0]).toEqual({ x: 0, y: 0, width: 495, height: 395 });
    expect(slots[1]).toEqual({ x: 505, y: 0, width: 495, height: 395 });
    expect(slots[2]).toEqual({ x: 0, y: 405, width: 1000, height: 395 });
  });

  it("caps the effective minimum size to a narrow canvas", () => {
    const [slot] = calculateGridSlots({ x: 0, y: 0, width: 300, height: 250 }, 1);

    expect(slot).toEqual({ x: 0, y: 0, width: 300, height: 250 });
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
