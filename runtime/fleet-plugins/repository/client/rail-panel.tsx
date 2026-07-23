import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffFileMode, DiffListResult, RepoCandidate, ReposResult, WorktreeCandidate, WorktreesResult } from "../server/types.js";
import "./repository.css";
import { ChangedFiles, type ChangedFilesState } from "./changed-files.js";
import { CompareView } from "./compare-view.js";
import { fuzzyMatch } from "./fuzzy.js";
import { buildRepoTree, compressRepoFolder, countRepos, type RepoTreeNode } from "./repo-tree.js";
import { clearSelectedFile, setSelectedFile, type SelectedFile, useSelectedFile } from "./repository-view-store.js";
import { HunkView } from "./hunk-view.js";
import { HistoryPanel } from "./history-panel.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth } from "./rail-layout.js";
import { buildWorkspaceTreeSections, calculateWorkspaceExtraWidth, readWorkspaceMode, saveWorkspaceMode } from "./workspace-layout.js";

type ViewMode = "list" | "tree";

interface RepositoryPanelProps {
  readonly ctx: RailPanelContext;
}

const PREFS_VIEW_MODE = "fleet-console.diff.viewMode";
const PREFS_LIST_PANE_WIDTH = "fleet-console.diff.listPaneWidth";
const PREFS_SOURCE = "fleet-console.repository.source";
const PREFS_REPO_PREFIX = "fleet-console.repository.repo.";
const PREFS_SCAN_DEPTH = "fleet-console.repository.scanDepth";
const SCAN_DEPTH_MIN = 1;
const SCAN_DEPTH_MAX = 8;
const SCAN_DEPTH_DEFAULT = 3;
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
    if (value === "repositories" || value === "worktrees" || value === "changes" || value === "history" || value === "compare" || value === "branches" || value === "tags" || value === "stashes") return value;
  } catch { /* ignore */ }
  return "changes";
}

export function readStoredRepositoryRel(theaterId: string): string {
  try { return localStorage.getItem(`${PREFS_REPO_PREFIX}${theaterId}`) ?? ""; }
  catch { return ""; }
}

export function readRepositoryRel(theaterId: string, repos: readonly RepoCandidate[], worktrees: readonly WorktreeCandidate[]): string {
  try {
    const key = `${PREFS_REPO_PREFIX}${theaterId}`;
    const stored = localStorage.getItem(key);
    if (stored === null) return "";
    if (repos.some((repo) => repo.relPath === stored) || worktrees.some((worktree) => worktree.relPath === stored)) return stored;
    localStorage.removeItem(key);
  } catch { /* ignore */ }
  return "";
}

export function readScanDepth(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(PREFS_SCAN_DEPTH) ?? "", 10);
    if (Number.isInteger(value) && value >= SCAN_DEPTH_MIN && value <= SCAN_DEPTH_MAX) return value;
  } catch { /* ignore */ }
  return SCAN_DEPTH_DEFAULT;
}

export function saveScanDepth(depth: number): void {
  try { localStorage.setItem(PREFS_SCAN_DEPTH, String(depth)); } catch { /* ignore */ }
}

export function saveRepositoryRel(theaterId: string, repoRel: string): void {
  try { localStorage.setItem(`${PREFS_REPO_PREFIX}${theaterId}`, repoRel); } catch { /* ignore */ }
}

function clearRepositoryRel(theaterId: string): void {
  try { localStorage.removeItem(`${PREFS_REPO_PREFIX}${theaterId}`); } catch { /* ignore */ }
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
  return <RepositoryPanelBody key={ctx.theaterId} ctx={ctx} />;
}

export type Source = "repositories" | "worktrees" | "changes" | "history" | "compare" | "branches" | "tags" | "stashes";
type RefSource = Exclude<Source, "repositories" | "worktrees" | "changes" | "history" | "compare">;
export type RepositoryRefItem = { label: string; ref: string; current: boolean };
export type RepositoryStash = { name: string; subject: string };
export type RepositoryRefs = { branches: RepositoryRefItem[]; remotes: RepositoryRefItem[]; tags: RepositoryRefItem[]; stashes: RepositoryStash[] };
export type RepositoryRefRow = { key: string; source: RefSource; primary: string; sub?: string; ref: string | null; current: boolean };
export type RepositoryRefGroup = { label?: "LOCAL" | "REMOTES"; rows: RepositoryRefRow[] };
type Refs = RepositoryRefs;

// 사용자 제스처 선택의 착지 결정 — 컨텍스트 전환 여부와 무관하게 History로 착지한다(refs 선택과 동일 문법).
export function resolveRepositorySelection(theaterId: string | null, currentRel: string, nextRel: string): { readonly transition: boolean; readonly landing: Source } {
  if (!theaterId || nextRel === currentRel) return { transition: false, landing: "history" };
  return { transition: true, landing: "history" };
}

export function isRemoteHeadRef(ref: string): boolean {
  return /^refs\/remotes\/[^/]+\/HEAD$/.test(ref);
}

export function buildRefListGroups(source: RefSource, refs: RepositoryRefs): RepositoryRefGroup[] {
  const refRows = (items: readonly RepositoryRefItem[], rowSource: "branches" | "tags"): RepositoryRefRow[] => items.map((item) => ({ key: item.ref, source: rowSource, primary: item.label, ref: item.ref, current: item.current }));
  if (source === "branches") {
    return [
      { label: "LOCAL", rows: refRows(refs.branches, "branches") },
      { label: "REMOTES", rows: refRows(refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)), "branches") },
    ];
  }
  if (source === "tags") return [{ rows: refRows(refs.tags, "tags") }];
  return [{ rows: refs.stashes.map((item) => ({ key: item.name, source, primary: item.subject || item.name, sub: item.name, ref: null, current: false })) }];
}
function RepositoryPanelBody({ ctx }: RepositoryPanelProps) {
  const [repos, setRepos] = useState<readonly RepoCandidate[]>([]);
  const [reposError, setReposError] = useState(false);
  const [reposRetry, setReposRetry] = useState(0);
  const [reposTruncated, setReposTruncated] = useState(false);
  const [scanDepth, setScanDepthState] = useState(readScanDepth);
  // 깊이 변경은 컨텍스트 전환이 아니다 — 선택된 저장소와 하위 상태는 그대로 두고 목록만 다시 받는다.
  const setScanDepth = useCallback((next: number) => { setScanDepthState(next); saveScanDepth(next); }, []);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [worktrees, setWorktrees] = useState<readonly WorktreeCandidate[]>([]);
  const [worktreesError, setWorktreesError] = useState(false);
  const [worktreesRetry, setWorktreesRetry] = useState(0);
  const [worktreesForRepoRel, setWorktreesForRepoRel] = useState<string | null>(null);
  const [repoRel, setRepoRel] = useState(() => ctx.theaterId ? readStoredRepositoryRel(ctx.theaterId) : "");
  const repoRelRef = useRef(repoRel);
  const [source, setSourceState] = useState<Source>(readRepositorySource);
  const [isWorkspace, setIsWorkspace] = useState(readWorkspaceMode);
  const [refFilter, setRefFilter] = useState<string | null>(null);
  const [refs, setRefs] = useState<Refs>({ branches: [], remotes: [], tags: [], stashes: [] });
  const [refsError, setRefsError] = useState(false); const [refsRetry, setRefsRetry] = useState(0);
  const [changedFiles, setChangedFiles] = useState<ChangedFilesState>({ kind: "loading" });
  const [changedFilesRetry, setChangedFilesRetry] = useState(0);
  const [historyInspectorOpen, setHistoryInspectorOpen] = useState(false);
  const [compareFileOpen, setCompareFileOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [filterText, setFilterText] = useState("");
  // 동일 컨텍스트 재착지는 repoRel key가 안 바뀌어 History 패널이 리마운트되지 않는다 —
  // epoch를 key에 섞어 전환 착지와 동일한 초기 상태(로컬 필터·선택·스크롤)로 재설정한다.
  const [historyLandingEpoch, setHistoryLandingEpoch] = useState(0);
  const selectedFile = useSelectedFile(ctx.theaterId ?? null, repoRel);
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const listPaneWidthRef = useRef(listPaneWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const setSource = useCallback((next: Source) => {
    setSourceState(next);
    saveRepositorySource(next);
  }, []);
  const toggleWorkspace = useCallback(() => {
    setIsWorkspace((value) => {
      const next = !value;
      saveWorkspaceMode(next);
      return next;
    });
  }, []);
  const transitionRepository = useCallback((nextRepoRel: string, persist: boolean, landing: Source = "changes") => {
    if (!ctx.theaterId) return;
    if (persist) saveRepositoryRel(ctx.theaterId, nextRepoRel);
    clearSelectedFile();
    setRefFilter(null);
    setFilterText("");
    setHistoryInspectorOpen(false);
    setCompareFileOpen(false);
    setChangedFiles({ kind: "loading" });
    setRefs({ branches: [], remotes: [], tags: [], stashes: [] });
    repoRelRef.current = nextRepoRel;
    setRepoRel(nextRepoRel);
    setSource(landing);
  }, [ctx.theaterId, setSource]);
  useEffect(() => {
    if (!ctx.theaterId) return;
    let cancelled = false;
    setReposError(false);
    setReposLoaded(false);
    ctx.api.fetch("repository", "repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, maxDepth: scanDepth }) })
      .then((response) => response.json() as Promise<ReposResult>)
      .then((value) => { if (!cancelled) { setRepos(value.repos); setReposTruncated(value.truncated === true); setReposLoaded(true); } })
      .catch(() => { if (!cancelled) setReposError(true); });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, reposRetry, scanDepth]);
  useEffect(() => {
    if (!ctx.theaterId) return;
    let cancelled = false;
    const requestedRepoRel = repoRel;
    setWorktrees([]);
    setWorktreesError(false);
    setWorktreesForRepoRel(null);
    ctx.api.fetch("repository", "worktrees", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel: requestedRepoRel }) })
      .then((response) => response.json() as Promise<WorktreesResult>)
      .then((value) => {
        if (!cancelled) {
          setWorktrees(value.worktrees);
          setWorktreesForRepoRel(requestedRepoRel);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = typeof error === "object" && error !== null && "status" in error ? (error as { readonly status?: unknown }).status : null;
        if (status === 400 && requestedRepoRel !== "") {
          clearRepositoryRel(ctx.theaterId!);
          transitionRepository("", false);
          return;
        }
        setWorktreesError(true);
      });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, repoRel, transitionRepository, worktreesRetry]);
  useEffect(() => {
    if (!ctx.theaterId || !reposLoaded || worktreesForRepoRel !== repoRel) return;
    const restoredRepoRel = readRepositoryRel(ctx.theaterId, repos, worktrees);
    if (restoredRepoRel !== repoRelRef.current) transitionRepository(restoredRepoRel, false);
  }, [ctx.theaterId, repoRel, repos, reposLoaded, transitionRepository, worktrees, worktreesForRepoRel]);
  useEffect(() => { if (!ctx.theaterId) return; let cancelled = false; setRefs({ branches: [], remotes: [], tags: [], stashes: [] }); setRefsError(false); ctx.api.fetch("repository", "refs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }) }).then((r) => r.ok ? r.json() as Promise<Refs> : Promise.reject()).then((value) => { if (!cancelled) setRefs(value); }).catch(() => { if (!cancelled) setRefsError(true); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, repoRel, refsRetry]);
  useEffect(() => {
    if (!ctx.theaterId) {
      setChangedFiles({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setChangedFiles({ kind: "loading" });
    // api.fetch(assertSafeResponse)는 non-2xx에서 payload를 버리고 throw하므로,
    // no_git_repo/git_unavailable 안내 매핑을 위해 원래의 raw fetch 경로를 유지한다
    fetch("/plugins/repository/changed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }) }).then(async (response) => {
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
  }, [changedFilesRetry, ctx.theaterId, repoRel]);

  useLayoutEffect(() => () => clearSelectedFile(), []);

  const handleSelectFile = useCallback((entry: DiffFileEntry) => {
    if (ctx.theaterId) setSelectedFile(entry, ctx.theaterId, repoRel);
  }, [ctx.theaterId, repoRel]);
  const handleSelectRepository = useCallback((next: { readonly relPath: string }) => {
    const decision = resolveRepositorySelection(ctx.theaterId, repoRel, next.relPath);
    // 동일 컨텍스트 재선택도 "이 체크아웃의 History" 착지다 — refFilter를 걷어내고 History 패널을
    // epoch 리마운트해 전환 착지와 동일한 초기 상태로 만든다(스코프된 로그·WIP 숨김 잔존 방지).
    if (!decision.transition) { setRefFilter(null); setHistoryLandingEpoch((value) => value + 1); setSource(decision.landing); return; }
    transitionRepository(next.relPath, true, decision.landing);
  }, [ctx.theaterId, repoRel, setSource, transitionRepository]);
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
    if (isWorkspace) {
      const requestWorkspaceWidth = () => ctx.requestExtraWidth?.(calculateWorkspaceExtraWidth(window.innerWidth));
      requestWorkspaceWidth();
      window.addEventListener("resize", requestWorkspaceWidth);
      return () => {
        window.removeEventListener("resize", requestWorkspaceWidth);
        ctx.requestExtraWidth?.(null);
      };
    }
    ctx.requestExtraWidth?.((source === "changes" && selectedFile) || (source === "history" && historyInspectorOpen) || (source === "compare" && compareFileOpen) ? EXTENDED_EXTRA_WIDTH : null);
    return () => ctx.requestExtraWidth?.(null);
  }, [ctx.requestExtraWidth, selectedFile, source, historyInspectorOpen, compareFileOpen, isWorkspace]);

  const hunkMode = selectedFile ? getHunkMode(selectedFile) : null;
  const retryChangedFiles = useCallback(() => setChangedFilesRetry((value) => value + 1), []);
  const wipFiles = changedFiles.kind === "ok" ? changedFiles.files : [];
  const selectedRepo = repos.find((repo) => repo.relPath === repoRel) ?? worktrees.find((worktree) => worktree.relPath === repoRel);
  const changesView = <div ref={rootRef} className={`repository-root${selectedFile ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={selectedFile ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
    {selectedFile && hunkMode ? <div className="repository-hunk-pane"><div className="repository-hunk-head"><span>{selectedFile.entry.path}</span><button type="button" onClick={handleCloseHunk}>✕</button></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile.entry} mode={hunkMode} /></div> : null}
    {selectedFile ? <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" /> : null}
    <div className="repository-list-pane">
      <div className="repository-toolbar"><div className="repository-filter"><input type="text" className="repository-filter-input" placeholder="Filter…" aria-label="Filter changed files" value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText ? <button type="button" className="repository-filter-clear" aria-label="Clear filter" onClick={() => setFilterText("")}>✕</button> : null}</div><div className="repository-view-toggle"><button type="button" className={`repository-toggle-btn${viewMode === "list" ? " is-active" : ""}`} title="List view" aria-pressed={viewMode === "list"} onClick={() => handleViewMode("list")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button type="button" className={`repository-toggle-btn${viewMode === "tree" ? " is-active" : ""}`} title="Tree view" aria-pressed={viewMode === "tree"} onClick={() => handleViewMode("tree")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg></button></div></div>
      <ChangedFiles state={changedFiles} onRetry={retryChangedFiles} viewMode={viewMode} selectedPath={selectedFile?.entry.path ?? null} onSelect={handleSelectFile} filterText={filterText} />
    </div>
  </div>;
  const compareView = <CompareView key={`${ctx.theaterId ?? ""}:${repoRel}`} ctx={ctx} repoRel={repoRel} refs={refs} refsError={refsError} onRetryRefs={() => setRefsRetry((value) => value + 1)} onFileOpenChange={setCompareFileOpen} />;
  const workspaceMain = source === "changes" ? changesView : source === "compare" ? compareView : undefined;
  return (
    <div className={`repository-unified${isWorkspace ? " is-workspace" : ""}`}>
      <div className={`repository-identity${repoRel ? " is-subcontext" : ""}`}><RepositoryIcon /><strong>{selectedRepo?.name ?? "Repository"}</strong>{selectedRepo?.branch && <span>{selectedRepo.branch}</span>}<button type="button" className="repository-ws-toggle" aria-label={isWorkspace ? "Collapse workspace" : "Expand workspace"} title={isWorkspace ? "Collapse workspace" : "Expand workspace"} onClick={toggleWorkspace}><WorkspaceToggleIcon expanded={isWorkspace} /></button></div>
      {isWorkspace ? <div className="repository-ws-layout">
        <WorkspaceTree repos={repos} reposError={reposError} reposTruncated={reposTruncated} scanDepth={scanDepth} worktrees={worktrees} worktreesError={worktreesError} refs={refs} refsError={refsError} changedFiles={changedFiles} selectedRel={repoRel} source={source} refFilter={refFilter} onRepository={handleSelectRepository} onScanDepth={setScanDepth} onRetryRepos={() => setReposRetry((value) => value + 1)} onRetryWorktrees={() => setWorktreesRetry((value) => value + 1)} onRetryRefs={() => setRefsRetry((value) => value + 1)} onSource={setSource} onRef={(ref) => { setRefFilter(ref); setSource("history"); }} />
        <HistoryPanel key={`${ctx.theaterId ?? ""}:${repoRel}:${historyLandingEpoch}`} ctx={ctx} repoRel={repoRel} active refFilter={refFilter} wipFiles={wipFiles} workspace workspaceMain={workspaceMain} onInspectorOpenChange={setHistoryInspectorOpen} onClearRef={() => setRefFilter(null)} onWip={() => setSource("changes")} />
      </div> : <div className="repository-unified-body"><SourceNav source={source} refs={refs} repos={repos} worktrees={worktrees} onSource={setSource} /><div className="repository-source-content">
        {source === "repositories" ? reposError ? <div className="history-error">Unable to load repositories<button type="button" className="repository-refresh-btn" onClick={() => setReposRetry((value) => value + 1)}>Retry</button></div> : <RepoList repos={repos} selectedRel={repoRel} onRepository={handleSelectRepository} scanDepth={scanDepth} onScanDepth={setScanDepth} truncated={reposTruncated} /> : null}
        {source === "worktrees" ? worktreesError ? <div className="history-error">Unable to load worktrees<button type="button" className="repository-refresh-btn" onClick={() => setWorktreesRetry((value) => value + 1)}>Retry</button></div> : <WorktreeList worktrees={worktrees} onWorktree={handleSelectRepository} /> : null}
        <div className="repository-source-fill" hidden={source !== "history"}><HistoryPanel key={`${ctx.theaterId ?? ""}:${repoRel}:${historyLandingEpoch}`} ctx={ctx} repoRel={repoRel} active={source === "history"} refFilter={refFilter} wipFiles={wipFiles} onInspectorOpenChange={setHistoryInspectorOpen} onClearRef={() => setRefFilter(null)} onWip={() => setSource("changes")} /></div>
        <div className="repository-source-fill" hidden={source !== "compare"}>{compareView}</div>
        {source !== "repositories" && source !== "worktrees" && source !== "changes" && source !== "history" && source !== "compare" ? refsError ? <div className="history-error">Unable to load refs<button type="button" className="repository-refresh-btn" onClick={() => setRefsRetry((value) => value + 1)}>Retry</button></div> : <RefList source={source} refs={refs} onRef={(ref) => { setRefFilter(ref); setSource("history"); }} /> : null}
        <div className="repository-source-fill" hidden={source !== "changes"}>{changesView}</div>
      </div></div>}
    </div>
  );
}

interface WorkspaceTreeProps {
  readonly repos: readonly RepoCandidate[];
  readonly reposError: boolean;
  readonly reposTruncated: boolean;
  readonly scanDepth: number;
  readonly worktrees: readonly WorktreeCandidate[];
  readonly worktreesError: boolean;
  readonly refs: Refs;
  readonly refsError: boolean;
  readonly changedFiles: ChangedFilesState;
  readonly selectedRel: string;
  readonly source: Source;
  readonly refFilter: string | null;
  readonly onRepository: (repo: RepoCandidate | WorktreeCandidate) => void;
  readonly onScanDepth: (depth: number) => void;
  readonly onRetryRepos: () => void;
  readonly onRetryWorktrees: () => void;
  readonly onRetryRefs: () => void;
  readonly onSource: (source: Source) => void;
  readonly onRef: (ref: string) => void;
}

function WorkspaceTree({ repos, reposError, reposTruncated, scanDepth, worktrees, worktreesError, refs, refsError, changedFiles, selectedRel, source, refFilter, onRepository, onScanDepth, onRetryRepos, onRetryWorktrees, onRetryRefs, onSource, onRef }: WorkspaceTreeProps) {
  const [query, setQuery] = useState("");
  const rootRepos = repos.filter((repo) => repo.kind === "root").sort((a, b) => a.name.localeCompare(b.name));
  const nestedRepos = repos.filter((repo) => repo.kind === "nested");
  const nestedTree = buildRepoTree(nestedRepos);
  const matchRepository = (repo: RepoCandidate) => fuzzyMatch(query, repo.name) ?? fuzzyMatch(query, repo.relPath);
  const rootMatches = query ? rootRepos.filter((repo) => matchRepository(repo) !== null) : rootRepos;
  const nestedMatches = query ? nestedRepos.filter((repo) => matchRepository(repo) !== null) : nestedRepos;
  const matchedCount = rootMatches.length + nestedMatches.length;
  const branchCount = refs.branches.length + refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)).length;
  const changesCount = changedFiles.kind === "ok" ? changedFiles.files.length : 0;
  const sections = buildWorkspaceTreeSections({
    context: repos.length,
    changes: changesCount,
    worktrees: worktrees.length,
    branches: branchCount,
    tags: refs.tags.length,
    stashes: refs.stashes.length,
  });
  const sectionHeader = (id: (typeof sections)[number]["id"]) => {
    const section = sections.find((item) => item.id === id)!;
    return <div className="repository-ws-section-head"><span>{section.label}</span><i>{section.count}</i></div>;
  };
  const refRows = (refSource: RefSource) => buildRefListGroups(refSource, refs).map((group) => <div key={group.label ?? refSource} className="repository-ws-ref-group">
    {group.label && <span className="repository-ws-ref-subhead">{group.label}</span>}
    {group.rows.map((row) => <button type="button" key={row.key} className={`repository-ws-tree-row${row.current ? " is-current" : ""}${source === "history" && row.ref === refFilter ? " is-active" : ""}`} disabled={row.ref === null} onClick={() => row.ref && onRef(row.ref)}>
      <SourceIcon source={row.source} /><span>{row.primary}</span>{row.current && <i>HEAD</i>}{row.sub && <i>{row.sub}</i>}
    </button>)}
  </div>);
  return <aside className="repository-ws-tree">
    <RepositoryDiscovery query={query} onQuery={setQuery} totalCount={repos.length} matchedCount={matchedCount} scanDepth={scanDepth} onScanDepth={onScanDepth} truncated={reposTruncated} onEnter={() => {
      const first = rootMatches[0] ?? nestedMatches[0];
      if (first) onRepository(first);
    }} />
    <div className="repository-ws-tree-scroll">
      <section className="repository-ws-section">{sectionHeader("context")}
        {reposError ? <WorkspaceTreeError label="Unable to load repositories" onRetry={onRetryRepos} /> : <>
          {rootMatches.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />)}
          {query ? nestedMatches.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />) : <RepoTreeChildren node={nestedTree} depth={0} selectedRel={selectedRel} onRepository={onRepository} />}
          {query && matchedCount === 0 && <div className="repository-empty-row">No matching repositories</div>}
        </>}
      </section>
      <section className="repository-ws-section">{sectionHeader("working")}
        <button type="button" className={`repository-ws-tree-row${source === "history" ? " is-active" : ""}`} onClick={() => onSource("history")}><SourceIcon source="history" /><span>History</span></button>
        <button type="button" className={`repository-ws-tree-row${source === "changes" ? " is-active" : ""}`} onClick={() => onSource("changes")}><SourceIcon source="changes" /><span>Changes</span><i>{changesCount}</i></button>
        <button type="button" className={`repository-ws-tree-row${source === "compare" ? " is-active" : ""}`} onClick={() => onSource("compare")}><SourceIcon source="compare" /><span>Compare</span></button>
      </section>
      <section className="repository-ws-section">{sectionHeader("worktrees")}
        {worktreesError ? <WorkspaceTreeError label="Unable to load worktrees" onRetry={onRetryWorktrees} /> : worktrees.map((worktree) => <button type="button" key={worktree.relPath} className={`repository-ws-tree-row${worktree.relPath === selectedRel ? " is-current" : ""}`} title={worktree.relPath} onClick={() => onRepository(worktree)}><SourceIcon source="worktrees" /><span>{worktree.name}</span>{worktree.current && <i>HEAD</i>}</button>)}
      </section>
      <section className="repository-ws-section">{sectionHeader("branches")}
        {refsError ? <WorkspaceTreeError label="Unable to load refs" onRetry={onRetryRefs} /> : refRows("branches")}
      </section>
      <section className="repository-ws-section">{sectionHeader("tags")}{!refsError && refRows("tags")}</section>
      <section className="repository-ws-section">{sectionHeader("stashes")}{!refsError && refRows("stashes")}</section>
    </div>
  </aside>;
}

function WorkspaceTreeError({ label, onRetry }: { readonly label: string; readonly onRetry: () => void }) {
  return <div className="repository-ws-tree-error"><span>{label}</span><button type="button" onClick={onRetry}>Retry</button></div>;
}

function WorkspaceToggleIcon({ expanded }: { readonly expanded: boolean }) {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">{expanded ? <><path d="M6 2v4H2M10 14v-4h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.5 5.5L6 2M13.5 10.5L10 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></> : <><path d="M2 6V2h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /><path d="M5.5 2.5L2 6M10.5 13.5L14 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>}</svg>;
}

function SourceIcon({ source }: { readonly source: Source }) { const path = source === "repositories" ? "M3 5h12v9H3zM5 3h8v2" : source === "worktrees" ? "M5 3v12M5 6h7M5 12h7" : source === "changes" ? "M3 4h12M3 9h12M3 14h12" : source === "history" ? "M4 4v10h10M7 7h6v5" : source === "compare" ? "M5.5 3v9M3 9.5l2.5 2.5L8 9.5M12.5 15V6M10 8.5L12.5 6L15 8.5" : source === "branches" ? "M5 3v12M5 6h7M5 12h7" : source === "tags" ? "M3 4h8l4 4-7 7-5-5z" : "M4 5h10v9H4zM6 3h6"; return <svg viewBox="0 0 18 18" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function SourceNav({ source, refs, repos, worktrees, onSource }: { readonly source: Source; readonly refs: Refs; readonly repos: readonly RepoCandidate[]; readonly worktrees: readonly WorktreeCandidate[]; readonly onSource: (source: Source) => void }) { const button = (id: Source, label: string, count?: number) => <button key={id} type="button" aria-label={label} aria-current={source === id ? "page" : undefined} onClick={() => onSource(id)}><SourceIcon source={id} /><span>{label}</span>{count !== undefined && <i>{count}</i>}</button>; return <nav className="repository-source-nav" aria-label="Repository sources"><b>CONTEXT</b>{button("repositories", "Repositories", repos.length)}{button("worktrees", "Worktrees", worktrees.length)}<b>WORKING</b>{button("changes", "Changes")}{button("history", "History")}{button("compare", "Compare")}<b>REFS</b>{button("branches", "Branches", refs.branches.length + refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)).length)}{button("tags", "Tags", refs.tags.length)}{button("stashes", "Stashes", refs.stashes.length)}</nav>; }
function RepositoryDiscovery({ query, onQuery, totalCount, matchedCount, scanDepth, onScanDepth, truncated, onEnter }: { readonly query: string; readonly onQuery: (query: string) => void; readonly totalCount: number; readonly matchedCount: number; readonly scanDepth: number; readonly onScanDepth: (depth: number) => void; readonly truncated: boolean; readonly onEnter: () => void }) {
  return <div className="repository-discovery">
    <input type="text" className="repository-filter-input" placeholder="Find repositories…" aria-label="Find repositories" value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      onEnter();
    }} />
    {query ? <button type="button" className="repository-filter-clear" aria-label="Clear search" onClick={() => onQuery("")}>✕</button> : null}
    <span className="repository-discovery-depth">Depth
      <button type="button" className="repository-depth-step" aria-label="Scan shallower" disabled={scanDepth <= SCAN_DEPTH_MIN} onClick={() => onScanDepth(scanDepth - 1)}>−</button>
      <output className="repository-depth-value">{scanDepth}</output>
      <button type="button" className="repository-depth-step" aria-label="Scan deeper" disabled={scanDepth >= SCAN_DEPTH_MAX} onClick={() => onScanDepth(scanDepth + 1)}>+</button>
    </span>
    <span className="repository-scan-count">{query ? `${matchedCount} of ${totalCount}` : `${totalCount} found${truncated ? " · limit reached" : ""}`}</span>
  </div>;
}
function RepoList({ repos, selectedRel, onRepository, scanDepth, onScanDepth, truncated }: { readonly repos: readonly RepoCandidate[]; readonly selectedRel: string; readonly onRepository: (repo: RepoCandidate) => void; readonly scanDepth: number; readonly onScanDepth: (depth: number) => void; readonly truncated: boolean }) {
  const [query, setQuery] = useState("");
  // 루트 저장소는 컨텍스트 복귀 affordance이므로 트리 밖 THIS THEATER 그룹에 고정한다.
  // (repos.ts 주석의 의도 — nested 저장소로 진입해도 루트로 되돌아오는 진입점이 필요.)
  const rootRepos = repos.filter((repo) => repo.kind === "root").sort((a, b) => a.name.localeCompare(b.name));
  const nestedRepos = repos.filter((repo) => repo.kind === "nested");
  const nestedTree = buildRepoTree(nestedRepos);
  const matchRepository = (repo: RepoCandidate) => {
    const nameMatch = fuzzyMatch(query, repo.name);
    const match = nameMatch ?? fuzzyMatch(query, repo.relPath);
    return match === null ? null : { repo, nameMatch: nameMatch ?? undefined };
  };
  const rootMatches = query ? rootRepos.map(matchRepository).filter((match) => match !== null) : [];
  const nestedMatches = query ? nestedRepos.map(matchRepository).filter((match) => match !== null) : [];
  const matchedCount = rootMatches.length + nestedMatches.length;
  const groups: readonly { readonly key: string; readonly label: "THIS THEATER" | "NESTED"; readonly render: () => ReactNode }[] = query ? [
    ...(rootMatches.length > 0 ? [{ key: "root", label: "THIS THEATER" as const, render: () => <>{rootMatches.map(({ repo, nameMatch }) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} nameMatch={nameMatch} />)}</> }] : []),
    ...(nestedMatches.length > 0 ? [{ key: "nested", label: "NESTED" as const, render: () => <>{nestedMatches.map(({ repo, nameMatch }) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} nameMatch={nameMatch} />)}</> }] : []),
  ] : [
    ...(rootRepos.length > 0 ? [{ key: "root", label: "THIS THEATER" as const, render: () => <>{rootRepos.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />)}</> }] : []),
    ...(nestedRepos.length > 0 ? [{ key: "nested", label: "NESTED" as const, render: () => <RepoTreeChildren node={nestedTree} depth={0} selectedRel={selectedRel} onRepository={onRepository} /> }] : []),
  ];
  return <div className="repository-scan-pane">
    <RepositoryDiscovery query={query} onQuery={setQuery} totalCount={repos.length} matchedCount={matchedCount} scanDepth={scanDepth} onScanDepth={onScanDepth} truncated={truncated} onEnter={() => {
      const firstMatch = rootMatches[0] ?? nestedMatches[0];
      if (firstMatch) onRepository(firstMatch.repo);
    }} />
    <div className="repository-ref-list">{groups.map((group) => <div key={group.key} className="repository-ref-group"><b className="repository-ref-group-label">{group.label}</b>{group.render()}</div>)}{query && matchedCount === 0 ? <div className="repository-empty-row">No matching repositories</div> : null}</div>
  </div>;
}

interface RepoTreeCommonProps {
  readonly selectedRel: string;
  readonly onRepository: (repo: RepoCandidate) => void;
}

function RepoTreeChildren({ node, depth, selectedRel, onRepository }: { readonly node: RepoTreeNode; readonly depth: number } & RepoTreeCommonProps) {
  return <>
    {Object.entries(node.dirs).map(([key, child]) => <RepoTreeFolder key={key} dirKey={key} node={child} depth={depth} selectedRel={selectedRel} onRepository={onRepository} />)}
    {node.repos.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={depth} selectedRel={selectedRel} onRepository={onRepository} />)}
  </>;
}

function RepoTreeFolder({ dirKey, node, depth, selectedRel, onRepository }: { readonly dirKey: string; readonly node: RepoTreeNode; readonly depth: number } & RepoTreeCommonProps) {
  const [collapsed, setCollapsed] = useState(false);
  const handleToggle = useCallback(() => setCollapsed((value) => !value), []);
  const { label, node: resolvedNode } = compressRepoFolder(dirKey, node);
  const indent = depth * 16 + 12;
  const total = countRepos(resolvedNode);
  return <div className={`repository-folder${collapsed ? " is-collapsed" : ""}`}>
    <button type="button" className="repository-folder-row" style={{ paddingLeft: `${indent}px`, gridTemplateColumns: "12px 15px 1fr auto" }} onClick={handleToggle} aria-expanded={!collapsed}>
      <svg className="repository-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="repository-folder-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="repository-folder-name">{label}</span>
      <span className="repository-folder-count">{total}</span>
    </button>
    {!collapsed && <RepoTreeChildren node={resolvedNode} depth={depth + 1} selectedRel={selectedRel} onRepository={onRepository} />}
  </div>;
}

function RepoLeafRow({ repo, depth, selectedRel, onRepository, nameMatch }: { readonly repo: RepoCandidate; readonly depth: number; readonly nameMatch?: readonly number[] } & RepoTreeCommonProps) {
  // 저장소 리프 아이콘을 폴더 아이콘 컬럼(padding-left 12 + chevron 12 + gap 6 = 30) 아래에 정렬한다.
  const indent = depth * 16 + 30;
  return <button type="button" title={repo.relPath} className={`repository-ref-row${repo.relPath === selectedRel ? " is-current" : ""}`} style={{ paddingLeft: `${indent}px` }} onClick={() => onRepository(repo)}>
    <SourceIcon source="repositories" />
    <span className="repository-ref-name">{nameMatch ? Array.from(repo.name).map((character, index) => nameMatch.includes(index) ? <b key={index} className="repository-ref-hl">{character}</b> : character) : repo.name}</span>{repo.relPath === selectedRel && <span className="repository-ref-mark">✓</span>}
    {repo.branch && <span className="repository-ref-sub">{repo.branch}</span>}
  </button>;
}
function WorktreeList({ worktrees, onWorktree }: { readonly worktrees: readonly WorktreeCandidate[]; readonly onWorktree: (worktree: WorktreeCandidate) => void }) { return <div className="repository-ref-list">{worktrees.map((worktree) => <button type="button" key={worktree.relPath} title={worktree.relPath} className={`repository-ref-row${worktree.current ? " is-current" : ""}`} onClick={() => onWorktree(worktree)}><SourceIcon source="worktrees" /><span className="repository-ref-name">{worktree.name}</span>{worktree.current && <span className="repository-ref-mark">✓</span>}{worktree.branch && <span className="repository-ref-sub">{worktree.branch}</span>}</button>)}</div>; }
function RefList({ source, refs, onRef }: { readonly source: Source; readonly refs: Refs; readonly onRef: (ref: string) => void }) {
  if (source === "repositories" || source === "worktrees" || source === "changes" || source === "history" || source === "compare") return null;
  return <div className="repository-ref-list">{buildRefListGroups(source, refs).map((group) => <div key={group.label ?? source} className="repository-ref-group">{group.label && <b className="repository-ref-group-label">{group.label}</b>}{group.rows.map((row) => {
    return <button type="button" key={row.key} className={`repository-ref-row${row.current ? " is-current" : ""}`} disabled={row.ref === null} onClick={() => {
      if (row.ref) onRef(row.ref);
    }}><SourceIcon source={row.source} /><span className="repository-ref-name">{row.primary}</span>{row.current && <span className="repository-ref-mark">✓</span>}{row.sub && <span className="repository-ref-sub">{row.sub}</span>}</button>;
  })}</div>)}</div>;
}

function RepositoryIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" /><rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" /></svg>;
}

export const repositoryPanel: RailPanelDescriptor = {
  id: "repository",
  title: "Repository",
  icon: () => <RepositoryIcon />,
  render: (ctx: RailPanelContext) => <RepositoryPanel ctx={ctx} />,
};
