import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";

import { fetchConsoleEnvironment, fetchOperations, renameOperation } from "../api.js";
import { useCanvasState } from "../canvas/canvas-store.js";
import { commandBandActiveOperation, commandBandRenameCommitTarget } from "./command-band-guards.js";
import { CommandBandOperationMenu, CommandBandTheaterMenu, CommandBandTriggerCaret, type CommandBandSwitcherMenu } from "./command-band-switcher.js";
import { FleetBrandHome } from "./side-bar-brand-foot.js";
import { useConsoleState } from "../hooks/use-store.js";
import { toggleRailChrome, useRailChromeExpanded } from "../rail/rail-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { setSideBarCollapsed, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { focusOperation, hydrateOperations, requestSideBarAddTheater, requestSideBarTheaterLaunch, setActiveTheater, sortOperationsByOrder, toggleOperationSearch } from "../store.js";
import type { ConsoleEnvironmentDiagnostics } from "../types.js";
import { useInlineRename } from "../use-inline-rename.js";
import { useFullscreenCommandBand } from "./use-fullscreen-command-band.js";

interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: {
    readonly platform?: string;
  };
}

interface CommandBandProps {
  readonly operationsViewVisible: boolean;
}

export function CommandBand({ operationsViewVisible }: CommandBandProps) {
  const state = useConsoleState();
  const registry = usePluginRegistry();
  const sideBar = useSideBarState();
  const railChromeExpanded = useRailChromeExpanded();
  const modLabel = resolveModLabel();
  const sideBarShortcut = `${modLabel}${modLabel === "⌘" ? "" : "+"}B`;
  const railShortcut = `${modLabel}${modLabel === "⌘" ? "⌥" : "+Alt+"}B`;
  const canvas = useCanvasState();
  const activeTheater = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const activeOperation = commandBandActiveOperation(state.operations, state.activeOperationId, state.activeTheaterId);
  const activePlugin = activeOperation ? registry.plugins.find((plugin) => plugin.id === activeOperation.pluginId) : null;
  const activeCliId = typeof activeOperation?.payload.cliId === "string" ? activeOperation.payload.cliId : null;
  const activeCliLabel = typeof activeOperation?.payload.cliLabel === "string" ? activeOperation.payload.cliLabel : activeCliId;
  const activeKind = activeOperation ? activePlugin?.operationKinds?.find((kind) => kind.type === activeOperation.type) ?? null : null;
  const activeOperationIcon = activeOperation && activePlugin?.renderLaunchIcon ? activePlugin.renderLaunchIcon({ id: activeCliId ?? activeOperation.type, type: activeOperation.type, title: activeKind?.title ?? activeOperation.type }) : null;
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const edgeRevealRef = useRef<HTMLButtonElement>(null);
  const pointerWithinRef = useRef({ edge: false, band: false });
  const renameTargetOperationIdRef = useRef<string | null>(null);
  const theaterTriggerRef = useRef<HTMLButtonElement>(null);
  const operationTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherMenuRef = useRef<HTMLDivElement>(null);
  const [switcherMenu, setSwitcherMenu] = useState<CommandBandSwitcherMenu | null>(null);
  const [operationMenuLeft, setOperationMenuLeft] = useState(0);
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
  const desktopChipLabel = typeof document !== "undefined" && document.documentElement.dataset.desktopPlatform === "darwin" ? "Local" : "Local · Desktop";
  const canAutoHide = useCallback(() => {
    const activeElement = document.activeElement;
    const focusWithin = activeElement instanceof Node && (commandBandRef.current?.contains(activeElement) || edgeRevealRef.current?.contains(activeElement));
    return !focusWithin && !pointerWithinRef.current.edge && !pointerWithinRef.current.band;
  }, []);
  const fullscreen = useFullscreenCommandBand(canAutoHide);
  const rename = useInlineRename({
    currentTitle: activeOperation?.title ?? "",
    onCommit: (title) => {
      const operationId = commandBandRenameCommitTarget(renameTargetOperationIdRef.current, state.activeOperationId);
      renameTargetOperationIdRef.current = null;
      if (!operationId) return;
      void renameOperation(operationId, title).then(() => fetchOperations(null)).then(hydrateOperations).catch(() => {});
    },
  });

  useEffect(() => {
    if (!rename.renaming || commandBandRenameCommitTarget(renameTargetOperationIdRef.current, state.activeOperationId)) return;
    // 활성 패널이 바뀌면 이전 초안을 버려 다른 Operation으로 이름이 넘어가지 않게 한다.
    renameTargetOperationIdRef.current = null;
    rename.cancel();
  }, [rename, state.activeOperationId]);

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
        setEnvironmentError(error instanceof Error ? error.message : "Unable to load environment details.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setEnvironmentLoading(false);
      });
    return () => controller.abort();
  }, [environmentOpen]);

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

  // Operation 메뉴는 자기 트리거 아래 정렬 — 스위처 래퍼(offsetParent) 기준 좌표를 열림 시점에 실측한다.
  useLayoutEffect(() => {
    if (switcherMenu !== "operation") return;
    setOperationMenuLeft(operationTriggerRef.current?.offsetLeft ?? 0);
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

  const theaterOperations = sortOperationsByOrder(
    state.operations.filter((operation) => operation.theaterId === state.activeTheaterId),
    canvas.operationOrder,
  );

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
        aria-label="Show command band"
        onPointerEnter={handleEdgePointerEnter}
        onPointerLeave={handleEdgePointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
        onKeyDown={(event) => { if (event.key === "Tab") fullscreen.reveal(); }}
      />
      <header
        ref={commandBandRef}
        className={`command-band${operationsViewVisible ? " is-operations" : " is-utility"}${fullscreen.isFullscreen ? " is-fullscreen" : ""}${fullscreen.isVisible ? " is-revealed" : ""}`}
        style={{ "--command-band-left-width": `${sideBar.width}px` } as CSSProperties}
        aria-hidden={commandBandHidden || undefined}
        inert={commandBandHidden || undefined}
        onPointerEnter={handleBandPointerEnter}
        onPointerLeave={handleBandPointerLeave}
        onFocus={fullscreen.reveal}
        onBlur={handleInteractionBlur}
      >
      <div className={`command-band-left${operationsViewVisible && sideBar.collapsed ? " is-collapsed" : ""}`}>
        <FleetBrandHome className="command-band-brand" />
        {state.channel === "local" ? <div className="command-band-environment">
          <button ref={environmentTriggerRef} type="button" className="command-band-local-chip" aria-haspopup="dialog" aria-expanded={environmentOpen} onClick={() => { setSwitcherMenu(null); discardEnvironmentState(); setEnvironmentOpen((open) => !open); }}>
          <span className="command-band-local-dot" aria-hidden="true" />
          <span className="command-band-local-chip-label">{desktopShell ? desktopChipLabel : "Local"}</span>
          </button>
          {environmentOpen ? <div ref={environmentPopoverRef}><EnvironmentPopover environment={environment} error={environmentError} loading={environmentLoading} copiedValue={copiedValue} copyFailedValue={copyFailedValue} desktopShell={desktopShell} onCopy={copyEnvironmentValue} /></div> : null}
        </div> : null}
        {operationsViewVisible ? <button type="button" className="command-band-button command-band-sidebar-toggle" onClick={() => setSideBarCollapsed(!sideBar.collapsed)} aria-label={`${sideBar.collapsed ? "Expand sidebar" : "Collapse sidebar"} (${sideBarShortcut})`} title={`${sideBar.collapsed ? "Expand sidebar" : "Collapse sidebar"} (${sideBarShortcut})`}>
          <PanelToggleIcon side="left" />
        </button> : null}
        <button type="button" className="command-band-button command-band-search" onClick={toggleOperationSearch} aria-label="Search sessions" title="Search sessions (⌘K)">
          <SearchIcon />
        </button>
      </div>
      <div className="command-band-center">
        {operationsViewVisible && activeTheater ? <div className="command-band-switcher">
          <div className="command-band-theater-cluster" aria-label={`Active Theater: ${activeTheater.label}`}>
            <button
              ref={theaterTriggerRef}
              type="button"
              className={`command-band-theater-segment command-band-segment-trigger${switcherMenu === "theater" ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={switcherMenu === "theater"}
              title="Switch Theater"
              onClick={() => toggleSwitcherMenu("theater")}
            >
              <span className="command-band-theater-mark">{theaterInitials(activeTheater.label)}</span>
              <span className="command-band-segment-label">{activeTheater.label}</span>
              <CommandBandTriggerCaret />
            </button>
            <span className="command-band-theater-separator" aria-hidden="true">›</span>
            {activeOperation ? <>
              {rename.renaming ? <input ref={rename.inputRef} className="command-band-rename-input" value={rename.draftTitle} aria-label={`${activeOperation.title} 이름 변경`} onChange={(event) => rename.setDraftTitle(event.target.value)} onKeyDown={rename.handleKeyDown} onBlur={rename.handleBlur} /> : <button
                ref={operationTriggerRef}
                type="button"
                className={`command-band-operation-name command-band-segment-trigger${switcherMenu === "operation" ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={switcherMenu === "operation"}
                title="Switch operation — double-click to rename"
                onClick={() => toggleSwitcherMenu("operation")}
                onDoubleClick={beginRename}
              >
                <span className="command-band-segment-label">{activeOperation.title}</span>
                <CommandBandTriggerCaret />
              </button>}
              {activeCliLabel ? <span className="command-band-operation-attribute" title={activeKind?.title ?? activeCliLabel}>{activeOperationIcon ? <span className="command-band-operation-kind" aria-hidden="true">{activeOperationIcon}</span> : null}{activeCliLabel}</span> : null}
            </> : <button
              ref={operationTriggerRef}
              type="button"
              className={`command-band-operation-placeholder command-band-segment-trigger${switcherMenu === "operation" ? " is-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={switcherMenu === "operation"}
              title="Select operation"
              onClick={() => toggleSwitcherMenu("operation")}
            >
              <span className="command-band-segment-label">Select operation…</span>
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
            containerRef={switcherMenuRef}
          /> : null}
          {switcherMenu === "operation" ? <CommandBandOperationMenu
            operations={theaterOperations}
            activeOperationId={activeOperation?.id ?? null}
            theaterLabel={activeTheater.label}
            onSelectOperation={selectOperationFromMenu}
            onRenameOperation={activeOperation ? beginRename : null}
            onNewOperation={launchOperationFromMenu}
            style={{ left: operationMenuLeft }}
            containerRef={switcherMenuRef}
          /> : null}
        </div> : null}
      </div>
      <div className="command-band-right">
        {fullscreen.isFullscreen ? <button type="button" className="command-band-button command-band-pin" onClick={fullscreen.togglePin} aria-label="Pin command band" aria-pressed={fullscreen.isPinned} title={fullscreen.isPinned ? "Unpin command band" : "Pin command band"}>
          <PinIcon />
        </button> : null}
        {operationsViewVisible ? <button type="button" className="command-band-button command-band-rail-toggle" onClick={toggleRailChrome} aria-label={`${railChromeExpanded ? "Collapse Activity Rail" : "Expand Activity Rail"} (${railShortcut})`} title={`${railChromeExpanded ? "Collapse Activity Rail" : "Expand Activity Rail"} (${railShortcut})`}>
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
  if (loading) return <div className="command-band-environment-popover" role="dialog" aria-label="Environment">Loading environment details…</div>;
  if (error) return <div className="command-band-environment-popover" role="dialog" aria-label="Environment">{error}</div>;
  if (!environment) return null;
  const rows: readonly [string, string][] = [
    ["Channel", environment.channel],
    ["Version", environment.version],
    ["Reachable on", `127.0.0.1:${environment.effectivePort}`],
    ["Data root", environment.dataDir],
    ["Runtime lock", environment.lockFile],
    ...(desktopShell ? [["Desktop data", `${environment.dataDir}/desktop`] as [string, string]] : []),
  ];
  return <div className="command-band-environment-popover" role="dialog" aria-label="Environment">
    <div className="command-band-environment-title">Environment</div>
    {rows.map(([label, value]) => <div key={label} className="command-band-environment-row"><span>{label}</span><code>{value}</code><button type="button" onClick={() => onCopy(value)}>{copiedValue === value ? "Copied" : copyFailedValue === value ? "Copy failed" : "Copy"}</button></div>)}
    <div className="command-band-environment-footer">Development and published channels keep separate data roots.</div>
  </div>;
}

function resolveModLabel(): string {
  const userAgentDataPlatform = (navigator as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.4 10.4 13.5 13.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
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
