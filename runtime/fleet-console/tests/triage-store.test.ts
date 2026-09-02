// @vitest-environment jsdom

import { operationRuntimeVisual, runtimeStateVisual } from "../core/client/src/operation-activity.js";
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
} from "../core/client/src/operation-marks.js";
import { focusOperation, getState, requestOperationLaunchMenu, setActiveOperation, setActiveTheater, setState as setConsoleState } from "../core/client/src/store.js";
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
} from "../core/client/src/canvas/canvas-store.js";
import {
  requestSideBarOperationAction,
  subscribeSideBarOperationAction,
} from "../core/client/src/sidebar/interaction.js";
import { resetSideBarStatusSectionCollapseForTests, setSideBarCollapsed } from "../core/client/src/sidebar/operations-side-bar-store.js";
import { OperationBodyPool } from "../core/client/src/mobile/operation-body-pool.js";
import { createHostCapabilities } from "../core/client/src/plugin-capabilities.js";
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
} from "../core/client/src/canvas/triage-store.js";
import { resolveTriageSideBarSections, TriageSideBar } from "../core/client/src/sidebar/triage-side-bar.js";
import type { OperationNode } from "../core/client/src/types.js";
import { TriageClearPlate } from "../core/client/src/canvas/canvas-overlays.js";
import { resolveTriageDeckPromotion, TRIAGE_DECK_ARRIVAL_DWELL_MS, TriageWatchDeck, useTriageDeckZoomControl, type TriageDeckZoomControl } from "../core/client/src/canvas/triage-watch-deck.js";
import { triageStageGeometryFor } from "../core/client/src/canvas/coordinates.js";
import { getOperationStatusDetailSnapshot, recordOperationActivityTransition, setOperationStatusDetail } from "../core/client/src/operation-marks.js";

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
  it("keeps the spotlight on by default, persists off, and resets cleanly", () => {
    expect(isTriageSpotlightEnabled()).toBe(true);

    setTriageSpotlightEnabled(false);
    expect(isTriageSpotlightEnabled()).toBe(false);
    expect(window.localStorage.getItem("fleet-console-triage-spotlight")).toBe("0");

    setTriageSpotlightEnabled(true);
    expect(isTriageSpotlightEnabled()).toBe(true);
    expect(window.localStorage.getItem("fleet-console-triage-spotlight")).toBeNull();

    setTriageSpotlightEnabled(false);
    resetTriageSpotlightForTests();
    expect(isTriageSpotlightEnabled()).toBe(true);
    expect(window.localStorage.getItem("fleet-console-triage-spotlight")).toBeNull();
  });

  it("arms the first set-aside press and dismisses only on the second press", () => {
    const pressSetAside = () => {
      if (getTriageSetAsideArmedId() === "picked") {
        disarmTriageSetAside();
        dismissTriageOperation("picked");
      } else {
        armTriageSetAside("picked");
      }
    };

    pressSetAside();
    expect(getTriageSetAsideArmedId()).toBe("picked");
    expect(isTriageOperationDismissed("picked")).toBe(false);

    pressSetAside();
    expect(getTriageSetAsideArmedId()).toBeNull();
    expect(isTriageOperationDismissed("picked")).toBe(true);
  });

  it("disarms set-aside after 1500ms", () => {
    armTriageSetAside("picked");

    vi.advanceTimersByTime(1_499);
    expect(getTriageSetAsideArmedId()).toBe("picked");
    vi.advanceTimersByTime(1);
    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("disarms set-aside when the Triage stage changes", () => {
    armTriageSetAside("picked");
    deferTriageOperation("picked");
    expect(getTriageSetAsideArmedId()).toBeNull();

    armTriageSetAside("picked");
    pickTriageOperation("next");
    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("keeps set-aside armed while an unrelated Operation changes activity", () => {
    const status: Record<string, OperationRuntimeState> = { picked: { lifecycle: "live", activity: "awaiting" }, next: { lifecycle: "live", activity: "awaiting" } };
    recordTriageActivity(OPERATIONS, status);
    armTriageSetAside("picked");

    recordTriageActivity(OPERATIONS, { ...status, next: { lifecycle: "live", activity: "running" } });

    expect(getTriageSetAsideArmedId()).toBe("picked");
  });

  it("disarms set-aside once its own Operation stops waiting", () => {
    const status: Record<string, OperationRuntimeState> = { picked: { lifecycle: "live", activity: "awaiting" }, next: { lifecycle: "live", activity: "awaiting" } };
    recordTriageActivity(OPERATIONS, status);
    armTriageSetAside("picked");

    recordTriageActivity(OPERATIONS, { ...status, picked: { lifecycle: "live", activity: "running" } });

    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("disarms set-aside when Triage exits or its armed Operation's Theater is forgotten", () => {
    setTriageActive(true);
    armTriageSetAside("picked");
    setTriageActive(false);
    expect(getTriageSetAsideArmedId()).toBeNull();

    recordTriageActivity(OPERATIONS, { picked: { lifecycle: "live", activity: "awaiting" }, next: { lifecycle: "live", activity: "awaiting" } });
    armTriageSetAside("picked");
    resetTriageTheater(THEATER_ID);
    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("removes a picked stage after its waiting activity clears and advances the next item", () => {
    const waiting: Readonly<Record<string, OperationRuntimeState>> = {
      picked: { lifecycle: "live", activity: "awaiting" },
      next: { lifecycle: "live", activity: "idle" },
    };
    markIdleArrival("next");
    recordTriageActivity(OPERATIONS, waiting, 1_000);
    pickTriageOperation("picked");

    const initialQueue = resolveTriageQueue(OPERATIONS, waiting, 1_000);
    expect(initialQueue.map((entry) => entry.operation.id)).toEqual(["picked", "next"]);

    const running: Readonly<Record<string, OperationRuntimeState>> = {
      ...waiting,
      picked: { lifecycle: "live", activity: "running" },
    };
    recordTriageActivity(OPERATIONS, running, 2_000);
    expect(isTriageClearedTransition(initialQueue[0]!.activity, "running")).toBe(true);
    markTriageCleared("picked");

    const advancedQueue = resolveTriageQueue(OPERATIONS, running, 2_000);
    expect(getTriagePick()).toBeNull();
    expect(advancedQueue.map((entry) => entry.operation.id)).toEqual(["next"]);
    expect(advancedQueue[0]?.operation.id).toBe("next");
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

  it("enters with no pick, active Operation, or canvas focus when the focused Operation is running", () => {
    const running = operation("running", 1);
    const frame = document.createElement("article");
    frame.className = "canvas-operation";
    frame.dataset.operationId = running.id;
    const input = document.createElement("input");
    frame.append(input);
    document.body.append(frame);
    input.focus();
    setConsoleState({
      operations: [running],
      activeTheaterId: THEATER_ID,
      activeOperationId: running.id,
      activeOperationAcknowledged: true,
      operationRuntime: { [running.id]: { lifecycle: "live", activity: "running" } },
    });

    const focusedOperationId = focusedTriageOperationId(document.activeElement);
    expect(focusedOperationId).toBe(running.id);
    enterTriage(focusedOperationId);

    const state = getState();
    expect(resolveTriageQueue([running], state.operationRuntime)).toHaveLength(0);
    expect(getTriagePick()).toBeNull();
    expect(state.activeOperationId).toBeNull();
    expect(document.activeElement).not.toBe(input);
  });

  it("picks a focused awaiting Operation as the queue head on entry", () => {
    const awaiting = operation("awaiting", 1);
    const later = operation("later", 2);
    const operationRuntime: Readonly<Record<string, OperationRuntimeState>> = {
      awaiting: { lifecycle: "live", activity: "awaiting" },
      later: { lifecycle: "live", activity: "awaiting" },
    };
    setConsoleState({ operations: [later, awaiting], operationRuntime });

    enterTriage(awaiting.id);

    expect(getTriagePick()).toBe(awaiting.id);
    expect(resolveTriageQueue([later, awaiting], operationRuntime)[0]?.operation.id)
      .toBe(awaiting.id);
  });

  it("picks a focused idle arrival on entry", () => {
    const arrived = operation("arrived", 1);
    const operationRuntime: Readonly<Record<string, OperationRuntimeState>> = { arrived: { lifecycle: "live", activity: "idle" } };
    markIdleArrival(arrived.id);
    setConsoleState({ operations: [arrived], operationRuntime });

    enterTriage(arrived.id);

    expect(getTriagePick()).toBe(arrived.id);
    expect(resolveTriageQueue([arrived], operationRuntime)[0]?.operation.id)
      .toBe(arrived.id);
  });

  it("claims an already-active deck panel when it starts waiting, without picking it", () => {
    const focused = operation("focused", 1);
    const staged = operation("staged", 2);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "running" },
      staged: { lifecycle: "live", activity: "awaiting" },
    };
    setConsoleState({
      operations: [focused, staged],
      activeOperationId: focused.id,
      operationRuntime,
    });
    setTriageActive(true);
    recordTriageActivity([focused, staged], operationRuntime, 1_000);

    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(getTriagePick()).toBeNull();

    const nextRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "awaiting" },
      staged: { lifecycle: "live", activity: "awaiting" },
    };
    recordTriageActivity([focused, staged], nextRuntime, 2_000);

    expect(getActiveAwaitingClaimId()).toBe(focused.id);
    expect(getTriagePick()).toBeNull();
    expect(isTriageOperationDeferred(focused.id)).toBe(false);
    const claimed = resolveActiveAwaitingTriageEntry([focused, staged], nextRuntime);
    expect(claimed?.operation.id).toBe(focused.id);
    expect(claimed?.picked).toBe(false);
    // 큐 선두는 먼저 대기에 들어선 staged다 — 클레임은 pick이 아니라서 우선순위를 바꾸지 않는다.
    expect(resolveTriageQueue([focused, staged], nextRuntime, 2_000).map((entry) => entry.operation.id))
      .toEqual([staged.id, focused.id]);
  });

  it("does not claim a waiting transition on a panel that is not active", () => {
    const idle = operation("idle", 1);
    const focused = operation("focused", 2);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      idle: { lifecycle: "live", activity: "running" },
      focused: { lifecycle: "live", activity: "running" },
    };
    setConsoleState({
      operations: [idle, focused],
      activeOperationId: focused.id,
      operationRuntime,
    });
    setTriageActive(true);
    recordTriageActivity([idle, focused], operationRuntime);
    recordTriageActivity([idle, focused], {
      idle: { lifecycle: "live", activity: "awaiting" },
      focused: { lifecycle: "live", activity: "running" },
    });

    expect(getActiveAwaitingClaimId()).toBeNull();
  });

  it("releases an active-awaiting claim when the panel loses activation", () => {
    const focused = operation("focused", 1);
    const staged = operation("staged", 2);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "running" },
      staged: { lifecycle: "live", activity: "awaiting" },
    };
    setConsoleState({
      operations: [focused, staged],
      activeOperationId: focused.id,
      operationRuntime,
    });
    setTriageActive(true);
    recordTriageActivity([focused, staged], operationRuntime);
    recordTriageActivity([focused, staged], {
      focused: { lifecycle: "live", activity: "awaiting" },
      staged: { lifecycle: "live", activity: "awaiting" },
    });
    expect(getActiveAwaitingClaimId()).toBe(focused.id);

    setActiveOperation(null);
    releaseInactiveActiveAwaitingClaim();

    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(resolveActiveAwaitingTriageEntry([focused, staged], {
      focused: { lifecycle: "live", activity: "awaiting" },
      staged: { lifecycle: "live", activity: "awaiting" },
    })).toBeNull();
  });

  it("still claims after leaving and re-entering War Room", () => {
    const focused = operation("focused", 1);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "running" },
    };
    setConsoleState({ operations: [focused], activeOperationId: focused.id, operationRuntime });
    setTriageActive(true);
    recordTriageActivity([focused], operationRuntime);
    setTriageActive(false);
    setTriageActive(true);
    recordTriageActivity([focused], { focused: { lifecycle: "live", activity: "awaiting" } });

    expect(getActiveAwaitingClaimId()).toBe(focused.id);
    expect(getTriagePick()).toBeNull();
  });

  it("does not claim a dismissed or deferred panel that starts waiting", () => {
    const focused = operation("focused", 1);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "running" },
    };
    setConsoleState({ operations: [focused], activeOperationId: focused.id, operationRuntime });
    setTriageActive(true);
    recordTriageActivity([focused], operationRuntime);
    dismissTriageOperation(focused.id);
    recordTriageActivity([focused], { focused: { lifecycle: "live", activity: "awaiting" } });
    expect(getActiveAwaitingClaimId()).toBeNull();

    setTriageActive(false);
    setTriageActive(true);
    recordTriageActivity([focused], { focused: { lifecycle: "live", activity: "running" } });
    deferTriageOperation(focused.id);
    recordTriageActivity([focused], { focused: { lifecycle: "live", activity: "awaiting" } });
    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(resolveActiveAwaitingTriageEntry([focused], {
      focused: { lifecycle: "live", activity: "awaiting" },
    })).toBeNull();
  });

  it("does not claim a caption-only activation of a panel that is already waiting", () => {
    const waiting = operation("waiting", 1);
    const operationRuntime: Readonly<Record<string, OperationRuntimeState>> = {
      waiting: { lifecycle: "live", activity: "awaiting" },
    };
    setConsoleState({ operations: [waiting], operationRuntime });
    setTriageActive(true);
    recordTriageActivity([waiting], operationRuntime);
    setActiveOperation(waiting.id);
    recordTriageActivity([waiting], operationRuntime);

    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(getTriagePick()).toBeNull();
  });

  it("does not claim an active awaiting transition outside War Room", () => {
    const focused = operation("focused", 1);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "running" },
    };
    setConsoleState({ operations: [focused], activeOperationId: focused.id, operationRuntime });
    recordTriageActivity([focused], operationRuntime);
    recordTriageActivity([focused], { focused: { lifecycle: "live", activity: "awaiting" } });

    expect(isTriageActive()).toBe(false);
    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(getTriagePick()).toBeNull();
  });

  it("claims an active idle panel when it becomes an idle arrival", () => {
    const focused = operation("focused", 1);
    const operationRuntime: Readonly<Record<string, OperationRuntimeState>> = {
      focused: { lifecycle: "live", activity: "idle" },
    };
    setConsoleState({ operations: [focused], activeOperationId: focused.id, operationRuntime });
    setTriageActive(true);
    recordTriageActivity([focused], operationRuntime);
    markIdleArrival(focused.id);
    recordTriageActivity([focused], operationRuntime);

    expect(getActiveAwaitingClaimId()).toBe(focused.id);
    expect(getTriagePick()).toBeNull();
    expect(resolveActiveAwaitingTriageEntry([focused], operationRuntime)?.operation.id).toBe(focused.id);
  });

  it("drops an active-awaiting claim when the panel is deferred or another Operation is picked", () => {
    const focused = operation("focused", 1);
    const other = operation("other", 2);
    const operationRuntime: Record<string, OperationRuntimeState> = {
      focused: { lifecycle: "live", activity: "running" },
      other: { lifecycle: "live", activity: "awaiting" },
    };
    setConsoleState({
      operations: [focused, other],
      activeOperationId: focused.id,
      operationRuntime,
    });
    setTriageActive(true);
    recordTriageActivity([focused, other], operationRuntime);
    recordTriageActivity([focused, other], {
      focused: { lifecycle: "live", activity: "awaiting" },
      other: { lifecycle: "live", activity: "awaiting" },
    });
    expect(getActiveAwaitingClaimId()).toBe(focused.id);

    deferTriageOperation(focused.id);
    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(resolveActiveAwaitingTriageEntry([focused, other], {
      focused: { lifecycle: "live", activity: "awaiting" },
      other: { lifecycle: "live", activity: "awaiting" },
    })).toBeNull();

    setConsoleState({
      operations: [focused, other],
      activeOperationId: focused.id,
      operationRuntime: {
        focused: { lifecycle: "live", activity: "running" },
        other: { lifecycle: "live", activity: "awaiting" },
      },
    });
    recordTriageActivity([focused, other], {
      focused: { lifecycle: "live", activity: "running" },
      other: { lifecycle: "live", activity: "awaiting" },
    });
    recordTriageActivity([focused, other], {
      focused: { lifecycle: "live", activity: "awaiting" },
      other: { lifecycle: "live", activity: "awaiting" },
    });
    pickTriageOperation(other.id);
    expect(getActiveAwaitingClaimId()).toBeNull();
    expect(getTriagePick()).toBe(other.id);
  });

  it("does not let a focused non-waiting Operation displace another waiting Operation on entry", () => {
    const running = operation("running", 1);
    const waiting = operation("waiting", 2);
    const operationRuntime: Readonly<Record<string, OperationRuntimeState>> = {
      running: { lifecycle: "live", activity: "running" },
      waiting: { lifecycle: "live", activity: "awaiting" },
    };
    setConsoleState({
      operations: [running, waiting],
      activeOperationId: running.id,
      operationRuntime,
    });

    enterTriage(running.id);

    expect(getTriagePick()).toBeNull();
    expect(resolveTriageQueue([running, waiting], operationRuntime)
      .map((entry) => entry.operation.id)).toEqual([waiting.id]);
    expect(getState().activeOperationId).toBe(running.id);
  });

  it("drops an invalid saved focus layer instead of restoring a minimized target", () => {
    setOperationGeometry("picked", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);
    minimizeOperation("picked");

    setTriageActive(false);
    expect(getMaximizedOperationId()).toBeNull();
  });

  it("drops a saved focus layer as soon as its Operation is forgotten", () => {
    setOperationGeometry("picked", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);

    forgetTriageOperation("picked");
    setTriageActive(false);
    expect(getMaximizedOperationId()).toBeNull();
  });

  it("does not treat a future clear timestamp as a returned question", () => {
    const older = operation("older", 1);
    const futureCleared = operation("future-cleared", 2);
    const awaiting: Readonly<Record<string, OperationRuntimeState>> = {
      older: { lifecycle: "live", activity: "awaiting" },
      "future-cleared": { lifecycle: "live", activity: "awaiting" },
    };
    vi.setSystemTime(5_000);
    markTriageCleared("future-cleared");
    recordTriageActivity([futureCleared, older], awaiting, 1_000);

    const queue = resolveTriageQueue([futureCleared, older], awaiting, 4_000);
    expect(queue.map((entry) => entry.operation.id)).toEqual(["older", "future-cleared"]);
  });

  it("advances a focused stage 600ms after its waiting activity changes to running", () => {
    const frame = document.createElement("article");
    frame.className = "canvas-operation";
    frame.dataset.operationId = "picked";
    const input = document.createElement("input");
    frame.append(input);
    document.body.append(frame);
    input.focus();
    expect(focusedTriageOperationId(document.activeElement)).toBe("picked");

    const waiting: Readonly<Record<string, OperationRuntimeState>> = {
      picked: { lifecycle: "live", activity: "awaiting" },
      next: { lifecycle: "live", activity: "idle" },
    };
    markIdleArrival("next");
    recordTriageActivity(OPERATIONS, waiting, 1_000);
    pickTriageOperation("picked");
    const initialActivity = resolveTriageQueue(OPERATIONS, waiting, 1_000)[0]!.activity;
    const running: Readonly<Record<string, OperationRuntimeState>> = {
      ...waiting,
      picked: { lifecycle: "live", activity: "running" },
    };
    recordTriageActivity(OPERATIONS, running, 2_000);
    scheduleTriageClear(
      "picked",
      () => isTriageClearedTransition(initialActivity, runtimeStateVisual(running.picked!)),
    );

    vi.advanceTimersByTime(599);
    expect(resolveTriageQueue(OPERATIONS, running, 2_599)[0]?.operation.id).toBe("picked");
    vi.advanceTimersByTime(1);
    expect(resolveTriageQueue(OPERATIONS, running, 2_600)[0]?.operation.id).toBe("next");
  });

  it("queues only idle arrivals unless an ordinary idle Operation is picked", () => {
    const fallbackIdle = operation("fallback-idle", 1);
    const liveIdle = operation("live-idle", 2);
    const status: Readonly<Record<string, OperationRuntimeState>> = { "live-idle": { lifecycle: "live", activity: "idle" } };
    recordTriageActivity([fallbackIdle, liveIdle], status, 1_000);

    expect(resolveTriageQueue([fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual([]);

    markIdleArrival("live-idle");
    expect(resolveTriageQueue([fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["live-idle"]);

    pickTriageOperation("fallback-idle");
    expect(resolveTriageQueue([fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["fallback-idle", "live-idle"]);
  });

  it("keeps an idle arrival as queue head when the user activates the stage during Triage", () => {
    const arrived = operation("arrived", 1);
    const status: Readonly<Record<string, OperationRuntimeState>> = { arrived: { lifecycle: "live", activity: "idle" } };
    markIdleArrival(arrived.id);
    setConsoleState({
      operations: [arrived],
      activeTheaterId: THEATER_ID,
      activeOperationId: null,
      activeOperationAcknowledged: true,
      operationRuntime: status,
    });

    setTriageActive(true);
    setActiveOperation(arrived.id, { acknowledged: false });
    expect(resolveTriageQueue([arrived], status)[0]?.operation.id).toBe(arrived.id);

    setActiveOperation(arrived.id);
    expect(acknowledgeIdleArrival(arrived.id)).toBe(false);
    expect(getState().activeOperationAcknowledged).toBe(false);
    expect(getIdleArrivalIds().has(arrived.id)).toBe(true);
    expect(resolveTriageQueue([arrived], status)[0]?.operation.id).toBe(arrived.id);

    setTriageActive(false);
    expect(getState().activeOperationAcknowledged).toBe(true);
    expect(getIdleArrivalIds().has(arrived.id)).toBe(false);
    expect(resolveTriageQueue([arrived], status)).toEqual([]);
  });

  it("keeps focusOperation unacknowledged while Triage suspends acknowledgement", () => {
    const arrived = operation("arrived", 1);
    markIdleArrival(arrived.id);
    setConsoleState({
      operations: [arrived],
      activeTheaterId: THEATER_ID,
      activeOperationId: null,
      activeOperationAcknowledged: true,
    });
    setTriageActive(true);

    focusOperation(arrived.id);

    expect(getIdleArrivalIds().has(arrived.id)).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(false);
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

  it("keeps acknowledgement suspended while a Theater forget passes through Triage", () => {
    markIdleArrival("arrived");
    setConsoleState({
      activeOperationId: "arrived",
      activeOperationAcknowledged: false,
    });
    setTriageActive(true);

    resetTriageTheater("theater-b");
    expect(getIdleArrivalIds().has("arrived")).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(false);

    setTriageActive(false);
    expect(getIdleArrivalIds().has("arrived")).toBe(false);
    expect(getState().activeOperationAcknowledged).toBe(true);
  });

  it("does nothing when Triage exits without an active Operation", () => {
    markIdleArrival("waiting");
    setTriageActive(true);

    setTriageActive(false);

    expect(getIdleArrivalIds().has("waiting")).toBe(true);
    expect(getState().activeOperationId).toBeNull();
    expect(getState().activeOperationAcknowledged).toBe(true);
  });

  it("does not acknowledge an active Operation when resetting a Theater", () => {
    markIdleArrival("active");
    setConsoleState({
      activeOperationId: "active",
      activeOperationAcknowledged: false,
    });

    resetTriageTheater("inactive-theater");

    expect(getIdleArrivalIds().has("active")).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(false);
  });

  it("clears an idle arrival explicitly even while acknowledgement is suspended", () => {
    markIdleArrival("arrived");
    setTriageActive(true);

    clearIdleArrival("arrived");

    expect(getIdleArrivalIds().has("arrived")).toBe(false);
  });

  it("clears an idle arrival when its Triage item is dismissed", () => {
    markIdleArrival("arrived");
    setTriageActive(true);

    dismissTriageOperation("arrived");

    expect(getIdleArrivalIds().has("arrived")).toBe(false);
  });

  it("always queues awaiting Operations without an idle arrival", () => {
    const awaiting = operation("awaiting", 1);
    expect(resolveTriageQueue([awaiting], { awaiting: { lifecycle: "live", activity: "awaiting" } })
      .map((entry) => entry.operation.id)).toEqual(["awaiting"]);
  });

  it("round-robins the queue through repeated deferrals without clearing or removing items", () => {
    const operations = [operation("first", 1), operation("second", 2), operation("third", 3)];
    const awaiting: Readonly<Record<string, OperationRuntimeState>> = {
      first: { lifecycle: "live", activity: "awaiting" },
      second: { lifecycle: "live", activity: "awaiting" },
      third: { lifecycle: "live", activity: "awaiting" },
    };
    recordTriageActivity(operations, awaiting, 1_000);

    expect(resolveTriageQueue(operations, awaiting, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["first", "second", "third"]);
    deferTriageOperation("first", 2_000);
    expect(resolveTriageQueue(operations, awaiting, 2_000)
      .map((entry) => entry.operation.id)).toEqual(["second", "third", "first"]);
    deferTriageOperation("second", 2_000);
    expect(resolveTriageQueue(operations, awaiting, 2_000)
      .map((entry) => entry.operation.id)).toEqual(["third", "first", "second"]);
    deferTriageOperation("third", 2_000);

    const completedRound = resolveTriageQueue(operations, awaiting, 2_000);
    expect(completedRound.map((entry) => entry.operation.id)).toEqual(["first", "second", "third"]);
    expect(completedRound).toHaveLength(3);
  });

  it("keeps round-robining past a full cycle when waiting states differ", () => {
    // 대기 상태가 섞이면 한 바퀴 뒤 전부 deferred가 되고, 그때 상태 우선순위가 미룬 순서를
    // 이기면 awaiting 항목이 매번 맨 앞으로 되돌아와 순환이 한 바퀴에서 멈춘다.
    const operations = [operation("aw", 1), operation("idle-a", 2), operation("idle-b", 3)];
    const mixed: Readonly<Record<string, OperationRuntimeState>> = {
      aw: { lifecycle: "live", activity: "awaiting" },
      "idle-a": { lifecycle: "live", activity: "idle" },
      "idle-b": { lifecycle: "live", activity: "idle" },
    };
    markIdleArrival("idle-a");
    markIdleArrival("idle-b");
    recordTriageActivity(operations, mixed, 1_000);

    const visited: string[] = [];
    let now = 2_000;
    for (let press = 0; press < 6; press += 1) {
      const head = resolveTriageQueue(operations, mixed, now)[0]!.operation.id;
      visited.push(head);
      deferTriageOperation(head, now);
      now += 1_000;
    }

    expect(visited).toEqual(["aw", "idle-a", "idle-b", "aw", "idle-a", "idle-b"]);
  });

  it("clears deferrals when picked, transitioned out of waiting, or Triage exits", () => {
    const operations = [operation("first", 1), operation("second", 2)];
    const awaiting: Readonly<Record<string, OperationRuntimeState>> = {
      first: { lifecycle: "live", activity: "awaiting" },
      second: { lifecycle: "live", activity: "awaiting" },
    };
    recordTriageActivity(operations, awaiting, 1_000);

    deferTriageOperation("first", 2_000);
    pickTriageOperation("first");
    expect(resolveTriageQueue(operations, awaiting, 2_000)[0]?.operation.id).toBe("first");
    markTriageCleared("first");

    deferTriageOperation("first", 3_000);
    recordTriageActivity(operations, { ...awaiting, first: { lifecycle: "live", activity: "running" } }, 3_000);
    recordTriageActivity(operations, awaiting, 4_000);
    expect(resolveTriageQueue(operations, awaiting, 4_000)[0]?.operation.id).toBe("first");

    setTriageActive(true);
    deferTriageOperation("first", 5_000);
    setTriageActive(false);
    setTriageActive(true);
    recordTriageActivity(operations, awaiting, 6_000);
    expect(resolveTriageQueue(operations, awaiting, 6_000)
      .map((entry) => entry.operation.id)).toEqual(["first", "second"]);
  });

  it("spans theaters in the global queue and orders awaiting-first across them", () => {
    const alphaWaiting = operation("alpha-waiting", 1);
    const betaWaiting = operation("beta-waiting", 2, "theater-b");
    const betaArrived = operation("beta-arrived", 3, "theater-b");
    const operations = [betaArrived, betaWaiting, alphaWaiting];
    const status: Readonly<Record<string, OperationRuntimeState>> = {
      "alpha-waiting": { lifecycle: "live", activity: "awaiting" },
      "beta-waiting": { lifecycle: "live", activity: "awaiting" },
      "beta-arrived": { lifecycle: "live", activity: "idle" },
    };
    markIdleArrival("beta-arrived");
    recordTriageActivity(operations, status, 1_000);

    expect(resolveTriageQueue(operations, status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["alpha-waiting", "beta-waiting", "beta-arrived"]);
  });

  it("keeps the active Theater on a foreign pick and returns to the last staged Theater on exit", () => {
    const foreign = operation("foreign", 1, "theater-b");
    setConsoleState({
      operations: [foreign],
      activeTheaterId: THEATER_ID,
      theaters: THEATERS.map((theater) => ({
        id: theater.id,
        label: theater.label,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        hasWiki: false,
        activeAdmiralCount: 0,
      })),
      operationRuntime: { foreign: { lifecycle: "live", activity: "awaiting" } },
    });
    setTriageActive(true);

    // 전 Theater 마운트 모드 — 지목은 Theater를 전환하지 않고 무대만 세운다.
    pickTriageOperation("foreign");
    expect(getState().activeTheaterId).toBe(THEATER_ID);
    expect(getTriagePick()).toBe("foreign");

    // canvas가 무대가 설 때 기록하는 이력 — 종료 시 이 Theater로 복귀한다.
    recordTriageStageTheater("theater-b");
    setTriageActive(false);
    expect(getState().activeTheaterId).toBe("theater-b");
  });

  it("clears a visited Theater's stored Formation flag before switching to it", () => {
    // theater-b를 Formation 상태로 남겨둔 채 theater-a에서 선별에 진입한 상황 —
    // 방문 시 플래그를 걷어내지 않으면 loadForTheater가 Formation을 복원해 상호배제가 깨진다.
    loadForTheater("theater-b");
    toggleFormationView();
    expect(getFormationView()).toBe(true);
    loadForTheater(THEATER_ID);
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);

    visitTriageTheater("theater-b");
    loadForTheater("theater-b");

    expect(getFormationView()).toBe(false);
    expect(isTriageActive()).toBe(true);
  });

  it("exits global Triage when Formation activates in any Theater", () => {
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);
    expect(isTriageActive()).toBe(true);

    toggleFormationView();

    expect(getFormationView()).toBe(true);
    expect(isTriageActive()).toBe(false);
  });

  it("groups sidebar entries into all shared status sections and orders awaiting by the queue", () => {
    const alphaWaiting = operation("alpha-waiting", 1);
    const betaWaiting = operation("beta-waiting", 2, "theater-b");
    const alphaRunning = operation("alpha-running", 3);
    const betaIdle = operation("beta-idle", 4, "theater-b");
    const alphaDormant = operation("alpha-dormant", 5);
    const operations = [betaIdle, alphaRunning, betaWaiting, alphaWaiting, alphaDormant];
    const status: Readonly<Record<string, OperationRuntimeState>> = {
      "alpha-waiting": { lifecycle: "live", activity: "awaiting" },
      "beta-waiting": { lifecycle: "live", activity: "awaiting" },
      "alpha-running": { lifecycle: "live", activity: "running" },
      "beta-idle": { lifecycle: "live", activity: "idle" },
      "alpha-dormant": { lifecycle: "dormant" },
    };
    recordTriageActivity(operations, status, 1_000);
    // beta-waiting을 지목해 전역 큐 선두로 올린다 — awaiting 섹션은 이 처리 순서를 따라야 한다.
    pickTriageOperation("beta-waiting");
    const queue = resolveTriageQueue(operations, status, 1_000);
    const entries = operations.map((candidate) => ({
      operation: candidate,
      active: false,
      minimized: false,
      notificationCount: 0,
      status: operationRuntimeVisual(status[candidate.id]),
      icon: null,
    }));

    const sections = resolveTriageSideBarSections(entries, queue);

    expect(sections.map((section) => section.status)).toEqual(["awaiting", "running", "idle", "ended"]);
    const byStatus = new Map(sections.map((section) => [section.status, section.entries.map((entry) => entry.operation.id)]));
    expect(byStatus.get("awaiting")).toEqual(["beta-waiting", "alpha-waiting"]);
    expect(byStatus.get("running")).toEqual(["alpha-running"]);
    expect(byStatus.get("idle")).toEqual(["beta-idle"]);
    expect(byStatus.get("ended")).toEqual(["alpha-dormant"]);
  });

  it("keeps the Triage stage and companions inside the arena inset without overlap", () => {
    // 전면 해도 개편: 기준 상자는 캔버스 박스가 아니라 아레나(부유 크롬 인셋을 뺀 유효 뷰포트)다.
    const arena = { x: 304, y: 0, width: 1_200, height: 800 };
    const geometries = [0, 1, 2].map((slotIndex) =>
      triageStageGeometryFor(arena, 10, slotIndex, 3));

    for (const geometry of geometries) {
      expect(geometry.x).toBeGreaterThanOrEqual(arena.x + 18);
      expect(geometry.y).toBeGreaterThanOrEqual(arena.y + 18 + 32);
      expect(geometry.x + geometry.width).toBeLessThanOrEqual(arena.x + arena.width - 18 + 1e-6);
      expect(geometry.y + geometry.height).toBe(arena.y + arena.height - 18);
    }
    expect(geometries[0]!.x + geometries[0]!.width).toBeLessThan(geometries[1]!.x);
    expect(geometries[1]!.x + geometries[1]!.width).toBeLessThan(geometries[2]!.x);
  });

  it("closes a companion opened during Triage and restores the entry focus layer", () => {
    setOperationGeometry("picked", { x: 20, y: 20, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);
    setCompanionOperationId("picked");
    expect(getCompanionOperationId()).toBe("picked");

    setTriageActive(false);
    expect(getCompanionOperationId()).toBeNull();
    expect(getMaximizedOperationId()).toBe("picked");
  });

  it("hides the clear plate during entry and renders it after the curtain finishes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);

    act(() => {
      triagePlateRoot?.render(createElement(TriageClearPlate, {
        active: true,
        entering: true,
        hasContent: false,
        idleCount: 0,
      }));
    });
    expect(container.querySelector(".canvas-triage-clear")).toBeNull();

    act(() => {
      triagePlateRoot?.render(createElement(TriageClearPlate, {
        active: true,
        entering: false,
        hasContent: false,
        idleCount: 0,
      }));
    });
    expect(container.querySelector(".canvas-triage-clear")).not.toBeNull();
  });

  it("guides an empty queue toward idle panels", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);

    act(() => {
      triagePlateRoot?.render(createElement(TriageClearPlate, {
        active: true,
        entering: false,
        hasContent: false,
        idleCount: 2,
      }));
    });

    expect(container.querySelector(".canvas-triage-clear p")?.textContent)
      .toBe("Nothing is waiting on you. 2 idle panels sit in the left list. Click one to bring it up.");
  });

  it("opens one deck slot per Operation and promotes the one whose slot is clicked", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const slots = new Map<string, HTMLElement | null>();

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationRuntime: { picked: { lifecycle: "live", activity: "running" }, next: { lifecycle: "live", activity: "idle" } },
        operationAccent: {},
        onPanelSlotRef: (operationId, element) => { slots.set(operationId, element); },
      }));
    });

    // 덱이 그리는 것은 자리뿐이다 — 그 자리에 설 패널은 캔버스가 portal로 들여보낸다.
    expect([...container.querySelectorAll("[data-triage-deck-card]")].map((cell) => cell.getAttribute("data-triage-deck-card")))
      .toEqual(["picked", "next"]);
    expect([...slots.keys()].sort()).toEqual(["next", "picked"]);
    // 패널이 들어오는 자리는 칸 자신이 아니라 그 안의 빈 mount다 — portal 대상에 React가 관리하는
    // 형제가 섞이면 자식 조정과 portal 삽입이 서로의 DOM을 밀어낸다.
    expect(slots.get("picked")).toBe(container.querySelector('[data-triage-deck-card="picked"] .canvas-triage-deck-mount'));
    expect(container.querySelector(".canvas-triage-clear")).toBeNull();

    act(() => (container.querySelector('[data-triage-deck-card="next"] .canvas-triage-deck-pick') as HTMLButtonElement).click());
    expect(getTriagePick()).toBe("next");
  });

  // 칸에 선 패널은 캔버스가 portal로 들여보낸 것이라 React 트리에서는 캔버스의 자식이다 — 칸에
  // 건 합성 핸들러는 그 캡션에서 일어난 일을 보지 못한다. 위임은 네이티브라 DOM을 따르므로,
  // 캡션에서 나간 우클릭도 그 Operation의 메뉴로 오고 확대는 캡션 위에서 살아남아야 한다.
  it("reads pointer and context menus off the portaled caption, not just the deck's own nodes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const operationMenu = vi.fn();

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationRuntime: { picked: { lifecycle: "live", activity: "running" }, next: { lifecycle: "live", activity: "idle" } },
        operationAccent: {},
        onOperationContextMenu: operationMenu,
      }));
    });

    // 캔버스가 하는 일을 흉내 낸다 — 칸의 mount 안에 패널을 넣는다(React 트리 밖의 DOM 자식).
    const cell = container.querySelector<HTMLElement>('[data-triage-deck-card="picked"]')!;
    const mount = cell.querySelector<HTMLElement>(".canvas-triage-deck-mount")!;
    const panel = document.createElement("article");
    panel.className = "canvas-operation is-deck-tile";
    const caption = document.createElement("div");
    caption.className = "canvas-operation-titlebar";
    panel.append(caption);
    mount.append(panel);

    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 11, clientY: 22 });
    act(() => caption.dispatchEvent(menu));
    expect(menu.defaultPrevented).toBe(true);
    expect(operationMenu).toHaveBeenCalledWith("picked", expect.any(DOMRect), cell.querySelector(".canvas-triage-deck-pick"));
  });

  // 칸의 신호(검토 전 맥동·도착·착지·지도 확대 강조)는 칸이 받아 그 안의 패널이 말한다. 그런데
  // 패널은 portal이 mount 안에 넣으므로 실제 구조는 칸 > 마운트 > 패널이다 — 선택자가 그 한 겹을
  // 건너뛰면 규칙은 파일에 남은 채 아무것도 칠하지 않는다. 문자열 존재만 보는 계약으로는 잡히지
  // 않으므로, 실제 구조에 맞춰 보는 이 검사가 그 자리를 대신한다.
  it("aims every deck tile signal at the panel the canvas portals into the mount", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationRuntime: { picked: { lifecycle: "live", activity: "running" }, next: { lifecycle: "live", activity: "idle" } },
        operationAccent: {},
      }));
    });

    const cell = container.querySelector<HTMLElement>('[data-triage-deck-card="picked"]')!;
    const mount = cell.querySelector<HTMLElement>(".canvas-triage-deck-mount")!;
    const panel = document.createElement("article");
    panel.className = "canvas-operation is-deck-tile";
    mount.append(panel);

    // jsdom 환경의 import.meta.url은 file: 스킴이 아니다 — vitest가 패키지 루트를 cwd로 잡으므로
    // 그 기준 상대 경로로 읽는다.
    const css = readFileSync("core/client/src/styles/components.css", "utf8");
    for (const state of ["is-fresh", "is-arriving", "is-landed"]) {
      const selectors = [...css.matchAll(new RegExp(`\\.canvas-triage-deck-cell\\.${state}[^,{]*\\.canvas-operation`, "g"))]
        .map((match) => match[0]);
      expect(selectors.length, `${state} has no signal selector`).toBeGreaterThan(0);
      cell.className = `canvas-triage-deck-cell ${state}`;
      for (const selector of selectors) {
        expect(panel.matches(selector), `${selector} never matches the portaled panel`).toBe(true);
      }
    }
  });

  it("wires an active-awaiting claim behind grace and protected stage retention", () => {
    const source = readFileSync("core/client/src/canvas/canvas.tsx", "utf8");
    expect(source).toContain("resolveActiveAwaitingTriageEntry(state.operations, state.operationRuntime)");
    expect(source).toContain("graceTriageEntry ?? protectedTriageEntry ?? activeAwaitingTriageEntry");
  });

  it("keeps the deck tile's own track from growing past the slot it stands in", () => {
    // 칸이 곧 패널이자 PTY 크기라는 계약은 두 축 모두에 최소값 0을 적어야 성립한다. 열 트랙을
    // 비워 두면 암시적 `auto` 열의 최소값이 본문의 min-content가 되고(xterm은 실측 288px),
    // 패널은 overflow:visible이라 그만큼이 옆 칸 위에 그려진다 — 밀도를 낮출수록 항상 재현된다.
    const css = readFileSync("core/client/src/styles/components.css", "utf8");
    const rule = /\.canvas-operation\.is-deck-tile\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, "is-deck-tile rule is gone").toBeDefined();
    for (const axis of ["columns", "rows"]) {
      const track = new RegExp(`grid-template-${axis}:([^;]*);`).exec(rule!)?.[1];
      expect(track, `is-deck-tile declares no grid-template-${axis}`).toBeDefined();
      expect(track, `is-deck-tile ${axis} track can outgrow its slot`).toContain("minmax(0,");
    }
  });

  it("routes deck-slot, map-dot, and owned empty-region context menus without guessing bare space", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const operationMenu = vi.fn();
    const theaterMenu = vi.fn();

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationRuntime: { picked: { lifecycle: "live", activity: "running" }, next: { lifecycle: "live", activity: "idle" } },
        operationAccent: {},
        onOperationContextMenu: operationMenu,
        onTheaterContextMenu: theaterMenu,
      }));
    });

    const cell = container.querySelector<HTMLElement>('[data-triage-deck-card="picked"]')!;
    const cellPick = cell.querySelector<HTMLButtonElement>(".canvas-triage-deck-pick")!;
    const cardMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 41, clientY: 52 });
    act(() => cell.dispatchEvent(cardMenu));
    expect(cardMenu.defaultPrevented).toBe(true);
    // 포커스는 칸 자신이 아니라 그 승격 면으로 돌아간다 — 칸은 tabindex를 갖지 않는다.
    expect(operationMenu).toHaveBeenCalledWith("picked", expect.any(DOMRect), cellPick);
    expect(theaterMenu).not.toHaveBeenCalled();

    const bandBody = container.querySelector<HTMLElement>(".canvas-triage-deck-band-body")!;
    const fieldMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 71, clientY: 82 });
    act(() => bandBody.dispatchEvent(fieldMenu));
    expect(fieldMenu.defaultPrevented).toBe(true);
    expect(theaterMenu).toHaveBeenCalledWith("theater-a", { x: 71, y: 82 });
  });

  it("groups deck cards into theater bands ordered by waiting count", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const alphaIdle = operation("alpha-idle", 1);
    const betaWaiting = operation("beta-waiting", 2, "theater-b");
    const betaRunning = operation("beta-running", 3, "theater-b");
    const status: Readonly<Record<string, OperationRuntimeState>> = {
      "alpha-idle": { lifecycle: "live", activity: "idle" },
      "beta-waiting": { lifecycle: "live", activity: "awaiting" },
      "beta-running": { lifecycle: "live", activity: "running" },
    };
    recordTriageActivity([alphaIdle, betaWaiting, betaRunning], status, 1_000);

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: [alphaIdle, betaWaiting, betaRunning],
        operationRuntime: status,
        operationAccent: {},
      }));
    });

    const bands = [...container.querySelectorAll(".canvas-triage-deck-band")];
    expect(bands).toHaveLength(2);
    expect(bands[0]?.querySelector(".canvas-triage-deck-band-chip")?.textContent).toBe("BE");
    expect(bands[1]?.querySelector(".canvas-triage-deck-band-chip")?.textContent).toBe("AL");
    expect(bands[0]?.querySelectorAll("[data-triage-deck-card]")).toHaveLength(2);
    expect(bands[1]?.querySelectorAll("[data-triage-deck-card]")).toHaveLength(1);
  });

  it("counts an idle arrival as waiting in the band header with the queue's predicate", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const arrival = operation("arrival", 1);
    const status: Readonly<Record<string, OperationRuntimeState>> = { arrival: { lifecycle: "live", activity: "idle" } };
    recordTriageActivity([arrival], status, 1_000);
    markIdleArrival("arrival");

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: [arrival],
        operationRuntime: status,
        operationAccent: {},
      }));
    });

    // 정렬(bandWaitingCount)과 헤더 수치가 같은 판정을 공유한다 — 유휴 도착은 대기 1로
    // 집계되고 유휴 수에서는 빠져 이중 집계되지 않는다.
    const counts = container.querySelector(".canvas-triage-deck-band-counts")?.textContent ?? "";
    expect(counts).toContain("1 waiting");
    expect(counts).toContain("0 idle");
  });

  it("holds automatic deck arrivals but lets picks, stage advancement, and suppressed motion promote immediately", () => {
    const started = resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      spotlight: true,
      dwell: null,
      now: 1_000,
      suppressed: false,
    });
    expect(started).toEqual({
      promote: false,
      arrivingOperationId: "awaiting",
      dwell: { operationId: "awaiting", deadline: 1_000 + TRIAGE_DECK_ARRIVAL_DWELL_MS },
    });
    expect(resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      spotlight: true,
      dwell: started.dwell,
      now: 1_000 + TRIAGE_DECK_ARRIVAL_DWELL_MS,
      suppressed: false,
    }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "picked", picked: true, deckVisible: true, spotlight: true, dwell: started.dwell, now: 1_001, suppressed: false }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "next", picked: false, deckVisible: false, spotlight: true, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: true, spotlight: true, dwell: null, now: 1_001, suppressed: true }).promote).toBe(true);
  });

  it("stops every automatic promotion while the spotlight is off, leaving only picks", () => {
    expect(resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      spotlight: false,
      dwell: null,
      now: 1_000,
      suppressed: false,
    })).toEqual({ promote: false, arrivingOperationId: null, dwell: null });
    expect(resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      spotlight: false,
      dwell: null,
      now: 1_000 + TRIAGE_DECK_ARRIVAL_DWELL_MS + 5_000,
      suppressed: false,
    })).toEqual({ promote: false, arrivingOperationId: null, dwell: null });
    // 지목은 스포트라이트와 무관하게 언제나 등단한다.
    expect(resolveTriageDeckPromotion({ operationId: "picked", picked: true, deckVisible: true, spotlight: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
    // OFF에서는 무대 교대도 자동으로 일어나지 않는다 — 무대의 작업이 끝나 다음 대기 건이
    // 저절로 올라오는 것이야말로 이 스위치가 막으려는 동작이다.
    expect(resolveTriageDeckPromotion({ operationId: "next", picked: false, deckVisible: false, spotlight: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(false);
    // reduced-motion(suppressed)의 즉시 등단보다 스포트라이트 OFF가 우선한다.
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: true, spotlight: false, dwell: null, now: 1_001, suppressed: true }).promote).toBe(false);
    // 입장 연출 중(deck는 곧 보일 상태)에도 저장된 OFF가 무시되지 않는다.
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: false, spotlight: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(false);
    // ON에서는 입장 연출 중 등단이 기존대로 유지된다.
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: false, spotlight: true, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
  });

  it("marks the dwelling Watch Deck card as arriving", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationRuntime: { picked: { lifecycle: "live", activity: "awaiting" }, next: { lifecycle: "live", activity: "idle" } },
        operationAccent: {},
        arrivingOperationId: "picked",
      }));
    });

    expect(container.querySelector('[data-triage-deck-card="picked"]')?.classList.contains("is-arriving")).toBe(true);
    expect(container.querySelector('[data-triage-deck-card="next"]')?.classList.contains("is-arriving")).toBe(false);
  });

  it("marks only the fresh Watch Deck cards while the spotlight is off", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationRuntime: { picked: { lifecycle: "live", activity: "awaiting" }, next: { lifecycle: "live", activity: "idle" } },
        operationAccent: {},
        freshOperationIds: new Set(["picked"]),
      }));
    });

    expect(container.querySelector('[data-triage-deck-card="picked"]')?.classList.contains("is-fresh")).toBe(true);
    expect(container.querySelector('[data-triage-deck-card="next"]')?.classList.contains("is-fresh")).toBe(false);
  });

  it("records detail and activity transition timestamps independently", () => {
    setOperationStatusDetail("detail-only", "Latest line");
    recordOperationActivityTransition("detail-only", "running", 1_500);
    recordOperationActivityTransition("detail-only", "running", 2_500);

    expect(getOperationStatusDetailSnapshot("detail-only")).toEqual({
      detail: "Latest line",
      activityChangedAt: 1_500,
    });
  });

  it("closes inherited companions on entry and stage changes but preserves an explicitly opened companion", () => {
    setOperationGeometry("picked", { x: 20, y: 20, width: 640, height: 400, zIndex: 1 });
    setCompanionOperationId("picked");
    expect(getCompanionOperationId()).toBe("picked");

    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);
    expect(getCompanionOperationId()).toBeNull();
    const pickedStage = reconcileTriageStageCompanion(
      null,
      { theaterId: THEATER_ID, operationId: "picked" },
    );

    setCompanionOperationId("picked");
    reconcileTriageStageCompanion(
      pickedStage,
      { theaterId: THEATER_ID, operationId: "picked" },
    );
    expect(getCompanionOperationId()).toBe("picked");

    armTriageSetAside("picked");
    reconcileTriageStageCompanion(
      pickedStage,
      { theaterId: THEATER_ID, operationId: "next" },
    );
    expect(getCompanionOperationId()).toBeNull();
    expect(getTriageSetAsideArmedId()).toBeNull();

    setTriageActive(false);
    expect(getCompanionOperationId()).toBe("picked");
    forceDropCompanionOperationId();
  });

  it("does not disturb a foreign Theater's stored focus layer when picking without switching", () => {
    const foreign = operation("foreign", 1, "theater-b");
    // B에 저장된 companion layer — 선별 전의 B 화면 상태다. 전 Theater 마운트 모드에서
    // 지목은 B를 로드하지 않으므로 저장본은 캡처도 소거도 없이 그대로 남아야 한다.
    setTheaterFocusLayerSnapshot("theater-b", { mode: "companion", operationId: "foreign", returnTo: "underlay" });
    setConsoleState({
      operations: [foreign],
      activeTheaterId: THEATER_ID,
      operationRuntime: { foreign: { lifecycle: "live", activity: "awaiting" } },
    });
    setTriageActive(true);

    pickTriageOperation("foreign");

    expect(getState().activeTheaterId).toBe(THEATER_ID);
    expect(getTheaterFocusLayerSnapshot("theater-b")).toEqual({ mode: "companion", operationId: "foreign", returnTo: "underlay" });

    setTriageActive(false);
    expect(getTheaterFocusLayerSnapshot("theater-b")).toEqual({ mode: "companion", operationId: "foreign", returnTo: "underlay" });
    setTheaterFocusLayerSnapshot("theater-b", null);
  });

  it("captures, nulls, and switches Theater when visitTriageTheater is called directly", () => {
    setTheaterFocusLayerSnapshot("theater-b", { mode: "maximized", operationId: "foreign" });
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);

    visitTriageTheater("theater-b");

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getTheaterFocusLayerSnapshot("theater-b")).toBeNull();

    // 종료 복원의 유효성 검사를 통과할 geometry를 B의 저장 상태에 확정한다(위 테스트와 같은 flush).
    loadForTheater("theater-b");
    setOperationGeometry("foreign", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    loadForTheater(THEATER_ID);
    loadForTheater("theater-b");
    // 재방문은 캡처본을 덮지 않는다 — 첫 스냅샷이 종료 시 복원된다.
    visitTriageTheater("theater-b");
    setTriageActive(false);
    expect(getTheaterFocusLayerSnapshot("theater-b")).toEqual({ mode: "maximized", operationId: "foreign" });
  });

  it("resets dismissals and returned-window state across exit and re-entry", () => {
    const awaiting = operation("awaiting", 1);
    const status: Readonly<Record<string, OperationRuntimeState>> = { awaiting: { lifecycle: "live", activity: "awaiting" } };
    setConsoleState({ operations: [awaiting], activeTheaterId: THEATER_ID, operationRuntime: status });
    recordTriageActivity([awaiting], status, 1_000);
    setTriageActive(true);

    dismissTriageOperation("awaiting");
    expect(resolveTriageQueue([awaiting], status, 1_000)).toHaveLength(0);

    setTriageActive(false);
    setTriageActive(true);
    // 치워둠은 진입에 붙는다 — 재진입하면 같은 Operation이 큐로 돌아온다.
    expect(resolveTriageQueue([awaiting], status, 1_000).map((entry) => entry.operation.id)).toEqual(["awaiting"]);

    const older = operation("older", 0);
    const pairStatus: Readonly<Record<string, OperationRuntimeState>> = { awaiting: { lifecycle: "live", activity: "awaiting" }, older: { lifecycle: "live", activity: "awaiting" } };
    recordTriageActivity([awaiting, older], pairStatus, 1_000);
    markTriageCleared("awaiting");
    setTriageActive(false);
    setTriageActive(true);
    // 종료는 진입 중의 처리 기록(lastClearedAt)도 지운다 — 재진입 큐에서 직전 세션의 clear가
    // returned 우선순위를 만들지 못하고, 순서는 seenAt→createdAt 규칙으로 되돌아간다.
    const reentryQueue = resolveTriageQueue([awaiting, older], pairStatus, Date.now());
    expect(reentryQueue.map((entry) => entry.operation.id)).toEqual(["older", "awaiting"]);
    expect(reentryQueue[0]?.picked).toBe(false);
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

  it("discards pending sidebar signals at both the entry and exit boundaries", () => {
    requestOperationLaunchMenu();
    expect(getState().launchMenuRequest).not.toBeNull();

    setTriageActive(true);
    expect(getState().launchMenuRequest).toBeNull();

    requestOperationLaunchMenu();
    expect(getState().launchMenuRequest).not.toBeNull();

    setTriageActive(false);
    expect(getState().launchMenuRequest).toBeNull();
  });

  it("discards a pending sidebar operation action at the triage boundary", () => {
    const consumed: string[] = [];
    // OperationsSideBar가 없으므로 소비하지 않는 리스너를 달아 요청이 잔류하도록 한다.
    const unsubscribe = subscribeSideBarOperationAction(() => false);
    let unsubscribeLate: () => void = () => {};
    try {
      requestSideBarOperationAction("picked", "rename");
      setTriageActive(true);

      requestSideBarOperationAction("picked", "set-accent");
      setTriageActive(false);

      // 경계에서 폐기되지 않았다면 새 소비 리스너가 구 요청을 뒤늦게 재생한다.
      unsubscribeLate = subscribeSideBarOperationAction((request) => {
        consumed.push(request.action);
        return true;
      });
    } finally {
      unsubscribe();
      unsubscribeLate();
    }
    expect(consumed).toEqual([]);
  });

  it("re-renders the sidebar with the shared chip grammar, full theater pills, and current highlight after a pick", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const operations = [operation("first", 1), operation("second", 2, "theater-b")];
    const status: Readonly<Record<string, OperationRuntimeState>> = { first: { lifecycle: "live", activity: "awaiting" }, second: { lifecycle: "live", activity: "awaiting" } };
    recordTriageActivity(operations, status, 1_000);
    setTriageActive(true);

    const render = () => {
      triagePlateRoot?.render(createElement(TriageSideBar, {
        theaters: THEATERS,
        operations,
        operationRuntime: status,
        operationNotifications: {},
        catalog: [],
        plugins: [],
        renderKindIcon: () => null,
        canLaunch: true,
        onLaunchKind: () => {},
        onPick: pickTriageOperation,
        onClose: () => {},
        onRename: () => {},
      }));
    };
    act(render);
    // 기존 사이드바 문법 그대로: 상태 섹션 헤더 + side-bar-chip 행.
    expect(container.querySelector(".side-bar-status-header--awaiting")).not.toBeNull();
    const chips = [...container.querySelectorAll<HTMLElement>(".side-bar-chip")];
    expect(chips).toHaveLength(2);
    // Theater 이름은 축약 없이 전체를 pill로 싣는다.
    const pills = [...container.querySelectorAll<HTMLElement>(".side-bar-chip-theater-pill")].map((pill) => pill.textContent);
    expect(pills).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    expect(pills.some((text) => text === "AL" || text === "BE")).toBe(false);

    // 사이드바는 triage 리비전을 스스로 구독한다 — 부모 prop 없이도 pick 변화에 리렌더한다.
    act(() => pickTriageOperation("second"));

    const rows = [...container.querySelectorAll<HTMLElement>(".side-bar-chip")];
    expect(rows[0]?.textContent).toContain("second");
    expect(rows[0]?.classList.contains("side-bar-chip--active")).toBe(true);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(rows[1]?.textContent).toContain("first");
    expect(rows[1]?.classList.contains("side-bar-chip--active")).toBe(false);

    // 접힘은 Map 사이드바와 같은 좌측 열 상태를 공유한다 — 커맨드 밴드 토글이 선별 중에도 동작한다.
    act(() => setSideBarCollapsed(true));
    const aside = container.querySelector<HTMLElement>(".triage-side-bar");
    expect(aside?.classList.contains("is-closed")).toBe(true);
    expect(aside?.dataset.sidebarState).toBe("closed");
    act(() => setSideBarCollapsed(false));
    expect(container.querySelector<HTMLElement>(".triage-side-bar")?.classList.contains("is-closed")).toBe(false);
  });

  it("renders dormant Operations in a separate collapsed shelf and resumes them without leaving War Room", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const dormant = operation("dormant", 1);
    const operations = [dormant];
    const status: Readonly<Record<string, OperationRuntimeState>> = { dormant: { lifecycle: "dormant" } };
    const resumeOperation = vi.fn();
    const onPick = vi.fn();
    setTriageActive(true);

    act(() => triagePlateRoot?.render(createElement(TriageSideBar, {
      theaters: THEATERS,
      operations,
      operationRuntime: status,
      operationNotifications: {},
      catalog: [],
      plugins: [{ id: "terminal", resumeOperation }],
      renderKindIcon: () => null,
      canLaunch: true,
      onLaunchKind: () => {},
      onPick,
      onClose: () => {},
      onRename: () => {},
    })));

    const shelf = container.querySelector(".triage-side-bar-dormant-shelf");
    expect(shelf).not.toBeNull();
    expect(container.querySelector(".triage-side-bar-sections .side-bar-status-section--ended")).toBeNull();
    expect(shelf?.querySelector(".side-bar-status-header__count")?.textContent).toBe("1");
    const toggle = shelf?.querySelector<HTMLButtonElement>(".side-bar-status-header__toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(shelf?.querySelector(".side-bar-chip")).toBeNull();

    act(() => toggle?.click());
    const chip = shelf?.querySelector<HTMLElement>(".side-bar-chip");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("aria-label")).toContain("Start ended operation dormant");
    expect(chip?.getAttribute("aria-label")).not.toContain("Focus operation");
    expect(chip?.getAttribute("title")).toBe("Select to start again");
    expect(chip?.getAttribute("title")).not.toContain("right-click");
    act(() => chip?.click());

    expect(resumeOperation).toHaveBeenCalledWith("dormant");
    expect(onPick).not.toHaveBeenCalled();
    expect(isTriageActive()).toBe(true);
  });

  it("opens canvas controls from bare sidebar space while chips and the dormant shelf keep their own contract", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const operations = [operation("first", 1), operation("resting", 2)];
    const status: Readonly<Record<string, OperationRuntimeState>> = { first: { lifecycle: "live", activity: "awaiting" }, resting: { lifecycle: "dormant" } };
    const onOpenOperationMenu = vi.fn();
    const onLaunchKind = vi.fn();
    recordTriageActivity(operations, status, 1_000);
    setTriageActive(true);

    act(() => triagePlateRoot?.render(createElement(TriageSideBar, {
      theaters: THEATERS,
      operations,
      operationRuntime: status,
      operationNotifications: {},
      catalog: [{ id: "terminal", title: "Terminal", kinds: [{ id: "claude", type: "agent", title: "Claude" }] }],
      plugins: [],
      renderKindIcon: () => null,
      canLaunch: true,
      onLaunchKind,
      onPick: () => {},
      onClose: () => {},
      onRename: () => {},
      onOpenOperationMenu,
    })));

    // 칩도 선반도 아닌 빈 자리는 캔버스의 주인 없는 자리와 같은 '캔버스 제어'를 연다 —
    // War Room에서 좌측 열이 실행 진입점을 갖지 못하던 구멍을 메운다.
    const aside = container.querySelector<HTMLElement>(".triage-side-bar")!;
    // 이 표면은 열면서 공용 닫기 신호를 함께 보낸다 — 캔버스가 이미 연 메뉴는 이 <aside> 밖이라
    // 포털의 외부-클릭 닫기가 잡지 못한다. 구독만 있고 발신이 없으면 두 메뉴가 동시에 뜬다.
    const closeSignals: Event[] = [];
    const recordClose = (event: Event) => closeSignals.push(event);
    window.addEventListener("canvas-context-menu-close", recordClose);
    const bareMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 48 });
    act(() => aside.dispatchEvent(bareMenu));
    window.removeEventListener("canvas-context-menu-close", recordClose);
    expect(closeSignals).toHaveLength(1);
    expect(bareMenu.defaultPrevented).toBe(true);
    const launchMenu = document.querySelector(".canvas-context-menu");
    expect(launchMenu).not.toBeNull();
    // 시각 헤더는 반복하지 않고, 메뉴 역할은 접근 이름으로만 유지한다.
    expect(launchMenu?.getAttribute("aria-label")).toBe("Operation launcher");
    expect(launchMenu?.querySelector(".canvas-context-menu-head")).toBeNull();
    // Terminal Shell은 우측 rail 아이콘이 소유하므로 이 메뉴에 없다 — 여기서 짚는 항목은
    // 우클릭 실행 목록에 남는 에이전트 종류다.
    const launchItem = launchMenu?.querySelector<HTMLButtonElement>('[data-operation-launch-kind="claude"]');
    expect(launchItem).not.toBeNull();
    expect(launchItem?.disabled).toBe(false);
    expect(launchMenu?.querySelector('[data-operation-launch-kind="shell"]')).toBeNull();
    expect(onOpenOperationMenu).not.toHaveBeenCalled();

    // 항목은 실제로 실행을 배선한다 — 열리기만 하는 메뉴는 진입점이 아니다.
    act(() => launchItem?.click());
    // 변형이 없는 종류는 실행 변형 인자를 비운 채 배선된다 — 계약의 세 번째 인자까지 못 박는다.
    expect(onLaunchKind).toHaveBeenCalledWith("terminal", expect.objectContaining({ id: "claude" }), undefined);
    expect(document.querySelector(".canvas-context-menu")).toBeNull();

    // 캔버스가 Map 클릭에서 보내는 같은 신호로도 닫힌다(pan이 mousedown 합성을 끊어 외부-클릭이 못 잡는다).
    act(() => aside.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 48 })));
    expect(document.querySelector(".canvas-context-menu")).not.toBeNull();
    act(() => { window.dispatchEvent(new Event("canvas-context-menu-close")); });
    expect(document.querySelector(".canvas-context-menu")).toBeNull();

    // 좌측 열을 접으면 그 열이 연 메뉴도 걷힌다 — 포털이라 <aside>의 inert가 닿지 않는다.
    act(() => aside.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 48 })));
    expect(document.querySelector(".canvas-context-menu")).not.toBeNull();
    act(() => setSideBarCollapsed(true));
    expect(document.querySelector(".canvas-context-menu")).toBeNull();
    act(() => setSideBarCollapsed(false));

    // 칩 우클릭은 Operation 메뉴 계약 그대로다 — 빈 자리 핸들러가 가로채지 않는다.
    const chip = container.querySelector<HTMLElement>(".triage-side-bar-sections .side-bar-chip")!;
    const chipMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 60 });
    act(() => chip.dispatchEvent(chipMenu));
    expect(onOpenOperationMenu).toHaveBeenCalled();
    expect(document.querySelector(".canvas-context-menu")).toBeNull();

    // 휴면 선반은 아무것도 열지 않는 표면 계약을 유지한다.
    const shelf = container.querySelector<HTMLElement>(".triage-side-bar-dormant-shelf")!;
    const shelfMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 90 });
    act(() => shelf.dispatchEvent(shelfMenu));
    expect(shelfMenu.defaultPrevented).toBe(true);
    expect(document.querySelector(".canvas-context-menu")).toBeNull();
  });

  it("opens nothing from bare sidebar space when no Theater is registered", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    setTriageActive(true);

    act(() => triagePlateRoot?.render(createElement(TriageSideBar, {
      theaters: [],
      operations: [],
      operationRuntime: {},
      operationNotifications: {},
      catalog: [{ id: "terminal", title: "Terminal", kinds: [{ id: "claude", type: "agent", title: "Claude" }] }],
      plugins: [],
      renderKindIcon: () => null,
      canLaunch: false,
      onLaunchKind: () => {},
      onPick: () => {},
      onClose: () => {},
      onRename: () => {},
    })));

    const aside = container.querySelector<HTMLElement>(".triage-side-bar")!;
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 48 });
    act(() => aside.dispatchEvent(menu));
    expect(menu.defaultPrevented).toBe(true);
    expect(document.querySelector(".canvas-context-menu")).toBeNull();
  });

  it("closes an already-open sidebar launcher when the last Theater disappears", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    setTriageActive(true);
    const catalog = [{ id: "terminal", title: "Terminal", kinds: [{ id: "claude", type: "agent", title: "Claude" }] }];
    const props = {
      operations: [],
      operationRuntime: {},
      operationNotifications: {},
      catalog,
      plugins: [],
      renderKindIcon: () => null,
      onLaunchKind: () => {},
      onPick: () => {},
      onClose: () => {},
      onRename: () => {},
    };

    act(() => triagePlateRoot?.render(createElement(TriageSideBar, {
      ...props,
      theaters: THEATERS,
      canLaunch: true,
    })));
    const aside = container.querySelector<HTMLElement>(".triage-side-bar")!;
    act(() => aside.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 48 })));
    expect(document.querySelector(".canvas-context-menu")).not.toBeNull();

    act(() => triagePlateRoot?.render(createElement(TriageSideBar, {
      ...props,
      theaters: [],
      canLaunch: false,
    })));
    expect(document.querySelector(".canvas-context-menu")).toBeNull();
  });

});

describe("triage deck zoom", () => {
  it("clamps zoom to [1.0, 2.0] and rejects non-finite input", () => {
    // 1× 아래는 카드가 읽히지 않는 구간이다 — 그 판(함대 지도)은 Cruise 축소가 세우고 덱은 내려가지 않는다.
    expect(clampTriageDeckZoom(0)).toBe(1.0);
    expect(clampTriageDeckZoom(0.4)).toBe(1.0);
    expect(clampTriageDeckZoom(1.25)).toBe(1.25);
    expect(clampTriageDeckZoom(2.5)).toBe(2.0);
    expect(clampTriageDeckZoom(Number.NaN)).toBe(1.0);
    expect(clampTriageDeckZoom(Number.POSITIVE_INFINITY)).toBe(1.0);
  });

  it("cycles presets from the nearest preset to the current zoom", () => {
    expect(nextTriageDeckZoomPreset(1.0)).toBe(1.6);
    expect(nextTriageDeckZoomPreset(1.6)).toBe(1.0);
    // 비-프리셋 배율은 가장 가까운 프리셋 기준으로 다음 단계를 고른다.
    expect(nextTriageDeckZoomPreset(1.2)).toBe(1.6);
    expect(nextTriageDeckZoomPreset(1.9)).toBe(1.0);
  });

  it("persists one global zoom in localStorage and clamps both writes and reloads", () => {
    setTriageDeckZoom(1.6);
    expect(window.localStorage.getItem("fleet-console.triage-deck-zoom")).toBe("1.6");
    setTriageDeckZoom(9);
    expect(getTriageDeckZoom()).toBe(2.0);
    expect(window.localStorage.getItem("fleet-console.triage-deck-zoom")).toBe("2");
    // 로드 경로도 클램프한다 — 리셋 후 저장소의 비정상 값은 lazy-load에서 걸러진다.
    resetTriageDeckZoomForTests();
    window.localStorage.setItem("fleet-console.triage-deck-zoom", "9");
    expect(getTriageDeckZoom()).toBe(2.0);
    // 지도 밀도가 있던 시절의 저장값(0.4)은 새 하한으로 올라선다 — 재진입이 91px 카드로 서지 않는다.
    resetTriageDeckZoomForTests();
    window.localStorage.setItem("fleet-console.triage-deck-zoom", "0.4");
    expect(getTriageDeckZoom()).toBe(1.0);
  });

  it("bare wheel zooms the deck; shift+wheel scrolls the card grid; alt leaves wheel alone", () => {
    const host = document.createElement("div");
    const deck = document.createElement("div");
    deck.className = "canvas-triage-deck";
    const grid = document.createElement("div");
    grid.className = "canvas-triage-deck-grid";
    grid.scrollTop = 0;
    deck.append(grid);
    host.append(deck);
    document.body.append(host);

    let control: TriageDeckZoomControl | null = null;
    const Probe = () => {
      const zoomControl = useTriageDeckZoomControl();
      useEffect(() => {
        control = zoomControl.control;
      }, [zoomControl.control]);
      return null;
    };
    triagePlateRoot = createRoot(document.createElement("div"));
    act(() => {
      triagePlateRoot?.render(createElement(Probe));
    });
    expect(control).not.toBeNull();

    let detach: (() => void) | undefined;
    act(() => {
      detach = control!.attachWheelListener(host);
      setTriageActive(true);
    });

    // 덱 밀도는 1× 아래로 내려가지 않으므로 기본 1×에서는 확대 방향(음의 deltaY)만 칸을 바꾼다.
    const bareWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -400,
    });
    act(() => {
      grid.dispatchEvent(bareWheel);
    });
    expect(bareWheel.defaultPrevented).toBe(true);
    expect(host.style.getPropertyValue("--triage-card-min")).not.toBe("");
    expect(host.style.getPropertyValue("--triage-card-min")).not.toBe("260px");

    act(() => {
      control!.setZoomTarget(1.0);
      control!.snapZoomTween();
    });
    const zoomBeforeShift = getTriageDeckZoom();
    const shiftWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
      shiftKey: true,
    });
    act(() => {
      grid.dispatchEvent(shiftWheel);
    });
    expect(shiftWheel.defaultPrevented).toBe(true);
    expect(grid.scrollTop).toBe(80);
    expect(getTriageDeckZoom()).toBe(zoomBeforeShift);

    const altWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
      altKey: true,
    });
    act(() => {
      grid.dispatchEvent(altWheel);
    });
    expect(altWheel.defaultPrevented).toBe(false);
    expect(getTriageDeckZoom()).toBe(zoomBeforeShift);

    // 일부 브라우저·트랙패드는 Shift+wheel을 deltaX로만 보고한다 — 세로 스크롤로 수렴해야 한다.
    const shiftHorizontalWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 60,
      deltaY: 0,
      shiftKey: true,
    });
    act(() => {
      grid.dispatchEvent(shiftHorizontalWheel);
    });
    expect(shiftHorizontalWheel.defaultPrevented).toBe(true);
    expect(grid.scrollTop).toBe(140);
    expect(getTriageDeckZoom()).toBe(zoomBeforeShift);

    // Firefox 물리 휠은 line 단위(deltaMode=1)로 보고한다 — 16px/line 정규화 없이는
    // 한 노치가 0.7% 줌이 되어 문법이 사실상 죽는다.
    const lineWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    act(() => {
      grid.dispatchEvent(lineWheel);
    });
    expect(lineWheel.defaultPrevented).toBe(true);
    const expectedLineZoomMin = Math.round(260 * Math.exp(3 * 16 * 0.0022));
    expect(host.style.getPropertyValue("--triage-card-min")).toBe(`${expectedLineZoomMin}px`);

    const lineShiftWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 3,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      shiftKey: true,
    });
    act(() => {
      grid.dispatchEvent(lineShiftWheel);
    });
    expect(grid.scrollTop).toBe(140 + 3 * 16);

    detach?.();
  });

  it("keeps the stored density across a triage exit and re-entry without remounting", () => {
    let control: TriageDeckZoomControl | null = null;
    const Probe = () => {
      const zoomControl = useTriageDeckZoomControl();
      useEffect(() => {
        control = zoomControl.control;
      }, [zoomControl.control]);
      return null;
    };
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    act(() => {
      triagePlateRoot?.render(createElement(Probe));
    });
    expect(control).not.toBeNull();

    act(() => {
      setTriageActive(true);
      control!.setZoomTarget(1.6);
      control!.snapZoomTween();
    });
    expect(getTriageDeckZoom()).toBe(1.6);

    act(() => {
      setTriageActive(false);
    });
    // 종료는 live 채널만 null로 되돌린다 — 저장 배율은 재진입의 출발점으로 남는다.
    expect(getTriageDeckZoom()).toBe(1.6);

    act(() => {
      setTriageActive(true);
    });
    expect(getTriageDeckZoom()).toBe(1.6);
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
