import { getViewedTheaterId, useViewedTheaterId } from "../integration/viewed-theater.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { SDK_API_VERSION } from "@fleet-console/sdk/version";

import { ActiveCompanionShortcutsProvider, takeKeyboardShortcutsReturnFocus } from "../integration/shortcuts.js";
import { shortcutCommandLabel } from "../integration/shortcut-bindings.js";
import { fetchGroups, fetchOperations, fetchTheaters, restoreDeletion, type DeferredDeletionReceipt } from "../integration/api.js";
import { afterBootLane, bootLanePending, openBootLane, startBootSnapshots } from "../integration/boot-schedule.js";
import { CommissioningOverlay } from "../chrome/components/commissioning-overlay.js";
import { ControlBar, ControlCurtain, ControlReclaimedNotice } from "../../../../features/remote-access/client/control-handover.js";
import { KeyboardShortcutsDialog } from "../chrome/components/keyboard-shortcuts-dialog.js";
import { OperationSearch } from "../chrome/components/operation-search.js";
import { QuickLaunch } from "../../../../features/execution/client/components/quick-launch.js";
import { ReconnectButton } from "../chrome/components/reconnect-button.js";
import { Toast, ToastHost } from "../chrome/components/toast.js";
import { UpdateCurtain } from "../../../../features/updates/client/update-curtain.js";
import { appendPendingUndo, archiveUndo, deletionUndo, latestPendingUndo, undoCountdownSeconds, type PendingUndo } from "../integration/deletion-undo.js";
import { openArchiveSheet } from "../integration/operation-archive.js";
import type { ArchiveOutcome } from "../integration/operation-actions.js";
import { ApiError, undoOperationArchive } from "@fleet-console/sdk/operations/browser";
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
import { useDesktopRailEntries } from "../chrome/pane/pane-registry.js";
import { usePluginRegistry, useExpandedSurfaceDescriptors } from "../integration/plugin-registry.js";
import { SettingsRouteAdapter } from "../../../../features/settings/client/settings-route-adapter.js";
import { syncSettingsSearchPlugins } from "../../../../features/settings/client/settings-pane.js";
import { Operations } from "../../../../features/workspace/client/operations.js";
import { openDefaultNewSession } from "../../../../features/workspace/client/conversation/new-session-entry.js";
import { ArchiveSheet } from "../../../../features/workspace/client/archive/archive-sheet.js";
import { TheaterSystemPromptSheet, subscribeTheaterSystemPromptForgotten } from "../../../../features/settings/client/theater-system-prompt-sheet.js";
import { SettingsModalHost } from "../../../../features/settings/client/settings-modal.js";
import { TheaterInboxHost } from "../integration/theater-inbox.js";
import { refreshObserverStatus } from "../integration/operations-sse.js";
import { closeKeyboardShortcuts, closeOperationSearch, getState, hydrateGroups, hydrateInitialOperations, hydrateOperations, hydrateTheaterBootstrap, hydrateTheaters, openOperationSearch, resolveOnboardingOnBootstrap, setOperationsViewActive, setState, themePolarity, toggleQuickLaunch, openQuickLaunchForPluginTarget } from "../integration/store.js";
import { abortReleaseNotesFetch, requestReleaseNotes } from "../../../../features/updates/client/whatsnew.js";
import { getSideBarState, setSideBarCollapsed, subscribeOperationActivityTracking } from "../../../../features/workspace/client/sidebar/operations-side-bar-store.js";
import { MobileFrame } from "../chrome/mobile/mobile-frame.js";
import { setMobileDestination } from "../chrome/mobile/mobile-store.js";
import { MobileActionToast, recallArchivedTitle } from "../chrome/mobile/mobile-toast.js";
import { MobileConnectionBand } from "../chrome/mobile/mobile-connection-band.js";
import { MobileSettingsPage } from "../chrome/mobile/mobile-settings-page.js";
import { getViewModeSnapshot, useViewMode } from "../integration/view-mode-store.js";
import { useConsoleLocale, useT, type CoreMessageKey } from "../i18n/index.js";
import { resolveReleaseNotesLocale } from "../../../../features/updates/client/whatsnew-i18n.js";
import { observeStateMotion } from "../integration/state-motion.js";

// 서버는 부팅 시 update 체크를 fire-and-forget으로 시작하므로, 첫 방문이 SSE 연결보다
// 빠르면 GNB 배지가 누락될 수 있다. 짧은 지연 후 status를 1회만 재조회해 cold-start를 보정한다(폴링 아님).
const UPDATE_STATUS_RECHECK_DELAY_MS = 6_000;
const UNDO_WINDOW_MS = 8_000;
const THEME_NOTICE_AUTO_DISMISS_MS = 8_000;

// 온보딩 엔진이 코어 크롬에 닿는 창구 — 레일 진입점 버튼(RailIcon이 세우는 #rail-tab-<id>)과 단축키 표기.
const ONBOARDING_PORTS = {
  railEntryElement: (railEntryId: string) => document.getElementById(`rail-tab-${railEntryId}`),
  railEntryHintAnchor: () => null,
  railEntryHintDoor: (element: HTMLElement) => element,
  shortcutLabel: (commandId: string) => shortcutCommandLabel(commandId),
} as const;

export function App() {
  const settings = useGlobalSettingsStore();
  const reduceMotion = settings.state?.reduceMotion === true;
  const lowerUnfocusedFrameRate = settings.state?.lowerUnfocusedFrameRate !== false;
  useEffect(() => observeStateMotion({ reduceMotion, lowerUnfocusedFrameRate }), [reduceMotion, lowerUnfocusedFrameRate]);
  // 몽글 아바타의 「차분」 — 문서 뿌리 한 곳에 싣고, 규칙은 components.css 의 .mongle-avatar 가 읽는다.
  const calmAvatars = settings.state?.calmAvatars === true;
  useEffect(() => {
    const root = document.documentElement;
    if (calmAvatars) root.dataset.avatarMotion = "calm";
    else delete root.dataset.avatarMotion;
  }, [calmAvatars]);
  const state = useConsoleState();
  // 종료 안내는 같은 문서에 남기되 활성 화면 전체를 내려 WS·플러그인·폴링과 단축키를 정리한다.
  return state.controlReclaimed === null ? <ConnectedApp /> : <ControlReclaimedNotice />;
}

function ConnectedApp() {
  useViewedTheaterId();
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const location = useLocation();
  const registry = usePluginRegistry();
  const surfaceDescriptors = useExpandedSurfaceDescriptors();
  const globalSettings = useGlobalSettingsStore();
  const [pendingUndos, setPendingUndos] = useState<readonly PendingUndo[]>([]);
  // 에이전트가 치운 Operation 의 저자 — 되돌리기 배너가 "누가 보관했는지" 를 말한다. 배너가 내려가면 함께 잊는다.
  const [undoAuthors, setUndoAuthors] = useState<ReadonlyMap<string, { readonly caller: string; readonly title: string }>>(new Map());
  const [undoClock, setUndoClock] = useState(Date.now());
  // 보관·되돌리기가 거절됐을 때의 짧은 안내 — 조용히 삼키지 않는다.
  const [undoNotice, setUndoNotice] = useState<{ readonly key: CoreMessageKey; readonly nonce: number } | null>(null);
  const [promptForgottenNotice, setPromptForgottenNotice] = useState<string | null>(null);
  useEffect(() => subscribeTheaterSystemPromptForgotten(setPromptForgottenNotice), []);
  useEffect(() => {
    if (promptForgottenNotice === null) return;
    const timer = setTimeout(() => setPromptForgottenNotice(null), THEME_NOTICE_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [promptForgottenNotice]);
  const pendingUndosRef = useRef(pendingUndos);
  const undoInFlightRef = useRef(false);
  pendingUndosRef.current = pendingUndos;
  const activeUndo = latestPendingUndo(pendingUndos, undoClock);
  const t = useT();
  const consoleLocale = useConsoleLocale();
  const releaseNotesLocale = resolveReleaseNotesLocale(globalSettings.state?.language ?? "auto");
  const connectionLostTime = state.connectionLostAt === null
    ? ""
    : new Date(state.connectionLostAt).toLocaleTimeString(consoleLocale);

  useEffect(() => {
    document.documentElement.lang = consoleLocale;
  }, [consoleLocale]);

  const [terminalFocused, setTerminalFocused] = useState(false);
  useEffect(() => {
    const update = () => setTerminalFocused(Boolean(document.activeElement?.closest(".terminal-stage")));
    const afterFocus = () => queueMicrotask(update);
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", afterFocus);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", afterFocus);
    };
  }, []);
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
  const desktopOperationsVisible = !mobileLayout && operationsViewVisible;

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
  const railBindings = useDesktopRailEntries();
  // 설정 검색 공급자는 React 밖에서 불린다 — 플러그인 섹션 스냅샷을 여기서 실어 준다.
  useEffect(() => { syncSettingsSearchPlugins(registry.providers); }, [registry.providers]);
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
          fileReferences: binding.entry.handles?.openFile !== undefined || binding.entry.id === "file-explorer",
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

  // 플러그인 설치는 레일 목록을 부를 때마다 읽는다 — 대화 중심 화면의 탭(사령관·Theater 칸)이 서고 걷힐 때마다 레일 목록이
  // 바뀌는데, 그때마다 모든 플러그인을 다시 설치하면 플러그인이 쥔 상태(사령관 기록·상태)가 비워진다.
  const railBindingsRef = useRef(railBindings);
  railBindingsRef.current = railBindings;
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    // 플러그인 설치가 여는 조회는 목록을 그리는 데 필요 없다. 데스크톱에서는 ready를 보낸 뒤에 세운다.
    const install = (): void => {
      if (cancelled) return;
      const capabilities = createHostCapabilities(() => {
        void fetchOperations().then(hydrateOperations).catch(() => {});
      }, { railBindings: () => railBindingsRef.current });
      for (const plugin of registry.providers) {
        const cleanup = plugin.install?.(capabilities);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
    };
    if (bootLanePending()) void afterBootLane().then(install);
    else install();
    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [registry.providers]);

  useEffect(() => {
    setOperationsViewActive(operationsViewVisible);
  }, [operationsViewVisible]);

  useEffect(() => subscribeOperationActivityTracking(), []);


  useEffect(() => {
    // 부팅이 설정·매니페스트와 함께 시작한 약속이다. 여기서 다시 열면 같은 목록을 두 번 받는다.
    // 수화는 이 마운트 안에서만 한다 — 그리기 전에 플래그를 세우면 ready가 빈 프레임에 나간다.
    let cancelled = false;
    const snapshots = startBootSnapshots();
    void snapshots.theaters.then((bootstrap) => {
      if (cancelled) return;
      hydrateTheaterBootstrap(bootstrap);
      resolveOnboardingOnBootstrap();
    }).catch((error: unknown) => {
      if (cancelled) return;
      setState({ theaterError: error instanceof Error ? error.message : String(error) });
      resolveOnboardingOnBootstrap();
    });
    void snapshots.operations.then((operations) => {
      if (cancelled) return;
      hydrateInitialOperations(operations);
    }).catch(() => {
      if (!cancelled) openBootLane();
    });
    void snapshots.groups.then((groups) => {
      if (cancelled || groups === null) return;
      hydrateGroups(groups);
    });
    refreshObserverStatus();
    // 이 콘솔이 방금 재기동을 겪고 돌아온 것일 수 있다. 그 사실은 서버의 메모리가 아니라
    // 워커가 남긴 기록에만 있으므로, 부팅 때 한 번 물어봐야 결과를 말할 수 있다.
    hydrateUpdateProgress();
    // cold-start 보정: 서버 백그라운드 refresh 완료를 기다렸다가 한 번 더 읽어 배지를 채운다.
    const recheckTimer = window.setTimeout(refreshObserverStatus, UPDATE_STATUS_RECHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(recheckTimer);
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
    if (pendingUndos.length === 0) return;
    const updateClock = () => {
      const nextNow = Date.now();
      setUndoClock(nextNow);
      setPendingUndos((current) => {
        const next = current.filter((entry) => entry.expiresAt > nextNow);
        pendingUndosRef.current = next;
        return next;
      });
    };
    updateClock();
    const timer = window.setInterval(updateClock, 100);
    return () => window.clearInterval(timer);
  }, [pendingUndos.length]);

  useEffect(() => {
    if (!undoNotice) return;
    const timer = window.setTimeout(() => setUndoNotice(null), THEME_NOTICE_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [undoNotice]);

  const enqueueUndo = useCallback((entry: PendingUndo) => {
    if (entry.expiresAt <= Date.now()) return;
    setUndoClock(Date.now());
    setPendingUndos((current) => {
      const next = appendPendingUndo(current, entry);
      pendingUndosRef.current = next;
      return next;
    });
  }, []);

  const dropUndo = useCallback((key: string) => {
    setPendingUndos((current) => {
      const next = current.filter((item) => item.key !== key);
      pendingUndosRef.current = next;
      return next;
    });
  }, []);

  const enqueueDeletion = useCallback((deletion: DeferredDeletionReceipt | null) => {
    if (deletion) enqueueUndo(deletionUndo(deletion));
  }, [enqueueUndo]);

  // 보관은 한 번에 끝난다 — 되돌리기 창은 토스트가 보이는 동안만이고, 그 뒤 복원은 보관함에서 한다.
  const enqueueArchive = useCallback((outcome: ArchiveOutcome) => {
    if (outcome.ok) enqueueUndo(archiveUndo(outcome.receipt, Date.now() + UNDO_WINDOW_MS));
    else setUndoNotice({ key: "chrome.toast.archiveFailed", nonce: Date.now() });
  }, [enqueueUndo]);

  // Console Use 의 보관 — 사람이 누른 것과 같은 되돌리기 창을 이 화면에도 세운다.
  useEffect(() => subscribeClosingByAgent((closing: ClosingByAgent) => {
    const caller = closing.by.kind === "operation" ? closing.by.title ?? closing.by.operationId : closing.by.pluginId;
    const entry = closing.kind === "archive"
      ? archiveUndo(closing.receipt, Date.now() + UNDO_WINDOW_MS)
      : closing.receipt.kind === "operation" ? deletionUndo(closing.receipt) : null;
    if (!entry) return;
    setUndoAuthors((current) => new Map(current).set(entry.key, { caller, title: closing.targetTitle }));
    enqueueUndo(entry);
  }), [enqueueUndo]);

  const undoLastClose = useCallback(() => {
    if (undoInFlightRef.current) return;
    const entry = latestPendingUndo(pendingUndosRef.current, Date.now());
    if (!entry) return;
    undoInFlightRef.current = true;
    const request = entry.kind === "archive"
      ? undoOperationArchive({ targetId: entry.receipt.targetId, archiveId: entry.receipt.archiveId })
        .then(() => Promise.allSettled([fetchOperations(null).then(hydrateOperations)]))
      : restoreDeletion(entry.deletion.deletionId)
        .then(() => Promise.allSettled([
          fetchTheaters(null).then(hydrateTheaters),
          fetchOperations(null).then(hydrateOperations),
          fetchGroups(null).then(hydrateGroups),
        ]));
    void request
      .then(() => dropUndo(entry.key))
      .catch((error: unknown) => {
        if (entry.kind === "archive") {
          // 다른 창에서 이미 복원·재보관·삭제됐다면 이 되돌리기는 더 이상 가리킬 것이 없다 — 사실대로 알리고 내린다.
          dropUndo(entry.key);
          const code = error instanceof ApiError ? error.message : "";
          setUndoNotice({ key: code === "archive_undo_conflict" || code === "unknown_operation" ? "chrome.toast.archiveUndoStale" : "chrome.toast.archiveUndoFailed", nonce: Date.now() });
          return;
        }
        if (entry.expiresAt <= Date.now()) dropUndo(entry.key);
      })
      .finally(() => {
        undoInFlightRef.current = false;
      });
  }, [dropUndo]);

  const canUndoLastClose = useCallback(
    () => pendingUndosRef.current.some((entry) => entry.expiresAt > Date.now()),
    [],
  );

  const lastUndoKind = useCallback(
    () => latestPendingUndo(pendingUndosRef.current, Date.now())?.kind ?? null,
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
      openOperationSearch,
      closeOperationSearch,
      getOperationSearchMode: () => getState().operationSearchMode,
      toggleQuickLaunch,
      // 새 세션 화면은 데스크톱 대화 배치의 본문이다 — 모바일 셸에는 그릴 자리가 없으므로 키를 두고 간다.
      openNewSession: () => {
        if (getViewModeSnapshot().effective === "mobile") return false;
        if (!operationsViewVisibleRef.current) navigate("/operations");
        openDefaultNewSession();
        return true;
      },
      openPluginQuickLaunch: () => {
        const available = registry.providers.some((plugin) => {
          try { return !!plugin.messageMentionTarget && plugin.mentionTargets?.().some((target) => target.quickLaunch); }
          catch { return false; }
        });
        if (!available) return false;
        openQuickLaunchForPluginTarget();
        return true;
      },
      toggleRailSurface: (entryId) => {
        const outcome = resolvePanelShortcut();
        const entry = railBindings.find((binding) => binding.entry.id === entryId)?.entry;
        if (outcome === "suppress" || entry === undefined) return false;
        if (getViewedTheaterId() === null) {
          // fleet 범위는 Theater 없이도 선다 — 아래 공통 activate 경로로 떨어진다.
          if (entry.scope !== "fleet" || entry.activate === undefined) return false;
        }
        if (outcome === "reveal") navigate("/operations");
        if (entry.activate) {
          const capabilities = createHostCapabilities(undefined, { railBindings });
          entry.activate({
            theaterId: getViewedTheaterId(),
            pathContext: { kind: "root", relPath: null, label: getState().theaters.find((theater) => theater.id === getViewedTheaterId())?.label ?? "" },
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
  }, [canUndoLastClose, consoleLocale, navigate, railBindings, registry.providers, resolvePanelShortcut, undoLastClose]);

  const undoAuthor = activeUndo ? undoAuthors.get(activeUndo.key) : undefined;
  const undoTitle = activeUndo === null
    ? ""
    : activeUndo.kind === "deletion"
      ? activeUndo.deletion.kind === "theater"
        ? (activeUndo.deletion.archivedOperationCount ?? 0) > 0
          ? t("chrome.toast.theaterForgottenWithArchived", { count: activeUndo.deletion.archivedOperationCount ?? 0 })
          : t("chrome.toast.theaterForgotten")
        : undoAuthor ? t("chrome.toast.operationClosedBy", undoAuthor) : t("chrome.toast.operationClosed")
      : undoAuthor
        ? t("chrome.toast.operationArchivedBy", undoAuthor)
        : activeUndo.receipt.operationIds.length > 1
          ? t("chrome.toast.operationsArchived", { count: activeUndo.receipt.operationIds.length })
          : t("chrome.toast.operationArchived");
  // 모바일 배치(S-33): 「「{제목}」을(를) 보관했습니다」 + 오른쪽 글자 버튼(되돌리기 · 보관함) — 데스크톱의 세 줄 토스트를 쓰지 않는다.
  const mobileUndoText = activeUndo === null ? "" : activeUndo.kind === "archive" && !undoAuthor && activeUndo.receipt.operationIds.length <= 1
    ? (() => { const title = recallArchivedTitle(activeUndo.receipt.targetId); return title ? t("mobile.toast.archived", { title }) : undoTitle; })()
    : undoTitle;
  const deletionToast = (
    <>
      {mobileLayout ? (
        <MobileActionToast
          open={activeUndo !== null}
          text={mobileUndoText}
          actions={[
            { label: activeUndo?.kind === "archive" ? t("chrome.toast.archiveUndo") : t("chrome.toast.undo"), run: undoLastClose },
            ...(activeUndo?.kind === "archive" ? [{ label: t("chrome.toast.openArchive"), run: () => { setMobileDestination({ kind: "archive" }); navigate("/operations", { replace: true }); } }] : []),
          ]}
        />
      ) : (
      <Toast
        open={activeUndo !== null}
        tone="undo"
        title={undoTitle}
        message={activeUndo ? t("chrome.toast.secondsRemaining", { count: undoCountdownSeconds(activeUndo, undoClock) }) : undefined}
        actionLabel={activeUndo?.kind === "archive" ? t("chrome.toast.archiveUndo") : t("chrome.toast.undo")}
        onAction={undoLastClose}
        secondaryActionLabel={activeUndo?.kind === "archive" ? t("chrome.toast.openArchive") : undefined}
        onSecondaryAction={activeUndo?.kind === "archive" ? openArchiveSheet : undefined}
        progress={activeUndo ? (activeUndo.expiresAt - undoClock) / UNDO_WINDOW_MS : undefined}
      />
      )}
      <Toast open={undoNotice !== null} tone="warn" title={undoNotice ? t(undoNotice.key) : ""} onDismiss={() => setUndoNotice(null)} />
    </>
  );

  const shellBars = (
    <div className="console-shell-bars">
      {/* 배너는 링크가 live가 아닌 동안 유지한다 — offline에만 걸면 재연결 시도가 시작되는 순간
          배너째 언마운트되어, 눌린 버튼의 피드백까지 함께 사라진다(실브라우저 재현). */}
      {/* 업데이트 중에는 링크 상실이 고장이 아니라 진행이다. 같은 순간에 두 가지 이야기를
          내보내면 사용자는 더 무서운 쪽을 믿는다 — 커튼이 떠 있는 동안 배너는 침묵한다. */}
      {state.connection !== "live" && state.connectionLostAt !== null && !updateProgress.watching && mobileLayout ? (
        <MobileConnectionBand failed={state.connection === "offline"}><ReconnectButton /></MobileConnectionBand>
      ) : state.connection !== "live" && state.connectionLostAt !== null && !updateProgress.watching ? (
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
  );

  return (
    <ComputerScreenShareProvider>
    <ActiveCompanionShortcutsProvider value={[]}>
      <div className={`console-shell${desktopOperationsVisible ? " is-operations-view" : ""}`}>
        {/* 화면 없는 상주 기여 — 아무것도 그리지 않지만 콘솔 수명 동안 살아 있어야 한다. */}
        <PersistentPluginComponents />
        {/* 상단 크롬은 없다 — 데스크톱은 대화 중심 화면이 찾기·새 Operation·호스트·사용량·도움말·설정을 사이드바 위·아래 줄로,
            도구를 오른쪽 패널 머리의 글자 탭으로 든다(features/workspace/client/conversation). 모바일 셸은 자기 머리와 탭 막대를 쓴다.
            `/`·`/settings`처럼 /operations로 갈아 끼우는 주소도 그 한 프레임 동안 빈 셸만 보인다. */}
        <FloatingWidgetLayer />
        {/* 흐름 바(연결·저하 배너, 업데이트 결과 바, 제어 반납 바)는 전부 이 한 자리에 모은다. 모바일 배치는 같은 자리를
            상단 막대 아래에 놓는다. 상자는 만들지 않는다(display: contents). */}
        {mobileLayout ? null : shellBars}
        {(() => {
          const routeContent = (
            <main className="console-route-content">
              <Routes>
                <Route path="/" element={<Navigate to="/operations" replace />} />
                <Route path="/operations" element={<Operations state={state} onDeferredDeletion={enqueueDeletion} onArchived={enqueueArchive} deletionToast={mobileLayout ? null : deletionToast} />} />
                <Route path="/settings" element={mobileLayout ? <MobileSettingsPage /> : <SettingsRouteAdapter />} />
                <Route path="*" element={<Navigate to="/operations" replace />} />
              </Routes>
            </main>
          );
          // The mobile frame sits outside the routes: the home list's shortcut chips reach every destination,
          // so a frame that unmounted with the operations route would strand the way back.
          return mobileLayout ? <MobileFrame state={state} bands={shellBars} onDeferredDeletion={enqueueDeletion}>{routeContent}</MobileFrame> : routeContent;
        })()}
        <OperationSearch
          state={state}
          railPanels={paletteRailPanels}
          plugins={registry.providers}
          onArchived={enqueueArchive}
          canUndoLastClose={canUndoLastClose}
          lastUndoKind={lastUndoKind}
          onUndoLastClose={undoLastClose}
        />
        <QuickLaunch />
        {state.keyboardShortcutsOpen ? <KeyboardShortcutsDialog onClose={closeKeyboardShortcuts} /> : null}
        <ArchiveSheet />
        <TheaterSystemPromptSheet />
        {/* 대화 중심 화면의 설정은 레일이 아니라 가운데 모달로 선다(settings-door.ts) — 배치가 바뀌면 열린 설정이 그릇을 갈아탄다. */}
        <SettingsModalHost visible={desktopOperationsVisible} mobile={mobileLayout} />
        <TheaterInboxHost />
        <WhatsNewModal state={state} />
        {mobileLayout ? null : <CommissioningOverlay state={state} />}
        <OnboardingHost
          toursSuspended={terminalFocused || mobileLayout}
          core={CORE_ONBOARDING}
          plugins={registry.onboarding}
          language={consoleLocale}
          ports={ONBOARDING_PORTS}
        />
        <ControlCurtain />
        <ToastHost>
          {/* 준비되지 않은 플러그인은 패널이 그냥 없는 것으로 보였다 — 서버 로그에만 남아
              운영자에게는 이유가 도달하지 않았다. 한 번은 말하고 지나간다. */}
          <Toast
            open={pluginFailuresNotice}
            tone="warn"
            title={t(registry.failures.length === 1 ? "chrome.toast.pluginSkipped_one" : "chrome.toast.pluginSkipped_other", { count: registry.failures.length })}
            message={registry.failures.map((failure) => failure.reason === "unsupported_api_version"
              ? t("chrome.toast.pluginSkippedApiVersion", { name: failure.name ?? failure.id, version: SDK_API_VERSION })
              : failure.name ?? failure.id).join(", ")}
            onDismiss={() => setPluginFailuresNotice(false)}
          />
          <Toast
            open={themeNotice !== null}
            tone="info"
            title={themeNotice === "light" ? t("chrome.toast.themeLight") : t("chrome.toast.themeDark")}
            onDismiss={() => setThemeNotice(null)}
          />
          <Toast open={promptForgottenNotice !== null} tone="warn" title={t("sidebar.theater.prompt.forgotten", { theater: promptForgottenNotice ?? "" })} onDismiss={() => setPromptForgottenNotice(null)} />
          {mobileLayout ? deletionToast : null}
        </ToastHost>
      </div>
    </ActiveCompanionShortcutsProvider>
    </ComputerScreenShareProvider>
  );
}
