import { useCallback, useState } from "react";

import type { DiffFileEntry, DiffSection } from "../server/types.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface TreeNode {
  dirs: { [key: string]: TreeNode };
  files: DiffFileEntry[];
}

// ─── constants ───────────────────────────────────────────────────────────────

const STATUS_GLYPHS: { [key: string]: string } = { M: "M", A: "A", D: "D", R: "R", U: "U" };

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

interface DiffTreeViewProps {
  readonly files: readonly DiffFileEntry[];
  readonly section: DiffSection;
  readonly selectedPath: string | null;
  readonly selectedSection: DiffSection | null;
  readonly onSelect: (entry: DiffFileEntry, section: DiffSection) => void;
}

export function DiffTreeView({ files, section, selectedPath, selectedSection, onSelect }: DiffTreeViewProps) {
  const tree = buildDiffTree(files);
  return (
    <DiffTreeChildren
      node={tree}
      depth={0}
      section={section}
      selectedPath={selectedPath}
      selectedSection={selectedSection}
      onSelect={onSelect}
    />
  );
}

// ─── 내부 공유 props ──────────────────────────────────────────────────────────

interface TreeCommonProps {
  readonly section: DiffSection;
  readonly selectedPath: string | null;
  readonly selectedSection: DiffSection | null;
  readonly onSelect: (entry: DiffFileEntry, section: DiffSection) => void;
}

// ─── DiffTreeChildren ─────────────────────────────────────────────────────────

interface TreeChildrenProps extends TreeCommonProps {
  readonly node: TreeNode;
  readonly depth: number;
}

function DiffTreeChildren({ node, depth, section, selectedPath, selectedSection, onSelect }: TreeChildrenProps) {
  return (
    <>
      {Object.entries(node.dirs).map(([key, child]) => (
        <DiffTreeFolder
          key={key}
          dirKey={key}
          node={child}
          depth={depth}
          section={section}
          selectedPath={selectedPath}
          selectedSection={selectedSection}
          onSelect={onSelect}
        />
      ))}
      {node.files.map((f) => (
        <DiffTreeLeaf
          key={f.path}
          entry={f}
          depth={depth}
          section={section}
          selectedPath={selectedPath}
          selectedSection={selectedSection}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

// ─── DiffTreeFolder ───────────────────────────────────────────────────────────

interface TreeFolderProps extends TreeCommonProps {
  readonly dirKey: string;
  readonly node: TreeNode;
  readonly depth: number;
}

function DiffTreeFolder({ dirKey, node, depth, section, selectedPath, selectedSection, onSelect }: TreeFolderProps) {
  const [collapsed, setCollapsed] = useState(false);
  const handleToggle = useCallback(() => setCollapsed((c) => !c), []);

  // VS Code 스타일: 자식 디렉터리 하나 + 파일 없음인 체인을 압축해 "a/b" 한 노드로 표시
  let label = dirKey;
  let resolvedNode = node;
  while (Object.keys(resolvedNode.dirs).length === 1 && resolvedNode.files.length === 0) {
    const onlyKey = Object.keys(resolvedNode.dirs)[0]!;
    label += "/" + onlyKey;
    resolvedNode = resolvedNode.dirs[onlyKey]!;
  }

  const indent = depth * 16 + 12;

  return (
    <div className={`diff-folder${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="diff-folder-row"
        style={{ paddingLeft: `${indent}px` }}
        onClick={handleToggle}
        aria-expanded={!collapsed}
      >
        <svg className="diff-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg className="diff-folder-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <span className="diff-folder-name">{label}</span>
      </button>
      {!collapsed && (
        <DiffTreeChildren
          node={resolvedNode}
          depth={depth + 1}
          section={section}
          selectedPath={selectedPath}
          selectedSection={selectedSection}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

// ─── DiffTreeLeaf ─────────────────────────────────────────────────────────────

interface TreeLeafProps extends TreeCommonProps {
  readonly entry: DiffFileEntry;
  readonly depth: number;
}

function DiffTreeLeaf({ entry, depth, section, selectedPath, selectedSection, onSelect }: TreeLeafProps) {
  const isSelected = entry.path === selectedPath && section === selectedSection;
  const handleClick = useCallback(() => onSelect(entry, section), [entry, section, onSelect]);
  const indent = depth * 16 + 12;
  const name = entry.path.split("/").pop() ?? entry.path;

  return (
    <button
      type="button"
      className={`diff-file-row${isSelected ? " is-cur" : ""}`}
      style={{ paddingLeft: `${indent}px` }}
      title={entry.path}
      onClick={handleClick}
    >
      <span className={`diff-status-glyph diff-status-${entry.status.toLowerCase()}`} aria-label={entry.status}>
        {STATUS_GLYPHS[entry.status] ?? entry.status}
      </span>
      <span className="diff-file-name">{name}</span>
      <span className="diff-nums">
        {entry.additions > 0 && <span className="diff-additions">+{entry.additions}</span>}
        {entry.deletions > 0 && <span className="diff-deletions">−{entry.deletions}</span>}
      </span>
    </button>
  );
}
