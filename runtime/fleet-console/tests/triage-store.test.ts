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
import { clearOperationRuntime, findOperation, focusOperation, getState, hydrateOperations, requestOperationLaunchMenu, setActiveOperation, setActiveTheater, setOperationRuntime, setState as setConsoleState } from "../core/client/src/integration/store.js";
import { fetchOperations } from "../core/client/src/integration/api.js";
import {
  detachAlignAllPanel,
  forceDropCompanionOperationId,
  getAlignAll,
  getCompanionOperationId,
  getSnapshot as getCanvasSnapshot,
  getTheaterFocusLayerSnapshot,
  loadForTheater,
  minimizeOperation,
  reconcileAlignAll,
  rejoinAlignAllPanel,
  releaseAlignAll,
  releaseSnapHold,
  setCompanionOperationId,
  setOperationGeometry,
  setTheaterFocusLayerSnapshot,
  snapOperationToArenaRect,
  syncSnapHoldGeometry,
  toggleAlignAll,
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
  releaseAlignAll();
  releaseSnapHold();
  forceDropCompanionOperationId();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  setTriageActive(false);
  resetTriageSpotlightForTests();
  resetTriageDeckZoomForTests();
  forceDropCompanionOperationId();
  releaseAlignAll();
  releaseSnapHold();
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
  it("keeps a member under its Commander: off every list, on the Commander's activity, and reachable by id", async () => {
    const commander = operation("commander", 1);
    const member = { ...operation("member", 2), parentOperationId: commander.id };
    // 서버 목록을 받는 길(파서 → 수화) 그대로 싣는다 — 파서가 부모를 떨어뜨리면 구성원이 모든 목록에 선다.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ operations: [commander, member] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    try { hydrateOperations(await fetchOperations()); } finally { vi.unstubAllGlobals(); }
    setConsoleState({ activeTheaterId: THEATER_ID, activeOperationId: null });
    const off = subscribeOperationActivityTracking();
    try {
      // 기본 목록은 사이드바·팔레트·War Room·부관단이 함께 읽는 원천이다 — 구성원은 거기 없고 id 로는 닿는다.
      expect(getState().operations.map((entry) => entry.id)).toEqual([commander.id]);
      expect(findOperation(member.id)?.parentOperationId).toBe(commander.id);

      setOperationRuntime(commander.id, { lifecycle: "live", activity: "running" });
      setOperationRuntime(member.id, { lifecycle: "live", activity: "running" });
      setOperationRuntime(commander.id, { lifecycle: "live", activity: "idle" });
      expect(getState().operationRuntime[commander.id]).toEqual({ lifecycle: "live", activity: "background" });
      expect(getIdleArrivalIds().has(commander.id)).toBe(false);
      expect(resolveTriageQueue(getState().operations, getState().operationRuntime)).toEqual([]);

      setOperationRuntime(member.id, { lifecycle: "live", activity: "awaiting" });
      expect(getState().operationRuntime[commander.id]).toEqual({ lifecycle: "live", activity: "awaiting" });
      expect(resolveTriageQueue(getState().operations, getState().operationRuntime).map((entry) => entry.operation.id)).toEqual([commander.id]);

      // 구성원 구성이 그대로인 쓰기(제목 바뀜)는 공개 활동을 다시 세지 않는다.
      const unchangedRuntime = getState().operationRuntime;
      setConsoleState({ operations: [commander, { ...member, title: "renamed" }] });
      expect(getState().operationRuntime).toBe(unchangedRuntime);

      // 구성원이 끝나면 도착은 지휘관의 것이다 — 숨은 구성원은 도착 표식을 남기지 않는다(보이지 않는 Theater 틱의 원천).
      setOperationRuntime(member.id, { lifecycle: "live", activity: "idle" });
      expect(getState().operationRuntime[commander.id]).toEqual({ lifecycle: "live", activity: "idle" });
      expect(getIdleArrivalIds().has(commander.id)).toBe(true);
      expect(getIdleArrivalIds().has(member.id)).toBe(false);

      // 구성원을 가리킨 이동은 지휘관 패널로 가서 그 본문을 보이고, 지휘관을 가리킨 이동은 지휘관 본문으로 돌린다.
      focusOperation(member.id);
      expect(getState().activeOperationId).toBe(commander.id);
      expect(getState().nestedBodySelection[commander.id]).toBe(member.id);
      focusOperation(commander.id);
      expect(getState().nestedBodySelection[commander.id]).toBeUndefined();
    } finally {
      off();
      setConsoleState({ operations: [], nestedBodySelection: {}, activeOperationId: null });
      clearOperationRuntime(commander.id);
      clearOperationRuntime(member.id);
      resetIdleArrivalForTests();
    }
  });

  it("keeps align-all across Triage round-trips, and align entry exits Triage", () => {    toggleAlignAll();
    expect(getAlignAll()).not.toBeNull();

    // 선별 진입은 정렬을 걷지 않는다 — War Room을 다녀와도 정렬이 남는다.
    setTriageActive(true);
    expect(isTriageActive()).toBe(true);
    expect(getAlignAll()).not.toBeNull();

    setTriageActive(false);
    expect(getAlignAll()).not.toBeNull();

    // 정렬 진입은 선별을 끝낸다.
    toggleAlignAll();
    expect(getAlignAll()).toBeNull();
    setTriageActive(true);
    expect(isTriageActive()).toBe(true);
    toggleAlignAll();
    expect(getAlignAll()).not.toBeNull();
    expect(isTriageActive()).toBe(false);
  });

  // 저장 무결성: 정렬 중 칸 동기화·빼내기·다시 넣기가 켜기 전 기억을 오염시키지 않고,
  // 끄면 그 자리와 켜기 전 수동 묶음이 정확히 돌아온다. 복원이 로컬 기억만으로 닫히므로
  // 서버 Cruise 기하는 정렬 내내 손대지 않는 것이 전제다(네트워크 무PATCH는 격리 실기로 확인).
  it("restores pre-align geometry and the prior hold exactly when align-all turns off", () => {
    setOperationGeometry("b", { x: 700, y: 20, width: 640, height: 400, zIndex: 2 });
    snapOperationToArenaRect("a", { x: 0, y: 0, width: 100, height: 100 }, {
      presetId: "half",
      zones: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
      zoneIndex: 0,
    });
    const before = getCanvasSnapshot().operations;

    toggleAlignAll();
    const meta = getAlignAll();
    expect(meta).not.toBeNull();
    // 켜기 전 기억은 손대기 전 그대로다.
    expect(meta!.savedGeometries).toEqual(before);
    expect(meta!.savedSnapHold?.assignments).toEqual({ a: 0 });

    // 멤버십 재계산·칸 동기화·빼내기·다시 넣기가 기억을 오염시키지 않는다.
    reconcileAlignAll(["a", "b"]);
    expect(getCanvasSnapshot().snapHold?.assignments).toEqual({ a: 0, b: 1 });
    syncSnapHoldGeometry([
      { sessionId: "a", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { sessionId: "b", rect: { x: 100, y: 0, width: 100, height: 100 } },
    ]);
    detachAlignAllPanel("b");
    expect(getAlignAll()!.savedGeometries).toEqual(before);
    rejoinAlignAllPanel("b");
    reconcileAlignAll(["a", "b"]);

    // 끄면 켜기 전 자리와 수동 묶음이 정확히 돌아온다.
    toggleAlignAll();
    expect(getAlignAll()).toBeNull();
    expect(getCanvasSnapshot().operations).toEqual(before);
    expect(getCanvasSnapshot().snapHold?.assignments).toEqual({ a: 0 });
  });

  // 빼낸 채로 끄면 묶음만 복원되고 빼낸 패널은 놓은 자리에 남는다 — 풀린 순간부터
  // 자유 패널이라 드롭 좌표가 새 Cruise 자리다(서버 커밋은 렌더가 드롭 시점에 맡는다).
  it("keeps the detached panel where it was dropped when align-all turns off", () => {
    setOperationGeometry("b", { x: 700, y: 20, width: 640, height: 400, zIndex: 2 });
    setOperationGeometry("a", { x: 10, y: 20, width: 640, height: 400, zIndex: 1 });
    const before = getCanvasSnapshot().operations;

    toggleAlignAll();
    reconcileAlignAll(["a", "b"]);
    syncSnapHoldGeometry([
      { sessionId: "a", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { sessionId: "b", rect: { x: 100, y: 0, width: 100, height: 100 } },
    ]);
    detachAlignAllPanel("b");
    // 드롭 자리에 놓은 좌표가 그대로라고 둔다.
    const dropped = { x: 500, y: 500, width: 640, height: 400, zIndex: 2 };
    setOperationGeometry("b", dropped);

    toggleAlignAll();
    expect(getAlignAll()).toBeNull();
    expect(getCanvasSnapshot().operations.a).toEqual(before.a);
    expect(getCanvasSnapshot().operations.b).toMatchObject({ x: 500, y: 500 });
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
