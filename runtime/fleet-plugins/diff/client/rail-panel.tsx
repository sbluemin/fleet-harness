import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffFileMode } from "../server/types.js";
import "./diff.css";
import { ChangedFiles } from "./changed-files.js";
import { pathContextKey } from "./context-key.js";
import { clearSelectedFile, setSelectedFile, type SelectedFile, useSelectedFile } from "./diff-view-store.js";
import { HunkView } from "./hunk-view.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth } from "./rail-layout.js";

type ViewMode = "list" | "tree";

interface DiffPanelProps {
  readonly ctx: RailPanelContext;
}

const PREFS_VIEW_MODE = "fleet-console.diff.viewMode";
const PREFS_LIST_PANE_WIDTH = "fleet-console.diff.listPaneWidth";
const EXTENDED_EXTRA_WIDTH = 400;
const LIST_PANE_DEFAULT_WIDTH = 248;
const LIST_PANE_MIN_WIDTH = 220;

function readViewMode(): ViewMode {
  try {
    const value = localStorage.getItem(PREFS_VIEW_MODE);
    if (value === "list" || value === "tree") return value;
  } catch { /* ignore */ }
  return "list";
}

function readListPaneWidth(): number {
  try {
    const value = localStorage.getItem(PREFS_LIST_PANE_WIDTH);
    const width = value === null ? NaN : Number.parseFloat(value);
    if (Number.isFinite(width) && width > 0) return Math.max(LIST_PANE_MIN_WIDTH, width);
  } catch { /* ignore */ }
  return LIST_PANE_DEFAULT_WIDTH;
}

function getHunkMode(selected: SelectedFile): DiffFileMode {
  return selected.entry.status === "U" ? "untracked" : "unified";
}

function DiffPanel({ ctx }: DiffPanelProps) {
  const contextKey = pathContextKey(ctx.theaterId, ctx.pathContext.relPath);

  return <DiffPanelBody key={contextKey} ctx={ctx} />;
}

function DiffPanelBody({ ctx }: DiffPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [filterText, setFilterText] = useState("");
  const subPath = ctx.pathContext.relPath ?? "";
  const selectedFile = useSelectedFile(ctx.theaterId ?? null, subPath);
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const listPaneWidthRef = useRef(listPaneWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useLayoutEffect(() => () => clearSelectedFile(), []);

  const handleSelectFile = useCallback((entry: DiffFileEntry) => {
    if (ctx.theaterId) setSelectedFile(entry, subPath, ctx.theaterId);
  }, [ctx.theaterId, subPath]);
  const handleCloseHunk = useCallback(() => clearSelectedFile(), []);
  const handleViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(PREFS_VIEW_MODE, next); } catch { /* ignore */ }
  }, []);
  const handleDividerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const startWidth = listPaneWidthRef.current;
    setIsDragging(true);
    const onMove = (move: PointerEvent) => {
      const next = clampListPaneWidth({ startWidth, dx: move.clientX - startX, containerWidth, listPaneMinWidth: LIST_PANE_MIN_WIDTH, hunkPaneMinWidth: HUNK_PANE_MIN_WIDTH, dividerWidth: DIFF_DIVIDER_WIDTH });
      if (next !== null) {
        listPaneWidthRef.current = next;
        setListPaneWidth(next);
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      try { localStorage.setItem(PREFS_LIST_PANE_WIDTH, String(listPaneWidthRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(selectedFile ? EXTENDED_EXTRA_WIDTH : null);
    return () => ctx.requestExtraWidth?.(null);
  }, [ctx.requestExtraWidth, selectedFile]);

  const hunkMode = selectedFile ? getHunkMode(selectedFile) : null;
  return (
    <div ref={rootRef} className={`diff-root${selectedFile ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={selectedFile ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
      {selectedFile && hunkMode ? <div className="diff-hunk-pane"><div className="diff-hunk-head"><span>{selectedFile.entry.path}</span><button type="button" onClick={handleCloseHunk}>✕</button></div><HunkView ctx={ctx} file={selectedFile.entry} mode={hunkMode} subPath={selectedFile.subPath} /></div> : null}
      {selectedFile ? <div className="diff-divider" onPointerDown={handleDividerDown} aria-hidden="true" /> : null}
      <div className="diff-list-pane">
        <div className="diff-toolbar"><div className="diff-filter"><input type="text" className="diff-filter-input" placeholder="Filter…" aria-label="Filter changed files" value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText ? <button type="button" className="diff-filter-clear" aria-label="Clear filter" onClick={() => setFilterText("")}>✕</button> : null}</div><div className="diff-view-toggle"><button type="button" className={`diff-toggle-btn${viewMode === "list" ? " is-active" : ""}`} title="List view" aria-pressed={viewMode === "list"} onClick={() => handleViewMode("list")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button type="button" className={`diff-toggle-btn${viewMode === "tree" ? " is-active" : ""}`} title="Tree view" aria-pressed={viewMode === "tree"} onClick={() => handleViewMode("tree")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg></button></div></div>
        <ChangedFiles ctx={ctx} viewMode={viewMode} selectedPath={selectedFile?.entry.path ?? null} subPath={subPath} onSelect={handleSelectFile} filterText={filterText} />
      </div>
    </div>
  );
}

function DiffIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" /><rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" /></svg>;
}

export const diffPanel: RailPanelDescriptor = {
  id: "diff",
  title: "Diff",
  icon: () => <DiffIcon />,
  pathAware: true,
  render: (ctx: RailPanelContext) => <DiffPanel ctx={ctx} />,
};
