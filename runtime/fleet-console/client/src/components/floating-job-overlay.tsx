import { JobOverlay } from "./job-overlay.js";
import type { ConsoleState } from "../types.js";

interface FloatingJobOverlayProps {
  readonly state: ConsoleState;
}

export function FloatingJobOverlay({ state }: FloatingJobOverlayProps) {
  return (
    <div className="floating-job-overlay" data-canvas-blocker>
      <JobOverlay state={state} />
    </div>
  );
}
