import { useEffect, useState } from "react";

import type { PaneContext } from "@fleet-console/sdk/pane";

import type { DiffFileEntry, DiffFileMode, DiffHunkResult } from "../server/types.js";
import { getT, readErrorSentence } from "./i18n/index.js";
import { highlightEscapedDiffCode, parseHunk } from "./repository-parsers.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface HunkViewProps {
  readonly ctx: PaneContext;
  readonly repoRel: string;
  readonly file: DiffFileEntry;
  readonly mode: DiffFileMode;
  readonly commit?: CommitSelection | null;
  readonly compare?: CompareSelection | null;
}

export interface CommitSelection {
  readonly fullHash: string;
  readonly theaterId: string;
  readonly repoRel: string;
  readonly oldPath?: string;
}

export interface CompareSelection {
  readonly base: string;
  readonly head: string;
  readonly theaterId: string;
  readonly repoRel: string;
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

export function HunkView({ ctx, repoRel, file, mode, commit, compare }: HunkViewProps) {
  const t = getT(ctx.language);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!ctx.theaterId) {
      setState({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    if (compare) {
      ctx.api.fetch("repository", "compare-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: compare.theaterId, repoRel: compare.repoRel, base: compare.base, head: compare.head, filePath: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) }),
      }).then(async (res) => {
        if (!res.ok) throw new Error((await res.json() as { readonly error?: string }).error ?? "git_failed");
        const result = await res.json() as DiffHunkResult;
        if (!cancelled) setState({ kind: "ok", result });
      }).catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
      });
    } else if (commit) {
      ctx.api.fetch("repository", "commit-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: commit.theaterId, repoRel: commit.repoRel, ref: commit.fullHash, filePath: file.path, ...(file.oldPath ?? commit.oldPath ? { oldPath: file.oldPath ?? commit.oldPath } : {}) }),
      }).then(async (res) => {
        if (!res.ok) throw new Error((await res.json() as { readonly error?: string }).error ?? "git_failed");
        const result = await res.json() as DiffHunkResult;
        if (!cancelled) setState({ kind: "ok", result });
      }).catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
      });
    } else {
      ctx.api.fetch("repository", "file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, filePath: file.path, mode }),
      }).then(async (res) => {
        if (!res.ok) throw new Error((await res.json() as { readonly error?: string }).error ?? "git_failed");
        const result = await res.json() as DiffHunkResult;
        if (!cancelled) setState({ kind: "ok", result });
      }).catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "unknown" });
      });
    }

    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, file.oldPath, file.path, mode, commit, compare, repoRel]);

  if (state.kind === "loading") {
    return <div className="repository-hunk-loading">{t("repository.common.loading")}</div>;
  }

  if (state.kind === "error") {
    return <div className="repository-hunk-error">{readErrorSentence(t, state.message)}</div>;
  }

  const { result } = state;
  const parsed = parseHunk(result.content);
  const lines = parsed.filter((l) => l.kind !== "file-label");

  return (
    <div className="repository-hunk-wrap">
      {result.truncated && <div className="repository-truncated-badge">{t("repository.hunk.diffTruncated")}</div>}
      <div className="repository-hunk-scroll">
        <table className="repository-hunk-table" cellSpacing={0} cellPadding={0}>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={`repository-line repository-line-${line.kind}`}>
                {line.kind === "hunk-label" ? (
                  <td
                    colSpan={4}
                    className="repository-line-label"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: escapeHtml(line.text) }}
                  />
                ) : line.kind === "meta" ? (
                  <td
                    colSpan={4}
                    className="repository-line-meta"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: escapeHtml(line.text) }}
                  />
                ) : line.kind === "file-label" ? (
                  <td
                    colSpan={4}
                    className="repository-line-file-label"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: escapeHtml(line.text) }}
                  />
                ) : (
                  <>
                    <td className="repository-gutter repository-gutter-old">{line.oldLine ?? ""}</td>
                    <td className="repository-gutter repository-gutter-new">{line.newLine ?? ""}</td>
                    <td className="repository-marker">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                    </td>
                    <td
                      className="repository-line-code"
                      // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: highlightEscapedDiffCode(escapeHtml(line.text.length > 0 ? line.text.slice(1) : line.text)) }}
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
