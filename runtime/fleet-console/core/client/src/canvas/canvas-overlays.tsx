import { useT } from "../i18n/index.js";
import { canvasRectToScreen, type CanvasRect, type CanvasViewport } from "./coordinates.js";

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

interface TriageClearPlateProps {
  readonly active: boolean;
  readonly entering: boolean;
  readonly hasContent: boolean;
  readonly idleCount: number;
}

export function TriageClearPlate({ active, entering, hasContent, idleCount }: TriageClearPlateProps) {
  const t = useT();
  if (!active || entering || hasContent) return null;
  return (
    <div className="canvas-triage-clear" data-canvas-blocker>
      <span>{t("canvas.triage.clearMark")}</span>
      <strong>{t("canvas.triage.clearTitle")}</strong>
      <p>{idleCount > 0
        ? t("canvas.triage.clearBodyIdle", { count: idleCount })
        : t("canvas.triage.clearBody")}</p>
    </div>
  );
}
