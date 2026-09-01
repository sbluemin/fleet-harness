import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";

import { SegmentedThumb } from "@fleet-console/sdk/react/browser";

import { fetchConsoleEnvironment } from "../api.js";
import { animateViewportTo, clearFormationView, fitAllOperations, selectFormationLayout, setStationKeeping, toggleFormationView, useFormationLayout, useFormationView, useStationKeeping, type FormationLayout } from "../canvas/canvas-store.js";
import { enterTriage, focusedTriageOperationId, setTriageActive, setTriageSpotlightEnabled, useTriageActive, useTriageDeckZoomLive, useTriageSpotlightEnabled } from "../canvas/triage-store.js";
import { cycleTriageDeckZoomPreset } from "../canvas/triage-watch-deck.js";
import { commandBandCenterFits, commandBandCenterGutter } from "./command-band-guards.js";
import { CommandBandSystemCluster } from "./command-band-system-cluster.js";
import { ViewModeToggle } from "./view-mode-toggle.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useUpdateProgress } from "../update-progress-store.js";
import { setRailChromeExpanded, toggleRailChrome, useRailChromeExpanded } from "../rail/rail-store.js";
import { setSideBarCollapsed, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { toggleOperationSearch } from "../store.js";
import type { ConsoleEnvironmentDiagnostics } from "../types.js";
import { useT, type CoreMessageKey } from "../i18n/index.js";
import { useViewMode } from "../view-mode-store.js";
import { useFullscreenCommandBand } from "./use-fullscreen-command-band.js";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

interface CommandBandProps {
  readonly operationsViewVisible: boolean;
}

// Cruise / Tactical / War Room은 번역하지 않는 제품 고유 명칭이다 — 로케일이 바뀌어도
// 모드 이름은 그대로고, 설명(title/aria)만 번역된다.
type CanvasMode = "cruise" | "tactical" | "warRoom";

interface CanvasModeSegment {
  readonly id: CanvasMode;
  readonly label: string;
  readonly titleKey: CoreMessageKey;
}

// 모드는 낱말로, 모드 전용 도구는 아이콘으로 말한다. 세그먼트에 아이콘을 함께 두면 클러스터가
// 375px까지 벌어져 좁은 밴드에서 중앙 정렬이 조기에 무너진다(2026-08 실측).
const CANVAS_MODES: readonly CanvasModeSegment[] = [
  { id: "cruise", label: "Cruise", titleKey: "chrome.commandBand.modeCruise" },
  { id: "tactical", label: "Tactical", titleKey: "chrome.commandBand.modeTactical" },
  { id: "warRoom", label: "War Room", titleKey: "chrome.commandBand.modeWarRoom" },
];

const TACTICAL_LAYOUTS: readonly {
  readonly id: FormationLayout;
  readonly titleKey: CoreMessageKey;
  readonly Icon: () => ReactElement;
}[] = [
  { id: "grid", titleKey: "chrome.commandBand.tacticalGrid", Icon: FormationGridIcon },
  { id: "columns", titleKey: "chrome.commandBand.tacticalColumns", Icon: FormationColumnsIcon },
  { id: "rows", titleKey: "chrome.commandBand.tacticalRows", Icon: FormationRowsIcon },
];

export function CommandBand({ operationsViewVisible: requestedOperationsViewVisible }: CommandBandProps) {
  const t = useT();
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const sideBar = useSideBarState();
  const railChromeExpanded = useRailChromeExpanded();
  const viewMode = useViewMode();
  const operationsViewVisible = requestedOperationsViewVisible && viewMode.effective !== "mobile";
  const modLabel = resolveModLabel();
  const sideBarShortcut = `${modLabel}${modLabel === "⌘" ? "" : "+"}B`;
  const railShortcut = `${modLabel}${modLabel === "⌘" ? "⌥" : "+Alt+"}B`;
  const navigate = useNavigate();
  // 두 패널 토글은 데스크톱 밴드에 상주한다 — 사라졌다 나타나는 조작 표면은 밴드를 불안정하게 읽히게 하고,
  // 버튼이 없는 동안에도 ⌘B·⌘⌥B는 계속 발화해 보이지 않는 영속 상태만 바꿨다(2026-08 실측).
  // /operations 밖에서는 접을 표면 자체가 없으므로 팔레트 toggle-rail과 같은 경로로 Operations로 돌아가 펼친다.
  const panelTogglesVisible = viewMode.effective !== "mobile";
  const sideBarToggleExpands = !operationsViewVisible || sideBar.collapsed;
  const sideBarToggleLabel = t(sideBarToggleExpands ? "chrome.commandBand.expandSidebar" : "chrome.commandBand.collapseSidebar", { shortcut: sideBarShortcut });
  const railToggleExpands = !operationsViewVisible || !railChromeExpanded;
  const railToggleLabel = t(railToggleExpands ? "chrome.commandBand.expandActivityRail" : "chrome.commandBand.collapseActivityRail", { shortcut: railShortcut });
  const handleSideBarToggle = useCallback(() => {
    if (operationsViewVisible) {
      setSideBarCollapsed(!sideBar.collapsed);
      return;
    }
    navigate("/operations");
    setSideBarCollapsed(false);
  }, [navigate, operationsViewVisible, sideBar.collapsed]);
  const handleRailToggle = useCallback(() => {
    if (operationsViewVisible) {
      toggleRailChrome();
      return;
    }
    navigate("/operations");
    setRailChromeExpanded(true);
  }, [navigate, operationsViewVisible]);
  const formationLayout = useFormationLayout();
  const formationView = useFormationView();
  const triageActive = useTriageActive();
  const triageSpotlightEnabled = useTriageSpotlightEnabled();
  const stationKeeping = useStationKeeping();
  const triageDeckZoomLive = useTriageDeckZoomLive();
  const canvasMode: CanvasMode = triageActive ? "warRoom" : formationView ? "tactical" : "cruise";
  const selectCanvasMode = (mode: CanvasMode) => {
    if (mode === canvasMode) return;
    if (mode === "warRoom") {
      enterTriage(focusedTriageOperationId(document.activeElement));
      return;
    }
    if (triageActive) setTriageActive(false);
    if (mode === "tactical") {
      if (!formationView) toggleFormationView();
      return;
    }
    if (formationView) clearFormationView();
  };
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const mapControlsRef = useRef<HTMLDivElement>(null);
  const bandLeftRef = useRef<HTMLDivElement>(null);
  const bandRightRef = useRef<HTMLDivElement>(null);
  const edgeRevealRef = useRef<HTMLButtonElement>(null);
  const pointerWithinRef = useRef({ edge: false, band: false });
  const [bandWidth, setBandWidth] = useState(0);
  const [leftContentEnd, setLeftContentEnd] = useState(0);
  const [rightContentWidth, setRightContentWidth] = useState(0);
  const [centerContentWidth, setCenterContentWidth] = useState(0);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<ConsoleEnvironmentDiagnostics | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailedValue, setCopyFailedValue] = useState<string | null>(null);
  // 맵 컨트롤(모드 스위치+트레이)은 중앙 트랙의 단독 승객이다(Theater›Operation 브레드크럼
  // 퇴역). 중앙은 Console 전체 정중앙에 고정하므로 여백 하한은 좌·우 클러스터의 실측 콘텐츠
  // 폭 중 큰 쪽에서 잰다 — 한쪽만 예약하면 중앙이 viewport 중앙에서 밀리거나 우측과 겹친다.
  const centerGutter = commandBandCenterGutter(leftContentEnd, rightContentWidth);
  // 중앙이 하한 사이에 들어가지 못하는 폭에서는 감추는 대신 좌측 플로우로 되돌린다 — 모드
  // 스위치는 캔버스 모드의 유일한 조작면이라 접을 수 없다. 판정용 centerGutter는 그대로 두어
  // 되돌아오는 폭이 흔들리지 않게 하고, CSS에 주입하는 값만 0으로 내린다.
  const centerControlsCentered = commandBandCenterFits(bandWidth, centerGutter, centerContentWidth);
  const injectedCenterGutter = centerControlsCentered ? centerGutter : 0;
  // 열림/닫힘 전환 시 이벤트 핸들러에서 동기 호출한다 — open effect(폐기 후 fetch)는 paint 뒤에 돌므로
  // 여기서 지우지 않으면 재오픈 첫 프레임에 이전 절대경로가 그대로 렌더된다.
  const discardEnvironmentState = () => {
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(false);
    setCopiedValue(null);
    setCopyFailedValue(null);
  };
  const desktopShell = typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
  // darwin Desktop은 traffic-light 인셋(88px)이 첫 트랙을 잠식해 전체 라벨이 사이드바 경계를 넘는다.
  // Desktop 앱 안에서는 Desktop임이 자명하므로 칩은 "Local"로 축약하고, Desktop 구분은 팝오버의
  // Desktop data 행이 유지한다(대원수 재가).
  const desktopChipLabel = typeof document !== "undefined" && document.documentElement.dataset.desktopPlatform === "darwin"
    ? t("chrome.commandBand.local")
    : t("chrome.commandBand.localDesktop");
  const canAutoHide = useCallback(() => {
    const activeElement = document.activeElement;
    const focusWithin = activeElement instanceof Node && (commandBandRef.current?.contains(activeElement) || edgeRevealRef.current?.contains(activeElement));
    return !focusWithin && !pointerWithinRef.current.edge && !pointerWithinRef.current.band;
  }, []);
  const fullscreen = useFullscreenCommandBand(canAutoHide);
  // 도킹 중에는 밴드가 흐름에 있어 부를 대상이 없다 — 엣지 스트립을 남기면 스테이지 최상단에
  // 클릭을 가로채는 투명 오버레이만 떠 있게 된다.
  const edgeRevealActive = fullscreen.isFullscreen && !fullscreen.isDocked;

  // 도킹하면 엣지 스트립이 display:none으로 사라지는데 Chromium은 activeElement를 그 위에
  // 그대로 남긴다. 그 포커스가 남아 있으면 canAutoHide가 영원히 거짓이라, 나중에 도킹을 풀어도
  // 밴드가 다시는 숨지 않는다.
  useEffect(() => {
    if (edgeRevealActive) return;
    const edge = edgeRevealRef.current;
    if (edge !== null && document.activeElement === edge) edge.blur();
  }, [edgeRevealActive]);

  useEffect(() => {
    if (!environmentOpen) return;
    const controller = new AbortController();
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(true);
    fetchConsoleEnvironment(controller.signal)
      .then(setEnvironment)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEnvironmentError(error instanceof Error ? error.message : t("chrome.commandBand.unableToLoadEnvironment"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEnvironmentLoading(false);
      });
    return () => controller.abort();
  }, [environmentOpen, t]);

  useEffect(() => {
    if (!environmentOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || environmentTriggerRef.current?.contains(target) || environmentPopoverRef.current?.contains(target)) return;
      setEnvironmentOpen(false);
      discardEnvironmentState();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setEnvironmentOpen(false);
      discardEnvironmentState();
      environmentTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [environmentOpen]);

  // 좌·우 클러스터의 실측 콘텐츠 폭이 중앙 여백 하한의 원료이고, 맵 컨트롤의 자연 폭이 중앙
  // 소요 폭이다. 사이드바 폭이 아니라 클러스터 폭이 하한을 정하므로 viewport 미디어쿼리로는
  // 판정할 수 없다. 자식 끝을 재는 이유: 칩 폭 변화(연결 상태 라벨·폰트 로드)와 모드 트레이의
  // 모드별 폭 변동이 모두 하한·소요 폭을 움직인다. offsetParent 좌표계는 밴드와 동일하다.
  useLayoutEffect(() => {
    const band = commandBandRef.current;
    if (!band || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = band.clientWidth;
      setBandWidth(width);
      const bandLeft = bandLeftRef.current;
      setLeftContentEnd(bandLeft === null ? 0 : Math.max(0, ...Array.from(bandLeft.children, (child) => (child instanceof HTMLElement ? child.offsetLeft + child.offsetWidth : 0))));
      const bandRight = bandRightRef.current;
      setRightContentWidth(bandRight === null ? 0 : Math.max(0, ...Array.from(bandRight.children, (child) => (child instanceof HTMLElement ? width - child.offsetLeft : 0))));
      // scrollWidth를 읽는다 — 중앙 트랙이 소요 폭보다 좁게 눌린 프레임에서도 자연 폭을
      // 돌려주므로, 눌린 값이 판정에 되먹임되어 접힘/복귀가 진동하는 일이 없다.
      const mapControls = mapControlsRef.current;
      setCenterContentWidth(mapControls === null ? 0 : mapControls.scrollWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    const mapControls = mapControlsRef.current;
    if (mapControls) observer.observe(mapControls);
    // 칩·트레이 폭 변화도 하한을 움직인다 — 자식을 직접 관찰하고, 자식의 등장/퇴장은
    // 아래 deps가 effect를 다시 돌려 관찰 대상을 갱신한다(모드 전환·fullscreen 핀 포함).
    const bandLeft = bandLeftRef.current;
    if (bandLeft) for (const child of bandLeft.children) observer.observe(child);
    const bandRight = bandRightRef.current;
    if (bandRight) for (const child of bandRight.children) observer.observe(child);
    return () => observer.disconnect();
  }, [operationsViewVisible, state.channel, state.connection, canvasMode, fullscreen.isFullscreen]);

  useEffect(() => {
    if (state.channel === "local") return;
    setEnvironmentOpen(false);
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(false);
    setCopiedValue(null);
    setCopyFailedValue(null);
  }, [state.channel]);

  const copyEnvironmentValue = (value: string) => {
    // 복사 실패는 해당 버튼의 인라인 상태로만 알린다 — environmentError는 fetch 실패 전용이며
    // 세팅하면 팝오버 전체가 에러 화면으로 대체되어 진단 값 자체를 볼 수 없게 된다.
    void navigator.clipboard.writeText(value)
      .then(() => { setCopiedValue(value); setCopyFailedValue(null); })
      .catch(() => { setCopyFailedValue(value); setCopiedValue(null); });
  };

  const hideAfterInteractionLeaves = () => {
    if (canAutoHide()) fullscreen.hideAfterLeave();
  };

  const handleInteractionBlur = (event: FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if ((!(nextTarget instanceof Node) || (!commandBandRef.current?.contains(nextTarget) && !edgeRevealRef.current?.contains(nextTarget))) && !pointerWithinRef.current.edge && !pointerWithinRef.current.band) {
      fullscreen.hideAfterLeave();
    }
  };

  const handleEdgePointerEnter = () => {
    pointerWithinRef.current.edge = true;
    fullscreen.reveal();
  };

  const handleEdgePointerLeave = () => {
    pointerWithinRef.current.edge = false;
    hideAfterInteractionLeaves();
  };

  const handleBandPointerEnter = () => {
    pointerWithinRef.current.band = true;
    fullscreen.reveal();
  };

  const handleBandPointerLeave = () => {
    pointerWithinRef.current.band = false;
    hideAfterInteractionLeaves();
  };

  const commandBandHidden = fullscreen.isFullscreen && !fullscreen.isVisible;

  return (
    <>
      <button
        ref={edgeRevealRef}
        type="button"
        className={`command-band-edge-reveal${edgeRevealActive ? " is-fullscreen" : ""}`}
        aria-label={t("chrome.commandBand.showCommandBand")}
        onPointerEnter={handleEdgePointerEnter}
        onPointerLeave={handleEdgePointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
        onKeyDown={(event) => { if (event.key === "Tab") fullscreen.reveal(); }}
      />
      <header
        ref={commandBandRef}
        className={`command-band${requestedOperationsViewVisible ? " is-operations" : " is-utility"}${centerControlsCentered ? "" : " is-center-flow"}${fullscreen.isFullscreen ? " is-fullscreen" : ""}${fullscreen.isVisible ? " is-revealed" : ""}${fullscreen.isFullscreen && fullscreen.isDocked ? " is-docked" : ""}`}
        style={{
          "--command-band-center-gutter": `${injectedCenterGutter}px`,
        } as CSSProperties}
        aria-hidden={commandBandHidden || undefined}
        inert={commandBandHidden || undefined}
        onPointerEnter={handleBandPointerEnter}
        onPointerLeave={handleBandPointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
      >
      <div ref={bandLeftRef} className="command-band-left">
        <BrandHome />
        {state.channel === "local" ? <div className="command-band-environment">
          <button ref={environmentTriggerRef} type="button" className={`command-band-local-chip${state.controlHolder !== null ? " is-shared" : ""}`} aria-haspopup="dialog" aria-expanded={environmentOpen} onClick={() => { discardEnvironmentState(); setEnvironmentOpen((open) => !open); }}>
          <span className="command-band-local-dot" aria-hidden="true" />
          <span className="command-band-local-chip-label">{state.controlHolder !== null ? t("chrome.control.shared") : desktopShell ? desktopChipLabel : t("chrome.commandBand.local")}</span>
          </button>
          {environmentOpen ? <div ref={environmentPopoverRef}><EnvironmentPopover environment={environment} error={environmentError} loading={environmentLoading} copiedValue={copiedValue} copyFailedValue={copyFailedValue} desktopShell={desktopShell} onCopy={copyEnvironmentValue} /></div> : null}
        </div> : null}
        {/* 업데이트 중에는 링크 상실이 고장이 아니라 진행이다. 커튼이 그 사실을 말하고 있는
            동안 이 칩까지 "연결 끊김"이라고 말하면, 한 화면이 두 가지 이야기를 한다. */}
        {state.connection !== "live" && !updateProgress.watching ? (
          <span className="command-band-link-chip" data-link-state={state.connection}>
            {t(state.connection === "offline" ? "chrome.link.offline" : "chrome.link.reconnecting")}
          </span>
        ) : null}
        {panelTogglesVisible ? <button type="button" className="command-band-button command-band-sidebar-toggle" onClick={handleSideBarToggle} aria-label={sideBarToggleLabel} title={sideBarToggleLabel}>
          <PanelToggleIcon side="left" />
        </button> : null}
        <button type="button" className="command-band-button command-band-search" onClick={toggleOperationSearch} aria-label={t("chrome.commandBand.searchSessions")} title={t("chrome.commandBand.searchSessionsTitle")}>
          <SearchIcon />
        </button>
      </div>
      {/* 맵 컨트롤은 중앙 트랙의 단독 승객이다 — Theater›Operation 브레드크럼은 사이드바가
          이미 말하는 문장이라 퇴역했고, 캔버스 모드가 밴드의 정중앙을 가져간다. */}
      <div className="command-band-center">
        {operationsViewVisible ? <div ref={mapControlsRef} className="command-band-map-controls">
        <div className="command-band-mode-switch" role="group" aria-label={t("chrome.commandBand.canvasMode")}>
          <SegmentedThumb />
          {CANVAS_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className="command-band-mode-seg"
              data-canvas-mode={mode.id}
              disabled={mode.id === "tactical" ? state.activeTheaterId === null : state.theaters.length === 0}
              aria-pressed={canvasMode === mode.id}
              aria-label={t(mode.titleKey)}
              title={t(mode.titleKey)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCanvasMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {canvasMode === "cruise" ? <div className="command-band-mode-tray" role="group" aria-label={t("chrome.commandBand.cruiseTools")}>
          <span className="command-band-mode-tray-divider" aria-hidden="true" />
          <button type="button" className="command-band-mode-tool" onClick={() => animateViewportTo({ x: 0, y: 0, zoom: 1 })} disabled={state.activeTheaterId === null} aria-label={t("chrome.commandBand.resetCanvasView")} title={t("chrome.commandBand.resetCanvasView")}><ResetViewIcon /></button>
          <button type="button" className="command-band-mode-tool" onClick={fitAllOperations} disabled={state.activeTheaterId === null || !state.operationsHydrated} aria-label={t("chrome.commandBand.fitAllPanels")} title={t("chrome.commandBand.fitAllPanels")}><FitAllIcon /></button>
          <button
            type="button"
            className="command-band-mode-tool"
            data-cruise-tool="station-keeping"
            aria-pressed={stationKeeping}
            disabled={state.activeTheaterId === null || !state.operationsHydrated}
            aria-label={t("chrome.commandBand.stationKeeping")}
            title={t("chrome.commandBand.stationKeeping")}
            onClick={() => setStationKeeping(!stationKeeping)}
          ><StationKeepingIcon /></button>
        </div> : null}
        {canvasMode === "warRoom" ? <div className="command-band-mode-tray" role="group" aria-label={t("chrome.commandBand.warRoomTools")}>
          <span className="command-band-mode-tray-divider" aria-hidden="true" />
          {/* data-war-room-tool은 화면 안내가 짚는 자리다 — 라벨이나 트레이 순서가 바뀌어도
              앵커가 조용히 사라지지 않도록 의미 속성으로 표시한다. */}
          <button
            type="button"
            className="command-band-mode-tool"
            data-war-room-tool="spotlight"
            aria-pressed={triageSpotlightEnabled}
            aria-label={t("canvas.triage.spotlightTitle")}
            title={t("canvas.triage.spotlightTitle")}
            onClick={() => setTriageSpotlightEnabled(!triageSpotlightEnabled)}
          ><SpotlightIcon /></button>
          <button
            type="button"
            className="command-band-mode-tool is-valued"
            data-war-room-tool="density"
            aria-pressed={triageDeckZoomLive !== 1.0}
            aria-label={t("canvas.triage.densityChipTitle")}
            title={t("canvas.triage.densityChipTitle")}
            onClick={cycleTriageDeckZoomPreset}
          ><DensityIcon /><span>{triageDeckZoomLive.toFixed(1)}×</span></button>
        </div> : null}
        {canvasMode === "tactical" ? <div className="command-band-mode-tray" role="group" aria-label={t("chrome.commandBand.tacticalTools")}>
          <span className="command-band-mode-tray-divider" aria-hidden="true" />
          {TACTICAL_LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className="command-band-mode-tool"
              // 이미 켜진 레이아웃을 다시 누르면 selectFormationLayout이 모드를 꺼버린다 —
              // 모드 이탈은 Cruise 세그먼트만 소유하므로 같은 레이아웃 클릭은 무시한다.
              onClick={() => { if (formationLayout !== layout.id) selectFormationLayout(layout.id); }}
              aria-pressed={formationLayout === layout.id}
              aria-label={t(layout.titleKey)}
              title={t(layout.titleKey)}
            ><layout.Icon /></button>
          ))}
        </div> : null}
        </div> : null}
      </div>
      <div ref={bandRightRef} className="command-band-right">
        {fullscreen.isFullscreen ? <button type="button" className="command-band-button command-band-dock-toggle" onClick={fullscreen.toggleDock} aria-label={t("chrome.commandBand.keepCommandBandVisible")} aria-pressed={fullscreen.isDocked} title={fullscreen.isDocked ? t("chrome.commandBand.stopKeepingCommandBandVisible") : t("chrome.commandBand.keepCommandBandVisible")}>
          <PinIcon />
        </button> : null}
        <ViewModeToggle className="command-band-button command-band-viewmode" />
        <CommandBandSystemCluster />
        {panelTogglesVisible ? <button type="button" className="command-band-button command-band-rail-toggle" onClick={handleRailToggle} aria-label={railToggleLabel} title={railToggleLabel}>
          <PanelToggleIcon side="right" />
        </button> : null}
      </div>
      </header>
    </>
  );
}

interface EnvironmentPopoverProps {
  readonly environment: ConsoleEnvironmentDiagnostics | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly copiedValue: string | null;
  readonly copyFailedValue: string | null;
  readonly desktopShell: boolean;
  readonly onCopy: (value: string) => void;
}

function EnvironmentPopover({ environment, error, loading, copiedValue, copyFailedValue, desktopShell, onCopy }: EnvironmentPopoverProps) {
  const t = useT();
  if (loading) return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>{t("chrome.commandBand.loadingEnvironment")}</div>;
  if (error) return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>{error}</div>;
  if (!environment) return null;
  const rows = buildEnvironmentRows(t, environment, desktopShell);
  return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>
    <div className="command-band-environment-title">{t("chrome.commandBand.environment")}</div>
    {rows.map(([label, value]) => <div key={label} className="command-band-environment-row"><span>{label}</span><code>{value}</code><button type="button" onClick={() => onCopy(value)}>{copiedValue === value ? t("chrome.commandBand.env.copied") : copyFailedValue === value ? t("chrome.commandBand.env.copyFailed") : t("chrome.commandBand.env.copy")}</button></div>)}
    <div className="command-band-environment-footer">{t("chrome.commandBand.env.footer")}</div>
  </div>;
}

function buildEnvironmentRows(
  t: ReturnType<typeof useT>,
  environment: ConsoleEnvironmentDiagnostics,
  desktopShell: boolean,
): readonly [string, string][] {
  return [
    [t("chrome.commandBand.env.channel"), environment.channel],
    [t("chrome.commandBand.env.version"), environment.version],
    [t("chrome.commandBand.env.reachableOn"), `127.0.0.1:${environment.effectivePort}`],
    [t("chrome.commandBand.env.dataRoot"), environment.dataDir],
    [t("chrome.commandBand.env.runtimeLock"), environment.lockFile],
    ...(desktopShell ? [[t("chrome.commandBand.env.desktopData"), `${environment.dataDir}/desktop`] as [string, string]] : []),
  ];
}

function BrandHome() {
  const t = useT();
  return <Link className="command-band-brand" to="/operations" aria-label={t("chrome.commandBand.operations")}><BrandMarkIcon /><span className="command-band-brand-wordmark">Fleet</span></Link>;
}

// 제품 favicon(bearing-scope 마크)의 인라인 축약판 — 브랜드 글리프는 파비콘과 동일 조형을 쓴다.
function BrandMarkIcon() {
  return (
    <svg className="command-band-brand-glyph" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--ink-deep)" stroke="var(--surface-rim-strong)" strokeWidth="2" />
      <circle cx="32" cy="32" r="18.5" fill="none" stroke="var(--brass)" strokeWidth="3.5" />
      <circle cx="32" cy="32" r="10.5" fill="none" stroke="var(--brass)" strokeWidth="1.8" opacity="0.55" />
      <path d="M32 9v8M32 47v8M9 32h8M47 32h8" stroke="var(--brass)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32" r="3" fill="var(--brass)" />
      <circle cx="44.7" cy="19.3" r="5" fill="var(--aurora)" />
    </svg>
  );
}

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}




// War Room 도착 스포트라이트 — 무대를 비추는 광원.
function SpotlightIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.25" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" /></svg>;
}

// 덱 밀도 — 간격이 다른 줄로 성김/빽빽함을 나타낸다.
function DensityIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 7h11M2.5 9.6h11M2.5 12h11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function FormationGridIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function ResetViewIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 7.2A4 4 0 1 1 4 9.2" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.4 4.6v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function FitAllIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// Station Keeping — 패널 둘레의 이격 반경(점선 keep-clear 구역 안의 패널).
function StationKeepingIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.25" /><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2.2" opacity="0.75" /></svg>;
}

function FormationColumnsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 2.5h3v11h-3z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function FormationRowsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v3h-11zM2.5 6.5h11v3h-11zM2.5 10.5h11v3h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}




function PanelToggleIcon({ side }: { readonly side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="10" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d={side === "left" ? "M6.4 3v10" : "M9.6 3v10"} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PinIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5h6M6.2 2.5v3l2.1 2.1v1H7.1V13.5l.9 1M9.8 2.5v3L7.7 7.6v1h1.2V13.5L8 14.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
