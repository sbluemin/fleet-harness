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
import { focusOperation, getState, setActiveOperation, setState as setConsoleState } from "../core/client/src/store.js";
import { getSideBarStatusAxis, setSideBarStatusAxis } from "../core/client/src/sidebar/operations-side-bar-store.js";
import {
  clearFormationView,
  forceDropCompanionOperationId,
  getCompanionOperationId,
  clearMaximizedOperationId,
  getFormationView,
  getMaximizedOperationId,
  loadForTheater,
  minimizeOperation,
  setMaximizedOperationId,
  setCompanionOperationId,
  setOperationGeometry,
  toggleFormationView,
} from "../core/client/src/canvas/canvas-store.js";
import {
  armTriageSetAside,
  deferTriageOperation,
  disarmTriageSetAside,
  dismissTriageOperation,
  enterTriage,
  focusedTriageOperationId,
  forgetTriageOperation,
  getTriageCleared,
  getTriagePick,
  getTriageSetAsideArmedId,
  isTriageActive,
  isTriageClearedTransition,
  isTriageOperationDismissed,
  markTriageCleared,
  pickTriageOperation,
  recordTriageActivity,
  reconcileTriageStageCompanion,
  resetTriageTheater,
  resolveTriageQueue,
  scheduleTriageClear,
  setTriageActive,
} from "../core/client/src/canvas/triage-store.js";
import type { OperationNode } from "../core/client/src/types.js";
import { TriageClearPlate } from "../core/client/src/canvas/canvas-overlays.js";
import { resolveTriageDeckPromotion, TRIAGE_DECK_ARRIVAL_DWELL_MS, TriageWatchDeck } from "../core/client/src/canvas/triage-watch-deck.js";
import { triageStageGeometryFor } from "../core/client/src/canvas/coordinates.js";
import { getOperationStatusDetailSnapshot, recordOperationActivityTransition, setOperationStatusDetail } from "../core/client/src/operation-status-detail-store.js";

const THEATER_ID = "theater-a";
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
  resetTriageTheater(THEATER_ID);
  resetIdleArrivalForTests();
  clearFormationView();
  clearMaximizedOperationId();
  forceDropCompanionOperationId();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  resetTriageTheater(THEATER_ID);
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
  it("arms the first set-aside press and dismisses only on the second press", () => {
    const pressSetAside = () => {
      if (getTriageSetAsideArmedId(THEATER_ID) === "picked") {
        disarmTriageSetAside(THEATER_ID);
        dismissTriageOperation(THEATER_ID, "picked");
      } else {
        armTriageSetAside(THEATER_ID, "picked");
      }
    };

    pressSetAside();
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBe("picked");
    expect(isTriageOperationDismissed("picked")).toBe(false);

    pressSetAside();
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();
    expect(isTriageOperationDismissed("picked")).toBe(true);
  });

  it("disarms set-aside after 1500ms", () => {
    armTriageSetAside(THEATER_ID, "picked");

    vi.advanceTimersByTime(1_499);
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBe("picked");
    vi.advanceTimersByTime(1);
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();
  });

  it("disarms set-aside when the Triage stage changes", () => {
    armTriageSetAside(THEATER_ID, "picked");
    deferTriageOperation(THEATER_ID, "picked");
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();

    armTriageSetAside(THEATER_ID, "picked");
    pickTriageOperation(THEATER_ID, "next");
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();
  });

  it("keeps set-aside armed while an unrelated Operation changes activity", () => {
    const status: Record<string, OperationActivity> = { picked: "awaiting", next: "awaiting" };
    recordTriageActivity(THEATER_ID, OPERATIONS, status);
    armTriageSetAside(THEATER_ID, "picked");

    recordTriageActivity(THEATER_ID, OPERATIONS, { ...status, next: "running" });

    expect(getTriageSetAsideArmedId(THEATER_ID)).toBe("picked");
  });

  it("disarms set-aside once its own Operation stops waiting", () => {
    const status: Record<string, OperationActivity> = { picked: "awaiting", next: "awaiting" };
    recordTriageActivity(THEATER_ID, OPERATIONS, status);
    armTriageSetAside(THEATER_ID, "picked");

    recordTriageActivity(THEATER_ID, OPERATIONS, { ...status, picked: "running" });

    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();
  });

  it("disarms set-aside when Triage exits or resets", () => {
    setTriageActive(THEATER_ID, true);
    armTriageSetAside(THEATER_ID, "picked");
    setTriageActive(THEATER_ID, false);
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();

    armTriageSetAside(THEATER_ID, "picked");
    resetTriageTheater(THEATER_ID);
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();
  });

  it.each([false, true])("enables the status axis during Triage and restores %s on exit", (initial) => {
    setSideBarStatusAxis(initial);
    setTriageActive(THEATER_ID, true);
    expect(getSideBarStatusAxis()).toBe(true);
    setTriageActive(THEATER_ID, false);
    expect(getSideBarStatusAxis()).toBe(initial);
  });

  it.each([
    [false, THEATER_ID, "theater-b"],
    [false, "theater-b", THEATER_ID],
    [true, THEATER_ID, "theater-b"],
    [true, "theater-b", THEATER_ID],
  ] as const)("restores the initial %s status axis after %s then %s exit", (
    initial,
    firstExit,
    lastExit,
  ) => {
    const otherTheaterId = "theater-b";
    setSideBarStatusAxis(initial);
    setTriageActive(THEATER_ID, true);
    setTriageActive(otherTheaterId, true);

    setTriageActive(firstExit, false);
    expect(getSideBarStatusAxis()).toBe(true);

    resetTriageTheater(lastExit);
    expect(getSideBarStatusAxis()).toBe(initial);
  });

  it("removes a picked stage after its waiting activity clears and advances the next item", () => {
    const waiting: Readonly<Record<string, OperationActivity>> = {
      picked: "awaiting",
      next: "idle",
    };
    markIdleArrival("next");
    recordTriageActivity(THEATER_ID, OPERATIONS, waiting, 1_000);
    pickTriageOperation(THEATER_ID, "picked");

    const initialQueue = resolveTriageQueue(THEATER_ID, OPERATIONS, waiting, 1_000);
    expect(initialQueue.map((entry) => entry.operation.id)).toEqual(["picked", "next"]);

    const running: Readonly<Record<string, OperationActivity>> = {
      ...waiting,
      picked: "running",
    };
    recordTriageActivity(THEATER_ID, OPERATIONS, running, 2_000);
    expect(isTriageClearedTransition(initialQueue[0]!.activity, "running")).toBe(true);
    markTriageCleared(THEATER_ID, "picked");

    const advancedQueue = resolveTriageQueue(THEATER_ID, OPERATIONS, running, 2_000);
    expect(getTriagePick(THEATER_ID)).toBeNull();
    expect(advancedQueue.map((entry) => entry.operation.id)).toEqual(["next"]);
    expect(advancedQueue[0]?.operation.id).toBe("next");
  });

  it("keeps Formation view and Triage mutually exclusive in both directions", () => {
    toggleFormationView();
    expect(getFormationView()).toBe(true);

    setTriageActive(THEATER_ID, true);
    expect(isTriageActive(THEATER_ID)).toBe(true);
    expect(getFormationView()).toBe(false);

    setTriageActive(THEATER_ID, false);
    setOperationGeometry("picked", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setTriageActive(THEATER_ID, true);
    toggleFormationView();
    expect(getFormationView()).toBe(true);
    expect(isTriageActive(THEATER_ID)).toBe(false);
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
    enterTriage(THEATER_ID, focusedOperationId);

    const state = getState();
    expect(resolveTriageQueue(THEATER_ID, [running], state.operationStatus)).toHaveLength(0);
    expect(getTriagePick(THEATER_ID)).toBeNull();
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

    enterTriage(THEATER_ID, awaiting.id);

    expect(getTriagePick(THEATER_ID)).toBe(awaiting.id);
    expect(resolveTriageQueue(THEATER_ID, [later, awaiting], operationStatus)[0]?.operation.id)
      .toBe(awaiting.id);
  });

  it("picks a focused idle arrival on entry", () => {
    const arrived = operation("arrived", 1);
    const operationStatus: Readonly<Record<string, OperationActivity>> = { arrived: "idle" };
    markIdleArrival(arrived.id);
    setConsoleState({ operations: [arrived], operationStatus });

    enterTriage(THEATER_ID, arrived.id);

    expect(getTriagePick(THEATER_ID)).toBe(arrived.id);
    expect(resolveTriageQueue(THEATER_ID, [arrived], operationStatus)[0]?.operation.id)
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

    enterTriage(THEATER_ID, running.id);

    expect(getTriagePick(THEATER_ID)).toBeNull();
    expect(resolveTriageQueue(THEATER_ID, [running, waiting], operationStatus)
      .map((entry) => entry.operation.id)).toEqual([waiting.id]);
    expect(getState().activeOperationId).toBe(running.id);
  });

  it("drops an invalid saved focus layer instead of restoring a minimized target", () => {
    setOperationGeometry("picked", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setTriageActive(THEATER_ID, true);
    minimizeOperation("picked");

    setTriageActive(THEATER_ID, false);
    expect(getMaximizedOperationId()).toBeNull();
  });

  it("drops a saved focus layer as soon as its Operation is forgotten", () => {
    setOperationGeometry("picked", { x: 0, y: 0, width: 640, height: 400, zIndex: 1 });
    setMaximizedOperationId("picked");
    setTriageActive(THEATER_ID, true);

    forgetTriageOperation("picked");
    setTriageActive(THEATER_ID, false);
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
    markTriageCleared(THEATER_ID, "future-cleared");
    recordTriageActivity(THEATER_ID, [futureCleared, older], awaiting, 1_000);

    const queue = resolveTriageQueue(THEATER_ID, [futureCleared, older], awaiting, 4_000);
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
    recordTriageActivity(THEATER_ID, OPERATIONS, waiting, 1_000);
    pickTriageOperation(THEATER_ID, "picked");
    const initialActivity = resolveTriageQueue(THEATER_ID, OPERATIONS, waiting, 1_000)[0]!.activity;
    const running: Readonly<Record<string, OperationActivity>> = {
      ...waiting,
      picked: "running",
    };
    recordTriageActivity(THEATER_ID, OPERATIONS, running, 2_000);
    scheduleTriageClear(
      THEATER_ID,
      "picked",
      () => isTriageClearedTransition(initialActivity, running.picked!),
    );

    vi.advanceTimersByTime(599);
    expect(resolveTriageQueue(THEATER_ID, OPERATIONS, running, 2_599)[0]?.operation.id).toBe("picked");
    vi.advanceTimersByTime(1);
    expect(resolveTriageQueue(THEATER_ID, OPERATIONS, running, 2_600)[0]?.operation.id).toBe("next");
  });

  it("queues only idle arrivals unless an ordinary idle Operation is picked", () => {
    const fallbackIdle = operation("fallback-idle", 1);
    const liveIdle = operation("live-idle", 2);
    const status: Readonly<Record<string, OperationActivity>> = { "live-idle": "idle" };
    recordTriageActivity(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000);

    expect(resolveTriageQueue(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual([]);

    markIdleArrival("live-idle");
    expect(resolveTriageQueue(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["live-idle"]);

    pickTriageOperation(THEATER_ID, "fallback-idle");
    expect(resolveTriageQueue(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000)
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

    setTriageActive(THEATER_ID, true);
    setActiveOperation(arrived.id, { acknowledged: false });
    expect(resolveTriageQueue(THEATER_ID, [arrived], status)[0]?.operation.id).toBe(arrived.id);

    setActiveOperation(arrived.id);
    expect(acknowledgeIdleArrival(arrived.id)).toBe(false);
    expect(getState().activeOperationAcknowledged).toBe(false);
    expect(getIdleArrivalIds().has(arrived.id)).toBe(true);
    expect(resolveTriageQueue(THEATER_ID, [arrived], status)[0]?.operation.id).toBe(arrived.id);

    setTriageActive(THEATER_ID, false);
    expect(getState().activeOperationAcknowledged).toBe(true);
    expect(getIdleArrivalIds().has(arrived.id)).toBe(false);
    expect(resolveTriageQueue(THEATER_ID, [arrived], status)).toEqual([]);
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
    setTriageActive(THEATER_ID, true);

    focusOperation(arrived.id);

    expect(getIdleArrivalIds().has(arrived.id)).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(false);
  });

  it("acknowledges only the active Operation when the last Triage Theater exits", () => {
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
    setTriageActive(THEATER_ID, true);

    setTriageActive(THEATER_ID, false);

    expect(getIdleArrivalIds().has(active.id)).toBe(false);
    expect(getIdleArrivalIds().has(waiting.id)).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(true);
  });

  it("keeps acknowledgement suspended while any Theater remains in Triage", () => {
    const otherTheaterId = "theater-b";
    const inactiveTheaterId = "theater-c";
    markIdleArrival("arrived");
    setConsoleState({
      activeOperationId: "arrived",
      activeOperationAcknowledged: false,
    });
    setTriageActive(THEATER_ID, true);

    resetTriageTheater(inactiveTheaterId);
    expect(getIdleArrivalIds().has("arrived")).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(false);

    setTriageActive(otherTheaterId, true);
    resetTriageTheater(THEATER_ID);
    expect(getIdleArrivalIds().has("arrived")).toBe(true);
    expect(getState().activeOperationAcknowledged).toBe(false);

    resetTriageTheater(otherTheaterId);
    expect(getIdleArrivalIds().has("arrived")).toBe(false);
    expect(getState().activeOperationAcknowledged).toBe(true);
  });

  it("does nothing when the last Triage Theater exits without an active Operation", () => {
    markIdleArrival("waiting");
    setTriageActive(THEATER_ID, true);

    setTriageActive(THEATER_ID, false);

    expect(getIdleArrivalIds().has("waiting")).toBe(true);
    expect(getState().activeOperationId).toBeNull();
    expect(getState().activeOperationAcknowledged).toBe(true);
  });

  it("does not acknowledge an active Operation when resetting an inactive Theater", () => {
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
    setTriageActive(THEATER_ID, true);

    clearIdleArrival("arrived");

    expect(getIdleArrivalIds().has("arrived")).toBe(false);
  });

  it("clears an idle arrival when its Triage item is dismissed", () => {
    markIdleArrival("arrived");
    setTriageActive(THEATER_ID, true);

    dismissTriageOperation(THEATER_ID, "arrived");

    expect(getIdleArrivalIds().has("arrived")).toBe(false);
  });

  it("always queues awaiting Operations without an idle arrival", () => {
    const awaiting = operation("awaiting", 1);
    expect(resolveTriageQueue(THEATER_ID, [awaiting], { awaiting: "awaiting" })
      .map((entry) => entry.operation.id)).toEqual(["awaiting"]);
  });

  it("round-robins the queue through repeated deferrals without clearing or removing items", () => {
    const operations = [operation("first", 1), operation("second", 2), operation("third", 3)];
    const awaiting: Readonly<Record<string, OperationActivity>> = {
      first: "awaiting",
      second: "awaiting",
      third: "awaiting",
    };
    recordTriageActivity(THEATER_ID, operations, awaiting, 1_000);

    expect(resolveTriageQueue(THEATER_ID, operations, awaiting, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["first", "second", "third"]);
    deferTriageOperation(THEATER_ID, "first", 2_000);
    expect(resolveTriageQueue(THEATER_ID, operations, awaiting, 2_000)
      .map((entry) => entry.operation.id)).toEqual(["second", "third", "first"]);
    deferTriageOperation(THEATER_ID, "second", 2_000);
    expect(resolveTriageQueue(THEATER_ID, operations, awaiting, 2_000)
      .map((entry) => entry.operation.id)).toEqual(["third", "first", "second"]);
    deferTriageOperation(THEATER_ID, "third", 2_000);

    const completedRound = resolveTriageQueue(THEATER_ID, operations, awaiting, 2_000);
    expect(completedRound.map((entry) => entry.operation.id)).toEqual(["first", "second", "third"]);
    expect(completedRound).toHaveLength(3);
    expect(getTriageCleared(THEATER_ID)).toBe(0);
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
    recordTriageActivity(THEATER_ID, operations, mixed, 1_000);

    const visited: string[] = [];
    let now = 2_000;
    for (let press = 0; press < 6; press += 1) {
      const head = resolveTriageQueue(THEATER_ID, operations, mixed, now)[0]!.operation.id;
      visited.push(head);
      deferTriageOperation(THEATER_ID, head, now);
      now += 1_000;
    }

    expect(visited).toEqual(["aw", "idle-a", "idle-b", "aw", "idle-a", "idle-b"]);
    expect(getTriageCleared(THEATER_ID)).toBe(0);
  });

  it("clears deferrals when picked, transitioned out of waiting, or Triage exits", () => {
    const operations = [operation("first", 1), operation("second", 2)];
    const awaiting: Readonly<Record<string, OperationActivity>> = {
      first: "awaiting",
      second: "awaiting",
    };
    recordTriageActivity(THEATER_ID, operations, awaiting, 1_000);

    deferTriageOperation(THEATER_ID, "first", 2_000);
    pickTriageOperation(THEATER_ID, "first");
    expect(resolveTriageQueue(THEATER_ID, operations, awaiting, 2_000)[0]?.operation.id).toBe("first");
    markTriageCleared(THEATER_ID, "first");

    deferTriageOperation(THEATER_ID, "first", 3_000);
    recordTriageActivity(THEATER_ID, operations, { ...awaiting, first: "running" }, 3_000);
    recordTriageActivity(THEATER_ID, operations, awaiting, 4_000);
    expect(resolveTriageQueue(THEATER_ID, operations, awaiting, 4_000)[0]?.operation.id).toBe("first");

    setTriageActive(THEATER_ID, true);
    deferTriageOperation(THEATER_ID, "first", 5_000);
    setTriageActive(THEATER_ID, false);
    setTriageActive(THEATER_ID, true);
    recordTriageActivity(THEATER_ID, operations, awaiting, 6_000);
    expect(resolveTriageQueue(THEATER_ID, operations, awaiting, 6_000)
      .map((entry) => entry.operation.id)).toEqual(["first", "second"]);
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
    setTriageActive(THEATER_ID, true);
    setCompanionOperationId("picked");
    expect(getCompanionOperationId()).toBe("picked");

    setTriageActive(THEATER_ID, false);
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
        theaterId: THEATER_ID,
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
    expect(getTriagePick(THEATER_ID)).toBe("next");
  });

  it("holds automatic deck arrivals but lets picks, stage advancement, and suppressed motion promote immediately", () => {
    const started = resolveTriageDeckPromotion({
      operationId: "awaiting",
      picked: false,
      deckVisible: true,
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
      dwell: started.dwell,
      now: 1_000 + TRIAGE_DECK_ARRIVAL_DWELL_MS,
      suppressed: false,
    }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "picked", picked: true, deckVisible: true, dwell: started.dwell, now: 1_001, suppressed: false }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "next", picked: false, deckVisible: false, dwell: null, now: 1_001, suppressed: false }).promote).toBe(true);
    expect(resolveTriageDeckPromotion({ operationId: "awaiting", picked: false, deckVisible: true, dwell: null, now: 1_001, suppressed: true }).promote).toBe(true);
  });

  it("marks the dwelling Watch Deck card as arriving", () => {
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
        arrivingOperationId: "picked",
      }));
    });

    expect(container.querySelector('[data-triage-deck-card="picked"]')?.classList.contains("is-arriving")).toBe(true);
    expect(container.querySelector('[data-triage-deck-card="next"]')?.classList.contains("is-arriving")).toBe(false);
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

    setTriageActive(THEATER_ID, true);
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

    armTriageSetAside(THEATER_ID, "picked");
    reconcileTriageStageCompanion(
      pickedStage,
      { theaterId: THEATER_ID, operationId: "next" },
    );
    expect(getCompanionOperationId()).toBeNull();
    expect(getTriageSetAsideArmedId(THEATER_ID)).toBeNull();

    setTriageActive(THEATER_ID, false);
    expect(getCompanionOperationId()).toBe("picked");
    forceDropCompanionOperationId();
  });
});

function operation(id: string, createdAt: number): OperationNode {
  return {
    id,
    theaterId: THEATER_ID,
    type: "shell",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt, updatedAt: createdAt },
  };
}
