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
    files.listFolder(currentPath || undefined).then(setResult).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "폴더를 불러올 수 없습니다");
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

  const handleDirClick = useCallback((entry: FolderEntry) => {
    const relPath = entry.relativePath;
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) { next.delete(relPath); return next; }
      next.add(relPath);
      return next;
    });
    if (!childResults.has(relPath)) {
      setLoadingDirs((prev) => new Set(prev).add(relPath));
      files.listFolder(relPath).then((r) => {
        setChildResults((prev) => new Map(prev).set(relPath, r));
        setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
      }).catch(() => {
        setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
      });
    }
  }, [files, childResults]);

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

  if (!theaterId) return <div className="fexp-tree-empty">Theater를 선택하세요</div>;
  if (error) return <div className="fexp-tree-error">{error}</div>;
  if (!result) return <div className="fexp-tree-loading">로딩 중…</div>;

  return (
    <div className="fexp-tree-container">
      <div className="fexp-filter">
        <input
          type="text"
          className="fexp-filter-input"
          placeholder="Filter…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          aria-label="파일 필터"
        />
        {filterText && (
          <button
            type="button"
            className="fexp-filter-clear"
            onClick={() => setFilterText("")}
            aria-label="필터 지우기"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          className={`fexp-hidden-toggle${showHidden ? " is-active" : ""}`}
          onClick={handleToggleHidden}
          aria-pressed={showHidden}
          aria-label={showHidden ? "숨김 파일 숨기기" : "숨김 파일 표시"}
          title={showHidden ? "숨김 파일 숨기기" : "숨김 파일 표시"}
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
        aria-label="파일 트리"
        onScroll={shouldVirtualize ? handleScroll : undefined}
      >
        {result.parentRelativePath !== null && !filterText && (
          <button
            className="fexp-tree-up"
            type="button"
            onClick={() => setCurrentPath(result.parentRelativePath ?? "")}
            aria-label="상위 폴더"
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
          <div className="fexp-tree-empty">일치하는 항목 없음</div>
        )}
        {flatRows.length === 0 && !filterText && result.entries.length === 0 && (
          <div className="fexp-tree-empty">폴더가 비어 있습니다</div>
        )}
        {hasOnlyHiddenEntries && (
          <div className="fexp-tree-empty">숨김 항목만 있습니다 — 눈 아이콘으로 표시</div>
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
