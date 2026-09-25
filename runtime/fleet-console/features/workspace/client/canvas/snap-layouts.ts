// Cruise 패널 스냅 — 아레나(보이는 화면)를 분수로 나눈 칸에 패널 하나를 앉히는 순수 기하.
//
// 칸은 항상 "지금 보이는 아레나"의 화면 픽셀로 잰다. 놓는 순간 줌 100% 프레임으로 환산하고 카메라를
// 그 프레임으로 당긴다(canvas-store.snapOperationToArenaRect) — 무슨 줌에서 끌었든 결과는 작업 크기다.
// 칸 나누기 규칙은 모두 정렬(alignZonesFor)과 같은 가족이다 — 모드 프레임 여백 18px,
// 칸 사이 8px, 캡션 32px는 칸 위 띠를 캡션이 채운다는 전제로 본문에서 뺀다.

import { OPERATION_WINDOW_CAPTION_HEIGHT, SNAP_FULL_PRESET_ID } from "./canvas-store.js";
import { FLEET_MAP_EXIT_ZOOM } from "./fleet-map-layout.js";

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

export type SnapZoneFraction = readonly [number, number, number, number];

export interface SnapPreset {
  readonly id: SnapPresetId;
  /** [x, y, width, height] — 아레나 분수. */
  readonly zones: readonly SnapZoneFraction[];
}

/** 칸 나누기 — 프리셋이거나, 유지 중 경계를 끌어 변한 칸들. */
export interface SnapZoneSet {
  readonly id: string;
  readonly zones: readonly SnapZoneFraction[];
}

/** 아레나 전체 한 칸(위쪽 가장자리 드롭·캡션 ⤢·Alt↑). 이 칸만 복원 메모를 갖는다(canvas-store.SnapHold.restore). */
export const SNAP_FULL_ZONES: SnapZoneSet = { id: SNAP_FULL_PRESET_ID, zones: [[0, 0, 1, 1]] };

export const SNAP_PRESETS: readonly SnapPreset[] = [
  { id: "half", zones: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1]] },
  { id: "thirds", zones: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { id: "quad", zones: [[0, 0, 1 / 2, 1 / 2], [1 / 2, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]] },
  { id: "wide", zones: [[0, 0, 2 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
  { id: "stack", zones: [[0, 0, 1 / 2, 1], [1 / 2, 0, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1 / 2, 1 / 2]] },
];

// 모드 프레임 여백(정렬 칸과 같은 18px)과 칸 사이 간격.
export const SNAP_FRAME_INSET = 18;
export const SNAP_GAP = 8;
// 끌던 패널이 이 띠(아레나 위쪽)에 닿으면 레이아웃 바가 내려온다. 열린 뒤에는 히스테리시스만큼 더 참는다.
export const SNAP_TOP_BAND = 44;
export const SNAP_TOP_BAND_HYSTERESIS = 12;
// 바는 아레나 윗변에서 이만큼 내려와 선다. 그 위 — 손잡이 띠와 Command Band — 까지 밀어 올리면 전체 화면이다.
export const SNAP_TOP_FULL_EDGE = 8;
// 좌우 가장자리·모서리 핫존 폭 — 바 없이 반쪽/사분면으로 바로 간다.
export const SNAP_EDGE = 28;
// Fleet Map에서는 패널이 지도 점이라 스냅 대상이 아니다. 지도는 0.2에서 들어와 0.24를 넘어야 걷히므로
// (히스테리시스) 이탈 문턱을 하한으로 삼는다 — 그 사이 구간에서 키보드 스냅이 지도 아래 패널을 옮기지 않게.
export const SNAP_MIN_ZOOM = FLEET_MAP_EXIT_ZOOM;

const EPSILON = 0.001;

/**
 * 프리셋의 모든 칸을 아레나-상대 화면 픽셀의 **본문** 사각형으로 편다. 캡션은 칸 위 띠를 채우므로
 * 본문 y는 캡션 높이만큼 내려가고 높이는 그만큼 준다. 아레나 밖으로 나가는 값은 만들지 않는다.
 */
export function snapZonesFor(arena: SnapRect, preset: SnapZoneSet): readonly SnapRect[] {
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

/** 아레나 전체 한 칸의 본문 사각형. */
export function snapFullZone(arena: SnapRect): SnapRect {
  return snapZonesFor(arena, SNAP_FULL_ZONES)[0]!;
}

/**
 * 정렬 칸 본문 균등화 — 같은 줄의 칸이 같은 폭을, 같은 열의 칸이 같은 높이를 갖게 한다.
 * snapZonesFor는 칸마다 안쪽 변에만 반간격을 빼서 가장자리 칸이 4px씩 넓어지는데,
 * 정렬은 빈칸 없이 꽉 채우므로 그 4px가 눈에 띈다. 줄·열 범위를 재서
 * 간격을 균등 분배한다. 수동 스냅에는 손대지 않는다(기존 나누기를 바꾸지 않기 위해서).
 *
 * 세로 보폭은 간격에 캡션 높이를 더한다 — 본문 rect 기준이라 아래 칸 캡션 띠(32px)가
 * 본문 피치에 들어가지 않으면 아래 행 캡션이 위 행 본문에 묻힌다.
 */
export function evenAlignBodies(bodies: readonly SnapRect[]): SnapRect[] {
  const next = bodies.map((body) => ({ ...body }));
  const cluster = (keyOf: (body: SnapRect) => string): number[][] => {
    const groups = new Map<string, number[]>();
    next.forEach((body, index) => {
      const key = keyOf(body);
      const list = groups.get(key) ?? [];
      list.push(index);
      groups.set(key, list);
    });
    return [...groups.values()].filter((indices) => indices.length > 1);
  };
  // 같은 줄: 시작점부터 끝점까지 재서 폭을 균등 분배한다.
  for (const indices of cluster((body) => `${Math.round(body.y)}:${Math.round(body.height)}`)) {
    const ordered = [...indices].sort((a, b) => (next[a]?.x ?? 0) - (next[b]?.x ?? 0));
    const first = next[ordered[0] ?? -1];
    const last = next[ordered[ordered.length - 1] ?? -1];
    if (!first || !last) continue;
    const start = first.x;
    const end = last.x + last.width;
    const count = ordered.length;
    const width = Math.max(0, (end - start - SNAP_GAP * (count - 1)) / count);
    ordered.forEach((index, position) => {
      const body = next[index];
      if (!body) return;
      next[index] = { ...body, x: start + position * (width + SNAP_GAP), width };
    });
  }
  // 같은 열: 위부터 아래까지 재서 높이를 균등 분배한다. 본문 사이에는 간격 8px에
  // 아래 칸 캡션 띠 32px가 들어가므로 보폭은 둘의 합이다.
  const ALIGN_ROW_STRIDE = SNAP_GAP + OPERATION_WINDOW_CAPTION_HEIGHT;
  for (const indices of cluster((body) => `${Math.round(body.x)}:${Math.round(body.width)}`)) {
    const ordered = [...indices].sort((a, b) => (next[a]?.y ?? 0) - (next[b]?.y ?? 0));
    const first = next[ordered[0] ?? -1];
    const last = next[ordered[ordered.length - 1] ?? -1];
    if (!first || !last) continue;
    const start = first.y;
    const end = last.y + last.height;
    const count = ordered.length;
    const height = Math.max(0, (end - start - ALIGN_ROW_STRIDE * (count - 1)) / count);
    ordered.forEach((index, position) => {
      const body = next[index];
      if (!body) return;
      next[index] = { ...body, y: start + position * (height + ALIGN_ROW_STRIDE), height };
    });
  }
  return next;
}

export interface SnapZoneHit {
  readonly zone: SnapRect;
  /** 어느 나누기의 몇 번째 칸인가 — 스냅 유지가 이 셋으로 묶음을 만든다. */
  readonly set: SnapZoneSet;
  readonly zoneIndex: number;
}

export function snapZoneHitFor(arena: SnapRect, set: SnapZoneSet, zoneIndex: number): SnapZoneHit {
  const zones = snapZonesFor(arena, set);
  return { zone: zones[zoneIndex]!, set, zoneIndex };
}

/** 유지 중인 나누기의 빈 칸 위인가 — 바·핫존 없이 그 칸에 바로 놓는다. */
export function snapEmptyZoneHitFor(point: SnapPoint, arena: SnapRect, set: SnapZoneSet, taken: ReadonlySet<number>): SnapZoneHit | null {
  const zones = snapZonesFor(arena, set);
  for (let index = 0; index < zones.length; index += 1) {
    if (taken.has(index)) continue;
    const frame = { x: zones[index]!.x, y: zones[index]!.y - OPERATION_WINDOW_CAPTION_HEIGHT, width: zones[index]!.width, height: zones[index]!.height + OPERATION_WINDOW_CAPTION_HEIGHT };
    if (snapPointInRect(point, frame)) return { zone: zones[index]!, set, zoneIndex: index };
  }
  return null;
}

/**
 * 유지 패널의 크기 조절을 칸 분수로 되돌린다 — 움직인 변을 같은 선을 나누던 이웃 칸도 따라 옮긴다
 * (Windows 스냅 묶음의 공유 경계). 이웃이 최소 폭·높이 아래로 줄어드는 만큼은 받지 않는다.
 * `frame`은 캡션을 포함한 아레나-상대 화면 프레임.
 */
export function snapZonesResized(arena: SnapRect, zones: readonly SnapZoneFraction[], index: number, frame: SnapRect, minWidth: number, minHeight: number): readonly SnapZoneFraction[] {
  const innerX = arena.x + SNAP_FRAME_INSET;
  const innerY = arena.y + SNAP_FRAME_INSET;
  const innerWidth = Math.max(1, arena.width - SNAP_FRAME_INSET * 2);
  const innerHeight = Math.max(1, arena.height - SNAP_FRAME_INSET * 2);
  const old = zones[index];
  if (!old) return zones;
  const [ofx, ofy, ofw, ofh] = old;
  const leftGap = ofx > EPSILON ? SNAP_GAP / 2 : 0;
  const rightGap = ofx + ofw < 1 - EPSILON ? SNAP_GAP / 2 : 0;
  const topGap = ofy > EPSILON ? SNAP_GAP / 2 : 0;
  const bottomGap = ofy + ofh < 1 - EPSILON ? SNAP_GAP / 2 : 0;
  // 새 변의 분수 — 바깥 변(0·1)은 아레나에 붙어 있으니 움직이지 않는다.
  const edges = {
    left: ofx > EPSILON ? clamp01((frame.x - leftGap - innerX) / innerWidth) : 0,
    right: ofx + ofw < 1 - EPSILON ? clamp01((frame.x + frame.width + rightGap - innerX) / innerWidth) : 1,
    top: ofy > EPSILON ? clamp01((frame.y - topGap - innerY) / innerHeight) : 0,
    bottom: ofy + ofh < 1 - EPSILON ? clamp01((frame.y + frame.height + bottomGap - innerY) / innerHeight) : 1,
  };
  const minW = (minWidth + SNAP_GAP) / innerWidth;
  const minH = (minHeight + SNAP_GAP + OPERATION_WINDOW_CAPTION_HEIGHT) / innerHeight;
  const next = zones.map((zone) => [...zone] as [number, number, number, number]);
  const moveEdge = (axis: "x" | "y", from: number, to: number) => {
    if (Math.abs(from - to) < EPSILON) return;
    const min = axis === "x" ? minW : minH;
    const si = axis === "x" ? 0 : 1, wi = axis === "x" ? 2 : 3;
    const ci = axis === "x" ? 1 : 0, cwi = axis === "x" ? 3 : 2;
    const onLine = (zone: readonly number[]) => Math.abs(zone[si]! + zone[wi]! - from) < EPSILON || Math.abs(zone[si]! - from) < EPSILON;
    // 이 선을 나누는 칸 가운데 움직이는 구간과 이어진 것들 — 끌던 칸의 구간에서 시작해, 그 구간과 겹치는 칸의
    // 구간을 더해 가며 닫힐 때까지 넓힌다. 한쪽 칸이 선 전체를 차지하면(stack의 왼쪽 반) 반대편 두 칸이 모두
    // 따라와야 하고, 사분면처럼 위·아래 줄이 끊겨 있으면 줄 하나만 움직인다.
    const moving = new Set<number>();
    const spans: [number, number][] = [[axis === "x" ? ofy : ofx, axis === "x" ? ofh : ofw]];
    let grew = true;
    while (grew) {
      grew = false;
      next.forEach((zone, index) => {
        if (moving.has(index) || !onLine(zone)) return;
        if (!spans.some(([start, size]) => overlaps(zone[ci], zone[cwi], start, size))) return;
        moving.add(index);
        spans.push([zone[ci], zone[cwi]]);
        grew = true;
      });
    }
    // 이웃이 최소 크기 아래로 가지 않는 범위로 한 번에 자른다.
    let bounded = to;
    for (const index of moving) {
      const zone = next[index]!;
      if (Math.abs(zone[si] + zone[wi] - from) < EPSILON) bounded = Math.max(bounded, zone[si] + min);
      if (Math.abs(zone[si] - from) < EPSILON) bounded = Math.min(bounded, zone[si] + zone[wi] - min);
    }
    for (const index of moving) {
      const zone = next[index]!;
      if (Math.abs(zone[si] + zone[wi] - from) < EPSILON) zone[wi] = bounded - zone[si];
      else if (Math.abs(zone[si] - from) < EPSILON) { zone[wi] = zone[si] + zone[wi] - bounded; zone[si] = bounded; }
    }
  };
  moveEdge("x", ofx, edges.left);
  moveEdge("x", ofx + ofw, edges.right);
  moveEdge("y", ofy, edges.top);
  moveEdge("y", ofy + ofh, edges.bottom);
  return next;
}

function overlaps(start: number, size: number, otherStart: number, otherSize: number): boolean {
  return start < otherStart + otherSize - EPSILON && otherStart < start + size - EPSILON;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 가장자리·모서리 핫존 — 포인터가 보이는 아레나(`hitArena`)의 좌우 28px 안이면 반쪽, 모서리면 사분면.
 * 칸 자체는 `zoneArena`(모드 아레나)로 편다 — 핫존은 눈에 보이는 가장자리의 것이고 칸은 정렬 칸과
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

/** 칸의 자리 이름 — 표식이 "어느 칸에 붙어 있다"를 말할 때 쓰는 분류. */
export type SnapZoneName =
  | "full" | "left" | "center" | "right" | "top" | "bottom"
  | "topLeft" | "topCenter" | "topRight" | "bottomLeft" | "bottomCenter" | "bottomRight";

/**
 * 분수 칸 하나를 사람이 부르는 이름으로 접는다. 한 축을 끝에서 끝까지 덮으면 그 축은 말하지 않는다 —
 * ⅓ 열은 "가운데 칸"이지 "가운데 위 칸"이 아니다. 경계를 끌어 프리셋에서 벗어난 칸도 중심으로 재므로
 * 이름이 없는 칸은 없다.
 */
export function snapZoneName(zone: SnapZoneFraction): SnapZoneName {
  const [fx, fy, fw, fh] = zone;
  const spansWidth = fx <= EPSILON && fx + fw >= 1 - EPSILON;
  const spansHeight = fy <= EPSILON && fy + fh >= 1 - EPSILON;
  if (spansWidth && spansHeight) return "full";
  const centerX = fx + fw / 2;
  const column = centerX < 0.4 ? "left" : centerX > 0.6 ? "right" : "center";
  if (spansHeight) return column;
  const top = fy + fh / 2 < 0.5;
  if (spansWidth) return top ? "top" : "bottom";
  if (column === "left") return top ? "topLeft" : "bottomLeft";
  if (column === "right") return top ? "topRight" : "bottomRight";
  return top ? "topCenter" : "bottomCenter";
}

// 손잡이 좌우로 이만큼은 더 받아 준다 — 손잡이 끝을 스치듯 올려도 바가 열린다.
export const SNAP_HANDLE_REACH = 24;

/**
 * 끌던 패널이 바를 내리는 띠 안에 있는가 — 가로로는 손잡이 폭(+여유) 안이어야 한다. 위쪽 어디로 가든
 * 바가 열리면 위로 옮기려는 평범한 드래그마다 바가 튀어나온다. 열린 뒤에는 히스테리시스만큼 더 넓게 본다.
 */
export function snapPointInTopBand(point: SnapPoint, arena: SnapRect, barOpen: boolean, handleCenterX: number, handleWidth: number): boolean {
  if (!snapPointWithinHandle(point, barOpen, handleCenterX, handleWidth)) return false;
  // 아래로만 막는다 — 아레나 위(Command Band)로 넘어가도 포인터는 캡션이 잡고 있고, 그곳은 전체 화면 핫존이다.
  return point.y < arena.y + SNAP_TOP_BAND + (barOpen ? SNAP_TOP_BAND_HYSTERESIS : 0);
}

/**
 * 끌던 패널이 바 위쪽 가장자리까지 올라갔는가 — Windows에서 창을 화면 꼭대기에 대면 최대화되듯,
 * 바를 지나 손잡이 띠(아레나 윗변 8px)나 그 위 Command Band까지 밀면 아레나 전체 한 칸이다.
 */
export function snapPointAtTopEdge(point: SnapPoint, arena: SnapRect, handleCenterX: number, handleWidth: number): boolean {
  return snapPointWithinHandle(point, true, handleCenterX, handleWidth) && point.y < arena.y + SNAP_TOP_FULL_EDGE;
}

function snapPointWithinHandle(point: SnapPoint, barOpen: boolean, handleCenterX: number, handleWidth: number): boolean {
  const reach = handleWidth / 2 + SNAP_HANDLE_REACH + (barOpen ? SNAP_TOP_BAND_HYSTERESIS : 0);
  return Math.abs(point.x - handleCenterX) <= reach;
}
