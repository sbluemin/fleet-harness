import { useCallback, useEffect, useState } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffListResult } from "../server/types.js";
import { DiffTreeView } from "./diff-tree.js";

// ─── types ───────────────────────────────────────────────────────────────────

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly files: readonly DiffFileEntry[] }
  | { readonly kind: "notice"; readonly reason: "no_git_repo" | "git_unavailable" }
  | { readonly kind: "error"; readonly message: string };

interface ChangedFilesProps {
  readonly ctx: RailPanelContext;
  readonly viewMode: "list" | "tree";
  readonly selectedPath: string | null;
  readonly subPath: string;
  readonly onSelect: (entry: DiffFileEntry) => void;
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
  U: "untracked",
};

// ─── ChangedFiles (export) ────────────────────────────────────────────────────

function readCollapsed(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

export function ChangedFiles({ ctx, viewMode, selectedPath, subPath, onSelect }: ChangedFilesProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(() => readCollapsed(PREFS_CHANGES_COLLAPSED));

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    fetch("/plugins/diff/changed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, subPath }),
    }).then(async (res) => {
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        const code = payload.error ?? "git_failed";
        if (!cancelled) {
          if (code === "no_git_repo" || code === "git_unavailable") {
            setState({ kind: "notice", reason: code });
          } else {
            setState({ kind: "error", message: code });
          }
        }
        return;
      }
      const data = await res.json() as DiffListResult;
      if (!cancelled) setState({ kind: "ok", files: data.files });
    }).catch((err: unknown) => {
      if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
    });

    return () => { cancelled = true; };
  }, [ctx.theaterId, subPath, refreshToken]);

  const handleRetry = useCallback(() => setRefreshToken((t) => t + 1), []);

  const handleToggleChanges = useCallback(() => {
    setChangesCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(PREFS_CHANGES_COLLAPSED, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  if (state.kind === "loading") {
    return <div className="diff-sections-loading">Loading…</div>;
  }

  if (state.kind === "notice") {
    const title = state.reason === "no_git_repo"
      ? "Not a Git repository"
      : "Git isn't available";
    const body = state.reason === "no_git_repo"
      ? "This folder isn't a Git repository, so there are no changes to show."
      : "Git was not found on this system. Install Git and make sure it's on your PATH.";
    return (
      <div className="diff-sections-notice">
        <strong className="diff-notice-title">{title}</strong>
        <span className="diff-notice-body">{body}</span>
        <button type="button" className="diff-refresh-btn" onClick={handleRetry}>Retry</button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="diff-sections-error">
        <span>{state.message}</span>
        <button type="button" className="diff-refresh-btn" onClick={handleRetry}>Retry</button>
      </div>
    );
  }

  return (
    <div className="diff-sections">
      <div className={`diff-section${changesCollapsed ? " is-collapsed" : ""}`}>
        <button type="button" className="diff-section-head" onClick={handleToggleChanges}>
          <svg className="diff-section-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="diff-section-name">Changes</span>
          <span className="diff-count-badge">{state.files.length}</span>
        </button>
        {!changesCollapsed && (
          <div className="diff-section-rows">
            {state.files.length === 0 ? (
              <div className="diff-empty-row">No changes</div>
            ) : viewMode === "tree" ? (
              <DiffTreeView
                files={state.files}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              state.files.map((entry) => (
                <ListFileRow
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

function ListFileRow({ entry, isSelected, onSelect }: ListFileRowProps) {
  const handleClick = useCallback(() => onSelect(entry), [entry, onSelect]);
  const lastSlash = entry.path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? entry.path.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? entry.path.slice(lastSlash + 1) : entry.path;

  return (
    <button
      type="button"
      className={`diff-file-row${isSelected ? " is-cur" : ""}`}
      title={entry.path}
      onClick={handleClick}
    >
      <span
        className={`diff-status-glyph diff-status-${entry.status.toLowerCase()}`}
        aria-label={STATUS_LABEL[entry.status] ?? entry.status}
      >
        {entry.status}
      </span>
      <span className="diff-file-name">
        {dir && <span className="diff-file-dir">{dir}</span>}
        {name}
      </span>
      <span className="diff-nums">
        {entry.additions > 0 && <span className="diff-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="diff-deletions">−{entry.deletions}</span>}
      </span>
    </button>
  );
}
