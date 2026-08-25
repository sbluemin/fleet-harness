import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { ActiveCompanionShortcutsProvider, availableCompanionPanels, type CompanionShortcutEntry, takeKeyboardShortcutsReturnFocus, usableCompanionShortcuts } from "./shortcuts.js";
import { fetchGroups, fetchOperations, fetchTheaterBootstrap, fetchTheaters, restoreDeletion, type DeferredDeletionReceipt } from "./api.js";
import { CommandBand } from "./components/command-band.js";
import { CommissioningOverlay } from "./components/commissioning-overlay.js";
import { ControlBar, ControlCurtain, ControlReclaimedNotice } from "./components/control-handover.js";
import { FeatureTourOverlay } from "./components/feature-tour.js";
import { KeyboardShortcutsDialog } from "./components/keyboard-shortcuts-dialog.js";
import { OperationSearch } from "./components/operation-search.js";
import { QuickLaunch } from "./components/quick-launch.js";
import { ReconnectButton } from "./components/reconnect-button.js";
import { Toast, ToastHost } from "./components/toast.js";
import { UpdateCurtain } from "./components/update-curtain.js";
import { claimTheaterBootMinimization } from "./boot-minimization-session.js";
import { appendPendingDeletion, deletionCountdownSeconds, latestPendingDeletion } from "./deletion-undo.js";
import { WhatsNewModal } from "./components/whatsnew-modal.js";
import { LiquidGlassWelcome } from "./components/liquid-glass-welcome.js";
import { FloatingWidgetLayer } from "./floating-widget-layer.js";
import { useGlobalSettingsStore } from "./global-settings-store.js";
import { hydrateUpdateProgress, useUpdateProgress } from "./update-progress-store.js";
import { installConsoleGlobalShortcuts, resolvePanelShortcutOutcome } from "./global-shortcuts.js";
import { useConsoleState } from "./hooks/use-store.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";
import { GlobalSettings } from "./pages/global-settings.js";
import { Operations } from "./pages/operations.js";
import { BUILT_IN_RAIL_PANELS } from "./rail/built-in-panels.js";
import { setRailChromeExpanded, toggleRailChrome } from "./rail/rail-store.js";
import { refreshObserverStatus } from "./operations-sse.js";
import { closeKeyboardShortcuts, hydrateGroups, hydrateInitialOperations, hydrateOperations, hydrateTheaterBootstrap, hydrateTheaters, openOperationSearch, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, themePolarity, toggleOperationSearch, toggleQuickLaunch } from "./store.js";
import { abortReleaseNotesFetch, requestReleaseNotes } from "./whatsnew.js";
import { getSideBarState, setSideBarCollapsed, subscribeOperationActivityTracking } from "./sidebar/operations-side-bar-store.js";
import { observeSideBarCollapseMotion } from "./sidebar/side-bar-motion.js";
import { useMobileSessionOpen } from "./mobile/mobile-store.js";
import { MobileTabBar } from "./mobile/mobile-tab-bar.js";
import { MobileSettingsPage } from "./mobile/mobile-settings-page.js";
import { MobileTheaterPage } from "./mobile/mobile-theater-page.js";
import { getViewModeSnapshot, useViewMode } from "./view-mode-store.js";
import { useConsoleLocale, useT } from "./i18n/index.js";
import { resolveReleaseNotesLocale } from "./whatsnew-i18n.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 SSE 연결보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;
const UNDO_WINDOW_MS = 8_000;
const THEME_NOTICE_AUTO_DISMISS_MS = 8_000;

export function App() {
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const bootOperationIdsRef = useRef<readonly string[] | null>(null);
  const location = useLocation();
  const registry = usePluginRegistry();
  const globalSettings = useGlobalSettingsStore();
  const [pendingDeletions, setPendingDeletions] = useState<readonly DeferredDeletionReceipt[]>([]);
  const [undoClock, setUndoClock] = useState(Date.now());
  const pendingDeletionsRef = useRef(pendingDeletions);
  const undoInFlightRef = useRef(false);
  pendingDeletionsRef.current = pendingDeletions;
  const activeDeletion = latestPendingDeletion(pendingDeletions, undoClock);
  const t = useT();
  const consoleLocale = useConsoleLocale();
  const releaseNotesLocale = resolveReleaseNotesLocale(globalSettings.state?.language ?? "auto");
  const connectionLostTime = state.connectionLostAt === null
    ? ""
    : new Date(state.connectionLostAt).toLocaleTimeString(consoleLocale);

  useEffect(() => {
    document.documentElement.lang = consoleLocale;
  }, [consoleLocale]);

  // 테마 극성(다크↔라이트) 전환 1회성 전역 안내 — 이전에는 터미널 패널마다 힌트가 떠서 전환 한 번에
  // 패널 수만큼 닫아야 했다. 실행 중 CLI의 내부 테마는 콘솔이 강제할 수 없으므로 안내는 유지하되,
  // 콘솔 chrome이 단 하나의 토스트로 발화한다. 기준선은 마운트 첫 실행에 심는다 — main.tsx가 주입/저장
  // 테마와 서버 settings 적용을 모두 render 전 top-level await로 끝내므로, 마운트 이후의 테마 변경은
  // 사용자 동작뿐이다. theaters bootstrap 같은 무관한 축에 게이트하면 그 응답이 늦거나 실패하는 동안의
  // 전환이 통째로 소실된다(Settings는 그 전에도 조작 가능하다).
  const [themeNotice, setThemeNotice] = useState<"light" | "dark" | null>(null);
  const [pluginFailuresNotice, setPluginFailuresNotice] = useState(registry.failures.length > 0);
  const themePolarityBaselineRef = useRef<"light" | "dark" | null>(null);
  const activeThemePolarity = themePolarity(state.activeTheme);
  useEffect(() => {
    if (themePolarityBaselineRef.current === null) {
      themePolarityBaselineRef.current = activeThemePolarity;
      return;
    }
    if (themePolarityBaselineRef.current !== activeThemePolarity) {
      themePolarityBaselineRef.current = activeThemePolarity;
      setThemeNotice(activeThemePolarity);
    }
  }, [activeThemePolarity]);

  // 안내는 잠시 띄우고 자동으로 거둔다 — 수동 닫기만 두면 "패널마다 닫기"가 "토스트 닫기 1회"로
  // 바뀌는 데 그치므로, 읽을 시간 뒤에는 스스로 사라진다. 재전환 시 새 극성으로 타이머가 리셋된다.
  useEffect(() => {
    if (themeNotice === null) return;
    const timer = setTimeout(() => setThemeNotice(null), THEME_NOTICE_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [themeNotice]);

  const pathname = location.pathname;
  const operationsViewVisible = pathname.startsWith("/operations");
  const mobileLayout = useViewMode().effective === "mobile";
  const mobileSessionOpen = useMobileSessionOpen();

  /*
   * 모바일 여부는 폭만으로 정해지지 않는다 — Fleet Console 앱은 UA로, 사용자는 명시 선호로 켤 수
   * 있어 넓은 화면에서도 모바일 셸이 선다. 그 판정을 루트에 실어야 포털로 body에 그려지는 표면처럼
   * React 트리 밖에 놓인 CSS도 같은 답을 읽는다(미디어 쿼리는 거기서 어긋난다).
   */
  useEffect(() => {
    document.documentElement.dataset.viewMode = mobileLayout ? "mobile" : "desktop";
  }, [mobileLayout]);
  const navigate = useNavigate();
  // 전역 단축키는 밴드의 패널 토글과 같은 계약을 따른다 — 사이드바·rail은 /operations에만 마운트되므로
  // 다른 경로에서 누르면 조작할 표면이 없다. ref로 읽어 리스너 재설치 없이 최신 경로를 본다.
  const operationsViewVisibleRef = useRef(operationsViewVisible);
  operationsViewVisibleRef.current = operationsViewVisible;
  // 팔레트의 "Open panel"과 패널 검색 목록 — RightRail과 동일한 빌트인+플러그인 합성 순서를 미러한다.
  const paletteRailPanels = useMemo(
    () => [...BUILT_IN_RAIL_PANELS, ...registry.railPanels.filter((panel) => (panel.side ?? "right") === "right" && panel.render !== undefined)],
    [registry.railPanels],
  );
  const companionShortcuts = useMemo((): readonly CompanionShortcutEntry[] => {
    const activeOperation = state.operations.find((operation) => operation.id === state.activeOperationId);
    if (!activeOperation) return [];
    const activeKind = registry.operationKinds.find((kind) =>
      kind.pluginId === activeOperation.pluginId && kind.type === activeOperation.type);
    // 도움말은 실제 디스패치와 같은 목록을 읽어야 한다 — 이 작전에서 사용 불가한 패널이 남으면
    // 누를 수 없는 단축키가 단축키 대화상자에 계속 실린다.
    const activeCompanions = availableCompanionPanels(activeKind?.companions ?? [], activeOperation);
    return usableCompanionShortcuts(activeCompanions).flatMap((companion) => companion.shortcut
      ? [{
          label: companion.shortcut.label,
          title: resolveLocalizedText(companion.title, consoleLocale),
        }]
      : []) ?? [];
  }, [consoleLocale, registry.operationKinds, state.activeOperationId, state.operations]);

  // 브라우저 세션 중 각 Theater를 처음 여는 시점에 한 번, 그 Theater의 "부팅 시점에 이미 존재하던" 패널 집합을 최소화 대상으로 반환한다.
  // App boot의 활성 Theater뿐 아니라 이후 선택·전환으로 처음 진입하는 Theater도 깨끗하게 열려, 선택한 패널만 하나씩 표면화된다.
  // "처음"의 기준은 페이지 수명이 아니라 탭 세션이다 — 콘솔 전환·새로고침으로 같은 탭에 돌아왔을 때
  // 사용자가 펼쳐둔 패널을 다시 접지 않기 위해서다.
  // 반환값은 전 Theater를 아우르는 초기 id 목록이고, 실제 최소화는 호출 측이 현재 Theater 패널로 좁힌다.
  const claimBootPanelMinimization = useCallback((theaterId: string): readonly string[] | null => {
    if (bootOperationIdsRef.current === null) return null;
    if (!claimTheaterBootMinimization(theaterId)) return null;
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

  useEffect(() => subscribeOperationActivityTracking(), []);

  useEffect(() => observeSideBarCollapseMotion(), []);

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
    // 이 콘솔이 방금 재기동을 겪고 돌아온 것일 수 있다. 그 사실은 서버의 메모리가 아니라
    // 워커가 남긴 기록에만 있으므로, 부팅 때 한 번 물어봐야 결과를 말할 수 있다.
    hydrateUpdateProgress();
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

  const shortcutsReturnFocusRef = useRef<HTMLElement | null>(null);

  // 단축키 다이얼로그가 열리는 시점의 포커스 요소를 캡처해 닫힐 때 복원한다(Help 메뉴 trigger 복원과 등가).
  // 다이얼로그 자체의 focus effect(passive)보다 먼저 돌도록 layout effect로 캡처한다.
  useLayoutEffect(() => {
    if (!state.keyboardShortcutsOpen) return;
    // 팔레트처럼 자신이 닫히며 여는 표면은 opener를 채널로 넘긴다 — 그 경우 activeElement는 이미 제거 중이다.
    // 캡처는 다이얼로그의 focus effect보다 선행해야 하므로 layout effect로 남긴다.
    shortcutsReturnFocusRef.current = takeKeyboardShortcutsReturnFocus()
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, [state.keyboardShortcutsOpen]);

  // 복원은 passive effect로 — 다이얼로그의 passive cleanup이 .console-shell inert를 걷어낸 뒤에 돌아야
  // 실브라우저에서 inert 조상 때문에 focus()가 무시되지 않는다(layout 단계에서는 아직 inert 상태).
  useEffect(() => {
    if (state.keyboardShortcutsOpen) return;
    const target = shortcutsReturnFocusRef.current;
    shortcutsReturnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }, [state.keyboardShortcutsOpen]);

  useEffect(() => {
    if (pendingDeletions.length === 0) return;
    const updateClock = () => {
      const nextNow = Date.now();
      setUndoClock(nextNow);
      setPendingDeletions((current) => {
        const next = current.filter((deletion) => deletion.expiresAt > nextNow);
        pendingDeletionsRef.current = next;
        return next;
      });
    };
    updateClock();
    const timer = window.setInterval(updateClock, 100);
    return () => window.clearInterval(timer);
  }, [pendingDeletions.length]);

  const enqueueDeletion = useCallback((deletion: DeferredDeletionReceipt | null) => {
    if (!deletion || deletion.expiresAt <= Date.now()) return;
    setUndoClock(Date.now());
    setPendingDeletions((current) => {
      const next = appendPendingDeletion(current, deletion);
      pendingDeletionsRef.current = next;
      return next;
    });
  }, []);

  const undoLastClose = useCallback(() => {
    if (undoInFlightRef.current) return;
    const currentNow = Date.now();
    const deletion = latestPendingDeletion(pendingDeletionsRef.current, currentNow);
    if (!deletion) return;
    undoInFlightRef.current = true;
    void restoreDeletion(deletion.deletionId)
      .then(() => {
        setPendingDeletions((current) => {
          const next = current.filter((item) => item.deletionId !== deletion.deletionId);
          pendingDeletionsRef.current = next;
          return next;
        });
        return Promise.allSettled([
          fetchTheaters(null).then(hydrateTheaters),
          fetchOperations(null).then(hydrateOperations),
          fetchGroups(null).then(hydrateGroups),
        ]);
      })
      .catch(() => {
        if (deletion.expiresAt <= Date.now()) {
          setPendingDeletions((current) => {
            const next = current.filter((item) => item.deletionId !== deletion.deletionId);
            pendingDeletionsRef.current = next;
            return next;
          });
        }
      })
      .finally(() => {
        undoInFlightRef.current = false;
      });
  }, []);

  const canUndoLastClose = useCallback(
    () => pendingDeletionsRef.current.some((deletion) => deletion.expiresAt > Date.now()),
    [],
  );

  // 뷰 모드는 구독하지 않고 발화 시점에 읽는다 — 뷰포트가 바뀔 때마다 리스너를 재설치할 이유가 없다.
  const resolvePanelShortcut = useCallback(() => resolvePanelShortcutOutcome({
    panelSurfacesReachable: getViewModeSnapshot().effective !== "mobile",
    operationsViewVisible: operationsViewVisibleRef.current,
  }), []);

  useEffect(() => {
    return installConsoleGlobalShortcuts({
      getSideBarCollapsed: () => getSideBarState().collapsed,
      setSideBarCollapsed: (collapsed) => {
        const outcome = resolvePanelShortcut();
        if (outcome === "suppress") return;
        if (outcome === "reveal") {
          navigate("/operations");
          setSideBarCollapsed(false);
          return;
        }
        setSideBarCollapsed(collapsed);
      },
      openOperationSearch: () => openOperationSearch(">"),
      toggleOperationSearch,
      toggleQuickLaunch,
      toggleRailChrome: () => {
        const outcome = resolvePanelShortcut();
        if (outcome === "suppress") return;
        if (outcome === "reveal") {
          navigate("/operations");
          setRailChromeExpanded(true);
          return;
        }
        toggleRailChrome();
      },
      canUndoLastClose,
      undoLastClose,
    });
  }, [canUndoLastClose, navigate, resolvePanelShortcut, undoLastClose]);

  return (
    <ActiveCompanionShortcutsProvider value={companionShortcuts}>
      <div className="console-shell">
        {/* The mobile layout carries its own header and tab bar, so the band would be a second,
            taller chrome on the axis a phone has least of. Its view-mode toggle moves to the
            mobile header and its settings entry becomes a tab, so nothing is stranded. */}
        {mobileLayout ? null : <CommandBand operationsViewVisible={operationsViewVisible} />}
        <FloatingWidgetLayer />
        {/* 밴드와 라우트 사이의 흐름 바는 전부 이 자리에 모은다. 밴드 유리 뒤로 본문을 흘리는
            레이아웃(layout.css)은 라우트가 밴드에 실제로 붙어 있을 때만 성립하는데, 그 조건을
            바 목록으로 열거하면 새 바가 생길 때마다 조용히 새어 나간다(연결·저하 배너와 제어 반납
            바를 열거한 뒤 업데이트 결과 바가 남아 있었다). 이 자리를 한 곳으로 만들면 CSS가
            :has(*) 하나로 "지금 흐름 바가 서 있는가"를 직접 물을 수 있고, 앞으로 여기에 무엇을
            더 넣든 게이트가 저절로 닫힌다. 상자는 만들지 않는다(display: contents). */}
        <div className="console-shell-bars">
          {/* 배너는 링크가 live가 아닌 동안 유지한다 — offline에만 걸면 재연결 시도가 시작되는 순간
              배너째 언마운트되어, 눌린 버튼의 피드백까지 함께 사라진다(실브라우저 재현). */}
          {/* 업데이트 중에는 링크 상실이 고장이 아니라 진행이다. 같은 순간에 두 가지 이야기를
              내보내면 사용자는 더 무서운 쪽을 믿는다 — 커튼이 떠 있는 동안 배너는 침묵한다. */}
          {state.connection !== "live" && state.connectionLostAt !== null && !updateProgress.watching ? (
            <div className="console-link-banner" role="status" aria-live="polite">
              <span>{t(state.connection === "offline" ? "chrome.link.offline" : "chrome.link.reconnecting")}. {t("chrome.link.bannerDetail", { time: connectionLostTime })}</span>
              <ReconnectButton />
            </div>
          ) : null}
          <UpdateCurtain />
          {/* 런타임 축이 degraded면 화면의 활동 표시는 마지막으로 알던 값일 뿐 지금의 사실이 아니다.
              칩마다 물음표를 뿌리는 대신 배너 하나로만 말한다(제품 결정) — 어느 쪽이든 모르는 상태를
              유휴나 휴면으로 추정하지는 않는다. */}
          {state.operationRuntimeHydration === "degraded" && !updateProgress.watching ? (
            <div className="console-link-banner" role="status" aria-live="polite">
              <span>{t("chrome.runtime.degraded")}</span>
            </div>
          ) : null}
          <ControlBar />
        </div>
        {(() => {
          const routeContent = (
            <main className="console-route-content">
              <Routes>
                <Route path="/" element={<Navigate to="/operations" replace />} />
                <Route path="/operations" element={<Operations state={state} claimBootPanelMinimization={claimBootPanelMinimization} onDeferredDeletion={enqueueDeletion} />} />
                {/* Theater is a phone-only destination: the desktop switches Theater from the band
                    and lists every Theater in its sidebar, so this route has nothing to add there. */}
                <Route path="/theaters" element={mobileLayout ? <MobileTheaterPage state={state} /> : <Navigate to="/operations" replace />} />
                <Route path="/settings" element={mobileLayout ? <MobileSettingsPage /> : <GlobalSettings />} />
                <Route path="*" element={<Navigate to="/operations" replace />} />
              </Routes>
            </main>
          );
          // The tab bar sits outside the routes because its destinations are routes: settings is a
          // tab, and a bar that unmounted with the operations route would strand the way back.
          return mobileLayout
            ? <div className="mobile-frame">{routeContent}{mobileSessionOpen ? null : <MobileTabBar />}</div>
            : routeContent;
        })()}
        <OperationSearch
          state={state}
          railPanels={paletteRailPanels}
          plugins={registry.plugins}
          onDeferredDeletion={enqueueDeletion}
          canUndoLastClose={canUndoLastClose}
          onUndoLastClose={undoLastClose}
        />
        <QuickLaunch />
        {state.keyboardShortcutsOpen ? <KeyboardShortcutsDialog onClose={closeKeyboardShortcuts} /> : null}
        <WhatsNewModal state={state} />
        <LiquidGlassWelcome state={state} />
        <CommissioningOverlay state={state} />
        <FeatureTourOverlay />
        <ControlCurtain />
        <ControlReclaimedNotice />
        <ToastHost>
          {/* 준비되지 않은 플러그인은 패널이 그냥 없는 것으로 보였다 — 서버 로그에만 남아
              운영자에게는 이유가 도달하지 않았다. 한 번은 말하고 지나간다. */}
          <Toast
            open={pluginFailuresNotice}
            tone="warn"
            title={t(registry.failures.length === 1 ? "chrome.toast.pluginSkipped_one" : "chrome.toast.pluginSkipped_other", { count: registry.failures.length })}
            message={registry.failures.map((failure) => failure.name ?? failure.id).join(", ")}
            onDismiss={() => setPluginFailuresNotice(false)}
          />
          <Toast
            open={themeNotice !== null}
            tone="info"
            title={themeNotice === "light" ? t("chrome.toast.themeLight") : t("chrome.toast.themeDark")}
            onDismiss={() => setThemeNotice(null)}
          />
          <Toast
            open={activeDeletion !== null}
            tone="undo"
            title={activeDeletion?.kind === "theater" ? t("chrome.toast.theaterForgotten") : t("chrome.toast.operationClosed")}
            message={activeDeletion ? t("chrome.toast.secondsRemaining", { count: deletionCountdownSeconds(activeDeletion, undoClock) }) : undefined}
            actionLabel={t("chrome.toast.undo")}
            onAction={undoLastClose}
            progress={activeDeletion ? (activeDeletion.expiresAt - undoClock) / UNDO_WINDOW_MS : undefined}
          />
        </ToastHost>
      </div>
    </ActiveCompanionShortcutsProvider>
  );
}
