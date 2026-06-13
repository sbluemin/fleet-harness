import { useEffect } from "react";

import { AuthGate } from "./components/auth-gate.js";
import { JobView } from "./components/job-view.js";
import { Sidebar } from "./components/sidebar.js";
import { Topbar } from "./components/topbar.js";
import { startObserverConnection } from "./connection.js";
import { useConsoleState } from "./hooks/use-store.js";
import { selectedJob } from "./store.js";

export function App() {
  const state = useConsoleState();

  useEffect(() => {
    if (!state.token) return;
    return startObserverConnection(state.token);
  }, [state.token]);

  return (
    <div className="console-shell">
      <Topbar connection={state.connection} connectionError={state.connectionError} tenantCount={state.tenants.length} />
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
    </div>
  );
}
