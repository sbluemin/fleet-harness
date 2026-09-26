import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { ActiveCompanionShortcutsProvider, availableCompanionPanels, type CompanionShortcutEntry, takeKeyboardShortcutsReturnFocus, usableCompanionShortcuts } from "../integration/shortcuts.js";
import { companionDefaultChord, companionShortcutCommandId, shortcutCommandLabel } from "../integration/shortcut-bindings.js";
import { fetchGroups, fetchOperations, fetchTheaterBootstrap, fetchTheaters, restoreDeletion, type DeferredDeletionReceipt } from "../integration/api.js";
import { CommandBand } from "../chrome/components/command-band.js";
import { CommissioningOverlay } from "../chrome/components/commissioning-overlay.js";
import { ControlBar, ControlCurtain, ControlReclaimedNotice } from "../../../../features/remote-access/client/control-handover.js";
import { KeyboardShortcutsDialog } from "../chrome/components/keyboard-shortcuts-dialog.js";
import { OperationSearch } from "../chrome/components/operation-search.js";
import { QuickLaunch } from "../../../../features/execution/client/components/quick-launch.js";
import { ReconnectButton } from "../chrome/components/reconnect-button.js";
import { Toast, ToastHost } from "../chrome/components/toast.js";
import { UpdateCurtain } from "../../../../features/updates/client/update-curtain.js";
import { claimTheaterBootMinimization } from "../integration/boot-minimization-session.js";
import { appendPendingDeletion, deletionCountdownSeconds, latestPendingDeletion } from "../integration/deletion-undo.js";
import { subscribeClosingByAgent, type ClosingByAgent } from "../../../../features/console-use/client/gestures.js";
import { WhatsNewModal } from "../../../../features/updates/client/whatsnew-modal.js";
import { OnboardingHost } from "../../../../features/onboarding/client/onboarding-host.js";
import { CORE_ONBOARDING } from "../integration/onboarding.js";
import { FloatingWidgetLayer } from "../integration/floating-widget-layer.js";
import { PersistentPluginComponents } from "../integration/persistent-components.js";
import { ComputerScreenShareProvider } from "../../../../features/computer-use/client/computer-screen-share.js";
import { bindExpandedSurfaceCloseNotifier, closeExpandedSurfacesOf, getExpandedSurfaceState, openExpandedSurface } from "../chrome/expanded-surface/store.js";
import { useGlobalSettingsStore } from "../../../../features/settings/client/global-settings-store.js";
import { hydrateUpdateProgress, useUpdateProgress } from "../../../../features/updates/client/update-progress-store.js";
import { installConsoleGlobalShortcuts, resolvePanelShortcutOutcome } from "../integration/global-shortcuts.js";
import { useConsoleState } from "../hooks/use-store.js";
import { createHostCapabilities } from "../integration/plugin-capabilities.js";
import { bindConsoleNavigate, notifyConsoleLocationChanged } from "../integration/console-location.js";
import type { PaletteSearchPanel } from "../integration/operation-search.js";
import { useRailEntries } from "../chrome/pane/pane-registry.js";
import { usePluginRegistry, useExpandedSurfaceDescriptors } from "../integration/plugin-registry.js";
import { SettingsRouteAdapter } from "../../../../features/settings/client/settings-route-adapter.js";
import { syncSettingsSearchPlugins } from "../../../../features/settings/client/settings-pane.js";
import { Operations } from "../../../../features/workspace/client/operations.js";
import { refreshObserverStatus } from "../integration/operations-sse.js";
import { COMMISSIONING_SEEN_KEY, closeKeyboardShortcuts, closeOperationSearch, getState, hydrateGroups, hydrateInitialOperations, hydrateOperations, hydrateTheaterBootstrap, hydrateTheaters, openOperationSearch, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, themePolarity, toggleQuickLaunch } from "../integration/store.js";
import { abortReleaseNotesFetch, requestReleaseNotes } from "../../../../features/updates/client/whatsnew.js";
import { getSideBarState, setSideBarCollapsed, subscribeOperationActivityTracking } from "../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { subscribeDormantAutoMinimize } from "../../../../features/workspace/client/canvas/dormant-auto-minimize.js";
import { observeSideBarCollapseMotion } from "../../../../features/workspace/client/sidebar/side-bar-motion.js";
import { useMobileSessionOpen } from "../chrome/mobile/mobile-store.js";
import { MobileTabBar } from "../chrome/mobile/mobile-tab-bar.js";
import { MobileSettingsPage } from "../chrome/mobile/mobile-settings-page.js";
import { MobileTheaterPage } from "../chrome/mobile/mobile-theater-page.js";
import { getViewModeSnapshot, useViewMode } from "../integration/view-mode-store.js";
import { useConsoleLocale, useT } from "../i18n/index.js";
import { resolveReleaseNotesLocale } from "../../../../features/updates/client/whatsnew-i18n.js";
import { syncExperimentModelOptionPlugins } from "../integration/experiment-model-options.js";
import { isZenMode, setZenMode, toggleZenMode, useZenModeState } from "../integration/zen-mode.js";
import { useZenDesktopFullscreen } from "../integration/desktop-fullscreen.js";
import { ZenBar } from "../chrome/zen/zen-bar.js";
import { ZenTransition } from "../chrome/zen/zen-transition.js";
import { toggleZenSideBar } from "../integration/zen-chrome-toggles.js";
import { ConsoleToolbar } from "../chrome/toolbar/console-toolbar.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 SSE 연결보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;
const UNDO_WINDOW_MS = 8_000;
const THEME_NOTICE_AUTO_DISMISS_MS = 8_000;

// 온보딩 엔진이 코어 크롬에 닿는 창구 — 레일 진입점 버튼(RailIcon이 세우는 #rail-tab-<id>)과 단축키 표기.
const ONBOARDING_PORTS = {
  railEntryElement: (railEntryId: string) => document.getElementById(`rail-tab-${railEntryId}`),
  shortcutLabel: (commandId: string) => shortcutCommandLabel(commandId),
} as const;

export function App() {
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const bootOperationIdsRef = useRef<readonly string[] | null>(null);
  const location = useLocation();
  const registry = usePluginRegistry();
  const surfaceDescriptors = useExpandedSurfaceDescriptors();
  const globalSettings = useGlobalSettingsStore();
  const [pendingDeletions, setPendingDeletions] = useState<readonly DeferredDeletionReceipt[]>([]);
  // 에이전트가 닫은 Operation 의 저자 — 되돌리기 배너가 "누가 닫았는지" 를 말한다. 배너가 내려가면 함께 잊는다.
  const [deletionAuthors, setDeletionAuthors] = useState<ReadonlyMap<string, { readonly caller: string; readonly title: string }>>(new Map());
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
  const zenState = useZenModeState();
  const zenMode = zenState.active;
  const zenActive = zenMode && operationsViewVisible && !mobileLayout;
  const workFocusRef = useRef<HTMLElement | null>(null);
  // Zen은 /operations 데스크톱 화면에만 선다. Theater를 바꿔도 Zen은 유지한다 — 작업 표시줄의
  // Theater 메뉴와 다른 Theater의 Operation이 바로 그 전환을 Zen 안에서 하는 길이다.
  // Zen이 켜질 때도 다시 잰다 — 전환 장면은 커튼이 내려온 뒤에 Zen을 켜므로, 그 사이 화면을 떠났거나 모바일이
  // 되었으면 늦게 켜진 Zen을 여기서 거둔다.
  useLayoutEffect(() => {
    if (zenMode && (!operationsViewVisible || mobileLayout)) setZenMode(false);
  }, [zenMode, operationsViewVisible, mobileLayout]);
  useZenDesktopFullscreen(zenActive);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".operations-center-stage, .right-rail-panel-slot, .expanded-surface")) workFocusRef.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  // Zen이 바뀌는 순간 포커스가 걷힌 크롬(inert 영역·숨은 Zen 바·작업 표시줄) 안에 있었다면 작업면으로
  // 돌려준다. 숨은 요소의 포커스는 브라우저가 body로 떨구기도 하므로 전환 직후의 body도 같은 경우로 본다.
  const previousZenActiveRef = useRef(zenActive);
  useLayoutEffect(() => {
    const changed = previousZenActiveRef.current !== zenActive;
    previousZenActiveRef.current = zenActive;
    if (!changed) return;
    const focused = document.activeElement;
    const stranded = focused === document.body
      || (focused instanceof HTMLElement && focused.closest("[inert], .zen-bar[hidden]") !== null);
    if (!stranded) return;
    const target = workFocusRef.current;
    if (target?.isConnected && !target.closest("[inert], [hidden]")) target.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>(".operations-center-stage")?.focus({ preventScroll: true });
  }, [zenActive]);
  // Zen 단축키로 한쪽 크롬을 숨길 때, 포커스가 그 안에 있었다면 위 Zen 진입과 같은 복귀 규칙을
  // 따른다. 숨길 영역 밖의 포커스는 건드리지 않는다.
  const hideZenChromeRestoringFocus = useCallback((regionSelector: string, hide: () => boolean) => {
    const focused = document.activeElement;
    const focusInside = focused instanceof HTMLElement && focused.closest(regionSelector) !== null;
    if (hide() || !focusInside) return;
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now instanceof HTMLElement && now !== document.body && !now.closest("[inert], [hidden]")) return;
      const target = workFocusRef.current;
      if (target?.isConnected && !target.closest("[inert], [hidden]")) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>(".operations-center-stage")?.focus({ preventScroll: true });
    });
  }, []);

  /*
   * 모바일 여부는 폭만으로 정해지지 않는다 — Fleet Console 앱은 UA로, 사용자는 명시 선호로 켤 수
   * 있어 넓은 화면에서도 모바일 셸이 선다. 그 판정을 루트에 실어야 포털로 body에 그려지는 표면처럼
   * React 트리 밖에 놓인 CSS도 같은 답을 읽는다(미디어 쿼리는 거기서 어긋난다).
   */
  useEffect(() => {
    document.documentElement.dataset.viewMode = mobileLayout ? "mobile" : "desktop";
  }, [mobileLayout]);
  const navigate = useNavigate();
  // 플러그인과 코어 비-React 코드가 주소를 바꾸는 유일한 창구에 라우터를 맡긴다 —
  // history를 직접 밀면 popstate가 안 나서 라우터가 이동을 놓친다.
  useEffect(() => bindConsoleNavigate((to, options) => navigate(to, { replace: options?.replace === true })), [navigate]);
  useEffect(() => { notifyConsoleLocationChanged(); }, [location]);
  // 전역 단축키는 밴드의 패널 토글과 같은 계약을 따른다 — 사이드바·rail은 /operations에만 마운트되므로
  // 다른 경로에서 누르면 조작할 표면이 없다. ref로 읽어 리스너 재설치 없이 최신 경로를 본다.
  const operationsViewVisibleRef = useRef(operationsViewVisible);
  operationsViewVisibleRef.current = operationsViewVisible;
  // 팔레트의 "Open panel"과 패널 검색 목록 — RightRail과 같은 레지스트리를 읽어 같은 순서로 선다.
  // 이름은 엔트리가, 검색은 그 엔트리가 세우는 페인들이 말한다. 한 엔트리에 검색을 가진 페인이
  // 여럿이면 결과를 한 그룹으로 합친다 — 팔레트가 보는 단위는 여전히 "무엇을 여는가"다.
  const railBindings = useRailEntries();
  // 설정 검색 공급자는 React 밖에서 불린다 — 플러그인 섹션 스냅샷을 여기서 실어 준다.
  useEffect(() => { syncSettingsSearchPlugins(registry.providers); syncExperimentModelOptionPlugins(registry.providers); }, [registry.providers]);
  const paletteRailPanels = useMemo<readonly PaletteSearchPanel[]>(
    () => railBindings
      // 페인을 세우지 않는 엔트리도 찾을 것을 가질 수 있다 — 확대 표면을 여는 기여가 그렇다.
      .filter((binding) => binding.panes.length > 0 || binding.entry.search !== undefined || binding.entry.surfaceId !== undefined)
      .map((binding) => {
        const providers = [
          ...binding.panes.flatMap((pane) => pane.search === undefined ? [] : [pane.search]),
          ...(binding.entry.search === undefined ? [] : [binding.entry.search]),
        ];
        return {
          id: binding.entry.id,
          icon: binding.entry.icon,
          title: binding.entry.title,
          ...(binding.entry.surfaceId === undefined ? {} : { surfaceId: binding.entry.surfaceId }),
          ...(providers.length === 0
            ? {}
            : {
              search: async (request) => {
                const batches = await Promise.all(providers.map((provider) => provider(request)));
                return batches.flat();
              },
            }),
        };
      }),
    [railBindings],
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
          commandId: companionShortcutCommandId(activeOperation.pluginId, companion.id),
          defaultChord: companionDefaultChord(companion.shortcut.code),
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

  // 확대 표면의 닫힘 통보는 콘솔 수명에 묶는다. 표면 레이어는 /operations 라우트에만
  // 서지만 스토어와 surfaces 능력은 어느 화면에서든 살아 있다 — 레이어에 묶어 두면
  // 설정 화면에서 닫힌 페인의 onClose가 조용히 건너뛰어지고, 플러그인은 자기가 아직
  // 열려 있다고 믿은 채로 남는다.
  useEffect(() => {
    bindExpandedSurfaceCloseNotifier((closed) => {
      surfaceDescriptors.get(closed.surfaceId)?.onClose?.(closed);
    });
    return () => bindExpandedSurfaceCloseNotifier(() => undefined);
  }, [surfaceDescriptors]);

  useEffect(() => {
    const capabilities = createHostCapabilities(() => {
      void fetchOperations().then(hydrateOperations).catch(() => {});
    });
    const cleanups = registry.providers.map((plugin) => plugin.install?.(capabilities)).filter((cleanup): cleanup is () => void => typeof cleanup === "function");
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [registry.providers]);

  useEffect(() => {
    setOperationsViewActive(operationsViewVisible);
  }, [operationsViewVisible]);

  useEffect(() => subscribeOperationActivityTracking(), []);

  useEffect(() => subscribeDormantAutoMinimize(), []);

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

  // Console Use 의 닫기 — 사람이 누른 것과 같은 되돌리기 창을 이 화면에도 세운다.
  useEffect(() => subscribeClosingByAgent((closing: ClosingByAgent) => {
    if (closing.kind !== "operation") return;
    const caller = closing.by.kind === "operation" ? closing.by.title ?? closing.by.operationId : closing.by.pluginId;
    setDeletionAuthors((current) => new Map(current).set(closing.deletionId, { caller, title: closing.targetTitle }));
    enqueueDeletion({ deletionId: closing.deletionId, kind: closing.kind, targetId: closing.targetId, expiresAt: closing.expiresAt });
  }), [enqueueDeletion]);

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
        // Zen은 /operations 데스크톱에서만 켜진다. 그 안의 토글은 Zen을 유지한 채 좌측만 드러낸다.
        if (isZenMode() && resolvePanelShortcut() === "apply") {
          hideZenChromeRestoringFocus(".zen-sidebar-chrome", toggleZenSideBar);
          return;
        }
        setZenMode(false);
        const outcome = resolvePanelShortcut();
        if (outcome === "suppress") return;
        if (outcome === "reveal") {
          navigate("/operations");
          setSideBarCollapsed(false);
          return;
        }
        setSideBarCollapsed(collapsed);
      },
      openOperationSearch,
      closeOperationSearch,
      getOperationSearchMode: () => getState().operationSearchMode,
      toggleQuickLaunch,
      toggleZenMode: () => {
        if (resolvePanelShortcut() === "apply") toggleZenMode();
      },
      toggleRailSurface: (entryId) => {
        const outcome = resolvePanelShortcut();
        const entry = railBindings.find((binding) => binding.entry.id === entryId)?.entry;
        if (outcome === "suppress" || getState().activeTheaterId === null || entry === undefined) return false;
        if (outcome === "reveal") navigate("/operations");
        if (entry.activate) {
          const capabilities = createHostCapabilities();
          entry.activate({
            theaterId: getState().activeTheaterId,
            pathContext: { kind: "root", relPath: null, label: getState().theaters.find((theater) => theater.id === getState().activeTheaterId)?.label ?? "" },
            api: capabilities.api,
            surfaces: capabilities.surfaces,
            rail: capabilities.rail,
            language: consoleLocale,
            theme: getState().activeTheme,
          });
          return true;
        }
        const surfaceId = entry.surfaceId;
        if (surfaceId === undefined) return false;
        if (outcome === "apply" && getExpandedSurfaceState().instances.some((instance) => instance.surfaceId === surfaceId)) closeExpandedSurfacesOf(surfaceId);
        else openExpandedSurface({ surfaceId });
        return true;
      },
      canUndoLastClose,
      undoLastClose,
    });
  }, [canUndoLastClose, consoleLocale, navigate, railBindings, resolvePanelShortcut, undoLastClose]);

  const deletionToast = (
    <Toast
      open={activeDeletion !== null}
      tone="undo"
      title={activeDeletion?.kind === "theater" ? t("chrome.toast.theaterForgotten") : activeDeletion && deletionAuthors.get(activeDeletion.deletionId) ? t("chrome.toast.operationClosedBy", deletionAuthors.get(activeDeletion.deletionId)!) : t("chrome.toast.operationClosed")}
      message={activeDeletion ? t("chrome.toast.secondsRemaining", { count: deletionCountdownSeconds(activeDeletion, undoClock) }) : undefined}
      actionLabel={t("chrome.toast.undo")}
      onAction={undoLastClose}
      progress={activeDeletion ? (activeDeletion.expiresAt - undoClock) / UNDO_WINDOW_MS : undefined}
    />
  );

  return (
    <ComputerScreenShareProvider>
    <ActiveCompanionShortcutsProvider value={companionShortcuts}>
      <div className={`console-shell${zenActive ? " is-zen" : ""}`}>
        {/* Zen 트레이 — 작업 표시줄 오른쪽 끝. 막대(작업 표시줄)는 Operations 페이지가 세우고, 이 트레이는
            콘솔 크롬이라 여기 둔다. 도구모음이 Zen 동안 여기에 선다 — 자리는 Zen이 꺼져 있어도 DOM에 남고,
            바 전체가 hidden이라 그려지지는 않는다. */}
        <ZenBar active={zenActive} local={state.channel === "local"} />
        <span className="zen-mode-announcement" role="status" aria-live="polite">{zenActive ? t("zen.active") : ""}</span>
        {/* The mobile layout carries its own header and tab bar, so the band would be a second,
            taller chrome on the axis a phone has least of. Its view-mode toggle moves to the
            mobile header and its settings entry becomes a tab, so nothing is stranded. */}
        {/* 화면 없는 상주 기여 — 아무것도 그리지 않지만 콘솔 수명 동안 살아 있어야 한다.
            밴드와 라우트 사이(흐름 바 자리)에 두지 않는다: 그 구간은 언더플로 게이트가
            지키는 화이트리스트라, 그리지 않는 것이라도 끼면 계약이 헐거워진다. */}
        <PersistentPluginComponents />
        {mobileLayout ? null : <CommandBand operationsViewVisible={operationsViewVisible} />}
        {/* 도구모음은 하나다 — 모드는 자리만 바꾼다(상단 바 오른쪽 ↔ Zen 트레이). 모바일 셸은 자기 탭 막대를 쓴다. */}
        {mobileLayout ? null : <ConsoleToolbar zen={zenActive} canvas={operationsViewVisible} />}
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
          {state.connection === "live" && state.operationRuntimeHydration === "degraded" && !updateProgress.watching ? (
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
                <Route path="/operations" element={<Operations state={state} claimBootPanelMinimization={claimBootPanelMinimization} onDeferredDeletion={enqueueDeletion} deletionToast={mobileLayout ? null : deletionToast} />} />
                {/* Theater is a phone-only destination: the desktop switches Theater from the band
                    and lists every Theater in its sidebar, so this route has nothing to add there. */}
                <Route path="/theaters" element={mobileLayout ? <MobileTheaterPage state={state} /> : <Navigate to="/operations" replace />} />
                <Route path="/settings" element={mobileLayout ? <MobileSettingsPage /> : <SettingsRouteAdapter />} />
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
          plugins={registry.providers}
          onDeferredDeletion={enqueueDeletion}
          canUndoLastClose={canUndoLastClose}
          onUndoLastClose={undoLastClose}
        />
        <QuickLaunch />
        {state.keyboardShortcutsOpen ? <KeyboardShortcutsDialog onClose={closeKeyboardShortcuts} /> : null}
        <WhatsNewModal state={state} />
        <CommissioningOverlay state={state} />
        <OnboardingHost
          core={CORE_ONBOARDING}
          plugins={registry.onboarding}
          language={consoleLocale}
          welcomeReady={state.bootstrapped && state.version !== "" && !state.releaseNotesLoading && (state.releaseNotesFetchedAt !== null || state.releaseNotesError !== null || state.releaseNotes.length > 0) && !state.whatsNewOpen}
          firstRun={state.bootstrapped && state.theaters.length === 0 && globalSettings.state !== null && !globalSettings.state.seenFeatureTours.includes(COMMISSIONING_SEEN_KEY)}
          ports={ONBOARDING_PORTS}
        />
        <ZenTransition local={state.channel === "local"} />
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
          {mobileLayout ? deletionToast : null}
        </ToastHost>
      </div>
    </ActiveCompanionShortcutsProvider>
    </ComputerScreenShareProvider>
  );
}
