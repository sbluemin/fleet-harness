import { useEffect, useState } from "react";

import type { CanvasViewport } from "./coordinates.js";

interface CanvasGridProps {
  readonly viewport: CanvasViewport;
  readonly backgroundAnimationEnabled: boolean;
}

const RADAR_PAUSED_CLASS = "is-animation-paused";

export function CanvasGrid({ viewport, backgroundAnimationEnabled }: CanvasGridProps) {
  const [radarAnimationPaused, setRadarAnimationPaused] = useState(() => document.hidden);
  const radarDisabled = !backgroundAnimationEnabled;
  const radarPaused = radarAnimationPaused || radarDisabled;

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
      {/* OFF에서도 unmount하지 않는다. 122vmax sweep 레이어 teardown이 인접 blur 표면에 잔상을 남길 수 있다. */}
      <div className={`operations-radar${radarPaused ? ` ${RADAR_PAUSED_CLASS}` : ""}${radarDisabled ? " is-disabled" : ""}`}>
        <span className="operations-radar-ring operations-radar-ring--outer" />
        <span className="operations-radar-ring operations-radar-ring--middle" />
        <span className="operations-radar-ring operations-radar-ring--inner" />
        <span className="operations-radar-sweep" />
      </div>
    </div>
  );
}
