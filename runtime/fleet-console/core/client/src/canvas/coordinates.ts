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

export function canvasToScreen(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
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

export function screenRectToCanvas(rect: CanvasRect, viewport: CanvasViewport): CanvasRect {
  const point = screenToCanvas(rect, viewport);
  return {
    ...point,
    width: rect.width / viewport.zoom,
    height: rect.height / viewport.zoom,
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
  canvasSize: { readonly width: number; readonly height: number },
  zIndex: number,
  slotIndex = 0,
  slotCount = 1,
): OperationGeometry {
  // 무대는 Tactical 슬롯과 같은 18px 인셋이다. 하단 대기 레일이 있던 자리(옛 height-84)는
  // 레일 제거 이후 비워 두지 않는다 — 사이드바 '대기'가 그 순서를 쥐고 있다.
  return modeSlotGeometryFor({
    x: 18,
    y: 18 + OPERATION_WINDOW_CAPTION_HEIGHT,
    width: Math.max(320, canvasSize.width - 36),
    height: Math.max(240, canvasSize.height - 36 - OPERATION_WINDOW_CAPTION_HEIGHT),
  }, slotIndex, slotCount, 8, zIndex);
}
