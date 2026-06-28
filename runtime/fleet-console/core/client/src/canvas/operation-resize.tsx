import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { OperationGeometry } from "./canvas-store.js";

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

interface OperationResizeHandlesProps {
  readonly geometry: OperationGeometry;
  readonly zoom: number;
  readonly onResize: (geometry: OperationGeometry) => void;
}

interface ResizeState {
  readonly direction: ResizeDirection;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: OperationGeometry;
}

const RESIZE_DIRECTIONS: readonly ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const MIN_OPERATION_WIDTH = 320;
const MIN_OPERATION_HEIGHT = 200;

export function OperationResizeHandles({ geometry, zoom, onResize }: OperationResizeHandlesProps) {
  const resizeRef = useRef<ResizeState | null>(null);

  const beginResize = (direction: ResizeDirection, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      geometry,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - resize.startX) / zoom;
    const dy = (event.clientY - resize.startY) / zoom;
    onResize(resizeGeometry(resize.geometry, resize.direction, dx, dy));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`canvas-operation-resize canvas-operation-resize--${direction}`}
          onPointerDown={(event) => beginResize(direction, event)}
          onPointerMove={updateResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          data-canvas-blocker
          aria-hidden="true"
        />
      ))}
    </>
  );
}

function resizeGeometry(geometry: OperationGeometry, direction: ResizeDirection, dx: number, dy: number): OperationGeometry {
  let { x, y, width, height } = geometry;
  if (direction.includes("e")) width += dx;
  if (direction.includes("s")) height += dy;
  if (direction.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (direction.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (width < MIN_OPERATION_WIDTH) {
    if (direction.includes("w")) x -= MIN_OPERATION_WIDTH - width;
    width = MIN_OPERATION_WIDTH;
  }
  if (height < MIN_OPERATION_HEIGHT) {
    if (direction.includes("n")) y -= MIN_OPERATION_HEIGHT - height;
    height = MIN_OPERATION_HEIGHT;
  }
  return { ...geometry, x, y, width, height };
}
