import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import type { PanelGeometry } from "./canvas-store.js";

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

interface PanelResizeHandlesProps {
  readonly geometry: PanelGeometry;
  readonly zoom: number;
  readonly onResize: (geometry: PanelGeometry) => void;
}

interface ResizeState {
  readonly direction: ResizeDirection;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly geometry: PanelGeometry;
}

const RESIZE_DIRECTIONS: readonly ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 200;

export function PanelResizeHandles({ geometry, zoom, onResize }: PanelResizeHandlesProps) {
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
          className={`canvas-panel-resize canvas-panel-resize--${direction}`}
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

function resizeGeometry(geometry: PanelGeometry, direction: ResizeDirection, dx: number, dy: number): PanelGeometry {
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
  if (width < MIN_PANEL_WIDTH) {
    if (direction.includes("w")) x -= MIN_PANEL_WIDTH - width;
    width = MIN_PANEL_WIDTH;
  }
  if (height < MIN_PANEL_HEIGHT) {
    if (direction.includes("n")) y -= MIN_PANEL_HEIGHT - height;
    height = MIN_PANEL_HEIGHT;
  }
  return { ...geometry, x, y, width, height };
}
