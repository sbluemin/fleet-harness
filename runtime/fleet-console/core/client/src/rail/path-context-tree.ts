import { createElement, useCallback, useEffect, useState, type ReactNode } from "react";

import type { RailPathDirectory } from "./path-context-api.js";

interface PathContextTreeProps {
  readonly theaterId: string;
  readonly parentPath: string | null;
  readonly selectedRelPath: string | null;
  readonly isDisabled: boolean;
  readonly loadDirectories: (parentPath: string | null, signal: AbortSignal) => Promise<readonly RailPathDirectory[]>;
  readonly onSelect: (relPath: string) => void;
}

interface DirectoryNodeProps {
  readonly directory: RailPathDirectory;
  readonly theaterId: string;
  readonly depth: number;
  readonly selectedRelPath: string | null;
  readonly isDisabled: boolean;
  readonly loadDirectories: PathContextTreeProps["loadDirectories"];
  readonly onSelect: PathContextTreeProps["onSelect"];
}

export function PathContextTree({ theaterId, parentPath, selectedRelPath, isDisabled, loadDirectories, onSelect }: PathContextTreeProps) {
  const [directories, setDirectories] = useState<readonly RailPathDirectory[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDirectories(null);
    setError(null);
    loadDirectories(parentPath, controller.signal).then(setDirectories).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load directories");
    });
    return () => controller.abort();
  }, [theaterId, parentPath, loadDirectories]);

  if (error) return createElement("div", { className: "rail-context-tree-status" }, error);
  if (!directories) return createElement("div", { className: "rail-context-tree-status" }, "Loading directories…");
  return createElement("div", { className: "rail-context-tree", role: "tree", "aria-label": "Directories" }, directories.map((directory) => createElement(DirectoryNode, { key: directory.relPath, directory, theaterId, depth: 0, selectedRelPath, isDisabled, loadDirectories, onSelect })));
}

function DirectoryNode({ directory, theaterId, depth, selectedRelPath, isDisabled, loadDirectories, onSelect }: DirectoryNodeProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<readonly RailPathDirectory[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children) return;
    const controller = new AbortController();
    setLoading(true);
    loadDirectories(directory.relPath, controller.signal).then(setChildren).catch(() => setChildren([])).finally(() => setLoading(false));
  }, [children, directory.relPath, expanded, loadDirectories]);

  const row = createElement("div", { className: `rail-context-tree-row${depth > 0 ? " is-nested" : ""}`, style: { paddingLeft: `${depth * 16}px` } },
    createElement("button", { className: `rail-context-expand${expanded ? " is-expanded" : ""}`, type: "button", disabled: isDisabled, "aria-label": `${expanded ? "Collapse" : "Expand"} ${directory.label}`, onClick: toggle }, "▸"),
    createElement("button", { className: `rail-context-select${selectedRelPath === directory.relPath ? " is-selected" : ""}`, type: "button", disabled: isDisabled, onClick: () => onSelect(directory.relPath) },
      createElement("span", { className: "rail-context-folder", "aria-hidden": "true" }),
      createElement("span", { className: "rail-context-badge rail-context-badge--directory" }, "DIR"),
      createElement("span", { className: "rail-context-row-label" }, directory.label)),
  );
  const childNodes: ReactNode = expanded && children?.map((child) => createElement(DirectoryNode, { key: child.relPath, directory: child, theaterId, depth: depth + 1, selectedRelPath, isDisabled, loadDirectories, onSelect }));
  return createElement("div", { className: "rail-context-tree-node", role: "treeitem", "aria-expanded": expanded }, row, expanded && loading ? createElement("div", { className: "rail-context-tree-status" }, "Loading…") : null, childNodes);
}
