import { useCallback, useEffect, useState } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { LogCommitEntry, LogResult } from "../server/types.js";
import { setSelectedCommit, useSelectedCommit } from "./diff-view-store.js";
import { GraphGutter } from "./graph-gutter.js";
import { layoutGraph } from "./graph-layout.js";
import { refBadges } from "./log-parse.js";

// ─── types ───────────────────────────────────────────────────────────────────

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly commits: readonly LogCommitEntry[] }
  | { readonly kind: "error"; readonly message: string };

interface HistorySectionProps {
  readonly ctx: RailPanelContext;
  readonly subPath: string;
  readonly refreshToken?: number;
  readonly graphMode?: "flat" | "graph";
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_HISTORY_COLLAPSED = "fleet-console.diff.historyCollapsed";

// ─── helpers ─────────────────────────────────────────────────────────────────

function readCollapsed(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

// ─── CommitRow ───────────────────────────────────────────────────────────────

interface CommitRowProps {
  readonly entry: LogCommitEntry;
  readonly isCur: boolean;
  readonly onClick: (entry: LogCommitEntry) => void;
  readonly graphNode?: import("./graph-layout.js").GraphNode | null;
  readonly laneCount?: number;
  readonly layoutCollapsed?: boolean;
}

function CommitRow({ entry, isCur, onClick, graphNode, laneCount = 0, layoutCollapsed = false }: CommitRowProps) {
  const handleClick = useCallback(() => onClick(entry), [entry, onClick]);
  const badges = refBadges(entry);

  return (
    <button
      type="button"
      className={`diff-commit-row${isCur ? " is-cur" : ""}`}
      onClick={handleClick}
    >
      <span className="diff-graph-gutter" aria-hidden="true">
        {graphNode ? <GraphGutter node={graphNode} laneCount={laneCount} collapsed={layoutCollapsed} /> : null}
      </span>
      <span className="diff-commit-sha">{entry.shortHash}</span>
      <span className="diff-commit-subject">{entry.subject}</span>
      {badges.length > 0 && (
        <span className="diff-commit-badges">
          {badges.map((b, i) => (
            <span key={i} className={`diff-badge badge--${b.kind}`}>{b.label}</span>
          ))}
        </span>
      )}
      <span className="diff-nums">
        {entry.additions > 0 && <span className="diff-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="diff-deletions">−{entry.deletions}</span>}
      </span>
      <span className="diff-commit-meta">{entry.authorName} · {entry.relTime}</span>
    </button>
  );
}

// ─── HistorySection ──────────────────────────────────────────────────────────

export function HistorySection({ ctx, subPath, refreshToken = 0, graphMode = "flat" }: HistorySectionProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [collapsed, setCollapsed] = useState(() => readCollapsed(PREFS_HISTORY_COLLAPSED));
  const [localRefreshToken, setLocalRefreshToken] = useState(0);
  const selectedCommit = useSelectedCommit(ctx.theaterId ?? null);

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "ok", commits: [] });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    ctx.api.fetch("diff", "log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, subPath }),
    }).then(async (res) => {
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        const code = payload.error ?? "unknown";
        if (!cancelled) {
          if (code === "git_unavailable") {
            setState({ kind: "ok", commits: [] });
          } else {
            setState({ kind: "error", message: code });
          }
        }
        return;
      }
      const data = await res.json() as LogResult;
      if (!cancelled) setState({ kind: "ok", commits: data.commits });
    }).catch((err: unknown) => {
      if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
    });

    return () => { cancelled = true; };
  }, [ctx.theaterId, ctx.api, subPath, refreshToken, localRefreshToken]);

  const handleToggle = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(PREFS_HISTORY_COLLAPSED, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleRetry = useCallback(() => setLocalRefreshToken((t) => t + 1), []);

  const handleSelectCommit = useCallback((entry: LogCommitEntry) => {
    if (!ctx.theaterId) return;
    setSelectedCommit(entry, subPath, ctx.theaterId);
  }, [ctx.theaterId, subPath]);

  const commitCount = state.kind === "ok" ? state.commits.length : 0;
  const layout = state.kind === "ok" && graphMode === "graph"
    ? layoutGraph(state.commits)
    : null;
  const layoutCollapsed = layout?.collapsed ?? false;

  return (
    <div className={`diff-section diff-section-history${collapsed ? " is-collapsed" : ""}`}>
      <button type="button" className="diff-section-head" onClick={handleToggle}>
        <svg className="diff-section-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="diff-section-name">History</span>
        {state.kind === "ok" && <span className="diff-count-badge">{commitCount}</span>}
      </button>
      {!collapsed && (
        <div className="diff-section-rows">
          {state.kind === "loading" && (
            <div className="diff-empty-row">Loading…</div>
          )}
          {state.kind === "error" && (
            <div className="diff-sections-error">
              <span>{state.message}</span>
              <button type="button" className="diff-refresh-btn" onClick={handleRetry}>Retry</button>
            </div>
          )}
          {state.kind === "ok" && state.commits.length === 0 && (
            <div className="diff-empty-row">No history</div>
          )}
          {state.kind === "ok" && state.commits.map((entry, i) => (
            <CommitRow
              key={entry.fullHash}
              entry={entry}
              isCur={selectedCommit?.commit.fullHash === entry.fullHash}
              onClick={handleSelectCommit}
              graphNode={layout ? layout.nodes[i] ?? null : null}
              laneCount={layout ? layout.activeLaneCount : 0}
              layoutCollapsed={layoutCollapsed}
            />
          ))}
        </div>
      )}
    </div>
  );
}
