import { JobOverlay } from "../components/job-overlay.js";
import { OperationsLanding } from "../components/operations-landing.js";
import { Sidebar } from "../components/sidebar.js";
import { Terminal } from "../components/terminal.js";
import { TerminalZoom } from "../components/terminal-zoom.js";
import { isSessionExpanded, removeTerminalSession, theaterSessionOrder } from "../store.js";
import type { ConsoleState } from "../types.js";

interface OperationsClassicProps {
  readonly state: ConsoleState;
}

export function OperationsClassic({ state }: OperationsClassicProps) {
  const activeSessionId = state.activeTerminalSessionId && theaterSessionOrder(state).includes(state.activeTerminalSessionId)
    ? state.activeTerminalSessionId
    : null;
  const expanded = activeSessionId ? isSessionExpanded(state, activeSessionId) : false;
  return (
    <div className={`console-body is-classic ${expanded ? "is-expanded" : ""}`}>
      {expanded ? null : <Sidebar state={state} />}
      <main className="operations-terminal-stage">
        {activeSessionId ? (
          <>
            <Terminal key={activeSessionId} sessionId={activeSessionId} onExit={() => removeTerminalSession(activeSessionId)} />
            <TerminalZoom state={state} sessionId={activeSessionId} expanded={expanded} />
            <JobOverlay state={state} />
          </>
        ) : (
          <OperationsLanding creating={state.creatingTerminalSession} error={state.terminalSessionError} hasTheaters={state.theaters.length > 0} activeTheaterId={state.activeTheaterId} />
        )}
      </main>
    </div>
  );
}
