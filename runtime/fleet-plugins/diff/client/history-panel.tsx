import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { LogCommitEntry, LogResult, RepoEntry, ReposDiscoveryResult, WorktreeCheckout } from "../server/types.js";
import { GraphGutter } from "./graph-gutter.js";
import { layoutGraph } from "./graph-layout.js";
import type { CommitSelection } from "./hunk-view.js";
import { HunkView } from "./hunk-view.js";
import { formatCommitTime, refBadges } from "./log-parse.js";
import { CommandDeck } from "./rail-panel.js";

// ─── types ───────────────────────────────────────────────────────────────────

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly commits: readonly LogCommitEntry[]; readonly checkouts: readonly WorktreeCheckout[]; readonly truncated: boolean }
  | { readonly kind: "error"; readonly message: string };

interface HistoryPanelProps {
  readonly ctx: RailPanelContext;
}

interface CommitRowProps {
  readonly entry: LogCommitEntry;
  readonly checkouts: readonly WorktreeCheckout[];
  readonly selected: boolean;
  readonly graphNode: import("./graph-layout.js").GraphNode;
  readonly laneCount: number;
  readonly layoutCollapsed: boolean;
  readonly onSelect: (entry: LogCommitEntry) => void;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_DEPTH = "fleet-console.diff.history.depth";
const PREFS_REPO_PREFIX = "fleet-console.diff.history.repo.";
const DEFAULT_DEPTH = 3;
const EXTENDED_EXTRA_WIDTH = 400;

const DEPTH_OPTS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
  { value: 8, label: "Max" },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

export function findDetachedCheckout(entry: LogCommitEntry, checkouts: readonly WorktreeCheckout[]): WorktreeCheckout | null {
  return checkouts.find((checkout) => checkout.branch === null && checkout.sha === entry.fullHash) ?? null;
}

export function resetTheaterScopedState(
  fetchSeqRef: { current: number },
  setters: {
    readonly setActiveSubPath: (subPath: string) => void;
    readonly setSelectedCommit: (commit: CommitSelection | null) => void;
    readonly setRepos: (repos: RepoEntry[]) => void;
    readonly setReposLoading: (loading: boolean) => void;
    readonly setReposTruncated: (truncated: boolean) => void;
    readonly setMenuOpen: (open: boolean) => void;
  },
): void {
  fetchSeqRef.current += 1;
  setters.setActiveSubPath("");
  setters.setSelectedCommit(null);
  setters.setRepos([]);
  setters.setReposLoading(false);
  setters.setReposTruncated(false);
  setters.setMenuOpen(false);
}

function readDepth(): number {
  try {
    const value = localStorage.getItem(PREFS_DEPTH);
    const depth = value === null ? NaN : Number.parseInt(value, 10);
    if (Number.isFinite(depth) && depth >= 1) return depth;
  } catch { /* ignore persisted preferences */ }
  return DEFAULT_DEPTH;
}

function readSubPath(theaterId: string): string {
  try { return localStorage.getItem(PREFS_REPO_PREFIX + theaterId) ?? ""; } catch { return ""; }
}

function saveSubPath(theaterId: string, relPath: string): void {
  try { localStorage.setItem(PREFS_REPO_PREFIX + theaterId, relPath); } catch { /* ignore persisted preferences */ }
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function FolderIcon() {
  return (
    <svg className="fico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg className="bico" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="3" cy="3" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="3" cy="9" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="9" cy="3.4" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 4.6v2.8M4.4 3.2H7M7.4 4.8C6.4 5.4 4.4 5.6 3.6 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="chev" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckoutIcon({ current }: { readonly current: boolean }) {
  if (current) {
    return (
      <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none" aria-label="Current checkout">
        <path d="M2.5 6.2L5 8.7L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none" aria-label="Checked out in another worktree">
      <path d="M1.5 3.4h3l1 1.1h5v5.1a.9.9 0 01-.9.9H2.4a.9.9 0 01-.9-.9V4.3a.9.9 0 01.9-.9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

// ─── components ──────────────────────────────────────────────────────────────

function CommitRow({ entry, checkouts, selected, graphNode, laneCount, layoutCollapsed, onSelect }: CommitRowProps) {
  const badges = refBadges(entry);
  const detachedCheckout = findDetachedCheckout(entry, checkouts);
  const handleSelect = useCallback(() => onSelect(entry), [entry, onSelect]);

  return (
    <button type="button" className={`history-commit-row${selected ? " is-selected" : ""}`} onClick={handleSelect}>
      <span className="history-graph-gutter" aria-hidden="true">
        <GraphGutter node={graphNode} laneCount={laneCount} collapsed={layoutCollapsed} />
      </span>
      <span className="history-commit-badges">
        {badges.map((badge) => {
          const checkout = badge.kind === "branch"
            ? checkouts.find((candidate) => candidate.branch === badge.label)
            : null;
          return (
            <span key={`${badge.kind}:${badge.label}`} className={`history-badge history-badge--${badge.kind}`}>
              {checkout && <CheckoutIcon current={checkout.isCurrent} />}
              {badge.label}
            </span>
          );
        })}
        {detachedCheckout && (
          <span className="history-badge history-badge--worktree">
            <CheckoutIcon current={detachedCheckout.isCurrent} />
            detached
          </span>
        )}
      </span>
      <span className="history-commit-subject">{entry.subject}</span>
      <span className="history-commit-author">{entry.authorName}</span>
      <span className="history-commit-sha">{entry.shortHash}</span>
      <span className="history-commit-time">{formatCommitTime(entry.authorAt)}</span>
    </button>
  );
}

function HistoryPanel({ ctx }: HistoryPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposTruncated, setReposTruncated] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [depth, setDepth] = useState(readDepth);
  const [activeSubPath, setActiveSubPath] = useState(() => ctx.theaterId ? readSubPath(ctx.theaterId) : "");
  const [selectedCommit, setSelectedCommit] = useState<CommitSelection | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const fetchSeqRef = useRef(0);
  const depthRef = useRef(depth);
  depthRef.current = depth;

  const fetchRepos = useCallback((maxDepth: number) => {
    if (!ctx.theaterId) return;
    const sequence = ++fetchSeqRef.current;
    setReposLoading(true);
    ctx.api.fetch("diff", "repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, maxDepth }),
    }).then(async (response) => {
      if (sequence !== fetchSeqRef.current) return;
      if (!response.ok) { setReposLoading(false); return; }
      const data = await response.json() as ReposDiscoveryResult;
      if (sequence !== fetchSeqRef.current) return;
      setRepos(data.repos as RepoEntry[]);
      setReposTruncated(data.truncated ?? false);
      setReposLoading(false);
    }).catch(() => {
      if (sequence !== fetchSeqRef.current) return;
      setReposLoading(false);
    });
  }, [ctx.api, ctx.theaterId]);

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "ok", commits: [], checkouts: [], truncated: false });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    ctx.api.fetch("diff", "log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, subPath: activeSubPath }),
    }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        if (!cancelled) setState({ kind: "error", message: payload.error ?? "unknown" });
        return;
      }
      const data = await response.json() as LogResult;
      if (!cancelled) {
        setState({ kind: "ok", commits: data.commits, checkouts: data.checkouts, truncated: data.truncated ?? false });
      }
    }).catch((error: unknown) => {
      if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });

    return () => { cancelled = true; };
  }, [activeSubPath, ctx.api, ctx.theaterId, refreshToken]);

  useEffect(() => {
    resetTheaterScopedState(fetchSeqRef, {
      setActiveSubPath,
      setSelectedCommit,
      setRepos,
      setReposLoading,
      setReposTruncated,
      setMenuOpen,
    });
    if (!ctx.theaterId) return;
    setActiveSubPath(readSubPath(ctx.theaterId));
    fetchRepos(depthRef.current);
  }, [ctx.theaterId, fetchRepos]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocumentClick = () => setMenuOpen(false);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(selectedCommit ? EXTENDED_EXTRA_WIDTH : null);
  }, [ctx, selectedCommit]);

  const handleSelectRepo = useCallback((relPath: string) => {
    if (relPath === activeSubPath) return;
    setActiveSubPath(relPath);
    setSelectedCommit(null);
    if (ctx.theaterId) saveSubPath(ctx.theaterId, relPath);
  }, [activeSubPath, ctx.theaterId]);

  const handleDepthChange = useCallback((nextDepth: number) => {
    setDepth(nextDepth);
    try { localStorage.setItem(PREFS_DEPTH, String(nextDepth)); } catch { /* ignore persisted preferences */ }
    fetchRepos(nextDepth);
  }, [fetchRepos]);

  const handleSelectCommit = useCallback((entry: LogCommitEntry) => {
    if (!ctx.theaterId) return;
    setSelectedCommit({ commit: entry, subPath: activeSubPath, theaterId: ctx.theaterId });
  }, [activeSubPath, ctx.theaterId]);

  const handleCloseDetail = useCallback(() => setSelectedCommit(null), []);
  const handleRetry = useCallback(() => setRefreshToken((value) => value + 1), []);

  const activeRepo = repos.find((repo) => repo.relPath === activeSubPath) ?? null;
  const activeName = activeRepo?.name ?? (activeSubPath === "" ? "Working tree" : basename(activeSubPath));
  const activeBranch = activeRepo?.branch ?? null;
  const layout = state.kind === "ok" ? layoutGraph(state.commits) : null;

  return (
    <div className={`history-root${selectedCommit ? " has-detail" : ""}`}>
      {selectedCommit && (
        <div className="history-detail-pane">
          <div className="history-detail-head">
            <span className="history-detail-sha">{selectedCommit.commit.shortHash}</span>
            <span className="history-detail-subject">{selectedCommit.commit.subject}</span>
            <button type="button" className="history-detail-close" aria-label="Close commit diff" onClick={handleCloseDetail}>✕</button>
          </div>
          <div className="history-detail-body">
            <HunkView
              ctx={ctx}
              file={{ path: "", status: "M", additions: 0, deletions: 0 }}
              mode="unified"
              subPath={selectedCommit.subPath}
              commit={selectedCommit}
            />
          </div>
        </div>
      )}
      <div className="history-list-pane">
        <div className="history-toolbar">
          <button type="button" className="diff-repo-trigger" aria-haspopup="listbox" aria-expanded={menuOpen} onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }}>
            <FolderIcon />
            <span className="nm">{activeName}</span>
            {activeBranch && <span className="brc"><BranchIcon /><span className="bnm">{activeBranch}</span></span>}
            <ChevronIcon />
          </button>
          {state.kind === "ok" && <span className="history-count">{state.commits.length}</span>}
        </div>
        <div className="history-list">
          {state.kind === "loading" && <div className="history-empty">Loading…</div>}
          {state.kind === "error" && <div className="history-error"><span>{state.message}</span><button type="button" className="diff-refresh-btn" onClick={handleRetry}>Retry</button></div>}
          {state.kind === "ok" && state.commits.length === 0 && <div className="history-empty">No history</div>}
          {state.kind === "ok" && layout && state.commits.map((entry, index) => (
            <CommitRow
              key={entry.fullHash}
              entry={entry}
              checkouts={state.checkouts}
              selected={selectedCommit?.commit.fullHash === entry.fullHash}
              graphNode={layout.nodes[index]!}
              laneCount={layout.activeLaneCount}
              layoutCollapsed={layout.collapsed}
              onSelect={handleSelectCommit}
            />
          ))}
          {state.kind === "ok" && state.truncated && <div className="history-truncated">History capped at 200 commits.</div>}
        </div>
        {menuOpen && (
          <CommandDeck
            theaterId={ctx.theaterId ?? ""}
            repos={repos}
            loading={reposLoading}
            truncated={reposTruncated}
            activeSubPath={activeSubPath}
            depth={depth}
            onSelect={handleSelectRepo}
            onDepthChange={handleDepthChange}
            onRescan={() => fetchRepos(depth)}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M5 3v12M10 7v8M14 11v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5 7c1.8 0 2.4 0 5 0M10 11c1.4 0 2.2 0 4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5" cy="3" r="2" fill="currentColor" />
      <circle cx="5" cy="7" r="1.7" fill="currentColor" />
      <circle cx="10" cy="11" r="1.7" fill="currentColor" />
      <circle cx="14" cy="15" r="1.7" fill="currentColor" />
    </svg>
  );
}

export const historyPanel: RailPanelDescriptor = {
  id: "history",
  title: "History",
  icon: () => <HistoryIcon />,
  render: (ctx: RailPanelContext) => <HistoryPanel ctx={ctx} />,
};
