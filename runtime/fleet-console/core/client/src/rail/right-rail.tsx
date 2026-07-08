import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";

import type { ClientApiCapability } from "@fleet-console/sdk/plugin";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail.css";
import { BUILT_IN_RAIL_PANELS } from "./built-in-panels.js";
import { closeRailPanel, requestRailPanelExtraWidth, toggleRailPanel, useActiveRailPanelId, useRailPanelExtraWidth } from "./rail-store.js";
import { useRailPanels } from "./rail-registry.js";
import { useCodexSplitExtraWidth } from "./use-codex-split-extra-width.js";

interface RightRailProps {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
}

const MIN_PANEL_WIDTH = 240;
const DEFAULT_PANEL_WIDTH = 312;
const PREFS_PANEL_WIDTH = "fleet-console.rail.panelWidth";

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
  const activeId = useActiveRailPanelId();
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
    api,
    requestExtraWidth: (px: number | null) => {
      if (activeId !== null) requestRailPanelExtraWidth(activeId, px);
    },
  }), [theaterId, api, activeId]);

  return (
    <div
      className={`right-rail${hasPanel ? " is-open" : ""}${isDragging ? " is-dragging" : ""}`}
      role="complementary"
      aria-label="Activity Rail"
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
      <nav className="right-rail-icons" role="tablist" aria-label="Activity tools">
        {builtInPanels.map((panel) => (
          <RailIcon key={panel.id} panel={panel} isActive={activeId === panel.id} />
        ))}
        {builtInPanels.length > 0 && pluginPanels.length > 0 ? (
          <div className="right-rail-divider" role="separator" aria-hidden="true" />
        ) : null}
        {pluginPanels.map((panel) => (
          <RailIcon key={panel.id} panel={panel} isActive={activeId === panel.id} />
        ))}
        <div className="right-rail-route-spacer" aria-hidden="true" />
        <div className="right-rail-divider right-rail-route-divider" role="separator" aria-hidden="true" />
        <div className="right-rail-route-nav" aria-label="Console routes">
          <RouteNavIcon to="/carrier-settings" label="Carriers" icon={<CarriersIcon />} />
          <RouteNavIcon to="/settings" label="Settings" icon={<SettingsIcon />} />
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

interface RouteNavIconProps {
  readonly to: string;
  readonly label: string;
  readonly icon: ReactNode;
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

function RouteNavIcon({ to, label, icon }: RouteNavIconProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `right-rail-route-link${isActive ? " is-active" : ""}`}
      aria-label={label}
      title={label}
    >
      {icon}
    </NavLink>
  );
}

function CarriersIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="4.2" r="1.15" fill="currentColor" />
      <circle cx="4" cy="8" r="1.15" fill="currentColor" />
      <circle cx="4" cy="11.8" r="1.15" fill="currentColor" />
      <path d="M7.2 4.2h6M7.2 8h6M7.2 11.8h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.4h10M3 8h10M3 11.6h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6.2" cy="4.4" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="8" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="7.4" cy="11.6" r="1.3" fill="var(--surface-glass-strong)" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
