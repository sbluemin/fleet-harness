import { useCallback, useMemo, useState, type RefObject } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { DiffFileEntry } from "../server/types.js";
import type { RepositoryMessageKey } from "./i18n/index.js";
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
  readonly t: Translate<RepositoryMessageKey>;
  readonly collapsedFolders?: ReadonlySet<string>;
  readonly onToggleFolder?: (path: string) => void;
  readonly scrollContainerRef?: RefObject<HTMLDivElement | null>;
  readonly onScroll?: () => void;
}

interface ListFileRowProps {
  readonly entry: DiffFileEntry;
  readonly isSelected: boolean;
  readonly onSelect: (entry: DiffFileEntry) => void;
  readonly t: Translate<RepositoryMessageKey>;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_CHANGES_COLLAPSED = "fleet-console.diff.changesCollapsed";

const STATUS_KEY: { [key: string]: RepositoryMessageKey } = {
  M: "repository.status.modified",
  A: "repository.status.added",
  D: "repository.status.deleted",
  R: "repository.status.renamed",
  T: "repository.status.typeChanged",
  U: "repository.status.untracked",
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

export function ChangedFiles({ state, onRetry, viewMode, selectedPath, onSelect, filterText, t, collapsedFolders, onToggleFolder, scrollContainerRef, onScroll }: ChangedFilesProps) {
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
    return <div className="repository-sections-loading">{t("repository.common.loading")}</div>;
  }

  if (state.kind === "notice") {
    const title = state.reason === "no_git_repo"
      ? t("repository.changes.notice.noGitRepoTitle")
      : t("repository.changes.notice.gitUnavailableTitle");
    const body = state.reason === "no_git_repo"
      ? t("repository.changes.notice.noGitRepoBody")
      : t("repository.changes.notice.gitUnavailableBody");
    return (
      <div className="repository-sections-notice">
        <strong className="repository-notice-title">{title}</strong>
        <span className="repository-notice-body">{body}</span>
        <button type="button" className="repository-refresh-btn" onClick={onRetry}>{t("repository.common.retry")}</button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="repository-sections-error">
        <span>{state.message}</span>
        <button type="button" className="repository-refresh-btn" onClick={onRetry}>{t("repository.common.retry")}</button>
      </div>
    );
  }

  const countLabel = filterText ? `${visibleFiles.length}/${state.files.length}` : String(state.files.length);

  return (
    <div ref={scrollContainerRef} className="repository-sections" onScroll={onScroll}>
      <div className={`repository-section${changesCollapsed ? " is-collapsed" : ""}`}>
        <button type="button" className="repository-section-head" onClick={handleToggleChanges}>
          <svg className="repository-section-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="repository-section-name">{t("repository.changes.section")}</span>
          <span className="repository-count-badge">{countLabel}</span>
        </button>
        {!changesCollapsed && (
          <div className="repository-section-rows">
            {visibleFiles.length === 0 ? (
              <div className="repository-empty-row">{filterText ? t("repository.common.noMatchingItems") : t("repository.changes.empty")}</div>
            ) : viewMode === "tree" ? (
              <DiffTreeView
                files={visibleFiles}
                selectedPath={selectedPath}
                onSelect={onSelect}
                collapsedFolders={collapsedFolders}
                onToggleFolder={onToggleFolder}
              />
            ) : (
              visibleFiles.map((entry) => (
                <FileRow
                  key={entry.path}
                  entry={entry}
                  isSelected={entry.path === selectedPath}
                  onSelect={onSelect}
                  t={t}
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

export function FileRow({ entry, isSelected, onSelect, t }: ListFileRowProps) {
  const handleClick = useCallback(() => onSelect(entry), [entry, onSelect]);
  // 미추적 디렉터리는 trailing slash 경로로 오므로, 이름은 마지막 비어있지 않은 세그먼트로 취한다
  const trimmed = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
  const lastSlash = trimmed.lastIndexOf("/");
  const dir = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : "";
  const name = (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed) + (entry.path.endsWith("/") ? "/" : "");
  const statusKey = STATUS_KEY[entry.status];

  return (
    <button
      type="button"
      className={`repository-file-row${isSelected ? " is-cur" : ""}`}
      title={entry.path}
      onClick={handleClick}
    >
      <span
        className={`repository-status-glyph repository-status-${entry.status.toLowerCase()}`}
        aria-label={statusKey ? t(statusKey) : entry.status}
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
