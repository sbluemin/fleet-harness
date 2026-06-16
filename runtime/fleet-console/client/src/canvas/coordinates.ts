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
