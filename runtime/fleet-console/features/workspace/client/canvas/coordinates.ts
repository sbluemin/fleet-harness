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

/** 본문 geometry에 창 캡션(top:-32px)을 더한 시각 프레임.
 *  Tactical 빈칸 가이드가 점유 패널과 같은 상자를 그리게 한다. */
export function operationWindowFrameFor(body: CanvasRect): CanvasRect {
  return {
    x: body.x,
    y: body.y - OPERATION_WINDOW_CAPTION_HEIGHT,
    width: body.width,
    height: body.height + OPERATION_WINDOW_CAPTION_HEIGHT,
  };
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
  // 무대는 Tactical 슬롯과 같은 18px 인셋이다. 기준 상자는 캔버스 박스가 아니라 아레나
  // (부유 크롬 인셋을 뺀 유효 뷰포트)다 — 전면 캔버스에서 박스 기준 18px는 무대를 부유
  // 사이드바·레일 밑으로 넣는다. 18px은 크롬 폭의 대체가 아니라 모드 프레임 여백이다.
  return modeSlotGeometryFor({
    x: arena.x + 18,
    y: arena.y + 18 + OPERATION_WINDOW_CAPTION_HEIGHT,
    width: Math.max(320, arena.width - 36),
    height: Math.max(240, arena.height - 36 - OPERATION_WINDOW_CAPTION_HEIGHT),
  }, slotIndex, slotCount, 8, zIndex);
}
