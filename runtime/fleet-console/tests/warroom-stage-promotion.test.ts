// @vitest-environment jsdom
// War Room 완료 승격 계약 — 사이드바 활동 추적기(도착 마크)와 선별 큐가 만나는 지점을 고정한다.
// 두 스토어를 함께 태워야만 관측되는 계약이라 triage-store.test.ts가 아니라 여기에 둔다.

import { beforeEach, describe, expect, it } from "vitest";

import { resetIdleArrivalForTests, getIdleArrivalIds } from "../core/client/src/operation-idle-arrival.js";
import { getState, setActiveOperation, setState as setConsoleState } from "../core/client/src/store.js";
import { loadForTheater } from "../core/client/src/canvas/canvas-store.js";
import {
  resetSideBarStatusRecencyForTests,
  trackOperationActivityTransitions,
} from "../core/client/src/sidebar/operations-side-bar-store.js";
import {
  enterTriage,
  recordTriageActivity,
  resolveTriageQueue,
  setTriageActive,
} from "../core/client/src/canvas/triage-store.js";
import type { OperationNode } from "../core/client/src/types.js";

const THEATER_ID = "theater-a";

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

const OPS = [operation("panel-a", 1), operation("panel-b", 2)];

// app.tsx:170의 전역 구독이 하는 일과 같다 — store 스냅샷을 제품 writer에 그대로 넘긴다.
function pumpActivityTracking(): void {
  const state = getState();
  trackOperationActivityTransitions({
    operations: state.operations,
    operationRuntime: state.operationRuntime,
    activeTheaterId: state.activeTheaterId,
    activeOperationId: state.activeOperationId,
    activeOperationAcknowledged: state.activeOperationAcknowledged,
  });
  recordTriageActivity(state.operations, state.operationRuntime);
}

function setRuntime(runtime: Record<string, { lifecycle: "live"; activity: "running" | "idle" }>): void {
  setConsoleState({ operationRuntime: runtime });
  pumpActivityTracking();
}

function queueIds(): readonly string[] {
  const state = getState();
  return resolveTriageQueue(state.operations, state.operationRuntime).map((entry) => entry.operation.id);
}

beforeEach(() => {
  window.localStorage.clear();
  loadForTheater(THEATER_ID);
  setTriageActive(false);
  resetIdleArrivalForTests();
  resetSideBarStatusRecencyForTests();
  setConsoleState({
    theaters: [{ id: THEATER_ID, label: "Alpha", createdAt: "2026-08-18T00:00:00.000Z", lastOpenedAt: "2026-08-18T00:00:00.000Z", hasWiki: false, activeAdmiralCount: 0 }],
    operations: OPS,
    activeTheaterId: THEATER_ID,
    activeOperationId: null,
    activeOperationAcknowledged: true,
    operationRuntime: {},
  });
  // 두 패널 모두 running으로 baseline을 잡는다(firstLive 처리).
  setRuntime({
    "panel-a": { lifecycle: "live", activity: "running" },
    "panel-b": { lifecycle: "live", activity: "running" },
  });
});

describe("War Room 완료 승격", () => {
  it("대조군: 비활성 패널이 완료되면 대기 큐에 든다", () => {
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "running" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });
    expect(getIdleArrivalIds().has("panel-b")).toBe(true);
    expect(queueIds()).toContain("panel-b");
  });

  it("대조군: 큐가 빈 채 War Room에 들어가면 enterTriage가 활성을 지워 완료가 큐에 든다", () => {
    setActiveOperation("panel-a");
    expect(getState().activeOperationAcknowledged).toBe(true);

    enterTriage(null);
    expect(getState().activeOperationId).toBeNull();

    setRuntime({
      "panel-a": { lifecycle: "live", activity: "idle" },
      "panel-b": { lifecycle: "live", activity: "running" },
    });
    expect(queueIds()).toContain("panel-a");
  });

  it("선별 중에는 인정된 활성의 완료도 대기 큐에 든다", () => {
    // 1) Cruise에서 panel-a를 클릭해 활성화 — 도착 마크가 없으므로 acknowledged=true.
    setActiveOperation("panel-a");
    expect(getState().activeOperationAcknowledged).toBe(true);

    // 2) panel-b가 먼저 완료되어 대기 큐가 생긴다.
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "running" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });
    expect(queueIds()).toEqual(["panel-b"]);

    // 3) 큐가 비어있지 않으므로 enterTriage는 활성을 지우지 않는다. 인정 플래그도 그대로 둔다 —
    //    바뀌는 것은 확인 처리의 정지뿐이고, 억제 판정이 그 정지를 읽는다.
    enterTriage(null);
    expect(getState().activeOperationId).toBe("panel-a");
    expect(getState().activeOperationAcknowledged).toBe(true);

    // 4) panel-a가 완료되면 도착 마크가 붙어 대기 큐에 든다.
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "idle" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });
    expect(getIdleArrivalIds().has("panel-a")).toBe(true);
    expect(queueIds()).toContain("panel-a");
  });

  it("무대가 서지 않아 자동 포커스가 활성을 덮어쓰지 못해도 완료가 큐에 든다", () => {
    // 스포트라이트 OFF·투어/모달·패널 안 입력 포커스는 무대 자동 포커스를 건너뛰게 한다.
    // 그 구제가 없어도 선별 중에는 억제가 정지하므로 완료는 큐로 들어와야 한다.
    setActiveOperation("panel-a");
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "running" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });
    enterTriage(null);

    // 무대 자동 포커스(setActiveOperation(stage, { acknowledged: false }))를 일부러 호출하지 않는다.
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "idle" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });

    expect(queueIds()).toContain("panel-a");
  });

  it("선별을 나오면 인정된 활성의 완료 억제가 되살아난다", () => {
    setActiveOperation("panel-a");
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "running" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });
    enterTriage(null);
    setTriageActive(false);
    expect(getState().activeOperationAcknowledged).toBe(true);

    // 선별 밖에서 포커스한 패널이 눈앞에서 끝나는 것은 "미확인 도착"이 아니다 — 기존 계약이다.
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "idle" },
      "panel-b": { lifecycle: "live", activity: "idle" },
    });
    expect(getIdleArrivalIds().has("panel-a")).toBe(false);
    expect(queueIds()).not.toContain("panel-a");
  });

  it("선별 왕복이 진입 전부터 있던 도착 마크를 지우지 않는다", () => {
    // Theater만 바꾸면 activeOperationId는 남는다. 그 잔류 활성이 다른 Theater에서 완료하면
    // Theater 불일치로 도착 마크가 붙는다. 선별을 여닫는 것만으로 그 마크가 사라지면 안 된다.
    setConsoleState({ activeTheaterId: "theater-other" });
    setActiveOperation("panel-a");
    expect(getState().activeOperationAcknowledged).toBe(true);

    setRuntime({
      "panel-a": { lifecycle: "live", activity: "running" },
      "panel-b": { lifecycle: "live", activity: "running" },
    });
    setRuntime({
      "panel-a": { lifecycle: "live", activity: "idle" },
      "panel-b": { lifecycle: "live", activity: "running" },
    });
    expect(getIdleArrivalIds().has("panel-a")).toBe(true);

    setTriageActive(true);
    setTriageActive(false);

    expect(getIdleArrivalIds().has("panel-a")).toBe(true);
  });
});
