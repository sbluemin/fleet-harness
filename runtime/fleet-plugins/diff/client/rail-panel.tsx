import { useCallback, useState } from "react";

import type { RailDiffFileEntry, RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "./diff.css";
import { ChangedFiles } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";

interface DiffPanelProps {
  readonly ctx: RailPanelContext;
}

type DiffMode = "workdir" | "staged" | "commit";

const PREFS_DIFF_MODE = "fleet-console.diff.mode";

function readDiffMode(): DiffMode {
  try {
    const v = localStorage.getItem(PREFS_DIFF_MODE);
    if (v === "workdir" || v === "staged") return v;
  } catch { /* ignore */ }
  return "workdir";
}

function DiffPanel({ ctx }: DiffPanelProps) {
  const [mode, setMode] = useState<DiffMode>(readDiffMode);
  const [selectedFile, setSelectedFile] = useState<RailDiffFileEntry | null>(null);

  const handleSelectFile = useCallback((entry: RailDiffFileEntry | null) => {
    setSelectedFile(entry);
  }, []);

  const handleModeChange = useCallback((next: DiffMode) => {
    setMode(next);
    setSelectedFile(null);
    try { localStorage.setItem(PREFS_DIFF_MODE, next); } catch { /* ignore */ }
  }, []);

  return (
    <div className={`diff-root${selectedFile ? " has-hunk" : ""}`}>
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
