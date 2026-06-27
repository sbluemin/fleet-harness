import { useCallback, useMemo, useRef, useState } from "react";

import type { RailDiffHunkResult, RailDiffListResult, RailFileReadResult, RailFolderListResult, RailHostCapabilities, RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail.css";
import { closeRailPanel, toggleRailPanel, useActiveRailPanelId } from "./rail-store.js";
import { useRailPanels } from "./rail-registry.js";

interface RightRailProps {
  readonly theaterId: string | null;
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

export function RightRail({ theaterId }: RightRailProps) {
  const activeId = useActiveRailPanelId();
  const panels = useRailPanels();
  const activePanel = panels.find((p) => p.id === activeId) ?? null;
  const hasPanel = activePanel !== null;

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
      const maxWidth = window.innerWidth - 148;
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

  const host = useHostCapabilities(theaterId);
  const ctx: RailPanelContext = useMemo(() => ({ theaterId, host }), [theaterId, host]);

  return (
    <div
      className={`right-rail${hasPanel ? " is-open" : ""}${isDragging ? " is-dragging" : ""}`}
      role="complementary"
      aria-label="Activity Rail"
    >
      <div
        className="right-rail-panel-slot"
        style={hasPanel ? { width: panelWidth } : undefined}
      >
        {hasPanel && (
          <div
            className="right-rail-resize-handle"
            onPointerDown={handleResizeDragStart}
            aria-hidden="true"
          />
        )}
        {activePanel && (
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
            <div
              className="right-rail-panel-body"
              role="tabpanel"
              aria-labelledby={`rail-tab-${activeId}`}
            >
              {activePanel.render(ctx)}
            </div>
          </>
        )}
      </div>
      <nav className="right-rail-icons" role="tablist" aria-label="Activity tools">
        {panels.map((panel) => (
          <RailIcon key={panel.id} panel={panel} isActive={activeId === panel.id} />
        ))}
      </nav>
    </div>
  );
}

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

function useHostCapabilities(theaterId: string | null): RailHostCapabilities {
  return useMemo<RailHostCapabilities>(() => ({
    files: {
      listFolder: async (relativePath?: string): Promise<RailFolderListResult> => {
        if (!theaterId) throw new Error("no_theater");
        const res = await fetch(`/theaters/${encodeURIComponent(theaterId)}/files/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ relativePath: relativePath ?? "" }),
        });
        if (!res.ok) {
          const payload = await res.json() as { error?: string };
          throw new Error(payload.error ?? "list_failed");
        }
        return res.json() as Promise<RailFolderListResult>;
      },
      readFile: async (relativePath: string): Promise<RailFileReadResult> => {
        if (!theaterId) throw new Error("no_theater");
        const res = await fetch(`/theaters/${encodeURIComponent(theaterId)}/files/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ relativePath }),
        });
        if (!res.ok) {
          const payload = await res.json() as { error?: string };
          throw new Error(payload.error ?? "read_failed");
        }
        return res.json() as Promise<RailFileReadResult>;
      },
      imageUrl: (relativePath: string): string => {
        if (!theaterId) return "";
        return `/theaters/${encodeURIComponent(theaterId)}/files/image?path=${encodeURIComponent(relativePath)}`;
      },
    },
    diff: {
      listChangedFiles: async (mode, ref?) => {
        if (!theaterId) throw new Error("no_theater");
        const res = await fetch(`/theaters/${encodeURIComponent(theaterId)}/diff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, ref }),
        });
        if (!res.ok) {
          const payload = await res.json() as { error?: string };
          throw new Error(payload.error ?? "diff_failed");
        }
        return res.json() as Promise<RailDiffListResult>;
      },
      unifiedDiff: async (filePath, mode, ref?) => {
        if (!theaterId) throw new Error("no_theater");
        const res = await fetch(`/theaters/${encodeURIComponent(theaterId)}/diff/file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath, mode, ref }),
        });
        if (!res.ok) {
          const payload = await res.json() as { error?: string };
          throw new Error(payload.error ?? "diff_file_failed");
        }
        return res.json() as Promise<RailDiffHunkResult>;
      },
    },
  }), [theaterId]);
}
