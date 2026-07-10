import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { FloatingChromeHandles } from "./components/floating-chrome-handles.js";
import { fetchGroups, fetchOperations, fetchTheaterBootstrap } from "./api.js";
import { CommissioningOverlay } from "./components/commissioning-overlay.js";
import { OperationSearch } from "./components/operation-search.js";
import { Toast } from "./components/toast.js";
import { WhatsNewModal } from "./components/whatsnew-modal.js";
import { useGlobalSettingsStore } from "./global-settings-store.js";
import { useConsoleState } from "./hooks/use-store.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { setRailChromeExpanded, useRailChromeExpanded } from "./rail/rail-store.js";
import { setSideBarCollapsed, useSideBarState } from "./sidebar/operations-side-bar-store.js";
import { CarrierSettings } from "./pages/carrier-settings.js";
import { GlobalSettings } from "./pages/global-settings.js";
import { Operations } from "./pages/operations.js";
import { refreshObserverStatus } from "./operations-sse.js";
import { hydrateGroups, hydrateOperations, hydrateTheaterBootstrap, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, toggleOperationSearch } from "./store.js";
import { abortReleaseNotesFetch, requestReleaseNotes } from "./release-notes-fetch.js";
import { resolveReleaseNotesLocale } from "./whatsnew-i18n.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 SSE 연결보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;

type ChromeRestoreFocusTarget = "sidebar" | "rail" | null;

export function App() {
  const state = useConsoleState();
  const location = useLocation();
  const registry = usePluginRegistry();
  const globalSettings = useGlobalSettingsStore();
  const releaseNotesLocale = resolveReleaseNotesLocale(globalSettings.state?.language ?? "auto");
  const pathname = location.pathname;
  const sideBar = useSideBarState();
  const railChromeExpanded = useRailChromeExpanded();
  const operationsViewVisible = pathname.startsWith("/operations");
  const [chromeRestoreFocusTarget, setChromeRestoreFocusTarget] = useState<ChromeRestoreFocusTarget>(null);

  useEffect(() => {
    const capabilities = createHostCapabilities(() => {
      void fetchOperations().then(hydrateOperations).catch(() => {});
    });
    const cleanups = registry.plugins.map((plugin) => plugin.install?.(capabilities)).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [registry.plugins]);

  useEffect(() => {
    setOperationsViewActive(operationsViewVisible);
  }, [operationsViewVisible]);

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
    void fetchOperations(null, abort.signal).then(hydrateOperations).catch(() => {});
    void fetchGroups(null, abort.signal).then(hydrateGroups).catch(() => {});
    refreshObserverStatus();
    // cold-start 보정: 서버 백그라운드 refresh 완료를 기다렸다가 한 번 더 읽어 배지를 채운다.
    const recheckTimer = window.setTimeout(refreshObserverStatus, UPDATE_STATUS_RECHECK_DELAY_MS);
    return () => {
      window.clearTimeout(recheckTimer);
      abort.abort();
    };
  }, []);

  useEffect(() => {
    void requestReleaseNotes({ locale: releaseNotesLocale });
    return abortReleaseNotesFetch;
  }, [releaseNotesLocale]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleOperationSearch();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return (
    <div
      className="console-shell"
      onClickCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        if (!sideBar.collapsed && event.target.closest(".side-bar-collapse-btn")) {
          setChromeRestoreFocusTarget("sidebar");
        }
        if (railChromeExpanded && event.target.closest(".right-rail-chrome-toggle")) {
          setChromeRestoreFocusTarget("rail");
        }
      }}
    >
      <main className="console-route-content">
        <Routes>
          <Route path="/" element={<Navigate to="/operations" replace />} />
          <Route path="/operations" element={<Operations state={state} />} />
          <Route path="/carrier-settings" element={<CarrierSettings />} />
          <Route path="/settings" element={<GlobalSettings />} />
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </main>
      <FloatingChromeHandles
        active={operationsViewVisible}
        sidebarClosed={sideBar.collapsed}
        railClosed={!railChromeExpanded}
        pendingTarget={chromeRestoreFocusTarget}
        onRestoreSidebar={() => {
          setSideBarCollapsed(false);
          setChromeRestoreFocusTarget("sidebar");
        }}
        onRestoreRail={() => {
          setRailChromeExpanded(true);
          setChromeRestoreFocusTarget("rail");
        }}
        onFocusComplete={() => setChromeRestoreFocusTarget(null)}
      />
      <OperationSearch state={state} />
      <WhatsNewModal state={state} />
      <CommissioningOverlay state={state} />
      <Toast
        open={state.connectionError !== null}
        tone="error"
        title="Console link interrupted"
        message={state.connectionError ?? undefined}
      />
    </div>
  );
}
