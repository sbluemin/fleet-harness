import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.js";

import type { RepositoryContext } from "./repository-context.js";

import type { CompareResult, DiffFileEntry } from "../server/types.js";
import { FileRow, FilesViewToggle, readFilesViewMode, saveFilesViewMode, type FilesViewMode } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";
import { getT, readErrorSentence } from "./i18n/index.js";
import { DiffTreeView } from "./repository-tree.js";
import { WorkspaceDock } from "./workspace-dock.js";

interface ComparePair {
  readonly base: string;
  readonly head: string;
  readonly baseLabel: string;
  readonly headLabel: string;
}

interface CompareInspectorProps {
  readonly ctx: RepositoryContext;
  readonly repoRel: string;
  readonly pair: ComparePair;
  readonly onSwap: () => void;
  readonly onClose: () => void;
}

type CompareInspectorState =
  | { readonly kind: "loading" }
  // ok 상태는 자기 쌍을 함께 든다 — 목록을 다음 답이 올 때까지 남기므로 파일 diff 조회는 새 쌍이 아니라 그 목록의 쌍을 향해야 한다.
  | { readonly kind: "ok"; readonly files: readonly DiffFileEntry[]; readonly pair: { readonly base: string; readonly head: string }; readonly mergeBase?: string; readonly truncated?: boolean }
  | { readonly kind: "notice"; readonly reason: "no_git_repo" | "git_unavailable" }
  | { readonly kind: "error"; readonly message: string };

export function CompareInspector({ ctx, repoRel, pair, onSwap, onClose }: CompareInspectorProps) {
  const t = getT(ctx.language);
  const [state, setState] = useState<CompareInspectorState>({ kind: "loading" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filesView, setFilesView] = useState<FilesViewMode>(readFilesViewMode);
  const requestSeqRef = useRef(0);
  const chooseFilesView = (next: FilesViewMode) => {
    setFilesView(next);
    saveFilesViewMode(next);
  };

  const [pending, setPending] = useState(true);
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    // base/head를 맞바꾸거나 다른 쌍으로 옮길 때 목록을 "비교 중"으로 갈아 끼우지 않는다 — 새 답이 올 때까지 옛 목록을 흐리게 남긴다.
    setState((current) => current.kind === "ok" ? current : { kind: "loading" });
    setPending(true);
    setSelectedPath(null);
    if (!ctx.theaterId) {
      setPending(false);
      setState({ kind: "error", message: "no_theater" });
      return;
    }
    // api.fetch는 non-2xx payload를 버리므로 오류 코드 매핑을 위해 raw fetch를 유지한다.
    fetch("/plugins/repository/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, base: pair.base, head: pair.head }) }).then(async (response) => {
      if (seq !== requestSeqRef.current) return;
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        if (seq !== requestSeqRef.current) return;
        const code = payload.error ?? "git_failed";
        setState(code === "no_git_repo" || code === "git_unavailable" ? { kind: "notice", reason: code } : { kind: "error", message: code });
        return;
      }
      const result = await response.json() as CompareResult;
      if (seq !== requestSeqRef.current) return;
      setState({ kind: "ok", files: result.files, pair: { base: pair.base, head: pair.head }, ...(result.mergeBase ? { mergeBase: result.mergeBase } : {}), ...(result.truncated ? { truncated: true } : {}) });
      setSelectedPath(result.files[0]?.path ?? null);
    }).catch((error: unknown) => {
      if (seq === requestSeqRef.current) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    }).finally(() => {
      if (seq === requestSeqRef.current) setPending(false);
    });
    return () => { requestSeqRef.current += 1; };
  }, [ctx.theaterId, pair.base, pair.head, repoRel]);

  const selectedFile = state.kind === "ok" ? state.files.find((file) => file.path === selectedPath) ?? state.files[0] ?? null : null;
  const additions = state.kind === "ok" ? state.files.reduce((sum, file) => sum + file.additions, 0) : 0;
  const deletions = state.kind === "ok" ? state.files.reduce((sum, file) => sum + file.deletions, 0) : 0;
  const loadedPair = state.kind === "ok" ? state.pair : pair;
  const compareSelection = useMemo(() => ctx.theaterId ? { base: loadedPair.base, head: loadedPair.head, theaterId: ctx.theaterId, repoRel } : null, [ctx.theaterId, loadedPair.base, loadedPair.head, repoRel]);
  const empty = state.kind === "loading"
    ? t("repository.compare.comparing")
    : state.kind === "notice"
      ? state.reason === "no_git_repo" ? t("repository.changes.notice.noGitRepoBody") : t("repository.changes.notice.gitUnavailableBody")
      : state.kind === "error"
        ? state.message === "no_merge_base" ? t("repository.compare.noMergeBase") : readErrorSentence(t, state.message)
        : state.files.length === 0 ? t("repository.compare.noDifferences") : null;

  return <WorkspaceDock
    t={t}
    className="history-compare-inspector"
    overlay={<span className="repository-sr-only" role="status">{state.kind === "ok" ? t("repository.compare.resultsAnnounce", { count: String(state.files.length) }) : ""}</span>}
    files={<section className="history-commit-files history-compare-files">
      <div className="history-files-title history-compare-result-head"><span className="history-files-label">{t("repository.compare.resultTitle", { head: pair.headLabel, base: pair.baseLabel })}</span>{state.kind === "ok" && <span className="history-files-stats">{state.files.length} <i>+{additions}</i> <em>−{deletions}</em></span>}<FilesViewToggle mode={filesView} onMode={chooseFilesView} t={t} /></div>
      {state.kind === "ok" && state.mergeBase && <div className="repository-compare-meta">{t("repository.compare.mergeBase")} <span>{state.mergeBase}</span></div>}
      <div className={`history-files-scroll${pending && state.kind === "ok" ? " is-stale" : ""}`} aria-busy={pending || undefined}>{state.kind === "ok" && (filesView === "tree" ? <DiffTreeView files={state.files} selectedPath={selectedFile?.path ?? null} onSelect={(entry) => setSelectedPath(entry.path)} /> : state.files.map((file) => <FileRow key={file.path} entry={file} isSelected={file.path === selectedFile?.path} onSelect={(entry) => setSelectedPath(entry.path)} t={t} />))}</div>
      {state.kind === "ok" && state.truncated && <div className="history-truncated">{t("repository.compare.capped")}</div>}
    </section>}
    main={<div className="repository-ws-dock-main">
      <div className="repository-ws-dock-meta history-compare-meta"><span className="history-compare-pair">{pair.baseLabel} → {pair.headLabel}</span><button type="button" className="repository-compare-swap" title={t("repository.compare.swap")} aria-label={t("repository.compare.swap")} onClick={onSwap}><Icon name="compare" size={13} /></button><button type="button" className="history-detail-close repository-ws-dock-close" aria-label={t("repository.compare.closeCompare")} title={t("repository.compare.closeCompare")} onClick={onClose}><Icon name="close" /></button></div>
      {selectedFile && compareSelection ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={selectedFile.path}>{selectedFile.path}</span></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile} mode="unified" compare={compareSelection} /></div> : <div className="history-inspector-empty">{empty}</div>}
    </div>}
  />;
}
