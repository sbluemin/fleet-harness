import { useEffect } from "react";

import { selectedJob, toggleCover } from "../store.js";
import type { ConsoleState, TenantJobsView } from "../types.js";
import { JobView } from "./job-view.js";

interface CarrierCoverProps {
  readonly state: ConsoleState;
}

export function CarrierCover({ state }: CarrierCoverProps) {
  const activeJobCount = countActiveJobs(state.tenantJobs);
  const job = selectedJob(state);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.coverOpen) toggleCover();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.coverOpen]);

  return (
    <aside className={`carrier-cover ${state.coverOpen ? "is-open" : "is-collapsed"}`} aria-label="Carrier Cover">
      <button type="button" className="cover-toggle" onClick={toggleCover} aria-expanded={state.coverOpen} aria-label="Toggle Carrier Cover">
        <span className="cover-live-dot" aria-hidden="true" />
        <span className="cover-count">{activeJobCount}</span>
        <span className="cover-chevron" aria-hidden="true">{state.coverOpen ? "›" : "‹"}</span>
      </button>
      {state.coverOpen ? (
        <div className="cover-panel">
          <JobView job={job} timelineOpen={state.timelineOpen} />
        </div>
      ) : null}
    </aside>
  );
}

function countActiveJobs(tenantJobs: Readonly<Record<string, TenantJobsView>>): number {
  let count = 0;
  for (const tenant of Object.values(tenantJobs)) {
    for (const jobId of tenant.jobOrder) {
      const status = tenant.jobs[jobId]?.status;
      if (status && status !== "done" && status !== "error" && status !== "cancelled") count += 1;
    }
  }
  return count;
}
