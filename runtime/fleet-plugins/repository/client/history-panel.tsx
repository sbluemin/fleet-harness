import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { CommitResult, DiffFileEntry, LogCommitEntry, LogResult, WorktreeCheckout } from "../server/types.js";
import { FileRow } from "./changed-files.js";
import { DiffTreeView } from "./repository-tree.js";
import { GraphGutter } from "./graph-gutter.js";
import { layoutGraph } from "./graph-layout.js";
import { HunkView } from "./hunk-view.js";
import { formatCommitTime, refBadges } from "./log-parse.js";
import { DIFF_DIVIDER_WIDTH, HISTORY_DETAIL_PANE_MIN_HEIGHT, HISTORY_LOG_PANE_MIN_HEIGHT, buildHistoryStackTemplate, buildInspectorChangesGridTemplate, buildInspectorDetailsGridTemplate, clampSplitPaneSize, installPointerDragLifecycle } from "./rail-layout.js";
import { buildWorkspaceDockTemplate, clampWorkspaceDockHeight, normalizeWorkspaceDockHeight, readWorkspaceDockHeight, saveWorkspaceDockHeight } from "./workspace-layout.js";

type LoadState = { readonly kind: "loading" } | { readonly kind: "ok"; readonly commits: readonly LogCommitEntry[]; readonly checkouts: readonly WorktreeCheckout[]; readonly truncated: boolean } | { readonly kind: "error"; readonly message: string };
type CommitTarget = { readonly fullHash: string; readonly entry?: LogCommitEntry };
type InspectorState = { readonly kind: "loading" } | { readonly kind: "ok"; readonly result: CommitResult } | { readonly kind: "error"; readonly message: string };
type FilesViewMode = "list" | "tree";

const PREFS_LOG_PANE_HEIGHT = "fleet-console.history.logHeight";
const PREFS_HEADER_HEIGHT = "fleet-console.history.headerHeight";
const PREFS_FILE_LIST_WIDTH = "fleet-console.history.fileListWidth";
const PREFS_FILES_VIEW = "fleet-console.history.filesView";
const LOG_PANE_DEFAULT_HEIGHT = 240;
const HEADER_DEFAULT_HEIGHT = 214;
const FILE_LIST_DEFAULT_WIDTH = 180;

export function findDetachedCheckout(entry: LogCommitEntry, checkouts: readonly WorktreeCheckout[]): WorktreeCheckout | null { return checkouts.find((checkout) => checkout.branch === null && checkout.sha === entry.fullHash) ?? null; }
export function filterHistoryCommits(commits: readonly LogCommitEntry[], filterText: string): readonly LogCommitEntry[] {
  const value = filterText.toLowerCase();
  return value ? commits.filter((entry) => entry.subject.toLowerCase().includes(value) || entry.authorName.toLowerCase().includes(value) || entry.shortHash.toLowerCase().includes(value) || entry.fullHash.toLowerCase().includes(value) || entry.refs.some((ref) => ref.toLowerCase().includes(value)) || refBadges(entry).some((badge) => badge.label.toLowerCase().includes(value))) : commits;
}

export function isInspectorDismissKey(key: string): boolean { return key === "Escape"; }
export function aggregateWip(files: readonly DiffFileEntry[]): { files: number; additions: number; deletions: number } { return files.reduce((sum, file) => ({ files: sum.files + 1, additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { files: 0, additions: 0, deletions: 0 }); }
export function shouldShowWip(wip: { readonly files: number }, filterText: string, refFilter: string | null): boolean { return wip.files > 0 && !filterText && !refFilter; }

function CheckoutIcon({ current }: { readonly current: boolean }) { return current ? <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L5 8.7L9.5 3.5" stroke="currentColor" strokeWidth="1.5" /></svg> : <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M1.5 3.4h3l1 1.1h5v5.1a.9.9 0 01-.9.9H2.4a.9.9 0 01-.9-.9V4.3a.9.9 0 01.9-.9z" stroke="currentColor" strokeWidth="1.2" /></svg>; }

function CommitRow({ entry, checkouts, selected, graphNode, onSelect }: { readonly entry: LogCommitEntry; readonly checkouts: readonly WorktreeCheckout[]; readonly selected: boolean; readonly graphNode: import("./graph-layout.js").GraphNode; readonly onSelect: (entry: LogCommitEntry) => void }) {
  const badges = refBadges(entry); const detached = findDetachedCheckout(entry, checkouts);
  // Fork 문법: refs 뱃지는 제목 왼쪽(그래프 바로 뒤)에서 커밋의 정체를 먼저 알린다.
  return <button type="button" className={`history-commit-row${selected ? " is-selected" : ""}${entry.onHead ? "" : " is-off-head"}`} onClick={() => onSelect(entry)}><span className="history-commit-badges">{badges.map((badge) => { const checkout = badge.kind === "branch" ? checkouts.find((item) => item.branch === badge.label) : null; return <span key={`${badge.kind}:${badge.label}`} className={`history-badge history-badge--${badge.kind}`}>{checkout && <CheckoutIcon current={checkout.isCurrent} />}{badge.label}</span>; })}{detached && <span className="history-badge history-badge--worktree"><CheckoutIcon current={detached.isCurrent} />detached</span>}</span><span className="history-commit-subject">{entry.subject}</span><span className="history-commit-sha">{entry.shortHash}</span><span className="history-commit-time">{formatCommitTime(entry.authorAt)}</span><span className="history-graph-gutter" aria-hidden="true"><GraphGutter node={graphNode} /></span></button>;
}

function CommitInspector({ ctx, repoRel, target, workspace, onSelectCommit, onClose }: { readonly ctx: RailPanelContext; readonly repoRel: string; readonly target: CommitTarget; readonly workspace: boolean; readonly onSelectCommit: (target: CommitTarget) => void; readonly onClose: () => void }) {
  const [state, setState] = useState<InspectorState>({ kind: "loading" }); const [tab, setTab] = useState<"details" | "changes">("details"); const [selectedPath, setSelectedPath] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(() => readSize(PREFS_HEADER_HEIGHT, HEADER_DEFAULT_HEIGHT)); const [fileListWidth, setFileListWidth] = useState(() => readSize(PREFS_FILE_LIST_WIDTH, FILE_LIST_DEFAULT_WIDTH));
  const [filesView, setFilesView] = useState<FilesViewMode>(readFilesViewMode);
  const detailsRef = useRef<HTMLDivElement>(null); const changesRef = useRef<HTMLDivElement>(null); const disposeRef = useRef<(() => void) | null>(null); const headerHeightRef = useRef(headerHeight); const fileListWidthRef = useRef(fileListWidth);
  const commit = useMemo(() => ({ fullHash: target.fullHash, theaterId: ctx.theaterId ?? "", repoRel }), [target.fullHash, ctx.theaterId, repoRel]);
  useEffect(() => { let cancelled = false; setState({ kind: "loading" }); ctx.api.fetch("repository", "commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ref: target.fullHash }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed"); return response.json() as Promise<CommitResult>; }).then((result) => { if (!cancelled) { setState({ kind: "ok", result }); setSelectedPath(result.files[0]?.path ?? null); } }).catch((error: unknown) => { if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" }); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, repoRel, target.fullHash]);
  useEffect(() => () => disposeRef.current?.(), []);
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, axis: "x" | "y") => { event.preventDefault(); const container = axis === "y" ? detailsRef.current : changesRef.current; if (!container) return; const start = axis === "y" ? headerHeightRef.current : fileListWidthRef.current; const startPointer = axis === "y" ? event.clientY : event.clientX; const size = axis === "y" ? container.getBoundingClientRect().height : container.getBoundingClientRect().width; disposeRef.current?.(); disposeRef.current = installPointerDragLifecycle({ documentTarget: document, windowTarget: window, onMove: (moveEvent) => { const move = moveEvent as PointerEvent; const next = clampSplitPaneSize(start, (axis === "y" ? move.clientY : move.clientX) - startPointer, size, 120, 120); if (next !== null) { if (axis === "y") { headerHeightRef.current = next; setHeaderHeight(next); } else { fileListWidthRef.current = next; setFileListWidth(next); } } }, onFinish: () => { const value = axis === "y" ? headerHeightRef.current : fileListWidthRef.current; try { localStorage.setItem(axis === "y" ? PREFS_HEADER_HEIGHT : PREFS_FILE_LIST_WIDTH, String(value)); } catch { /* ignore */ } disposeRef.current = null; } }); }, []);
  const content = state.kind === "loading" ? <div className="history-inspector-empty">Loading commit…</div> : state.kind === "error" ? <div className="history-inspector-empty history-inspector-error">{state.message}</div> : (() => {
    const { meta, files } = state.result;
    const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const entry = target.entry;
    const chooseFile = (file: DiffFileEntry, showChanges: boolean) => {
      setSelectedPath(file.path);
      if (showChanges) setTab("changes");
    };
    const chooseFilesView = (next: FilesViewMode) => {
      setFilesView(next);
      try { localStorage.setItem(PREFS_FILES_VIEW, next); } catch { /* ignore */ }
    };
    const copySha = () => {
      const copiedPromise = navigator.clipboard?.writeText(target.fullHash);
      if (!copiedPromise) return;
      void copiedPromise.then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }).catch(() => undefined);
    };
    if (workspace) {
      return <div className="repository-ws-dock">
        <CommitFiles files={files} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, false)} />
        <div className="repository-ws-dock-main">
          <div className="repository-ws-dock-meta">
            <CommitHeader meta={meta} entry={entry} fullHash={target.fullHash} copied={copied} onCopy={copySha} onParent={(full) => onSelectCommit({ fullHash: full })} />
            <button type="button" className="history-detail-close repository-ws-dock-close" aria-label="Close inspector" title="Close inspector" onClick={onClose}>✕</button>
          </div>
          {selectedFile ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={selectedFile.path}>{selectedFile.path}</span><div><button type="button" aria-label="Previous file" disabled={files.indexOf(selectedFile) === 0} onClick={() => chooseFile(files[files.indexOf(selectedFile) - 1]!, false)}>‹</button><button type="button" aria-label="Next file" disabled={files.indexOf(selectedFile) === files.length - 1} onClick={() => chooseFile(files[files.indexOf(selectedFile) + 1]!, false)}>›</button></div></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile} mode="unified" commit={commit} /></div> : <div className="history-inspector-empty">No changed files</div>}
        </div>
      </div>;
    }
    return tab === "details" ? <div ref={detailsRef} className="history-details-tab" style={{ gridTemplateRows: buildInspectorDetailsGridTemplate(headerHeight) }}><CommitHeader meta={meta} entry={entry} fullHash={target.fullHash} copied={copied} onCopy={copySha} onParent={(full) => onSelectCommit({ fullHash: full })} /><div className="history-divider history-divider--horizontal" onPointerDown={(event) => startDrag(event, "y")} /><CommitFiles files={files} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, true)} /></div> : <div className="history-changes-tab"><div ref={changesRef} className="history-changes-columns" style={{ gridTemplateColumns: buildInspectorChangesGridTemplate(fileListWidth) }}><CommitFiles files={files} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, false)} /><div className="history-divider" onPointerDown={(event) => startDrag(event, "x")} />{selectedFile ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={selectedFile.path}>{selectedFile.path}</span><div><button type="button" aria-label="Previous file" disabled={files.indexOf(selectedFile) === 0} onClick={() => chooseFile(files[files.indexOf(selectedFile) - 1]!, false)}>‹</button><button type="button" aria-label="Next file" disabled={files.indexOf(selectedFile) === files.length - 1} onClick={() => chooseFile(files[files.indexOf(selectedFile) + 1]!, false)}>›</button></div></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile} mode="unified" commit={commit} /></div> : <div className="history-inspector-empty">No changed files</div>}</div></div>;
  })();
  return <div className={`history-inspector${workspace ? " repository-ws-inspector" : ""}`} onKeyDown={(event) => { if (isInspectorDismissKey(event.key)) { event.preventDefault(); onClose(); } }}>{workspace ? content : <><div className="history-segmented"><button type="button" aria-pressed={tab === "details"} onClick={() => setTab("details")}>Details</button><button type="button" aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>Changes {state.kind === "ok" && <span>{state.result.files.length}</span>}</button><button type="button" className="history-detail-close history-inspector-close" aria-label="Close inspector" title="Close inspector" onClick={onClose}>✕</button></div>{content}</>}</div>;
}

function CommitHeader({ meta, entry, fullHash, copied, onCopy, onParent }: { readonly meta: CommitResult["meta"]; readonly entry?: LogCommitEntry; readonly fullHash: string; readonly copied: boolean; readonly onCopy: () => void; readonly onParent: (full: string) => void }) { return <div className="history-inspector-head"><div className="history-inspector-subject">{meta.subject}</div>{meta.body && <pre className="history-inspector-message">{meta.body}</pre>}<div className="history-author"><span className="history-avatar">{initials(meta.authorName)}</span><span><b>{meta.authorName}</b><small>{meta.authorEmail}</small></span><time title={new Date(meta.authorAt * 1000).toLocaleString()}>{entry?.relTime ?? formatCommitTime(meta.authorAt)}</time></div><div className="history-inspector-ids"><button type="button" className={`history-sha-copy${copied ? " is-copied" : ""}`} onClick={onCopy}>{fullHash}<span>{copied ? "copied" : "copy"}</span></button>{meta.parents.map((parent) => <button type="button" className="history-parent" key={parent.full} onClick={() => onParent(parent.full)}>parent {parent.short}</button>)}</div>{entry && <div className="history-ref-chips">{refBadges(entry).map((badge) => <span key={`${badge.kind}:${badge.label}`} className={`history-badge history-badge--${badge.kind}`}>{badge.label}</span>)}</div>}</div>; }
function CommitFiles({ files, selectedPath, additions, deletions, viewMode, onViewMode, onSelect }: { readonly files: readonly DiffFileEntry[]; readonly selectedPath: string | null; readonly additions: number; readonly deletions: number; readonly viewMode: FilesViewMode; readonly onViewMode: (mode: FilesViewMode) => void; readonly onSelect: (file: DiffFileEntry) => void }) { return <section className="history-commit-files"><div className="history-files-title"><span className="history-files-label">Changed files</span><span className="history-files-stats">{files.length} <i>+{additions}</i> <em>−{deletions}</em></span><div className="repository-view-toggle history-files-view-toggle"><button type="button" className={`repository-toggle-btn${viewMode === "list" ? " is-active" : ""}`} title="List view" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => onViewMode("list")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button type="button" className={`repository-toggle-btn${viewMode === "tree" ? " is-active" : ""}`} title="Tree view" aria-label="Tree view" aria-pressed={viewMode === "tree"} onClick={() => onViewMode("tree")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg></button></div></div><div className="history-files-scroll">{viewMode === "tree" ? <DiffTreeView files={files} selectedPath={selectedPath} onSelect={onSelect} /> : files.map((file) => <FileRow key={file.path} entry={file} isSelected={file.path === selectedPath} onSelect={onSelect} />)}</div></section>; }

interface HistoryPanelProps {
  readonly ctx: RailPanelContext;
  readonly repoRel: string;
  readonly active?: boolean;
  readonly refFilter?: string | null;
  readonly wipFiles: readonly DiffFileEntry[];
  readonly workspace?: boolean;
  readonly workspaceMain?: ReactNode;
  readonly workspaceMainVisible?: boolean;
  readonly onInspectorOpenChange?: (open: boolean) => void;
  readonly onClearRef?: () => void;
  readonly onWip?: () => void;
}

export function HistoryPanel({ ctx, repoRel, active = true, refFilter = null, wipFiles, workspace = false, workspaceMain, workspaceMainVisible = false, onInspectorOpenChange, onClearRef, onWip }: HistoryPanelProps) {
  return <HistoryPanelBody key={`${ctx.theaterId ?? ""}:${repoRel}`} ctx={ctx} repoRel={repoRel} active={active} refFilter={refFilter} wipFiles={wipFiles} workspace={workspace} workspaceMain={workspaceMain} workspaceMainVisible={workspaceMainVisible} onInspectorOpenChange={onInspectorOpenChange} onClearRef={onClearRef} onWip={onWip} />;
}

function HistoryPanelBody({ ctx, repoRel, active, refFilter, wipFiles, workspace, workspaceMain, workspaceMainVisible, onInspectorOpenChange, onClearRef, onWip }: Required<Pick<HistoryPanelProps, "active" | "ctx" | "refFilter" | "repoRel" | "wipFiles" | "workspace" | "workspaceMainVisible">> & Pick<HistoryPanelProps, "workspaceMain" | "onInspectorOpenChange" | "onClearRef" | "onWip">) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [target, setTarget] = useState<CommitTarget | null>(null);
  const [filterText, setFilterText] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [logHeight, setLogHeight] = useState(readLogPaneHeight);
  const [dockHeight, setDockHeight] = useState(readWorkspaceDockHeight);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  const logHeightRef = useRef(logHeight);
  const dockHeightRef = useRef(dockHeight);
  useEffect(() => { setTarget(null); }, [refFilter]);
  // 숨은 마운트는 상태 보존용일 뿐이므로, 첫 활성화 전에는 log 조회 비용을 지불하지 않는다
  const [everActive, setEverActive] = useState(active);
  useEffect(() => { if (active) setEverActive(true); }, [active]);
  useEffect(() => { if (!everActive) return; if (!ctx.theaterId) { setState({ kind: "ok", commits: [], checkouts: [], truncated: false }); return; } let cancelled = false; setState({ kind: "loading" }); ctx.api.fetch("repository", "log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ...(refFilter ? { ref: refFilter } : {}) }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed"); return response.json() as Promise<LogResult>; }).then((data) => { if (!cancelled) setState({ kind: "ok", commits: data.commits, checkouts: data.checkouts, truncated: data.truncated ?? false }); }).catch((error: unknown) => { if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" }); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, everActive, refreshToken, refFilter, repoRel]);
  useEffect(() => { onInspectorOpenChange?.(active && target !== null); }, [active, onInspectorOpenChange, target]); useEffect(() => () => dragDisposeRef.current?.(), []);
  // 저장된 dock 높이는 현재 컨테이너 기준으로 정규화해 축소된 창에서 주 영역이 잘리지 않게 한다(저장값 자체는 보존).
  useLayoutEffect(() => {
    if (!workspace || target === null) return;
    const root = rootRef.current;
    if (!root) return;
    const normalize = () => {
      const next = normalizeWorkspaceDockHeight(dockHeightRef.current, root.getBoundingClientRect().height);
      if (next !== dockHeightRef.current) { dockHeightRef.current = next; setDockHeight(next); }
    };
    normalize();
    const observer = new ResizeObserver(normalize);
    observer.observe(root);
    return () => observer.disconnect();
  }, [workspace, target]);
  const handleDivider = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const start = workspace ? dockHeightRef.current : logHeightRef.current;
    const startY = event.clientY;
    const height = root.getBoundingClientRect().height;
    dragDisposeRef.current?.();
    setIsDragging(true);
    dragDisposeRef.current = installPointerDragLifecycle({
      documentTarget: document,
      windowTarget: window,
      onMove: (moveEvent) => {
        const delta = (moveEvent as PointerEvent).clientY - startY;
        const next = workspace
          ? clampWorkspaceDockHeight(start, delta, height)
          : clampSplitPaneSize(start, delta, height, HISTORY_LOG_PANE_MIN_HEIGHT, HISTORY_DETAIL_PANE_MIN_HEIGHT, DIFF_DIVIDER_WIDTH);
        if (next === null) return;
        if (workspace) {
          dockHeightRef.current = next;
          setDockHeight(next);
        } else {
          logHeightRef.current = next;
          setLogHeight(next);
        }
      },
      onFinish: () => {
        if (workspace) saveWorkspaceDockHeight(dockHeightRef.current);
        else {
          try { localStorage.setItem(PREFS_LOG_PANE_HEIGHT, String(logHeightRef.current)); } catch { /* ignore */ }
        }
        setIsDragging(false);
        dragDisposeRef.current = null;
      },
    });
  }, [workspace]);
  const visible = useMemo(() => state.kind === "ok" ? filterHistoryCommits(state.commits, filterText) : [], [filterText, state]); const layout = state.kind === "ok" ? layoutGraph(visible) : null;
  const wip = useMemo(() => aggregateWip(wipFiles), [wipFiles]);
  const showWip = shouldShowWip(wip, filterText, refFilter);
  const stackTemplate = target
    ? workspace ? buildWorkspaceDockTemplate(dockHeight) : buildHistoryStackTemplate(logHeight)
    : undefined;
  return <div ref={rootRef} className={`history-root${workspace ? " repository-ws-history" : ""}${isDragging ? " is-dragging" : ""}`} style={stackTemplate ? { gridTemplateRows: stackTemplate } : undefined}>
    <div className="history-list-pane" hidden={workspace && workspaceMainVisible}>
      <div className="history-toolbar"><div className="history-filter"><input className="history-filter-input" placeholder="Filter…" value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText && <button type="button" className="history-filter-clear" onClick={() => setFilterText("")}>✕</button>}</div>{refFilter && <button type="button" className="repository-ref-chip" onClick={onClearRef}>{refFilter} ✕</button>}{state.kind === "ok" && <span className="history-count">{filterText ? `${visible.length}/${state.commits.length}` : state.commits.length}</span>}</div>
      <div className="history-list">{showWip && <button type="button" className="repository-wip-row" onClick={onWip}>Uncommitted changes <span>{wip.files} files · +{wip.additions} −{wip.deletions}</span></button>}{state.kind === "loading" && <div className="history-empty">Loading…</div>}{state.kind === "error" && <div className="history-error">{state.message}<button type="button" className="repository-refresh-btn" onClick={() => setRefreshToken((value) => value + 1)}>Retry</button></div>}{state.kind === "ok" && state.commits.length === 0 && <div className="history-empty">No history</div>}{state.kind === "ok" && state.commits.length > 0 && visible.length === 0 && <div className="history-empty">No matching items</div>}{state.kind === "ok" && layout && visible.map((entry, index) => <CommitRow key={entry.fullHash} entry={entry} checkouts={state.checkouts} selected={target?.fullHash === entry.fullHash} graphNode={layout.nodes[index]!} onSelect={(selected) => setTarget({ fullHash: selected.fullHash, entry: selected })} />)}{state.kind === "ok" && (state.truncated || state.commits.length >= 200) && <div className="history-truncated">History capped at 200 commits.</div>}</div>
    </div>
    {workspaceMain !== undefined && <div className="repository-ws-main" hidden={!workspaceMainVisible}>{workspaceMain}</div>}
    {target && <><div className="history-divider history-divider--horizontal" role="separator" aria-orientation="horizontal" aria-label={workspace ? "Resize commit detail dock" : "Resize commit log"} onPointerDown={handleDivider} /><div className="history-detail-pane"><CommitInspector ctx={ctx} repoRel={repoRel} target={target} workspace={workspace} onSelectCommit={setTarget} onClose={() => setTarget(null)} /></div></>}
  </div>;
}
function readLogPaneHeight(): number { return readSize(PREFS_LOG_PANE_HEIGHT, LOG_PANE_DEFAULT_HEIGHT, HISTORY_LOG_PANE_MIN_HEIGHT); }
function readFilesViewMode(): FilesViewMode { try { const value = localStorage.getItem(PREFS_FILES_VIEW); if (value === "list" || value === "tree") return value; } catch { /* ignore */ } return "list"; }
function readSize(key: string, fallback: number, minimum = 0): number { try { const value = Number.parseFloat(localStorage.getItem(key) ?? ""); if (Number.isFinite(value) && value >= minimum) return value; } catch { /* ignore */ } return fallback; }
function initials(name: string): string { return name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?"; }
function HistoryIcon() { return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 3v12M10 7v8M14 11v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><path d="M5 7c1.8 0 2.4 0 5 0M10 11c1.4 0 2.2 0 4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>; }
