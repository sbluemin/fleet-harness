// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { OperationActivity } from "@fleet-console/sdk/plugin";

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
  deferTriageOperation,
  focusedTriageOperationId,
  forgetTriageOperation,
  getTriageCleared,
  getTriagePick,
  isTriageActive,
  isTriageClearedTransition,
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
import { TriageClearPlate } from "../core/client/src/canvas/triage-clear-plate.js";
import { triageStageGeometryFor } from "../core/client/src/canvas/triage-geometry.js";

const THEATER_ID = "theater-a";
const OPERATIONS = [operation("picked", 1), operation("next", 2)];
let triagePlateRoot: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  window.localStorage.clear();
  loadForTheater(THEATER_ID);
  resetTriageTheater(THEATER_ID);
  clearFormationView();
  clearMaximizedOperationId();
  forceDropCompanionOperationId();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  vi.useRealTimers();
});

describe("triage store", () => {
  it("removes a picked stage after its waiting activity clears and advances the next item", () => {
    const waiting: Readonly<Record<string, OperationActivity>> = {
      picked: "awaiting",
      next: "idle",
    };
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

  it("resolves the focused canvas Operation for activation-time picking", () => {
    const frame = document.createElement("article");
    frame.className = "canvas-operation";
    frame.dataset.operationId = "focused-op";
    const input = document.createElement("input");
    frame.append(input);
    document.body.append(frame);
    input.focus();

    const focusedOperationId = focusedTriageOperationId(document.activeElement);
    expect(focusedOperationId).toBe("focused-op");
    if (focusedOperationId) pickTriageOperation(THEATER_ID, focusedOperationId);
    setTriageActive(THEATER_ID, true);
    expect(getTriagePick(THEATER_ID)).toBe("focused-op");
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

  it("queues only reported idle Operations unless a fallback idle Operation is picked", () => {
    const fallbackIdle = operation("fallback-idle", 1);
    const liveIdle = operation("live-idle", 2);
    const status: Readonly<Record<string, OperationActivity>> = { "live-idle": "idle" };
    recordTriageActivity(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000);

    expect(resolveTriageQueue(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["live-idle"]);

    pickTriageOperation(THEATER_ID, "fallback-idle");
    expect(resolveTriageQueue(THEATER_ID, [fallbackIdle, liveIdle], status, 1_000)
      .map((entry) => entry.operation.id)).toEqual(["fallback-idle", "live-idle"]);
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
      }));
    });
    expect(container.querySelector(".canvas-triage-clear")).toBeNull();

    act(() => {
      triagePlateRoot?.render(createElement(TriageClearPlate, {
        active: true,
        entering: false,
        hasContent: false,
      }));
    });
    expect(container.querySelector(".canvas-triage-clear")).not.toBeNull();
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

    reconcileTriageStageCompanion(
      pickedStage,
      { theaterId: THEATER_ID, operationId: "next" },
    );
    expect(getCompanionOperationId()).toBeNull();

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
