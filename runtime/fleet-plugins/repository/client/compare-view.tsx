import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { CompareResult, DiffFileEntry } from "../server/types.js";
import { ChangedFiles } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";
import { isRemoteHeadRef, type RepositoryRefItem, type RepositoryRefs } from "./rail-panel.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth, installPointerDragLifecycle } from "./rail-layout.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface CompareViewProps {
  readonly ctx: RailPanelContext;
  readonly repoRel: string;
  readonly refs: RepositoryRefs;
  readonly onFileOpenChange?: (open: boolean) => void;
}

type CompareState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly base: string; readonly head: string; readonly files: readonly DiffFileEntry[]; readonly mergeBase?: string; readonly truncated?: boolean }
  | { readonly kind: "notice"; readonly reason: "no_git_repo" | "git_unavailable" }
  | { readonly kind: "error"; readonly message: string };

interface StoredCompareSelection {
  readonly base?: unknown;
  readonly head?: unknown;
}

// ─── constants ───────────────────────────────────────────────────────────────

const PREFS_COMPARE_PREFIX = "fleet-console.repository.compare.";
const LIST_PANE_DEFAULT_WIDTH = 248;
const LIST_PANE_MIN_WIDTH = 220;

// ─── persistence ─────────────────────────────────────────────────────────────

function compareSelectionKey(theaterId: string, repoRel: string): string {
  return `${PREFS_COMPARE_PREFIX}${theaterId}.${repoRel}`;
}

export function readCompareSelection(theaterId: string, repoRel: string): { base: string; head: string } | null {
  try {
    const raw = localStorage.getItem(compareSelectionKey(theaterId, repoRel));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCompareSelection;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      base: typeof parsed.base === "string" ? parsed.base : "",
      head: typeof parsed.head === "string" ? parsed.head : "",
    };
  } catch { return null; }
}

function saveCompareSelection(theaterId: string, repoRel: string, base: string, head: string): void {
  try { localStorage.setItem(compareSelectionKey(theaterId, repoRel), JSON.stringify({ base, head })); } catch { /* ignore */ }
}

// ─── CompareView ─────────────────────────────────────────────────────────────

export function CompareView({ ctx, repoRel, refs, onFileOpenChange }: CompareViewProps) {
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [result, setResult] = useState<CompareState>({ kind: "idle" });
  const [selected, setSelected] = useState<DiffFileEntry | null>(null);
  const [listPaneWidth, setListPaneWidth] = useState(LIST_PANE_DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const listPaneWidthRef = useRef(listPaneWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  const hydratedRef = useRef(false);
  const requestSeqRef = useRef(0);

  const remoteRefs = useMemo(() => refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)), [refs.remotes]);
  const currentBranch = refs.branches.find((item) => item.current) ?? null;
  const showHeadOption = currentBranch === null;
  const isValidSelection = useCallback((value: string): boolean => {
    if (value === "HEAD") return showHeadOption;
    return refs.branches.some((item) => item.ref === value) || remoteRefs.some((item) => item.ref === value) || refs.tags.some((item) => item.ref === value);
  }, [refs.branches, refs.tags, remoteRefs, showHeadOption]);

  // refs 도착 후 1회 hydrate — 저장된 선택은 현재 refs 목록 대조로 read-time 검증한다
  useEffect(() => {
    const refsLoaded = refs.branches.length > 0 || remoteRefs.length > 0 || refs.tags.length > 0;
    const defaultHead = currentBranch?.ref ?? "HEAD";
    if (!hydratedRef.current) {
      if (!refsLoaded || !ctx.theaterId) return;
      hydratedRef.current = true;
      const stored = readCompareSelection(ctx.theaterId, repoRel);
      setBase(stored && isValidSelection(stored.base) ? stored.base : "");
      setHead(stored && isValidSelection(stored.head) ? stored.head : defaultHead);
      return;
    }
    // refs 갱신으로 사라진 ref는 기본값으로 폴백한다
    setBase((value) => value && !isValidSelection(value) ? "" : value);
    setHead((value) => value && !isValidSelection(value) ? defaultHead : value);
  }, [ctx.theaterId, currentBranch, isValidSelection, refs.branches.length, refs.tags.length, remoteRefs.length, repoRel]);

  useEffect(() => { onFileOpenChange?.(selected !== null); }, [onFileOpenChange, selected]);
  useEffect(() => () => dragDisposeRef.current?.(), []);

  const chooseRef = useCallback((side: "base" | "head", value: string) => {
    const nextBase = side === "base" ? value : base;
    const nextHead = side === "head" ? value : head;
    if (side === "base") setBase(value); else setHead(value);
    if (ctx.theaterId) saveCompareSelection(ctx.theaterId, repoRel, nextBase, nextHead);
  }, [base, ctx.theaterId, head, repoRel]);

  const runCompare = useCallback(() => {
    if (!ctx.theaterId || !base || !head || base === head) return;
    const seq = ++requestSeqRef.current;
    setSelected(null);
    setResult({ kind: "loading" });
    // api.fetch는 non-2xx에서 payload를 버리고 throw하므로 오류 코드 매핑을 위해 raw fetch를 유지한다
    fetch("/plugins/repository/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, base, head }) }).then(async (response) => {
      if (seq !== requestSeqRef.current) return;
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        const code = payload.error ?? "git_failed";
        setResult(code === "no_git_repo" || code === "git_unavailable" ? { kind: "notice", reason: code } : { kind: "error", message: code });
        return;
      }
      const data = await response.json() as CompareResult;
      setResult({ kind: "ok", base, head, files: data.files, ...(data.mergeBase ? { mergeBase: data.mergeBase } : {}), ...(data.truncated ? { truncated: true } : {}) });
    }).catch((error: unknown) => {
      if (seq === requestSeqRef.current) setResult({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
  }, [base, ctx.theaterId, head, repoRel]);

  const handleDividerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const startWidth = listPaneWidthRef.current;
    dragDisposeRef.current?.();
    setIsDragging(true);
    dragDisposeRef.current = installPointerDragLifecycle({
      documentTarget: document,
      windowTarget: window,
      onMove: (moveEvent) => {
        const move = moveEvent as PointerEvent;
        const next = clampListPaneWidth({ startWidth, dx: move.clientX - startX, containerWidth, listPaneMinWidth: LIST_PANE_MIN_WIDTH, hunkPaneMinWidth: HUNK_PANE_MIN_WIDTH, dividerWidth: DIFF_DIVIDER_WIDTH });
        if (next !== null) {
          listPaneWidthRef.current = next;
          setListPaneWidth(next);
        }
      },
      onFinish: () => { setIsDragging(false); dragDisposeRef.current = null; },
    });
  }, []);

  const refOptions = (items: readonly RepositoryRefItem[]) => items.map((item) => <option key={item.ref} value={item.ref}>{item.label}</option>);
  const refSelect = (side: "base" | "head", value: string) => (
    <select className="repository-compare-select" aria-label={side === "base" ? "Base ref" : "Head ref"} value={value} onChange={(event) => chooseRef(side, event.target.value)}>
      {side === "base" && <option value="" disabled>Select base…</option>}
      {showHeadOption && <option value="HEAD">HEAD</option>}
      {refs.branches.length > 0 && <optgroup label="LOCAL">{refOptions(refs.branches)}</optgroup>}
      {remoteRefs.length > 0 && <optgroup label="REMOTES">{refOptions(remoteRefs)}</optgroup>}
      {refs.tags.length > 0 && <optgroup label="TAGS">{refOptions(refs.tags)}</optgroup>}
    </select>
  );

  const canCompare = base !== "" && head !== "" && base !== head;
  const compareSelection = result.kind === "ok" && ctx.theaterId ? { base: result.base, head: result.head, theaterId: ctx.theaterId, repoRel } : null;

  return (
    <div className="repository-compare">
      <div className="repository-compare-controls">
        {refSelect("base", base)}
        <span className="repository-compare-arrow" aria-hidden="true">…</span>
        {refSelect("head", head)}
        <button type="button" className="repository-refresh-btn repository-compare-run" disabled={!canCompare} onClick={runCompare}>Compare</button>
      </div>
      <div ref={rootRef} className={`repository-root${selected ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={selected ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
        {selected && compareSelection ? <div className="repository-hunk-pane"><div className="repository-hunk-head"><span>{selected.path}</span><button type="button" onClick={() => setSelected(null)}>✕</button></div><HunkView ctx={ctx} repoRel={repoRel} file={selected} mode="unified" compare={compareSelection} /></div> : null}
        {selected ? <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" /> : null}
        <div className="repository-list-pane repository-compare-results">
          {result.kind === "idle" && <div className="history-empty">Select base and head refs, then run Compare.</div>}
          {result.kind === "loading" && <div className="history-empty">Comparing…</div>}
          {result.kind === "ok" && result.files.length === 0 && <div className="history-empty">No differences between the selected refs.</div>}
          {(result.kind === "notice" || result.kind === "error" || (result.kind === "ok" && result.files.length > 0)) && (
            <>
              {result.kind === "ok" && result.mergeBase && <div className="repository-compare-meta">merge-base <span>{result.mergeBase}</span></div>}
              <ChangedFiles
                state={result.kind === "ok" ? { kind: "ok", files: result.files } : result}
                onRetry={runCompare}
                viewMode="list"
                selectedPath={selected?.path ?? null}
                onSelect={setSelected}
                filterText=""
              />
              {result.kind === "ok" && result.truncated && <div className="history-truncated">Comparison capped — file list truncated.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
