import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffFileMode, DiffListResult } from "../server/types.js";
import "./repository.css";
import { ChangedFiles, type ChangedFilesState } from "./changed-files.js";
import { pathContextKey } from "./context-key.js";
import { clearSelectedFile, setSelectedFile, type SelectedFile, useSelectedFile } from "./repository-view-store.js";
import { HunkView } from "./hunk-view.js";
import { HistoryPanel } from "./history-panel.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth } from "./rail-layout.js";

type ViewMode = "list" | "tree";

interface RepositoryPanelProps {
  readonly ctx: RailPanelContext;
}

const PREFS_VIEW_MODE = "fleet-console.diff.viewMode";
const PREFS_LIST_PANE_WIDTH = "fleet-console.diff.listPaneWidth";
const PREFS_SOURCE = "fleet-console.repository.source";
const EXTENDED_EXTRA_WIDTH = 400;
const LIST_PANE_DEFAULT_WIDTH = 248;
const LIST_PANE_MIN_WIDTH = 220;

function readViewMode(): ViewMode {
  try {
    const value = localStorage.getItem(PREFS_VIEW_MODE);
    if (value === "list" || value === "tree") return value;
  } catch { /* ignore */ }
  return "list";
}

export function readRepositorySource(): Source {
  try {
    const value = localStorage.getItem(PREFS_SOURCE);
    if (value === "changes" || value === "history" || value === "branches" || value === "tags" || value === "stashes" || value === "worktrees") return value;
  } catch { /* ignore */ }
  return "changes";
}

function saveRepositorySource(source: Source): void {
  try { localStorage.setItem(PREFS_SOURCE, source); } catch { /* ignore */ }
}

function readListPaneWidth(): number {
  try {
    const value = localStorage.getItem(PREFS_LIST_PANE_WIDTH);
    const width = value === null ? NaN : Number.parseFloat(value);
    if (Number.isFinite(width) && width > 0) return Math.max(LIST_PANE_MIN_WIDTH, width);
  } catch { /* ignore */ }
  return LIST_PANE_DEFAULT_WIDTH;
}

function getHunkMode(selected: SelectedFile): DiffFileMode {
  return selected.entry.status === "U" ? "untracked" : "unified";
}

function RepositoryPanel({ ctx }: RepositoryPanelProps) {
  const contextKey = pathContextKey(ctx.theaterId, ctx.pathContext.relPath);

  return <RepositoryPanelBody key={contextKey} ctx={ctx} />;
}

type Source = "changes" | "history" | "branches" | "tags" | "stashes" | "worktrees";
type RepositoryWorktree = { name: string; branch: string | null; current: boolean };
type RefItem = { label: string; ref: string; current: boolean };
type Refs = { branches: RefItem[]; remotes: RefItem[]; tags: RefItem[]; stashes: { name: string; subject: string }[]; worktrees: RepositoryWorktree[] };
function RepositoryPanelBody({ ctx }: RepositoryPanelProps) {
  const [source, setSourceState] = useState<Source>(readRepositorySource);
  const [refFilter, setRefFilter] = useState<string | null>(null);
  const [refs, setRefs] = useState<Refs>({ branches: [], remotes: [], tags: [], stashes: [], worktrees: [] });
  const [refsError, setRefsError] = useState(false); const [refsRetry, setRefsRetry] = useState(0);
  const [changedFiles, setChangedFiles] = useState<ChangedFilesState>({ kind: "loading" });
  const [changedFilesRetry, setChangedFilesRetry] = useState(0);
  const [historyInspectorOpen, setHistoryInspectorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [filterText, setFilterText] = useState("");
  const subPath = ctx.pathContext.relPath ?? "";
  const selectedFile = useSelectedFile(ctx.theaterId ?? null, subPath);
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const listPaneWidthRef = useRef(listPaneWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const setSource = useCallback((next: Source) => {
    setSourceState(next);
    saveRepositorySource(next);
  }, []);
  useEffect(() => { if (!ctx.theaterId) return; let cancelled = false; setRefsError(false); ctx.api.fetch("repository", "refs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, subPath }) }).then((r) => r.ok ? r.json() as Promise<Refs> : Promise.reject()).then((value) => { if (!cancelled) setRefs(value); }).catch(() => { if (!cancelled) setRefsError(true); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, subPath, refsRetry]);
  useEffect(() => {
    if (!ctx.theaterId) {
      setChangedFiles({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setChangedFiles({ kind: "loading" });
    // api.fetch(assertSafeResponse)는 non-2xx에서 payload를 버리고 throw하므로,
    // no_git_repo/git_unavailable 안내 매핑을 위해 원래의 raw fetch 경로를 유지한다
    fetch("/plugins/repository/changed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, subPath }) }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        const code = payload.error ?? "git_failed";
        if (!cancelled) setChangedFiles(code === "no_git_repo" || code === "git_unavailable" ? { kind: "notice", reason: code } : { kind: "error", message: code });
        return;
      }
      const data = await response.json() as DiffListResult;
      if (!cancelled) setChangedFiles({ kind: "ok", files: data.files });
    }).catch((error: unknown) => {
      if (!cancelled) setChangedFiles({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [changedFilesRetry, ctx.theaterId, subPath]);

  useLayoutEffect(() => () => clearSelectedFile(), []);

  const handleSelectFile = useCallback((entry: DiffFileEntry) => {
    if (ctx.theaterId) setSelectedFile(entry, subPath, ctx.theaterId);
  }, [ctx.theaterId, subPath]);
  const handleCloseHunk = useCallback(() => clearSelectedFile(), []);
  const handleViewMode = useCallback((next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(PREFS_VIEW_MODE, next); } catch { /* ignore */ }
  }, []);
  const handleDividerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const startWidth = listPaneWidthRef.current;
    setIsDragging(true);
    const onMove = (move: PointerEvent) => {
      const next = clampListPaneWidth({ startWidth, dx: move.clientX - startX, containerWidth, listPaneMinWidth: LIST_PANE_MIN_WIDTH, hunkPaneMinWidth: HUNK_PANE_MIN_WIDTH, dividerWidth: DIFF_DIVIDER_WIDTH });
      if (next !== null) {
        listPaneWidthRef.current = next;
        setListPaneWidth(next);
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
      try { localStorage.setItem(PREFS_LIST_PANE_WIDTH, String(listPaneWidthRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.((source === "changes" && selectedFile) || (source === "history" && historyInspectorOpen) ? EXTENDED_EXTRA_WIDTH : null);
    return () => ctx.requestExtraWidth?.(null);
  }, [ctx.requestExtraWidth, selectedFile, source, historyInspectorOpen]);

  const hunkMode = selectedFile ? getHunkMode(selectedFile) : null;
  const retryChangedFiles = useCallback(() => setChangedFilesRetry((value) => value + 1), []);
  const wipFiles = changedFiles.kind === "ok" ? changedFiles.files : [];
  return (
    <div className="repository-unified"><SourceNav source={source} refs={refs} onSource={setSource} onRef={(ref) => { setRefFilter(ref); setSource("history"); }} /><div className="repository-source-content">
      <div hidden={source !== "history"}><HistoryPanel ctx={ctx} active={source === "history"} refFilter={refFilter} wipFiles={wipFiles} onInspectorOpenChange={setHistoryInspectorOpen} onClearRef={() => setRefFilter(null)} onWip={() => setSource("changes")} /></div>
      {source !== "changes" && source !== "history" ? refsError ? <div className="history-error">Unable to load refs<button type="button" className="repository-refresh-btn" onClick={() => setRefsRetry((value) => value + 1)}>Retry</button></div> : <RefList source={source} refs={refs} onRef={(ref) => { setRefFilter(ref); setSource("history"); }} /> : null}
      <div hidden={source !== "changes"} ref={rootRef} className={`repository-root${selectedFile ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={selectedFile ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
      {selectedFile && hunkMode ? <div className="repository-hunk-pane"><div className="repository-hunk-head"><span>{selectedFile.entry.path}</span><button type="button" onClick={handleCloseHunk}>✕</button></div><HunkView ctx={ctx} file={selectedFile.entry} mode={hunkMode} subPath={selectedFile.subPath} /></div> : null}
      {selectedFile ? <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" /> : null}
      <div className="repository-list-pane">
        <div className="repository-toolbar"><div className="repository-filter"><input type="text" className="repository-filter-input" placeholder="Filter…" aria-label="Filter changed files" value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText ? <button type="button" className="repository-filter-clear" aria-label="Clear filter" onClick={() => setFilterText("")}>✕</button> : null}</div><div className="repository-view-toggle"><button type="button" className={`repository-toggle-btn${viewMode === "list" ? " is-active" : ""}`} title="List view" aria-pressed={viewMode === "list"} onClick={() => handleViewMode("list")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button type="button" className={`repository-toggle-btn${viewMode === "tree" ? " is-active" : ""}`} title="Tree view" aria-pressed={viewMode === "tree"} onClick={() => handleViewMode("tree")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg></button></div></div>
        <ChangedFiles state={changedFiles} onRetry={retryChangedFiles} viewMode={viewMode} selectedPath={selectedFile?.entry.path ?? null} onSelect={handleSelectFile} filterText={filterText} />
      </div>
      </div></div></div>
  );
}

function SourceIcon({ source }: { readonly source: Source }) { const path = source === "changes" ? "M3 4h12M3 9h12M3 14h12" : source === "history" ? "M4 4v10h10M7 7h6v5" : source === "branches" ? "M5 3v12M5 6h7M5 12h7" : source === "tags" ? "M3 4h8l4 4-7 7-5-5z" : source === "stashes" ? "M4 5h10v9H4zM6 3h6" : "M3 5h5l1 2h6v7H3z"; return <svg viewBox="0 0 18 18" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function SourceNav({ source, refs, onSource }: { readonly source: Source; readonly refs: Refs; readonly onSource: (source: Source) => void; readonly onRef: (ref: string) => void }) { const button = (id: Source, label: string, count?: number) => <button key={id} type="button" aria-label={label} aria-current={source === id ? "page" : undefined} onClick={() => onSource(id)}><SourceIcon source={id} /><span>{label}</span>{count !== undefined && <i>{count}</i>}</button>; return <nav className="repository-source-nav" aria-label="Repository sources"><b>WORKING</b>{button("changes", "Changes")}{button("history", "History")}<b>REFS</b>{button("branches", "Branches", refs.branches.length + refs.remotes.length)}{button("tags", "Tags", refs.tags.length)}{button("stashes", "Stashes", refs.stashes.length)}{button("worktrees", "Worktrees", refs.worktrees.length)}</nav>; }
function RefList({ source, refs, onRef }: { readonly source: Source; readonly refs: Refs; readonly onRef: (ref: string) => void }) { const rows = source === "branches" ? [...refs.branches, ...refs.remotes] : source === "tags" ? refs.tags : source === "stashes" ? refs.stashes.map((item) => ({ label: `${item.name} ${item.subject}`, ref: "", current: false })) : refs.worktrees.map((item) => ({ label: item.branch ?? item.name, ref: "", current: item.current })); return <div className="repository-ref-list">{rows.map((row) => <button type="button" key={row.ref || row.label} className={row.current ? "is-current" : ""} disabled={!row.ref} onClick={() => onRef(row.ref)}>{row.label}{row.current && " ✓"}</button>)}</div>; }

function RepositoryIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" /><rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" /></svg>;
}

export const repositoryPanel: RailPanelDescriptor = {
  id: "repository",
  title: "Repository",
  icon: () => <RepositoryIcon />,
  pathAware: true,
  render: (ctx: RailPanelContext) => <RepositoryPanel ctx={ctx} />,
};
