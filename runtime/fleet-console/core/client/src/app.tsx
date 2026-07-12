import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import { fetchGroups, fetchOperations, fetchTheaterBootstrap } from "./api.js";
import { CommandBand } from "./components/command-band.js";
import { CommissioningOverlay } from "./components/commissioning-overlay.js";
import { isKeyboardShortcutsModalOpen } from "./components/keyboard-shortcuts-dialog.js";
import { OperationSearch } from "./components/operation-search.js";
import { Toast } from "./components/toast.js";
import { WhatsNewModal } from "./components/whatsnew-modal.js";
import { useGlobalSettingsStore } from "./global-settings-store.js";
import { useConsoleState } from "./hooks/use-store.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { CarrierSettings } from "./pages/carrier-settings.js";
import { GlobalSettings } from "./pages/global-settings.js";
import { Operations } from "./pages/operations.js";
import { toggleRailChrome } from "./rail/rail-store.js";
import { refreshObserverStatus } from "./operations-sse.js";
import { hydrateGroups, hydrateOperations, hydrateTheaterBootstrap, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, toggleOperationSearch } from "./store.js";
import { abortReleaseNotesFetch, requestReleaseNotes } from "./release-notes-fetch.js";
import { getSideBarState, setSideBarCollapsed } from "./sidebar/operations-side-bar-store.js";
import { resolveReleaseNotesLocale } from "./whatsnew-i18n.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 SSE 연결보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;

// 사이드바/레일 토글 단축키(Mod+B / Mod+Alt+B)가 터미널·텍스트 입력 포커스를 가로채지 않도록 판별한다.
// 예: 터미널 포커스 중 Ctrl+B는 readline backward-character나 tmux prefix로 터미널에 전달돼야 한다.
function isTextEntryFocused(event: KeyboardEvent): boolean {
  for (const node of [event.target, document.activeElement]) {
    if (!(node instanceof Element)) continue;
    if (node.closest(".xterm")) return true;
    const tag = node.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (node.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]')) return true;
  }
  return false;
}

// aria-modal 대화상자(Operation Search, 디렉터리 브라우저 등)가 열려 있으면 배경 크롬(사이드바/레일)을
// 토글하지 않는다 — 모달 경계와 포커스 트랩 의미를 지키기 위함(포커스가 모달 내 버튼으로 이동한 경우 포함).
function isBlockingDialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]:not([hidden])') !== null;
}

export function App() {
  const state = useConsoleState();
  const location = useLocation();
  const registry = usePluginRegistry();
  const globalSettings = useGlobalSettingsStore();
  const releaseNotesLocale = resolveReleaseNotesLocale(globalSettings.state?.language ?? "auto");
  const pathname = location.pathname;
  const operationsViewVisible = pathname.startsWith("/operations");

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
      if (isKeyboardShortcutsModalOpen()) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleOperationSearch();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyB" && event.altKey && !event.shiftKey && !isTextEntryFocused(event) && !isBlockingDialogOpen()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleRailChrome();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyB" && !event.altKey && !event.shiftKey && !isTextEntryFocused(event) && !isBlockingDialogOpen()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSideBarCollapsed(!getSideBarState().collapsed);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return (
    <div className="console-shell">
      <CommandBand operationsViewVisible={operationsViewVisible} />
      <main className="console-route-content">
        <Routes>
          <Route path="/" element={<Navigate to="/operations" replace />} />
          <Route path="/operations" element={<Operations state={state} />} />
          <Route path="/carrier-settings" element={<CarrierSettings />} />
          <Route path="/settings" element={<GlobalSettings />} />
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </main>
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
