import { canvasRectToScreen, type CanvasRect, type CanvasViewport } from "./coordinates.js";

interface RubberBandProps {
  readonly rect: CanvasRect;
  readonly viewport: CanvasViewport;
}

export function RubberBand({ rect, viewport }: RubberBandProps) {
  const screenRect = canvasRectToScreen(rect, viewport);
  return (
    <div
      className="canvas-rubber-band"
      style={{
        left: screenRect.x,
        top: screenRect.y,
        width: screenRect.width,
        height: screenRect.height,
      }}
      aria-hidden="true"
    />
  );
}
