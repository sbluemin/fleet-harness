import { useEffect } from "react";

import { activeSessionActiveJobs, backToCoverList, selectedCoverJob, toggleCover } from "../store.js";
import type { ConsoleState } from "../types.js";
import { CoverJobList } from "./cover-job-list.js";
import { JobView } from "./job-view.js";

interface CarrierCoverProps {
  readonly state: ConsoleState;
}

export function CarrierCover({ state }: CarrierCoverProps) {
  const activeJobCount = activeSessionActiveJobs(state).length;
  const job = selectedCoverJob(state);

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
          {state.coverDepth === "detail" ? (
            <>
              <button type="button" className="cover-back-button" onClick={backToCoverList}>
                Back
              </button>
              <JobView job={job} timelineOpen={state.timelineOpen} />
            </>
          ) : (
            <CoverJobList state={state} />
          )}
        </div>
      ) : null}
    </aside>
  );
}
