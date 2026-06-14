import { JobOverlay } from "../components/job-overlay.js";
import { OperationsLanding } from "../components/operations-landing.js";
import { Sidebar } from "../components/sidebar.js";
import { Terminal } from "../components/terminal.js";
import { removeTerminalSession, theaterSessionOrder } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const activeSessionId = state.activeTerminalSessionId && theaterSessionOrder(state).includes(state.activeTerminalSessionId)
    ? state.activeTerminalSessionId
    : null;
  return (
    <div className="console-body">
      <Sidebar state={state} />
      <main className="operations-terminal-stage">
        {activeSessionId ? (
          <>
            <Terminal key={activeSessionId} sessionId={activeSessionId} onExit={() => removeTerminalSession(activeSessionId)} />
            <JobOverlay state={state} />
          </>
        ) : (
          <OperationsLanding creating={state.creatingTerminalSession} error={state.terminalSessionError} hasTheaters={state.theaters.length > 0} activeTheaterId={state.activeTheaterId} />
        )}
      </main>
    </div>
  );
}
