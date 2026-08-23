import { useCallback, useState, type ReactNode } from "react";

import type { DiffFileEntry } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface TreeNode {
  dirs: { [key: string]: TreeNode };
  files: DiffFileEntry[];
}

interface DiffTreeViewProps {
  readonly files: readonly DiffFileEntry[];
  readonly selectedPath: string | null;
  readonly onSelect: (entry: DiffFileEntry) => void;
  readonly collapsedFolders?: ReadonlySet<string>;
  readonly onToggleFolder?: (path: string) => void;
  /** 스테이징처럼 행 단위 동사가 필요한 호스트가 잎 행 오른쪽에 끼워 넣는 액션 슬롯. */
  readonly renderActions?: (entry: DiffFileEntry) => ReactNode;
}

interface TreeCommonProps {
  readonly selectedPath: string | null;
  readonly onSelect: (entry: DiffFileEntry) => void;
  readonly collapsedFolders?: ReadonlySet<string>;
  readonly onToggleFolder?: (path: string) => void;
  readonly renderActions?: (entry: DiffFileEntry) => ReactNode;
}

interface TreeChildrenProps extends TreeCommonProps {
  readonly node: TreeNode;
  readonly depth: number;
  readonly parentPath: string;
}

interface TreeFolderProps extends TreeCommonProps {
  readonly dirKey: string;
  readonly node: TreeNode;
  readonly depth: number;
  readonly parentPath: string;
}

interface TreeLeafProps extends TreeCommonProps {
  readonly entry: DiffFileEntry;
  readonly depth: number;
}

// ─── constants ───────────────────────────────────────────────────────────────

const STATUS_GLYPHS: { [key: string]: string } = { M: "M", A: "A", D: "D", R: "R", T: "T", U: "U" };

// ─── buildDiffTree ───────────────────────────────────────────────────────────

export function buildDiffTree(files: readonly DiffFileEntry[]): TreeNode {
  const root: TreeNode = { dirs: {}, files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    parts.pop(); // 파일명 제거, 디렉터리 세그먼트만 남김
    let node = root;
    for (const part of parts) {
      if (!node.dirs[part]) {
        node.dirs[part] = { dirs: {}, files: [] };
      }
      node = node.dirs[part]!;
    }
    node.files.push(f);
  }
  return root;
}

// ─── DiffTreeView (export) ────────────────────────────────────────────────────

export function DiffTreeView({ files, selectedPath, onSelect, collapsedFolders, onToggleFolder, renderActions }: DiffTreeViewProps) {
  const tree = buildDiffTree(files);
  return (
    <DiffTreeChildren
      node={tree}
      depth={0}
      parentPath=""
      selectedPath={selectedPath}
      onSelect={onSelect}
      collapsedFolders={collapsedFolders}
      onToggleFolder={onToggleFolder}
      renderActions={renderActions}
    />
  );
}

// ─── 내부 컴포넌트 ─────────────────────────────────────────────────────────────

function DiffTreeChildren({ node, depth, parentPath, selectedPath, onSelect, collapsedFolders, onToggleFolder, renderActions }: TreeChildrenProps) {
  return (
    <>
      {Object.entries(node.dirs).map(([key, child]) => (
        <DiffTreeFolder
          key={key}
          dirKey={key}
          node={child}
          depth={depth}
          parentPath={parentPath}
          selectedPath={selectedPath}
          onSelect={onSelect}
          collapsedFolders={collapsedFolders}
          onToggleFolder={onToggleFolder}
          renderActions={renderActions}
        />
      ))}
      {node.files.map((f) => (
        <DiffTreeLeaf
          key={f.path}
          entry={f}
          depth={depth}
          selectedPath={selectedPath}
          onSelect={onSelect}
          renderActions={renderActions}
        />
      ))}
    </>
  );
}

function DiffTreeFolder({ dirKey, node, depth, parentPath, selectedPath, onSelect, collapsedFolders, onToggleFolder, renderActions }: TreeFolderProps) {
  // VS Code 스타일: 자식 디렉터리 하나 + 파일 없음인 체인을 압축해 "a/b" 한 노드로 표시
  let label = dirKey;
  let resolvedNode = node;
  while (Object.keys(resolvedNode.dirs).length === 1 && resolvedNode.files.length === 0) {
    const onlyKey = Object.keys(resolvedNode.dirs)[0]!;
    label += "/" + onlyKey;
    resolvedNode = resolvedNode.dirs[onlyKey]!;
  }
  const path = parentPath ? `${parentPath}/${label}` : label;
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = collapsedFolders ? collapsedFolders.has(path) : localCollapsed;
  const handleToggle = useCallback(() => {
    if (onToggleFolder) onToggleFolder(path);
    else setLocalCollapsed((value) => !value);
  }, [onToggleFolder, path]);

  const indent = depth * 16 + 12;

  return (
    <div className={`repository-folder${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="repository-folder-row"
        style={{ paddingLeft: `${indent}px` }}
        onClick={handleToggle}
        aria-expanded={!collapsed}
      >
        <svg className="repository-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg className="repository-folder-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <span className="repository-folder-name">{label}</span>
      </button>
      {!collapsed && (
        <DiffTreeChildren
          node={resolvedNode}
          depth={depth + 1}
          parentPath={path}
          selectedPath={selectedPath}
          onSelect={onSelect}
          collapsedFolders={collapsedFolders}
          onToggleFolder={onToggleFolder}
          renderActions={renderActions}
        />
      )}
    </div>
  );
}

function DiffTreeLeaf({ entry, depth, selectedPath, onSelect, renderActions }: TreeLeafProps) {
  const isSelected = entry.path === selectedPath;
  const handleClick = useCallback(() => onSelect(entry), [entry, onSelect]);
  const indent = depth * 16 + 12;
  const name = entry.path.split("/").pop() ?? entry.path;

  const main = (
    <button
      type="button"
      className={renderActions ? "repository-staging-row-main" : `repository-file-row${isSelected ? " is-cur" : ""}`}
      style={{ paddingLeft: `${indent}px` }}
      title={entry.path}
      onClick={handleClick}
    >
      <span className={`repository-status-glyph repository-status-${entry.status.toLowerCase()}`} aria-label={entry.status}>
        {STATUS_GLYPHS[entry.status] ?? entry.status}
      </span>
      {/* 파일명 타이포/색·is-cur brass는 .repository-file-fn이 소유하므로 리스트 행과 동일 마크업을 유지한다 */}
      <span className="repository-file-name">
        <span className="repository-file-fn">{name}</span>
      </span>
      <span className="repository-nums">
        {entry.additions > 0 && <span className="repository-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="repository-deletions">−{entry.deletions}</span>}
      </span>
    </button>
  );
  if (!renderActions) return main;
  // 스테이징 잎은 리스트 행과 같은 래퍼 문법을 쓴다 — 행 hover가 액션 라벨을 여는 축이 같아야 한다.
  return (
    <div className={`repository-file-row repository-staging-row${isSelected ? " is-cur" : ""}`}>
      {main}
      <span className="repository-stage-actions">{renderActions(entry)}</span>
    </div>
  );
}
