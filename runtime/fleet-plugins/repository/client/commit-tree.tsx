import { useCallback, useEffect, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import { FileIcon, FolderIcon } from "@fleet-console/sdk/components/file-icon";
import type { RepositoryContext } from "./repository-context.js";

import type { BlobResult, DiffFileEntry, TreeEntry, TreeResult } from "../server/types.js";
import { Icon } from "./icons.js";
import { getT, type RepositoryMessageKey } from "./i18n/index.js";
import { highlightEscapedDiffCode } from "./repository-parsers.js";

type T = Translate<RepositoryMessageKey>;

type FolderState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly entries: readonly TreeEntry[] }
  | { readonly kind: "error" };

/** 트리에서 고른 파일 — 이 커밋에서 바뀐 파일이면 diff 항목을 함께 든다. */
export interface CommitTreeSelection {
  readonly path: string;
  readonly changed: DiffFileEntry | null;
}

interface CommitTreeViewProps {
  readonly ctx: RepositoryContext;
  readonly repoRel: string;
  readonly fullHash: string;
  /** 이 커밋에서 바뀐 파일 — 트리에서 상태 글리프로 표시된다. */
  readonly commitFiles: readonly DiffFileEntry[];
  readonly selectedPath: string | null;
  readonly onSelect: (selection: CommitTreeSelection) => void;
}

/** 파일 탐색기와 같은 행 기하 — 28px 행, 12px 들여쓰기 단, 깊이마다 가이드 선. */
const TREE_INDENT = 14;
const TREE_BASE_PAD = 12;

/**
 * 커밋 시점의 전체 파일 트리 — 파일 탐색기 문법(chevron · 폴더/파일 아이콘 · 가이드 선)을 쓴다.
 * 폴더 단위 lazy 조회라 저장소 크기에 무관하게 한 층씩만 서버를 부른다.
 */
export function CommitTreeView({ ctx, repoRel, fullHash, commitFiles, selectedPath, onSelect }: CommitTreeViewProps) {
  // key "" = 루트. 열린 폴더의 자식만 적재한다; 접으면 캐시는 남는다.
  const [folders, setFolders] = useState<ReadonlyMap<string, FolderState>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));

  const loadFolder = useCallback((dirPath: string) => {
    if (!ctx.theaterId) return;
    setFolders((current) => {
      if (current.has(dirPath)) return current;
      const next = new Map(current);
      next.set(dirPath, { kind: "loading" });
      return next;
    });
    ctx.api.fetch("repository", "tree", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ref: fullHash, ...(dirPath ? { dirPath } : {}) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error("tree_failed");
      return response.json() as Promise<TreeResult>;
    }).then((result) => {
      setFolders((current) => {
        const next = new Map(current);
        next.set(dirPath, { kind: "ok", entries: result.entries });
        return next;
      });
    }).catch(() => {
      setFolders((current) => {
        const next = new Map(current);
        next.set(dirPath, { kind: "error" });
        return next;
      });
    });
  }, [ctx.api, ctx.theaterId, fullHash, repoRel]);

  useEffect(() => { loadFolder(""); }, [loadFolder]);

  const toggleFolder = useCallback((dirPath: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath);
      else {
        next.add(dirPath);
        loadFolder(dirPath);
      }
      return next;
    });
  }, [loadFolder]);

  return <div className="repository-ftree" role="tree">
    <CommitTreeFolderBody
      t={getT(ctx.language)}
      dirPath=""
      depth={0}
      folders={folders}
      expanded={expanded}
      commitFiles={commitFiles}
      selectedPath={selectedPath}
      onToggle={toggleFolder}
      onSelect={onSelect}
    />
  </div>;
}

function statusTone(status: string): string {
  if (status === "A" || status === "U") return " is-added";
  if (status === "D") return " is-deleted";
  return " is-modified";
}

function CommitTreeFolderBody({ t, dirPath, depth, folders, expanded, commitFiles, selectedPath, onToggle, onSelect }: {
  readonly t: T;
  readonly dirPath: string;
  readonly depth: number;
  readonly folders: ReadonlyMap<string, FolderState>;
  readonly expanded: ReadonlySet<string>;
  readonly commitFiles: readonly DiffFileEntry[];
  readonly selectedPath: string | null;
  readonly onToggle: (dirPath: string) => void;
  readonly onSelect: (selection: CommitTreeSelection) => void;
}) {
  const state = folders.get(dirPath);
  const note = (text: string, error = false) => <div className={`repository-ftree-note${error ? " is-error" : ""}`} style={{ paddingLeft: `${TREE_BASE_PAD + depth * TREE_INDENT + 18}px` }}>{text}</div>;
  if (!state || state.kind === "loading") return note(t("repository.filetree.loading"));
  if (state.kind === "error") return note(t("repository.filetree.error"), true);
  if (state.entries.length === 0) return note(t("repository.filetree.empty"));
  const guides = Array.from({ length: depth }, (_, index) => <span key={index} className="repository-ftree-guide" style={{ left: `${TREE_BASE_PAD + index * TREE_INDENT + 6}px` }} aria-hidden="true" />);
  const indent = TREE_BASE_PAD + depth * TREE_INDENT;
  return <>
    {state.entries.map((entry) => {
      if (entry.kind === "tree") {
        const open = expanded.has(entry.path);
        // 하위 변경 수 — 접힌 폴더에서도 "이 안에 바뀐 것이 있다"가 보이게 한다.
        const changedInside = commitFiles.reduce((count, file) => count + (file.path.startsWith(`${entry.path}/`) ? 1 : 0), 0);
        return <div key={entry.path} role="none">
          <button type="button" role="treeitem" className={`repository-ftree-row is-dir${changedInside ? " has-changes" : ""}`} style={{ paddingLeft: `${indent}px` }} aria-expanded={open} onClick={() => onToggle(entry.path)}>
            {guides}
            <span className="repository-ftree-chevron" aria-hidden="true"><Icon name="child" size={12} /></span>
            <span className="repository-ftree-icon" aria-hidden="true"><FolderIcon name={entry.name} open={open} /></span>
            <span className="repository-ftree-name">{entry.name}</span>
            {!open && changedInside > 0 && <span className="repository-ftree-count">{changedInside}</span>}
          </button>
          {open && <CommitTreeFolderBody t={t} dirPath={entry.path} depth={depth + 1} folders={folders} expanded={expanded} commitFiles={commitFiles} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} />}
        </div>;
      }
      const changed = commitFiles.find((file) => file.path === entry.path) ?? null;
      const selected = selectedPath === entry.path;
      return <button key={entry.path} type="button" role="treeitem" aria-selected={selected} className={`repository-ftree-row is-file${selected ? " is-cur" : ""}${changed ? statusTone(changed.status) : ""}`} style={{ paddingLeft: `${indent}px` }} title={entry.path} onClick={() => onSelect({ path: entry.path, changed })}>
        {guides}
        <span className="repository-ftree-chevron" aria-hidden="true" />
        <span className="repository-ftree-icon" aria-hidden="true"><FileIcon name={entry.name} /></span>
        <span className="repository-ftree-name">{entry.name}</span>
        {changed && <span className={`repository-status-glyph repository-status-${changed.status.toLowerCase()}`} aria-label={changed.status}>{changed.status}</span>}
      </button>;
    })}
  </>;
}

// ─── 파일 내용 보기 ──────────────────────────────────────────────────────────

/** 렌더 상한 — 1MB 안에 짧은 줄이 수십만 개 들어올 수 있어 바이트 상한만으로는 DOM이 폭주한다. */
const BLOB_MAX_LINES = 5000;

type BlobState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly lines: readonly string[]; readonly truncated: boolean }
  | { readonly kind: "binary" }
  | { readonly kind: "error"; readonly code: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 커밋 시점의 파일 내용 — 바뀌지 않은 파일을 트리에서 골랐을 때 diff 대신 보여 준다. */
export function CommitBlobView({ ctx, repoRel, fullHash, path }: { readonly ctx: RepositoryContext; readonly repoRel: string; readonly fullHash: string; readonly path: string }) {
  const t = getT(ctx.language);
  const [state, setState] = useState<BlobState>({ kind: "loading" });
  useEffect(() => {
    if (!ctx.theaterId) return;
    let cancelled = false;
    setState({ kind: "loading" });
    ctx.api.fetch("repository", "blob", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ref: fullHash, filePath: path }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as Partial<BlobResult> & { readonly error?: string };
      if (cancelled) return;
      if (!response.ok) { setState({ kind: "error", code: payload.error ?? "git_failed" }); return; }
      if (payload.binary) { setState({ kind: "binary" }); return; }
      const content = payload.content ?? "";
      const lines = content.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const capped = lines.length > BLOB_MAX_LINES;
      setState({ kind: "ok", lines: capped ? lines.slice(0, BLOB_MAX_LINES) : lines, truncated: payload.truncated === true || capped });
    }).catch(() => { if (!cancelled) setState({ kind: "error", code: "network" }); });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, fullHash, path, repoRel]);
  if (state.kind === "loading") return <div className="repository-hunk-loading">{t("repository.common.loading")}</div>;
  if (state.kind === "binary") return <div className="repository-hunk-loading">{t("repository.filetree.binary")}</div>;
  if (state.kind === "error") return <div className="repository-hunk-error">{t(state.code === "file_not_found" ? "repository.filetree.fileMissing" : "repository.filetree.contentError")}</div>;
  return <div className="repository-hunk-wrap">
    <div className="repository-hunk-scroll">
      <table className="repository-hunk-table repository-blob-table">
        <tbody>
          {state.lines.map((line, index) => <tr key={index}>
            <td className="repository-gutter repository-blob-gutter">{index + 1}</td>
            <td className="repository-line-code" dangerouslySetInnerHTML={{ __html: highlightEscapedDiffCode(escapeHtml(line)) || "&nbsp;" }} />
          </tr>)}
        </tbody>
      </table>
      {state.truncated && <div className="repository-truncated-note">{t("repository.filetree.contentTruncated")}</div>}
    </div>
  </div>;
}
