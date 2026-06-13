import { AuthGate } from "../components/auth-gate.js";
import { JobView } from "../components/job-view.js";
import { Sidebar } from "../components/sidebar.js";
import { selectedJob } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  return (
    <div className={`console-body ${state.token ? "" : "console-body--gate"}`}>
      {state.token ? (
        <>
          <Sidebar state={state} />
          <JobView job={selectedJob(state)} timelineOpen={state.timelineOpen} />
        </>
      ) : (
        <AuthGate />
      )}
    </div>
  );
}
