import { beforeEach, describe, expect, it } from "vitest";

import { claimTopZIndex, getSnapshot, loadForTheater, setOperationGeometry, type OperationGeometry } from "../core/client/src/canvas/canvas-store.js";

const GEO: OperationGeometry = { x: 0, y: 0, width: 100, height: 100, zIndex: 0 };

// Operation은 setOperationGeometry로 store에 저장되므로 스냅샷에서 zIndex를 읽는다.
function operationZ(sessionId: string): number {
  const z = getSnapshot().operations[sessionId]?.zIndex;
  if (z === undefined) throw new Error(`operation ${sessionId} not found`);
  return z;
}

describe("shared top z-index counter (Operations + shell)", () => {
  beforeEach(() => {
    // 각 테스트를 빈 Theater에서 시작한다 — Operation을 비운다. 카운터는 단조 증가만 하므로
    // 모든 단언은 상대적(greater-than)으로 작성해 시작값에 무관하게 성립한다.
    loadForTheater(null);
  });

  it("새로 발급한 셸 z-index가 기존 Operation보다 위에 온다", () => {
    setOperationGeometry("op-1", { ...GEO });
    // 셸 생성 경로(canvas.tsx launchViaPlugin)와 동일하게 공유 카운터에서 발급한다.
    const shellZ = claimTopZIndex();
    expect(shellZ).toBeGreaterThan(operationZ("op-1"));
  });

  it("셸이 위에 있어도 Operation을 활성화하면 셸 위로 올라온다", () => {
    setOperationGeometry("op-1", { ...GEO });
    const shellZ = claimTopZIndex();
    expect(shellZ).toBeGreaterThan(operationZ("op-1"));
    // bringToFront(Operation) — onPointerDown → setOperationGeometry
    setOperationGeometry("op-1", { ...GEO });
    expect(operationZ("op-1")).toBeGreaterThan(shellZ);
  });

  it("Operations가 위에 있어도 셸을 활성화하면 다시 Operations 위로 올라온다", () => {
    setOperationGeometry("op-1", { ...GEO });
    claimTopZIndex(); // 초기 셸 생성
    setOperationGeometry("op-1", { ...GEO }); // Operations가 최상단
    // bringToFront(플러그인 패널) — descriptor render → claimTopZIndex
    const shellZ = claimTopZIndex();
    expect(shellZ).toBeGreaterThan(operationZ("op-1"));
  });

  it("두 Operation 사이의 활성화 순서도 보존된다(회귀 가드)", () => {
    setOperationGeometry("op-1", { ...GEO });
    setOperationGeometry("op-2", { ...GEO });
    expect(operationZ("op-2")).toBeGreaterThan(operationZ("op-1"));
    setOperationGeometry("op-1", { ...GEO });
    expect(operationZ("op-1")).toBeGreaterThan(operationZ("op-2"));
  });
});
