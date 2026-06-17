import { useEffect, useState } from "react";

import type { CanvasViewport } from "./coordinates.js";

interface CanvasGridProps {
  readonly viewport: CanvasViewport;
  readonly backgroundAnimationEnabled: boolean;
}

const RADAR_PAUSED_CLASS = "is-animation-paused";

export function CanvasGrid({ viewport, backgroundAnimationEnabled }: CanvasGridProps) {
  const [radarAnimationPaused, setRadarAnimationPaused] = useState(() => document.hidden);

  useEffect(() => {
    function handleVisibilityChange() {
      setRadarAnimationPaused(document.hidden);
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

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
      {backgroundAnimationEnabled ? (
        <div className={`operations-radar${radarAnimationPaused ? ` ${RADAR_PAUSED_CLASS}` : ""}`}>
          <span className="operations-radar-ring operations-radar-ring--outer" />
          <span className="operations-radar-ring operations-radar-ring--middle" />
          <span className="operations-radar-ring operations-radar-ring--inner" />
          <span className="operations-radar-sweep" />
        </div>
      ) : null}
    </div>
  );
}
