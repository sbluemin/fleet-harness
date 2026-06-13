import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { Topbar } from "./components/topbar.js";
import { startObserverConnection } from "./connection.js";
import { useConsoleState } from "./hooks/use-store.js";
import { Operations } from "./pages/operations.js";
import { Welcome } from "./pages/welcome.js";

export function App() {
  const state = useConsoleState();

  useEffect(() => {
    if (!state.token) return;
    return startObserverConnection(state.token);
  }, [state.token]);

  return (
    <div className="console-shell">
      <Topbar connection={state.connection} connectionError={state.connectionError} tenantCount={state.tenants.length} />
      <Routes>
        <Route path="/" element={<Welcome state={state} />} />
        <Route path="/operations" element={<Operations state={state} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
