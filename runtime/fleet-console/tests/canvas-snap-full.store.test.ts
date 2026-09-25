// 「한 패널만 크게」는 옛 최대화 레이어가 아니라 스냅 유지의 전체 칸 하나다. 그래서 정적 gate가
// 지키던 것(최대화 상태를 들고 있는가)은 사라지고, 지킬 것이 하나 남는다: 전체 칸에 들어간 패널이
// 되돌아갈 자리를 잃지 않는가. 그 자리는 기하만이 아니라 카메라까지다 — 저줌 Cruise에서 ⤢로 들어간
// 뒤 ⤡로 나왔을 때 줌 100%에 남으면, 사용자는 자기가 보던 지도를 잃는다.
import { beforeEach, describe, expect, it } from "vitest";

import {
  getSnapFullOperationId,
  getSnapshot,
  loadForTheater,
  restoreSnapFullOperation,
  setCanvasArenaInsets,
  setCanvasViewportSize,
  setOperationGeometry,
  setViewport,
} from "../features/workspace/client/canvas/canvas-store.js";
import { snapOperationToFullZone } from "../features/workspace/client/canvas/snap-full.js";

const OPERATION_ID = "op-full";
const RESTING = { x: 220, y: 140, width: 640, height: 420, zIndex: 3 };
const RESTING_VIEWPORT = { x: -80, y: -40, zoom: 0.5 };

describe("캔버스 전체 칸 스냅", () => {
  beforeEach(() => {
    loadForTheater("theater-snap-full");
    setCanvasViewportSize({ width: 1600, height: 900 });
    setCanvasArenaInsets({ left: 0, top: 0, right: 0, bottom: 0 });
    setOperationGeometry(OPERATION_ID, RESTING);
    setViewport(RESTING_VIEWPORT);
  });

  it("전체 칸에 들면 직전 기하와 카메라를 기억하고, 떠날 때 그 자리로 되돌린다", () => {
    expect(snapOperationToFullZone(OPERATION_ID)).toBe(true);
    // 전체 칸을 쥔 패널은 별도 상태가 아니라 유지 묶음의 실제 배정에서 파생한다.
    expect(getSnapFullOperationId()).toBe(OPERATION_ID);
    const held = getSnapshot();
    expect(held.operations[OPERATION_ID]!.width).toBeGreaterThan(RESTING.width);
    // 스냅은 줌을 100%로 되돌린다 — 칸 하나가 곧 작업 크기다.
    expect(held.viewport.zoom).toBe(1);

    expect(restoreSnapFullOperation(OPERATION_ID)).toBe(true);
    const restored = getSnapshot();
    expect(getSnapFullOperationId()).toBeNull();
    expect(restored.snapHold).toBeNull();
    expect(restored.operations[OPERATION_ID]).toMatchObject({
      x: RESTING.x,
      y: RESTING.y,
      width: RESTING.width,
      height: RESTING.height,
    });
    expect(restored.viewport).toEqual(RESTING_VIEWPORT);
  });
});
