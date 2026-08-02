import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { RailPanelContext, RailPanelDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffFileMode, DiffListResult, RepoCandidate, RepositorySearchResult, ReposResult, WorktreeCandidate, WorktreesResult } from "../server/types.js";
import "./repository.css";
import { ChangedFiles, type ChangedFilesState } from "./changed-files.js";
import { CompareView } from "./compare-view.js";
import { fuzzyMatch } from "./repository-parsers.js";
import { getT, type RepositoryMessageKey } from "./i18n/index.js";
import { buildRepoTree, compressRepoFolder, countRepos, type RepoTreeNode } from "./repository-parsers.js";
import { clearSelectedFile, setSelectedFile, type SelectedFile, useSelectedFile } from "./repository-state.js";
import { HunkView } from "./hunk-view.js";
import { dropHistoryCacheForRepository } from "./repository-state.js";
import { HistoryPanel } from "./history-panel.js";
import { dropRepoViewState, readRepoViewState, readWorkspaceTreeState, writeRepoViewState, writeWorkspaceTreeState } from "./repository-state.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth } from "./rail-layout.js";
import { buildWorkspaceTreeSections, clampWorkspaceTreeWidth, readWorkspaceTreeWidth, saveWorkspaceTreeWidth } from "./workspace-layout.js";
import { activateRepositorySearchTarget, useRepositorySearchTarget } from "./repository-state.js";

type T = Translate<RepositoryMessageKey>;

type ViewMode = "list" | "tree";

type RepositoryFetchResult =
  | { readonly ok: true; readonly skipped: "throttled"; readonly lastFetchAt: string }
  | { readonly ok: true; readonly fetchedAt: string; readonly lastFetchAt: string; readonly pruned: number; readonly newRefs: number; readonly updatedRefs: number };

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
    if (value === "changes" || value === "history" || value === "compare") return value;
  } catch { /* ignore */ }
  // 구 소스 페이지 값(repositories/branches 등)은 워크스페이스 중앙 뷰가 아니므로 History로 착지한다.
  return "history";
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

export type Source = "changes" | "history" | "compare";
type RefSource = "branches" | "tags" | "stashes";
type SourceIconKind = Source | RefSource | "repositories" | "worktrees";
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
  const t = getT(ctx.language);
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
  const [initialRepoViewState] = useState(() => ctx.theaterId ? readRepoViewState(ctx.theaterId, repoRel) : null);
  const repoRelRef = useRef(repoRel);
  const [source, setSourceState] = useState<Source>(readRepositorySource);
  const [treeWidth, setTreeWidth] = useState(readWorkspaceTreeWidth);
  const treeWidthRef = useRef(treeWidth);
  const [isTreeDragging, setIsTreeDragging] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [refFilter, setRefFilter] = useState<string | null>(initialRepoViewState?.refFilter ?? null);
  const [refs, setRefs] = useState<Refs>({ branches: [], remotes: [], tags: [], stashes: [] });
  const [refsError, setRefsError] = useState(false); const [refsRetry, setRefsRetry] = useState(0);
  const [changedFiles, setChangedFiles] = useState<ChangedFilesState>({ kind: "loading" });
  const [changedFilesRetry, setChangedFilesRetry] = useState(0);
  const [historyExternalRefreshToken, setHistoryExternalRefreshToken] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const syncRequestIdRef = useRef(0);
  const autoSyncTheaterRef = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [filterText, setFilterText] = useState(initialRepoViewState?.filterText ?? "");
  const [collapsedChangeFolders, setCollapsedChangeFolders] = useState(() => new Set(initialRepoViewState?.collapsedFolders ?? []));
  const repoViewCacheKey = `${ctx.theaterId ?? ""}\x00${repoRel}`;
  const [hydratedRepoViewCacheKey, setHydratedRepoViewCacheKey] = useState(repoViewCacheKey);
  const freshRefFilterCacheKeyRef = useRef<string | null>(null);
  const changesListRef = useRef<HTMLDivElement>(null);
  const restoredChangesScrollTopRef = useRef<number | null>(initialRepoViewState?.scrollTop ?? null);
  const changesScrollTopRef = useRef(initialRepoViewState?.scrollTop ?? 0);
  const changesCacheFrameRef = useRef<number | null>(null);
  // 동일 컨텍스트 재착지는 repoRel key가 안 바뀌어 History 패널이 리마운트되지 않는다 —
  // epoch를 key에 섞어 전환 착지와 동일한 초기 상태(로컬 필터·선택·스크롤)로 재설정한다.
  const [historyLandingEpoch, setHistoryLandingEpoch] = useState(0);
  const searchTarget = useRepositorySearchTarget();
  const selectedFile = useSelectedFile(ctx.theaterId ?? null, repoRel);
  const [listPaneWidth, setListPaneWidth] = useState(readListPaneWidth);
  const listPaneWidthRef = useRef(listPaneWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const setSource = useCallback((next: Source) => {
    setSourceState(next);
    saveRepositorySource(next);
  }, []);
  const handleTreeDividerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = layoutRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const startWidth = treeWidthRef.current;
    setIsTreeDragging(true);
    const onMove = (move: PointerEvent) => {
      const next = clampWorkspaceTreeWidth(startWidth, move.clientX - startX, containerWidth);
      if (next !== null) {
        treeWidthRef.current = next;
        setTreeWidth(next);
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsTreeDragging(false);
      saveWorkspaceTreeWidth(treeWidthRef.current);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);
  const repoViewSnapshotRef = useRef({ theaterId: ctx.theaterId, repoRel, repoViewCacheKey, hydratedRepoViewCacheKey, filterText, refFilter, collapsedChangeFolders });
  repoViewSnapshotRef.current = { theaterId: ctx.theaterId, repoRel, repoViewCacheKey, hydratedRepoViewCacheKey, filterText, refFilter, collapsedChangeFolders };
  const flushChangesCache = useCallback(() => {
    const snapshot = repoViewSnapshotRef.current;
    if (!snapshot.theaterId || snapshot.hydratedRepoViewCacheKey !== snapshot.repoViewCacheKey) return;
    writeRepoViewState(snapshot.theaterId, snapshot.repoRel, {
      filterText: snapshot.filterText,
      refFilter: snapshot.refFilter,
      scrollTop: changesScrollTopRef.current,
      collapsedFolders: [...snapshot.collapsedChangeFolders],
    });
  }, []);
  const scheduleChangesCacheWrite = useCallback(() => {
    if (changesCacheFrameRef.current !== null) return;
    changesCacheFrameRef.current = requestAnimationFrame(() => {
      changesCacheFrameRef.current = null;
      flushChangesCache();
    });
  }, [flushChangesCache]);
  const transitionRepository = useCallback((nextRepoRel: string, persist: boolean, landing: Source = "changes") => {
    if (!ctx.theaterId) return;
    // rAF로 미뤄둔 이전 스코프의 캐시 write가 있다면 스코프가 바뀌기 전에 동기로 flush한다 —
    // 전환 후 발화하면 snapshot이 새 스코프로 바뀌어 이전 스코프의 마지막 스크롤/필터가 소실된다.
    if (changesCacheFrameRef.current !== null) {
      cancelAnimationFrame(changesCacheFrameRef.current);
      changesCacheFrameRef.current = null;
    }
    flushChangesCache();
    if (persist) saveRepositoryRel(ctx.theaterId, nextRepoRel);
    clearSelectedFile();
    syncRequestIdRef.current += 1;
    setSyncing(false);
    setChangedFiles({ kind: "loading" });
    setRefs({ branches: [], remotes: [], tags: [], stashes: [] });
    repoRelRef.current = nextRepoRel;
    setRepoRel(nextRepoRel);
    setSource(landing);
  }, [ctx.theaterId, flushChangesCache, setSource]);
  useEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== ctx.theaterId) return;
    setRefFilter(null);
    if (repoRelRef.current !== searchTarget.repoRel) {
      freshRefFilterCacheKeyRef.current = `${searchTarget.theaterId}\x00${searchTarget.repoRel}`;
      transitionRepository(searchTarget.repoRel, true, "history");
      return;
    }
    setSource("history");
  }, [ctx.theaterId, searchTarget, setSource, transitionRepository]);
  useLayoutEffect(() => {
    if (hydratedRepoViewCacheKey === repoViewCacheKey) return;
    const cached = ctx.theaterId ? readRepoViewState(ctx.theaterId, repoRel) : null;
    const freshRefLanding = freshRefFilterCacheKeyRef.current === repoViewCacheKey;
    setFilterText(cached?.filterText ?? "");
    setRefFilter(freshRefLanding ? null : cached?.refFilter ?? null);
    setCollapsedChangeFolders(new Set(cached?.collapsedFolders ?? []));
    const restoredScrollTop = cached?.scrollTop ?? 0;
    restoredChangesScrollTopRef.current = restoredScrollTop;
    changesScrollTopRef.current = restoredScrollTop;
    setHydratedRepoViewCacheKey(repoViewCacheKey);
    if (freshRefLanding) freshRefFilterCacheKeyRef.current = null;
  }, [ctx.theaterId, hydratedRepoViewCacheKey, repoRel, repoViewCacheKey]);
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

  const refreshRepositoryData = useCallback(() => {
    setRefsRetry((value) => value + 1);
    setWorktreesRetry((value) => value + 1);
    setChangedFilesRetry((value) => value + 1);
    setReposRetry((value) => value + 1);
    setHistoryExternalRefreshToken((value) => value + 1);
  }, []);
  const syncRepository = useCallback(async (mode?: "auto") => {
    if (!ctx.theaterId) return;
    const requestId = ++syncRequestIdRef.current;
    setSyncing(true);
    let response: Response;
    try {
      response = await fetch("/plugins/repository/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ...(mode ? { mode } : {}) }),
      });
    } catch {
      if (requestId !== syncRequestIdRef.current) return;
      setSyncing(false);
      return;
    }
    const payload = await response.json().catch(() => ({})) as RepositoryFetchResult | { readonly error?: string };
    if (requestId !== syncRequestIdRef.current) return;
    setSyncing(false);
    if (!response.ok || !("ok" in payload) || payload.ok !== true) return;
    if ("skipped" in payload) return;
    refreshRepositoryData();
  }, [ctx.theaterId, refreshRepositoryData, repoRel]);
  useEffect(() => {
    if (!ctx.theaterId) return;
    const contextKey = `${ctx.theaterId}:${repoRel}`;
    if (autoSyncTheaterRef.current === contextKey) return;
    autoSyncTheaterRef.current = contextKey;
    void syncRepository("auto");
  }, [ctx.theaterId, repoRel, syncRepository]);

  useLayoutEffect(() => () => clearSelectedFile(), []);

  const updateChangesScroll = useCallback(() => {
    const list = changesListRef.current;
    if (!list || list.clientHeight <= 0 || list.scrollHeight <= 0) return;
    if (restoredChangesScrollTopRef.current !== null) {
      const restoredScrollTop = restoredChangesScrollTopRef.current;
      if (restoredScrollTop > 0 && list.scrollHeight <= list.clientHeight) return;
      list.scrollTop = restoredScrollTop;
      restoredChangesScrollTopRef.current = null;
    }
    changesScrollTopRef.current = list.scrollTop;
    scheduleChangesCacheWrite();
  }, [scheduleChangesCacheWrite]);
  useLayoutEffect(() => {
    updateChangesScroll();
    const list = changesListRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateChangesScroll);
    observer.observe(list);
    return () => observer.disconnect();
  }, [changedFiles, filterText, hydratedRepoViewCacheKey, updateChangesScroll, viewMode]);
  useEffect(() => {
    scheduleChangesCacheWrite();
  }, [collapsedChangeFolders, filterText, hydratedRepoViewCacheKey, refFilter, repoRel, scheduleChangesCacheWrite]);
  useEffect(() => () => {
    if (changesCacheFrameRef.current !== null) {
      cancelAnimationFrame(changesCacheFrameRef.current);
      changesCacheFrameRef.current = null;
    }
    flushChangesCache();
  }, [flushChangesCache]);

  const handleSelectFile = useCallback((entry: DiffFileEntry) => {
    if (ctx.theaterId) setSelectedFile(entry, ctx.theaterId, repoRel);
  }, [ctx.theaterId, repoRel]);
  const handleSelectRepository = useCallback((next: { readonly relPath: string }) => {
    const decision = resolveRepositorySelection(ctx.theaterId, repoRel, next.relPath);
    // 동일 컨텍스트 재선택도 "이 체크아웃의 History" 착지다 — refFilter를 걷어내고 History 패널을
    // epoch 리마운트해 전환 착지와 동일한 초기 상태로 만든다(스코프된 로그·WIP 숨김 잔존 방지).
    if (!decision.transition) {
      dropHistoryCacheForRepository(`${ctx.theaterId ?? ""}:${next.relPath}`);
      if (ctx.theaterId) {
        dropRepoViewState(ctx.theaterId, next.relPath);
        setHydratedRepoViewCacheKey("");
      }
      setRefFilter(null);
      setHistoryLandingEpoch((value) => value + 1);
      setSource(decision.landing);
      return;
    }
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

  const hunkMode = selectedFile ? getHunkMode(selectedFile) : null;
  const retryChangedFiles = useCallback(() => setChangedFilesRetry((value) => value + 1), []);
  const handleToggleChangeFolder = useCallback((path: string) => {
    setCollapsedChangeFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const wipFiles = changedFiles.kind === "ok" ? changedFiles.files : [];
  const selectedRepo = repos.find((repo) => repo.relPath === repoRel) ?? worktrees.find((worktree) => worktree.relPath === repoRel);
  const changesView = <div ref={rootRef} className={`repository-root${selectedFile ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={selectedFile ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
    {selectedFile && hunkMode ? <div className="repository-hunk-pane"><div className="repository-hunk-head"><span>{selectedFile.entry.path}</span><button type="button" onClick={handleCloseHunk}>✕</button></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile.entry} mode={hunkMode} /></div> : null}
    {selectedFile ? <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" /> : null}
    <div className="repository-list-pane">
      <div className="repository-toolbar"><div className="repository-filter"><input type="text" className="repository-filter-input" placeholder={t("repository.common.filterPlaceholder")} aria-label={t("repository.common.filterChangedFiles")} value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText ? <button type="button" className="repository-filter-clear" aria-label={t("repository.common.clearFilter")} onClick={() => setFilterText("")}>✕</button> : null}</div><div className="repository-view-toggle"><button type="button" className={`repository-toggle-btn${viewMode === "list" ? " is-active" : ""}`} title={t("repository.common.listView")} aria-pressed={viewMode === "list"} onClick={() => handleViewMode("list")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><line x1="2" y1="3.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="2" y1="10.5" x2="12" y2="10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button><button type="button" className={`repository-toggle-btn${viewMode === "tree" ? " is-active" : ""}`} title={t("repository.common.treeView")} aria-pressed={viewMode === "tree"} onClick={() => handleViewMode("tree")}><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="1" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="1" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /><rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" strokeWidth="1.3" /></svg></button></div></div>
      <ChangedFiles state={changedFiles} onRetry={retryChangedFiles} viewMode={viewMode} selectedPath={selectedFile?.entry.path ?? null} onSelect={handleSelectFile} filterText={filterText} t={t} collapsedFolders={collapsedChangeFolders} onToggleFolder={handleToggleChangeFolder} scrollContainerRef={changesListRef} onScroll={updateChangesScroll} />
    </div>
  </div>;
  const compareView = <CompareView key={`${ctx.theaterId ?? ""}:${repoRel}`} ctx={ctx} repoRel={repoRel} refs={refs} refsError={refsError} onRetryRefs={() => setRefsRetry((value) => value + 1)} />;
  // 컴팩트 레이아웃과 동일하게 Changes/Compare를 hidden으로 상시 마운트해 섹션 전환에도 내부 상태를 보존한다.
  const workspaceMainVisible = source === "changes" || source === "compare";
  const workspaceMain = <>
    <div className="repository-source-fill" hidden={source !== "changes"}>{changesView}</div>
    <div className="repository-source-fill" hidden={source !== "compare"}>{compareView}</div>
  </>;
  return (
    <div className="repository-unified is-workspace">
      <div className={`repository-identity${repoRel ? " is-subcontext" : ""}`}><RepositoryIcon /><strong>{selectedRepo?.name ?? t("repository.panel.title")}</strong>{selectedRepo?.branch && <span>{selectedRepo.branch}</span>}<button type="button" className={`repository-sync-button${syncing ? " is-syncing" : ""}`} title={t("repository.sync.title")} aria-label={t("repository.sync.title")} disabled={syncing} onClick={() => { void syncRepository(); }}><span className="repository-sync-icon" aria-hidden="true">↻</span>{t("repository.sync.button")}</button></div>
      <div ref={layoutRef} className={`repository-ws-layout${isTreeDragging ? " is-dragging" : ""}`} style={{ "--ws-tree-width": `${treeWidth}px` } as React.CSSProperties}>
        <WorkspaceTree theaterId={ctx.theaterId ?? ""} t={t} repos={repos} reposError={reposError} reposTruncated={reposTruncated} scanDepth={scanDepth} worktrees={worktrees} worktreesError={worktreesError} refs={refs} refsError={refsError} changedFiles={changedFiles} selectedRel={repoRel} source={source} refFilter={refFilter} onRepository={handleSelectRepository} onScanDepth={setScanDepth} onRetryRepos={() => setReposRetry((value) => value + 1)} onRetryWorktrees={() => setWorktreesRetry((value) => value + 1)} onRetryRefs={() => setRefsRetry((value) => value + 1)} onSource={setSource} onRef={(ref) => { setRefFilter(ref); setSource("history"); }} />
        <div className="repository-divider repository-ws-tree-divider" onPointerDown={handleTreeDividerDown} role="separator" aria-orientation="vertical" aria-label={t("repository.common.resizeSourceTree")} />
        <HistoryPanel key={`${ctx.theaterId ?? ""}:${repoRel}:${historyLandingEpoch}`} cacheScope={`${ctx.theaterId ?? ""}:${repoRel}`} ctx={ctx} repoRel={repoRel} externalRefreshToken={historyExternalRefreshToken} active refFilter={refFilter} wipFiles={wipFiles} workspace workspaceMain={workspaceMain} workspaceMainVisible={workspaceMainVisible} onClearRef={() => setRefFilter(null)} onWip={() => setSource("changes")} />
      </div>
    </div>
  );
}

interface WorkspaceTreeProps {
  readonly theaterId?: string;
  readonly t: T;
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

export function WorkspaceTree({ theaterId = "", t, repos, reposError, reposTruncated, scanDepth, worktrees, worktreesError, refs, refsError, changedFiles, selectedRel, source, refFilter, onRepository, onScanDepth, onRetryRepos, onRetryWorktrees, onRetryRefs, onSource, onRef }: WorkspaceTreeProps) {
  const [initialTreeState] = useState(() => readWorkspaceTreeState(theaterId));
  const [query, setQuery] = useState(initialTreeState?.query ?? "");
  const [collapsedSections, setCollapsedSections] = useState(() => new Set(initialTreeState?.collapsedSections ?? ["tags", "stashes"]));
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set(initialTreeState?.collapsedFolders ?? []));
  const handleToggleRepoFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const rootRepos = repos.filter((repo) => repo.kind === "root").sort((a, b) => a.name.localeCompare(b.name));
  const nestedRepos = repos.filter((repo) => repo.kind === "nested");
  const nestedTree = buildRepoTree(nestedRepos);
  const matchRepository = (repo: RepoCandidate) => fuzzyMatch(query, repo.name) ?? fuzzyMatch(query, repo.relPath);
  const rootMatches = query ? rootRepos.filter((repo) => matchRepository(repo) !== null) : rootRepos;
  const nestedMatches = query ? nestedRepos.filter((repo) => matchRepository(repo) !== null) : nestedRepos;
  const matchedCount = rootMatches.length + nestedMatches.length;
  const branchCount = refs.branches.length + refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)).length;
  const refRowCount = refs.branches.length + refs.remotes.length + refs.tags.length + refs.stashes.length;
  const changesCount = changedFiles.kind === "ok" ? changedFiles.files.length : 0;
  const sections = buildWorkspaceTreeSections({
    context: repos.length,
    changes: changesCount,
    worktrees: worktrees.length,
    branches: branchCount,
    tags: refs.tags.length,
    stashes: refs.stashes.length,
  }, t);
  const sectionHeader = (id: (typeof sections)[number]["id"]) => {
    const section = sections.find((item) => item.id === id)!;
    const collapsed = collapsedSections.has(id);
    return <button type="button" className="repository-ws-section-head" aria-expanded={!collapsed} onClick={() => {
      setCollapsedSections((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }}>
      <svg className="repository-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{section.label}</span><i>{section.count}</i>
    </button>;
  };
  const refRows = (refSource: RefSource) => buildRefListGroups(refSource, refs).map((group) => <div key={group.label ?? refSource} className="repository-ws-ref-group">
    {group.label && <span className="repository-ws-ref-subhead">{t(group.label === "LOCAL" ? "repository.refs.local" : "repository.refs.remotes")}</span>}
    {group.rows.map((row) => <button type="button" key={row.key} className={`repository-ws-tree-row${row.current ? " is-current" : ""}${source === "history" && row.ref === refFilter ? " is-active" : ""}`} disabled={row.ref === null} onClick={() => row.ref && onRef(row.ref)}>
      <SourceIcon source={row.source} /><span>{row.primary}</span>{row.current && <i>HEAD</i>}{row.sub && <i>{row.sub}</i>}
    </button>)}
  </div>);
  return <aside className="repository-ws-tree">
    <RepositoryDiscovery t={t} query={query} onQuery={setQuery} totalCount={repos.length} matchedCount={matchedCount} scanDepth={scanDepth} onScanDepth={onScanDepth} truncated={reposTruncated} onEnter={() => {
      const first = rootMatches[0] ?? nestedMatches[0];
      if (first) onRepository(first);
    }} />
    <WorkspaceTreeScroll theaterId={theaterId} query={query} collapsedSections={collapsedSections} collapsedFolders={collapsedFolders} initialScrollTop={initialTreeState?.scrollTop ?? 0} contentVersion={`${repos.length}:${worktrees.length}:${refRowCount}:${changesCount}:${collapsedSections.size}:${collapsedFolders.size}`}>
      <section className={`repository-ws-section${collapsedSections.has("context") ? " is-collapsed" : ""}`}>{sectionHeader("context")}
        {!collapsedSections.has("context") && (reposError ? <WorkspaceTreeError t={t} label={t("repository.discovery.loadReposFailed")} onRetry={onRetryRepos} /> : <>
          {rootMatches.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />)}
          {query ? nestedMatches.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />) : <RepoTreeChildren node={nestedTree} depth={0} parentPath="" collapsedFolders={collapsedFolders} onToggleFolder={handleToggleRepoFolder} selectedRel={selectedRel} onRepository={onRepository} />}
          {query && matchedCount === 0 && <div className="repository-empty-row">{t("repository.discovery.noMatching")}</div>}
        </>)}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("working") ? " is-collapsed" : ""}`}>{sectionHeader("working")}
        {!collapsedSections.has("working") && <>
          <button type="button" className={`repository-ws-tree-row${source === "history" ? " is-active" : ""}`} onClick={() => onSource("history")}><SourceIcon source="history" /><span>{t("repository.source.history")}</span></button>
          <button type="button" className={`repository-ws-tree-row${source === "changes" ? " is-active" : ""}`} onClick={() => onSource("changes")}><SourceIcon source="changes" /><span>{t("repository.source.changes")}</span><i>{changesCount}</i></button>
          <button type="button" className={`repository-ws-tree-row${source === "compare" ? " is-active" : ""}`} onClick={() => onSource("compare")}><SourceIcon source="compare" /><span>{t("repository.source.compare")}</span></button>
        </>}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("worktrees") ? " is-collapsed" : ""}`}>{sectionHeader("worktrees")}
        {!collapsedSections.has("worktrees") && (worktreesError ? <WorkspaceTreeError t={t} label={t("repository.discovery.loadWorktreesFailed")} onRetry={onRetryWorktrees} /> : worktrees.map((worktree) => <button type="button" key={worktree.relPath} className={`repository-ws-tree-row${worktree.relPath === selectedRel ? " is-current" : ""}`} title={worktree.relPath} onClick={() => onRepository(worktree)}><SourceIcon source="worktrees" /><span>{worktree.name}</span>{worktree.current && <i>HEAD</i>}</button>))}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("branches") ? " is-collapsed" : ""}`}>{sectionHeader("branches")}
        {!collapsedSections.has("branches") && (refsError ? <WorkspaceTreeError t={t} label={t("repository.discovery.loadRefsFailed")} onRetry={onRetryRefs} /> : refRows("branches"))}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("tags") ? " is-collapsed" : ""}`}>{sectionHeader("tags")}{!collapsedSections.has("tags") && !refsError && refRows("tags")}</section>
      <section className={`repository-ws-section${collapsedSections.has("stashes") ? " is-collapsed" : ""}`}>{sectionHeader("stashes")}{!collapsedSections.has("stashes") && !refsError && refRows("stashes")}</section>
    </WorkspaceTreeScroll>
  </aside>;
}

function WorkspaceTreeScroll({ theaterId, query, collapsedSections, collapsedFolders, initialScrollTop, contentVersion, children }: {
  readonly theaterId: string;
  readonly query: string;
  readonly collapsedSections: ReadonlySet<string>;
  readonly collapsedFolders: ReadonlySet<string>;
  readonly initialScrollTop: number;
  readonly contentVersion: string;
  readonly children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(initialScrollTop);
  const restoredScrollTopRef = useRef<number | null>(initialScrollTop);
  const cacheFrameRef = useRef<number | null>(null);
  const snapshotRef = useRef({ theaterId, query, collapsedSections, collapsedFolders });
  snapshotRef.current = { theaterId, query, collapsedSections, collapsedFolders };
  const flushCache = useCallback(() => {
    const snapshot = snapshotRef.current;
    writeWorkspaceTreeState(snapshot.theaterId, {
      query: snapshot.query,
      collapsedSections: [...snapshot.collapsedSections],
      collapsedFolders: [...snapshot.collapsedFolders],
      scrollTop: scrollTopRef.current,
    });
  }, []);
  const scheduleCacheWrite = useCallback(() => {
    if (cacheFrameRef.current !== null) return;
    cacheFrameRef.current = requestAnimationFrame(() => {
      cacheFrameRef.current = null;
      flushCache();
    });
  }, [flushCache]);
  const updateTreeScroll = useCallback(() => {
    const tree = scrollRef.current;
    if (!tree || tree.clientHeight <= 0 || tree.scrollHeight <= 0) return;
    if (restoredScrollTopRef.current !== null) {
      const restoredScrollTop = restoredScrollTopRef.current;
      if (restoredScrollTop > 0 && tree.scrollHeight <= tree.clientHeight) return;
      tree.scrollTop = restoredScrollTop;
      restoredScrollTopRef.current = null;
    }
    scrollTopRef.current = tree.scrollTop;
    scheduleCacheWrite();
  }, [scheduleCacheWrite]);
  useLayoutEffect(() => {
    updateTreeScroll();
    const tree = scrollRef.current;
    if (!tree) return;
    const observer = new ResizeObserver(updateTreeScroll);
    observer.observe(tree);
    return () => observer.disconnect();
  }, [contentVersion, updateTreeScroll]);
  useEffect(() => {
    scheduleCacheWrite();
  }, [collapsedFolders, collapsedSections, query, scheduleCacheWrite, theaterId]);
  useEffect(() => () => {
    if (cacheFrameRef.current !== null) {
      cancelAnimationFrame(cacheFrameRef.current);
      cacheFrameRef.current = null;
    }
    flushCache();
  }, [flushCache]);
  return <div ref={scrollRef} className="repository-ws-tree-scroll" onScroll={updateTreeScroll}>{children}</div>;
}

function WorkspaceTreeError({ t, label, onRetry }: { readonly t: T; readonly label: string; readonly onRetry: () => void }) {
  return <div className="repository-ws-tree-error"><span>{label}</span><button type="button" onClick={onRetry}>{t("repository.common.retry")}</button></div>;
}


function SourceIcon({ source }: { readonly source: SourceIconKind }) { const path = source === "repositories" ? "M3 5h12v9H3zM5 3h8v2" : source === "worktrees" ? "M5 3v12M5 6h7M5 12h7" : source === "changes" ? "M3 4h12M3 9h12M3 14h12" : source === "history" ? "M4 4v10h10M7 7h6v5" : source === "compare" ? "M5.5 3v9M3 9.5l2.5 2.5L8 9.5M12.5 15V6M10 8.5L12.5 6L15 8.5" : source === "branches" ? "M5 3v12M5 6h7M5 12h7" : source === "tags" ? "M3 4h8l4 4-7 7-5-5z" : "M4 5h10v9H4zM6 3h6"; return <svg viewBox="0 0 18 18" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function RepositoryDiscovery({ t, query, onQuery, totalCount, matchedCount, scanDepth, onScanDepth, truncated, onEnter }: { readonly t: T; readonly query: string; readonly onQuery: (query: string) => void; readonly totalCount: number; readonly matchedCount: number; readonly scanDepth: number; readonly onScanDepth: (depth: number) => void; readonly truncated: boolean; readonly onEnter: () => void }) {
  return <div className="repository-discovery">
    <input type="text" className="repository-filter-input" placeholder={t("repository.discovery.placeholder")} aria-label={t("repository.discovery.aria")} value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      onEnter();
    }} />
    {query ? <button type="button" className="repository-filter-clear" aria-label={t("repository.discovery.clearSearch")} onClick={() => onQuery("")}>✕</button> : null}
    <span className="repository-discovery-depth">{t("repository.discovery.depth")}
      <button type="button" className="repository-depth-step" aria-label={t("repository.discovery.scanShallower")} disabled={scanDepth <= SCAN_DEPTH_MIN} onClick={() => onScanDepth(scanDepth - 1)}>−</button>
      <output className="repository-depth-value">{scanDepth}</output>
      <button type="button" className="repository-depth-step" aria-label={t("repository.discovery.scanDeeper")} disabled={scanDepth >= SCAN_DEPTH_MAX} onClick={() => onScanDepth(scanDepth + 1)}>+</button>
    </span>
    <span className="repository-scan-count">{query ? t("repository.discovery.countMatched", { matched: matchedCount, total: totalCount }) : truncated ? t("repository.discovery.countFoundLimited", { count: totalCount }) : t("repository.discovery.countFound", { count: totalCount })}</span>
  </div>;
}
interface RepoTreeCommonProps {
  readonly selectedRel: string;
  readonly onRepository: (repo: RepoCandidate) => void;
  readonly collapsedFolders: ReadonlySet<string>;
  readonly onToggleFolder: (path: string) => void;
}

function RepoTreeChildren({ node, depth, parentPath, selectedRel, onRepository, collapsedFolders, onToggleFolder }: { readonly node: RepoTreeNode; readonly depth: number; readonly parentPath: string } & RepoTreeCommonProps) {
  return <>
    {Object.entries(node.dirs).map(([key, child]) => <RepoTreeFolder key={key} dirKey={key} node={child} depth={depth} parentPath={parentPath} collapsedFolders={collapsedFolders} onToggleFolder={onToggleFolder} selectedRel={selectedRel} onRepository={onRepository} />)}
    {node.repos.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={depth} selectedRel={selectedRel} onRepository={onRepository} />)}
  </>;
}

function RepoTreeFolder({ dirKey, node, depth, parentPath, selectedRel, onRepository, collapsedFolders, onToggleFolder }: { readonly dirKey: string; readonly node: RepoTreeNode; readonly depth: number; readonly parentPath: string } & RepoTreeCommonProps) {
  const { label, node: resolvedNode } = compressRepoFolder(dirKey, node);
  const path = parentPath ? `${parentPath}/${label}` : label;
  const collapsed = collapsedFolders.has(path);
  const indent = depth * 16 + 12;
  const total = countRepos(resolvedNode);
  return <div className={`repository-folder${collapsed ? " is-collapsed" : ""}`}>
    <button type="button" className="repository-folder-row" style={{ paddingLeft: `${indent}px`, gridTemplateColumns: "12px 15px 1fr auto" }} onClick={() => onToggleFolder(path)} aria-expanded={!collapsed}>
      <svg className="repository-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="repository-folder-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="repository-folder-name">{label}</span>
      <span className="repository-folder-count">{total}</span>
    </button>
    {!collapsed && <RepoTreeChildren node={resolvedNode} depth={depth + 1} parentPath={path} collapsedFolders={collapsedFolders} onToggleFolder={onToggleFolder} selectedRel={selectedRel} onRepository={onRepository} />}
  </div>;
}

function RepoLeafRow({ repo, depth, selectedRel, onRepository, nameMatch }: { readonly repo: RepoCandidate; readonly depth: number; readonly nameMatch?: readonly number[] } & Pick<RepoTreeCommonProps, "selectedRel" | "onRepository">) {
  // 저장소 리프 아이콘을 폴더 아이콘 컬럼(padding-left 12 + chevron 12 + gap 6 = 30) 아래에 정렬한다.
  const indent = depth * 16 + 30;
  return <button type="button" title={repo.relPath} className={`repository-ref-row${repo.relPath === selectedRel ? " is-current" : ""}`} style={{ paddingLeft: `${indent}px` }} onClick={() => onRepository(repo)}>
    <SourceIcon source="repositories" />
    <span className="repository-ref-name">{nameMatch ? Array.from(repo.name).map((character, index) => nameMatch.includes(index) ? <b key={index} className="repository-ref-hl">{character}</b> : character) : repo.name}</span>{repo.relPath === selectedRel && <span className="repository-ref-mark">✓</span>}
    {repo.branch && <span className="repository-ref-sub">{repo.branch}</span>}
  </button>;
}
function RepositoryIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" /><rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" /></svg>;
}

export const repositoryPanel: RailPanelDescriptor = {
  id: "repository",
  title: (locale) => getT(locale)("repository.panel.title"),
  defaultWidth: 420,
  icon: () => <RepositoryIcon />,
  render: (ctx: RailPanelContext) => <RepositoryPanel ctx={ctx} />,
  search: async ({ query, theaterId, limit, signal }) => {
    const repoRel = readStoredRepositoryRel(theaterId);
    const response = await fetch("/plugins/repository/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, repoRel, query, limit }),
      signal,
    });
    if (!response.ok) throw new Error("repository_search_failed");
    const result = await response.json() as RepositorySearchResult;
    return result.commits.map((commit) => ({
      id: `${result.repoRel}:${commit.fullHash}`,
      title: commit.subject,
      subtitle: commit.shortHash,
      activate: () => activateRepositorySearchTarget(theaterId, result.repoRel, commit.fullHash),
    }));
  },
};
