import { useEffect, useState } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffFileMode, DiffHunkResult } from "../server/types.js";
import { parseHunk } from "./hunk-parse.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface HunkViewProps {
  readonly ctx: RailPanelContext;
  readonly file: DiffFileEntry;
  readonly mode: DiffFileMode;
  readonly subPath: string;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly result: DiffHunkResult }
  | { readonly kind: "error"; readonly message: string };

// ─── helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── HunkView ────────────────────────────────────────────────────────────────

export function HunkView({ ctx, file, mode, subPath }: HunkViewProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    ctx.api.fetch("diff", "file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, filePath: file.path, mode, subPath }),
    }).then(async (res) => {
      const result = await res.json() as DiffHunkResult;
      if (!cancelled) setState({ kind: "ok", result });
    }).catch((err: unknown) => {
      if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.api, file.path, mode, subPath, ctx.theaterId]);

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
                {line.kind === "hunk-label" ? (
                  <td
                    colSpan={4}
                    className="diff-line-label"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: escapeHtml(line.text) }}
                  />
                ) : (
                  <>
                    <td className="diff-gutter diff-gutter-old">{line.oldLine ?? ""}</td>
                    <td className="diff-gutter diff-gutter-new">{line.newLine ?? ""}</td>
                    <td className="diff-marker">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                    </td>
                    <td
                      className="diff-line-code"
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={{ __html: escapeHtml(line.text.length > 0 ? line.text.slice(1) : line.text) }}
                    />
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
