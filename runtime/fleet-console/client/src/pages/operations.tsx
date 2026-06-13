import { CarrierCover } from "../components/carrier-cover.js";
import { OperationsLanding } from "../components/operations-landing.js";
import { Sidebar } from "../components/sidebar.js";
import { Terminal } from "../components/terminal.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  return (
    <div className="console-body">
      <Sidebar state={state} />
      <main className="operations-terminal-stage">
        {state.activeTerminalSessionId ? (
          <>
            <Terminal key={state.activeTerminalSessionId} sessionId={state.activeTerminalSessionId} />
            <CarrierCover state={state} />
          </>
        ) : (
          <OperationsLanding creating={state.creatingTerminalSession} error={state.terminalSessionError} />
        )}
      </main>
    </div>
  );
}
