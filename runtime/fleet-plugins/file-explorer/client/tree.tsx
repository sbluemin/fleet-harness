import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { GitFileStatus, GitStatusResult } from "../server/tree-services.js";
import type { FolderEntry, FolderListResult } from "../server/types.js";
import { restoreContextMenuFocus } from "./context-menu.js";
import type { FileExplorerMessageKey } from "./i18n/index.js";
import { translateServerError } from "./i18n/index.js";
import type { FileSearchTarget } from "./search-navigation.js";

import { FileIcon, FolderIcon } from "./file-icon.js";
export interface PluginFilesClient {
  readonly listFolder: (relativePath?: string) => Promise<FolderListResult>;
}

interface FileTreeProps {
  readonly contextKey: string;
  readonly files: PluginFilesClient;
  readonly theaterId: string | null;
  readonly selectedPath: string | null;
  readonly revealTarget?: FileSearchTarget | null;
  readonly onSelect: (entry: FolderEntry) => void;
  readonly onContextMenu: (entry: FolderEntry, x: number, y: number) => void;
  readonly t: Translate<FileExplorerMessageKey>;
}

export interface FileTreeHandle {
  readonly restoreContextMenuFocus: (relativePath: string) => HTMLElement | null;
}

export interface FlatRow {
  readonly entry: FolderEntry;
  readonly depth: number;
  readonly isSelected: boolean;
  readonly isExpanded: boolean;
  readonly isLoading: boolean;
}

/** 목록 상한에 잘린 폴터 끝에 붙는 표식 행 — 포커스/선택 대상이 아니다. */
export interface CapRow {
  readonly type: "cap";
  readonly depth: number;
  readonly cap: number;
  readonly key: string;
}

/** VCS 날것(.git 등)이 숨겨졌음을 이름으로 밝히는 muted 행 — 펼침/포커스 불가. */
export interface VcsRow {
  readonly type: "vcs";
  readonly name: string;
  readonly depth: number;
  readonly key: string;
}

/** 작업 트리에서 삭제된 파일의 합성 행 — 실제 목록에 없으므로 정보 표시 전용, 포커스 불가. */
export interface GhostRow {
  readonly type: "ghost";
  readonly name: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly key: string;
}

export type EntryRow = FlatRow & { readonly type: "entry" };
export type TreeRow = EntryRow | CapRow | VcsRow | GhostRow;

export function isEntryRow(row: TreeRow): row is EntryRow {
  return row.type === "entry";
}

function firstEntryPath(rows: readonly TreeRow[]): string | null {
  return rows.find(isEntryRow)?.entry.relativePath ?? null;
}

function hasEntryPath(rows: readonly TreeRow[], path: string | null): boolean {
  return path !== null && rows.some((row) => isEntryRow(row) && row.entry.relativePath === path);
}

export type TreeNavigationAction =
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "expand" }
  | { readonly kind: "collapse" }
  | { readonly kind: "activate" }
  | { readonly kind: "none" };

interface FilterDescendantLoadOptions {
  readonly entries: readonly FolderEntry[];
  readonly cachedResults: ReadonlyMap<string, FolderListResult>;
  readonly files: PluginFilesClient;
  readonly showHidden: boolean;
  readonly isCurrent: () => boolean;
  readonly onFolderResult: (relativePath: string, result: FolderListResult) => void;
  readonly onProgress?: (walked: number) => void;
}

export interface FilterLoadStats {
  /** 실제로 내용을 확인한 폴터 수 (캐시 적중 포함) */
  readonly walked: number;
  /** 폴터 상한에 걸려 일부 폴터를 탐색하지 못한 경우 true — UI가 표식을 띄운다. */
  readonly capped: boolean;
}

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 30;
const OVERSCAN = 5;
const PREFS_SHOW_HIDDEN = "fleet-console.fileExplorer.showHidden";
const PREFS_SORT_MODE = "fleet-console.fileExplorer.sortMode";
const PREFS_EXPANDED_PREFIX = "fleet-console.fileExplorer.expanded.";
const EXPANDED_PERSIST_CAP = 200;
const EXPANDED_RESTORE_FETCH_CAP = 50;
const GIT_STATUS_DEBOUNCE_MS = 500;
export const FILTER_DIRECTORY_CAP = 500;

// ═══ 정렬 ═══════════════════════════════════════════════════════════════════

export type SortMode = "name" | "modified" | "size";

export const SORT_MODE_CYCLE: readonly SortMode[] = ["name", "modified", "size"];

export function nextSortMode(mode: SortMode): SortMode {
  const index = SORT_MODE_CYCLE.indexOf(mode);
  return SORT_MODE_CYCLE[(index + 1) % SORT_MODE_CYCLE.length] ?? "name";
}

/**
 * 한 수준의 엔트리를 정렬한다. 디렉터리는 항상 파일보다 앞이다.
 * name — 서버 순서(이미 dirs-first 이름순)를 그대로 쓴다.
 * modified — 최신 우선. 메타 없는 항목은 이름순 꼬리로 보낸다.
 * size — 파일은 큰 것 우선, 디렉터리는 이름순(크기 신호가 없다).
 */
export function sortEntries(entries: readonly FolderEntry[], mode: SortMode): readonly FolderEntry[] {
  if (mode === "name") return entries;
  const byName = (a: FolderEntry, b: FolderEntry) => a.name.localeCompare(b.name);
  const byMeta = (metaOf: (entry: FolderEntry) => number | undefined) =>
    (a: FolderEntry, b: FolderEntry): number => {
      const am = metaOf(a);
      const bm = metaOf(b);
      if (am === undefined && bm === undefined) return byName(a, b);
      if (am === undefined) return 1;
      if (bm === undefined) return -1;
      return bm - am || byName(a, b);
    };
  const dirs = entries.filter((entry) => entry.kind === "dir");
  const files = entries.filter((entry) => entry.kind !== "dir");
  if (mode === "modified") {
    const compare = byMeta((entry) => entry.mtimeMs);
    return [...dirs.slice().sort(compare), ...files.slice().sort(compare)];
  }
  return [...dirs, ...files.slice().sort(byMeta((entry) => entry.sizeBytes))];
}

export interface GitStatusBadge {
  readonly text: "M" | "U" | "D";
  readonly status: GitFileStatus;
  readonly messageKey:
    | "fileExplorer.git.modified"
    | "fileExplorer.git.untracked"
    | "fileExplorer.git.deleted";
}

export function mapGitStatusBadge(status: GitFileStatus | undefined): GitStatusBadge | null {
  if (status === "modified") {
    return { text: "M", status, messageKey: "fileExplorer.git.modified" };
  }
  if (status === "untracked") {
    return { text: "U", status, messageKey: "fileExplorer.git.untracked" };
  }
  if (status === "deleted") {
    return { text: "D", status, messageKey: "fileExplorer.git.deleted" };
  }
  return null;
}

export function triggerManualRefresh(
  refreshTree: () => void,
  refreshGitStatus: () => void | Promise<void>,
): void {
  refreshTree();
  void refreshGitStatus();
}

export function isCurrentContextRequest(requestContextKey: string, currentContextKey: string): boolean {
  return requestContextKey === currentContextKey;
}

export type FolderExpandFetch = "none" | "foreground" | "background";

export interface FolderExpandPlan {
  readonly nextExpanded: boolean;
  readonly fetch: FolderExpandFetch;
}

/** 접힘→펼침은 캐시가 있으면 즉시 그리고, 진행 중 요청은 합류한다. */
export function planFolderExpand(
  isCurrentlyExpanded: boolean,
  hasCachedResult: boolean,
  isInFlight: boolean,
): FolderExpandPlan {
  if (isCurrentlyExpanded) return { nextExpanded: false, fetch: "none" };
  if (isInFlight) return { nextExpanded: true, fetch: "none" };
  if (hasCachedResult) return { nextExpanded: true, fetch: "background" };
  return { nextExpanded: true, fetch: "foreground" };
}

// 탭 복귀 시 git 배지를 다시 읽을지 판정한다 — 외부 터미널의 add/commit 같은
// git 메타데이터 전용 변경은 fs.watch가 감지하지 못하므로 focus 복귀가 갱신 기회다.
export function shouldRefreshGitStatusOnVisibility(visibilityState: string): boolean {
  return visibilityState === "visible";
}

export async function loadFilterDescendants({ entries, cachedResults, files, showHidden, isCurrent, onFolderResult, onProgress }: FilterDescendantLoadOptions): Promise<FilterLoadStats> {
  const pending: FolderEntry[] = [];
  const knownResults = new Map(cachedResults);
  const queuedPaths = new Set<string>();
  const visitedFolders = new Set<string>();
  let requestCount = 0;
  let capped = false;
  const enqueue = (candidates: readonly FolderEntry[]) => {
    for (const candidate of candidates) {
      if (!isVisibleDirectory(candidate, showHidden) || queuedPaths.has(candidate.relativePath)) continue;
      if (queuedPaths.size >= FILTER_DIRECTORY_CAP) { capped = true; return; }
      queuedPaths.add(candidate.relativePath);
      pending.push(candidate);
    }
  };

  enqueue(entries);
  while (pending.length > 0 && isCurrent()) {
    const entry = pending.shift();
    if (!entry) break;
    const cached = knownResults.get(entry.relativePath);
    if (cached) {
      if (visitedFolders.has(cached.relativePath)) continue;
      visitedFolders.add(cached.relativePath);
      onProgress?.(visitedFolders.size);
      enqueue(cached.entries);
      continue;
    }
    if (requestCount >= FILTER_DIRECTORY_CAP) { capped = true; break; }
    requestCount += 1;
    try {
      const result = await files.listFolder(entry.relativePath);
      if (!isCurrent()) break;
      knownResults.set(entry.relativePath, result);
      onFolderResult(entry.relativePath, result);
      if (visitedFolders.has(result.relativePath)) continue;
      visitedFolders.add(result.relativePath);
      onProgress?.(visitedFolders.size);
      enqueue(result.entries);
    } catch {
      // 권한 오류나 사라진 폴더는 해당 하위 트리만 건너뛴다.
    }
  }
  return { walked: visitedFolders.size, capped };
}

interface LevelMeta {
  /** 이 수준의 목록이 상한에서 잘린 경우의 상한 값 */
  readonly truncatedCap?: number;
  /** 이 수준에서 숨겨진 VCS 날것 이름 (.git 등) */
  readonly hiddenVcs?: readonly string[];
}

export interface BuildRowsOptions {
  readonly sortMode?: SortMode;
  /** 부모 폴더 상대경로("" = 루트) → 그 폴더에서 삭제된 파일 이름들. 고스트 행으로 합성된다. */
  readonly deletedByDir?: ReadonlyMap<string, readonly string[]>;
}

export function buildFlatRows(
  entries: readonly FolderEntry[],
  depth: number,
  selectedPath: string | null,
  expandedDirs: Set<string>,
  loadingDirs: Set<string>,
  childResults: Map<string, FolderListResult>,
  low: string,
  showHidden: boolean,
  ancestorFolders: ReadonlySet<string> = new Set(),
  filterCollapsedDirs: ReadonlySet<string> = new Set(),
  levelMeta: LevelMeta = {},
  levelKey = "",
  options: BuildRowsOptions = {},
): TreeRow[] {
  const rows: TreeRow[] = [];
  const sortMode = options.sortMode ?? "name";
  // VCS 표식 행은 디렉터리 구간에 이름순으로 끼워 넣는다 — 숨김 파일 표시 중이고 필터링이 아닐 때만.
  // 이름순이 아닌 정렬에서는 끼워 넣을 기준이 없으므로 수준 끝에 몰아 붙인다.
  const vcsNames = !low && showHidden && levelMeta.hiddenVcs
    ? [...levelMeta.hiddenVcs].sort((a, b) => a.localeCompare(b))
    : [];
  let vcsIdx = 0;
  const flushVcs = (beforeName?: string) => {
    for (;;) {
      const name = vcsNames[vcsIdx];
      if (name === undefined) return;
      if (sortMode === "name" && beforeName !== undefined && name.localeCompare(beforeName) >= 0) return;
      vcsIdx += 1;
      rows.push({ type: "vcs", name, depth, key: `vcs:${levelKey}:${name}` });
    }
  };
  // 삭제 고스트 행 — 삭제 파일은 목록에 실제 행이 없으므로 여기서 합성한다.
  // 필터 중에는 실제 목록과 구분이 흐려지므로 내지 않는다.
  const ghostNames = !low && options.deletedByDir?.get(levelKey)
    ? [...(options.deletedByDir.get(levelKey) ?? [])]
      .filter((name) => showHidden || !name.startsWith("."))
      .sort((a, b) => a.localeCompare(b))
    : [];
  let ghostIdx = 0;
  const flushGhosts = (beforeName?: string) => {
    for (;;) {
      const name = ghostNames[ghostIdx];
      if (name === undefined) return;
      if (sortMode === "name" && beforeName !== undefined && name.localeCompare(beforeName) >= 0) return;
      ghostIdx += 1;
      const relativePath = levelKey ? `${levelKey}/${name}` : name;
      rows.push({ type: "ghost", name, relativePath, depth, key: `ghost:${relativePath}` });
    }
  };
  let filesStarted = false;
  for (const entry of sortEntries(entries, sortMode)) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    const childResult = childResults.get(entry.relativePath);
    const children = childResult?.entries;
    const folderIdentity = childResult?.relativePath ?? entry.relativePath;
    const isCycle = entry.kind === "dir" && ancestorFolders.has(folderIdentity);
    // 잘린 목록은 비표시 항목에 매치가 숨어 있을 수 있으므로 잠재 매치로 취급해 캡 행을 살린다.
    const childMatch = entry.kind === "dir" && !isCycle
      && (hasFilterMatch(children ?? [], childResults, low, showHidden) || Boolean(low && childResult?.truncated));
    if (low) {
      const directMatch = entry.name.toLowerCase().includes(low);
      if (!directMatch && !childMatch) continue;
    }
    if (entry.kind === "dir") {
      flushVcs(entry.name);
    } else {
      if (!filesStarted) {
        // VCS 행은 "디렉터리 같은" 항목 — 첫 파일 행이 나오기 전에 남은 것을 밀어낸다.
        filesStarted = true;
        flushVcs();
      }
      // 고스트(삭제 파일)는 파일 구간에 이름순으로 끼워 넣는다.
      flushGhosts(entry.name);
    }
    const isExpanded = !filterCollapsedDirs.has(entry.relativePath)
      && (expandedDirs.has(entry.relativePath) || Boolean(low && childMatch));
    rows.push({
      type: "entry",
      entry,
      depth,
      isSelected: selectedPath === entry.relativePath,
      isExpanded,
      isLoading: loadingDirs.has(entry.relativePath),
    });
    if (entry.kind === "dir" && isExpanded && !isCycle) {
      if (children) {
        const nextAncestorFolders = new Set(ancestorFolders);
        nextAncestorFolders.add(folderIdentity);
        rows.push(...buildFlatRows(
          children,
          depth + 1,
          selectedPath,
          expandedDirs,
          loadingDirs,
          childResults,
          low,
          showHidden,
          nextAncestorFolders,
          filterCollapsedDirs,
          {
            truncatedCap: childResult?.truncated ? childResult.cap : undefined,
            hiddenVcs: childResult?.hiddenVcsInternals,
          },
          folderIdentity,
          options,
        ));
      }
    }
  }
  flushVcs();
  flushGhosts();
  if (levelMeta.truncatedCap !== undefined) {
    rows.push({ type: "cap", depth, cap: levelMeta.truncatedCap, key: `cap:${levelKey}` });
  }
  return rows;
}

function nextEntryIndex(rows: readonly TreeRow[], from: number, direction: 1 | -1): number | null {
  for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
    if (rows[i]?.type === "entry") return i;
  }
  return null;
}

export function resolveTreeNavigation(rows: readonly TreeRow[], index: number, key: string): TreeNavigationAction {
  const row = rows[index];
  if (!row || row.type !== "entry") return { kind: "none" };
  if (key === "ArrowDown") return { kind: "focus", index: nextEntryIndex(rows, index, 1) ?? index };
  if (key === "ArrowUp") return { kind: "focus", index: nextEntryIndex(rows, index, -1) ?? index };
  if (key === "Home") return { kind: "focus", index: nextEntryIndex(rows, -1, 1) ?? index };
  if (key === "End") return { kind: "focus", index: nextEntryIndex(rows, rows.length, -1) ?? index };
  if (key === "ArrowRight") {
    if (row.entry.kind !== "dir") return { kind: "none" };
    if (!row.isExpanded) return { kind: "expand" };
    // 첫 자식 엔트리로 내린다 — 중간의 VCS/캡 표식 행은 건어너뛴다.
    for (let i = index + 1; i < rows.length; i += 1) {
      const candidate = rows[i];
      if (!candidate || candidate.depth <= row.depth) break;
      if (candidate.type === "entry" && candidate.depth === row.depth + 1) return { kind: "focus", index: i };
    }
    return { kind: "none" };
  }
  if (key === "ArrowLeft") {
    if (row.entry.kind === "dir" && row.isExpanded) return { kind: "collapse" };
    for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
      const candidate = rows[parentIndex];
      if (candidate && candidate.type === "entry" && candidate.depth === row.depth - 1) return { kind: "focus", index: parentIndex };
    }
    return { kind: "none" };
  }
  if (key === "Enter" || key === " ") return { kind: "activate" };
  return { kind: "none" };
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { contextKey, files, theaterId, selectedPath, revealTarget, onSelect, onContextMenu, t },
  ref,
) {
  const [result, setResult] = useState<FolderListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [childResults, setChildResults] = useState<Map<string, FolderListResult>>(new Map());
  const [filterText, setFilterText] = useState<string>("");
  const [filterCollapsedDirs, setFilterCollapsedDirs] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [showHidden, setShowHidden] = useState<boolean>(() => readShowHidden());
  const [sortMode, setSortMode] = useState<SortMode>(() => readSortMode());
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const [gitStatusResult, setGitStatusResult] = useState<GitStatusResult | null>(null);
  const [filterWalked, setFilterWalked] = useState<number | null>(null);
  const [filterCapped, setFilterCapped] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusPathRef = useRef<string | null>(null);
  const revealedRequestRef = useRef(0);
  const gitStatusRequestRef = useRef(0);

  // SSE 핸들러가 최신 상태를 참조하도록 ref로 유지
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const currentPathRef = useRef<string>(currentPath);
  currentPathRef.current = currentPath;
  const filesRef = useRef<PluginFilesClient>(files);
  filesRef.current = files;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const childResultsRef = useRef<Map<string, FolderListResult>>(childResults);
  childResultsRef.current = childResults;
  const inFlightFoldersRef = useRef(new Map<string, Promise<void>>());
  const filterRequestRef = useRef(0);
  const isFiltering = Boolean(filterText);

  const refreshGitStatus = useCallback(async () => {
    if (!theaterId) return;
    const requestId = ++gitStatusRequestRef.current;
    const requestContextKey = contextKey;
    try {
      const response = await fetch("/plugins/file-explorer/files/git-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId }),
      });
      if (!response.ok) return;
      const nextResult = await response.json() as GitStatusResult;
      if (
        requestId !== gitStatusRequestRef.current
        || !isCurrentContextRequest(requestContextKey, contextKeyRef.current)
      ) return;
      setGitStatusResult(nextResult);
    } catch {
      // Git 상태는 보조 신호다. 조회 실패는 파일 탐색을 방해하거나 오류 UI를 만들지 않는다.
    }
  }, [contextKey, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    setResult(null);
    setError(null);
    setCurrentPath("");
    setExpandedDirs(new Set());
    setChildResults(new Map());
    inFlightFoldersRef.current.clear();
    setFilterText("");
    setFilterCollapsedDirs(new Set());
    setScrollTop(0);
    setCursorPath(null);
    setGitStatusResult(null);
    setFilterWalked(null);
    setFilterCapped(false);
  }, [contextKey, theaterId]);

  // 저장된 펼침 상태 복원 — 위 리셋 효과 다음에 선언되어 리셋 후에 실행된다.
  useEffect(() => {
    if (!theaterId) return;
    const stored = readExpandedDirs(contextKey);
    if (stored.length === 0) return;
    const requestContextKey = contextKey;
    setExpandedDirs((current) => {
      const next = new Set([...current, ...stored]);
      expandedDirsRef.current = next;
      return next;
    });
    // 내용은 다시 불러온다(상한까지) — 실패한 폴더는 접힌 채 남는다.
    for (const relPath of stored.slice(0, EXPANDED_RESTORE_FETCH_CAP)) {
      filesRef.current.listFolder(relPath).then((r) => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setChildResults((prev) => new Map(prev).set(relPath, r));
      }).catch(() => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setExpandedDirs((prev) => {
          if (!prev.has(relPath)) return prev;
          const next = new Set(prev);
          next.delete(relPath);
          expandedDirsRef.current = next;
          return next;
        });
      });
    }
  }, [contextKey, theaterId]);

  // 펼침 상태 지속 — Theater별로 저장해 리로드 후 복원한다.
  useEffect(() => {
    if (!theaterId) return;
    saveExpandedDirs(contextKey, expandedDirs);
  }, [contextKey, expandedDirs, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    void refreshGitStatus();
    return () => { gitStatusRequestRef.current += 1; };
  }, [refreshGitStatus, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    // 탭 전환(visibilitychange)과 앱 복귀(window focus) 모두 갱신 기회다.
    // 나란히 둔 외부 터미널의 git add/commit은 fs.watch가 못 잡으므로.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshGitStatus();
      }, 200);
    };
    const handleVisibilityChange = () => {
      if (shouldRefreshGitStatusOnVisibility(document.visibilityState)) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", scheduleRefresh);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", scheduleRefresh);
    };
  }, [refreshGitStatus, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    const requestContextKey = contextKey;
    files.listFolder(currentPath || undefined).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setResult(r);
      setError(null);
    }).catch((e: unknown) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      const raw = e instanceof Error ? e.message : "Unable to load folder";
      setError(translateServerError(raw, t));
    });
  }, [contextKey, theaterId, currentPath, files, t]);

  useEffect(() => {
    if (!revealTarget || revealTarget.theaterId !== theaterId || revealTarget.requestId <= revealedRequestRef.current) return;
    let active = true;
    const requestContextKey = contextKey;
    const loadRevealPath = async () => {
      const rootResult = await files.listFolder();
      const nextResults = new Map<string, FolderListResult>();
      const nextExpanded = new Set<string>();
      const parts = revealTarget.relativePath.split("/").filter(Boolean);
      let parentPath = "";
      for (const part of parts.slice(0, -1)) {
        parentPath = parentPath ? `${parentPath}/${part}` : part;
        const folderResult = await files.listFolder(parentPath);
        nextResults.set(parentPath, folderResult);
        nextExpanded.add(parentPath);
      }
      if (!active || !isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setFilterText("");
      setFilterCollapsedDirs(new Set());
      if (parts.some((part) => part.startsWith("."))) {
        setShowHidden(true);
        saveShowHidden(true);
      }
      setCurrentPath("");
      setResult(rootResult);
      setChildResults((current) => {
        const next = new Map(current);
        for (const [relativePath, folderResult] of nextResults) next.set(relativePath, folderResult);
        return next;
      });
      setExpandedDirs((current) => new Set([...current, ...nextExpanded]));
      setCursorPath(revealTarget.relativePath);
    };
    void loadRevealPath().catch(() => undefined);
    return () => { active = false; };
  }, [contextKey, files, revealTarget, theaterId]);

  useEffect(() => {
    const requestId = ++filterRequestRef.current;
    if (!isFiltering || !result) return;
    let active = true;
    const requestContextKey = contextKey;
    const isCurrent = () => active
      && requestId === filterRequestRef.current
      && isCurrentContextRequest(requestContextKey, contextKeyRef.current);
    setFilterWalked(0);
    setFilterCapped(false);
    void loadFilterDescendants({
      entries: result.entries,
      cachedResults: childResultsRef.current,
      files,
      showHidden,
      isCurrent,
      onFolderResult: (relativePath, folderResult) => {
        if (!isCurrent()) return;
        setChildResults((prev) => new Map(prev).set(relativePath, folderResult));
      },
      onProgress: (walked) => {
        if (!isCurrent()) return;
        setFilterWalked(walked);
      },
    }).then((stats) => {
      if (!isCurrent()) return;
      setFilterWalked(null);
      setFilterCapped(stats.capped);
    });
    return () => { active = false; };
  }, [contextKey, files, isFiltering, result, showHidden]);

  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight));
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // SSE 자동 새로고침 — theaterId/files 변경 시 재구독, 언마운트 시 close
  useEffect(() => {
    if (!theaterId) return;

    let isFirstOpen = true;
    let gitStatusTimer: ReturnType<typeof setTimeout> | null = null;
    const url = `/plugins/file-explorer/files/watch?theaterId=${encodeURIComponent(theaterId)}`;
    const es = new EventSource(url);

    // 루트 재조회 성공 시 stale error를 함께 걷어 에러 화면에서 회복한다
    const reloadRoot = () => {
      const requestContextKey = contextKey;
      filesRef.current.listFolder(currentPathRef.current || undefined).then((r) => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setResult(r);
        setError(null);
      }).catch(() => {});
    };

    const doFullRefresh = () => {
      reloadRoot();
      // 재연결 풀 리프레시는 놓친 change 이벤트의 조정 경로이므로 git 배지도 함께 갱신한다
      void refreshGitStatus();
      for (const relPath of expandedDirsRef.current) {
        const requestContextKey = contextKey;
        filesRef.current.listFolder(relPath).then((r) => {
          if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
          setChildResults((prev) => new Map(prev).set(relPath, r));
        }).catch(() => {});
      }
    };

    es.addEventListener("change", (e) => {
      // 서버가 JSON 프레이밍한 상대경로 — 개행 포함 파일명도 안전하게 전달된다
      let relDir: string;
      try {
        relDir = JSON.parse((e as MessageEvent).data as string) as string;
      } catch {
        return;
      }
      if (typeof relDir !== "string") return;
      if (gitStatusTimer !== null) clearTimeout(gitStatusTimer);
      gitStatusTimer = setTimeout(() => {
        gitStatusTimer = null;
        void refreshGitStatus();
      }, GIT_STATUS_DEBOUNCE_MS);
      // 루트 레벨 변경 또는 현재 탐색 경로 변경
      if (relDir === "" || relDir === currentPathRef.current) {
        reloadRoot();
      }
      // 펼쳐진 폴더에 해당하면 해당 폴더만 재조회
      if (relDir !== "" && expandedDirsRef.current.has(relDir)) {
        const requestContextKey = contextKey;
        filesRef.current.listFolder(relDir).then((r) => {
          if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
          setChildResults((prev) => new Map(prev).set(relDir, r));
        }).catch(() => {});
      }
    });

    es.onopen = () => {
      if (isFirstOpen) {
        isFirstOpen = false;
        return;
      }
      // 재연결: 놓친 변경 보정을 위해 전체 재조회
      doFullRefresh();
    };

    return () => {
      if (gitStatusTimer !== null) clearTimeout(gitStatusTimer);
      es.close();
    };
  }, [contextKey, theaterId, files, refreshGitStatus]);

  const handleDirClick = useCallback((entry: FolderEntry) => {
    const relPath = entry.relativePath;
    const plan = planFolderExpand(
      expandedDirsRef.current.has(relPath),
      childResultsRef.current.has(relPath),
      inFlightFoldersRef.current.has(relPath),
    );
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (plan.nextExpanded) next.add(relPath);
      else next.delete(relPath);
      expandedDirsRef.current = next;
      return next;
    });
    if (plan.fetch === "none") return;
    const requestContextKey = contextKey;
    const showSpinner = plan.fetch === "foreground";
    if (showSpinner) setLoadingDirs((prev) => new Set(prev).add(relPath));
    const request = files.listFolder(relPath).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setChildResults((prev) => new Map(prev).set(relPath, r));
    }).catch(() => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      // 캐시가 없는 첫 펼침 실패는 빈 폴더로 남기지 않고 접는다.
      if (childResultsRef.current.has(relPath)) return;
      setExpandedDirs((prev) => {
        if (!prev.has(relPath)) return prev;
        const next = new Set(prev);
        next.delete(relPath);
        expandedDirsRef.current = next;
        return next;
      });
    }).finally(() => {
      inFlightFoldersRef.current.delete(relPath);
      if (!showSpinner) return;
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
    });
    inFlightFoldersRef.current.set(relPath, request);
  }, [contextKey, files]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.currentTarget as HTMLDivElement).scrollTop);
  }, []);

  const handleToggleHidden = useCallback(() => {
    setShowHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PREFS_SHOW_HIDDEN, next ? "1" : "0");
      } catch {
        // localStorage 접근 실패 무시
      }
      return next;
    });
  }, []);

  const handleCycleSort = useCallback(() => {
    setSortMode((prev) => {
      const next = nextSortMode(prev);
      try {
        localStorage.setItem(PREFS_SORT_MODE, next);
      } catch {
        // localStorage 접근 실패 무시
      }
      return next;
    });
  }, []);

  const refreshTree = useCallback(() => {
    if (!theaterId) return;
    const requestContextKey = contextKey;
    // 루트 재조회 — 성공 시 stale error를 걷어 에러 화면에서도 복구 가능하게 한다
    files.listFolder(currentPath || undefined).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setResult(r);
      setError(null);
    }).catch((e: unknown) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      const raw = e instanceof Error ? e.message : "Unable to load folder";
      setError(translateServerError(raw, t));
    });
    // 펼쳐진 모든 폴더 재조회
    for (const relPath of expandedDirs) {
      files.listFolder(relPath).then((r) => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setChildResults((prev) => new Map(prev).set(relPath, r));
      }).catch(() => {});
    }
  }, [contextKey, files, currentPath, expandedDirs, theaterId, t]);

  const handleRefresh = useCallback(() => {
    triggerManualRefresh(refreshTree, refreshGitStatus);
  }, [refreshGitStatus, refreshTree]);

  const low = filterText.toLowerCase();

  const gitAvailable = gitStatusResult?.gitAvailable === true;
  const gitStatusByPath = useMemo(
    () => new Map(gitStatusResult?.statuses.map((entry) => [entry.path, entry.status]) ?? []),
    [gitStatusResult],
  );

  // 삭제 파일의 고스트 행 데이터 — 실제 목록에 아직 남아 있는 경로(스테이지 삭제 등)는 제외한다.
  const deletedByDir = useMemo(() => {
    if (!gitAvailable) return new Map<string, readonly string[]>();
    const listedPaths = new Set<string>();
    for (const entry of result?.entries ?? []) listedPaths.add(entry.relativePath);
    for (const child of childResults.values()) {
      for (const entry of child.entries) listedPaths.add(entry.relativePath);
    }
    const grouped = new Map<string, string[]>();
    for (const [statusPath, status] of gitStatusByPath) {
      if (status !== "deleted" || listedPaths.has(statusPath)) continue;
      const slash = statusPath.lastIndexOf("/");
      const dir = slash < 0 ? "" : statusPath.slice(0, slash);
      const name = slash < 0 ? statusPath : statusPath.slice(slash + 1);
      const bucket = grouped.get(dir);
      if (bucket) bucket.push(name);
      else grouped.set(dir, [name]);
    }
    return grouped as ReadonlyMap<string, readonly string[]>;
  }, [childResults, gitAvailable, gitStatusByPath, result]);

  const flatRows = useMemo(() => {
    if (!result) return [];
    return buildFlatRows(
      result.entries,
      0,
      selectedPath,
      expandedDirs,
      loadingDirs,
      childResults,
      low,
      showHidden,
      new Set(),
      filterCollapsedDirs,
      { truncatedCap: result.truncated ? result.cap : undefined, hiddenVcs: result.hiddenVcsInternals },
      "",
      { sortMode, deletedByDir },
    );
  }, [result, selectedPath, expandedDirs, loadingDirs, childResults, low, showHidden, filterCollapsedDirs, sortMode, deletedByDir]);

  const hasOnlyHiddenEntries = !showHidden && result !== null && result.entries.length > 0 && flatRows.length === 0 && !filterText;

  const shouldVirtualize = flatRows.length > VIRTUALIZE_THRESHOLD;
  const startIdx = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const endIdx = shouldVirtualize ? Math.min(flatRows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN) : flatRows.length;
  const visibleRows = flatRows.slice(startIdx, endIdx);
  const totalHeight = flatRows.length * ROW_HEIGHT;
  const offsetY = startIdx * ROW_HEIGHT;
  const selectedVisiblePath = selectedPath && hasEntryPath(flatRows, selectedPath)
    ? selectedPath
    : null;
  const resolvedCursorPath = hasEntryPath(flatRows, cursorPath)
    ? cursorPath
    : selectedVisiblePath ?? firstEntryPath(flatRows);
  const renderedCursorPath = hasEntryPath(visibleRows, resolvedCursorPath)
    ? resolvedCursorPath
    : firstEntryPath(visibleRows);

  const filterMatchCount = useMemo(() => {
    if (!low) return 0;
    let count = 0;
    for (const row of flatRows) {
      if (isEntryRow(row) && row.entry.kind === "file" && row.entry.name.toLowerCase().includes(low)) count += 1;
    }
    return count;
  }, [flatRows, low]);

  useEffect(() => {
    if (renderedCursorPath !== cursorPath) setCursorPath(renderedCursorPath);
  }, [cursorPath, renderedCursorPath]);

  useLayoutEffect(() => {
    const path = pendingFocusPathRef.current;
    if (path === null || path !== renderedCursorPath) return;
    pendingFocusPathRef.current = null;
    rowRefs.current.get(path)?.focus();
  }, [renderedCursorPath, visibleRows]);

  useLayoutEffect(() => {
    if (!revealTarget || revealTarget.requestId <= revealedRequestRef.current) return;
    const rowIndex = flatRows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === revealTarget.relativePath);
    if (rowIndex < 0) return;
    setCursorPath(revealTarget.relativePath);
    if (shouldVirtualize && (rowIndex < startIdx || rowIndex >= endIdx)) {
      const nextScrollTop = Math.max(0, rowIndex * ROW_HEIGHT);
      if (treeRef.current) treeRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      return;
    }
    const row = rowRefs.current.get(revealTarget.relativePath);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    revealedRequestRef.current = revealTarget.requestId;
  }, [endIdx, flatRows, revealTarget, shouldVirtualize, startIdx, visibleRows]);

  useImperativeHandle(ref, () => ({
    restoreContextMenuFocus: (relativePath) => restoreContextMenuFocus(
      relativePath,
      rowRefs.current,
      renderedCursorPath,
      treeRef.current,
    ),
  }), [renderedCursorPath]);

  const focusRow = (rowIndex: number) => {
    const row = flatRows[rowIndex];
    if (!row || row.type !== "entry") return;
    const path = row.entry.relativePath;
    if (path === renderedCursorPath) {
      // 경계(첫/마지막 행)에서는 커서가 그대로라 리렌더가 없다. 요청을 남겨두면 나중의 SSE 리렌더가
      // 그걸 소비해 사용자가 떠난 뒤 포커스를 훔치므로, 여기서 바로 처리하고 큐를 비운다.
      pendingFocusPathRef.current = null;
      rowRefs.current.get(path)?.focus();
      return;
    }
    pendingFocusPathRef.current = path;
    setCursorPath(path);
    if (shouldVirtualize && (rowIndex < startIdx || rowIndex >= endIdx)) {
      const nextScrollTop = Math.max(0, rowIndex * ROW_HEIGHT);
      if (treeRef.current) treeRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  };

  const handleTreeItemKeyDown = (row: EntryRow, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = flatRows.findIndex((candidate) => isEntryRow(candidate) && candidate.entry.relativePath === row.entry.relativePath);
    if (index < 0) return;
    const action = resolveTreeNavigation(flatRows, index, event.key);
    if (action.kind === "none") {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") event.preventDefault();
      return;
    }
    event.preventDefault();
    if (action.kind === "focus") {
      focusRow(action.index);
      return;
    }
    if (action.kind === "expand") {
      if (low) {
        setFilterCollapsedDirs((current) => {
          const next = new Set(current);
          next.delete(row.entry.relativePath);
          return next;
        });
      } else {
        handleDirClick(row.entry);
      }
      return;
    }
    if (action.kind === "collapse") {
      if (row.entry.kind === "dir") {
        if (low) {
          setFilterCollapsedDirs((current) => new Set(current).add(row.entry.relativePath));
        } else {
          setExpandedDirs((current) => {
            const next = new Set(current);
            next.delete(row.entry.relativePath);
            return next;
          });
        }
      }
      return;
    }
    activateRow(row);
  };

  const activateRow = (row: EntryRow) => {
    if (row.entry.kind !== "dir") {
      onSelect(row.entry);
      return;
    }
    if (!low) {
      handleDirClick(row.entry);
      return;
    }
    setFilterCollapsedDirs((current) => {
      const next = new Set(current);
      if (row.isExpanded) next.add(row.entry.relativePath);
      else next.delete(row.entry.relativePath);
      return next;
    });
  };

  const handleRowClick = (row: EntryRow) => {
    setCursorPath(row.entry.relativePath);
    activateRow(row);
  };

  const handleRowContextMenu = (row: EntryRow, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setCursorPath(row.entry.relativePath);
    onContextMenu(row.entry, event.clientX, event.clientY);
  };

  if (!theaterId) return <div className="fexp-tree-empty">{t("fileExplorer.status.selectTheater")}</div>;
  // 전체 에러 화면은 보여줄 트리가 아예 없을 때(초기 로드 실패)만 —
  // 이전 result가 있으면 트리를 유지해 ↻ 재시도 경로를 보존한다
  if (error && !result) return <div className="fexp-tree-error">{error}</div>;
  if (!result) return <div className="fexp-tree-loading">{t("fileExplorer.status.loading")}</div>;

  const renderTreeRow = (row: TreeRow) => {
    if (row.type === "cap") {
      return (
        <div
          key={row.key}
          className="fexp-tree-cap"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
          role="note"
        >
          {t("fileExplorer.tree.listingCapped", { cap: row.cap })}
        </div>
      );
    }
    if (row.type === "vcs") {
      return (
        <div
          key={row.key}
          className="fexp-tree-vcs"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
        >
          {t("fileExplorer.tree.vcsHidden", { name: row.name })}
        </div>
      );
    }
    if (row.type === "ghost") {
      return (
        <div
          key={row.key}
          className="fexp-tree-ghost"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
          role="note"
          aria-label={t("fileExplorer.git.deletedGhost", { name: row.name })}
          title={t("fileExplorer.git.deletedGhost", { name: row.name })}
        >
          <span className="fexp-tree-icon" aria-hidden="true"><FileIcon name={row.name} /></span>
          <span className="fexp-tree-name">{row.name}</span>
          <span className="fexp-git-badge is-deleted" aria-hidden="true">D</span>
        </div>
      );
    }
    return (
      <FlatTreeRow
        key={row.entry.relativePath}
        row={row}
        cursor={row.entry.relativePath === renderedCursorPath}
        rowRefs={rowRefs}
        gitAvailable={gitAvailable}
        gitStatus={gitStatusByPath.get(row.entry.relativePath)}
        onEntryClick={handleRowClick}
        onContextMenu={handleRowContextMenu}
        onKeyDown={handleTreeItemKeyDown}
        t={t}
      />
    );
  };

  return (
    <div className="fexp-tree-container">
      <div className="fexp-head">
      <div className="fexp-filter">
        <input
          type="text"
          className="fexp-filter-input"
          placeholder={t("fileExplorer.filter.placeholder")}
          value={filterText}
          onChange={(e) => {
            setFilterText(e.target.value);
            setFilterCollapsedDirs(new Set());
          }}
          aria-label={t("fileExplorer.filter.aria")}
        />
        {filterText && (
          <button
            type="button"
            className="fexp-filter-clear"
            onClick={() => {
              setFilterText("");
              setFilterCollapsedDirs(new Set());
            }}
            aria-label={t("fileExplorer.filter.clear")}
          >
            ✕
          </button>
        )}
        <button
          type="button"
          className="fexp-sort-btn"
          onClick={handleCycleSort}
          aria-label={t("fileExplorer.sort.cycle", { mode: t(SORT_MODE_LABEL_KEYS[sortMode]) })}
          title={t("fileExplorer.sort.cycle", { mode: t(SORT_MODE_LABEL_KEYS[sortMode]) })}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4.5 3v9M4.5 12l-2-2M4.5 12l2-2M9 4.5h5M9 8h4M9 11.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="fexp-sort-label">{t(SORT_MODE_LABEL_KEYS[sortMode])}</span>
        </button>
        <button
          type="button"
          className="fexp-refresh-btn"
          onClick={handleRefresh}
          aria-label={t("fileExplorer.tree.refresh")}
          title={t("fileExplorer.tree.refresh")}
        >
          ↻
        </button>
        <button
          type="button"
          className={`fexp-hidden-toggle${showHidden ? " is-active" : ""}`}
          onClick={handleToggleHidden}
          aria-pressed={showHidden}
          aria-label={showHidden ? t("fileExplorer.tree.hideHidden") : t("fileExplorer.tree.showHidden")}
          title={showHidden ? t("fileExplorer.tree.hideHidden") : t("fileExplorer.tree.showHidden")}
        >
          {showHidden ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <ellipse cx="8" cy="8" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.4"/>
              <circle cx="8" cy="8" r="1.8" fill="currentColor"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <ellipse cx="8" cy="8" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.4"/>
              <circle cx="8" cy="8" r="1.8" fill="currentColor"/>
              <line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </div>
      {isFiltering && filterWalked !== null && (
        <div className="fexp-filter-scan" role="status">
          {t("fileExplorer.filter.scanning", { count: filterWalked })}
        </div>
      )}
      {isFiltering && filterWalked === null && filterCapped && (
        <div className="fexp-filter-cap" role="status">
          {t("fileExplorer.filter.capped", { matches: filterMatchCount, cap: FILTER_DIRECTORY_CAP })}
        </div>
      )}
      {gitStatusResult?.truncated && (
        <div className="fexp-git-note" role="status">
          {t("fileExplorer.git.truncated", { cap: gitStatusResult.cap ?? 0 })}
        </div>
      )}
      </div>
      <div
        ref={treeRef}
        className="fexp-tree"
        role="tree"
        tabIndex={-1}
        aria-label={t("fileExplorer.tree.aria")}
        onScroll={shouldVirtualize ? handleScroll : undefined}
      >
        {false && result?.parentRelativePath !== null && !filterText && (
          <button
            className="fexp-tree-up"
            type="button"
            onClick={() => setCurrentPath(result?.parentRelativePath ?? "")}
            aria-label={t("fileExplorer.tree.parentFolder")}
          >
            ↑ ..
          </button>
        )}
        {shouldVirtualize ? (
          <div style={{ height: totalHeight, position: "relative" }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleRows.map(renderTreeRow)}
            </div>
          </div>
        ) : (
          visibleRows.map(renderTreeRow)
        )}
        {flatRows.length === 0 && filterText && (
          <div className="fexp-tree-empty">{t("fileExplorer.status.noMatchingItems")}</div>
        )}
        {flatRows.length === 0 && !filterText && result.entries.length === 0 && (
          <div className="fexp-tree-empty">{t("fileExplorer.status.emptyFolder")}</div>
        )}
        {hasOnlyHiddenEntries && (
          <div className="fexp-tree-empty">{t("fileExplorer.status.onlyHiddenItems")}</div>
        )}
      </div>
    </div>
  );
});

function hasFilterMatch(
  entries: readonly FolderEntry[],
  childResults: Map<string, FolderListResult>,
  low: string,
  showHidden: boolean,
  visitedFolders: ReadonlySet<string> = new Set(),
): boolean {
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    if (e.name.toLowerCase().includes(low)) return true;
    if (e.kind === "dir") {
      const result = childResults.get(e.relativePath);
      if (result && !visitedFolders.has(result.relativePath)) {
        // 잘린 목록은 비표시 꼬리에 매치가 숨어 있을 수 있다 — 조상 사슬을 유지한다.
        if (result.truncated) return true;
        const nextVisitedFolders = new Set(visitedFolders);
        nextVisitedFolders.add(result.relativePath);
        if (hasFilterMatch(result.entries, childResults, low, showHidden, nextVisitedFolders)) return true;
      }
    }
  }
  return false;
}

function isVisibleDirectory(entry: FolderEntry, showHidden: boolean): boolean {
  return entry.kind === "dir" && (showHidden || !entry.name.startsWith("."));
}

interface FlatTreeRowProps {
  readonly row: EntryRow;
  readonly cursor: boolean;
  readonly rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  readonly gitAvailable: boolean;
  readonly gitStatus: GitFileStatus | undefined;
  readonly onEntryClick: (row: EntryRow) => void;
  readonly onContextMenu: (row: EntryRow, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (row: EntryRow, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly t: Translate<FileExplorerMessageKey>;
}

function FlatTreeRow({ row, cursor, rowRefs, gitAvailable, gitStatus, onEntryClick, onContextMenu, onKeyDown, t }: FlatTreeRowProps) {
  const { entry, depth, isSelected, isExpanded, isLoading } = row;
  const isDir = entry.kind === "dir";
  // 디렉터리형 행이라도 정확 경로에 상태가 있으면 배지를 단다 —
  // dirty 서브모듈/디렉터리형 심링크는 git이 그 경로 자체를 보고한다.
  // 일반 디렉터리는 상태 항목 자체가 없어 자연스럽게 묰배지.
  const gitBadge = gitAvailable ? mapGitStatusBadge(gitStatus) : null;
  const indent = depth * 16;
  const handleClick = useCallback(() => onEntryClick(row), [onEntryClick, row]);

  return (
    <button
      ref={(node) => {
        if (node) rowRefs.current.set(entry.relativePath, node);
        else rowRefs.current.delete(entry.relativePath);
      }}
      className={`fexp-tree-row${isSelected ? " is-cur" : ""}${isDir ? " is-dir" : " is-file"}`}
      style={{ paddingLeft: `${indent + 12}px` }}
      type="button"
      role="treeitem"
      tabIndex={cursor ? 0 : -1}
      aria-haspopup="menu"
      aria-selected={isSelected}
      aria-expanded={isDir ? isExpanded : undefined}
      onClick={handleClick}
      onContextMenu={(event) => onContextMenu(row, event)}
      onKeyDown={(event) => onKeyDown(row, event)}
    >
      <span className="fexp-tree-icon" aria-hidden="true">
        {isDir ? <FolderIcon name={entry.name} open={isExpanded} /> : <FileIcon name={entry.name} />}
      </span>
      <span className="fexp-tree-name">{entry.name}</span>
      {isLoading && <span className="fexp-tree-spin" aria-hidden="true">⋯</span>}
      {gitBadge && (
        <span className={`fexp-git-badge is-${gitBadge.status}`} aria-label={t(gitBadge.messageKey)}>
          {gitBadge.text}
        </span>
      )}
    </button>
  );
}

const SORT_MODE_LABEL_KEYS = {
  name: "fileExplorer.sort.name",
  modified: "fileExplorer.sort.modified",
  size: "fileExplorer.sort.size",
} as const satisfies Record<SortMode, FileExplorerMessageKey>;

function readSortMode(): SortMode {
  try {
    const raw = localStorage.getItem(PREFS_SORT_MODE);
    return raw === "modified" || raw === "size" ? raw : "name";
  } catch {
    return "name";
  }
}

function readExpandedDirs(contextKey: string): readonly string[] {
  try {
    const raw = localStorage.getItem(PREFS_EXPANDED_PREFIX + contextKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, EXPANDED_PERSIST_CAP);
  } catch {
    return [];
  }
}

function saveExpandedDirs(contextKey: string, expandedDirs: ReadonlySet<string>): void {
  try {
    const key = PREFS_EXPANDED_PREFIX + contextKey;
    if (expandedDirs.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify([...expandedDirs].slice(0, EXPANDED_PERSIST_CAP)));
  } catch {
    // localStorage 접근 실패 무시
  }
}

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(PREFS_SHOW_HIDDEN) === "1";
  } catch {
    return false;
  }
}

function saveShowHidden(showHidden: boolean): void {
  try {
    localStorage.setItem(PREFS_SHOW_HIDDEN, showHidden ? "1" : "0");
  } catch {
    // localStorage 접근 실패 무시
  }
}
