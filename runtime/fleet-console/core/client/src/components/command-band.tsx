import { useCallback, useEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";

import { fetchConsoleEnvironment, fetchOperations, renameOperation } from "../api.js";
import { commandBandRenameCommitTarget, railPathContextDeckOpenAfterCommandBandToggle, shouldCloseCommandBandContextDeck } from "./command-band-guards.js";
import { FleetBrandHome } from "./side-bar-brand-foot.js";
import { useConsoleState } from "../hooks/use-store.js";
import { putRailPathContext } from "../rail/path-context-api.js";
import { PathContextDeck } from "../rail/path-context-deck.js";
import { mutateRailPathContext, setRailPathContextDeckOpen, toggleRailChrome, useRailChromeExpanded, useRailPathContextStore, useRightRailWidth } from "../rail/rail-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { setSideBarCollapsed, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { hydrateOperations, toggleOperationSearch } from "../store.js";
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
  const rightRailWidth = useRightRailWidth();
  const modLabel = resolveModLabel();
  const sideBarShortcut = `${modLabel}${modLabel === "⌘" ? "" : "+"}B`;
  const railShortcut = `${modLabel}${modLabel === "⌘" ? "⌥" : "+Alt+"}B`;
  const activeTheater = state.theaters.find((theater) => theater.id === state.activeTheaterId) ?? null;
  const activeOperation = state.operations.find((operation) => operation.id === state.activeOperationId) ?? null;
  const activePlugin = activeOperation ? registry.plugins.find((plugin) => plugin.id === activeOperation.pluginId) : null;
  const activeCliId = typeof activeOperation?.payload.cliId === "string" ? activeOperation.payload.cliId : null;
  const activeCliLabel = typeof activeOperation?.payload.cliLabel === "string" ? activeOperation.payload.cliLabel : activeCliId;
  const activeKind = activeOperation ? activePlugin?.operationKinds?.find((kind) => kind.type === activeOperation.type) ?? null : null;
  const activeOperationIcon = activeOperation && activePlugin?.renderLaunchIcon ? activePlugin.renderLaunchIcon({ id: activeCliId ?? activeOperation.type, type: activeOperation.type, title: activeKind?.title ?? activeOperation.type }) : null;
  const pathContext = useRailPathContextStore();
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const contextDeckRef = useRef<HTMLDivElement>(null);
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const edgeRevealRef = useRef<HTMLButtonElement>(null);
  const pointerWithinRef = useRef({ edge: false, band: false });
  const renameTargetOperationIdRef = useRef<string | null>(null);
  const [contextDeckOpen, setContextDeckOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<ConsoleEnvironmentDiagnostics | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const desktopShell = typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
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
    if (!contextDeckOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || contextTriggerRef.current?.contains(target) || contextDeckRef.current?.contains(target)) return;
      setContextDeckOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    return () => document.removeEventListener("pointerdown", closeOnPointer);
  }, [contextDeckOpen]);

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
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setEnvironmentOpen(false);
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
    if (state.channel === "local") return;
    setEnvironmentOpen(false);
    setEnvironment(null);
    setEnvironmentError(null);
    setCopiedValue(null);
  }, [state.channel]);

  useEffect(() => {
    if (shouldCloseCommandBandContextDeck(contextDeckOpen, pathContext.isPathContextDeckOpen)) setContextDeckOpen(false);
  }, [contextDeckOpen, pathContext.isPathContextDeckOpen]);

  const closeContextDeck = () => {
    setContextDeckOpen(false);
    contextTriggerRef.current?.focus();
  };

  const copyEnvironmentValue = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => setCopiedValue(value)).catch(() => setEnvironmentError("Unable to copy value."));
  };

  // 밴드 데크는 로컬 상태만 사용한다 — 공유 open 플래그를 세우면 path-aware 레일 패널의
  // 데크가 같은 플래그로 함께 열리므로, 밴드를 열 때는 레일 쪽 데크를 닫아 상호 배타를 유지한다.
  const toggleContextDeck = () => {
    const next = !contextDeckOpen;
    setContextDeckOpen(next);
    setRailPathContextDeckOpen(railPathContextDeckOpenAfterCommandBandToggle(next, pathContext.isPathContextDeckOpen));
  };

  const selectPathContext = (relPath: string | null) => {
    if (!activeTheater) return;
    void mutateRailPathContext(activeTheater.id, (signal) => putRailPathContext(activeTheater.id, relPath, signal));
  };

  const beginRename = () => {
    if (!activeOperation) return;
    renameTargetOperationIdRef.current = activeOperation.id;
    rename.begin();
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
        style={{ "--command-band-left-width": `${sideBar.width}px`, "--command-band-right-width": `${rightRailWidth}px` } as CSSProperties}
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
          <button ref={environmentTriggerRef} type="button" className="command-band-local-chip" aria-haspopup="dialog" aria-expanded={environmentOpen} onClick={() => setEnvironmentOpen((open) => !open)}>
          <span className="command-band-local-dot" aria-hidden="true" />
          {desktopShell ? "Local · Desktop" : "Local"}
          </button>
          {environmentOpen ? <div ref={environmentPopoverRef}><EnvironmentPopover environment={environment} error={environmentError} loading={environmentLoading} copiedValue={copiedValue} desktopShell={desktopShell} onCopy={copyEnvironmentValue} /></div> : null}
        </div> : null}
        {operationsViewVisible ? <button type="button" className="command-band-button command-band-sidebar-toggle" onClick={() => setSideBarCollapsed(!sideBar.collapsed)} aria-label={`${sideBar.collapsed ? "Expand sidebar" : "Collapse sidebar"} (${sideBarShortcut})`} title={`${sideBar.collapsed ? "Expand sidebar" : "Collapse sidebar"} (${sideBarShortcut})`}>
          <PanelToggleIcon side="left" />
        </button> : null}
        <button type="button" className="command-band-button command-band-search" onClick={toggleOperationSearch} aria-label="Search sessions" title="Search sessions (⌘K)">
          <SearchIcon />
        </button>
      </div>
      <div className="command-band-center">
        {operationsViewVisible && activeTheater ? <div className="command-band-theater-cluster" aria-label={`Active Theater: ${activeTheater.label}`}>
          <span className="command-band-theater-segment"><span className="command-band-theater-mark">{theaterInitials(activeTheater.label)}</span>{activeTheater.label}</span>
          {activeOperation ? <>
            <span className="command-band-theater-separator" aria-hidden="true">›</span>
            {rename.renaming ? <input ref={rename.inputRef} className="command-band-rename-input" value={rename.draftTitle} aria-label={`${activeOperation.title} 이름 변경`} onChange={(event) => rename.setDraftTitle(event.target.value)} onKeyDown={rename.handleKeyDown} onBlur={rename.handleBlur} /> : <button type="button" className="command-band-operation-name" onDoubleClick={beginRename} title="Double-click to rename">{activeOperation.title}</button>}
            {activeCliLabel ? <span className="command-band-operation-attribute" title={activeKind?.title ?? activeCliLabel}>{activeOperationIcon ? <span className="command-band-operation-kind" aria-hidden="true">{activeOperationIcon}</span> : null}{activeCliLabel}</span> : null}
          </> : null}
        </div> : null}
        {operationsViewVisible && activeTheater && pathContext.pathContextHydrated && pathContext.pathContext ? <><span className="command-band-context-separator" aria-hidden="true" /><div className="command-band-context">
          <button ref={contextTriggerRef} type="button" className="command-band-context-trigger" onClick={toggleContextDeck} aria-expanded={contextDeckOpen} aria-haspopup="dialog" title={pathContext.pathContextError ?? "Path context — shared with the Activity Rail"}><PathContextIcon />{pathContext.pathContext.label}<span aria-hidden="true">⌄</span></button>
          {contextDeckOpen ? <PathContextDeck ref={contextDeckRef} className="command-band-context-deck" theaterId={activeTheater.id} theaterLabel={activeTheater.label} context={pathContext.pathContext} isMutating={pathContext.pathContextMutationInProgress} onSelect={selectPathContext} onClose={closeContextDeck} /> : null}
        </div></> : null}
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
  readonly desktopShell: boolean;
  readonly onCopy: (value: string) => void;
}

function EnvironmentPopover({ environment, error, loading, copiedValue, desktopShell, onCopy }: EnvironmentPopoverProps) {
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
    {rows.map(([label, value]) => <div key={label} className="command-band-environment-row"><span>{label}</span><code>{value}</code><button type="button" onClick={() => onCopy(value)}>{copiedValue === value ? "Copied" : "Copy"}</button></div>)}
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

function PathContextIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.7h4.5a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}
