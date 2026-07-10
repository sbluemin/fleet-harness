import { useCallback, useEffect, useState } from "react";

import type { RailPathContext } from "@fleet-console/sdk/rail";

import { fetchRailPathDirectories, fetchRailPathWorktrees, type RailPathWorktreesResult } from "./path-context-api.js";
import { PathContextTree } from "./path-context-tree.js";

interface PathContextDeckProps {
  readonly theaterId: string;
  readonly context: RailPathContext;
  readonly onSelect: (relPath: string | null) => void;
  readonly onClose: () => void;
}

export function PathContextDeck({ theaterId, context, onSelect, onClose }: PathContextDeckProps) {
  const [worktrees, setWorktrees] = useState<RailPathWorktreesResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchRailPathWorktrees(theaterId, controller.signal).then(setWorktrees).catch(() => setWorktrees({ isGitRepo: false, worktrees: [] }));
    return () => controller.abort();
  }, [theaterId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const loadDirectories = useCallback((relativePath: string | null, signal: AbortSignal) => fetchRailPathDirectories(theaterId, relativePath, signal), [theaterId]);

  return (
    <div className="rail-context-deck" role="dialog" aria-label="Path context">
      <button className={`rail-context-row${context.relPath === null ? " is-selected" : ""}`} type="button" onClick={() => onSelect(null)}>
        <span className="rail-context-badge rail-context-badge--root">ROOT</span><span>Theater root</span>
      </button>
      {worktrees?.isGitRepo ? (
        <section className="rail-context-section" aria-label="Worktrees">
          <h3>WORKTREES</h3>
          {worktrees.worktrees.map((worktree) => (
            <button key={worktree.relPath} className={`rail-context-row${context.relPath === worktree.relPath ? " is-selected" : ""}`} type="button" onClick={() => onSelect(worktree.relPath)}>
              <span className="rail-context-badge rail-context-badge--worktree">WORKTREE</span><span>{worktree.relPath}</span>{worktree.branch ? <small>{worktree.branch}</small> : null}
            </button>
          ))}
        </section>
      ) : null}
      <section className="rail-context-section" aria-label="Directories">
        <h3>DIRECTORIES</h3>
        <PathContextTree theaterId={theaterId} parentPath={null} loadDirectories={loadDirectories} onSelect={onSelect} />
      </section>
    </div>
  );
}
