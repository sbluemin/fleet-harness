import { useCallback, useEffect, useMemo, useRef } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { fetchGroups, fetchOperations, fetchTheaterBootstrap } from "./api.js";
import { CommandBand } from "./components/command-band.js";
import { CommissioningOverlay } from "./components/commissioning-overlay.js";
import { KeyboardShortcutsDialog } from "./components/keyboard-shortcuts-dialog.js";
import { OperationSearch } from "./components/operation-search.js";
import { Toast } from "./components/toast.js";
import { WhatsNewModal } from "./components/whatsnew-modal.js";
import { useGlobalSettingsStore } from "./global-settings-store.js";
import { installConsoleGlobalShortcuts } from "./global-shortcuts.js";
import { useConsoleState } from "./hooks/use-store.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { GlobalSettings } from "./pages/global-settings.js";
import { Operations } from "./pages/operations.js";
import { BUILT_IN_RAIL_PANELS } from "./rail/built-in-panels.js";
import { toggleRailChrome } from "./rail/rail-store.js";
import { refreshObserverStatus } from "./operations-sse.js";
import { closeKeyboardShortcuts, hydrateGroups, hydrateInitialOperations, hydrateOperations, hydrateTheaterBootstrap, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, toggleOperationSearch } from "./store.js";
import { abortReleaseNotesFetch, requestReleaseNotes } from "./release-notes-fetch.js";
import { getSideBarState, setSideBarCollapsed } from "./sidebar/operations-side-bar-store.js";
import { resolveReleaseNotesLocale } from "./whatsnew-i18n.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 SSE 연결보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;

export function App() {
  const state = useConsoleState();
  const minimizedTheatersRef = useRef<Set<string>>(new Set());
  const bootOperationIdsRef = useRef<readonly string[] | null>(null);
  const location = useLocation();
  const registry = usePluginRegistry();
  const globalSettings = useGlobalSettingsStore();
  const releaseNotesLocale = resolveReleaseNotesLocale(globalSettings.state?.language ?? "auto");
  const pathname = location.pathname;
  const operationsViewVisible = pathname.startsWith("/operations");
  // 팔레트 커맨드 모드의 "Open panel" 목록 — RightRail과 동일한 빌트인+플러그인 합성 순서를 미러한다.
  const paletteRailPanels = useMemo(
    () => [...BUILT_IN_RAIL_PANELS, ...registry.railPanels.filter((panel) => (panel.side ?? "right") === "right")]
      .map((panel) => ({ id: panel.id, title: panel.title })),
    [registry.railPanels],
  );

  // 세션 중 각 Theater를 처음 여는 시점에 한 번, 그 Theater의 "부팅 시점에 이미 존재하던" 패널 집합을 최소화 대상으로 반환한다.
  // App boot의 활성 Theater뿐 아니라 이후 선택·전환으로 처음 진입하는 Theater도 깨끗하게 열려, 선택한 패널만 하나씩 표면화된다.
  // 반환값은 전 Theater를 아우르는 초기 id 목록이고, 실제 최소화는 호출 측이 현재 Theater 패널로 좁힌다.
  const claimBootPanelMinimization = useCallback((theaterId: string): readonly string[] | null => {
    if (bootOperationIdsRef.current === null) return null;
    if (minimizedTheatersRef.current.has(theaterId)) return null;
    minimizedTheatersRef.current.add(theaterId);
    return bootOperationIdsRef.current;
  }, []);

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
    const bootOperationsRequestStartedAt = Date.now();
    void fetchOperations(null, abort.signal).then((operations) => {
      // 요청 시작 뒤 생성된 Operation은 응답에 포함돼도 새 launch로 취급한다.
      bootOperationIdsRef.current = operations
        .filter((operation) => operation.ts.createdAt < bootOperationsRequestStartedAt)
        .map((operation) => operation.id);
      hydrateInitialOperations(operations);
    }).catch(() => {});
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
    return installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => getSideBarState().collapsed,
      setSideBarCollapsed,
      toggleOperationSearch,
      toggleRailChrome,
    });
  }, []);

  return (
    <div className="console-shell">
      <CommandBand operationsViewVisible={operationsViewVisible} />
      <main className="console-route-content">
        <Routes>
          <Route path="/" element={<Navigate to="/operations" replace />} />
          <Route path="/operations" element={<Operations state={state} claimBootPanelMinimization={claimBootPanelMinimization} />} />
          <Route path="/carrier-settings" element={<Navigate to="/settings?section=terminal%3Acarriers" replace />} />
          <Route path="/settings" element={<GlobalSettings />} />
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </main>
      <OperationSearch state={state} railPanels={paletteRailPanels} />
      {state.keyboardShortcutsOpen ? <KeyboardShortcutsDialog onClose={closeKeyboardShortcuts} /> : null}
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
