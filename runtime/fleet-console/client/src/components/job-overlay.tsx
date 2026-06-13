import { useEffect } from "react";

import { clearSelectedJob, selectedJob } from "../store.js";
import type { ConsoleState } from "../types.js";
import { JobView } from "./job-view.js";

interface JobOverlayProps {
  readonly state: ConsoleState;
}

export function JobOverlay({ state }: JobOverlayProps) {
  const job = selectedJob(state);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelectedJob();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!job) return null;

  return (
    <div className="job-overlay" role="dialog" aria-modal="true" aria-label="Carrier job stream">
      <button type="button" className="job-overlay-scrim" onClick={clearSelectedJob} aria-label="Close job stream" />
      <div className="job-overlay-card">
        <button type="button" className="job-overlay-close" onClick={clearSelectedJob} aria-label="Close job stream">
          ×
        </button>
        <JobView job={job} timelineOpen={state.timelineOpen} />
      </div>
    </div>
  );
}
