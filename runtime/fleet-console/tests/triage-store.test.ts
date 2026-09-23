// @vitest-environment jsdom

import { operationRuntimeVisual, runtimeStateVisual } from "../features/execution/client/operation-activity.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";

import {
  acknowledgeIdleArrival,
  clearIdleArrival,
  getIdleArrivalIds,
  markIdleArrival,
  resetIdleArrivalForTests,
} from "../features/execution/client/operation-marks.js";
import { clearOperationRuntime, focusOperation, getState, requestOperationLaunchMenu, setActiveOperation, setActiveTheater, setOperationRuntime, setOperationRuntimeClusters, setState as setConsoleState } from "../core/client/src/integration/store.js";
import {
  clearFormationView,
  forceDropCompanionOperationId,
  getCompanionOperationId,
  clearMaximizedOperationId,
  getFormationView,
  getMaximizedOperationId,
  getTheaterFocusLayerSnapshot,
  loadForTheater,
  minimizeOperation,
  setMaximizedOperationId,
  setCompanionOperationId,
  setOperationGeometry,
  setTheaterFocusLayerSnapshot,
  toggleFormationView,
} from "../features/workspace/client/canvas/canvas-store.js";
import {
  requestSideBarOperationAction,
  subscribeSideBarOperationAction,
} from "../features/workspace/client/sidebar/interaction.js";
import { resetSideBarStatusSectionCollapseForTests, setSideBarCollapsed, subscribeOperationActivityTracking } from "../features/workspace/client/sidebar/operations-side-bar-store.js";
import {
  armTriageSetAside,
  clampTriageDeckZoom,
  deferTriageOperation,
  disarmTriageSetAside,
  dismissTriageOperation,
  enterTriage,
  focusedTriageOperationId,
  forgetTriageOperation,
  getActiveAwaitingClaimId,
  getTriageDeckZoom,
  getTriagePick,
  getTriageSetAsideArmedId,
  isTriageActive,
  isTriageClearedTransition,
  isTriageOperationDeferred,
  isTriageOperationDismissed,
  isTriageSpotlightEnabled,
  markTriageCleared,
  nextTriageDeckZoomPreset,
  pickTriageOperation,
  recordTriageActivity,
  recordTriageStageTheater,
  reconcileTriageStageCompanion,
  releaseInactiveActiveAwaitingClaim,
  resetTriageDeckZoomForTests,
  resetTriageSpotlightForTests,
  resetTriageTheater,
  resolveActiveAwaitingTriageEntry,
  resolveTriageQueue,
  scheduleTriageClear,
  setTriageActive,
  setTriageDeckZoom,
  setTriageSpotlightEnabled,
  subscribeTriage,
  visitTriageTheater,
} from "../features/workspace/client/canvas/triage-store.js";
import { resolveTriageSideBarSections, TriageSideBar } from "../features/workspace/client/sidebar/triage-side-bar.js";
import type { OperationNode } from "../core/client/src/integration/types.js";
import { TriageClearPlate } from "../features/workspace/client/canvas/canvas-overlays.js";
import { resolveTriageDeckPromotion, TRIAGE_DECK_ARRIVAL_DWELL_MS, TriageWatchDeck, useTriageDeckZoomControl, type TriageDeckZoomControl } from "../features/workspace/client/canvas/triage-watch-deck.js";
import { triageStageGeometryFor } from "../features/workspace/client/canvas/coordinates.js";
import { getOperationStatusDetailSnapshot, recordOperationActivityTransition, setOperationStatusDetail } from "../features/execution/client/operation-marks.js";

const THEATER_ID = "theater-a";
const THEATERS = [
  { id: "theater-a", label: "Alpha" },
  { id: "theater-b", label: "Beta" },
];
const OPERATIONS = [operation("picked", 1), operation("next", 2)];
let triagePlateRoot: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  window.localStorage.clear();
  loadForTheater(THEATER_ID);
  resetIdleArrivalForTests();
  setConsoleState({
    operations: [],
    activeTheaterId: null,
    activeOperationId: null,
    activeOperationAcknowledged: true,
    operationRuntime: {},
  });
  setTriageActive(false);
  resetTriageSpotlightForTests();
  resetTriageDeckZoomForTests();
  resetIdleArrivalForTests();
  resetSideBarStatusSectionCollapseForTests();
  clearFormationView();
  clearMaximizedOperationId();
  forceDropCompanionOperationId();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  setTriageActive(false);
  resetTriageSpotlightForTests();
  resetTriageDeckZoomForTests();
  forceDropCompanionOperationId();
  clearFormationView();
  clearMaximizedOperationId();
  loadForTheater(null);
  if (triagePlateRoot) {
    act(() => triagePlateRoot?.unmount());
    triagePlateRoot = null;
  }
  document.body.replaceChildren();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  vi.useRealTimers();
});

describe("triage store", () => {
  it("keeps a Chef off the idle arrival and triage queue until its live step stops", () => {
    const chef = operation("chef", 1);
    const step = operation("step", 2);
    setConsoleState({ operations: [chef, step], activeTheaterId: THEATER_ID, activeOperationId: null });
    setOperationRuntimeClusters([{ id: "todo:item", theaterId: THEATER_ID, title: "Item", root: chef.id, members: [
      { operationId: step.id, label: "Step", after: [], progress: "running" },
      { operationId: "pending", pending: true, label: "Next", after: [], progress: "open" },
    ] }]);
    const off = subscribeOperationActivityTracking();
    try {
      setOperationRuntime(chef.id, { lifecycle: "live", activity: "running" });
      setOperationRuntime(step.id, { lifecycle: "live", activity: "running" });
      setOperationRuntime(chef.id, { lifecycle: "live", activity: "idle" });
      expect(getState().operationRuntime[chef.id]).toEqual({ lifecycle: "live", activity: "background" });
      expect(getIdleArrivalIds().has(chef.id)).toBe(false);
      expect(resolveTriageQueue([chef], getState().operationRuntime)).toEqual([]);

      setOperationRuntime(step.id, { lifecycle: "live", activity: "awaiting" });
      expect(getState().operationRuntime[chef.id]).toEqual({ lifecycle: "live", activity: "awaiting" });
      expect(getState().operationRuntime[step.id]).toEqual({ lifecycle: "live", activity: "awaiting" });
      expect(resolveTriageQueue([chef], getState().operationRuntime).map((entry) => entry.operation.id)).toEqual([chef.id]);

      const unchangedRuntime = getState().operationRuntime;
      setOperationRuntimeClusters([{ id: "todo:item", theaterId: THEATER_ID, title: "Renamed", root: chef.id, members: [
        { operationId: step.id, label: "Step", after: [], progress: "awaiting" },
        { operationId: "pending", pending: true, label: "Next", after: [], progress: "open" },
      ] }]);
      expect(getState().operationRuntime).toBe(unchangedRuntime);

      setOperationRuntime(step.id, { lifecycle: "live", activity: "idle" });
      expect(getState().operationRuntime[chef.id]).toEqual({ lifecycle: "live", activity: "idle" });
      expect(getIdleArrivalIds().has(chef.id)).toBe(true);
      expect(resolveTriageQueue([chef], getState().operationRuntime).map((entry) => entry.operation.id)).toEqual([chef.id]);
    } finally {
      off();
      setOperationRuntimeClusters([]);
      clearOperationRuntime(chef.id);
      clearOperationRuntime(step.id);
      resetIdleArrivalForTests();
    }
  });

  it("keeps Formation view and Triage mutually exclusive in both directions", () => {
    toggleFormationView();
    expect(getFormationView()).toBe(true);

    setTriageActive(true);
    expect(isTriageActive()).toBe(true);
    expect(getFormationView()).toBe(false);

    setTriageActive(false);
    setOperationGeometry("picked", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setTriageActive(true);
    toggleFormationView();
    expect(getFormationView()).toBe(true);
    expect(isTriageActive()).toBe(false);
    expect(getMaximizedOperationId()).toBeNull();
  });

  it("acknowledges only the active Operation when Triage exits", () => {
    const active = operation("active", 1);
    const waiting = operation("waiting", 2);
    markIdleArrival(active.id);
    markIdleArrival(waiting.id);
    setConsoleState({
      operations: [active, waiting],
      activeTheaterId: THEATER_ID,
      activeOperationId: active.id,
      activeOperationAcknowledged: false,
    });
    setTriageActive(true);

    setTriageActive(false);

    expect(getIdleArrivalIds().has(active.id)).toBe(false);
    expect(getIdleArrivalIds().has(waiting.id)).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(true);
  });

  it("advances the queue when a Theater forget clears its owned pick", () => {
    const alpha = operation("alpha", 1);
    const beta = operation("beta", 2, "theater-b");
    const operations = [alpha, beta];
    const status: Readonly<Record<string, OperationRuntimeState>> = { alpha: { lifecycle: "live", activity: "awaiting" }, beta: { lifecycle: "live", activity: "awaiting" } };
    setConsoleState({ operations, activeTheaterId: THEATER_ID, operationRuntime: status });
    recordTriageActivity(operations, status, 1_000);
    setTriageActive(true);
    pickTriageOperation("beta");
    expect(resolveTriageQueue(operations, status, 1_000)[0]?.operation.id).toBe("beta");

    resetTriageTheater("theater-b");

    expect(getTriagePick()).toBeNull();
    expect(resolveTriageQueue(operations, status, 1_000)[0]?.operation.id).toBe("alpha");
    expect(isTriageActive()).toBe(true);
  });

});

// 기본 픽스처는 활동 축의 대역이다 — Shell 점은 활동 is-*를 아예 달지 않으므로, 상태 색·링을
// 재는 픽스처는 에이전트여야 한다(Shell 점 사례는 전용 테스트가 따로 있다).
function operation(id: string, createdAt: number, theaterId = THEATER_ID, type = "agent"): OperationNode {
  return {
    id,
    theaterId,
    type,
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt, updatedAt: createdAt },
  };
}
