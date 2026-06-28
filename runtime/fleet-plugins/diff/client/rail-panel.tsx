import { useCallback, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffSection } from "../server/types.js";
import "./diff.css";
import { ChangedFiles } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";

// ─── types ───────────────────────────────────────────────────────────────────

type ViewMode = "list" | "tree";

type HunkMode = "workdir" | "staged" | "commit" | "untracked";

interface SelectedFile {
  readonly entry: DiffFileEntry;
  readonly section: DiffSection;
}

interface DiffPanelProps {
  readonly ctx: RailPanelContext;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_VIEW_MODE = "fleet-console.diff.viewMode";
const PREFS_SPLIT_RATIO = "fleet-console.diff.splitRatio";
// 레일 패널 기본 폭(312px)·최소 폭(240px) 안에서 미리보기+리스트가 나란히 들어가도록
// 두 최소폭 합(130+100=230)을 레일 최소폭 이하로 잡는다.
const MIN_HUNK_PX = 130;
const MIN_TREE_PX = 100;
const DEFAULT_SPLIT_RATIO = 0.55;

// ─── helpers ─────────────────────────────────────────────────────────────────

function readViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(PREFS_VIEW_MODE);
    if (v === "list" || v === "tree") return v;
  } catch { /* ignore */ }
  return "list";
}

function readSplitRatio(): number {
  try {
    const v = localStorage.getItem(PREFS_SPLIT_RATIO);
    if (v !== null) {
      const n = parseFloat(v);
      if (!isNaN(n) && n > 0 && n < 1) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_SPLIT_RATIO;
}

// 섹션+상태에서 HunkView가 사용할 git diff 모드 결정
function getHunkMode(selected: SelectedFile): HunkMode {
  if (selected.section === "staged") return "staged";
  if (selected.entry.status === "U") return "untracked";
  return "workdir";
}

// ─── DiffPanel ───────────────────────────────────────────────────────────────

function DiffPanel({ ctx }: DiffPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [splitRatio, setSplitRatioState] = useState(readSplitRatio);
  const splitRatioRef = useRef(splitRatio);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleSelectFile = useCallback((entry: DiffFileEntry, section: DiffSection) => {
    setSelectedFile({ entry, section });
  }, []);

  const handleCloseHunk = useCallback(() => {
    setSelectedFile(null);
  }, []);

  const handleViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(PREFS_VIEW_MODE, next); } catch { /* ignore */ }
  }, []);

  const handleDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startRatio = splitRatioRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const lower = MIN_HUNK_PX / containerWidth;
      const upper = 1 - MIN_TREE_PX / containerWidth;
      const raw = startRatio + dx / containerWidth;
      // 컨테이너가 두 최소폭 합보다 좁으면 lower > upper로 클램프 범위가 역전된다.
      const newRatio = lower <= upper ? Math.max(lower, Math.min(upper, raw)) : startRatio;
      splitRatioRef.current = newRatio;
      setSplitRatioState(newRatio);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      try { localStorage.setItem(PREFS_SPLIT_RATIO, String(splitRatioRef.current)); } catch { /* ignore */ }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const hunkMode: HunkMode = selectedFile ? getHunkMode(selectedFile) : "workdir";

  return (
    <div
      ref={rootRef}
      className={`diff-root${selectedFile ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`}
      style={selectedFile ? {
        gridTemplateColumns: `minmax(${MIN_HUNK_PX}px, ${splitRatio}fr) 4px minmax(${MIN_TREE_PX}px, ${1 - splitRatio}fr)`,
      } : undefined}
    >
      {selectedFile && (
        <div className="diff-hunk-pane">
          <div className="diff-hunk-head">
            <span className="diff-hunk-filename">{selectedFile.entry.path}</span>
            <button
              type="button"
              className="diff-hunk-close"
              aria-label="Close diff"
              onClick={handleCloseHunk}
            >
              ✕
            </button>
          </div>
          <div className="diff-hunk-body">
            <HunkView ctx={ctx} file={selectedFile.entry} mode={hunkMode} />
          </div>
        </div>
      )}
      {selectedFile && (
        <div
          className="diff-divider"
          onPointerDown={handleDividerDown}
          aria-hidden="true"
        />
      )}
      <div className="diff-tree-pane">
        <div className="diff-plugin-toolbar">
          <span className="diff-toolbar-label">Working tree</span>
          <div className="diff-view-toggle">
            <button
              type="button"
              className={`diff-toggle-btn${viewMode === "list" ? " is-active" : ""}`}
              title="List view"
              aria-pressed={viewMode === "list"}
              onClick={() => handleViewMode("list")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={`diff-toggle-btn${viewMode === "tree" ? " is-active" : ""}`}
              title="Tree view"
              aria-pressed={viewMode === "tree"}
              onClick={() => handleViewMode("tree")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          </div>
        </div>
        <ChangedFiles
          ctx={ctx}
          viewMode={viewMode}
          selectedPath={selectedFile?.entry.path ?? null}
          selectedSection={selectedFile?.section ?? null}
          onSelect={handleSelectFile}
        />
      </div>
    </div>
  );
}

// ─── DiffIcon ────────────────────────────────────────────────────────────────

function DiffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" />
      <rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" />
      <line x1="14" y1="2" x2="14" y2="16" stroke="currentColor" strokeWidth="1.2" />
      <polyline points="12,4 14,2 16,4" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <polyline points="12,14 14,16 16,14" stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export const diffPanel: RailPanelDescriptor = {
  id: "diff",
  title: "Diff",
  icon: () => <DiffIcon />,
  render: (ctx: RailPanelContext) => <DiffPanel ctx={ctx} />,
};
