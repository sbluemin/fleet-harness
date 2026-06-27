import { useCallback, useRef, useState } from "react";

import type { RailDiffFileEntry, RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "./diff.css";
import { ChangedFiles } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";

interface DiffPanelProps {
  readonly ctx: RailPanelContext;
}

type DiffMode = "workdir" | "staged" | "commit";

const PREFS_DIFF_MODE = "fleet-console.diff.mode";
const PREFS_SPLIT_RATIO = "fleet-console.diff.splitRatio";
// 레일 패널 기본 폭(312px)·최소 폭(240px) 안에서 미리보기+리스트가 나란히 들어가도록
// 두 최소폭 합(130+100=230)을 레일 최소폭 이하로 잡는다. 합이 레일 폭을 넘으면
// grid minmax의 min이 컨테이너를 초과해 overflow가 나고 드래그 여유공간이 사라진다.
const MIN_HUNK_PX = 130;
const MIN_TREE_PX = 100;
const DEFAULT_SPLIT_RATIO = 0.55;

function readDiffMode(): DiffMode {
  try {
    const v = localStorage.getItem(PREFS_DIFF_MODE);
    if (v === "workdir" || v === "staged") return v;
  } catch { /* ignore */ }
  return "workdir";
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

function DiffPanel({ ctx }: DiffPanelProps) {
  const [mode, setMode] = useState<DiffMode>(readDiffMode);
  const [selectedFile, setSelectedFile] = useState<RailDiffFileEntry | null>(null);
  const [splitRatio, setSplitRatioState] = useState(readSplitRatio);
  const splitRatioRef = useRef(splitRatio);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleSelectFile = useCallback((entry: RailDiffFileEntry | null) => {
    setSelectedFile(entry);
  }, []);

  const handleModeChange = useCallback((next: DiffMode) => {
    setMode(next);
    setSelectedFile(null);
    try { localStorage.setItem(PREFS_DIFF_MODE, next); } catch { /* ignore */ }
  }, []);

  const handleDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = e.clientX;
    const startRatio = splitRatioRef.current;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const lower = MIN_HUNK_PX / containerWidth;
      const upper = 1 - MIN_TREE_PX / containerWidth;
      const raw = startRatio + dx / containerWidth;
      // 컨테이너가 두 최소폭 합보다 좁으면 lower > upper로 클램프 범위가 역전된다.
      // 그 경우 비율을 고정해 NaN/역전 클램핑을 막는다.
      const newRatio = lower <= upper ? Math.max(lower, Math.min(upper, raw)) : startRatio;
      splitRatioRef.current = newRatio;
      setSplitRatioState(newRatio);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      try { localStorage.setItem(PREFS_SPLIT_RATIO, String(splitRatioRef.current)); } catch { /* ignore */ }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  return (
    <div
      ref={rootRef}
      className={`diff-root${selectedFile ? " has-hunk" : ""}`}
      style={selectedFile ? {
        gridTemplateColumns: `minmax(${MIN_HUNK_PX}px, ${splitRatio}fr) 4px minmax(${MIN_TREE_PX}px, ${1 - splitRatio}fr)`,
      } : undefined}
    >
      {selectedFile && (
        <div className="diff-hunk-pane">
          <div className="diff-hunk-head">
            <span className="diff-hunk-filename">{selectedFile.path}</span>
            <button
              type="button"
              className="diff-hunk-close"
              aria-label="Close diff"
              onClick={() => handleSelectFile(null)}
            >
              ✕
            </button>
          </div>
          <div className="diff-hunk-body">
            <HunkView ctx={ctx} file={selectedFile} mode={mode} />
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
        <div className="diff-mode-bar">
          {(["workdir", "staged"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`diff-mode-btn${mode === m ? " is-active" : ""}`}
              onClick={() => handleModeChange(m)}
            >
              {m === "workdir" ? "Changes" : "Staged"}
            </button>
          ))}
        </div>
        <ChangedFiles
          ctx={ctx}
          mode={mode}
          selectedPath={selectedFile?.path ?? null}
          onSelect={handleSelectFile}
        />
      </div>
    </div>
  );
}

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
