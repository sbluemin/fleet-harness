import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FolderEntry, FolderListResult } from "../server/types.js";

import { FileIcon, FolderIcon } from "./file-icon.js";

export interface PluginFilesClient {
  readonly listFolder: (relativePath?: string) => Promise<FolderListResult>;
}

interface FileTreeProps {
  readonly files: PluginFilesClient;
  readonly theaterId: string | null;
  readonly selectedPath: string | null;
  readonly onSelect: (entry: FolderEntry) => void;
}

interface FlatRow {
  readonly entry: FolderEntry;
  readonly depth: number;
  readonly isSelected: boolean;
  readonly isExpanded: boolean;
  readonly isLoading: boolean;
}

const VIRTUALIZE_THRESHOLD = 200;
const ROW_HEIGHT = 30;
const OVERSCAN = 5;
const PREFS_SHOW_HIDDEN = "fleet-console.fileExplorer.showHidden";

function hasFilterMatch(
  entries: readonly FolderEntry[],
  childResults: Map<string, FolderListResult>,
  low: string,
  showHidden: boolean,
): boolean {
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    if (e.name.toLowerCase().includes(low)) return true;
    if (e.kind === "dir") {
      const children = childResults.get(e.relativePath)?.entries;
      if (children && hasFilterMatch(children, childResults, low, showHidden)) return true;
    }
  }
  return false;
}

function buildFlatRows(
  entries: readonly FolderEntry[],
  depth: number,
  selectedPath: string | null,
  expandedDirs: Set<string>,
  loadingDirs: Set<string>,
  childResults: Map<string, FolderListResult>,
  low: string,
  showHidden: boolean,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    if (low) {
      const directMatch = entry.name.toLowerCase().includes(low);
      const childMatch = entry.kind === "dir" && hasFilterMatch(
        childResults.get(entry.relativePath)?.entries ?? [],
        childResults,
        low,
        showHidden,
      );
      if (!directMatch && !childMatch) continue;
    }
    rows.push({
      entry,
      depth,
      isSelected: selectedPath === entry.relativePath,
      isExpanded: expandedDirs.has(entry.relativePath),
      isLoading: loadingDirs.has(entry.relativePath),
    });
    if (entry.kind === "dir" && expandedDirs.has(entry.relativePath)) {
      const children = childResults.get(entry.relativePath)?.entries;
      if (children) {
        rows.push(...buildFlatRows(children, depth + 1, selectedPath, expandedDirs, loadingDirs, childResults, low, showHidden));
      }
    }
  }
  return rows;
}

export function FileTree({ files, theaterId, selectedPath, onSelect }: FileTreeProps) {
  const [result, setResult] = useState<FolderListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [childResults, setChildResults] = useState<Map<string, FolderListResult>>(new Map());
  const [filterText, setFilterText] = useState<string>("");
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [showHidden, setShowHidden] = useState<boolean>(() => readShowHidden());
  const treeRef = useRef<HTMLDivElement>(null);

  // SSE 핸들러가 최신 상태를 참조하도록 ref로 유지
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const currentPathRef = useRef<string>(currentPath);
  currentPathRef.current = currentPath;
  const filesRef = useRef<PluginFilesClient>(files);
  filesRef.current = files;

  useEffect(() => {
    if (!theaterId) return;
    setResult(null);
    setError(null);
    setCurrentPath("");
    setExpandedDirs(new Set());
    setChildResults(new Map());
    setFilterText("");
  }, [theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    files.listFolder(currentPath || undefined).then((r) => {
      setResult(r);
      setError(null);
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Unable to load folder");
    });
  }, [theaterId, currentPath, files]);

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
      filesRef.current.listFolder(currentPathRef.current || undefined).then((r) => {
        setResult(r);
        setError(null);
      }).catch(() => {});
    };

    const doFullRefresh = () => {
      reloadRoot();
      for (const relPath of expandedDirsRef.current) {
        filesRef.current.listFolder(relPath).then((r) => {
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
        filesRef.current.listFolder(relDir).then((r) => {
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
  }, [theaterId, files]);

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
      setLoadingDirs((prev) => new Set(prev).add(relPath));
      files.listFolder(relPath).then((r) => {
        setChildResults((prev) => new Map(prev).set(relPath, r));
        setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
      }).catch(() => {
        setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
      });
    }
  }, [files, expandedDirs]);

  const handleEntryClick = useCallback((entry: FolderEntry) => {
    if (entry.kind === "dir") handleDirClick(entry);
    else onSelect(entry);
  }, [handleDirClick, onSelect]);

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
    // 루트 재조회 — 성공 시 stale error를 걷어 에러 화면에서도 복구 가능하게 한다
    files.listFolder(currentPath || undefined).then((r) => {
      setResult(r);
      setError(null);
    }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Unable to load folder");
    });
    // 펼쳐진 모든 폴더 재조회
    for (const relPath of expandedDirs) {
      files.listFolder(relPath).then((r) => {
        setChildResults((prev) => new Map(prev).set(relPath, r));
      }).catch(() => {});
    }
  }, [files, currentPath, expandedDirs, theaterId]);

  const low = filterText.toLowerCase();

  const flatRows = useMemo(() => {
    if (!result) return [];
    return buildFlatRows(result.entries, 0, selectedPath, expandedDirs, loadingDirs, childResults, low, showHidden);
  }, [result, selectedPath, expandedDirs, loadingDirs, childResults, low, showHidden]);

  const hasOnlyHiddenEntries = !showHidden && result !== null && result.entries.length > 0 && flatRows.length === 0 && !filterText;

  const shouldVirtualize = flatRows.length > VIRTUALIZE_THRESHOLD;
  const startIdx = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const endIdx = shouldVirtualize ? Math.min(flatRows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN) : flatRows.length;
  const visibleRows = flatRows.slice(startIdx, endIdx);
  const totalHeight = flatRows.length * ROW_HEIGHT;
  const offsetY = startIdx * ROW_HEIGHT;

  if (!theaterId) return <div className="fexp-tree-empty">Select a Theater</div>;
  if (error) return <div className="fexp-tree-error">{error}</div>;
  if (!result) return <div className="fexp-tree-loading">Loading…</div>;

  return (
    <div className="fexp-tree-container">
      <div className="fexp-filter">
        <input
          type="text"
          className="fexp-filter-input"
          placeholder="Filter…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="Filter files"
        />
        {filterText && (
          <button
            type="button"
            className="fexp-filter-clear"
            onClick={() => setFilterText("")}
            aria-label="Clear filter"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          className="fexp-refresh-btn"
          onClick={handleRefresh}
          aria-label="Refresh file tree"
          title="Refresh file tree"
        >
          ↻
        </button>
        <button
          type="button"
          className={`fexp-hidden-toggle${showHidden ? " is-active" : ""}`}
          onClick={handleToggleHidden}
          aria-pressed={showHidden}
          aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
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
        aria-label="File tree"
        onScroll={shouldVirtualize ? handleScroll : undefined}
      >
        {result.parentRelativePath !== null && !filterText && (
          <button
            className="fexp-tree-up"
            type="button"
            onClick={() => setCurrentPath(result.parentRelativePath ?? "")}
            aria-label="Parent folder"
          >
            ↑ ..
          </button>
        )}
        {shouldVirtualize ? (
          <div style={{ height: totalHeight, position: "relative" }}>
            <div style={{ transform: `translateY(${offsetY}px)` }}>
              {visibleRows.map((row) => (
                <FlatTreeRow key={row.entry.relativePath} row={row} onEntryClick={handleEntryClick} />
              ))}
            </div>
          </div>
        ) : (
          visibleRows.map((row) => (
            <FlatTreeRow key={row.entry.relativePath} row={row} onEntryClick={handleEntryClick} />
          ))
        )}
        {flatRows.length === 0 && filterText && (
          <div className="fexp-tree-empty">No matching items</div>
        )}
        {flatRows.length === 0 && !filterText && result.entries.length === 0 && (
          <div className="fexp-tree-empty">This folder is empty</div>
        )}
        {hasOnlyHiddenEntries && (
          <div className="fexp-tree-empty">Only hidden items — use the eye icon to show them</div>
        )}
      </div>
    </div>
  );
}

interface FlatTreeRowProps {
  readonly row: FlatRow;
  readonly onEntryClick: (entry: FolderEntry) => void;
}

function FlatTreeRow({ row, onEntryClick }: FlatTreeRowProps) {
  const { entry, depth, isSelected, isExpanded, isLoading } = row;
  const isDir = entry.kind === "dir";
  const indent = depth * 16;
  const handleClick = useCallback(() => onEntryClick(entry), [entry, onEntryClick]);

  return (
    <button
      className={`fexp-tree-row${isSelected ? " is-cur" : ""}${isDir ? " is-dir" : " is-file"}`}
      style={{ paddingLeft: `${indent + 12}px` }}
      type="button"
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={isDir ? isExpanded : undefined}
      onClick={handleClick}
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
