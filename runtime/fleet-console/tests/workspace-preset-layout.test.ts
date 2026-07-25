// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { getSnapshot as getCanvasSnapshot, loadForTheater, setState as setCanvasState } from "../core/client/src/canvas/canvas-store.js";
import { getRailStoreSnapshot, setActiveRailPanel, setRailChromeExpanded } from "../core/client/src/rail/rail-store.js";
import { getSideBarStatusAxis, setSideBarStatusAxis } from "../core/client/src/sidebar/operations-side-bar-store.js";
import type { WorkspacePresetApplyResult } from "../core/client/src/types.js";
import { applyWorkspacePresetClientLayout } from "../core/client/src/workspace-preset-layout.js";

describe("Workspace Preset client layout", () => {
  beforeEach(() => {
    window.localStorage.clear();
    loadForTheater("theater");
    setCanvasState({
      viewport: { x: 0, y: 0, zoom: 1 },
      operations: {
        "op-a": { x: 0, y: 0, width: 400, height: 300, zIndex: 1 },
        "op-new": { x: 30, y: 30, width: 500, height: 320, zIndex: 2 },
      },
      minimized: ["op-new"],
    });
    setActiveRailPanel("plans");
    setRailChromeExpanded(false);
    setSideBarStatusAxis(false);
  });

  it("partially applies core state, preserves the rail for an unavailable panel, and returns a warning", () => {
    const previousRail = getRailStoreSnapshot();
    const result = makeApplyResult("missing-plugin");

    const warning = applyWorkspacePresetClientLayout(result, ["op-a", "op-new"], new Set(["plans"]));

    expect(getCanvasSnapshot()).toMatchObject({
      viewport: { x: 12, y: -8, zoom: 0.8 },
      operations: {
        "op-a": { x: 100, y: 120, width: 640, height: 400, zIndex: 8 },
        "op-new": { x: 30, y: 30, width: 500, height: 320, zIndex: 2 },
      },
      minimized: ["op-a"],
    });
    expect(getSideBarStatusAxis()).toBe(true);
    expect(getRailStoreSnapshot()).toMatchObject({
      activeRailPanelId: previousRail.activeRailPanelId,
      railChromeExpanded: previousRail.railChromeExpanded,
      currentPanelWidth: previousRail.currentPanelWidth,
    });
    expect(warning).toBe("Panel “missing-plugin” is not installed; the current rail was preserved. 1 missing operation skipped.");
  });

  it("applies an installed panel and queues the preset width without mutating the preset", () => {
    const result = makeApplyResult("plans");

    const warning = applyWorkspacePresetClientLayout(result, ["op-a", "op-new"], new Set(["plans"]));

    expect(warning).toBe("1 missing operation skipped.");
    expect(getRailStoreSnapshot()).toMatchObject({
      activeRailPanelId: "plans",
      railChromeExpanded: true,
      presetPanelWidthRequest: { panelId: "plans", width: 520 },
    });
    expect(result.preset.layout.rail.panelWidth).toBe(520);
  });
});

function makeApplyResult(activePanelId: string): WorkspacePresetApplyResult {
  return {
    preset: {
      id: "preset",
      theaterId: "theater",
      name: "Review",
      createdAt: 1,
      updatedAt: 1,
      layout: {
        viewport: { x: 12, y: -8, zoom: 0.8 },
        operationGeometries: {
          "op-a": { x: 100, y: 120, width: 640, height: 400, zIndex: 8 },
          "op-missing": { x: 40, y: 40, width: 500, height: 320, zIndex: 3 },
        },
        minimizedOperationIds: ["op-a", "op-missing"],
        rail: { activePanelId, chromeExpanded: true, panelWidth: 520 },
        sidebar: { statusAxis: "status" },
      },
    },
    appliedOperationIds: ["op-a"],
    missingOperationIds: ["op-missing"],
  };
}
