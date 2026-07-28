import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { CommitResult, DiffFileEntry, LogCommitEntry, LogResult, WorktreeCheckout } from "../server/types.js";
import { FileRow } from "./changed-files.js";
import { DiffTreeView } from "./repository-tree.js";
import { GraphGutter, ROW_HEIGHT } from "./graph-gutter.js";
import { layoutGraph, type GraphLayout, type GraphNode } from "./graph-layout.js";
import { dropHistoryCache, readHistoryCache, writeHistoryCache, type HistoryCacheEntry } from "./history-cache.js";
import { HunkView } from "./hunk-view.js";
import { getT, localeTag, type RepositoryMessageKey } from "./i18n/index.js";
import { formatCommitTime, refBadges } from "./log-parse.js";
import { DIFF_DIVIDER_WIDTH, HISTORY_DETAIL_PANE_MIN_HEIGHT, HISTORY_LOG_PANE_MIN_HEIGHT, buildHistoryStackTemplate, buildInspectorChangesGridTemplate, buildInspectorDetailsGridTemplate, clampSplitPaneSize, installPointerDragLifecycle } from "./rail-layout.js";
import { buildWorkspaceDockTemplate, clampWorkspaceDockHeight, normalizeWorkspaceDockHeight, readWorkspaceDockHeight, saveWorkspaceDockHeight } from "./workspace-layout.js";
import { consumeRepositorySearchTarget, useRepositorySearchTarget } from "./search-navigation.js";

type T = Translate<RepositoryMessageKey>;

export type HistoryOkState = { readonly kind: "ok"; readonly commits: readonly LogCommitEntry[]; readonly checkouts: readonly WorktreeCheckout[]; readonly hasMore: boolean; readonly truncated: boolean };
type LoadState = { readonly kind: "loading" } | HistoryOkState | { readonly kind: "error"; readonly message: string };
type CommitTarget = { readonly fullHash: string; readonly entry?: LogCommitEntry };
type InspectorState = { readonly kind: "loading" } | { readonly kind: "ok"; readonly result: CommitResult } | { readonly kind: "error"; readonly message: string };
type FilesViewMode = "list" | "tree";
type HistoryCacheRestore = { readonly state: HistoryOkState; readonly target: CommitTarget | null; readonly filterText: string; readonly scrollTop: number };

function readHistoryCacheRestore(historyCacheKey: string, pendingSearchTargetHash: string | null): HistoryCacheRestore | null {
  const entry = readHistoryCache(historyCacheKey);
  if (!entry || (pendingSearchTargetHash && !entry.commits.some((commit) => commit.fullHash === pendingSearchTargetHash))) return null;
  return buildHistoryCacheRestore(entry);
}

function buildHistoryCacheRestore(entry: HistoryCacheEntry): HistoryCacheRestore {
  const targetEntry = entry.targetHash ? entry.commits.find((commit) => commit.fullHash === entry.targetHash) : undefined;
  return {
    state: { kind: "ok", commits: entry.commits, checkouts: entry.checkouts, hasMore: entry.hasMore, truncated: entry.truncated },
    target: entry.targetHash ? { fullHash: entry.targetHash, entry: targetEntry } : null,
    filterText: entry.filterText,
    scrollTop: entry.scrollTop,
  };
}

export interface HistoryLoadGeneration {
  readonly theaterId: string | null | undefined;
  readonly repoRel: string;
  readonly refFilter: string | null;
  readonly refreshToken: number;
}

const PREFS_LOG_PANE_HEIGHT = "fleet-console.history.logHeight";
const PREFS_HEADER_HEIGHT = "fleet-console.history.headerHeight";
const PREFS_FILE_LIST_WIDTH = "fleet-console.history.fileListWidth";
const PREFS_FILES_VIEW = "fleet-console.history.filesView";
const LOG_PANE_DEFAULT_HEIGHT = 240;
const HEADER_DEFAULT_HEIGHT = 214;
const FILE_LIST_DEFAULT_WIDTH = 180;
const HISTORY_OVERSCAN_ROWS = 8;
const HISTORY_PAGE_SIZE = 200;

export interface HistoryWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
}

export interface HistoryWindowRow {
  readonly entry: LogCommitEntry;
  readonly graphNode: GraphNode;
  readonly visibleIndex: number;
  readonly commitIndex: number;
}

export function calculateHistoryWindow(itemCount: number, scrollTop: number, viewportHeight: number): HistoryWindow {
  const safeItemCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const maxScrollTop = Math.max(0, safeItemCount * ROW_HEIGHT - safeViewportHeight);
  const safeScrollTop = Math.min(Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0, maxScrollTop);
  const startIndex = Math.max(0, Math.floor(safeScrollTop / ROW_HEIGHT) - HISTORY_OVERSCAN_ROWS);
  const endIndex = Math.min(safeItemCount, Math.max(startIndex, Math.ceil((safeScrollTop + safeViewportHeight) / ROW_HEIGHT) + HISTORY_OVERSCAN_ROWS));
  return {
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * ROW_HEIGHT,
    bottomSpacerHeight: Math.max(0, (safeItemCount - endIndex) * ROW_HEIGHT),
  };
}

export function isHistoryGenerationCurrent(request: HistoryLoadGeneration, current: HistoryLoadGeneration): boolean {
  return request.theaterId === current.theaterId
    && request.repoRel === current.repoRel
    && request.refFilter === current.refFilter
    && request.refreshToken === current.refreshToken;
}

export function appendHistoryPage(
  current: HistoryOkState,
  data: LogResult,
  requestGeneration: HistoryLoadGeneration,
  currentGeneration: HistoryLoadGeneration,
): HistoryOkState | null {
  if (!isHistoryGenerationCurrent(requestGeneration, currentGeneration)) return null;
  const existing = new Set(current.commits.map((commit) => commit.fullHash));
  // Offset 페이지 사이에서 ref가 움직이면 중복뿐 아니라 누락도 생길 수 있다. 여기서는 React key와
  // 그래프 인덱스 훼손을 막기 위해 중복 hash만 제거하며, 누락 해결에는 서버 커서가 별도로 필요하다.
  const appended = data.commits.filter((commit) => !existing.has(commit.fullHash));
  return {
    kind: "ok",
    commits: [...current.commits, ...appended],
    checkouts: data.checkouts,
    hasMore: data.hasMore,
    truncated: current.truncated || (data.truncated ?? false),
  };
}

export function getHistoryWindowRows(
  commitIndexes: ReadonlyMap<string, number>,
  visible: readonly LogCommitEntry[],
  layout: GraphLayout,
  window: HistoryWindow,
): readonly HistoryWindowRow[] {
  return visible.slice(window.startIndex, window.endIndex).map((entry, offset) => {
    const commitIndex = commitIndexes.get(entry.fullHash);
    if (commitIndex === undefined) throw new Error(`History commit missing from graph layout: ${entry.fullHash}`);
    return {
      entry,
      graphNode: layout.nodes[commitIndex]!,
      visibleIndex: window.startIndex + offset,
      commitIndex,
    };
  });
}

export function findDetachedCheckout(entry: LogCommitEntry, checkouts: readonly WorktreeCheckout[]): WorktreeCheckout | null { return checkouts.find((checkout) => checkout.branch === null && checkout.sha === entry.fullHash) ?? null; }
export function filterHistoryCommits(commits: readonly LogCommitEntry[], filterText: string): readonly LogCommitEntry[] {
  const value = filterText.toLowerCase();
  return value ? commits.filter((entry) => entry.subject.toLowerCase().includes(value) || entry.authorName.toLowerCase().includes(value) || entry.shortHash.toLowerCase().includes(value) || entry.fullHash.toLowerCase().includes(value) || entry.refs.some((ref) => ref.toLowerCase().includes(value)) || refBadges(entry).some((badge) => badge.label.toLowerCase().includes(value))) : commits;
}

export function isInspectorDismissKey(key: string): boolean { return key === "Escape"; }
export function aggregateWip(files: readonly DiffFileEntry[]): { files: number; additions: number; deletions: number } { return files.reduce((sum, file) => ({ files: sum.files + 1, additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { files: 0, additions: 0, deletions: 0 }); }
export function shouldShowWip(wip: { readonly files: number }, filterText: string, refFilter: string | null): boolean { return wip.files > 0 && !filterText && !refFilter; }

function CheckoutIcon({ current }: { readonly current: boolean }) { return current ? <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L5 8.7L9.5 3.5" stroke="currentColor" strokeWidth="1.5" /></svg> : <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M1.5 3.4h3l1 1.1h5v5.1a.9.9 0 01-.9.9H2.4a.9.9 0 01-.9-.9V4.3a.9.9 0 01.9-.9z" stroke="currentColor" strokeWidth="1.2" /></svg>; }

export function CommitRow({ entry, checkouts, selected, graphNode, onSelect, rowRef, locale }: { readonly entry: LogCommitEntry; readonly checkouts: readonly WorktreeCheckout[]; readonly selected: boolean; readonly graphNode: import("./graph-layout.js").GraphNode; readonly onSelect: (entry: LogCommitEntry) => void; readonly rowRef?: (node: HTMLButtonElement | null) => void; readonly locale?: ConsoleLocale }) {
  const t = getT(locale);
  const badges = refBadges(entry); const detached = findDetachedCheckout(entry, checkouts);
  // Fork 문법: refs 뱃지는 제목 왼쪽(그래프 바로 뒤)에서 커밋의 정체를 먼저 알린다.
  return <button ref={rowRef} type="button" className={`history-commit-row${selected ? " is-selected" : ""}${entry.onHead ? "" : " is-off-head"}`} onClick={() => onSelect(entry)}><span className="history-commit-badges">{badges.map((badge) => { const checkout = badge.kind === "branch" ? checkouts.find((item) => item.branch === badge.label) : null; return <span key={`${badge.kind}:${badge.label}`} className={`history-badge history-badge--${badge.kind}`}>{checkout && <CheckoutIcon current={checkout.isCurrent} />}{badge.label}</span>; })}{detached && <span className="history-badge history-badge--worktree"><CheckoutIcon current={detached.isCurrent} />{t("repository.history.detached")}</span>}</span><span className="history-commit-subject" title={entry.subject}>{entry.subject}</span><span className="history-commit-sha">{entry.shortHash}</span><span className="history-commit-time">{formatCommitTime(entry.authorAt, new Date(), locale)}</span><span className="history-graph-gutter" aria-hidden="true"><GraphGutter node={graphNode} /></span></button>;
}

function CommitInspector({ ctx, repoRel, target, workspace, onSelectCommit, onClose }: { readonly ctx: RailPanelContext; readonly repoRel: string; readonly target: CommitTarget; readonly workspace: boolean; readonly onSelectCommit: (target: CommitTarget) => void; readonly onClose: () => void }) {
  const t = getT(ctx.language);
  const [state, setState] = useState<InspectorState>({ kind: "loading" }); const [tab, setTab] = useState<"details" | "changes">("details"); const [selectedPath, setSelectedPath] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(() => readSize(PREFS_HEADER_HEIGHT, HEADER_DEFAULT_HEIGHT)); const [fileListWidth, setFileListWidth] = useState(() => readSize(PREFS_FILE_LIST_WIDTH, FILE_LIST_DEFAULT_WIDTH));
  const [filesView, setFilesView] = useState<FilesViewMode>(readFilesViewMode);
  const detailsRef = useRef<HTMLDivElement>(null); const changesRef = useRef<HTMLDivElement>(null); const disposeRef = useRef<(() => void) | null>(null); const headerHeightRef = useRef(headerHeight); const fileListWidthRef = useRef(fileListWidth);
  const commit = useMemo(() => ({ fullHash: target.fullHash, theaterId: ctx.theaterId ?? "", repoRel }), [target.fullHash, ctx.theaterId, repoRel]);
  useEffect(() => { let cancelled = false; setState({ kind: "loading" }); ctx.api.fetch("repository", "commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ref: target.fullHash }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed"); return response.json() as Promise<CommitResult>; }).then((result) => { if (!cancelled) { setState({ kind: "ok", result }); setSelectedPath(result.files[0]?.path ?? null); } }).catch((error: unknown) => { if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" }); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, repoRel, target.fullHash]);
  useEffect(() => () => disposeRef.current?.(), []);
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, axis: "x" | "y") => { event.preventDefault(); const container = axis === "y" ? detailsRef.current : changesRef.current; if (!container) return; const start = axis === "y" ? headerHeightRef.current : fileListWidthRef.current; const startPointer = axis === "y" ? event.clientY : event.clientX; const size = axis === "y" ? container.getBoundingClientRect().height : container.getBoundingClientRect().width; disposeRef.current?.(); disposeRef.current = installPointerDragLifecycle({ documentTarget: document, windowTarget: window, onMove: (moveEvent) => { const move = moveEvent as PointerEvent; const next = clampSplitPaneSize(start, (axis === "y" ? move.clientY : move.clientX) - startPointer, size, 120, 120); if (next !== null) { if (axis === "y") { headerHeightRef.current = next; setHeaderHeight(next); } else { fileListWidthRef.current = next; setFileListWidth(next); } } }, onFinish: () => { const value = axis === "y" ? headerHeightRef.current : fileListWidthRef.current; try { localStorage.setItem(axis === "y" ? PREFS_HEADER_HEIGHT : PREFS_FILE_LIST_WIDTH, String(value)); } catch { /* ignore */ } disposeRef.current = null; } }); }, []);
  const content = state.kind === "loading" ? <div className="history-inspector-empty">{t("repository.history.loadingCommit")}</div> : state.kind === "error" ? <div className="history-inspector-empty history-inspector-error">{state.message}</div> : (() => {
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
        <CommitFiles files={files} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, false)} t={t} />
        <div className="repository-ws-dock-main">
          <div className="repository-ws-dock-meta">
            <CommitHeader meta={meta} entry={entry} fullHash={target.fullHash} copied={copied} onCopy={copySha} onParent={(full) => onSelectCommit({ fullHash: full })} locale={ctx.language} t={t} />
            <button type="button" className="history-detail-close repository-ws-dock-close" aria-label={t("repository.history.closeInspector")} title={t("repository.history.closeInspector")} onClick={onClose}>✕</button>
          </div>
          {selectedFile ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={selectedFile.path}>{selectedFile.path}</span><div><button type="button" aria-label={t("repository.history.previousFile")} disabled={files.indexOf(selectedFile) === 0} onClick={() => chooseFile(files[files.indexOf(selectedFile) - 1]!, false)}>‹</button><button type="button" aria-label={t("repository.history.nextFile")} disabled={files.indexOf(selectedFile) === files.length - 1} onClick={() => chooseFile(files[files.indexOf(selectedFile) + 1]!, false)}>›</button></div></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile} mode="unified" commit={commit} /></div> : <div className="history-inspector-empty">{t("repository.history.noChangedFiles")}</div>}
        </div>
      </div>;
    }
    return tab === "details" ? <div ref={detailsRef} className="history-details-tab" style={{ gridTemplateRows: buildInspectorDetailsGridTemplate(headerHeight) }}><CommitHeader meta={meta} entry={entry} fullHash={target.fullHash} copied={copied} onCopy={copySha} onParent={(full) => onSelectCommit({ fullHash: full })} locale={ctx.language} t={t} /><div className="history-divider history-divider--horizontal" onPointerDown={(event) => startDrag(event, "y")} /><CommitFiles files={files} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, true)} t={t} /></div> : <div className="history-changes-tab"><div ref={changesRef} className="history-changes-columns" style={{ gridTemplateColumns: buildInspectorChangesGridTemplate(fileListWidth) }}><CommitFiles files={files} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, false)} t={t} /><div className="history-divider" onPointerDown={(event) => startDrag(event, "x")} />{selectedFile ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={selectedFile.path}>{selectedFile.path}</span><div><button type="button" aria-label={t("repository.history.previousFile")} disabled={files.indexOf(selectedFile) === 0} onClick={() => chooseFile(files[files.indexOf(selectedFile) - 1]!, false)}>‹</button><button type="button" aria-label={t("repository.history.nextFile")} disabled={files.indexOf(selectedFile) === files.length - 1} onClick={() => chooseFile(files[files.indexOf(selectedFile) + 1]!, false)}>›</button></div></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile} mode="unified" commit={commit} /></div> : <div className="history-inspector-empty">{t("repository.history.noChangedFiles")}</div>}</div></div>;
  })();
  return <div className={`history-inspector${workspace ? " repository-ws-inspector" : ""}`} onKeyDown={(event) => { if (isInspectorDismissKey(event.key)) { event.preventDefault(); onClose(); } }}>{workspace ? content : <><div className="history-segmented"><button type="button" aria-pressed={tab === "details"} onClick={() => setTab("details")}>{t("repository.history.details")}</button><button type="button" aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>{t("repository.source.changes")} {state.kind === "ok" && <span>{state.result.files.length}</span>}</button><button type="button" className="history-detail-close history-inspector-close" aria-label={t("repository.history.closeInspector")} title={t("repository.history.closeInspector")} onClick={onClose}>✕</button></div>{content}</>}</div>;
}

function CommitHeader({ meta, entry, fullHash, copied, onCopy, onParent, locale, t }: { readonly meta: CommitResult["meta"]; readonly entry?: LogCommitEntry; readonly fullHash: string; readonly copied: boolean; readonly onCopy: () => void; readonly onParent: (full: string) => void; readonly locale: ConsoleLocale | undefined; readonly t: T }) { return <div className="history-inspector-head"><div className="history-inspector-subject">{meta.subject}</div>{meta.body && <pre className="history-inspector-message">{meta.body}</pre>}<div className="history-author"><span className="history-avatar">{initials(meta.authorName)}</span><span><b>{meta.authorName}</b><small>{meta.authorEmail}</small></span><time title={new Date(meta.authorAt * 1000).toLocaleString(localeTag(locale))}>{formatCommitTime(meta.authorAt, new Date(), locale)}</time></div><div className="history-inspector-ids"><button type="button" className={`history-sha-copy${copied ? " is-copied" : ""}`} onClick={onCopy}>{fullHash}<span>{copied ? t("repository.history.copied") : t("repository.history.copy")}</span></button>{meta.parents.map((parent) => <button type="button" className="history-parent" key={parent.full} onClick={() => onParent(parent.full)}>{t("repository.history.parent", { short: parent.short })}</button>)}</div>{entry && <div className="history-ref-chips">{refBadges(entry).map((badge) => <span key={`${badge.kind}:${badge.label}`} className={`history-badge history-badge--${badge.kind}`}>{badge.label}</span>)}</div>}</div>; }
function CommitFiles({ files, selectedPath, additions, deletions, viewMode, onViewMode, onSelect, t }: { readonly files: readonly DiffFileEntry[]; readonly selectedPath: string | null; readonly additions: number; readonly deletions: number; readonly viewMode: FilesViewMode; readonly onViewMode: (mode: FilesViewMode) => void; readonly onSelect: (file: DiffFileEntry) => void; readonly t: T }) { return <section className="history-commit-files"><div className="history-files-title"><span className="history-files-label">{t("repository.history.changedFiles")}</span><span className="history-files-stats">{files.length} <i>+{additions}</i> <em>−{deletions}</em></span><div className="repository-view-toggle history-files-view-toggle"><button type="button" className={`repository-toggle-btn${viewMode === "list" ? " is-active" : ""}`} title={t("repository.common.listView")} aria-label={t("repository.common.listView")} aria-pressed={viewMode === "list"} onClick={() => onViewMode("list")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button type="button" className={`repository-toggle-btn${viewMode === "tree" ? " is-active" : ""}`} title={t("repository.common.treeView")} aria-label={t("repository.common.treeView")} aria-pressed={viewMode === "tree"} onClick={() => onViewMode("tree")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg></button></div></div><div className="history-files-scroll">{viewMode === "tree" ? <DiffTreeView files={files} selectedPath={selectedPath} onSelect={onSelect} /> : files.map((file) => <FileRow key={file.path} entry={file} isSelected={file.path === selectedPath} onSelect={onSelect} t={t} />)}</div></section>; }

interface HistoryPanelProps {
  readonly ctx: RailPanelContext;
  readonly repoRel: string;
  readonly cacheScope?: string;
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

export function HistoryPanel({ ctx, repoRel, cacheScope = `${ctx.theaterId ?? ""}:${repoRel}`, active = true, refFilter = null, wipFiles, workspace = false, workspaceMain, workspaceMainVisible = false, onInspectorOpenChange, onClearRef, onWip }: HistoryPanelProps) {
  return <HistoryPanelBody key={cacheScope} ctx={ctx} repoRel={repoRel} cacheScope={cacheScope} active={active} refFilter={refFilter} wipFiles={wipFiles} workspace={workspace} workspaceMain={workspaceMain} workspaceMainVisible={workspaceMainVisible} onInspectorOpenChange={onInspectorOpenChange} onClearRef={onClearRef} onWip={onWip} />;
}

function HistoryPanelBody({ ctx, repoRel, cacheScope, active, refFilter, wipFiles, workspace, workspaceMain, workspaceMainVisible, onInspectorOpenChange, onClearRef, onWip }: Required<Pick<HistoryPanelProps, "active" | "cacheScope" | "ctx" | "refFilter" | "repoRel" | "wipFiles" | "workspace" | "workspaceMainVisible">> & Pick<HistoryPanelProps, "workspaceMain" | "onInspectorOpenChange" | "onClearRef" | "onWip">) {
  const t = getT(ctx.language);
  const historyCacheKey = `${cacheScope}::${refFilter ?? ""}`;
  const searchTarget = useRepositorySearchTarget();
  const pendingSearchTargetHash = searchTarget?.theaterId === ctx.theaterId && searchTarget.repoRel === repoRel ? searchTarget.fullHash : null;
  const [initialRestore] = useState(() => readHistoryCacheRestore(historyCacheKey, pendingSearchTargetHash));
  const [state, setState] = useState<LoadState>(initialRestore?.state ?? { kind: "loading" });
  const [target, setTarget] = useState<CommitTarget | null>(initialRestore?.target ?? null);
  const [filterText, setFilterText] = useState(initialRestore?.filterText ?? "");
  const [refreshToken, setRefreshToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [commitViewport, setCommitViewport] = useState({ scrollTop: initialRestore?.scrollTop ?? 0, height: 0 });
  const [logHeight, setLogHeight] = useState(readLogPaneHeight);
  const [dockHeight, setDockHeight] = useState(readWorkspaceDockHeight);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commitWindowRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const revealKeyRef = useRef<string | null>(initialRestore?.target ? `${initialRestore.target.fullHash}\x00${initialRestore.filterText}` : null);
  const pendingRevealRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const loadedCacheKeyRef = useRef<string | null>(initialRestore ? historyCacheKey : null);
  const loadedCommitsRef = useRef<readonly LogCommitEntry[] | null>(initialRestore?.state.commits ?? null);
  const stateCacheKeyRef = useRef<string | null>(initialRestore ? historyCacheKey : null);
  const restoredScrollTopRef = useRef<number | null>(initialRestore?.scrollTop ?? null);
  const scrollTopRef = useRef(initialRestore?.scrollTop ?? 0);
  const previousFilterTextRef = useRef(filterText);
  const previousRefFilterRef = useRef(refFilter);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  const logHeightRef = useRef(logHeight);
  const dockHeightRef = useRef(dockHeight);
  const generation = useMemo<HistoryLoadGeneration>(() => ({ theaterId: ctx.theaterId, repoRel, refFilter, refreshToken }), [ctx.theaterId, refFilter, refreshToken, repoRel]);
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const visible = useMemo(() => state.kind === "ok" ? filterHistoryCommits(state.commits, filterText) : [], [filterText, state]);
  const layout = useMemo(() => state.kind === "ok" ? layoutGraph(state.commits) : null, [state]);
  const commitIndexes = useMemo(() => new Map(state.kind === "ok" ? state.commits.map((entry, index) => [entry.fullHash, index]) : []), [state]);
  const wip = useMemo(() => aggregateWip(wipFiles), [wipFiles]);
  const showWip = shouldShowWip(wip, filterText, refFilter);
  const virtualWindow = calculateHistoryWindow(visible.length, commitViewport.scrollTop, commitViewport.height);
  const windowRows = state.kind === "ok" && layout ? getHistoryWindowRows(commitIndexes, visible, layout, virtualWindow) : [];
  const updateCommitViewport = useCallback(() => {
    const list = listRef.current;
    const commitWindow = commitWindowRef.current;
    if (!list || list.clientHeight <= 0 || list.scrollHeight <= 0) return;
    if (restoredScrollTopRef.current !== null) {
      list.scrollTop = restoredScrollTopRef.current;
      scrollTopRef.current = list.scrollTop;
      restoredScrollTopRef.current = null;
    }
    if (!commitWindow) return;
    const contentTop = commitWindow.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    scrollTopRef.current = list.scrollTop;
    setCommitViewport({
      scrollTop: Math.max(0, list.scrollTop - contentTop),
      height: list.clientHeight,
    });
  }, []);
  useLayoutEffect(() => {
    if (previousFilterTextRef.current === filterText) return;
    previousFilterTextRef.current = filterText;
    const list = listRef.current;
    if (list) list.scrollTop = 0;
    scrollTopRef.current = 0;
    setCommitViewport({ scrollTop: 0, height: list?.clientHeight ?? 0 });
  }, [filterText]);
  useEffect(() => {
    if (previousRefFilterRef.current === refFilter) return;
    previousRefFilterRef.current = refFilter;
    setTarget(null);
  }, [refFilter]);
  useEffect(() => {
    if (
      !searchTarget
      || searchTarget.theaterId !== ctx.theaterId
      || searchTarget.repoRel !== repoRel
      || state.kind !== "ok"
    ) return;
    const entry = state.commits.find((commit) => commit.fullHash === searchTarget.fullHash);
    if (!entry) return;
    setFilterText("");
    setTarget({ fullHash: entry.fullHash, entry });
    consumeRepositorySearchTarget(searchTarget);
  }, [ctx.theaterId, repoRel, searchTarget, state]);
  useLayoutEffect(() => {
    if (!target) {
      revealKeyRef.current = null;
      pendingRevealRef.current = null;
      return;
    }
    const revealKey = `${target.fullHash}\x00${filterText}`;
    const isNewReveal = revealKeyRef.current !== revealKey;
    if (isNewReveal) {
      revealKeyRef.current = revealKey;
      pendingRevealRef.current = target.fullHash;
    } else if (pendingRevealRef.current !== target.fullHash) {
      return;
    }
    const row = rowRefs.current.get(target.fullHash);
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
      pendingRevealRef.current = null;
      return;
    }
    const targetIndex = visible.findIndex((entry) => entry.fullHash === target.fullHash);
    const list = listRef.current;
    const commitWindow = commitWindowRef.current;
    if (targetIndex < 0 || !list || !commitWindow) return;
    const contentTop = commitWindow.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const rowTop = contentTop + targetIndex * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
    updateCommitViewport();
  }, [filterText, target, updateCommitViewport, virtualWindow.endIndex, virtualWindow.startIndex, visible]);
  // 숨은 마운트는 상태 보존용일 뿐이므로, 첫 활성화 전에는 log 조회 비용을 지불하지 않는다
  const [everActive, setEverActive] = useState(active);
  useEffect(() => { if (active) setEverActive(true); }, [active]);
  useEffect(() => {
    if (!everActive) return;
    if (
      loadedCacheKeyRef.current === historyCacheKey
      && refreshToken === 0
      && (!pendingSearchTargetHash || loadedCommitsRef.current?.some((commit) => commit.fullHash === pendingSearchTargetHash))
    ) return;
    if (refreshToken === 0) {
      const restored = readHistoryCacheRestore(historyCacheKey, pendingSearchTargetHash);
      if (restored) {
        loadedCacheKeyRef.current = historyCacheKey;
        loadedCommitsRef.current = restored.state.commits;
        stateCacheKeyRef.current = historyCacheKey;
        restoredScrollTopRef.current = restored.scrollTop;
        scrollTopRef.current = restored.scrollTop;
        previousFilterTextRef.current = restored.filterText;
        revealKeyRef.current = restored.target ? `${restored.target.fullHash}\x00${restored.filterText}` : null;
        pendingRevealRef.current = null;
        loadingMoreRef.current = false;
        setState(restored.state);
        setTarget(restored.target);
        setFilterText(restored.filterText);
        setCommitViewport({ scrollTop: restored.scrollTop, height: 0 });
        setLoadingMore(false);
        setLoadMoreError(null);
        return;
      }
    }
    loadedCacheKeyRef.current = null;
    loadedCommitsRef.current = null;
    stateCacheKeyRef.current = null;
    if (refreshToken > 0) dropHistoryCache(historyCacheKey);
    if (!ctx.theaterId) {
      loadedCacheKeyRef.current = historyCacheKey;
      loadedCommitsRef.current = [];
      stateCacheKeyRef.current = historyCacheKey;
      setState({ kind: "ok", commits: [], checkouts: [], hasMore: false, truncated: false });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadMoreError(null);
    ctx.api.fetch("repository", "log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, limit: HISTORY_PAGE_SIZE, skip: 0, ...(refFilter ? { ref: refFilter } : {}) }) }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed");
      return response.json() as Promise<LogResult>;
    }).then((data) => {
      if (!cancelled) {
        loadedCacheKeyRef.current = historyCacheKey;
        loadedCommitsRef.current = data.commits;
        stateCacheKeyRef.current = historyCacheKey;
        setState({ kind: "ok", commits: data.commits, checkouts: data.checkouts, hasMore: data.hasMore, truncated: data.truncated ?? false });
      }
    }).catch((error: unknown) => {
      if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, everActive, historyCacheKey, pendingSearchTargetHash, refreshToken, refFilter, repoRel]);
  useEffect(() => {
    if (state.kind !== "ok" || stateCacheKeyRef.current !== historyCacheKey) return;
    const list = listRef.current;
    if (!list || list.clientHeight <= 0 || list.scrollHeight <= 0) return;
    writeHistoryCache(historyCacheKey, {
      commits: state.commits,
      checkouts: state.checkouts,
      hasMore: state.hasMore,
      truncated: state.truncated,
      scrollTop: scrollTopRef.current,
      targetHash: target?.fullHash ?? null,
      filterText,
    });
  }, [commitViewport.height, commitViewport.scrollTop, filterText, historyCacheKey, state, target]);
  useEffect(() => { onInspectorOpenChange?.(active && target !== null); }, [active, onInspectorOpenChange, target]); useEffect(() => () => dragDisposeRef.current?.(), []);
  useLayoutEffect(() => {
    updateCommitViewport();
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateCommitViewport);
    observer.observe(list);
    return () => observer.disconnect();
  }, [showWip, updateCommitViewport, visible.length]);
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
  const loadMore = useCallback(() => {
    if (state.kind !== "ok" || !state.hasMore || loadingMoreRef.current || !ctx.theaterId) return;
    const requestGeneration = generation;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    ctx.api.fetch("repository", "log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, limit: HISTORY_PAGE_SIZE, skip: state.commits.length, ...(refFilter ? { ref: refFilter } : {}) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed");
      return response.json() as Promise<LogResult>;
    }).then((data) => {
      if (!isHistoryGenerationCurrent(requestGeneration, generationRef.current)) return;
      setState((current) => {
        if (current.kind !== "ok") return current;
        const next = appendHistoryPage(current, data, requestGeneration, generationRef.current);
        if (next) {
          loadedCommitsRef.current = next.commits;
          stateCacheKeyRef.current = historyCacheKey;
        }
        return next ?? current;
      });
    }).catch((error: unknown) => {
      if (!isHistoryGenerationCurrent(requestGeneration, generationRef.current)) return;
      setLoadMoreError(error instanceof Error ? error.message : "unknown");
    }).finally(() => {
      if (!isHistoryGenerationCurrent(requestGeneration, generationRef.current)) return;
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }, [ctx.api, ctx.theaterId, generation, historyCacheKey, refFilter, repoRel, state]);
  const refreshHistory = useCallback(() => {
    dropHistoryCache(historyCacheKey);
    stateCacheKeyRef.current = null;
    setRefreshToken((value) => value + 1);
  }, [historyCacheKey]);
  const stackTemplate = target
    ? workspace ? buildWorkspaceDockTemplate(dockHeight) : buildHistoryStackTemplate(logHeight)
    : undefined;
  return <div ref={rootRef} className={`history-root${workspace ? " repository-ws-history" : ""}${isDragging ? " is-dragging" : ""}`} style={stackTemplate ? { gridTemplateRows: stackTemplate } : undefined}>
    <div className="history-list-pane" hidden={workspace && workspaceMainVisible}>
      <div className="history-toolbar"><div className="history-filter"><input className="history-filter-input" placeholder={t("repository.common.filterPlaceholder")} value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText && <button type="button" className="history-filter-clear" onClick={() => setFilterText("")}>✕</button>}</div>{refFilter && <button type="button" className="repository-ref-chip" onClick={onClearRef}>{refFilter} ✕</button>}{state.kind === "ok" && <><span className="history-count">{filterText ? `${visible.length}/${state.commits.length}` : state.commits.length}</span><button type="button" className="repository-refresh-btn" onClick={refreshHistory}>{t("repository.history.refresh")}</button></>}</div>
      <div ref={listRef} className="history-list" onScroll={updateCommitViewport}>{showWip && <button type="button" className="repository-wip-row" onClick={onWip}>{t("repository.history.uncommitted")} <span>{t(wip.files === 1 ? "repository.history.wipStats_one" : "repository.history.wipStats_other", { count: wip.files, additions: wip.additions, deletions: wip.deletions })}</span></button>}{state.kind === "loading" && <div className="history-empty">{t("repository.common.loading")}</div>}{state.kind === "error" && <div className="history-error">{state.message}<button type="button" className="repository-refresh-btn" onClick={refreshHistory}>{t("repository.common.retry")}</button></div>}{state.kind === "ok" && state.commits.length === 0 && <div className="history-empty">{t("repository.history.empty")}</div>}{state.kind === "ok" && state.commits.length > 0 && visible.length === 0 && <div className="history-empty">{t("repository.common.noMatchingItems")}</div>}{state.kind === "ok" && layout && visible.length > 0 && <div ref={commitWindowRef} className="history-commit-window"><div className="history-window-spacer" aria-hidden="true" style={{ height: virtualWindow.topSpacerHeight }} />{windowRows.map(({ entry, graphNode }) => <CommitRow key={entry.fullHash} rowRef={(node) => { if (node) rowRefs.current.set(entry.fullHash, node); else rowRefs.current.delete(entry.fullHash); }} entry={entry} checkouts={state.checkouts} selected={target?.fullHash === entry.fullHash} graphNode={graphNode} onSelect={(selected) => setTarget({ fullHash: selected.fullHash, entry: selected })} locale={ctx.language} />)}<div className="history-window-spacer" aria-hidden="true" style={{ height: virtualWindow.bottomSpacerHeight }} /></div>}{state.kind === "ok" && state.commits.length > 0 && <div className="history-pagination">{state.hasMore ? loadingMore ? <span>{t("repository.history.loadingMore")}</span> : <button type="button" className="repository-refresh-btn" onClick={loadMore}>{t("repository.history.loadMore")}</button> : <><span>{t("repository.history.end")}</span>{state.truncated && <span>{t("repository.history.capped")}</span>}</>}{loadMoreError && <span className="history-pagination-error">{loadMoreError}</span>}</div>}</div>
    </div>
    {workspaceMain !== undefined && <div className="repository-ws-main" hidden={!workspaceMainVisible}>{workspaceMain}</div>}
    {target && <><div className="history-divider history-divider--horizontal" role="separator" aria-orientation="horizontal" aria-label={workspace ? t("repository.history.resizeDock") : t("repository.history.resizeLog")} onPointerDown={handleDivider} /><div className="history-detail-pane"><CommitInspector ctx={ctx} repoRel={repoRel} target={target} workspace={workspace} onSelectCommit={setTarget} onClose={() => setTarget(null)} /></div></>}
  </div>;
}
function readLogPaneHeight(): number { return readSize(PREFS_LOG_PANE_HEIGHT, LOG_PANE_DEFAULT_HEIGHT, HISTORY_LOG_PANE_MIN_HEIGHT); }
function readFilesViewMode(): FilesViewMode { try { const value = localStorage.getItem(PREFS_FILES_VIEW); if (value === "list" || value === "tree") return value; } catch { /* ignore */ } return "list"; }
function readSize(key: string, fallback: number, minimum = 0): number { try { const value = Number.parseFloat(localStorage.getItem(key) ?? ""); if (Number.isFinite(value) && value >= minimum) return value; } catch { /* ignore */ } return fallback; }
function initials(name: string): string { return name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?"; }
function HistoryIcon() { return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 3v12M10 7v8M14 11v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><path d="M5 7c1.8 0 2.4 0 5 0M10 11c1.4 0 2.2 0 4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>; }
