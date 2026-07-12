import { useEffect, useRef, useState, type CSSProperties } from "react";

import { fetchOperations, renameOperation } from "../api.js";
import { commandBandRenameCommitTarget, railPathContextDeckOpenAfterCommandBandToggle, shouldCloseCommandBandContextDeck } from "./command-band-guards.js";
import { FleetBrandHome } from "./side-bar-brand-foot.js";
import { useConsoleState } from "../hooks/use-store.js";
import { putRailPathContext } from "../rail/path-context-api.js";
import { PathContextDeck } from "../rail/path-context-deck.js";
import { mutateRailPathContext, setRailPathContextDeckOpen, toggleRailChrome, useRailChromeExpanded, useRailPathContextStore } from "../rail/rail-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { setSideBarCollapsed, useSideBarState } from "../sidebar/operations-side-bar-store.js";
import { hydrateOperations, toggleOperationSearch } from "../store.js";
import { useInlineRename } from "../use-inline-rename.js";

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
  const renameTargetOperationIdRef = useRef<string | null>(null);
  const [contextDeckOpen, setContextDeckOpen] = useState(false);
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
    if (shouldCloseCommandBandContextDeck(contextDeckOpen, pathContext.isPathContextDeckOpen)) setContextDeckOpen(false);
  }, [contextDeckOpen, pathContext.isPathContextDeckOpen]);

  const closeContextDeck = () => {
    setContextDeckOpen(false);
    contextTriggerRef.current?.focus();
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

  return (
    <header className={`command-band${operationsViewVisible ? " is-operations" : " is-utility"}`} style={{ "--command-band-left-width": `${sideBar.width}px` } as CSSProperties}>
      <div className={`command-band-left${operationsViewVisible && sideBar.collapsed ? " is-collapsed" : ""}`}>
        <FleetBrandHome className="command-band-brand" />
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
        {operationsViewVisible ? <button type="button" className="command-band-button command-band-rail-toggle" onClick={toggleRailChrome} aria-label={`${railChromeExpanded ? "Collapse Activity Rail" : "Expand Activity Rail"} (${railShortcut})`} title={`${railChromeExpanded ? "Collapse Activity Rail" : "Expand Activity Rail"} (${railShortcut})`}>
          <PanelToggleIcon side="right" />
        </button> : null}
      </div>
    </header>
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

function PanelToggleIcon({ side }: { readonly side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="10" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d={side === "left" ? "M6.4 3v10" : "M9.6 3v10"} stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PathContextIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.7h4.5a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
}
