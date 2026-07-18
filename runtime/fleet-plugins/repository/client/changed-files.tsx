import { useCallback, useMemo, useState } from "react";

import type { DiffFileEntry } from "../server/types.js";
import { DiffTreeView } from "./repository-tree.js";

// ─── types ───────────────────────────────────────────────────────────────────

export type ChangedFilesState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly files: readonly DiffFileEntry[] }
  | { readonly kind: "notice"; readonly reason: "no_git_repo" | "git_unavailable" }
  | { readonly kind: "error"; readonly message: string };

interface ChangedFilesProps {
  readonly state: ChangedFilesState;
  readonly onRetry: () => void;
  readonly viewMode: "list" | "tree";
  readonly selectedPath: string | null;
  readonly onSelect: (entry: DiffFileEntry) => void;
  readonly filterText: string;
}

interface ListFileRowProps {
  readonly entry: DiffFileEntry;
  readonly isSelected: boolean;
  readonly onSelect: (entry: DiffFileEntry) => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_CHANGES_COLLAPSED = "fleet-console.diff.changesCollapsed";

const STATUS_LABEL: { [key: string]: string } = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  T: "type changed",
  U: "untracked",
};

// ─── ChangedFiles (export) ────────────────────────────────────────────────────

export function filterDiffFiles(files: readonly DiffFileEntry[], filterText: string): readonly DiffFileEntry[] {
  const normalizedFilter = filterText.toLowerCase();

  if (!normalizedFilter) return files;

  return files.filter((entry) => entry.path.toLowerCase().includes(normalizedFilter));
}

// ─── ChangedFiles (export) ────────────────────────────────────────────────────

function readCollapsed(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

export function ChangedFiles({ state, onRetry, viewMode, selectedPath, onSelect, filterText }: ChangedFilesProps) {
  const [changesCollapsed, setChangesCollapsed] = useState(() => readCollapsed(PREFS_CHANGES_COLLAPSED));

  const handleToggleChanges = useCallback(() => {
    setChangesCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(PREFS_CHANGES_COLLAPSED, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const visibleFiles = useMemo(
    () => state.kind === "ok" ? filterDiffFiles(state.files, filterText) : [],
    [filterText, state],
  );

  if (state.kind === "loading") {
    return <div className="repository-sections-loading">Loading…</div>;
  }

  if (state.kind === "notice") {
    const title = state.reason === "no_git_repo"
      ? "Not a Git repository"
      : "Git isn't available";
    const body = state.reason === "no_git_repo"
      ? "This folder isn't a Git repository, so there are no changes to show."
      : "Git was not found on this system. Install Git and make sure it's on your PATH.";
    return (
      <div className="repository-sections-notice">
        <strong className="repository-notice-title">{title}</strong>
        <span className="repository-notice-body">{body}</span>
        <button type="button" className="repository-refresh-btn" onClick={onRetry}>Retry</button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="repository-sections-error">
        <span>{state.message}</span>
        <button type="button" className="repository-refresh-btn" onClick={onRetry}>Retry</button>
      </div>
    );
  }

  const countLabel = filterText ? `${visibleFiles.length}/${state.files.length}` : String(state.files.length);

  return (
    <div className="repository-sections">
      <div className={`repository-section${changesCollapsed ? " is-collapsed" : ""}`}>
        <button type="button" className="repository-section-head" onClick={handleToggleChanges}>
          <svg className="repository-section-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="repository-section-name">Changes</span>
          <span className="repository-count-badge">{countLabel}</span>
        </button>
        {!changesCollapsed && (
          <div className="repository-section-rows">
            {visibleFiles.length === 0 ? (
              <div className="repository-empty-row">{filterText ? "No matching items" : "No changes"}</div>
            ) : viewMode === "tree" ? (
              <DiffTreeView
                files={visibleFiles}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              visibleFiles.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  isSelected={entry.path === selectedPath}
                  onSelect={onSelect}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

export function FileRow({ entry, isSelected, onSelect }: ListFileRowProps) {
  const handleClick = useCallback(() => onSelect(entry), [entry, onSelect]);
  // 미추적 디렉터리는 trailing slash 경로로 오므로, 이름은 마지막 비어있지 않은 세그먼트로 취한다
  const trimmed = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
  const lastSlash = trimmed.lastIndexOf("/");
  const dir = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : "";
  const name = (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed) + (entry.path.endsWith("/") ? "/" : "");

  return (
    <button
      type="button"
      className={`repository-file-row${isSelected ? " is-cur" : ""}`}
      title={entry.path}
      onClick={handleClick}
    >
      <span
        className={`repository-status-glyph repository-status-${entry.status.toLowerCase()}`}
        aria-label={STATUS_LABEL[entry.status] ?? entry.status}
      >
        {entry.status}
      </span>
      <span className="repository-file-name">
        <span className="repository-file-fn">{name}</span>
        {dir && <span className="repository-file-dir">{dir}</span>}
      </span>
      <span className="repository-nums">
        {entry.additions > 0 && <span className="repository-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="repository-deletions">−{entry.deletions}</span>}
      </span>
    </button>
  );
}
