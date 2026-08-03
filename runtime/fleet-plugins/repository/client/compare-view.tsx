import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Select, type SelectOption } from "@fleet-console/sdk/react/browser";
import type { RailPanelContext } from "@fleet-console/sdk/rail";

import type { CompareResult, DiffFileEntry } from "../server/types.js";
import { ChangedFiles } from "./changed-files.js";
import { HunkView } from "./hunk-view.js";
import { getT } from "./i18n/index.js";
import { readCompareViewState, writeCompareViewState, type CompareResultSnapshot } from "./repository-state.js";
import { isRemoteHeadRef, type RepositoryRefs } from "./rail-panel.js";
import { DIFF_DIVIDER_WIDTH, HUNK_PANE_MIN_WIDTH, buildDiffGridTemplate, clampListPaneWidth, installPointerDragLifecycle } from "./rail-layout.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface CompareViewProps {
  readonly ctx: RailPanelContext;
  readonly repoRel: string;
  readonly refs: RepositoryRefs;
  readonly request?: { base: string; head: string; seq: number } | null;
  readonly refsError?: boolean;
  readonly onRetryRefs?: () => void;
  readonly onFileOpenChange?: (open: boolean) => void;
}

type CompareState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | CompareResultSnapshot;

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

export function CompareView({ ctx, repoRel, refs, request, refsError = false, onRetryRefs, onFileOpenChange }: CompareViewProps) {
  const t = getT(ctx.language);
  const [initialCache] = useState(() => ctx.theaterId ? readCompareViewState(ctx.theaterId, repoRel) : null);
  const initialResult: CompareState = initialCache?.result ?? { kind: "idle" };
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [result, setResult] = useState<CompareState>(initialResult);
  const [selected, setSelected] = useState<DiffFileEntry | null>(() => {
    if (initialResult.kind !== "ok" || !initialCache?.selectedPath) return null;
    return initialResult.files.find((entry) => entry.path === initialCache.selectedPath) ?? null;
  });
  const [listPaneWidth, setListPaneWidth] = useState(initialCache?.listPaneWidth ?? LIST_PANE_DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const listPaneWidthRef = useRef(listPaneWidth);
  const rootRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(initialCache?.scrollTop ?? 0);
  const restoredScrollTopRef = useRef<number | null>(initialCache?.scrollTop ?? null);
  const stateCacheKeyRef = useRef(`${ctx.theaterId ?? ""}\x00${repoRel}`);
  const cacheFrameRef = useRef<number | null>(null);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  const hydratedRef = useRef(false);
  const autoRanRef = useRef(false);
  const requestSeqRef = useRef(0);
  const handledRequestSeqRef = useRef(0);

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
    // refs 재조회 중 빈 배열 과도 상태에서는 모든 ref가 invalid로 보이므로,
    // 로드 전에는 hydrate도 유효성 폴백도 수행하지 않는다(선택 소실 방지).
    if (!refsLoaded) return;
    const defaultHead = currentBranch?.ref ?? "HEAD";
    const fallbackBase = refs.defaultBase && isValidSelection(refs.defaultBase) && refs.defaultBase !== defaultHead ? refs.defaultBase : "";
    if (!hydratedRef.current) {
      if (!ctx.theaterId) return;
      hydratedRef.current = true;
      const stored = readCompareSelection(ctx.theaterId, repoRel);
      setBase(stored && isValidSelection(stored.base) ? stored.base : fallbackBase);
      setHead(stored && isValidSelection(stored.head) ? stored.head : defaultHead);
      return;
    }
    // refs 갱신으로 사라진 ref는 기본값으로 폴백한다
    setBase((value) => value && !isValidSelection(value) ? fallbackBase : value);
    setHead((value) => value && !isValidSelection(value) ? defaultHead : value);
  }, [ctx.theaterId, currentBranch, isValidSelection, refs.branches.length, refs.defaultBase, refs.tags.length, remoteRefs.length, repoRel]);

  useEffect(() => { onFileOpenChange?.(selected !== null); }, [onFileOpenChange, selected]);
  useEffect(() => () => dragDisposeRef.current?.(), []);
  const cacheSnapshotRef = useRef({ theaterId: ctx.theaterId, repoRel, result, selected, listPaneWidth });
  cacheSnapshotRef.current = { theaterId: ctx.theaterId, repoRel, result, selected, listPaneWidth };
  const flushCompareCache = useCallback(() => {
    const snapshot = cacheSnapshotRef.current;
    if (!snapshot.theaterId || stateCacheKeyRef.current !== `${snapshot.theaterId}\x00${snapshot.repoRel}` || snapshot.result.kind === "loading") return;
    writeCompareViewState(snapshot.theaterId, snapshot.repoRel, {
      result: snapshot.result.kind === "idle" ? null : snapshot.result,
      selectedPath: snapshot.result.kind === "ok" && snapshot.selected && snapshot.result.files.some((entry) => entry.path === snapshot.selected?.path) ? snapshot.selected.path : null,
      listPaneWidth: snapshot.listPaneWidth,
      scrollTop: scrollTopRef.current,
    });
  }, []);
  const scheduleCompareCacheWrite = useCallback(() => {
    if (cacheFrameRef.current !== null) return;
    cacheFrameRef.current = requestAnimationFrame(() => {
      cacheFrameRef.current = null;
      flushCompareCache();
    });
  }, [flushCompareCache]);
  const updateResultsScroll = useCallback(() => {
    const list = resultsRef.current;
    if (!list || list.clientHeight <= 0 || list.scrollHeight <= 0) return;
    if (restoredScrollTopRef.current !== null) {
      const restoredScrollTop = restoredScrollTopRef.current;
      if (restoredScrollTop > 0 && list.scrollHeight <= list.clientHeight) return;
      list.scrollTop = restoredScrollTop;
      restoredScrollTopRef.current = null;
    }
    scrollTopRef.current = list.scrollTop;
    scheduleCompareCacheWrite();
  }, [scheduleCompareCacheWrite]);
  useEffect(() => {
    scheduleCompareCacheWrite();
  }, [listPaneWidth, result, scheduleCompareCacheWrite, selected]);
  useEffect(() => () => {
    if (cacheFrameRef.current !== null) {
      cancelAnimationFrame(cacheFrameRef.current);
      cacheFrameRef.current = null;
    }
    flushCompareCache();
  }, [flushCompareCache]);
  useLayoutEffect(() => {
    updateResultsScroll();
    const list = resultsRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateResultsScroll);
    observer.observe(list);
    return () => observer.disconnect();
  }, [result, updateResultsScroll]);

  const chooseRef = useCallback((side: "base" | "head", value: string) => {
    const nextBase = side === "base" ? value : base;
    const nextHead = side === "head" ? value : head;
    if (side === "base") setBase(value); else setHead(value);
    if (ctx.theaterId) saveCompareSelection(ctx.theaterId, repoRel, nextBase, nextHead);
  }, [base, ctx.theaterId, head, repoRel]);

  const swapRefs = useCallback(() => {
    setBase(head);
    setHead(base);
    if (ctx.theaterId) saveCompareSelection(ctx.theaterId, repoRel, head, base);
  }, [base, head, ctx.theaterId, repoRel]);

  const runCompare = useCallback((baseRef: string = base, headRef: string = head) => {
    if (!ctx.theaterId || !baseRef || !headRef || baseRef === headRef) return;
    const seq = ++requestSeqRef.current;
    setSelected(null);
    setResult({ kind: "loading" });
    // api.fetch는 non-2xx에서 payload를 버리고 throw하므로 오류 코드 매핑을 위해 raw fetch를 유지한다
    fetch("/plugins/repository/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, base: baseRef, head: headRef }) }).then(async (response) => {
      if (seq !== requestSeqRef.current) return;
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        // json() await 사이에 새 요청이 시작됐으면 stale 응답을 무시한다
        if (seq !== requestSeqRef.current) return;
        const code = payload.error ?? "git_failed";
        setResult(code === "no_git_repo" || code === "git_unavailable" ? { kind: "notice", reason: code } : { kind: "error", message: code });
        return;
      }
      const data = await response.json() as CompareResult;
      if (seq !== requestSeqRef.current) return;
      setResult({ kind: "ok", base: baseRef, head: headRef, files: data.files, ...(data.mergeBase ? { mergeBase: data.mergeBase } : {}), ...(data.truncated ? { truncated: true } : {}) });
    }).catch((error: unknown) => {
      if (seq === requestSeqRef.current) setResult({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
  }, [base, ctx.theaterId, head, repoRel]);

  useEffect(() => {
    if (!request || request.seq === handledRequestSeqRef.current) return;
    handledRequestSeqRef.current = request.seq;
    if (!isValidSelection(request.base) || !isValidSelection(request.head)) return;
    setBase(request.base);
    setHead(request.head);
    if (ctx.theaterId) saveCompareSelection(ctx.theaterId, repoRel, request.base, request.head);
    runCompare(request.base, request.head);
  }, [ctx.theaterId, isValidSelection, repoRel, request, runCompare]);

  useEffect(() => {
    if (autoRanRef.current || !hydratedRef.current || !base || !head || base === head) return;
    // 캐시 복원 결과가 현재 선택과 일치하면 재실행하지 않는다.
    // 불일치(예: 체크아웃 변경 후 재진입으로 head 기본값이 이동)면 1회 갱신해 셀렉터-결과 정합을 지킨다.
    const staleOk = result.kind === "ok" && (result.base !== base || result.head !== head);
    if (result.kind !== "idle" && !staleOk) return;
    autoRanRef.current = true;
    runCompare();
  }, [base, head, result, runCompare]);

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

  const headRefOptions = useMemo((): readonly SelectOption[] => {
    const options: SelectOption[] = [];
    if (showHeadOption) options.push({ value: "HEAD", label: "HEAD" });
    for (const item of refs.branches) options.push({ value: item.ref, label: t("repository.compare.optionLocal", { label: item.label }) });
    for (const item of remoteRefs) options.push({ value: item.ref, label: t("repository.compare.optionRemotes", { label: item.label }) });
    for (const item of refs.tags) options.push({ value: item.ref, label: t("repository.compare.optionTags", { label: item.label }) });
    return options;
  }, [refs.branches, refs.tags, remoteRefs, showHeadOption, t]);
  const baseRefOptions = useMemo(
    (): readonly SelectOption[] => [{ value: "", label: t("repository.compare.selectBase"), disabled: true }, ...headRefOptions.map((option) => option.value === refs.defaultBase ? { ...option, label: `${option.label} · ${t("repository.compare.baseBadge")}` } : option)],
    [headRefOptions, refs.defaultBase, t],
  );
  const refSelect = (side: "base" | "head", value: string) => (
    <Select
      label={side === "base" ? t("repository.compare.baseRef") : t("repository.compare.headRef")}
      value={value}
      options={side === "base" ? baseRefOptions : headRefOptions}
      onChange={(next) => chooseRef(side, next)}
    />
  );

  const canCompare = base !== "" && head !== "" && base !== head;
  // primitive 기준으로만 재생성 — 객체 identity가 매 렌더 바뀌면 HunkView effect가 드래그마다 재fetch한다 (history-panel commit selection 선례 미러)
  const okBase = result.kind === "ok" ? result.base : null;
  const okHead = result.kind === "ok" ? result.head : null;
  const compareSelection = useMemo(
    () => okBase && okHead && ctx.theaterId ? { base: okBase, head: okHead, theaterId: ctx.theaterId, repoRel } : null,
    [okBase, okHead, ctx.theaterId, repoRel],
  );

  return (
    <div className="repository-compare">
      {refsError ? <div className="history-error">{t("repository.discovery.loadRefsFailed")}<button type="button" className="repository-refresh-btn" onClick={onRetryRefs}>{t("repository.common.retry")}</button></div> : <div className="repository-compare-controls">
        {refSelect("base", base)}
        <button type="button" className="repository-compare-swap" disabled={!base || !head} onClick={swapRefs} title={t("repository.compare.swap")} aria-label={t("repository.compare.swap")}>⇄</button>
        {refSelect("head", head)}
        <button type="button" className="repository-refresh-btn repository-compare-run" disabled={!canCompare} onClick={() => runCompare()}>{t("repository.compare.run")}</button>
      </div>}
      <div ref={rootRef} className={`repository-root${selected ? " has-hunk" : ""}${isDragging ? " is-dragging" : ""}`} style={selected ? { gridTemplateColumns: buildDiffGridTemplate(listPaneWidth) } : undefined}>
        {selected && compareSelection ? <div className="repository-hunk-pane"><div className="repository-hunk-head"><span>{selected.path}</span><button type="button" onClick={() => setSelected(null)}>✕</button></div><HunkView ctx={ctx} repoRel={repoRel} file={selected} mode="unified" compare={compareSelection} /></div> : null}
        {selected ? <div className="repository-divider" onPointerDown={handleDividerDown} aria-hidden="true" /> : null}
        <div className="repository-list-pane repository-compare-results">
          <span className="repository-sr-only" role="status">{result.kind === "ok" ? t("repository.compare.resultsAnnounce", { count: String(result.files.length) }) : ""}</span>
          {result.kind === "idle" && <div className="history-empty">{t("repository.compare.idle")}</div>}
          {result.kind === "loading" && <div className="history-empty">{t("repository.compare.comparing")}</div>}
          {result.kind === "ok" && result.files.length === 0 && <div className="history-empty">{t("repository.compare.noDifferences")}</div>}
          {/* 무관 히스토리 ref 쌍은 오류가 아니라 안내로 표면화한다 */}
          {result.kind === "error" && result.message === "no_merge_base" && <div className="history-empty">{t("repository.compare.noMergeBase")}</div>}
          {(result.kind === "notice" || (result.kind === "error" && result.message !== "no_merge_base") || (result.kind === "ok" && result.files.length > 0)) && (
            <>
              {result.kind === "ok" && result.mergeBase && <div className="repository-compare-meta">{t("repository.compare.mergeBase")} <span>{result.mergeBase}</span></div>}
              <ChangedFiles
                state={result.kind === "ok" ? { kind: "ok", files: result.files } : result}
                onRetry={runCompare}
                viewMode="list"
                selectedPath={selected?.path ?? null}
                onSelect={setSelected}
                filterText=""
                t={t}
                scrollContainerRef={resultsRef}
                onScroll={updateResultsScroll}
              />
              {result.kind === "ok" && result.truncated && <div className="history-truncated">{t("repository.compare.capped")}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
