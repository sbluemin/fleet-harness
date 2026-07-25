import type { OperationGeometry } from "./canvas-store.js";

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
  return modeSlotGeometryFor({
    x: 18,
    y: 18,
    width: Math.max(320, canvasSize.width - 36),
    height: Math.max(240, canvasSize.height - 84),
  }, slotIndex, slotCount, 8, zIndex);
}
