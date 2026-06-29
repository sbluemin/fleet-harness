import { useCallback, useEffect, useState } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffListResult, DiffSection } from "../server/types.js";
import { DiffTreeView } from "./diff-tree.js";

// ─── types ───────────────────────────────────────────────────────────────────

type PairLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly staged: readonly DiffFileEntry[]; readonly changes: readonly DiffFileEntry[] }
  | { readonly kind: "notice"; readonly reason: "no_git_repo" | "git_unavailable" }
  | { readonly kind: "error"; readonly message: string };

interface ChangedFilesProps {
  readonly ctx: RailPanelContext;
  readonly viewMode: "list" | "tree";
  readonly selectedPath: string | null;
  readonly selectedSection: DiffSection | null;
  readonly onSelect: (entry: DiffFileEntry, section: DiffSection) => void;
}

interface SectionProps {
  readonly name: string;
  readonly files: readonly DiffFileEntry[];
  readonly isCollapsed: boolean;
  readonly onToggle: () => void;
  readonly viewMode: "list" | "tree";
  readonly section: DiffSection;
  readonly selectedPath: string | null;
  readonly selectedSection: DiffSection | null;
  readonly onSelect: (entry: DiffFileEntry, section: DiffSection) => void;
}

interface ListFileRowProps {
  readonly entry: DiffFileEntry;
  readonly section: DiffSection;
  readonly isSelected: boolean;
  readonly onSelect: (entry: DiffFileEntry, section: DiffSection) => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_STAGED_COLLAPSED = "fleet-console.diff.stagedCollapsed";
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

export function ChangedFiles({ ctx, viewMode, selectedPath, selectedSection, onSelect }: ChangedFilesProps) {
  const [state, setState] = useState<PairLoadState>({ kind: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);
  const [stagedCollapsed, setStagedCollapsed] = useState(() => readCollapsed(PREFS_STAGED_COLLAPSED));
  const [changesCollapsed, setChangesCollapsed] = useState(() => readCollapsed(PREFS_CHANGES_COLLAPSED));

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    const fetchMode = async (mode: "workdir" | "staged"): Promise<DiffListResult> => {
      const res = await fetch("/plugins/diff/changed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, mode }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "git_failed");
      }
      return res.json() as Promise<DiffListResult>;
    };

    // allSettled로 두 모드를 모두 평가한다. Promise.all은 먼저 reject되는 쪽으로 실패하는데,
    // repo 밖에서 workdir(`git diff`)는 "not a git repository"를 내지만 staged(`git diff --cached`)는
    // "unknown option `cached'"로 실패해 git_failed로 분류된다 → 레이스로 notice가 비결정적이 된다.
    // 한쪽이라도 not-a-repo / git 미설치를 보고하면 그것이 폴더에 대한 권위적 사유이므로 우선 채택한다.
    Promise.allSettled([fetchMode("workdir"), fetchMode("staged")]).then(([workdir, staged]) => {
      if (cancelled) return;
      if (workdir.status === "fulfilled" && staged.status === "fulfilled") {
        setState({ kind: "ok", staged: staged.value.files, changes: workdir.value.files });
        return;
      }
      const reasons = [workdir, staged].map((r) =>
        r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : "unknown") : null,
      );
      const notice = reasons.find((m) => m === "no_git_repo" || m === "git_unavailable");
      if (notice === "no_git_repo" || notice === "git_unavailable") {
        setState({ kind: "notice", reason: notice });
        return;
      }
      setState({ kind: "error", message: reasons.find((m) => m !== null) ?? "unknown" });
    });

    return () => { cancelled = true; };
  }, [ctx.theaterId, refreshToken]);

  const handleRetry = useCallback(() => setRefreshToken((t) => t + 1), []);

  const handleToggleStaged = useCallback(() => {
    setStagedCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(PREFS_STAGED_COLLAPSED, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

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
      <AccordionSection
        name="Staged Changes"
        files={state.staged}
        isCollapsed={stagedCollapsed}
        onToggle={handleToggleStaged}
        viewMode={viewMode}
        section="staged"
        selectedPath={selectedPath}
        selectedSection={selectedSection}
        onSelect={onSelect}
      />
      <AccordionSection
        name="Changes"
        files={state.changes}
        isCollapsed={changesCollapsed}
        onToggle={handleToggleChanges}
        viewMode={viewMode}
        section="workdir"
        selectedPath={selectedPath}
        selectedSection={selectedSection}
        onSelect={onSelect}
      />
    </div>
  );
}

// ─── 내부 헬퍼 ───────────────────────────────────────────────────────────────

function AccordionSection({ name, files, isCollapsed, onToggle, viewMode, section, selectedPath, selectedSection, onSelect }: SectionProps) {
  return (
    <div className={`diff-section${isCollapsed ? " is-collapsed" : ""}`}>
      <button type="button" className="diff-section-head" onClick={onToggle}>
        <svg className="diff-section-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="diff-section-name">{name}</span>
        <span className="diff-count-badge">{files.length}</span>
      </button>
      {!isCollapsed && (
        <div className="diff-section-rows">
          {files.length === 0 ? (
            <div className="diff-empty-row">No changes</div>
          ) : viewMode === "tree" ? (
            <DiffTreeView
              files={files}
              section={section}
              selectedPath={selectedPath}
              selectedSection={selectedSection}
              onSelect={onSelect}
            />
          ) : (
            files.map((entry) => (
              <ListFileRow
                key={entry.path}
                entry={entry}
                section={section}
                isSelected={entry.path === selectedPath && section === selectedSection}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ListFileRow({ entry, section, isSelected, onSelect }: ListFileRowProps) {
  const handleClick = useCallback(() => onSelect(entry, section), [entry, section, onSelect]);
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
