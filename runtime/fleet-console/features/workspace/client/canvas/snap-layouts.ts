// Cruise 패널 스냅 — 아레나(보이는 화면)를 분수로 나눈 칸에 패널 하나를 앉히는 순수 기하.
//
// 칸은 항상 "지금 보이는 아레나"의 화면 픽셀로 잰다. 놓는 순간 줌 100% 프레임으로 환산하고 카메라를
// 그 프레임으로 당긴다(canvas-store.snapOperationToArenaRect) — 무슨 줌에서 끌었든 결과는 작업 크기다.
// 칸 나누기 규칙은 Tactical 슬롯(calculateGridSlots)과 같은 가족이다 — 모드 프레임 여백 18px,
// 칸 사이 8px, 캡션 32px는 칸 위 띠를 캡션이 채운다는 전제로 본문에서 뺀다.

import { OPERATION_WINDOW_CAPTION_HEIGHT } from "./canvas-store.js";

export interface SnapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SnapPoint {
  readonly x: number;
  readonly y: number;
}

export type SnapPresetId = "half" | "thirds" | "quad" | "wide" | "stack";

export interface SnapPreset {
  readonly id: SnapPresetId;
  /** [x, y, width, height] — 아레나 분수. */
  readonly zones: readonly (readonly [number, number, number, number])[];
}

export const SNAP_PRESETS: readonly SnapPreset[] = [
  { id: "half", zones: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1]] },
  { id: "thirds", zones: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { id: "quad", zones: [[0, 0, 1 / 2, 1 / 2], [1 / 2, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]] },
  { id: "wide", zones: [[0, 0, 2 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { id: "stack", zones: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]] },
];

// 모드 프레임 여백(Tactical 슬롯과 같은 18px)과 칸 사이 간격.
export const SNAP_FRAME_INSET = 18;
export const SNAP_GAP = 8;
// 끌던 패널이 이 띠(아레나 위쪽)에 닿으면 레이아웃 바가 내려온다. 열린 뒤에는 히스테리시스만큼 더 참는다.
export const SNAP_TOP_BAND = 44;
export const SNAP_TOP_BAND_HYSTERESIS = 12;
// 좌우 가장자리·모서리 핫존 폭 — 바 없이 반쪽/사분면으로 바로 간다.
export const SNAP_EDGE = 28;
// Fleet Map(줌 < 0.2)에서는 패널이 지도 점이라 스냅 대상이 아니다. 지도 진입 문턱과 같은 값.
export const SNAP_MIN_ZOOM = 0.2;

const EPSILON = 0.001;

/**
 * 프리셋의 모든 칸을 아레나-상대 화면 픽셀의 **본문** 사각형으로 편다. 캡션은 칸 위 띠를 채우므로
 * 본문 y는 캡션 높이만큼 내려가고 높이는 그만큼 준다. 아레나 밖으로 나가는 값은 만들지 않는다.
 */
export function snapZonesFor(arena: SnapRect, preset: SnapPreset): readonly SnapRect[] {
  const innerX = arena.x + SNAP_FRAME_INSET;
  const innerY = arena.y + SNAP_FRAME_INSET;
  const innerWidth = Math.max(0, arena.width - SNAP_FRAME_INSET * 2);
  const innerHeight = Math.max(0, arena.height - SNAP_FRAME_INSET * 2);
  return preset.zones.map(([fx, fy, fw, fh]) => {
    const leftGap = fx > EPSILON ? SNAP_GAP / 2 : 0;
    const rightGap = fx + fw < 1 - EPSILON ? SNAP_GAP / 2 : 0;
    const topGap = fy > EPSILON ? SNAP_GAP / 2 : 0;
    const bottomGap = fy + fh < 1 - EPSILON ? SNAP_GAP / 2 : 0;
    const frameX = innerX + fx * innerWidth + leftGap;
    const frameY = innerY + fy * innerHeight + topGap;
    const frameWidth = Math.max(0, fw * innerWidth - leftGap - rightGap);
    const frameHeight = Math.max(0, fh * innerHeight - topGap - bottomGap);
    return {
      x: frameX,
      y: frameY + OPERATION_WINDOW_CAPTION_HEIGHT,
      width: frameWidth,
      height: Math.max(0, frameHeight - OPERATION_WINDOW_CAPTION_HEIGHT),
    };
  });
}

/** 아레나 전체 한 칸(위쪽 가장자리 드롭·⌘⌥↑). */
export function snapFullZone(arena: SnapRect): SnapRect {
  return snapZonesFor(arena, { id: "half", zones: [[0, 0, 1, 1]] })[0]!;
}

export interface SnapZoneHit {
  readonly zone: SnapRect;
  /** 같은 프리셋의 나머지 칸 — 스냅 뒤 가이드로 남아 다음 패널을 받는다. */
  readonly siblings: readonly SnapRect[];
}

export function snapZoneHitFor(arena: SnapRect, preset: SnapPreset, zoneIndex: number): SnapZoneHit {
  const zones = snapZonesFor(arena, preset);
  return { zone: zones[zoneIndex]!, siblings: zones.filter((_, index) => index !== zoneIndex) };
}

/**
 * 가장자리·모서리 핫존 — 포인터가 보이는 아레나(`hitArena`)의 좌우 28px 안이면 반쪽, 모서리면 사분면.
 * 칸 자체는 `zoneArena`(모드 아레나)로 편다 — 핫존은 눈에 보이는 가장자리의 것이고 칸은 Tactical 슬롯과
 * 같은 상자의 것이라 둘이 다르다. 위쪽 띠는 레이아웃 바의 몫이라 여기서 다루지 않는다.
 */
export function snapEdgeHitFor(point: SnapPoint, hitArena: SnapRect, zoneArena: SnapRect = hitArena): SnapZoneHit | null {
  const left = point.x < hitArena.x + SNAP_EDGE;
  const right = point.x > hitArena.x + hitArena.width - SNAP_EDGE;
  if (!left && !right) return null;
  const top = point.y < hitArena.y + SNAP_EDGE;
  const bottom = point.y > hitArena.y + hitArena.height - SNAP_EDGE;
  if (top || bottom) {
    const index = top ? (left ? 0 : 1) : (left ? 2 : 3);
    return snapZoneHitFor(zoneArena, SNAP_PRESETS[2]!, index);
  }
  return snapZoneHitFor(zoneArena, SNAP_PRESETS[0]!, left ? 0 : 1);
}

export function snapPointInRect(point: SnapPoint, rect: SnapRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

/** 끌던 패널이 바를 내리는 띠 안에 있는가 — 열린 뒤에는 히스테리시스만큼 더 넓게 본다. */
export function snapPointInTopBand(point: SnapPoint, arena: SnapRect, barOpen: boolean): boolean {
  if (point.x < arena.x || point.x > arena.x + arena.width) return false;
  return point.y >= arena.y && point.y < arena.y + SNAP_TOP_BAND + (barOpen ? SNAP_TOP_BAND_HYSTERESIS : 0);
}
