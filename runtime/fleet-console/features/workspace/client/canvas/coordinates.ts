import { OPERATION_WINDOW_CAPTION_HEIGHT, type OperationGeometry } from "./canvas-store.js";

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasRect extends CanvasPoint {
  readonly width: number;
  readonly height: number;
}

export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

function canvasToScreen(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

export function screenToCanvas(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

export function canvasRectToScreen(rect: CanvasRect, viewport: CanvasViewport): CanvasRect {
  const point = canvasToScreen(rect, viewport);
  return {
    ...point,
    width: rect.width * viewport.zoom,
    height: rect.height * viewport.zoom,
  };
}

export interface ModeGeometryRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function modeSlotGeometryFor(
  rect: ModeGeometryRect,
  slotIndex: number,
  slotCount: number,
  gap: number,
  zIndex: number,
): OperationGeometry {
  const count = Math.max(1, slotCount);
  const width = Math.max(0, (rect.width - gap * (count - 1)) / count);
  return {
    x: rect.x + slotIndex * (width + gap),
    y: rect.y,
    width,
    height: Math.max(0, rect.height),
    zIndex,
  };
}

export function triageStageGeometryFor(
  arena: ModeGeometryRect,
  zIndex: number,
  slotIndex = 0,
  slotCount = 1,
): OperationGeometry {
  // War Room은 Zen 아레나(작업 표시줄 높이를 뺀 유효 뷰포트)를 쓴다. 틀의 위·좌·우는
  // 아레나에서 10px 안쪽, 바닥은 수평선(아레나 끝)이므로 무대는 위·좌·우 18px, 아래 8px로
  // 네 변 모두 틀과 8px을 띄운다. 단일 칸·동반 칸과 FLIP 목적 좌표가 같은 기하를 쓴다.
  return modeSlotGeometryFor({
    x: arena.x + 18,
    y: arena.y + 18 + OPERATION_WINDOW_CAPTION_HEIGHT,
    width: Math.max(320, arena.width - 36),
    height: Math.max(240, arena.height - 18 - 8 - OPERATION_WINDOW_CAPTION_HEIGHT),
  }, slotIndex, slotCount, 8, zIndex);
}
