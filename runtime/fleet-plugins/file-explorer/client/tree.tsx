import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FolderEntry, FolderListResult } from "../server/types.js";
import type { FileExplorerMessageKey } from "./i18n/index.js";
import { translateServerError } from "./i18n/server-errors.js";
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
  readonly t: Translate<FileExplorerMessageKey>;
}

export interface FlatRow {
  readonly entry: FolderEntry;
  readonly depth: number;
  readonly isSelected: boolean;
  readonly isExpanded: boolean;
  readonly isLoading: boolean;
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
}

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 30;
const OVERSCAN = 5;
const PREFS_SHOW_HIDDEN = "fleet-console.fileExplorer.showHidden";
export const FILTER_DIRECTORY_CAP = 500;

export function isCurrentContextRequest(requestContextKey: string, currentContextKey: string): boolean {
  return requestContextKey === currentContextKey;
}

export async function loadFilterDescendants({ entries, cachedResults, files, showHidden, isCurrent, onFolderResult }: FilterDescendantLoadOptions): Promise<void> {
  const pending: FolderEntry[] = [];
  const knownResults = new Map(cachedResults);
  const queuedPaths = new Set<string>();
  const visitedFolders = new Set<string>();
  let requestCount = 0;
  const enqueue = (candidates: readonly FolderEntry[]) => {
    for (const candidate of candidates) {
      if (!isVisibleDirectory(candidate, showHidden) || queuedPaths.has(candidate.relativePath)) continue;
      if (queuedPaths.size >= FILTER_DIRECTORY_CAP) return;
      queuedPaths.add(candidate.relativePath);
      pending.push(candidate);
    }
  };

  enqueue(entries);
  while (pending.length > 0 && isCurrent()) {
    const entry = pending.shift();
    if (!entry) return;
    const cached = knownResults.get(entry.relativePath);
    if (cached) {
      if (visitedFolders.has(cached.relativePath)) continue;
      visitedFolders.add(cached.relativePath);
      enqueue(cached.entries);
      continue;
    }
    if (requestCount >= FILTER_DIRECTORY_CAP) return;
    requestCount += 1;
    try {
      const result = await files.listFolder(entry.relativePath);
      if (!isCurrent()) return;
      knownResults.set(entry.relativePath, result);
      onFolderResult(entry.relativePath, result);
      if (visitedFolders.has(result.relativePath)) continue;
      visitedFolders.add(result.relativePath);
      enqueue(result.entries);
    } catch {
      // 권한 오류나 사라진 폴더는 해당 하위 트리만 건너뛴다.
    }
  }
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
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    const childResult = childResults.get(entry.relativePath);
    const children = childResult?.entries;
    const folderIdentity = childResult?.relativePath ?? entry.relativePath;
    const isCycle = entry.kind === "dir" && ancestorFolders.has(folderIdentity);
    const childMatch = entry.kind === "dir" && !isCycle && hasFilterMatch(children ?? [], childResults, low, showHidden);
    if (low) {
      const directMatch = entry.name.toLowerCase().includes(low);
      if (!directMatch && !childMatch) continue;
    }
    const isExpanded = !filterCollapsedDirs.has(entry.relativePath)
      && (expandedDirs.has(entry.relativePath) || Boolean(low && childMatch));
    rows.push({
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
        ));
      }
    }
  }
  return rows;
}

export function resolveTreeNavigation(rows: readonly FlatRow[], index: number, key: string): TreeNavigationAction {
  const row = rows[index];
  if (!row) return { kind: "none" };
  if (key === "ArrowDown") return { kind: "focus", index: Math.min(rows.length - 1, index + 1) };
  if (key === "ArrowUp") return { kind: "focus", index: Math.max(0, index - 1) };
  if (key === "Home") return { kind: "focus", index: 0 };
  if (key === "End") return { kind: "focus", index: rows.length - 1 };
  if (key === "ArrowRight") {
    if (row.entry.kind !== "dir") return { kind: "none" };
    if (!row.isExpanded) return { kind: "expand" };
    return rows[index + 1]?.depth === row.depth + 1
      ? { kind: "focus", index: index + 1 }
      : { kind: "none" };
  }
  if (key === "ArrowLeft") {
    if (row.entry.kind === "dir" && row.isExpanded) return { kind: "collapse" };
    for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
      if (rows[parentIndex]?.depth === row.depth - 1) return { kind: "focus", index: parentIndex };
    }
    return { kind: "none" };
  }
  if (key === "Enter" || key === " ") return { kind: "activate" };
  return { kind: "none" };
}

export function FileTree({ contextKey, files, theaterId, selectedPath, revealTarget, onSelect, t }: FileTreeProps) {
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
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusPathRef = useRef<string | null>(null);
  const revealedRequestRef = useRef(0);

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
  const filterRequestRef = useRef(0);
  const isFiltering = Boolean(filterText);

  useEffect(() => {
    if (!theaterId) return;
    setResult(null);
    setError(null);
    setCurrentPath("");
    setExpandedDirs(new Set());
    setChildResults(new Map());
    setFilterText("");
    setFilterCollapsedDirs(new Set());
    setScrollTop(0);
    setCursorPath(null);
  }, [contextKey, theaterId]);

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
      es.close();
    };
  }, [contextKey, theaterId, files]);

  const handleDirClick = useCallback((entry: FolderEntry) => {
    const relPath = entry.relativePath;
    // 현재 펼침 상태를 읽어 펼치는 동작인지 판단
    const isExpanding = !expandedDirs.has(relPath);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) { next.delete(relPath); return next; }
      next.add(relPath);
      return next;
    });
    // 폴더를 펼 때마다 항상 서버에서 재조회 (영구 캐시 제거)
    if (isExpanding) {
      const requestContextKey = contextKey;
      setLoadingDirs((prev) => new Set(prev).add(relPath));
      files.listFolder(relPath).then((r) => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setChildResults((prev) => new Map(prev).set(relPath, r));
        setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
      }).catch(() => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
      });
    }
  }, [contextKey, files, expandedDirs]);

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

  const handleRefresh = useCallback(() => {
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

  const low = filterText.toLowerCase();

  const flatRows = useMemo(() => {
    if (!result) return [];
    return buildFlatRows(result.entries, 0, selectedPath, expandedDirs, loadingDirs, childResults, low, showHidden, new Set(), filterCollapsedDirs);
  }, [result, selectedPath, expandedDirs, loadingDirs, childResults, low, showHidden, filterCollapsedDirs]);

  const hasOnlyHiddenEntries = !showHidden && result !== null && result.entries.length > 0 && flatRows.length === 0 && !filterText;

  const shouldVirtualize = flatRows.length > VIRTUALIZE_THRESHOLD;
  const startIdx = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const endIdx = shouldVirtualize ? Math.min(flatRows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN) : flatRows.length;
  const visibleRows = flatRows.slice(startIdx, endIdx);
  const totalHeight = flatRows.length * ROW_HEIGHT;
  const offsetY = startIdx * ROW_HEIGHT;
  const selectedVisiblePath = selectedPath && flatRows.some((row) => row.entry.relativePath === selectedPath)
    ? selectedPath
    : null;
  const resolvedCursorPath = cursorPath && flatRows.some((row) => row.entry.relativePath === cursorPath)
    ? cursorPath
    : selectedVisiblePath ?? flatRows[0]?.entry.relativePath ?? null;
  const renderedCursorPath = visibleRows.some((row) => row.entry.relativePath === resolvedCursorPath)
    ? resolvedCursorPath
    : visibleRows[0]?.entry.relativePath ?? null;

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
    const rowIndex = flatRows.findIndex((row) => row.entry.relativePath === revealTarget.relativePath);
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

  const focusRow = (rowIndex: number) => {
    const row = flatRows[rowIndex];
    if (!row) return;
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

  const handleTreeItemKeyDown = (row: FlatRow, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = flatRows.findIndex((candidate) => candidate.entry.relativePath === row.entry.relativePath);
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

  const activateRow = (row: FlatRow) => {
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

  const handleRowClick = (row: FlatRow) => {
    setCursorPath(row.entry.relativePath);
    activateRow(row);
  };

  if (!theaterId) return <div className="fexp-tree-empty">{t("fileExplorer.status.selectTheater")}</div>;
  // 전체 에러 화면은 보여줄 트리가 아예 없을 때(초기 로드 실패)만 —
  // 이전 result가 있으면 트리를 유지해 ↻ 재시도 경로를 보존한다
  if (error && !result) return <div className="fexp-tree-error">{error}</div>;
  if (!result) return <div className="fexp-tree-loading">{t("fileExplorer.status.loading")}</div>;

  return (
    <div className="fexp-tree-container">
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
      <div
        ref={treeRef}
        className="fexp-tree"
        role="tree"
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
              {visibleRows.map((row) => (
                <FlatTreeRow
                  key={row.entry.relativePath}
                  row={row}
                  cursor={row.entry.relativePath === renderedCursorPath}
                  rowRefs={rowRefs}
                  onEntryClick={handleRowClick}
                  onKeyDown={handleTreeItemKeyDown}
                />
              ))}
            </div>
          </div>
        ) : (
          visibleRows.map((row) => (
            <FlatTreeRow
              key={row.entry.relativePath}
              row={row}
              cursor={row.entry.relativePath === renderedCursorPath}
              rowRefs={rowRefs}
              onEntryClick={handleRowClick}
              onKeyDown={handleTreeItemKeyDown}
            />
          ))
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
}

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
  readonly row: FlatRow;
  readonly cursor: boolean;
  readonly rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  readonly onEntryClick: (row: FlatRow) => void;
  readonly onKeyDown: (row: FlatRow, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

function FlatTreeRow({ row, cursor, rowRefs, onEntryClick, onKeyDown }: FlatTreeRowProps) {
  const { entry, depth, isSelected, isExpanded, isLoading } = row;
  const isDir = entry.kind === "dir";
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
      aria-selected={isSelected}
      aria-expanded={isDir ? isExpanded : undefined}
      onClick={handleClick}
      onKeyDown={(event) => onKeyDown(row, event)}
    >
      <span className="fexp-tree-icon" aria-hidden="true">
        {isDir ? <FolderIcon name={entry.name} open={isExpanded} /> : <FileIcon name={entry.name} />}
      </span>
      <span className="fexp-tree-name">{entry.name}</span>
      {isLoading && <span className="fexp-tree-spin" aria-hidden="true">⋯</span>}
    </button>
  );
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
