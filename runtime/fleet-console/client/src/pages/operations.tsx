import { AuthGate } from "../components/auth-gate.js";
import { CarrierCover } from "../components/carrier-cover.js";
import { Sidebar } from "../components/sidebar.js";
import { Terminal } from "../components/terminal.js";
import type { ConsoleState } from "../types.js";

interface OperationsProps {
  readonly state: ConsoleState;
}

export function Operations({ state }: OperationsProps) {
  const hasTokens = Boolean(state.token && state.terminalToken);
  return (
    <div className={`console-body ${hasTokens ? "" : "console-body--gate"}`}>
      {hasTokens && state.terminalToken ? (
        <>
          <Sidebar state={state} />
          <main className="operations-terminal-stage">
            <Terminal terminalToken={state.terminalToken} />
            <CarrierCover state={state} />
          </main>
        </>
      ) : (
        <AuthGate />
      )}
    </div>
  );
}
