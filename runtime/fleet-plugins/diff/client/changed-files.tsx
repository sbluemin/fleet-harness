import { useCallback, useEffect, useState } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffListResult } from "../server/types.js";

type DiffMode = "workdir" | "staged" | "commit";

interface ChangedFilesProps {
  readonly ctx: RailPanelContext;
  readonly mode: DiffMode;
  readonly selectedPath: string | null;
  readonly onSelect: (entry: DiffFileEntry | null) => void;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly result: DiffListResult }
  | { readonly kind: "error"; readonly message: string };

const STATUS_GLYPH: Record<DiffFileEntry["status"], string> = {
  M: "M",
  A: "A",
  D: "D",
  R: "R",
};

const STATUS_LABEL: Record<DiffFileEntry["status"], string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
};

export function ChangedFiles({ ctx, mode, selectedPath, onSelect }: ChangedFilesProps) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    ctx.api.fetch("diff", "changed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, mode }),
    }).then(async (res) => {
      const result = await res.json() as DiffListResult;
      if (!cancelled) setState({ kind: "ok", result });
    }).catch((err: unknown) => {
      if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.api, mode, ctx.theaterId]);

  const handleRefresh = useCallback(() => {
    setState({ kind: "idle" });
  }, []);

  if (state.kind === "loading" || state.kind === "idle") {
    return <div className="diff-tree-loading">Loading…</div>;
  }

  if (state.kind === "error") {
    return (
      <div className="diff-tree-error">
        <span>{state.message}</span>
        <button type="button" className="diff-refresh-btn" onClick={handleRefresh}>Retry</button>
      </div>
    );
  }

  const { files, truncated } = state.result;

  if (files.length === 0) {
    return <div className="diff-tree-empty">No changes</div>;
  }

  return (
    <div className="diff-tree">
      {truncated && <div className="diff-truncated-badge">Results truncated</div>}
      {files.map((entry) => (
        <FileRow
          key={entry.path}
          entry={entry}
          isSelected={entry.path === selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

interface FileRowProps {
  readonly entry: DiffFileEntry;
  readonly isSelected: boolean;
  readonly onSelect: (entry: DiffFileEntry) => void;
}

function FileRow({ entry, isSelected, onSelect }: FileRowProps) {
  const handleClick = useCallback(() => onSelect(entry), [entry, onSelect]);
  const filename = entry.path.split("/").pop() ?? entry.path;

  return (
    <button
      type="button"
      className={`diff-file-row${isSelected ? " is-cur" : ""}`}
      onClick={handleClick}
      title={entry.path}
    >
      <span
        className={`diff-status-glyph diff-status-${entry.status.toLowerCase()}`}
        aria-label={STATUS_LABEL[entry.status]}
      >
        {STATUS_GLYPH[entry.status]}
      </span>
      <span className="diff-file-name">{filename}</span>
      <span className="diff-file-path">{entry.path}</span>
      <span className="diff-additions">+{entry.additions}</span>
      <span className="diff-deletions">-{entry.deletions}</span>
    </button>
  );
}
