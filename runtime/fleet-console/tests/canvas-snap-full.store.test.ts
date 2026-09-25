// @vitest-environment jsdom
//
// 「한 패널만 크게」는 옛 최대화 레이어가 아니라 스냅 유지의 전체 칸 하나다. 그래서 정적 gate가
// 지키던 것(최대화 상태를 들고 있는가)은 사라지고, 지킬 것이 하나 남는다: 전체 칸에 들어간 패널이
// 되돌아갈 자리를 잃지 않는가. 그 자리는 기하만이 아니라 카메라까지다 — 저줌 Cruise에서 ⤢로 들어간
// 뒤 ⤡로 나왔을 때 줌 100%에 남으면, 사용자는 자기가 보던 지도를 잃는다. 그리고 그 칸은 이웃의 자리를
// 빼앗지 않는다 — 칸 뒤에 감춰진 패널은 아레나에 자리를 차지하지 않으므로, Station Keeping이 그 사각형을
// 장애물로 세어 이웃을 밀어내고 그 좌표를 영속시키면 안 된다(Theater를 다녀오면 이웃이 화면 밖에 있다).
import { beforeEach, describe, expect, it } from "vitest";

import {
  getSnapFullOperationId,
  getSnapshot,
  loadForTheater,
  resolveLaunchGeometry,
  restoreSnapFullOperation,
  setCanvasArenaInsets,
  setCanvasViewportSize,
  setOperationGeometry,
  setStationKeeping,
  setViewport,
} from "../features/workspace/client/canvas/canvas-store.js";
import { snapOperationToFullZone } from "../features/workspace/client/canvas/snap-full.js";

const OPERATION_ID = "op-full";
const PEER_ID = "op-peer";
const RESTING = { x: 220, y: 140, width: 640, height: 420, zIndex: 3 };
const PEER_RESTING = { x: 40, y: 600, width: 420, height: 240, zIndex: 1 };
const RESTING_VIEWPORT = { x: -80, y: -40, zoom: 0.5 };
// 칸 뒤에서 보면 비어 있는 자리 — RESTING(220,140,640×420) 어디와도 겹치지 않고 아레나 안이다.
const LAUNCH_REQUEST = { x: 900, y: 600, width: 400, height: 200, zIndex: 2 };
const THEATER_ID = "theater-snap-full";
const MOTION = (reduced: boolean) => ((query: string) => ({ matches: reduced && query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;

describe("캔버스 전체 칸 스냅", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // 기억·복원은 카메라의 최종 상태를 재는 것이므로 tween을 끄고 본다 — 줌이 rAF로 걸어가면 재는
    // 대상이 애니메이션 타이밍으로 바뀐다. 그 이동 중에도 기억이 남는지는 사례 끝에서 다시 켜고 잰다.
    window.matchMedia = MOTION(true);
    loadForTheater(THEATER_ID);
    setCanvasViewportSize({ width: 1600, height: 900 });
    setCanvasArenaInsets({ left: 0, top: 0, right: 0, bottom: 0 });
    setOperationGeometry(OPERATION_ID, RESTING);
    setViewport(RESTING_VIEWPORT);
  });

  it("전체 칸에 들면 직전 기하와 카메라를 기억하고, 떠날 때 그 자리로 되돌린다", async () => {
    expect(snapOperationToFullZone(OPERATION_ID, () => undefined)).toBe(true);
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

    // 규율이 켜진 Theater를 다녀와도 칸 뒤의 이웃은 제자리다. 로드 시점의 불변식 복구가 전체 칸을
    // 실재 장애물로 세면 이웃이 아레나 밖으로 밀려나고, 그 좌표가 저장까지 수렴해 되돌릴 길이 없다.
    setOperationGeometry(PEER_ID, PEER_RESTING);
    setStationKeeping(true);
    const settledPeer = getSnapshot().operations[PEER_ID]!;
    expect(snapOperationToFullZone(OPERATION_ID, () => undefined)).toBe(true);

    loadForTheater(null);
    loadForTheater(THEATER_ID);

    const returned = getSnapshot();
    expect(getSnapFullOperationId()).toBe(OPERATION_ID);
    expect(returned.operations[PEER_ID]).toMatchObject({ x: settledPeer.x, y: settledPeer.y });

    // 새 Operation의 첫 자리도 같은 이유로 칸의 사각형을 피하지 않는다 — 칸을 쥔 패널이 돌아갈 자리가
    // 실제 장애물이다. 아레나만큼 큰 사각형을 장애물로 세면 피할 빈자리가 없어 새 패널이 화면 밖으로
    // 밀려나고, 그 패널이 칸을 승계하는 순간 화면 밖 좌표가 복원 메모로 굳는다(⤡에 패널이 사라진다).
    expect(resolveLaunchGeometry(THEATER_ID, LAUNCH_REQUEST)).toMatchObject({ x: LAUNCH_REQUEST.x, y: LAUNCH_REQUEST.y });

    // 되돌아갈 자리는 카메라 이동이 흐르는 중에 Theater를 옮겨도(또는 새로고침해도) 남는다 — 저장이
    // 애니메이션 중간 줌을 적으면 다음 로드가 유지를 줌 불일치로 버리고, 패널은 칸 크기로 굳는다.
    expect(restoreSnapFullOperation(OPERATION_ID)).toBe(true);
    window.matchMedia = MOTION(false);
    setViewport(RESTING_VIEWPORT);
    expect(snapOperationToFullZone(OPERATION_ID, () => undefined)).toBe(true);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    expect(getSnapshot().viewport.zoom).not.toBe(1);

    loadForTheater(null);
    loadForTheater(THEATER_ID);

    expect(getSnapFullOperationId()).toBe(OPERATION_ID);
    // 좌표는 규율이 켜져 있으면 제 간격만큼 다듬으므로, 되돌아왔다는 사실은 크기로 잰다 — 메모를 잃으면
    // 패널은 칸 크기(아레나만큼)로 굳는다.
    expect(restoreSnapFullOperation(OPERATION_ID)).toBe(true);
    expect(getSnapshot().operations[OPERATION_ID]).toMatchObject({ width: RESTING.width, height: RESTING.height });
  });
});
