import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { useMaximized } from "./canvas/canvas-store.js";
import { useOperationsMode } from "./operations-mode.js";
import { fetchObserverStatus, fetchTerminalSessions, fetchTheaterBootstrap } from "./api.js";
import { CommissioningOverlay } from "./components/commissioning-overlay.js";
import { ShortcutsOverlay } from "./components/shortcuts-overlay.js";
import { ShellOverlay } from "./components/shell-overlay.js";
import { OperationSearch } from "./components/operation-search.js";
import { OperationToastHost } from "./components/operation-toasts.js";
import { Toast } from "./components/toast.js";
import { Topbar } from "./components/topbar.js";
import { startObserverConnection } from "./connection.js";
import { useConsoleState } from "./hooks/use-store.js";
import { CarrierSettings } from "./pages/carrier-settings.js";
import { Codex } from "./pages/codex.js";
import { GlobalSettings } from "./pages/global-settings.js";
import { Operations } from "./pages/operations.js";
import { applyObserverStatus, hydrateTerminalSessions, hydrateTheaterBootstrap, resolveOnboardingOnBootstrap, setState, toggleOperationSearch, toggleShell } from "./store.js";
import { Welcome } from "./pages/welcome.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 registry 응답보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;

export function App() {
  const state = useConsoleState();
  const pathname = useLocation().pathname;
  const maximized = useMaximized();
  const operationsMode = useOperationsMode();
  // 최대화는 localStorage에 영속되지만, GNB 숨김은 Map(canvas) Operations 화면에서만 적용한다 —
  // 다른 라우트(Welcome/Codex/Helm)로 가거나 그 상태로 로드되어도 내비게이션이 사라지지 않게 한다.
  const maximizedActive = maximized && pathname.startsWith("/operations") && operationsMode === "canvas";

  useEffect(() => {
    return startObserverConnection();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void fetchTheaterBootstrap(abort.signal)
      .then((bootstrap) => {
        hydrateTheaterBootstrap(bootstrap);
        resolveOnboardingOnBootstrap();
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        setState({ theaterError: error instanceof Error ? error.message : String(error) });
        resolveOnboardingOnBootstrap();
      });
    void fetchTerminalSessions(abort.signal)
      .then(hydrateTerminalSessions)
      .catch((error) => {
        if (abort.signal.aborted) return;
        setState({ terminalSessionError: error instanceof Error ? error.message : String(error) });
      });
    const refreshUpdateStatus = () => {
      void fetchObserverStatus(state.activeTheaterId, abort.signal)
        .then(applyObserverStatus)
        .catch(() => {});
    };
    refreshUpdateStatus();
    // cold-start 보정: 서버 백그라운드 refresh 완료를 기다렸다가 한 번 더 읽어 배지를 채운다.
    const recheckTimer = window.setTimeout(refreshUpdateStatus, UPDATE_STATUS_RECHECK_DELAY_MS);
    return () => {
      window.clearTimeout(recheckTimer);
      abort.abort();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (window.location.pathname.includes("/codex")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleOperationSearch();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
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
    <div className={`console-shell ${maximizedActive ? "is-maximized" : ""}`}>
      <Topbar state={state} />
      <Routes>
        <Route path="/" element={<Welcome state={state} />} />
        <Route path="/operations" element={<Operations state={state} />} />
        <Route path="/carrier-settings" element={<CarrierSettings />} />
        <Route path="/settings" element={<GlobalSettings />} />
        <Route path="/codex/*" element={<Codex state={state} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ShellOverlay state={state} />
      <OperationSearch state={state} />
      <ShortcutsOverlay state={state} />
      <CommissioningOverlay state={state} />
      <Toast
        open={state.connectionError !== null}
        tone="error"
        title="Console link interrupted"
        message={state.connectionError ?? undefined}
      />
      <OperationToastHost toasts={state.operationToasts} />
    </div>
  );
}
