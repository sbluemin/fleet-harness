import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";

import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail.css";
import { BUILT_IN_RAIL_PANELS } from "./built-in-panels.js";
import { focusCommandBandToggleWhenPanelContainsActiveElement } from "../components/command-band-focus.js";
import { getState, subscribe } from "../store.js";
import { closeRailPanel, requestRailPanelExtraWidth, toggleRailPanel, useActiveRailPanelId, useRailChromeExpanded, useRailPanelExtraWidth } from "./rail-store.js";
import { useRailPanels } from "./rail-registry.js";
import { useCodexSplitExtraWidth } from "./use-codex-split-extra-width.js";

interface RightRailProps {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
}

const MIN_PANEL_WIDTH = 240;
const DEFAULT_PANEL_WIDTH = 312;
const PREFS_PANEL_WIDTH = "fleet-console.rail.panelWidth";
const FALLBACK_THEATER_LABEL = "Theater";

function readStoredPanelWidth(): number {
  try {
    const v = localStorage.getItem(PREFS_PANEL_WIDTH);
    if (v !== null) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= MIN_PANEL_WIDTH) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_PANEL_WIDTH;
}

export function RightRail({ theaterId, api }: RightRailProps) {
  const theaterLabel = useSyncExternalStore(
    subscribe,
    () => getState().theaters.find((theater) => theater.id === theaterId)?.label ?? FALLBACK_THEATER_LABEL,
    () => FALLBACK_THEATER_LABEL,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const activeId = useActiveRailPanelId();
  const railChromeExpanded = useRailChromeExpanded();
  const previousRailChromeExpandedRef = useRef(railChromeExpanded);
  const pluginPanels = useRailPanels();
  const builtInPanels = BUILT_IN_RAIL_PANELS;
  const allPanels = [...builtInPanels, ...pluginPanels];
  const activePanel = allPanels.find((p) => p.id === activeId) ?? null;
  const hasPanel = activePanel !== null;
  const extraWidth = useCodexSplitExtraWidth(activeId) + (activePanel?.preferredExtraWidth ?? 0) + useRailPanelExtraWidth();
  const extraWidthRef = useRef(extraWidth);
  extraWidthRef.current = extraWidth;

  const [panelWidth, setPanelWidthState] = useState(readStoredPanelWidth);
  const panelWidthRef = useRef(panelWidth);
  const [isDragging, setIsDragging] = useState(false);

  useLayoutEffect(() => {
    if (previousRailChromeExpandedRef.current && !railChromeExpanded) focusCommandBandToggleWhenPanelContainsActiveElement(rootRef.current, ".command-band-rail-toggle");
    previousRailChromeExpandedRef.current = railChromeExpanded;
  }, [railChromeExpanded]);

  const handleResizeDragStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX;
      const maxWidth = window.innerWidth - 148 - extraWidthRef.current;
      const next = Math.max(MIN_PANEL_WIDTH, Math.min(maxWidth, startWidth + dx));
      panelWidthRef.current = next;
      setPanelWidthState(next);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      try { localStorage.setItem(PREFS_PANEL_WIDTH, String(panelWidthRef.current)); } catch { /* ignore */ }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const ctx: RailPanelContext = useMemo(() => ({
    theaterId,
    pathContext: { kind: "root", relPath: null, label: theaterLabel },
    api,
    requestExtraWidth: (px: number | null) => {
      if (activeId !== null) requestRailPanelExtraWidth(activeId, px);
    },
  }), [theaterId, theaterLabel, api, activeId]);

  return (
    <div
      ref={rootRef}
      className={`right-rail${hasPanel ? " is-open" : ""}${railChromeExpanded ? " is-expanded" : " is-closed"}${isDragging ? " is-dragging" : ""}`}
      data-rail-chrome={railChromeExpanded ? "expanded" : "closed"}
      role="complementary"
      aria-label="Activity Rail"
      inert={!railChromeExpanded}
      style={{ "--right-rail-panel-width": `${hasPanel ? panelWidth + extraWidth : 0}px` } as CSSProperties}
    >
      <div
        className="right-rail-panel-slot"
        style={hasPanel ? { width: panelWidth + extraWidth } : undefined}
      >
        {hasPanel && (
          <div
            className="right-rail-resize-handle"
            onPointerDown={handleResizeDragStart}
            aria-hidden="true"
          />
        )}
        {activePanel && (
          <RailPanelContent activePanel={activePanel} activeId={activeId} ctx={ctx} />
        )}
      </div>
      <nav className="right-rail-icons" aria-label="Activity tools">
        <div className="right-rail-tabs" role="tablist" aria-label="Activity panels">
          {builtInPanels.map((panel) => (
            <RailIcon key={panel.id} panel={panel} isActive={activeId === panel.id} />
          ))}
          {builtInPanels.length > 0 && pluginPanels.length > 0 ? (
            <div className="right-rail-divider" role="separator" aria-hidden="true" />
          ) : null}
          {pluginPanels.map((panel) => (
            <RailIcon key={panel.id} panel={panel} isActive={activeId === panel.id} />
          ))}
        </div>
      </nav>
    </div>
  );
}

interface RailPanelContentProps {
  readonly activePanel: RailPanelDescriptor;
  readonly activeId: string | null;
  readonly ctx: RailPanelContext;
}

// 패널 본문은 무거운 플러그인 콘텐츠(파일 트리·diff·Codex)를 렌더한다. 리사이즈 드래그가
// 매 프레임 RightRail을 재렌더해도 이 본문이 함께 재렌더되면 끊김이 생기므로, 폭과 무관한
// (activePanel·ctx·activeId) props로 memo해 드래그 중 본문 재렌더를 건너뛴다(좌측 SideBar처럼 가벼운 부분만 재렌더).
const RailPanelContent = memo(function RailPanelContent({ activePanel, activeId, ctx }: RailPanelContentProps) {
  return (
    <>
      <div className="right-rail-panel-head">
        <span className="right-rail-panel-title">{activePanel.title}</span>
        <button
          className="right-rail-close-btn"
          type="button"
          aria-label={`Close ${activePanel.title}`}
          onClick={closeRailPanel}
        >
          ✕
        </button>
      </div>
      <div className="right-rail-panel-body" role="tabpanel" aria-labelledby={`rail-tab-${activeId}`}>
        {activePanel.render(ctx)}
      </div>
    </>
  );
});

interface RailIconProps {
  readonly panel: RailPanelDescriptor;
  readonly isActive: boolean;
}

function RailIcon({ panel, isActive }: RailIconProps) {
  const handleClick = useCallback(() => toggleRailPanel(panel.id), [panel.id]);
  const icon = typeof panel.icon === "function" ? panel.icon() : panel.icon;

  return (
    <button
      id={`rail-tab-${panel.id}`}
      className={`right-rail-ico${isActive ? " is-active" : ""}`}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={panel.title}
      title={panel.title}
      onClick={handleClick}
    >
      {icon}
    </button>
  );
}

/* 패널 접기 아이콘 — 우측 영역을 선으로 구분한 패널 모양(#44 시안, 우측 미러). */
