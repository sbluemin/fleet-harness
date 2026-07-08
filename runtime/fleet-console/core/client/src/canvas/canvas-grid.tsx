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
      {/* OFF에서도 unmount하지 않는다 — sweep은 122vmax 승격 레이어라 DOM 파괴 시
          stale damage가 인접 blur 표면(사이드바)에 유령 심을 남긴다(GPU 환경 회귀).
          마운트를 유지한 채 정지+은닉하면 레이어가 조용히 강등되어 심이 생기지 않는다. */}
      <div
        className={`operations-radar${radarAnimationPaused || !backgroundAnimationEnabled ? ` ${RADAR_PAUSED_CLASS}` : ""}${backgroundAnimationEnabled ? "" : " is-disabled"}`}
      >
        <span className="operations-radar-ring operations-radar-ring--outer" />
        <span className="operations-radar-ring operations-radar-ring--middle" />
        <span className="operations-radar-ring operations-radar-ring--inner" />
        <span className="operations-radar-sweep" />
      </div>
    </div>
  );
}
