import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { LogCommitEntry, LogResult, WorktreeCheckout } from "../server/types.js";
import { pathContextKey } from "./context-key.js";
import { GraphGutter } from "./graph-gutter.js";
import { layoutGraph } from "./graph-layout.js";
import type { CommitSelection } from "./hunk-view.js";
import { HunkView } from "./hunk-view.js";
import { formatCommitTime, refBadges } from "./log-parse.js";

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

const EXTENDED_EXTRA_WIDTH = 400;

export function findDetachedCheckout(entry: LogCommitEntry, checkouts: readonly WorktreeCheckout[]): WorktreeCheckout | null {
  return checkouts.find((checkout) => checkout.branch === null && checkout.sha === entry.fullHash) ?? null;
}

export function filterHistoryCommits(commits: readonly LogCommitEntry[], filterText: string): readonly LogCommitEntry[] {
  const normalizedFilter = filterText.toLowerCase();

  if (!normalizedFilter) return commits;

  return commits.filter((entry) => (
    entry.subject.toLowerCase().includes(normalizedFilter)
    || entry.authorName.toLowerCase().includes(normalizedFilter)
    || entry.shortHash.toLowerCase().includes(normalizedFilter)
    || entry.fullHash.toLowerCase().includes(normalizedFilter)
    || entry.refs.some((ref) => ref.toLowerCase().includes(normalizedFilter))
    || refBadges(entry).some((badge) => badge.label.toLowerCase().includes(normalizedFilter))
  ));
}

function CheckoutIcon({ current }: { readonly current: boolean }) {
  return current ? <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none" aria-label="Current checkout"><path d="M2.5 6.2L5 8.7L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none" aria-label="Checked out in another worktree"><path d="M1.5 3.4h3l1 1.1h5v5.1a.9.9 0 01-.9.9H2.4a.9.9 0 01-.9-.9V4.3a.9.9 0 01.9-.9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}

function CommitRow({ entry, checkouts, selected, graphNode, laneCount, layoutCollapsed, onSelect }: CommitRowProps) {
  const badges = refBadges(entry);
  const detachedCheckout = findDetachedCheckout(entry, checkouts);
  return <button type="button" className={`history-commit-row${selected ? " is-selected" : ""}${entry.onHead ? "" : " is-off-head"}`} onClick={() => onSelect(entry)}><span className="history-graph-gutter" aria-hidden="true"><GraphGutter node={graphNode} laneCount={laneCount} collapsed={layoutCollapsed} /></span><span className="history-commit-badges">{badges.map((badge) => { const checkout = badge.kind === "branch" ? checkouts.find((candidate) => candidate.branch === badge.label) : null; return <span key={`${badge.kind}:${badge.label}`} className={`history-badge history-badge--${badge.kind}`}>{checkout ? <CheckoutIcon current={checkout.isCurrent} /> : null}{badge.label}</span>; })}{detachedCheckout ? <span className="history-badge history-badge--worktree"><CheckoutIcon current={detachedCheckout.isCurrent} />detached</span> : null}</span><span className="history-commit-subject">{entry.subject}</span><span className="history-commit-author">{entry.authorName}</span><span className="history-commit-sha">{entry.shortHash}</span><span className="history-commit-time">{formatCommitTime(entry.authorAt)}</span></button>;
}

function HistoryPanel({ ctx }: HistoryPanelProps) {
  const contextKey = pathContextKey(ctx.theaterId, ctx.pathContext.relPath);

  return <HistoryPanelBody key={contextKey} ctx={ctx} />;
}

function HistoryPanelBody({ ctx }: HistoryPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedCommit, setSelectedCommit] = useState<CommitSelection | null>(null);
  const [filterText, setFilterText] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const fetchSeqRef = useRef(0);
  const subPath = ctx.pathContext.relPath ?? "";

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "ok", commits: [], checkouts: [], truncated: false });
      return;
    }
    const sequence = ++fetchSeqRef.current;
    setState({ kind: "loading" });
    ctx.api.fetch("diff", "log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, subPath }) }).then(async (response) => {
      if (sequence !== fetchSeqRef.current) return;
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        setState({ kind: "error", message: payload.error ?? "unknown" });
        return;
      }
      const data = await response.json() as LogResult;
      if (sequence === fetchSeqRef.current) setState({ kind: "ok", commits: data.commits, checkouts: data.checkouts, truncated: data.truncated ?? false });
    }).catch((error: unknown) => {
      if (sequence === fetchSeqRef.current) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
  }, [ctx.api, ctx.theaterId, refreshToken, subPath]);

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(selectedCommit ? EXTENDED_EXTRA_WIDTH : null);
    return () => ctx.requestExtraWidth?.(null);
  }, [ctx.requestExtraWidth, selectedCommit]);

  const handleSelectCommit = useCallback((entry: LogCommitEntry) => {
    if (ctx.theaterId) setSelectedCommit({ commit: entry, subPath, theaterId: ctx.theaterId });
  }, [ctx.theaterId, subPath]);
  const visibleCommits = useMemo(() => state.kind === "ok" ? filterHistoryCommits(state.commits, filterText) : [], [filterText, state]);
  const layout = state.kind === "ok" ? layoutGraph(visibleCommits) : null;
  const countLabel = state.kind === "ok" ? filterText ? `${visibleCommits.length}/${state.commits.length}` : String(state.commits.length) : null;
  return <div className={`history-root${selectedCommit ? " has-detail" : ""}`}>{selectedCommit ? <div className="history-detail-pane"><div className="history-detail-head"><span className="history-detail-sha">{selectedCommit.commit.shortHash}</span><span className="history-detail-subject">{selectedCommit.commit.subject}</span><button type="button" className="history-detail-close" aria-label="Close commit diff" onClick={() => setSelectedCommit(null)}>✕</button></div><div className="history-detail-body"><HunkView ctx={ctx} file={{ path: "", status: "M", additions: 0, deletions: 0 }} mode="unified" subPath={selectedCommit.subPath} commit={selectedCommit} /></div></div> : null}<div className="history-list-pane"><div className="history-toolbar"><div className="history-filter"><input type="text" className="history-filter-input" placeholder="Filter…" aria-label="Filter commits" value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText ? <button type="button" className="history-filter-clear" aria-label="Clear filter" onClick={() => setFilterText("")}>✕</button> : null}</div>{countLabel ? <span className="history-count">{countLabel}</span> : null}</div><div className="history-list">{state.kind === "loading" ? <div className="history-empty">Loading…</div> : null}{state.kind === "error" ? <div className="history-error"><span>{state.message}</span><button type="button" className="diff-refresh-btn" onClick={() => setRefreshToken((value) => value + 1)}>Retry</button></div> : null}{state.kind === "ok" && state.commits.length === 0 ? <div className="history-empty">No history</div> : null}{state.kind === "ok" && state.commits.length > 0 && visibleCommits.length === 0 ? <div className="history-empty">No matching items</div> : null}{state.kind === "ok" && layout ? visibleCommits.map((entry, index) => <CommitRow key={entry.fullHash} entry={entry} checkouts={state.checkouts} selected={selectedCommit?.commit.fullHash === entry.fullHash} graphNode={layout.nodes[index]!} laneCount={layout.activeLaneCount} layoutCollapsed={layout.collapsed} onSelect={handleSelectCommit} />) : null}{state.kind === "ok" && (state.truncated || state.commits.length >= 200) ? <div className="history-truncated">History capped at 200 commits.</div> : null}</div></div></div>;
}

function HistoryIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 3v12M10 7v8M14 11v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><path d="M5 7c1.8 0 2.4 0 5 0M10 11c1.4 0 2.2 0 4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

export const historyPanel: RailPanelDescriptor = {
  id: "history",
  title: "History",
  icon: () => <HistoryIcon />,
  pathAware: true,
  render: (ctx: RailPanelContext) => <HistoryPanel ctx={ctx} />,
};
