import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";

import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { fetchConsoleEnvironment, fetchOperations, renameOperation } from "../api.js";
import { animateViewportTo, fitAllOperations, selectFormationLayout, useCanvasState, useFormationLayout, useFormationView } from "../canvas/canvas-store.js";
import { enterTriage, focusedTriageOperationId, setTriageActive, useTriageActive } from "../canvas/triage-store.js";
import { commandBandActiveOperation, commandBandMenuClampedLeft, commandBandRenameCommitTarget, commandBandSwitcherFocusLeft, commandBandTheaterOperations } from "./command-band-guards.js";
import { CommandBandOperationMenu, CommandBandTheaterMenu, CommandBandTriggerCaret, type CommandBandSwitcherMenu } from "./command-band-switcher.js";
import { FleetBrandHome } from "./side-bar-brand-foot.js";
import { useGlobalSettingsStore } from "../global-settings-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { toggleRailChrome, useRailChromeExpanded } from "../rail/rail-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { setSideBarCollapsed, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { focusOperation, hydrateOperations, requestSideBarAddTheater, requestSideBarTheaterLaunch, setActiveTheater, toggleOperationSearch } from "../store.js";
import type { ConsoleEnvironmentDiagnostics } from "../types.js";
import { useInlineRename } from "../use-inline-rename.js";
import { useT } from "../i18n/index.js";
import { resolveConsoleLanguage } from "../whatsnew-i18n.js";
import { cycleViewModePreference, useViewMode } from "../view-mode-store.js";
import { useFullscreenCommandBand } from "./use-fullscreen-command-band.js";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

interface CommandBandProps {
  readonly operationsViewVisible: boolean;
}

export function CommandBand({ operationsViewVisible: requestedOperationsViewVisible }: CommandBandProps) {
  const t = useT();
  const state = useConsoleState();
  const registry = usePluginRegistry();
  const sideBar = useSideBarState();
  const railChromeExpanded = useRailChromeExpanded();
  const viewMode = useViewMode();
  const operationsViewVisible = requestedOperationsViewVisible && viewMode.effective !== "mobile";
  const viewModeLabel = t(viewMode.preference === "auto"
    ? "chrome.commandBand.viewModeAuto"
    : viewMode.preference === "mobile"
      ? "chrome.commandBand.viewModeMobile"
      : "chrome.commandBand.viewModeDesktop");
  const modLabel = resolveModLabel();
  const sideBarShortcut = `${modLabel}${modLabel === "⌘" ? "" : "+"}B`;
  const railShortcut = `${modLabel}${modLabel === "⌘" ? "⌥" : "+Alt+"}B`;
  const canvas = useCanvasState();
  const formationLayout = useFormationLayout();
  const formationView = useFormationView();
  const triageActive = useTriageActive(state.activeTheaterId);
  const activeTheater = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const activeOperation = commandBandActiveOperation(state.operations, state.activeOperationId, state.activeTheaterId);
  const activePlugin = activeOperation ? registry.plugins.find((plugin) => plugin.id === activeOperation.pluginId) : null;
  const activeCliId = typeof activeOperation?.payload.cliId === "string" ? activeOperation.payload.cliId : null;
  const activeCliLabel = typeof activeOperation?.payload.cliLabel === "string" ? activeOperation.payload.cliLabel : activeCliId;
  const activeKind = activeOperation ? activePlugin?.operationKinds?.find((kind) => kind.type === activeOperation.type) ?? null : null;
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const activeKindTitle = activeKind ? resolveLocalizedText(activeKind.title, language) : null;
  const activeOperationIcon = activeOperation && activePlugin?.renderLaunchIcon ? activePlugin.renderLaunchIcon({ id: activeCliId ?? activeOperation.type, type: activeOperation.type, title: activeKindTitle ?? activeOperation.type }) : null;
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const edgeRevealRef = useRef<HTMLButtonElement>(null);
  const pointerWithinRef = useRef({ edge: false, band: false });
  const renameTargetOperationIdRef = useRef<string | null>(null);
  const theaterTriggerRef = useRef<HTMLButtonElement>(null);
  const operationTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const switcherMenuRef = useRef<HTMLDivElement>(null);
  const [switcherMenu, setSwitcherMenu] = useState<CommandBandSwitcherMenu | null>(null);
  const [switcherMenuLeft, setSwitcherMenuLeft] = useState(0);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<ConsoleEnvironmentDiagnostics | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailedValue, setCopyFailedValue] = useState<string | null>(null);
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
  // 브레드크럼 표시 대상(P0 가드 결과) 기준으로 판정한다 — activeOperationId가 그대로여도
  // Theater 전환으로 Operation 세그먼트가 숨으면 숨은 rename이 살아남아 복귀 시 스테일 draft가 부활한다.
  const displayedOperationId = activeOperation?.id ?? null;
  // 커밋 판정은 ref로 읽는다 — Theater 전환 렌더가 input을 언마운트하며 동기로 blur 커밋을
  // 쏘는데, 이때 클로저의 이전 렌더 state는 여전히 일치해 스테일 draft가 커밋된다(실브라우저 재현).
  const displayedOperationIdRef = useRef<string | null>(null);
  displayedOperationIdRef.current = displayedOperationId;
  const rename = useInlineRename({
    currentTitle: activeOperation?.title ?? "",
    onCommit: (title) => {
      const operationId = commandBandRenameCommitTarget(renameTargetOperationIdRef.current, displayedOperationIdRef.current);
      renameTargetOperationIdRef.current = null;
      if (!operationId) return;
      void renameOperation(operationId, title).then(() => fetchOperations(null)).then(hydrateOperations).catch(() => {});
    },
  });

  useEffect(() => {
    if (!rename.renaming || commandBandRenameCommitTarget(renameTargetOperationIdRef.current, displayedOperationId)) return;
    // 표시 대상이 어긋나면(패널 전환·Theater 전환 포함) 이전 초안을 버려 이름이 넘어가지 않게 한다.
    renameTargetOperationIdRef.current = null;
    rename.cancel();
  }, [rename, displayedOperationId]);

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

  useEffect(() => {
    if (switcherMenu === null) return;
    const triggerRef = switcherMenu === "theater" ? theaterTriggerRef : operationTriggerRef;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || triggerRef.current?.contains(target) || switcherMenuRef.current?.contains(target)) return;
      setSwitcherMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSwitcherMenu(null);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherMenu]);

  // 메뉴 열림 중 사이드바 등 외부 경로로 활성 Theater/Operation이 바뀌면 메뉴를 닫는다.
  // (메뉴 내 선택은 상태 변경 전에 동기적으로 닫으므로 여기서는 no-op이다.)
  useEffect(() => {
    setSwitcherMenu(null);
  }, [state.activeTheaterId, state.activeOperationId]);

  // Operation 메뉴는 자기 트리거 아래 정렬(래퍼 offsetLeft), Theater 메뉴는 좌단 기준 —
  // 어느 쪽이든 좁은 viewport에서 우측이 화면을 넘지 않도록 실측 clamp하고 resize 시 재측정한다.
  useLayoutEffect(() => {
    if (switcherMenu === null) return;
    const measure = () => {
      const wrapper = switcherRef.current;
      const menu = switcherMenuRef.current;
      if (!wrapper || !menu) return;
      const desiredLeft = switcherMenu === "operation" ? operationTriggerRef.current?.offsetLeft ?? 0 : 0;
      setSwitcherMenuLeft(commandBandMenuClampedLeft(desiredLeft, wrapper.getBoundingClientRect().left, menu.getBoundingClientRect().width, window.innerWidth));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [switcherMenu]);

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

  const beginRename = () => {
    if (!activeOperation) return;
    setSwitcherMenu(null);
    renameTargetOperationIdRef.current = activeOperation.id;
    rename.begin();
  };

  const toggleSwitcherMenu = (menu: CommandBandSwitcherMenu) => {
    setEnvironmentOpen(false);
    discardEnvironmentState();
    setSwitcherMenu((open) => (open === menu ? null : menu));
  };

  // Tab 등으로 포커스가 스위처 밖으로 나가면 메뉴를 닫는다 — 포커스는 자연 Tab 대상에 남기고
  // 트리거 복귀는 Escape 전용으로 유지한다.
  const handleSwitcherFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    if (switcherMenu === null || !commandBandSwitcherFocusLeft(event.currentTarget, event.relatedTarget)) return;
    setSwitcherMenu(null);
  };

  const selectTheaterFromMenu = (theaterId: string) => {
    setSwitcherMenu(null);
    theaterTriggerRef.current?.focus();
    if (theaterId !== state.activeTheaterId) setActiveTheater(theaterId);
  };

  const selectOperationFromMenu = (operationId: string) => {
    setSwitcherMenu(null);
    operationTriggerRef.current?.focus();
    focusOperation(operationId);
  };

  const addTheaterFromMenu = () => {
    setSwitcherMenu(null);
    theaterTriggerRef.current?.focus();
    requestSideBarAddTheater();
  };

  const launchOperationFromMenu = () => {
    if (!activeTheater) return;
    setSwitcherMenu(null);
    operationTriggerRef.current?.focus();
    requestSideBarTheaterLaunch(activeTheater.id);
  };

  const theaterOperations = commandBandTheaterOperations(state.operations, state.groups, state.activeTheaterId, canvas.operationOrder);

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
        className={`command-band-edge-reveal${fullscreen.isFullscreen ? " is-fullscreen" : ""}`}
        aria-label={t("chrome.commandBand.showCommandBand")}
        onPointerEnter={handleEdgePointerEnter}
        onPointerLeave={handleEdgePointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
        onKeyDown={(event) => { if (event.key === "Tab") fullscreen.reveal(); }}
      />
      <header
        ref={commandBandRef}
        className={`command-band${requestedOperationsViewVisible ? " is-operations" : " is-utility"}${fullscreen.isFullscreen ? " is-fullscreen" : ""}${fullscreen.isVisible ? " is-revealed" : ""}`}
        style={{ "--command-band-left-width": viewMode.effective === "mobile" ? "min-content" : `${sideBar.width}px` } as CSSProperties}
        aria-hidden={commandBandHidden || undefined}
        inert={commandBandHidden || undefined}
        onPointerEnter={handleBandPointerEnter}
        onPointerLeave={handleBandPointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
      >
      <div className={`command-band-left${requestedOperationsViewVisible && sideBar.collapsed ? " is-collapsed" : ""}`}>
        <FleetBrandHome className="command-band-brand" />
        {state.channel === "local" ? <div className="command-band-environment">
          <button ref={environmentTriggerRef} type="button" className="command-band-local-chip" aria-haspopup="dialog" aria-expanded={environmentOpen} onClick={() => { setSwitcherMenu(null); discardEnvironmentState(); setEnvironmentOpen((open) => !open); }}>
          <span className="command-band-local-dot" aria-hidden="true" />
          <span className="command-band-local-chip-label">{desktopShell ? desktopChipLabel : t("chrome.commandBand.local")}</span>
          </button>
          {environmentOpen ? <div ref={environmentPopoverRef}><EnvironmentPopover environment={environment} error={environmentError} loading={environmentLoading} copiedValue={copiedValue} copyFailedValue={copyFailedValue} desktopShell={desktopShell} onCopy={copyEnvironmentValue} /></div> : null}
        </div> : null}
        {state.connection !== "live" ? (
          <span className="command-band-link-chip" data-link-state={state.connection}>
            {t(state.connection === "offline" ? "chrome.link.offline" : "chrome.link.reconnecting")}
          </span>
        ) : null}
        {operationsViewVisible ? <button type="button" className="command-band-button command-band-sidebar-toggle" onClick={() => setSideBarCollapsed(!sideBar.collapsed)} aria-label={t(sideBar.collapsed ? "chrome.commandBand.expandSidebar" : "chrome.commandBand.collapseSidebar", { shortcut: sideBarShortcut })} title={t(sideBar.collapsed ? "chrome.commandBand.expandSidebar" : "chrome.commandBand.collapseSidebar", { shortcut: sideBarShortcut })}>
          <PanelToggleIcon side="left" />
        </button> : null}
        <button type="button" className="command-band-button command-band-search" onClick={toggleOperationSearch} aria-label={t("chrome.commandBand.searchSessions")} title={t("chrome.commandBand.searchSessionsTitle")}>
          <SearchIcon />
        </button>
      </div>
      {operationsViewVisible ? <div className="command-band-formation-group" role="group" aria-label={t("chrome.commandBand.formationView")}>
        <button type="button" className="command-band-formation-toggle command-band-formation-seg" onClick={() => animateViewportTo({ x: 0, y: 0, zoom: 1 })} disabled={state.activeTheaterId === null} aria-label={t("chrome.commandBand.resetCanvasView")} title={t("chrome.commandBand.resetCanvasView")}><ResetViewIcon /></button>
        <button type="button" className="command-band-formation-toggle command-band-formation-seg" onClick={fitAllOperations} disabled={state.activeTheaterId === null || triageActive} aria-label={t("chrome.commandBand.fitAllPanels")} title={t("chrome.commandBand.fitAllPanels")}><FitAllIcon /></button>
        <span className="command-band-formation-divider" aria-hidden="true" />
        <button type="button" className="command-band-formation-toggle command-band-formation-seg" onClick={() => selectFormationLayout("grid")} disabled={state.activeTheaterId === null} aria-pressed={formationView && formationLayout === "grid"} aria-label={t("chrome.commandBand.formationGrid")} title={t("chrome.commandBand.formationGrid")}><FormationGridIcon /></button>
        <button type="button" className="command-band-formation-toggle command-band-formation-seg" onClick={() => selectFormationLayout("columns")} disabled={state.activeTheaterId === null} aria-pressed={formationView && formationLayout === "columns"} aria-label={t("chrome.commandBand.formationColumns")} title={t("chrome.commandBand.formationColumns")}><FormationColumnsIcon /></button>
        <button type="button" className="command-band-formation-toggle command-band-formation-seg" onClick={() => selectFormationLayout("rows")} disabled={state.activeTheaterId === null} aria-pressed={formationView && formationLayout === "rows"} aria-label={t("chrome.commandBand.formationRows")} title={t("chrome.commandBand.formationRows")}><FormationRowsIcon /></button>
      </div> : null}
      {operationsViewVisible ? <button
        type="button"
        className="command-band-triage-toggle"
        disabled={state.activeTheaterId === null}
        aria-pressed={triageActive}
        aria-label={t("chrome.commandBand.triageToggle")}
        title={t("chrome.commandBand.triageToggle")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (state.activeTheaterId) {
            const activating = !triageActive;
            if (activating) {
              enterTriage(state.activeTheaterId, focusedTriageOperationId(document.activeElement));
            } else {
              setTriageActive(state.activeTheaterId, false);
            }
          }
        }}
      >
        <TriageIcon />
        {triageActive ? <span>{t("chrome.commandBand.triage")}</span> : null}
      </button> : null}
      {viewMode.effective !== "mobile" ? <div className="command-band-center">
        {operationsViewVisible && activeTheater ? <div ref={switcherRef} className="command-band-switcher" onBlur={handleSwitcherFocusOut}>
          <div className="command-band-theater-cluster" aria-label={t("chrome.commandBand.activeTheater", { label: activeTheater.label })}>
            <button
              ref={theaterTriggerRef}
              type="button"
              className={`command-band-theater-segment command-band-segment-trigger${switcherMenu === "theater" ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={switcherMenu === "theater"}
              title={t("chrome.commandBand.switchTheater")}
              onClick={() => toggleSwitcherMenu("theater")}
            >
              <span className="command-band-theater-mark">{theaterInitials(activeTheater.label)}</span>
              <span className="command-band-segment-label">{activeTheater.label}</span>
              <CommandBandTriggerCaret />
            </button>
            <span className="command-band-theater-separator" aria-hidden="true">›</span>
            {activeOperation ? <>
              {rename.renaming ? <input ref={rename.inputRef} className="command-band-rename-input" value={rename.draftTitle} aria-label={t("chrome.commandBand.renameOperationAria", { title: activeOperation.title })} onChange={(event) => rename.setDraftTitle(event.target.value)} onKeyDown={rename.handleKeyDown} onBlur={rename.handleBlur} /> : <button
                ref={operationTriggerRef}
                type="button"
                className={`command-band-operation-name command-band-segment-trigger${switcherMenu === "operation" ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={switcherMenu === "operation"}
                title={t("chrome.commandBand.switchOperationRename")}
                onClick={() => toggleSwitcherMenu("operation")}
                onDoubleClick={beginRename}
              >
                <span className="command-band-segment-label">{activeOperation.title}</span>
                <CommandBandTriggerCaret />
              </button>}
              {activeCliLabel ? <span className="command-band-operation-attribute" title={activeKindTitle ?? activeCliLabel}>{activeOperationIcon ? <span className="command-band-operation-kind" aria-hidden="true">{activeOperationIcon}</span> : null}{activeCliLabel}</span> : null}
            </> : <button
              ref={operationTriggerRef}
              type="button"
              className={`command-band-operation-placeholder command-band-segment-trigger${switcherMenu === "operation" ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={switcherMenu === "operation"}
              title={t("chrome.commandBand.selectOperation")}
              onClick={() => toggleSwitcherMenu("operation")}
            >
              <span className="command-band-segment-label">{t("chrome.commandBand.selectOperationEllipsis")}</span>
              <CommandBandTriggerCaret />
            </button>}
          </div>
          {switcherMenu === "theater" ? <CommandBandTheaterMenu
            theaters={state.theaters}
            operations={state.operations}
            activeTheaterId={state.activeTheaterId}
            addingTheater={state.addingTheater}
            onSelectTheater={selectTheaterFromMenu}
            onAddTheater={addTheaterFromMenu}
            style={{ left: switcherMenuLeft }}
            containerRef={switcherMenuRef}
          /> : null}
          {switcherMenu === "operation" ? <CommandBandOperationMenu
            operations={theaterOperations}
            activeOperationId={activeOperation?.id ?? null}
            theaterLabel={activeTheater.label}
            onSelectOperation={selectOperationFromMenu}
            onRenameOperation={activeOperation ? beginRename : null}
            onNewOperation={launchOperationFromMenu}
            style={{ left: switcherMenuLeft }}
            containerRef={switcherMenuRef}
          /> : null}
        </div> : null}
      </div> : null}
      <div className="command-band-right">
        {fullscreen.isFullscreen ? <button type="button" className="command-band-button command-band-pin" onClick={fullscreen.togglePin} aria-label={t("chrome.commandBand.pinCommandBand")} aria-pressed={fullscreen.isPinned} title={fullscreen.isPinned ? t("chrome.commandBand.unpinCommandBand") : t("chrome.commandBand.pinCommandBand")}>
          <PinIcon />
        </button> : null}
        <button type="button" className="command-band-button command-band-viewmode" onClick={cycleViewModePreference} aria-label={viewModeLabel} aria-pressed={viewMode.preference !== "auto"} title={viewModeLabel}>
          {viewMode.preference === "auto" ? <ViewModeAutoIcon /> : viewMode.preference === "mobile" ? <ViewModeMobileIcon /> : <ViewModeDesktopIcon />}
        </button>
        {operationsViewVisible ? <button type="button" className="command-band-button command-band-rail-toggle" onClick={toggleRailChrome} aria-label={t(railChromeExpanded ? "chrome.commandBand.collapseActivityRail" : "chrome.commandBand.expandActivityRail", { shortcut: railShortcut })} title={t(railChromeExpanded ? "chrome.commandBand.collapseActivityRail" : "chrome.commandBand.expandActivityRail", { shortcut: railShortcut })}>
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

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

function ViewModeAutoIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2.5" width="10" height="7.5" rx="1.4" strokeWidth="1.2" /><path d="M4.5 12.5h4M6.5 10v2.5" strokeWidth="1.2" strokeLinecap="round" /><rect x="9.5" y="6.5" width="4.5" height="7" rx="1" strokeWidth="1.2" /></svg>;
}

function ViewModeMobileIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="4.25" y="1.5" width="7.5" height="13" rx="1.6" strokeWidth="1.3" /><path d="M6.7 3.3h2.6M7.4 12.7h1.2" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function ViewModeDesktopIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2.25" width="13" height="9" rx="1.5" strokeWidth="1.3" /><path d="M5 14h6M8 11.25V14" strokeWidth="1.3" strokeLinecap="round" /></svg>;
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

function FormationColumnsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.5 2.5h3v11h-3z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function FormationRowsIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v3h-11zM2.5 6.5h11v3h-11zM2.5 10.5h11v3h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}

function TriageIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v3H3zM5 8h6v2H5zM7 12h2v2H7z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
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
