import type { CanvasViewport } from "./coordinates.js";

interface CanvasGridProps {
  readonly viewport: CanvasViewport;
}

export function CanvasGrid({ viewport }: CanvasGridProps) {
  return (
    <div className="operations-canvas-background" aria-hidden="true">
      <div className="operations-canvas-sea" />
      <div
        className="operations-canvas-grid"
        style={{
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          backgroundSize: `${48 * viewport.zoom}px ${48 * viewport.zoom}px, ${12 * viewport.zoom}px ${12 * viewport.zoom}px`,
        }}
      />
    </div>
  );
}
