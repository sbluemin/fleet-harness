import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { fetchTerminalSessions } from "./api.js";
import { ShellOverlay } from "./components/shell-overlay.js";
import { Toast } from "./components/toast.js";
import { Topbar } from "./components/topbar.js";
import { startObserverConnection } from "./connection.js";
import { useConsoleState } from "./hooks/use-store.js";
import { Codex } from "./pages/codex.js";
import { Operations } from "./pages/operations.js";
import { hydrateTerminalSessions, setState, toggleShell } from "./store.js";
import { Welcome } from "./pages/welcome.js";

export function App() {
  const state = useConsoleState();

  useEffect(() => {
    return startObserverConnection();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void fetchTerminalSessions(abort.signal)
      .then(hydrateTerminalSessions)
      .catch((error) => {
        if (abort.signal.aborted) return;
        setState({ terminalSessionError: error instanceof Error ? error.message : String(error) });
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        toggleShell();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="console-shell">
      <Topbar connectionError={state.connectionError} />
      <Routes>
        <Route path="/" element={<Welcome state={state} />} />
        <Route path="/operations" element={<Operations state={state} />} />
        <Route path="/codex/*" element={<Codex />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ShellOverlay state={state} />
      <Toast
        open={state.connectionError !== null}
        tone="error"
        title="Console link interrupted"
        message={state.connectionError ?? undefined}
      />
    </div>
  );
}
