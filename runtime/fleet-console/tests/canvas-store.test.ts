import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calculateGridSlots, clearCompanionOperationId, clearFormationView, clearMaximizedOperationId, consumePendingFitAllOperations, ensureDefaultGeometry, fitAllOperations, forceDropCompanionOperationId, getCompanionOperationId, getCompanionPanelVisibilityOverrides, getFormationLayout, getFormationView, getMaximizedOperationId, getSnapshot, getStationKeeping, getTheaterCanvasSnapshot, loadForTheater, minimizeOperation, minimizeOperations, pruneOperations, requestFitAllOperations, resetCanvasViewportSize, resolveClearPosition, resolveLaunchGeometry, restoreOperation, selectFormationLayout, setCanvasViewportSize, setCompanionOperationId, setCompanionPanelVisible, setFormationLayout, setMaximizedOperationId, setOperationAccent, setOperationGeometry, setOperationOrder, setState, setStationKeeping, settleOperationGeometry, STATION_KEEPING_GAP, toggleFormationView, toggleTheaterGroupCollapsed, type OperationGeometry } from "../core/client/src/canvas/canvas-store.js";

const GEOMETRY: OperationGeometry = { x: 0, y: 0, width: 100, height: 100, zIndex: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    cancelAnimationFrame: vi.fn(),
    clearTimeout,
    localStorage: createStorage(),
    matchMedia: vi.fn().mockReturnValue({ matches: false }),
    setTimeout,
  });
  window.localStorage.clear();
  setFormationLayout("grid");
  loadForTheater("theater-a");
  clearCompanionOperationId();
  clearMaximizedOperationId();
  clearFormationView();
  resetCanvasViewportSize();
  setCanvasViewportSize({ width: 1_000, height: 800 });
});

afterEach(() => {
  loadForTheater("theater-a");
  clearCompanionOperationId();
  clearMaximizedOperationId();
  clearFormationView();
  loadForTheater("theater-b");
  clearCompanionOperationId();
  clearMaximizedOperationId();
  clearFormationView();
  loadForTheater(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("canvas store", () => {
  it("fits the visible Operation bounding box and centers it in the canvas", () => {
    setOperationGeometry("op-a", { x: 100, y: 200, width: 200, height: 100, zIndex: 0 });
    setOperationGeometry("op-b", { x: 500, y: 400, width: 300, height: 200, zIndex: 0 });

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual({ x: 50, y: 0, zoom: 1 });
  });

  it("zooms out far enough to fit widely scattered Operations", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: -5_000, y: -1_000 });
    setOperationGeometry("op-b", { ...GEOMETRY, x: 5_000, y: 1_000 });

    fitAllOperations();

    const { x, y, zoom } = getSnapshot().viewport;
    expect(zoom).toBeCloseTo(904 / 10_100, 10);
    expect(x).toBeCloseTo(500 - 50 * (904 / 10_100), 10);
    expect(y).toBeCloseTo(400 - 50 * (904 / 10_100), 10);
  });

  it("clamps fit zoom only at the numerical epsilon for extreme spreads", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: -50_000, y: -1_000 });
    setOperationGeometry("op-b", { ...GEOMETRY, x: 50_000, y: 1_000 });

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual({ x: 499, y: 399, zoom: 0.02 });
  });

  it("preserves an intermediate fit zoom between the lower and upper bounds", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 0, y: 0 });
    setOperationGeometry("op-b", { ...GEOMETRY, x: 1_900, y: 0 });

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual({ x: 48, y: 377.4, zoom: 0.452 });
  });

  it("clamps fit zoom to the 1 upper bound for a narrow Operation set", () => {
    setOperationGeometry("op-a", { x: 20, y: 30, width: 100, height: 80, zIndex: 0 });

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual({ x: 430, y: 330, zoom: 1 });
  });

  it("does not change the viewport when no visible Operations exist", () => {
    const viewport = { x: 12, y: 34, zoom: 0.75 };
    setState({ viewport });

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual(viewport);
  });

  it("excludes minimized Operations from the fit bounds", () => {
    setOperationGeometry("visible", { x: 20, y: 30, width: 100, height: 80, zIndex: 0 });
    setOperationGeometry("minimized", { x: 5_000, y: 4_000, width: 500, height: 400, zIndex: 0 });
    minimizeOperation("minimized");

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual({ x: 430, y: 330, zoom: 1 });
  });

  it("does not fit while Formation view is active", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 100, y: 200 });
    const viewport = { x: 12, y: 34, zoom: 0.75 };
    setState({ viewport });
    toggleFormationView();

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual(viewport);
  });

  it("does not fit while an Operation is maximized", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 100, y: 200 });
    const viewport = { x: 12, y: 34, zoom: 0.75 };
    setState({ viewport });
    setMaximizedOperationId("op-a");

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual(viewport);
  });

  it("does not fit while an Operation companion is active", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 100, y: 200 });
    const viewport = { x: 12, y: 34, zoom: 0.75 };
    setState({ viewport });
    setCompanionOperationId("op-a");

    fitAllOperations();

    expect(getSnapshot().viewport).toEqual(viewport);
  });

  it("preserves a pending fit until canvas size registration and then consumes it", () => {
    setOperationGeometry("op-a", { x: 20, y: 30, width: 100, height: 80, zIndex: 0 });
    resetCanvasViewportSize();

    requestFitAllOperations();
    expect(getSnapshot().viewport).toEqual({ x: 0, y: 0, zoom: 1 });

    setCanvasViewportSize({ width: 1_000, height: 800 });
    consumePendingFitAllOperations();
    expect(getSnapshot().viewport).toEqual({ x: 430, y: 330, zoom: 1 });
  });

  it("fits immediately when a valid canvas size is already registered", () => {
    setOperationGeometry("op-a", { x: 20, y: 30, width: 100, height: 80, zIndex: 0 });

    requestFitAllOperations();

    expect(getSnapshot().viewport).toEqual({ x: 430, y: 330, zoom: 1 });
  });

  it("keeps companion visibility overrides per Operation and resets them on Analyze entry", () => {
    setCompanionPanelVisible("op-a", "artifacts", true);
    setCompanionPanelVisible("op-b", "artifacts", false);

    expect(getCompanionPanelVisibilityOverrides("op-a")).toEqual({ artifacts: true });
    expect(getCompanionPanelVisibilityOverrides("op-b")).toEqual({ artifacts: false });

    setCompanionOperationId("op-a");
    expect(getCompanionPanelVisibilityOverrides("op-a")).toEqual({});
    expect(getCompanionPanelVisibilityOverrides("op-b")).toEqual({ artifacts: false });
  });

  it("clears companion visibility overrides on normal Exit and force-drop", () => {
    setCompanionOperationId("op-a");
    setCompanionPanelVisible("op-a", "artifacts", true);
    clearCompanionOperationId();
    expect(getCompanionPanelVisibilityOverrides("op-a")).toEqual({});

    setCompanionOperationId("op-b");
    setCompanionPanelVisible("op-b", "artifacts", false);
    forceDropCompanionOperationId();
    expect(getCompanionPanelVisibilityOverrides("op-b")).toEqual({});
  });

  it("clears the previous companion target's overrides on retarget and maximize replacement", () => {
    setCompanionOperationId("op-a");
    setCompanionPanelVisible("op-a", "artifacts", true);
    setCompanionOperationId("op-b");
    expect(getCompanionPanelVisibilityOverrides("op-a")).toEqual({});

    setCompanionPanelVisible("op-b", "artifacts", true);
    setMaximizedOperationId("op-c");
    expect(getCompanionPanelVisibilityOverrides("op-b")).toEqual({});
  });

  it("captures Map underlay once, retargets without mutating it, and exits to Map", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 48, y: 72 });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-a");
    const viewport = { x: 24, y: 36, zoom: 0.75 };
    setState({ viewport });
    const operations = getSnapshot().operations;
    setCompanionOperationId("op-a");
    setCompanionOperationId("op-b");

    expect(getCompanionOperationId()).toBe("op-b");
    expect(getMaximizedOperationId()).toBeNull();
    expect(getFormationView()).toBe(false);
    expect(getSnapshot().minimized).toEqual([]);
    expect(getSnapshot().viewport).toEqual(viewport);
    expect(getSnapshot().operations).toEqual(operations);

    clearCompanionOperationId();
    expect(getSnapshot().viewport).toEqual(viewport);
    expect(getSnapshot().operations).toEqual(operations);
  });

  it("preserves Formation as the underlay across retarget and normal Exit", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY, x: 120 });
    const operations = getSnapshot().operations;
    toggleFormationView();

    setCompanionOperationId("op-a");
    setCompanionOperationId("op-b");

    expect(getFormationView()).toBe(true);
    expect(getCompanionOperationId()).toBe("op-b");
    clearCompanionOperationId();
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().operations).toEqual(operations);
  });

  it("restores Maximized around the latest valid retarget on normal Exit", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setMaximizedOperationId("op-a");

    setCompanionOperationId("op-a");
    setCompanionOperationId("op-b");
    clearCompanionOperationId();

    expect(getCompanionOperationId()).toBeNull();
    expect(getMaximizedOperationId()).toBe("op-b");
  });

  it("does not restore Maximized after minimize, removal, or an explicit replacement", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setMaximizedOperationId("op-a");
    setCompanionOperationId("op-a");
    setCompanionOperationId("op-b");
    minimizeOperation("op-b");
    expect(getCompanionOperationId()).toBeNull();
    expect(getMaximizedOperationId()).toBeNull();

    setMaximizedOperationId("op-a");
    setCompanionOperationId("op-a");
    pruneOperations([]);
    clearCompanionOperationId();
    expect(getMaximizedOperationId()).toBeNull();

    setOperationGeometry("op-a", { ...GEOMETRY });
    setMaximizedOperationId("op-a");
    setCompanionOperationId("op-a");
    setMaximizedOperationId("op-b");
    expect(getCompanionOperationId()).toBeNull();
    expect(getMaximizedOperationId()).toBe("op-b");
  });

  it("force-drops Analyze without restoring", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setMaximizedOperationId("op-a");
    setCompanionOperationId("op-a");
    forceDropCompanionOperationId();
    expect(getMaximizedOperationId()).toBeNull();

  });

  it("keeps Formation active when same or different layout explicitly replaces Analyze", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    toggleFormationView();
    expect(getFormationLayout()).toBe("grid");

    setCompanionOperationId("op-a");
    selectFormationLayout("grid");
    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
    expect(getFormationLayout()).toBe("grid");

    setCompanionOperationId("op-a");
    selectFormationLayout("columns");
    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
    expect(getFormationLayout()).toBe("columns");
  });

  it("clears companion layout when maximize or Formation takes ownership", () => {
    setCompanionOperationId("op-a");
    setMaximizedOperationId("op-b");
    expect(getCompanionOperationId()).toBeNull();
    expect(getMaximizedOperationId()).toBe("op-b");

    setCompanionOperationId("op-a");
    toggleFormationView();
    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
  });

  it("keeps companion layout through a transient prune and clears it only when the target is minimized", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setCompanionOperationId("op-a");
    // ops 푸시 레이스로 목록에서 일시적으로 빠져도 즉시 닫지 않는다 — 지속 부재 정리는 캔버스 유예 효과 소유.
    pruneOperations([]);
    expect(getCompanionOperationId()).toBe("op-a");

    setOperationGeometry("op-a", { ...GEOMETRY });
    minimizeOperation("op-a");
    expect(getCompanionOperationId()).toBeNull();
  });

  it("keeps companion target and return mode scoped independently per Theater", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setMaximizedOperationId("op-a");
    setCompanionOperationId("op-a");
    // ops 동기화가 loadForTheater를 같은 Theater로 다시 불러도 열린 분석 레이아웃은 보존되어야 한다.
    loadForTheater("theater-a");
    expect(getCompanionOperationId()).toBe("op-a");

    loadForTheater("theater-b");
    expect(getCompanionOperationId()).toBeNull();
    setOperationGeometry("op-b", { ...GEOMETRY });
    toggleFormationView();
    setCompanionOperationId("op-b");

    loadForTheater("theater-a");
    expect(getCompanionOperationId()).toBe("op-a");
    clearCompanionOperationId();
    expect(getMaximizedOperationId()).toBe("op-a");

    loadForTheater("theater-b");
    expect(getCompanionOperationId()).toBe("op-b");
    clearCompanionOperationId();
    expect(getFormationView()).toBe(true);
  });

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

  it("keeps the actual minimized list and Formation under a render-only focus layer", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setOperationGeometry("op-c", { ...GEOMETRY });
    minimizeOperation("op-a");
    const viewport = { x: 48, y: 72, zoom: 0.8 };
    const operations = getSnapshot().operations;
    setState({ viewport });
    toggleFormationView();

    setMaximizedOperationId("op-b");

    expect(getMaximizedOperationId()).toBe("op-b");
    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["op-a"]);
    expect(getSnapshot().viewport).toEqual(viewport);
    expect(getSnapshot().operations).toEqual(operations);

    clearMaximizedOperationId();

    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("removes only the focused Operation from the actual minimized list", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-a");
    minimizeOperation("op-b");

    setMaximizedOperationId("op-b");

    expect(getMaximizedOperationId()).toBe("op-b");
    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("minimizes only the focused Operation and clears its focus layer", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-a");
    setMaximizedOperationId("op-b");

    minimizeOperation("op-b");

    expect(getMaximizedOperationId()).toBeNull();
    expect(getSnapshot().minimized).toEqual(["op-a", "op-b"]);
  });

  it("minimizes boot panels without changing their stored geometry", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 48, y: 72, zIndex: 4 });
    setOperationGeometry("op-b", { ...GEOMETRY, x: 96, y: 144, zIndex: 8 });
    const geometry = getSnapshot().operations;

    minimizeOperations(["op-a", "op-b", "missing"]);

    expect(getSnapshot().minimized).toEqual(["op-a", "op-b"]);
    expect(getSnapshot().operations).toEqual(geometry);
  });

  it("keeps existing minimized panels first when adding boot panels", () => {
    setOperationGeometry("launched", { ...GEOMETRY });
    setOperationGeometry("initial", { ...GEOMETRY });
    minimizeOperation("launched");

    minimizeOperations(["initial", "launched", "missing", "initial"]);

    expect(getSnapshot().minimized).toEqual(["launched", "initial"]);
  });

  it("does not minimize Operations added after boot initialization", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    minimizeOperations(["op-a"]);
    setOperationGeometry("op-b", { ...GEOMETRY });

    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("keeps boot-minimized panels and geometry scoped to their Theater", () => {
    setOperationGeometry("op-a", { ...GEOMETRY, x: 48, y: 72 });
    minimizeOperations(["op-a"]);

    loadForTheater("theater-b");
    setOperationGeometry("op-b", { ...GEOMETRY, x: 96, y: 144 });

    loadForTheater("theater-a");
    expect(getSnapshot().minimized).toEqual(["op-a"]);
    expect(getSnapshot().operations["op-a"]).toMatchObject({ x: 48, y: 72 });

    loadForTheater("theater-b");
    expect(getSnapshot().minimized).toEqual([]);
    expect(getSnapshot().operations["op-b"]).toMatchObject({ x: 96, y: 144 });
  });

  it("reads and toggles collapsed groups for an inactive Theater without changing the loaded canvas", () => {
    window.localStorage.setItem("fleet-console.canvas.theater-b", JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      operations: { "op-b": GEOMETRY },
      operationOrder: ["op-b"],
      operationAccent: { "op-b": "rose" },
      minimized: ["op-b"],
      collapsedGroups: ["group-b"],
    }));

    setOperationOrder(["op-a"]);
    expect(getTheaterCanvasSnapshot("theater-b")).toMatchObject({
      operationOrder: ["op-b"],
      operationAccent: { "op-b": "rose" },
      minimized: ["op-b"],
      collapsedGroups: ["group-b"],
    });

    toggleTheaterGroupCollapsed("theater-b", "group-b");

    expect(getSnapshot().operationOrder).toEqual(["op-a"]);
    expect(getTheaterCanvasSnapshot("theater-b").collapsedGroups).toEqual([]);
  });

  it("restores each Theater's collapsed groups across A → B → A", () => {
    toggleTheaterGroupCollapsed("theater-a", "group-a");

    loadForTheater("theater-b");
    toggleTheaterGroupCollapsed("theater-b", "group-b");
    expect(getSnapshot().collapsedGroups).toEqual(["group-b"]);

    loadForTheater("theater-a");
    expect(getSnapshot().collapsedGroups).toEqual(["group-a"]);
  });

  it("keeps Formation and actual minimized Operations when focusing a panel", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    setOperationGeometry("op-c", { ...GEOMETRY });
    minimizeOperation("op-a");
    toggleFormationView();
    setMaximizedOperationId("op-b");

    expect(getFormationView()).toBe(true);
    expect(getMaximizedOperationId()).toBe("op-b");
    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("keeps manually minimized Operations minimized when entering Formation", () => {
    setOperationGeometry("op-a", { ...GEOMETRY });
    setOperationGeometry("op-b", { ...GEOMETRY });
    minimizeOperation("op-b");

    toggleFormationView();

    expect(getFormationView()).toBe(true);
    expect(getSnapshot().minimized).toEqual(["op-b"]);
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

  it("calculates full-height columns with configured gap and padding", () => {
    const slots = calculateGridSlots({ x: 10, y: 20, width: 1000, height: 800 }, 5, 320, 200, 10, 20, "columns");

    expect(slots).toHaveLength(5);
    expect(slots[0]).toEqual({ x: 30, y: 40, width: 184, height: 760 });
    expect(slots[4]).toEqual({ x: 806, y: 40, width: 184, height: 760 });
  });

  it("calculates full-width rows with configured gap and padding", () => {
    const slots = calculateGridSlots({ x: 10, y: 20, width: 1000, height: 800 }, 5, 320, 200, 10, 20, "rows");

    expect(slots).toHaveLength(5);
    expect(slots[0]).toEqual({ x: 30, y: 40, width: 960, height: 144 });
    expect(slots[4]).toEqual({ x: 30, y: 656, width: 960, height: 144 });
  });

  it("quantifies the Formation frame padding without a HUD reserve at 1280x720", () => {
    const formationRect = { x: 0, y: 0, width: 1_280, height: 720 };
    const gridNine = calculateGridSlots(formationRect, 9, 320, 200, 8, 18, "grid");
    const gridTwelve = calculateGridSlots(formationRect, 12, 320, 200, 8, 18, "grid");
    const columnsThree = calculateGridSlots(formationRect, 3, 320, 200, 8, 18, "columns");
    const columnsFour = calculateGridSlots(formationRect, 4, 320, 200, 8, 18, "columns");
    const rowsThree = calculateGridSlots(formationRect, 3, 320, 200, 8, 18, "rows");
    const rowsFour = calculateGridSlots(formationRect, 4, 320, 200, 8, 18, "rows");

    expect(gridNine[0]).toMatchObject({ x: 18, y: 18, width: 409.3333333333333 });
    expect(gridNine[0]?.height).toBeCloseTo(222.666667);
    expect(gridTwelve[0]).toMatchObject({ x: 18, y: 18, width: 305 });
    expect(gridTwelve[0]?.height).toBeCloseTo(222.666667);
    expect(columnsThree[0]).toMatchObject({ width: 409.3333333333333, height: 684 });
    expect(columnsFour[0]).toMatchObject({ width: 305, height: 684 });
    expect(rowsThree[0]?.width).toBe(1_244);
    expect(rowsThree[0]?.height).toBeCloseTo(222.666667);
    expect(rowsFour[0]?.width).toBe(1_244);
    expect(rowsFour[0]?.height).toBe(165);
  });

  it("defaults Formation layout to grid and persists the global selection", () => {
    expect(getFormationLayout()).toBe("grid");

    setFormationLayout("columns");
    expect(getFormationLayout()).toBe("columns");
    expect(window.localStorage.getItem("fleet-console.formation-layout")).toBe("columns");

    loadForTheater("theater-b");
    expect(getFormationLayout()).toBe("columns");
  });

  it("selects a Formation layout to enter, switch, and exit Formation", () => {
    selectFormationLayout("columns");
    expect(getFormationView()).toBe(true);
    expect(getFormationLayout()).toBe("columns");

    selectFormationLayout("rows");
    expect(getFormationView()).toBe(true);
    expect(getFormationLayout()).toBe("rows");

    selectFormationLayout("rows");
    expect(getFormationView()).toBe(false);
    expect(getFormationLayout()).toBe("rows");
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

describe("station keeping", () => {
  const rect = (x: number, y: number, width = 100, height = 100): OperationGeometry => ({ x, y, width, height, zIndex: 0 });

  function expectAllVisibleClear(): void {
    const snapshot = getSnapshot();
    const visible = Object.entries(snapshot.operations)
      .filter(([id]) => !snapshot.minimized.includes(id))
      .map(([, geometry]) => geometry);
    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const a = visible[i]!;
        const b = visible[j]!;
        const clear = a.x + a.width + STATION_KEEPING_GAP <= b.x || b.x + b.width + STATION_KEEPING_GAP <= a.x
          || a.y + a.height + STATION_KEEPING_GAP <= b.y || b.y + b.height + STATION_KEEPING_GAP <= a.y;
        expect(clear, `panels ${i} and ${j} overlap: ${JSON.stringify([a, b])}`).toBe(true);
      }
    }
  }

  it("resolveClearPosition returns the target when it is already clear", () => {
    expect(resolveClearPosition(rect(0, 0), [rect(500, 500)])).toEqual({ x: 0, y: 0 });
  });

  it("resolveClearPosition finds the nearest clear spot honoring the gap", () => {
    // 장애물 (0,0,100,100) 위에 정확히 겹친 목표 — 최근접 해는 한 축으로 100+gap 만큼 밀린 자리다.
    const spot = resolveClearPosition(rect(0, 0), [rect(0, 0)]);
    const distance = Math.sqrt((spot.x - 0) ** 2 + (spot.y - 0) ** 2);
    expect(distance).toBeCloseTo(100 + STATION_KEEPING_GAP, 10);
  });

  it("enabling spreads overlapping panels and leaves them clear", () => {
    setOperationGeometry("op-a", rect(0, 0));
    setOperationGeometry("op-b", rect(40, 40));
    setOperationGeometry("op-c", rect(80, 80));

    setStationKeeping(true);

    expect(getStationKeeping()).toBe(true);
    expectAllVisibleClear();
  });

  it("anchors the z-top panel while lower panels absorb the spread displacement", () => {
    setOperationGeometry("op-a", rect(0, 0));
    setOperationGeometry("op-b", rect(40, 40));
    setOperationGeometry("op-c", rect(80, 80)); // 마지막 setOperationGeometry가 최상단 z를 가진다.
    const top = getSnapshot().operations["op-c"]!;

    setStationKeeping(true);

    const after = getSnapshot().operations["op-c"]!;
    expect({ x: after.x, y: after.y }).toEqual({ x: top.x, y: top.y });
    expectAllVisibleClear();
  });

  it("disabling moves nothing", () => {
    setOperationGeometry("op-a", rect(0, 0));
    setOperationGeometry("op-b", rect(40, 40));
    setStationKeeping(true);
    const spread = { ...getSnapshot().operations };

    setStationKeeping(false);

    expect(getStationKeeping()).toBe(false);
    expect(getSnapshot().operations).toEqual(spread);
  });

  it("settleOperationGeometry moves only the touched panel", () => {
    setOperationGeometry("op-a", rect(0, 0));
    setOperationGeometry("op-b", rect(400, 0));
    setStationKeeping(true);
    const anchor = getSnapshot().operations["op-b"]!;

    // 드래그 종료를 재현: op-a를 op-b 위로 옮긴 뒤 정착시킨다.
    setOperationGeometry("op-a", { ...getSnapshot().operations["op-a"]!, x: 410, y: 10 });
    settleOperationGeometry("op-a");

    expectAllVisibleClear();
    const settled = getSnapshot().operations["op-b"]!;
    expect({ x: settled.x, y: settled.y }).toEqual({ x: anchor.x, y: anchor.y });
  });

  it("settleOperationGeometry is a no-op while disabled", () => {
    setOperationGeometry("op-a", rect(0, 0));
    setOperationGeometry("op-b", rect(10, 10));

    settleOperationGeometry("op-a");

    expect(getSnapshot().operations["op-a"]).toMatchObject({ x: 0, y: 0 });
  });

  it("ensureDefaultGeometry lands hydrated panels clear of existing ones", () => {
    setOperationGeometry("op-a", rect(0, 0, 640, 400));
    setStationKeeping(true);

    // 캐스케이드 폴백(index×40)은 op-a와 겹치는 자리다 — 규율이 정착시켜야 한다.
    ensureDefaultGeometry("op-b");

    expectAllVisibleClear();
  });

  it("restoreOperation settles a panel whose spot was taken while minimized", () => {
    setOperationGeometry("op-a", rect(0, 0));
    setStationKeeping(true);
    minimizeOperation("op-a");
    setOperationGeometry("op-b", rect(0, 0));

    restoreOperation("op-a");

    expectAllVisibleClear();
  });

  it("resolveLaunchGeometry settles launch coordinates while enabled and passes them through while disabled", () => {
    setOperationGeometry("op-a", rect(0, 0));
    const launch = rect(10, 10);

    expect(resolveLaunchGeometry("theater-a", launch)).toEqual(launch);

    setStationKeeping(true);
    const settled = resolveLaunchGeometry("theater-a", launch);
    const clear = settled.x >= 100 + STATION_KEEPING_GAP || settled.y >= 100 + STATION_KEEPING_GAP
      || settled.x + settled.width + STATION_KEEPING_GAP <= 0 || settled.y + settled.height + STATION_KEEPING_GAP <= 0;
    expect(clear).toBe(true);
  });

  it("persists the flag per theater and round-trips through storage", () => {
    setStationKeeping(true);
    expect(getStationKeeping()).toBe(true);

    loadForTheater("theater-b");
    expect(getStationKeeping()).toBe(false);

    loadForTheater("theater-a");
    expect(getStationKeeping()).toBe(true);
  });

  it("normalizes stored state without the flag to disabled", () => {
    window.localStorage.setItem("fleet-console.canvas.theater-legacy", JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      operations: { "op-a": rect(0, 0) },
    }));

    loadForTheater("theater-legacy");

    expect(getStationKeeping()).toBe(false);
  });

  it("loadForTheater restores the invariant when external writes left overlaps", () => {
    // 규율이 켜진 Theater의 저장본에 규율 밖 쓰기(War Room 지도 이동 등)가 겹침을 남긴 상황.
    window.localStorage.setItem("fleet-console.canvas.theater-drifted", JSON.stringify({
      viewport: { x: 0, y: 0, zoom: 1 },
      operations: { "op-a": rect(0, 0), "op-b": rect(20, 20) },
      stationKeeping: true,
    }));

    loadForTheater("theater-drifted");

    expect(getStationKeeping()).toBe(true);
    expectAllVisibleClear();
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
