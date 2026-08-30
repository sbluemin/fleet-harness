import { useCallback, useEffect, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { PaneContext } from "@fleet-console/sdk/pane";

import type { DiffFileEntry, TreeEntry, TreeResult } from "../server/types.js";
import { getT, type RepositoryMessageKey } from "./i18n/index.js";

type T = Translate<RepositoryMessageKey>;

type FolderState =
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly entries: readonly TreeEntry[] }
  | { readonly kind: "error" };

interface CommitTreeViewProps {
  readonly ctx: PaneContext;
  readonly repoRel: string;
  readonly fullHash: string;
  /** 이 커밋에서 바뀐 파일 — 트리에서 상태 글리프로 표시되고, 선택하면 diff로 이동한다. */
  readonly commitFiles: readonly DiffFileEntry[];
  readonly onOpenFile: (file: DiffFileEntry) => void;
}

/**
 * 커밋 시점의 전체 파일 트리 — Fork의 File Tree 탭.
 * 폴더 단위 lazy 조회라 저장소 크기에 무관하게 한 층씩만 서버를 부른다.
 */
export function CommitTreeView({ ctx, repoRel, fullHash, commitFiles, onOpenFile }: CommitTreeViewProps) {
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

  return <CommitTreeFolderBody
    t={getT(ctx.language)}
    dirPath=""
    depth={0}
    folders={folders}
    expanded={expanded}
    commitFiles={commitFiles}
    onToggle={toggleFolder}
    onOpenFile={onOpenFile}
  />;
}

function CommitTreeFolderBody({ t, dirPath, depth, folders, expanded, commitFiles, onToggle, onOpenFile }: {
  readonly t: T;
  readonly dirPath: string;
  readonly depth: number;
  readonly folders: ReadonlyMap<string, FolderState>;
  readonly expanded: ReadonlySet<string>;
  readonly commitFiles: readonly DiffFileEntry[];
  readonly onToggle: (dirPath: string) => void;
  readonly onOpenFile: (file: DiffFileEntry) => void;
}) {
  const state = folders.get(dirPath);
  if (!state || state.kind === "loading") return <div className="repository-filetree-note">{t("repository.filetree.loading")}</div>;
  if (state.kind === "error") return <div className="repository-filetree-note is-error">{t("repository.filetree.error")}</div>;
  if (state.entries.length === 0) return <div className="repository-filetree-note">{t("repository.filetree.empty")}</div>;
  return <>
    {state.entries.map((entry) => {
      const indent = depth * 14 + 10;
      if (entry.kind === "tree") {
        const open = expanded.has(entry.path);
        return <div key={entry.path}>
          <button type="button" className="repository-filetree-row is-folder" style={{ paddingLeft: `${indent}px` }} aria-expanded={open} onClick={() => onToggle(entry.path)}>
            <svg className={`repository-folder-chevron${open ? "" : " is-collapsed"}`} viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{entry.name}</span>
          </button>
          {open && <CommitTreeFolderBody t={t} dirPath={entry.path} depth={depth + 1} folders={folders} expanded={expanded} commitFiles={commitFiles} onToggle={onToggle} onOpenFile={onOpenFile} />}
        </div>;
      }
      const changed = commitFiles.find((file) => file.path === entry.path);
      return changed
        ? <button key={entry.path} type="button" className="repository-filetree-row is-changed" style={{ paddingLeft: `${indent + 14}px` }} title={entry.path} onClick={() => onOpenFile(changed)}>
          <span className={`repository-status-glyph repository-status-${changed.status.toLowerCase()}`}>{changed.status}</span>
          <span>{entry.name}</span>
        </button>
        : <div key={entry.path} className="repository-filetree-row" style={{ paddingLeft: `${indent + 14}px` }} title={entry.path}>
          <span>{entry.name}</span>
        </div>;
    })}
  </>;
}
