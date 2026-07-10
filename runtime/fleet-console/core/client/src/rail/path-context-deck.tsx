import { forwardRef, useCallback, useEffect, useState } from "react";

import type { RailPathContext } from "@fleet-console/sdk/rail";

import { fetchRailPathDirectories, fetchRailPathWorktrees, type RailPathWorktreesResult } from "./path-context-api.js";
import { PathContextTree } from "./path-context-tree.js";

interface PathContextDeckProps {
  readonly theaterId: string;
  readonly context: RailPathContext;
  readonly isMutating: boolean;
  readonly onSelect: (relPath: string | null) => void;
  readonly onClose: () => void;
}

export const PathContextDeck = forwardRef<HTMLDivElement, PathContextDeckProps>(function PathContextDeck({ theaterId, context, isMutating, onSelect, onClose }, ref) {
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
  const selectContext = useCallback((relPath: string | null) => {
    if (!isMutating) onSelect(relPath);
  }, [isMutating, onSelect]);

  return (
    <div ref={ref} className="rail-context-deck" role="dialog" aria-label="Path context">
      <div className="rail-context-deck-caption">Path context · applies to all path-aware panels</div>
      <button className={`rail-context-row${context.relPath === null ? " is-selected" : ""}`} type="button" disabled={isMutating} onClick={() => selectContext(null)}>
        <span className="rail-context-badge rail-context-badge--root">ROOT</span>
        <span className="rail-context-row-label">{context.label}</span>
        <span className="rail-context-row-secondary">THEATER</span>
      </button>
      <section className="rail-context-section" aria-label="Directories">
        <h3>DIRECTORIES</h3>
        <PathContextTree key={`${theaterId}:${context.relPath ?? "root"}`} theaterId={theaterId} parentPath={null} selectedRelPath={context.relPath} isDisabled={isMutating} loadDirectories={loadDirectories} onSelect={selectContext} />
      </section>
      {worktrees?.isGitRepo ? (
        <section className="rail-context-section" aria-label="Worktrees">
          <h3>WORKTREES</h3>
          {worktrees.worktrees.map((worktree) => (
            <button key={worktree.relPath} className={`rail-context-row${context.relPath === worktree.relPath ? " is-selected" : ""}`} type="button" title={worktree.relPath} disabled={isMutating} onClick={() => selectContext(worktree.relPath)}>
              <span className="rail-context-badge rail-context-badge--worktree">WORKTREE</span>
              <span className="rail-context-row-label">{worktree.relPath.split("/").at(-1)}</span>
              {worktree.branch ? <span className="rail-context-row-secondary">{worktree.branch}</span> : null}
            </button>
          ))}
        </section>
      ) : null}
      <div className="rail-context-deck-hint">Selected once · delivered to plugins via SDK</div>
    </div>
  );
});
