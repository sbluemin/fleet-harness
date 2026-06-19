import { useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import type { Location } from "react-router-dom";

import { useMaximized } from "./canvas/canvas-store.js";
import { useOperationsMode } from "./operations-mode.js";
import { setCodexViewMode, useCodexSideWidth, useCodexUserChosen, useCodexViewMode } from "./codex-view-mode.js";
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
import { CodexSurface } from "./components/codex-surface.js";
import { GlobalSettings } from "./pages/global-settings.js";
import { Operations } from "./pages/operations.js";
import { applyObserverStatus, hydrateTerminalSessions, hydrateTheaterBootstrap, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, toggleOperationSearch, toggleShell } from "./store.js";
import { Welcome } from "./pages/welcome.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 registry 응답보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;

export function App() {
  const state = useConsoleState();
  const location = useLocation();
  const pathname = location.pathname;
  const navigate = useNavigate();
  const maximized = useMaximized();
  const operationsMode = useOperationsMode();
  const codexViewMode = useCodexViewMode();
  const codexUserChosen = useCodexUserChosen();
  const codexSideWidth = useCodexSideWidth();
  // Codex는 옵션 A: 모든 모드에서 URL이 /codex로 따라가고, side은 직전 비-Codex 라우트를
  // 배경으로 유지한다(react-router background-location 패턴). 직접 deep-link/새로고침으로 들어오면
  // 배경이 없으므로 저장된 선호와 무관하게 Full(route)로 표시한다(선호값 자체는 보존).
  const isCodexRoute = pathname.startsWith("/codex");
  const backgroundLocationRef = useRef<Location>(location);
  const hasRealBackgroundRef = useRef<boolean>(!isCodexRoute);
  // 최대화는 localStorage에 영속되지만, GNB 숨김은 Map(canvas) Operations 화면에서만 적용한다 —
  // 다른 라우트(Welcome/Codex/Helm)로 가거나 그 상태로 로드되어도 내비게이션이 사라지지 않게 한다.
  const maximizedActive = maximized && pathname.startsWith("/operations") && operationsMode === "canvas";
  // Codex 표현 모드 도출 — 오버레이(side)는 배경이 있거나 사용자가 직접 모드를 고른 경우 허용한다.
  // (deep-link로 막 들어온 첫 렌더에는 둘 다 아니므로 Full로 강등 → 승인된 "새로고침=Full".)
  // codexUserChosen은 reactive 구독이라, deep-link Full 상태에서 같은 값(side)을 다시 눌러도 재렌더된다.
  const codexOverlayActive =
    isCodexRoute && codexViewMode !== "route" && (hasRealBackgroundRef.current || codexUserChosen);
  const codexEffectiveMode = codexOverlayActive ? codexViewMode : "route";
  // Side 패널이 실제로 떠 있는지 — 엣지 핸들 노출(닫힘 시) 및 검색 국한 판단의 단일 기준.
  const codexSideActive = isCodexRoute && codexEffectiveMode === "side";
  // 배경이 없으면(직접 진입 후 사용자가 오버레이를 고른 경우) Welcome을 배경으로 둔다.
  const codexBackground: Location = hasRealBackgroundRef.current
    ? backgroundLocationRef.current
    : { pathname: "/", search: "", hash: "", state: null, key: "codex-fallback" };
  const displayLocation = codexOverlayActive ? codexBackground : location;
  // 화면에 실제로 보이는 라우트가 Operations인지로 판단한다 — Side 오버레이가 /operations를 배경으로
  // 띄우면 실제 URL(/codex)이 아니라 displayLocation 기준이어야 in-view Operation 토스트 억제가 유지된다.
  const operationsViewVisible = displayLocation.pathname.startsWith("/operations");

  useEffect(() => {
    return startObserverConnection();
  }, []);

  // 비-Codex 라우트에 있을 때마다 배경 위치를 기록한다. 이후 Codex를 side로 열면 이 위치가
  // 배경으로 유지된다. effect라 다음 Codex 진입 렌더에서는 직전 비-Codex 위치가 이미 잡혀 있다.
  useEffect(() => {
    if (!isCodexRoute) {
      backgroundLocationRef.current = location;
      hasRealBackgroundRef.current = true;
    }
  }, [isCodexRoute, location]);

  // Operations 뷰가 화면에 떠 있는지를 store에 반영한다(Side 오버레이의 배경 포함). 다른 화면에선
  // 어떤 Operation도 보이지 않으므로, 백그라운드 Operation의 입력 대기 토스트가 잘못 억제되지 않게 한다.
  useEffect(() => {
    setOperationsViewActive(operationsViewVisible);
  }, [operationsViewVisible]);

  // Side 패널이 떠 있는 동안 body에 표식과 패널 폭을 노출한다 — Codex 명령 팔레트(⌘K)를
  // 전체 화면이 아닌 Side 패널 영역 안으로 국한하기 위한 CSS 훅(항목③).
  useEffect(() => {
    const { body } = document;
    if (codexSideActive) {
      body.dataset.codexSide = "true";
      body.style.setProperty("--codex-side-width", `${codexSideWidth}px`);
    } else {
      delete body.dataset.codexSide;
      body.style.removeProperty("--codex-side-width");
    }
    return () => {
      delete body.dataset.codexSide;
      body.style.removeProperty("--codex-side-width");
    };
  }, [codexSideActive, codexSideWidth]);

  // 우현 오버레이(Side 패널·scrim·검색)의 상단 오프셋을 topbar 실제 bottom에 맞춘다 — topbar가 반응형으로
  // 1행/2행이 바뀌거나 라우트별 토글로 높이가 달라져도 GNB를 덮지 않도록 정밀 동기화한다(CSS 값은 초기/폴백).
  useEffect(() => {
    const topbar = document.querySelector(".topbar");
    if (!topbar) return;
    const sync = () => {
      document.documentElement.style.setProperty(
        "--console-topbar-offset",
        `${Math.round(topbar.getBoundingClientRect().bottom)}px`,
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(topbar);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
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
        // 적재 실패 시에는 terminalSessionsHydrated를 올리지 않는다. sessions를 알 수 없는 상태에서 빈
        // sessionOrder로 prune하면 방금 복원한 패널 레이아웃을 지우고 그 빈 상태를 영속해, 일시적 500·네트워크
        // 오류가 사용자 레이아웃의 영구 손실이 된다. prune은 성공 적재(빈 배열 포함) 시에만 권위를 갖는다.
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

  // 오버레이 닫기 = 배경 라우트로 복귀(없으면 Welcome). hash/state까지 보존해 정확히 직전 위치로 돌아간다.
  // /codex를 벗어나면 CodexSurface가 언마운트되며 정리된다.
  const handleCodexClose = () => {
    const background = backgroundLocationRef.current;
    if (hasRealBackgroundRef.current) {
      navigate(
        { pathname: background.pathname, search: background.search, hash: background.hash },
        { state: background.state },
      );
    } else {
      navigate("/");
    }
  };

  // 어느 라우트에서든 Codex를 Side 패널로 연다 — /codex로 이동해 현재 화면을 배경으로 남기고 side 모드로 전환한다.
  const handleOpenCodexSide = () => {
    navigate("/codex");
    setCodexViewMode("side");
  };

  return (
    <div className={`console-shell ${maximizedActive ? "is-maximized" : ""}`}>
      <Topbar state={state} codexMode={codexEffectiveMode} />
      <Routes location={displayLocation}>
        <Route path="/" element={<Welcome state={state} />} />
        <Route path="/operations" element={<Operations state={state} />} />
        <Route path="/carrier-settings" element={<CarrierSettings />} />
        <Route path="/settings" element={<GlobalSettings />} />
        {/* Codex는 <Routes> 밖 CodexSurface가 그린다 — 여기선 와일드카드 리다이렉트만 막는다. */}
        <Route path="/codex/*" element={null} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {isCodexRoute ? <CodexSurface state={state} mode={codexEffectiveMode} onClose={handleCodexClose} /> : null}
      {!isCodexRoute ? <CodexEdgeHandle onOpen={handleOpenCodexSide} /> : null}
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

// Side가 닫혀 있는 비-Codex 화면에서 뷰포트 우현 가장자리에 노출되는 Codex Side 열기 핸들.
// Side가 열리면(=Codex 라우트) App이 이 핸들을 렌더하지 않아 자연히 숨겨진다.
function CodexEdgeHandle({ onOpen }: { readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      className="codex-edge-handle"
      onClick={onOpen}
      aria-label="Open Codex side panel"
      title="Codex (Side)"
    >
      <span className="codex-edge-handle-chevron" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 4 5.5 8l4 4" />
        </svg>
      </span>
      <span className="codex-edge-handle-label">Codex</span>
    </button>
  );
}
