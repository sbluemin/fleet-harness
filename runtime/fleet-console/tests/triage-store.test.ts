// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

import {
  acknowledgeIdleArrival,
  clearIdleArrival,
  getIdleArrivalIds,
  markIdleArrival,
  resetIdleArrivalForTests,
} from "../core/client/src/operation-idle-arrival.js";
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
  getTriageCleared,
  getTriageDeckZoom,
  getTriagePick,
  getTriageSetAsideArmedId,
  isTriageActive,
  isTriageClearedTransition,
  isTriageDeckMapMode,
  isTriageDeckMapModeActive,
  isTriageOperationDismissed,
  isTriageSpotlightEnabled,
  markTriageCleared,
  nextTriageDeckZoomPreset,
  pickTriageOperation,
  recordTriageActivity,
  reconcileTriageStageCompanion,
  resetTriageSpotlightForTests,
  resetTriageTheater,
  resolveTriageMapMarkerLayout,
  resolveTriageQueue,
  scheduleTriageClear,
  setTriageActive,
  resetTriageDeckZoomForTests,
  setTriageDeckMapModeLive,
  setTriageDeckZoom,
  setTriageSpotlightEnabled,
  subscribeTriage,
  visitTriageTheater,
} from "../core/client/src/canvas/triage-store.js";
import { resolveTriageSideBarSections, TriageSideBar } from "../core/client/src/sidebar/triage-side-bar.js";
import type { OperationNode } from "../core/client/src/types.js";
import { TriageClearPlate } from "../core/client/src/canvas/canvas-overlays.js";
import { resolveTriageDeckPromotion, TRIAGE_DECK_ARRIVAL_DWELL_MS, TriageWatchDeck } from "../core/client/src/canvas/triage-watch-deck.js";
import { triageStageGeometryFor } from "../core/client/src/canvas/coordinates.js";
import { getOperationStatusDetailSnapshot, recordOperationActivityTransition, setOperationStatusDetail } from "../core/client/src/operation-status-detail-store.js";

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
    operationStatus: {},
  });
  setTriageActive(false);
  resetTriageSpotlightForTests();
  resetTriageDeckZoomForTests();
  resetIdleArrivalForTests();
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
    const status: Record<string, OperationActivity> = { picked: "awaiting", next: "awaiting" };
    recordTriageActivity(OPERATIONS, status);
    armTriageSetAside("picked");

    recordTriageActivity(OPERATIONS, { ...status, next: "running" });

    expect(getTriageSetAsideArmedId()).toBe("picked");
  });

  it("disarms set-aside once its own Operation stops waiting", () => {
    const status: Record<string, OperationActivity> = { picked: "awaiting", next: "awaiting" };
    recordTriageActivity(OPERATIONS, status);
    armTriageSetAside("picked");

    recordTriageActivity(OPERATIONS, { ...status, picked: "running" });

    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("disarms set-aside when Triage exits or its armed Operation's Theater is forgotten", () => {
    setTriageActive(true);
    armTriageSetAside("picked");
    setTriageActive(false);
    expect(getTriageSetAsideArmedId()).toBeNull();

    recordTriageActivity(OPERATIONS, { picked: "awaiting", next: "awaiting" });
    armTriageSetAside("picked");
    resetTriageTheater(THEATER_ID);
    expect(getTriageSetAsideArmedId()).toBeNull();
  });

  it("removes a picked stage after its waiting activity clears and advances the next item", () => {
    const waiting: Readonly<Record<string, OperationActivity>> = {
      picked: "awaiting",
      next: "idle",
    };
    markIdleArrival("next");
    recordTriageActivity(OPERATIONS, waiting, 1_000);
    pickTriageOperation("picked");

    const initialQueue = resolveTriageQueue(OPERATIONS, waiting, 1_000);
    expect(initialQueue.map((entry) => entry.operation.id)).toEqual(["picked", "next"]);

    const running: Readonly<Record<string, OperationActivity>> = {
      ...waiting,
      picked: "running",
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
      operationStatus: { [running.id]: "running" },
    });

    const focusedOperationId = focusedTriageOperationId(document.activeElement);
    expect(focusedOperationId).toBe(running.id);
    enterTriage(focusedOperationId);

    const state = getState();
    expect(resolveTriageQueue([running], state.operationStatus)).toHaveLength(0);
    expect(getTriagePick()).toBeNull();
    expect(state.activeOperationId).toBeNull();
    expect(document.activeElement).not.toBe(input);
  });

  it("picks a focused awaiting Operation as the queue head on entry", () => {
    const awaiting = operation("awaiting", 1);
    const later = operation("later", 2);
    const operationStatus: Readonly<Record<string, OperationActivity>> = {
      awaiting: "awaiting",
      later: "awaiting",
    };
    setConsoleState({ operations: [later, awaiting], operationStatus });

    enterTriage(awaiting.id);

    expect(getTriagePick()).toBe(awaiting.id);
    expect(resolveTriageQueue([later, awaiting], operationStatus)[0]?.operation.id)
      .toBe(awaiting.id);
  });

  it("picks a focused idle arrival on entry", () => {
    const arrived = operation("arrived", 1);
    const operationStatus: Readonly<Record<string, OperationActivity>> = { arrived: "idle" };
    markIdleArrival(arrived.id);
    setConsoleState({ operations: [arrived], operationStatus });

    enterTriage(arrived.id);

    expect(getTriagePick()).toBe(arrived.id);
    expect(resolveTriageQueue([arrived], operationStatus)[0]?.operation.id)
      .toBe(arrived.id);
  });

  it("does not let a focused non-waiting Operation displace another waiting Operation on entry", () => {
    const running = operation("running", 1);
    const waiting = operation("waiting", 2);
    const operationStatus: Readonly<Record<string, OperationActivity>> = {
      running: "running",
      waiting: "awaiting",
    };
    setConsoleState({
      operations: [running, waiting],
      activeOperationId: running.id,
      operationStatus,
    });

    enterTriage(running.id);

    expect(getTriagePick()).toBeNull();
    expect(resolveTriageQueue([running, waiting], operationStatus)
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
    const awaiting: Readonly<Record<string, OperationActivity>> = {
      older: "awaiting",
      "future-cleared": "awaiting",
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

    const waiting: Readonly<Record<string, OperationActivity>> = {
      picked: "awaiting",
      next: "idle",
    };
    markIdleArrival("next");
    recordTriageActivity(OPERATIONS, waiting, 1_000);
    pickTriageOperation("picked");
    const initialActivity = resolveTriageQueue(OPERATIONS, waiting, 1_000)[0]!.activity;
    const running: Readonly<Record<string, OperationActivity>> = {
      ...waiting,
      picked: "running",
    };
    recordTriageActivity(OPERATIONS, running, 2_000);
    scheduleTriageClear(
      "picked",
      () => isTriageClearedTransition(initialActivity, running.picked!),
    );

    vi.advanceTimersByTime(599);
    expect(resolveTriageQueue(OPERATIONS, running, 2_599)[0]?.operation.id).toBe("picked");
    vi.advanceTimersByTime(1);
    expect(resolveTriageQueue(OPERATIONS, running, 2_600)[0]?.operation.id).toBe("next");
  });

  it("queues only idle arrivals unless an ordinary idle Operation is picked", () => {
    const fallbackIdle = operation("fallback-idle", 1);
    const liveIdle = operation("live-idle", 2);
    const status: Readonly<Record<string, OperationActivity>> = { "live-idle": "idle" };
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
    const status: Readonly<Record<string, OperationActivity>> = { arrived: "idle" };
    markIdleArrival(arrived.id);
    setConsoleState({
      operations: [arrived],
      activeTheaterId: THEATER_ID,
      activeOperationId: null,
      activeOperationAcknowledged: true,
      operationStatus: status,
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
    expect(resolveTriageQueue([awaiting], { awaiting: "awaiting" })
      .map((entry) => entry.operation.id)).toEqual(["awaiting"]);
  });

  it("round-robins the queue through repeated deferrals without clearing or removing items", () => {
    const operations = [operation("first", 1), operation("second", 2), operation("third", 3)];
    const awaiting: Readonly<Record<string, OperationActivity>> = {
      first: "awaiting",
      second: "awaiting",
      third: "awaiting",
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
    expect(getTriageCleared()).toBe(0);
  });

  it("keeps round-robining past a full cycle when waiting states differ", () => {
    // 대기 상태가 섞이면 한 바퀴 뒤 전부 deferred가 되고, 그때 상태 우선순위가 미룬 순서를
    // 이기면 awaiting 항목이 매번 맨 앞으로 되돌아와 순환이 한 바퀴에서 멈춘다.
    const operations = [operation("aw", 1), operation("idle-a", 2), operation("idle-b", 3)];
    const mixed: Readonly<Record<string, OperationActivity>> = {
      aw: "awaiting",
      "idle-a": "idle",
      "idle-b": "idle",
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
    expect(getTriageCleared()).toBe(0);
  });

  it("clears deferrals when picked, transitioned out of waiting, or Triage exits", () => {
    const operations = [operation("first", 1), operation("second", 2)];
    const awaiting: Readonly<Record<string, OperationActivity>> = {
      first: "awaiting",
      second: "awaiting",
    };
    recordTriageActivity(operations, awaiting, 1_000);

    deferTriageOperation("first", 2_000);
    pickTriageOperation("first");
    expect(resolveTriageQueue(operations, awaiting, 2_000)[0]?.operation.id).toBe("first");
    markTriageCleared("first");

    deferTriageOperation("first", 3_000);
    recordTriageActivity(operations, { ...awaiting, first: "running" }, 3_000);
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
    const status: Readonly<Record<string, OperationActivity>> = {
      "alpha-waiting": "awaiting",
      "beta-waiting": "awaiting",
      "beta-arrived": "idle",
    };
    markIdleArrival("beta-arrived");
    recordTriageActivity(operations, status, 1_000);

    expect(resolveTriageQueue(operations, status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["alpha-waiting", "beta-waiting", "beta-arrived"]);
  });

  it("switches the active Theater when picking a foreign-Theater Operation", () => {
    const foreign = operation("foreign", 1, "theater-b");
    setConsoleState({
      operations: [foreign],
      activeTheaterId: THEATER_ID,
      operationStatus: { foreign: "awaiting" },
    });

    pickTriageOperation("foreign");

    expect(getState().activeTheaterId).toBe("theater-b");
    expect(getTriagePick()).toBe("foreign");
  });

  it("exits global Triage when Formation activates in any Theater", () => {
    setConsoleState({ activeTheaterId: THEATER_ID });
    setTriageActive(true);
    expect(isTriageActive()).toBe(true);

    toggleFormationView();

    expect(getFormationView()).toBe(true);
    expect(isTriageActive()).toBe(false);
  });

  it("partitions sidebar sections into waiting, watching, and idle with theater-then-createdAt order", () => {
    const alphaWaiting = operation("alpha-waiting", 1);
    const alphaRunning = operation("alpha-running", 2);
    const betaBackground = operation("beta-background", 3, "theater-b");
    const betaIdle = operation("beta-idle", 4, "theater-b");
    const alphaIdle = operation("alpha-idle", 5);
    const alphaDormant = operation("alpha-dormant", 6);
    const operations = [betaIdle, alphaIdle, betaBackground, alphaRunning, alphaWaiting, alphaDormant];
    const status: Readonly<Record<string, OperationActivity>> = {
      "alpha-waiting": "awaiting",
      "alpha-running": "running",
      "beta-background": "background",
      "beta-idle": "idle",
      "alpha-idle": "idle",
      "alpha-dormant": "dormant",
    };
    recordTriageActivity(operations, status, 1_000);
    const queue = resolveTriageQueue(operations, status, 1_000);

    const sections = resolveTriageSideBarSections(operations, status, queue, THEATERS);

    expect(sections.waiting.map((operation) => operation.id)).toEqual(["alpha-waiting"]);
    expect(sections.watching.map((operation) => operation.id)).toEqual(["alpha-running", "beta-background"]);
    expect(sections.idle.map((operation) => operation.id)).toEqual(["alpha-idle", "beta-idle"]);
    expect(sections.watching.some((operation) => operation.id === "alpha-dormant")).toBe(false);
  });

  it("keeps the Triage stage and companions inside the inset without overlap", () => {
    const canvasSize = { width: 1_200, height: 800 };
    const geometries = [0, 1, 2].map((slotIndex) =>
      triageStageGeometryFor(canvasSize, 10, slotIndex, 3));

    for (const geometry of geometries) {
      expect(geometry.x).toBeGreaterThanOrEqual(18);
      expect(geometry.y).toBeGreaterThanOrEqual(18);
      expect(geometry.x + geometry.width).toBeLessThanOrEqual(canvasSize.width - 18);
      expect(geometry.y + geometry.height).toBeLessThanOrEqual(canvasSize.height - 66);
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

  it("renders every Operation in the Watch Deck and promotes a clicked idle card", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    setOperationStatusDetail("picked", "Inspecting the latest output");
    recordOperationActivityTransition("picked", "running", 0);

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: OPERATIONS,
        operationStatus: { picked: "running", next: "idle" },
        operationAccent: {},
      }));
    });

    expect([...container.querySelectorAll("[data-triage-deck-card]")].map((card) => card.getAttribute("data-triage-deck-card")))
      .toEqual(["picked", "next"]);
    expect(container.querySelector('[data-triage-deck-card="picked"] .canvas-triage-deck-card-detail')?.textContent)
      .toBe("Inspecting the latest output");
    expect(container.querySelector(".canvas-triage-clear")).toBeNull();

    act(() => (container.querySelector('[data-triage-deck-card="next"]') as HTMLButtonElement).click());
    expect(getTriagePick()).toBe("next");
  });

  it("groups deck cards into theater bands ordered by waiting count", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const alphaIdle = operation("alpha-idle", 1);
    const betaWaiting = operation("beta-waiting", 2, "theater-b");
    const betaRunning = operation("beta-running", 3, "theater-b");
    const status: Readonly<Record<string, OperationActivity>> = {
      "alpha-idle": "idle",
      "beta-waiting": "awaiting",
      "beta-running": "running",
    };
    recordTriageActivity([alphaIdle, betaWaiting, betaRunning], status, 1_000);

    act(() => {
      triagePlateRoot?.render(createElement(TriageWatchDeck, {
        active: true,
        entering: false,
        theaters: THEATERS,
        operations: [alphaIdle, betaWaiting, betaRunning],
        operationStatus: status,
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

  it("holds automatic deck arrivals but lets picks, stage advancement, and suppressed motion promote immediately", () => {
    const started = resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      deckAvailable: true,
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
      deckAvailable: true,
      spotlight: true,
      dwell: started.dwell,
      now: 1_000 + TRIAGE_DECK_ARRIVAL_DWELL_MS,
      suppressed: false,
    }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "picked", picked: true, deckVisible: true, deckAvailable: true, spotlight: true, dwell: started.dwell, now: 1_001, suppressed: false }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "next", picked: false, deckVisible: false, deckAvailable: false, spotlight: true, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: true, deckAvailable: true, spotlight: true, dwell: null, now: 1_001, suppressed: true }).promote).toBe(true);
  });

  it("stops automatic promotion while the spotlight is off, except for picks and stage advancement", () => {
    expect(resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      deckAvailable: true,
      spotlight: false,
      dwell: null,
      now: 1_000,
      suppressed: false,
    })).toEqual({ promote: false, arrivingOperationId: null, dwell: null });
    expect(resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
      deckAvailable: true,
      spotlight: false,
      dwell: null,
      now: 1_000 + TRIAGE_DECK_ARRIVAL_DWELL_MS + 5_000,
      suppressed: false,
    })).toEqual({ promote: false, arrivingOperationId: null, dwell: null });
    // 지목은 스포트라이트와 무관하게 언제나 등단한다.
    expect(resolveTriageDeckPromotion({ operationId: "picked", picked: true, deckVisible: true, deckAvailable: true, spotlight: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
    // deck가 보이지 않을 때는 무대 진행이 멈추지 않는다.
    expect(resolveTriageDeckPromotion({ operationId: "next", picked: false, deckVisible: false, deckAvailable: false, spotlight: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
    // reduced-motion(suppressed)의 즉시 등단보다 스포트라이트 OFF가 우선한다.
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: true, deckAvailable: true, spotlight: false, dwell: null, now: 1_001, suppressed: true }).promote).toBe(false);
    // 입장 연출 중(deck는 곧 보일 상태)에도 저장된 OFF가 무시되지 않는다.
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: false, deckAvailable: true, spotlight: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(false);
    // ON에서는 입장 연출 중 등단이 기존대로 유지된다.
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: false, deckAvailable: true, spotlight: true, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
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
        operationStatus: { picked: "awaiting", next: "idle" },
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
        theaterId: THEATER_ID,
        operations: OPERATIONS,
        operationStatus: { picked: "awaiting", next: "idle" },
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

  it("captures and nulls a visited Theater's focus layer on pick and restores both Theaters on exit", () => {
    const foreign = operation("foreign", 1, "theater-b");
    // B에 저장된 companion layer — 선별 전의 B 화면 상태다.
    setTheaterFocusLayerSnapshot("theater-b", { mode: "companion", operationId: "foreign", returnTo: "underlay" });
    setConsoleState({
      operations: [foreign],
      activeTheaterId: THEATER_ID,
      operationStatus: { foreign: "awaiting" },
    });
    setTriageActive(true);

    pickTriageOperation("foreign");

    expect(getState().activeTheaterId).toBe("theater-b");
    // 방문 시점에 B의 live snapshot은 비워져야 선별 중 companion이 부활하지 않는다.
    expect(getTheaterFocusLayerSnapshot("theater-b")).toBeNull();
    expect(getCompanionOperationId()).toBeNull();

    // 종료 복원의 유효성 검사(대상 geometry 존재·비최소화)를 통과하는 상태를 B에 남긴다 —
    // geometry 저장은 지연(scheduleSave)이라 loadForTheater 왕복으로 flush해 B의 저장 상태에 확정한다.
    loadForTheater("theater-b");
    setOperationGeometry("foreign", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    loadForTheater(THEATER_ID);
    loadForTheater("theater-b");

    setTriageActive(false);
    // 캡처본이 복원되어 B의 선별 전 화면이 되돌아온다.
    expect(getTheaterFocusLayerSnapshot("theater-b")).toEqual({ mode: "companion", operationId: "foreign", returnTo: "underlay" });
    expect(getCompanionOperationId()).toBe("foreign");
    forceDropCompanionOperationId();
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
    const status: Readonly<Record<string, OperationActivity>> = { awaiting: "awaiting" };
    setConsoleState({ operations: [awaiting], activeTheaterId: THEATER_ID, operationStatus: status });
    recordTriageActivity([awaiting], status, 1_000);
    setTriageActive(true);

    dismissTriageOperation("awaiting");
    expect(resolveTriageQueue([awaiting], status, 1_000)).toHaveLength(0);

    setTriageActive(false);
    setTriageActive(true);
    // 치워둠은 진입에 붙는다 — 재진입하면 같은 Operation이 큐로 돌아온다.
    expect(resolveTriageQueue([awaiting], status, 1_000).map((entry) => entry.operation.id)).toEqual(["awaiting"]);

    const older = operation("older", 0);
    const pairStatus: Readonly<Record<string, OperationActivity>> = { awaiting: "awaiting", older: "awaiting" };
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
    const status: Readonly<Record<string, OperationActivity>> = { alpha: "awaiting", beta: "awaiting" };
    setConsoleState({ operations, activeTheaterId: THEATER_ID, operationStatus: status });
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

  it("re-renders the sidebar with moved ordinals and current highlight after a pick", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const operations = [operation("first", 1), operation("second", 2)];
    const status: Readonly<Record<string, OperationActivity>> = { first: "awaiting", second: "awaiting" };
    recordTriageActivity(operations, status, 1_000);
    setTriageActive(true);

    const render = () => {
      triagePlateRoot?.render(createElement(TriageSideBar, {
        theaters: THEATERS,
        operations,
        operationStatus: status,
        onPick: pickTriageOperation,
      }));
    };
    act(render);
    expect(container.querySelectorAll(".triage-side-bar-row")).toHaveLength(2);
    expect(container.querySelector(".triage-side-bar-row")?.textContent).toContain("01");

    // 사이드바는 triage 리비전을 스스로 구독한다 — 부모 prop 없이도 pick 변화에 리렌더한다.
    act(() => pickTriageOperation("second"));

    const rows = [...container.querySelectorAll<HTMLElement>(".triage-side-bar-row")];
    expect(rows[0]?.textContent).toContain("second");
    expect(rows[0]?.classList.contains("is-current")).toBe(true);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(rows[1]?.textContent).toContain("first");
    expect(rows[1]?.classList.contains("is-current")).toBe(false);
  });

  it("renders live previews only for active-Theater cards and the detail fallback for foreign ones", () => {
    const container = document.createElement("div");
    document.body.append(container);
    triagePlateRoot = createRoot(container);
    const home = operation("home", 1);
    const foreign = operation("foreign", 2, "theater-b");
    const operations = [home, foreign];
    const status: Readonly<Record<string, OperationActivity>> = { home: "running", foreign: "running" };
    setConsoleState({ activeTheaterId: THEATER_ID });

    const previewConfigFor = (candidate: OperationNode) => candidate.theaterId === THEATER_ID
      ? {
          active: false,
          geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
          operation: candidate,
          theme: "maritime" as const,
          language: "en" as const,
          zoom: 1,
          onActivate: () => {},
          onClose: () => {},
          onGeometryChange: () => {},
          onRequestCompanions: () => {},
          companionsOpen: false,
          hiddenCompanionPanelIds: [],
          onSetCompanionPanelVisible: () => {},
        }
      : null;
    act(() => {
      // has-preview 클래스는 pool 가용성 게이트를 통과해야 붙는다 — 실제 조립 경로와 같은
      // OperationBodyPool 안에서 렌더한다.
      triagePlateRoot?.render(createElement(OperationBodyPool, {
        operations,
        operationKinds: [],
        capabilities: createHostCapabilities(),
        defaultConfig: (candidate: OperationNode) => previewConfigFor(candidate) ?? ({} as never),
        children: createElement(TriageWatchDeck, {
          active: true,
          entering: false,
          theaters: THEATERS,
          operations,
          operationStatus: status,
          operationAccent: {},
          previewConfigFor,
        }),
      }));
    });

    expect(container.querySelector('[data-triage-deck-card="home"]')?.classList.contains("has-preview")).toBe(true);
    const foreignCard = container.querySelector('[data-triage-deck-card="foreign"]');
    expect(foreignCard?.classList.contains("has-preview")).toBe(false);
    expect(foreignCard?.querySelector(".canvas-triage-deck-card-detail")).not.toBeNull();
  });
});

describe("triage deck zoom", () => {
  it("clamps zoom to [0.35, 2.0] and rejects non-finite input", () => {
    expect(clampTriageDeckZoom(0)).toBe(0.35);
    expect(clampTriageDeckZoom(0.2)).toBe(0.35);
    expect(clampTriageDeckZoom(1.25)).toBe(1.25);
    expect(clampTriageDeckZoom(2.5)).toBe(2.0);
    expect(clampTriageDeckZoom(Number.NaN)).toBe(1.0);
    expect(clampTriageDeckZoom(Number.POSITIVE_INFINITY)).toBe(1.0);
  });

  it("flips map mode exactly when the 260px card base falls below 140px", () => {
    expect(isTriageDeckMapMode(1.0)).toBe(false);
    expect(isTriageDeckMapMode(140 / 260)).toBe(false);
    expect(isTriageDeckMapMode(140 / 260 - 0.01)).toBe(true);
    expect(isTriageDeckMapMode(0.4)).toBe(true);
    expect(isTriageDeckMapMode(0.35)).toBe(true);
  });

  it("cycles presets from the nearest preset to the current zoom", () => {
    expect(nextTriageDeckZoomPreset(1.0)).toBe(1.6);
    expect(nextTriageDeckZoomPreset(1.6)).toBe(0.4);
    expect(nextTriageDeckZoomPreset(0.4)).toBe(1.0);
    // 비-프리셋 배율은 가장 가까운 프리셋 기준으로 다음 단계를 고른다.
    expect(nextTriageDeckZoomPreset(1.2)).toBe(1.6);
    expect(nextTriageDeckZoomPreset(0.5)).toBe(1.0);
  });

  it("persists zoom globally in localStorage and reloads it clamped", () => {
    setTriageDeckZoom(1.6);
    expect(window.localStorage.getItem("fleet-console.triage-deck-zoom")).toBe("1.6");
    window.localStorage.setItem("fleet-console.triage-deck-zoom", "9");
    expect(getTriageDeckZoom()).toBe(2.0);
    resetTriageDeckZoomForTests();
    expect(getTriageDeckZoom()).toBe(1.0);
  });

  it("reflects live map mode overrides and falls back to the persisted zoom", () => {
    setTriageDeckZoom(1.0);
    expect(isTriageDeckMapModeActive()).toBe(false);
    setTriageDeckMapModeLive(true);
    expect(isTriageDeckMapModeActive()).toBe(true);
    setTriageDeckMapModeLive(false);
    expect(isTriageDeckMapModeActive()).toBe(false);
  });

  it("emits only when the live map mode actually changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTriage(listener);
    setTriageDeckMapModeLive(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setTriageDeckMapModeLive(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setTriageDeckMapModeLive(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe("triage map marker layout", () => {
  const geometry = (x: number, y: number) => ({ x, y, width: 100, height: 60, zIndex: 1 });

  it("projects canvas geometry centers into the deck [8%,92%]×[10%,86%] band", () => {
    const layout = resolveTriageMapMarkerLayout([
      { id: "a", geometry: geometry(0, 0) },
      { id: "b", geometry: geometry(900, 400) },
    ]);
    expect(layout.find((marker) => marker.operationId === "a")).toMatchObject({ x: 8, y: 10 });
    expect(layout.find((marker) => marker.operationId === "b")).toMatchObject({ x: 92, y: 86 });
  });

  it("pins a degenerate bounding-box axis to the center", () => {
    const layout = resolveTriageMapMarkerLayout([
      { id: "a", geometry: geometry(0, 0) },
      { id: "b", geometry: geometry(500, 0) },
    ]);
    // y 좌표가 전부 같아 세로 bounding box 높이가 0이면 y는 중앙(48%) 고정이다.
    for (const marker of layout) expect(marker.y).toBe(48);
    expect(layout.find((marker) => marker.operationId === "a")?.x).toBe(8);
    expect(layout.find((marker) => marker.operationId === "b")?.x).toBe(92);
  });

  it("places geometry-less operations deterministically without Math.random", () => {
    const input = [
      { id: "orphan-1", geometry: null },
      { id: "orphan-2", geometry: null },
      { id: "orphan-3", geometry: null },
    ];
    const first = resolveTriageMapMarkerLayout(input);
    const second = resolveTriageMapMarkerLayout([...input].reverse());
    // 반환 순서는 입력 순서를 따르므로 id 기준 정렬 후 비교 — 위치 자체가 결정적이어야 한다.
    const byId = (layout: typeof first) => [...layout].sort((a, b) => a.operationId.localeCompare(b.operationId));
    expect(byId(first)).toEqual(byId(second));
    for (const marker of first) {
      expect(marker.x).toBeGreaterThanOrEqual(4);
      expect(marker.x).toBeLessThanOrEqual(96);
      expect(marker.y).toBeGreaterThanOrEqual(4);
      expect(marker.y).toBeLessThanOrEqual(96);
    }
  });

  it("relaxes overlapping markers apart deterministically", () => {
    // 같은 중심의 geometry 3개 — 이완 후 쌍 거리는 최소 4%를 만족하거나 경계 클램프에 걸린다.
    const input = [
      { id: "a", geometry: geometry(100, 100) },
      { id: "b", geometry: geometry(100, 100) },
      { id: "c", geometry: geometry(100, 100) },
    ];
    const layout = resolveTriageMapMarkerLayout(input);
    expect(layout).toEqual(resolveTriageMapMarkerLayout(input));
    for (let left = 0; left < layout.length; left += 1) {
      for (let right = left + 1; right < layout.length; right += 1) {
        const a = layout[left]!;
        const b = layout[right]!;
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        expect(distance).toBeGreaterThanOrEqual(4 - 1e-6);
      }
    }
  });
});

function operation(id: string, createdAt: number, theaterId = THEATER_ID): OperationNode {
  return {
    id,
    theaterId,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt, updatedAt: createdAt },
  };
}
