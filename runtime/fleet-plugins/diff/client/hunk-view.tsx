import { useEffect, useState } from "react";

import type { RailDiffFileEntry, RailDiffHunkResult, RailPanelContext } from "@fleet-console/sdk/rail";

type DiffMode = "workdir" | "staged" | "commit";

interface HunkViewProps {
  readonly ctx: RailPanelContext;
  readonly file: RailDiffFileEntry;
  readonly mode: DiffMode;
  readonly ref?: string;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly result: RailDiffHunkResult }
  | { readonly kind: "error"; readonly message: string };

type HunkLine =
  | { readonly kind: "header"; readonly text: string }
  | { readonly kind: "add"; readonly text: string }
  | { readonly kind: "del"; readonly text: string }
  | { readonly kind: "ctx"; readonly text: string };

function parseHunk(content: string): HunkLine[] {
  return content.split("\n").map((line): HunkLine => {
    if (line.startsWith("@@")) return { kind: "header", text: line };
    if (line.startsWith("+")) return { kind: "add", text: line };
    if (line.startsWith("-")) return { kind: "del", text: line };
    return { kind: "ctx", text: line };
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function HunkView({ ctx, file, mode, ref: commitRef }: HunkViewProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    ctx.host.diff.unifiedDiff(file.path, mode, commitRef).then((result) => {
      if (!cancelled) setState({ kind: "ok", result });
    }).catch((err: unknown) => {
      if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.host.diff, file.path, mode, commitRef]);

  if (state.kind === "loading") {
    return <div className="diff-hunk-loading">Loading…</div>;
  }

  if (state.kind === "error") {
    return <div className="diff-hunk-error">{state.message}</div>;
  }

  const { result } = state;
  const lines = parseHunk(result.content);

  return (
    <div className="diff-hunk-wrap">
      {result.truncated && <div className="diff-truncated-badge">Diff truncated</div>}
      <div className="diff-hunk-scroll">
        <table className="diff-hunk-table" cellSpacing={0} cellPadding={0}>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={`diff-line diff-line-${line.kind}`}>
                <td
                  className="diff-line-code"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: escapeHtml(line.text) }}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
