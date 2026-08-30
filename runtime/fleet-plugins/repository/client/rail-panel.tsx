import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailPanelContext, RailEntryDescriptor } from "@fleet-console/sdk/rail";

import type { DiffFileEntry, DiffListResult, RepoCandidate, RepositorySearchResult, ReposResult, WorkstateResult, WorktreeCandidate, WorktreesResult } from "../server/types.js";
import "./repository.css";
import { type ChangedFilesState } from "./changed-files.js";
import { fuzzyMatch, shortRefName } from "./repository-parsers.js";
import { getT, type RepositoryMessageKey } from "./i18n/index.js";
import { buildRepoTree, compressRepoFolder, countRepos, type RepoTreeNode } from "./repository-parsers.js";
import { clearSelectedFile } from "./repository-state.js";
import { dropHistoryCacheForRepository } from "./repository-state.js";
import { HistoryPanel } from "./history-panel.js";
import { dropRepoViewState, readRepoViewState, readWorkspaceTreeState, writeRepoViewState, writeWorkspaceTreeState } from "./repository-state.js";
import { StagingView, guardMessageOf } from "./staging-view.js";
import { buildWorkspaceTreeSections, clampWorkspaceTreeWidth, readWorkspaceTreeWidth, saveWorkspaceTreeWidth } from "./workspace-layout.js";
import { activateRepositorySearchTarget, useRepositorySearchTarget } from "./repository-state.js";

type T = Translate<RepositoryMessageKey>;

type RepositoryFetchResult =
  | { readonly ok: true; readonly skipped: "throttled"; readonly lastFetchAt: string }
  | { readonly ok: true; readonly fetchedAt: string; readonly lastFetchAt: string; readonly pruned: number; readonly newRefs: number; readonly updatedRefs: number };

interface RepositoryPanelProps {
  readonly ctx: RailPanelContext;
}

const PREFS_SOURCE = "fleet-console.repository.source";
const PREFS_REPO_PREFIX = "fleet-console.repository.repo.";
const PREFS_SCAN_DEPTH = "fleet-console.repository.scanDepth";
const SCAN_DEPTH_MIN = 1;
const SCAN_DEPTH_MAX = 8;
const SCAN_DEPTH_DEFAULT = 3;
// ✓ 체류는 클릭했다는 사실이 눈에 남을 만큼만, 말풍선은 짧은 한 마디를 읽을 만큼만.
// 원격 왕복이 수백 ms라 요청 자체는 거의 보이지 않으므로, 결과 쪽 체류가 피드백을 진다.
const SYNC_SETTLED_MS = 1400;
const SYNC_HINT_MS = 2200;
// 실패 문면은 조치를 담고 있어 성공보다 오래 머문다 — 물러난 뒤에도 coral 점과 hover로 다시 열린다.
const VERB_ERROR_HINT_MS = 7000;

export function readRepositorySource(): Source {
  try {
    const value = localStorage.getItem(PREFS_SOURCE);
    if (value === "changes" || value === "history") return value;
    // 저장된 "compare"는 History로 착지한다(Compare 뷰 은퇴).
  } catch { /* ignore */ }
  // 구 소스 페이지 값(repositories/branches 등)은 워크스페이스 중앙 뷰가 아니므로 History로 착지한다.
  return "history";
}

function readStoredRepositoryRel(theaterId: string): string {
  try { return localStorage.getItem(`${PREFS_REPO_PREFIX}${theaterId}`) ?? ""; }
  catch { return ""; }
}

export function readRepositoryRel(theaterId: string, repos: readonly RepoCandidate[], worktrees: readonly WorktreeCandidate[]): string {
  try {
    const key = `${PREFS_REPO_PREFIX}${theaterId}`;
    const stored = localStorage.getItem(key);
    if (stored === null) return "";
    if (repos.some((repo) => repo.relPath === stored) || worktrees.some((worktree) => worktree.relPath === stored)) return stored;
    localStorage.removeItem(key);
  } catch { /* ignore */ }
  return "";
}

export function readScanDepth(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(PREFS_SCAN_DEPTH) ?? "", 10);
    if (Number.isInteger(value) && value >= SCAN_DEPTH_MIN && value <= SCAN_DEPTH_MAX) return value;
  } catch { /* ignore */ }
  return SCAN_DEPTH_DEFAULT;
}

function saveScanDepth(depth: number): void {
  try { localStorage.setItem(PREFS_SCAN_DEPTH, String(depth)); } catch { /* ignore */ }
}

export function saveRepositoryRel(theaterId: string, repoRel: string): void {
  try { localStorage.setItem(`${PREFS_REPO_PREFIX}${theaterId}`, repoRel); } catch { /* ignore */ }
}

function clearRepositoryRel(theaterId: string): void {
  try { localStorage.removeItem(`${PREFS_REPO_PREFIX}${theaterId}`); } catch { /* ignore */ }
}

function saveRepositorySource(source: Source): void {
  try { localStorage.setItem(PREFS_SOURCE, source); } catch { /* ignore */ }
}


/**
 * 동사 성공의 문면은 "무엇을 했다"는 서술이 아니라 "몇 커밋이 움직였다"는 실질이다 —
 * 서술은 버튼을 누른 사람이 이미 아는 것이고, 실질만이 버튼 곁의 ahead/behind 계기와 함께 읽힌다.
 * 서버가 수를 세지 못한 경우(count === null)는 0으로 단정하지 않고 중립 문면으로 물러난다.
 */
function verbCountText(raw: unknown, verb: "pull" | "push", t: T): string {
  const count = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (count === null) return t(verb === "pull" ? "repository.verb.pulledResult" : "repository.verb.pushedResult");
  if (count === 0) return t("repository.verb.upToDate");
  const one = verb === "pull" ? "repository.verb.pulledCount_one" : "repository.verb.pushedCount_one";
  const other = verb === "pull" ? "repository.verb.pulledCount_other" : "repository.verb.pushedCount_other";
  return t(count === 1 ? one : other, { count });
}

/**
 * 툴바 동사 버튼 — 동기화 버튼과 같은 부품으로 조립한다: 진행 중 회전, 성공 시 ✓ 체류,
 * 결과 말풍선, 실패 점. 결과 표면이 버튼 안에 있으므로 어떤 답도 패널 본문을 밀어내지 않는다.
 */
function VerbToolbarButton({ glyph, label, title, count, disabled, busy, outcome, settled, hinting, failedTitle, onClick }: {
  readonly glyph: string;
  readonly label: string;
  readonly title: string;
  readonly count: ReactNode;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly outcome: { readonly kind: "success" | "error"; readonly text: string } | null;
  readonly settled: boolean;
  readonly hinting: boolean;
  readonly failedTitle: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className={`repository-sync-button repository-verb-button${busy ? " is-syncing" : ""}`} title={title} disabled={disabled} onClick={onClick}>
      <span className={`repository-sync-icon${settled ? " is-settled" : ""}`} aria-hidden="true">
        <span className="repository-sync-glyph repository-sync-glyph-idle">{glyph}</span>
        <span className="repository-sync-glyph repository-sync-glyph-settled">✓</span>
      </span>
      {label}
      {count}
      {outcome?.kind === "error" && <span className="repository-sync-dot" title={failedTitle} aria-hidden="true" />}
      {outcome && <span className={`repository-sync-hint${outcome.kind === "error" ? " is-error" : ""}${hinting ? " is-open" : ""}`} aria-hidden="true">{outcome.text}</span>}
    </button>
  );
}

function mapSharedVerbError(code: string, t: T): string | null {
  switch (code) {
    case "auth_failed": return t("repository.verb.failedAuth");
    case "network": return t("repository.verb.failedNetwork");
    case "timeout": return t("repository.verb.failedTimeout");
    case "no_remote": return t("repository.verb.failedNoRemote");
    case "detached_head": return t("repository.verb.failedDetachedHead");
    case "index_locked": return t("repository.guard.indexLocked");
    case "stash_conflict": return t("repository.verb.failedStashConflict");
    default: return null;
  }
}

export interface CheckoutTab {
  readonly relPath: string;
  readonly label: string;
  readonly worktree: boolean;
}

/**
 * Fork의 상단 레포 탭 — 루트 체크아웃과 워크트리들이 한 줄에 선다.
 * 중첩 저장소는 트리에서 고르되, 선택 중이면 자기 탭이 임시로 나타난다.
 */
function buildCheckoutTabs(repos: readonly RepoCandidate[], worktrees: readonly WorktreeCandidate[], selectedRel: string): readonly CheckoutTab[] {
  const tabs: CheckoutTab[] = [];
  const seen = new Set<string>();
  const push = (relPath: string, label: string, worktree: boolean) => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    tabs.push({ relPath, label, worktree });
  };
  const root = repos.find((repo) => repo.kind === "root");
  if (root) push(root.relPath, root.name, false);
  for (const worktree of worktrees) push(worktree.relPath, worktree.name, true);
  if (!seen.has(selectedRel)) {
    const selected = repos.find((repo) => repo.relPath === selectedRel);
    if (selected) push(selected.relPath, selected.name, false);
  }
  return tabs;
}

function RepositoryPanel({ ctx }: RepositoryPanelProps) {
  return <RepositoryPanelBody key={ctx.theaterId} ctx={ctx} />;
}

export type Source = "changes" | "history";
type RefSource = "branches" | "tags" | "stashes";
type SourceIconKind = Source | RefSource | "repositories" | "worktrees";
export type RepositoryRefItem = { label: string; ref: string; current: boolean };
export type RepositoryStash = { name: string; subject: string; readonly sha?: string };
export type RepositoryRefs = { branches: RepositoryRefItem[]; remotes: RepositoryRefItem[]; tags: RepositoryRefItem[]; stashes: RepositoryStash[]; readonly defaultBase?: string };
export type RepositoryRefRow = { key: string; source: RefSource; primary: string; sub?: string; ref: string | null; current: boolean; readonly stashSha?: string };
export type RepositoryRefGroup = { label?: "LOCAL" | "REMOTES"; rows: RepositoryRefRow[] };
type Refs = RepositoryRefs;
type RefContextMenuState = { readonly row: RepositoryRefRow; readonly anchor: { readonly x: number; readonly y: number } };

// 사용자 제스처 선택의 착지 결정 — 컨텍스트 전환 여부와 무관하게 History로 착지한다(refs 선택과 동일 문법).
export function resolveRepositorySelection(theaterId: string | null, currentRel: string, nextRel: string): { readonly transition: boolean; readonly landing: Source } {
  if (!theaterId || nextRel === currentRel) return { transition: false, landing: "history" };
  return { transition: true, landing: "history" };
}

export function isRemoteHeadRef(ref: string): boolean {
  return /^refs\/remotes\/[^/]+\/HEAD$/.test(ref);
}

export function buildRefListGroups(source: RefSource, refs: RepositoryRefs): RepositoryRefGroup[] {
  const refRows = (items: readonly RepositoryRefItem[], rowSource: "branches" | "tags"): RepositoryRefRow[] => items.map((item) => ({ key: item.ref, source: rowSource, primary: item.label, ref: item.ref, current: item.current }));
  if (source === "branches") {
    return [
      { label: "LOCAL", rows: refRows(refs.branches, "branches") },
      { label: "REMOTES", rows: refRows(refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)), "branches") },
    ];
  }
  if (source === "tags") return [{ rows: refRows(refs.tags, "tags") }];
  return [{ rows: refs.stashes.map((item) => ({ key: item.name, source, primary: item.subject || item.name, sub: item.name, ref: null, current: false, ...(item.sha ? { stashSha: item.sha } : {}) })) }];
}
function RepositoryPanelBody({ ctx }: RepositoryPanelProps) {
  const t = getT(ctx.language);
  const [repos, setRepos] = useState<readonly RepoCandidate[]>([]);
  const [reposError, setReposError] = useState(false);
  const [reposRetry, setReposRetry] = useState(0);
  const [reposTruncated, setReposTruncated] = useState(false);
  const [scanDepth, setScanDepthState] = useState(readScanDepth);
  // 깊이 변경은 컨텍스트 전환이 아니다 — 선택된 저장소와 하위 상태는 그대로 두고 목록만 다시 받는다.
  const setScanDepth = useCallback((next: number) => { setScanDepthState(next); saveScanDepth(next); }, []);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [worktrees, setWorktrees] = useState<readonly WorktreeCandidate[]>([]);
  const [worktreesError, setWorktreesError] = useState(false);
  const [worktreesRetry, setWorktreesRetry] = useState(0);
  const [worktreesForRepoRel, setWorktreesForRepoRel] = useState<string | null>(null);
  const [repoRel, setRepoRel] = useState(() => ctx.theaterId ? readStoredRepositoryRel(ctx.theaterId) : "");
  const [initialRepoViewState] = useState(() => ctx.theaterId ? readRepoViewState(ctx.theaterId, repoRel) : null);
  const repoRelRef = useRef(repoRel);
  const [source, setSourceState] = useState<Source>(readRepositorySource);
  const [treeWidth, setTreeWidth] = useState(readWorkspaceTreeWidth);
  const treeWidthRef = useRef(treeWidth);
  const [isTreeDragging, setIsTreeDragging] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [refFilter, setRefFilter] = useState<string | null>(initialRepoViewState?.refFilter ?? null);
  const [refs, setRefs] = useState<Refs>({ branches: [], remotes: [], tags: [], stashes: [] });
  const [refsError, setRefsError] = useState(false); const [refsRetry, setRefsRetry] = useState(0);
  const [changedFiles, setChangedFiles] = useState<ChangedFilesState>({ kind: "loading" });
  const [changedFilesRetry, setChangedFilesRetry] = useState(0);
  // 로컬 상태 새로 읽기가 오를 때마다 함께 오른다 — 스테이징 뷰는 자기 상태를 따로 읽으므로
  // 이 토큰이 없으면 트리 수치만 갱신되고 목록·파괴적 동사는 낡은 채로 남는다.
  const [stateReloadToken, setStateReloadToken] = useState(0);
  const [workstate, setWorkstate] = useState<WorkstateResult | null>(null);
  const [workstateRetry, setWorkstateRetry] = useState(0);
  const [workstateFailed, setWorkstateFailed] = useState(false);
  type VerbKind = "pull" | "push" | "stash";
  // 잠금은 행 동작도 함께 진다(같은 저장소를 쓴다) — 그러나 회전은 그 일을 시킨 표면에서만 돈다.
  // 행 메뉴에서 고른 삭제가 툴바 Stash 버튼을 돌리면, 결과와 마찬가지로 진행 상태까지 오귀속된다.
  const [verbBusy, setVerbBusy] = useState<{ readonly verb: VerbKind; readonly surface: "button" | "notice" } | null>(null);
  // 동사의 결과는 흐름 안의 배너가 아니라 그 동사의 버튼 자리에서 답한다 — 동기화가 "이미 최신 상태"를
  // 답하는 문법과 같다. 성공은 아이콘이 잠깐 ✓로 바뀌고(settled) 말풍선이 실질(받은·보낸 커밋 수)을 짧게
  // 이른 뒤 물러나며, 실패는 같은 말풍선이 더 오래 머문 뒤 coral 점만 남겨 다음 시도까지 hover·포커스로
  // 다시 열린다. 절대 위치라 어느 결과도 패널 본문을 밀어내지 않는다.
  type VerbOutcome = { readonly verb: VerbKind; readonly kind: "success" | "error"; readonly text: string };
  const [verbOutcome, setVerbOutcome] = useState<VerbOutcome | null>(null);
  const [verbSettled, setVerbSettled] = useState(false);
  const [verbHinting, setVerbHinting] = useState(false);
  const verbSettledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verbHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 스태시 행 동작(적용·적용 후 제거·삭제)은 툴바 동사가 아니다. 그 답을 툴바 Stash 버튼에 얹으면
  // "작업 중 변경 전체를 스태시" 버튼에 ✓와 실패 점이 붙어, 행 메뉴에서 고른 동작의 결과가 누르지도
  // 않은 명령에 귀속된다. 행 동작은 자기 행이 곧 사라질 수 있어 행 자리에도 답할 수 없으므로,
  // 이 개편 이전과 같이 패널 알림으로 답한다 — 버튼 문법은 툴바 동사만의 것이다.
  const [rowNotice, setRowNotice] = useState<{ readonly kind: "success" | "error"; readonly text: string } | null>(null);
  const rowNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeLockedRef = useRef(false);
  // 쓰기 울타리 문면은 렌더 아래쪽에서 정해지지만 verb 핸들러는 그 위에서 닫힌다 — ref로 건넨다.
  const writeGuardRef = useRef<string | null>(null);
  const [historyExternalRefreshToken, setHistoryExternalRefreshToken] = useState(0);
  const [compareRequest, setCompareRequest] = useState<{ base: string; head: string; baseLabel: string; headLabel: string; seq: number } | null>(null);
  const [inspectRequest, setInspectRequest] = useState<{ fullHash: string; seq: number } | null>(null);
  const [stashRequest, setStashRequest] = useState<{ name: string; sha: string; subject: string; seq: number } | null>(null);
  type SyncNotice =
    | { kind: "error"; code: "auth_failed" | "network" | "timeout" | "no_remote" | "git_failed" }
    | { kind: "success"; newRefs: number; updatedRefs: number; pruned: number };
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const syncNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "이미 최신 상태"는 가져온 것이 없는 결과라 배너로 표면화하면 흐름 안의 블록이 패널 본문을
  // 밀어낸다(등장·소멸 각 1회). 정보량 없는 결과는 버튼 자리에서만 답한다 — 아이콘이 잠깐 ✓로
  // 바뀌고(settled), 말풍선이 짧게 안내한 뒤(hinting) 스스로 물러나며, 문면은 다음 동기화까지
  // hover로 다시 열 수 있다(hintAvailable). 갱신·실패는 계속 배너를 쓴다.
  const [syncSettled, setSyncSettled] = useState(false);
  const [syncHinting, setSyncHinting] = useState(false);
  const [syncHintAvailable, setSyncHintAvailable] = useState(false);
  const syncSettledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncRequestIdRef = useRef(0);
  const autoSyncTheaterRef = useRef<string | null>(null);
  const [filterText, setFilterText] = useState(initialRepoViewState?.filterText ?? "");
  const [collapsedChangeFolders, setCollapsedChangeFolders] = useState(() => new Set(initialRepoViewState?.collapsedFolders ?? []));
  const repoViewCacheKey = `${ctx.theaterId ?? ""}\x00${repoRel}`;
  const [hydratedRepoViewCacheKey, setHydratedRepoViewCacheKey] = useState(repoViewCacheKey);
  const freshRefFilterCacheKeyRef = useRef<string | null>(null);
  const restoredChangesScrollTopRef = useRef<number | null>(initialRepoViewState?.scrollTop ?? null);
  const changesScrollTopRef = useRef(initialRepoViewState?.scrollTop ?? 0);
  const changesCacheFrameRef = useRef<number | null>(null);
  // 동일 컨텍스트 재착지는 repoRel key가 안 바뀌어 History 패널이 리마운트되지 않는다 —
  // epoch를 key에 섞어 전환 착지와 동일한 초기 상태(로컬 필터·선택·스크롤)로 재설정한다.
  const [historyLandingEpoch, setHistoryLandingEpoch] = useState(0);
  const searchTarget = useRepositorySearchTarget();
  const setSource = useCallback((next: Source) => {
    setSourceState(next);
    saveRepositorySource(next);
  }, []);
  const handleTreeDividerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = layoutRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const startWidth = treeWidthRef.current;
    setIsTreeDragging(true);
    const onMove = (move: PointerEvent) => {
      const next = clampWorkspaceTreeWidth(startWidth, move.clientX - startX, containerWidth);
      if (next !== null) {
        treeWidthRef.current = next;
        setTreeWidth(next);
      }
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsTreeDragging(false);
      saveWorkspaceTreeWidth(treeWidthRef.current);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);
  const repoViewSnapshotRef = useRef({ theaterId: ctx.theaterId, repoRel, repoViewCacheKey, hydratedRepoViewCacheKey, filterText, refFilter, collapsedChangeFolders });
  repoViewSnapshotRef.current = { theaterId: ctx.theaterId, repoRel, repoViewCacheKey, hydratedRepoViewCacheKey, filterText, refFilter, collapsedChangeFolders };
  const flushChangesCache = useCallback(() => {
    const snapshot = repoViewSnapshotRef.current;
    if (!snapshot.theaterId || snapshot.hydratedRepoViewCacheKey !== snapshot.repoViewCacheKey) return;
    writeRepoViewState(snapshot.theaterId, snapshot.repoRel, {
      filterText: snapshot.filterText,
      refFilter: snapshot.refFilter,
      scrollTop: changesScrollTopRef.current,
      collapsedFolders: [...snapshot.collapsedChangeFolders],
    });
  }, []);
  const scheduleChangesCacheWrite = useCallback(() => {
    if (changesCacheFrameRef.current !== null) return;
    changesCacheFrameRef.current = requestAnimationFrame(() => {
      changesCacheFrameRef.current = null;
      flushChangesCache();
    });
  }, [flushChangesCache]);
  const transitionRepository = useCallback((nextRepoRel: string, persist: boolean, landing: Source = "changes") => {
    if (!ctx.theaterId) return;
    // rAF로 미뤄둔 이전 스코프의 캐시 write가 있다면 스코프가 바뀌기 전에 동기로 flush한다 —
    // 전환 후 발화하면 snapshot이 새 스코프로 바뀌어 이전 스코프의 마지막 스크롤/필터가 소실된다.
    if (changesCacheFrameRef.current !== null) {
      cancelAnimationFrame(changesCacheFrameRef.current);
      changesCacheFrameRef.current = null;
    }
    flushChangesCache();
    if (persist) saveRepositoryRel(ctx.theaterId, nextRepoRel);
    clearSelectedFile();
    syncRequestIdRef.current += 1;
    setSyncing(false);
    // sync 결과 상태는 패널 스코프라 저장소 전환 시 명시 리셋해야 이전 저장소의 실패 점/토스트가 새 컨텍스트에 남지 않는다.
    if (syncNoticeTimerRef.current !== null) {
      clearTimeout(syncNoticeTimerRef.current);
      syncNoticeTimerRef.current = null;
    }
    if (syncSettledTimerRef.current !== null) {
      clearTimeout(syncSettledTimerRef.current);
      syncSettledTimerRef.current = null;
    }
    if (syncHintTimerRef.current !== null) {
      clearTimeout(syncHintTimerRef.current);
      syncHintTimerRef.current = null;
    }
    setSyncNotice(null);
    setSyncFailed(false);
    setSyncSettled(false);
    setSyncHinting(false);
    setSyncHintAvailable(false);
    for (const timer of [verbSettledTimerRef, verbHintTimerRef, rowNoticeTimerRef]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
    setVerbOutcome(null);
    setVerbSettled(false);
    setVerbHinting(false);
    setRowNotice(null);
    setWorkstate(null);
    setChangedFiles({ kind: "loading" });
    setCompareRequest(null);
    setInspectRequest(null);
    // stashRequest도 같은 one-shot이다 — 남겨 두면 리마운트된 패널이 seq 0에서 옛 요청을 재생해
    // 다른 체크아웃 위에 낡은 스태시 카드를 세운다.
    setStashRequest(null);
    setRefs({ branches: [], remotes: [], tags: [], stashes: [] });
    repoRelRef.current = nextRepoRel;
    setRepoRel(nextRepoRel);
    setSource(landing);
  }, [ctx.theaterId, flushChangesCache, setSource]);
  useEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== ctx.theaterId) return;
    setRefFilter(null);
    if (repoRelRef.current !== searchTarget.repoRel) {
      freshRefFilterCacheKeyRef.current = `${searchTarget.theaterId}\x00${searchTarget.repoRel}`;
      transitionRepository(searchTarget.repoRel, true, "history");
      return;
    }
    setSource("history");
  }, [ctx.theaterId, searchTarget, setSource, transitionRepository]);
  useLayoutEffect(() => {
    if (hydratedRepoViewCacheKey === repoViewCacheKey) return;
    const cached = ctx.theaterId ? readRepoViewState(ctx.theaterId, repoRel) : null;
    const freshRefLanding = freshRefFilterCacheKeyRef.current === repoViewCacheKey;
    setFilterText(cached?.filterText ?? "");
    setRefFilter(freshRefLanding ? null : cached?.refFilter ?? null);
    setCollapsedChangeFolders(new Set(cached?.collapsedFolders ?? []));
    const restoredScrollTop = cached?.scrollTop ?? 0;
    restoredChangesScrollTopRef.current = restoredScrollTop;
    changesScrollTopRef.current = restoredScrollTop;
    setHydratedRepoViewCacheKey(repoViewCacheKey);
    if (freshRefLanding) freshRefFilterCacheKeyRef.current = null;
  }, [ctx.theaterId, hydratedRepoViewCacheKey, repoRel, repoViewCacheKey]);
  useEffect(() => {
    if (!ctx.theaterId) return;
    let cancelled = false;
    setReposError(false);
    setReposLoaded(false);
    ctx.api.fetch("repository", "repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, maxDepth: scanDepth }) })
      .then((response) => response.json() as Promise<ReposResult>)
      .then((value) => { if (!cancelled) { setRepos(value.repos); setReposTruncated(value.truncated === true); setReposLoaded(true); } })
      .catch(() => { if (!cancelled) setReposError(true); });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, reposRetry, scanDepth]);
  useEffect(() => {
    if (!ctx.theaterId) return;
    let cancelled = false;
    const requestedRepoRel = repoRel;
    setWorktrees([]);
    setWorktreesError(false);
    setWorktreesForRepoRel(null);
    ctx.api.fetch("repository", "worktrees", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel: requestedRepoRel }) })
      .then((response) => response.json() as Promise<WorktreesResult>)
      .then((value) => {
        if (!cancelled) {
          setWorktrees(value.worktrees);
          setWorktreesForRepoRel(requestedRepoRel);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const status = typeof error === "object" && error !== null && "status" in error ? (error as { readonly status?: unknown }).status : null;
        if (status === 400 && requestedRepoRel !== "") {
          clearRepositoryRel(ctx.theaterId!);
          transitionRepository("", false);
          return;
        }
        setWorktreesError(true);
      });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, repoRel, transitionRepository, worktreesRetry]);
  useEffect(() => {
    if (!ctx.theaterId || !reposLoaded || worktreesForRepoRel !== repoRel) return;
    const restoredRepoRel = readRepositoryRel(ctx.theaterId, repos, worktrees);
    if (restoredRepoRel !== repoRelRef.current) transitionRepository(restoredRepoRel, false);
  }, [ctx.theaterId, repoRel, repos, reposLoaded, transitionRepository, worktrees, worktreesForRepoRel]);
  useEffect(() => { if (!ctx.theaterId) return; let cancelled = false; setRefs({ branches: [], remotes: [], tags: [], stashes: [] }); setRefsError(false); ctx.api.fetch("repository", "refs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }) }).then((r) => r.ok ? r.json() as Promise<Refs> : Promise.reject()).then((value) => { if (!cancelled) setRefs(value); }).catch(() => { if (!cancelled) setRefsError(true); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, repoRel, refsRetry]);
  useEffect(() => {
    if (!ctx.theaterId) {
      setChangedFiles({ kind: "error", message: "no_theater" });
      return;
    }
    let cancelled = false;
    setChangedFiles({ kind: "loading" });
    // api.fetch(assertSafeResponse)는 non-2xx에서 payload를 버리고 throw하므로,
    // no_git_repo/git_unavailable 안내 매핑을 위해 원래의 raw fetch 경로를 유지한다
    fetch("/plugins/repository/changed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }) }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json() as { readonly error?: string };
        const code = payload.error ?? "git_failed";
        if (!cancelled) setChangedFiles(code === "no_git_repo" || code === "git_unavailable" ? { kind: "notice", reason: code } : { kind: "error", message: code });
        return;
      }
      const data = await response.json() as DiffListResult;
      // 서버는 상한에 걸린 목록에 truncated를 실어 보낸다. 이 값을 버리면 잘린 목록이 전체로 보이고,
      // "모두 스테이지"가 보이지 않는 나머지를 건드리지 않는다는 사실이 화면에서 사라진다.
      if (!cancelled) setChangedFiles({ kind: "ok", files: data.files, ...(data.truncated ? { truncated: true } : {}) });
    }).catch((error: unknown) => {
      if (!cancelled) setChangedFiles({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [changedFilesRetry, ctx.theaterId, repoRel]);

  useEffect(() => {
    if (!ctx.theaterId) { setWorkstate(null); return; }
    let cancelled = false;
    ctx.api.fetch("repository", "workstate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel }) })
      .then((response) => response.ok ? response.json() as Promise<WorkstateResult> : Promise.reject(new Error("workstate_failed")))
      .then((value) => { if (!cancelled) { setWorkstate(value); setWorkstateFailed(false); } })
      // 실패를 null로 접으면 병합·리베이스·index lock 경고와 ahead/behind가 함께 사라지고 쓰기 verb가
      // 깨끗한 저장소처럼 켜진다. 마지막으로 읽은 값은 남기고, 모른다는 사실만 따로 든다.
      .catch(() => { if (!cancelled) setWorkstateFailed(true); });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, repoRel, workstateRetry]);
  const refreshRepositoryData = useCallback(() => {
    setStateReloadToken((value) => value + 1);
    setRefsRetry((value) => value + 1);
    setWorktreesRetry((value) => value + 1);
    setChangedFilesRetry((value) => value + 1);
    setReposRetry((value) => value + 1);
    setWorkstateRetry((value) => value + 1);
    setHistoryExternalRefreshToken((value) => value + 1);
  }, []);
  // 스테이징 뷰의 변이는 목록·울타리를 새로 읽는다 — repos 재스캔은 불필요하고,
  // 기록·refs 재적재는 커밋처럼 기록 축이 실제로 움직인 변이에만 지불한다.
  const handleWorkspaceMutated = useCallback((options: { readonly history: boolean; readonly localState?: boolean }) => {
    setChangedFilesRetry((value) => value + 1);
    setWorkstateRetry((value) => value + 1);
    // 스테이징 밖에서 워킹트리를 바꾼 동사(스태시·pull)는 스테이징 목록 재조회까지 지불해야 한다 —
    // 카운트만 갱신되고 목록이 낡은 채 남는 불일치(M2)가 이 갈림에서 태어났다.
    if (options.localState) setStateReloadToken((value) => value + 1);
    if (options.history) {
      setRefsRetry((value) => value + 1);
      setHistoryExternalRefreshToken((value) => value + 1);
    }
  }, []);
  // 한 시도의 답은 ✓ 체류와 말풍선 두 표면에 나뉘어 앉는다. 새 시도가 둘을 함께 걷지 않으면 앞 시도의
  // 말풍선이 자기 시간을 사는 동안 뒤 시도의 ✓가 겹쳐, 실패 문면과 성공 표식이 동시에 뜬다.
  const clearVerbSurfacing = useCallback(() => {
    for (const timer of [verbSettledTimerRef, verbHintTimerRef]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
    setVerbOutcome(null);
    setVerbSettled(false);
    setVerbHinting(false);
  }, []);
  const showRowNotice = useCallback((notice: { readonly kind: "success" | "error"; readonly text: string }) => {
    if (rowNoticeTimerRef.current !== null) clearTimeout(rowNoticeTimerRef.current);
    setRowNotice(notice);
    rowNoticeTimerRef.current = setTimeout(() => {
      rowNoticeTimerRef.current = null;
      setRowNotice(null);
    }, 6000);
  }, []);
  const showVerbOutcome = useCallback((outcome: VerbOutcome) => {
    for (const timer of [verbSettledTimerRef, verbHintTimerRef]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
    setVerbOutcome(outcome);
    setVerbSettled(outcome.kind === "success");
    setVerbHinting(true);
    if (outcome.kind === "success") {
      verbSettledTimerRef.current = setTimeout(() => {
        verbSettledTimerRef.current = null;
        setVerbSettled(false);
      }, SYNC_SETTLED_MS);
    }
    verbHintTimerRef.current = setTimeout(() => {
      verbHintTimerRef.current = null;
      setVerbHinting(false);
    }, outcome.kind === "error" ? VERB_ERROR_HINT_MS : SYNC_HINT_MS);
  }, []);
  const runToolbarVerb = useCallback(async (verb: VerbKind, route: string, body: Record<string, unknown>, successText: (payload: Record<string, unknown>) => string, mapError: (code: string) => string | null, surface: "button" | "notice" = "button"): Promise<boolean> => {
    if (!ctx.theaterId || verbBusy) return false;
    const emit = (kind: "success" | "error", text: string) => {
      if (surface === "notice") showRowNotice({ kind, text });
      else showVerbOutcome({ verb, kind, text });
    };
    // 새 시도는 지난 결과의 표면을 먼저 걷는다 — 앞 결과가 남은 채 다음 요청이 돌면 어느 시도의 답인지 읽을 수 없다.
    if (surface === "button") clearVerbSurfacing();
    setVerbBusy({ verb, surface });
    try {
      const response = await fetch(`/plugins/repository/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ...body }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const code = typeof payload.error === "string" ? payload.error : "git_failed";
        emit("error", mapError(code) ?? mapSharedVerbError(code, t) ?? code);
        return false;
      }
      emit("success", successText(payload));
      // 성공한 원격·스태시 동사만 전역 갱신을 지불한다 — 실패는 저장소를 바꾸지 않았다.
      handleWorkspaceMutated({ history: true, localState: true });
      return true;
    } catch {
      emit("error", t("repository.verb.failedNetwork"));
      return false;
    } finally {
      setVerbBusy(null);
    }
  }, [clearVerbSurfacing, ctx.theaterId, handleWorkspaceMutated, repoRel, showRowNotice, showVerbOutcome, t, verbBusy]);
  const handlePull = useCallback(() => {
    void runToolbarVerb("pull", "pull", {}, (payload) => verbCountText(payload.received, "pull", t), (code) =>
      code === "non_fast_forward" ? t("repository.verb.failedPullDiverged")
      : code === "dirty_worktree" ? t("repository.verb.failedDirtyWorktree")
      : code === "no_upstream" ? t("repository.verb.failedNoUpstream")
      : null);
  }, [runToolbarVerb, t]);
  const handlePush = useCallback(() => {
    void runToolbarVerb("push", "push", {}, (payload) => verbCountText(payload.sent, "push", t), (code) =>
      code === "non_fast_forward" ? t("repository.verb.failedNonFastForward") : null);
  }, [runToolbarVerb, t]);
  const [stashPromptOpen, setStashPromptOpen] = useState(false);
  const stashButtonHostRef = useRef<HTMLSpanElement | null>(null);
  const handleStash = useCallback(() => {
    setStashPromptOpen((current) => !current);
  }, []);
  const handleStashSave = useCallback((message: string) => {
    setStashPromptOpen(false);
    const trimmed = message.trim();
    void runToolbarVerb("stash", "stash", { action: "save", ...(trimmed ? { message: trimmed } : {}) }, () => t("repository.verb.stashedResult"), (code) =>
      code === "nothing_to_stash" ? t("repository.verb.failedNothingToStash") : null);
  }, [runToolbarVerb, t]);
  const handleStashRowAction = useCallback(async (action: "apply" | "pop" | "drop", name: string, sha: string): Promise<boolean> => {
    // 스태시 동사도 툴바·스테이징과 같은 울타리를 진다 — 잠금 중 우회로가 되면 안 된다.
    if (writeLockedRef.current) {
      showRowNotice({ kind: "error", text: writeGuardRef.current ?? t("repository.guard.indexLocked") });
      return false;
    }
    return runToolbarVerb("stash", "stash", { action, name, sha }, () =>
      t(action === "apply" ? "repository.stash.applied" : action === "pop" ? "repository.stash.popped" : "repository.stash.dropped"), (code) =>
      code === "stash_moved" ? t("repository.stash.moved") : null, "notice");
  }, [runToolbarVerb, showRowNotice, t]);
  const showSyncNotice = useCallback((notice: SyncNotice) => {
    if (syncNoticeTimerRef.current !== null) clearTimeout(syncNoticeTimerRef.current);
    setSyncNotice(notice);
    syncNoticeTimerRef.current = setTimeout(() => {
      syncNoticeTimerRef.current = null;
      setSyncNotice(null);
    }, 6000);
  }, []);
  const showSyncSettled = useCallback(() => {
    if (syncSettledTimerRef.current !== null) clearTimeout(syncSettledTimerRef.current);
    if (syncHintTimerRef.current !== null) clearTimeout(syncHintTimerRef.current);
    setSyncSettled(true);
    setSyncHinting(true);
    setSyncHintAvailable(true);
    syncSettledTimerRef.current = setTimeout(() => {
      syncSettledTimerRef.current = null;
      setSyncSettled(false);
    }, SYNC_SETTLED_MS);
    syncHintTimerRef.current = setTimeout(() => {
      syncHintTimerRef.current = null;
      setSyncHinting(false);
    }, SYNC_HINT_MS);
  }, []);
  // 한 시도의 답은 배너·✓·말풍선 세 표면에 나뉘어 앉는다. 새 시도를 시작할 때 셋을 함께 걷지 않으면
  // 앞 시도의 배너가 자기 6초를 사는 동안 뒤 시도의 ✓가 겹쳐, 실패 배너와 "이미 최신 상태"가 동시에 뜬다.
  // 수동 동기화에는 throttle이 없어 두 번 누르는 것으로 재현된다. 지속 실패 점은 시도별 알림이 아니라
  // "마지막 결과" 표식이라 여기서 걷지 않고 성공 시에만 해제한다.
  const clearSyncSurfacing = useCallback(() => {
    for (const timer of [syncNoticeTimerRef, syncSettledTimerRef, syncHintTimerRef]) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    }
    setSyncNotice(null);
    setSyncSettled(false);
    setSyncHinting(false);
    setSyncHintAvailable(false);
  }, []);
  useEffect(() => () => {
    if (syncNoticeTimerRef.current !== null) clearTimeout(syncNoticeTimerRef.current);
    if (syncSettledTimerRef.current !== null) clearTimeout(syncSettledTimerRef.current);
    if (syncHintTimerRef.current !== null) clearTimeout(syncHintTimerRef.current);
    if (verbSettledTimerRef.current !== null) clearTimeout(verbSettledTimerRef.current);
    if (verbHintTimerRef.current !== null) clearTimeout(verbHintTimerRef.current);
    if (rowNoticeTimerRef.current !== null) clearTimeout(rowNoticeTimerRef.current);
  }, []);
  const syncRepository = useCallback(async (mode?: "auto") => {
    if (!ctx.theaterId) return;
    const isManual = mode !== "auto";
    const requestId = ++syncRequestIdRef.current;
    // 새 시도는 지난 결과의 표면을 먼저 걷는다 — 앞 결과가 남은 채 다음 요청이 돌면 어느 시도의 결과인지 읽을 수 없다.
    if (isManual) clearSyncSurfacing();
    setSyncing(true);
    let response: Response;
    try {
      response = await fetch("/plugins/repository/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ...(mode ? { mode } : {}) }),
      });
    } catch {
      if (requestId !== syncRequestIdRef.current) return;
      setSyncing(false);
      if (isManual) {
        showSyncNotice({ kind: "error", code: "network" });
        setSyncFailed(true);
      }
      return;
    }
    const payload = await response.json().catch(() => ({})) as RepositoryFetchResult | { readonly error?: string };
    if (requestId !== syncRequestIdRef.current) return;
    setSyncing(false);
    if (!response.ok || !("ok" in payload) || payload.ok !== true) {
      const raw = "error" in payload ? payload.error : undefined;
      const code = raw === "auth_failed" || raw === "network" || raw === "timeout" || raw === "no_remote" ? raw : "git_failed";
      if (isManual) {
        showSyncNotice({ kind: "error", code });
        setSyncFailed(true);
      }
      return;
    }
    if ("skipped" in payload) return;
    setSyncFailed(false);
    if (isManual) {
      const newRefs = "newRefs" in payload ? payload.newRefs : 0;
      const updatedRefs = "updatedRefs" in payload ? payload.updatedRefs : 0;
      const pruned = "pruned" in payload ? payload.pruned : 0;
      if (newRefs === 0 && updatedRefs === 0 && pruned === 0) showSyncSettled();
      else showSyncNotice({ kind: "success", newRefs, updatedRefs, pruned });
    }
    refreshRepositoryData();
  }, [clearSyncSurfacing, ctx.theaterId, refreshRepositoryData, repoRel, showSyncNotice, showSyncSettled]);
  useEffect(() => {
    if (!ctx.theaterId) return;
    const contextKey = `${ctx.theaterId}:${repoRel}`;
    if (autoSyncTheaterRef.current === contextKey) return;
    autoSyncTheaterRef.current = contextKey;
    void syncRepository("auto");
  }, [ctx.theaterId, repoRel, syncRepository]);

  useLayoutEffect(() => () => clearSelectedFile(), []);

  useEffect(() => {
    scheduleChangesCacheWrite();
  }, [collapsedChangeFolders, filterText, hydratedRepoViewCacheKey, refFilter, repoRel, scheduleChangesCacheWrite]);
  useEffect(() => () => {
    if (changesCacheFrameRef.current !== null) {
      cancelAnimationFrame(changesCacheFrameRef.current);
      changesCacheFrameRef.current = null;
    }
    flushChangesCache();
  }, [flushChangesCache]);

  const handleSelectRepository = useCallback((next: { readonly relPath: string }) => {
    const decision = resolveRepositorySelection(ctx.theaterId, repoRel, next.relPath);
    // 동일 컨텍스트 재선택도 "이 체크아웃의 History" 착지다 — refFilter를 걷어내고 History 패널을
    // epoch 리마운트해 전환 착지와 동일한 초기 상태로 만든다(스코프된 로그·WIP 숨김 잔존 방지).
    if (!decision.transition) {
      dropHistoryCacheForRepository(`${ctx.theaterId ?? ""}:${next.relPath}`);
      if (ctx.theaterId) {
        dropRepoViewState(ctx.theaterId, next.relPath);
        setHydratedRepoViewCacheKey("");
      }
      setRefFilter(null);
      // epoch 리마운트는 handled-seq ref를 초기화하므로, 잔존 one-shot 요청을 함께 비워야 착지가 재생 없이 깨끗하다.
      setCompareRequest(null);
      setInspectRequest(null);
      setStashRequest(null);
      setHistoryLandingEpoch((value) => value + 1);
      setSource(decision.landing);
      return;
    }
    transitionRepository(next.relPath, true, decision.landing);
  }, [ctx.theaterId, repoRel, setSource, transitionRepository]);
  const openCompare = useCallback((base: string, head: string) => {
    setSource("history");
    setCompareRequest((prev) => ({
      base,
      head,
      baseLabel: shortRefName(base),
      headLabel: shortRefName(head),
      seq: (prev?.seq ?? 0) + 1,
    }));
  }, [setSource]);
  const openStashInspect = useCallback((stashRow: { readonly name: string; readonly sha: string; readonly subject: string }) => {
    setSource("history");
    setStashRequest((prev) => ({ ...stashRow, seq: (prev?.seq ?? 0) + 1 }));
  }, [setSource]);

  const wipFiles = changedFiles.kind === "ok" ? changedFiles.files : [];
  const selectedRepo = repos.find((repo) => repo.relPath === repoRel) ?? worktrees.find((worktree) => worktree.relPath === repoRel);
  const checkoutTabs = buildCheckoutTabs(repos, worktrees, repoRel);
  const writeGuardMessage = workstateFailed ? t("repository.guard.stateUnknown") : guardMessageOf(workstate, t);
  const writeLocked = writeGuardMessage !== null;
  writeLockedRef.current = writeLocked;
  writeGuardRef.current = writeGuardMessage;
  // WORKING > Changes는 Fork 문법의 스테이징 뷰다 — 목록·diff·커밋 상자를 StagingView가 소유한다.
  // 체크아웃마다 새 인스턴스를 세운다 — 키 없이 재사용하면 이전 체크아웃의 목록·커밋 초안 위에서
  // 파괴 동사가 다른 체크아웃을 때릴 수 있다.
  const changesView = <StagingView key={`${ctx.theaterId ?? ""}\u0000${repoRel}`} ctx={ctx} repoRel={repoRel} workstate={workstate} stateUnknown={workstateFailed} reloadToken={stateReloadToken} onMutated={handleWorkspaceMutated} />;
  const syncNoticeMessage = syncNotice == null ? null
    : syncNotice.kind === "error"
      ? t(syncNotice.code === "auth_failed" ? "repository.sync.failedAuth"
        : syncNotice.code === "network" ? "repository.sync.failedNetwork"
        : syncNotice.code === "timeout" ? "repository.sync.failedTimeout"
        : syncNotice.code === "no_remote" ? "repository.sync.failedNoRemote"
        : "repository.sync.failedGit")
      : t("repository.sync.summary", { newRefs: syncNotice.newRefs, updatedRefs: syncNotice.updatedRefs, pruned: syncNotice.pruned });
  // Changes만 hidden으로 상시 마운트해 섹션 전환에도 내부 상태를 보존한다.
  const workspaceMainVisible = source === "changes";
  const workspaceMain = <div className="repository-source-fill" hidden={source !== "changes"}>{changesView}</div>;
  return (
    <div className="repository-unified is-workspace">
      <div className={`repository-identity${repoRel ? " is-subcontext" : ""}`}><RepositoryIcon /><strong>{selectedRepo?.name ?? t("repository.panel.title")}</strong>{selectedRepo?.branch && <span>{selectedRepo.branch}</span>}<button type="button" className={`repository-sync-button${syncing ? " is-syncing" : ""}`} title={t("repository.sync.title")} aria-label={t("repository.sync.title")} disabled={syncing} onClick={() => { void syncRepository(); }}><span className={`repository-sync-icon${syncSettled ? " is-settled" : ""}`} aria-hidden="true"><span className="repository-sync-glyph repository-sync-glyph-idle">↻</span><span className="repository-sync-glyph repository-sync-glyph-settled">✓</span></span>{t("repository.sync.button")}{syncFailed && <span className="repository-sync-dot" title={t("repository.sync.lastFailed")} aria-hidden="true" />}{syncHintAvailable && <span className={`repository-sync-hint${syncHinting ? " is-open" : ""}`} aria-hidden="true">{t("repository.sync.upToDate")}</span>}</button><span className="repository-verb-cluster">
        <VerbToolbarButton glyph="⇩" label={t("repository.verb.pull")} title={t("repository.verb.pullTitle")} count={workstate?.behind ? <em className="repository-verb-count" title={t("repository.verb.behindCount", { count: workstate.behind })}>{workstate.behind}↓</em> : null} disabled={verbBusy !== null || writeLocked} busy={verbBusy?.surface === "button" && verbBusy.verb === "pull"} outcome={verbOutcome?.verb === "pull" ? verbOutcome : null} settled={verbSettled && verbOutcome?.verb === "pull"} hinting={verbHinting} failedTitle={t("repository.verb.lastFailed")} onClick={handlePull} />
        <VerbToolbarButton glyph="⇧" label={t("repository.verb.push")} title={t("repository.verb.pushTitle")} count={workstate?.ahead ? <em className="repository-verb-count" title={t("repository.verb.aheadCount", { count: workstate.ahead })}>{workstate.ahead}↑</em> : null} disabled={verbBusy !== null || writeLocked} busy={verbBusy?.surface === "button" && verbBusy.verb === "push"} outcome={verbOutcome?.verb === "push" ? verbOutcome : null} settled={verbSettled && verbOutcome?.verb === "push"} hinting={verbHinting} failedTitle={t("repository.verb.lastFailed")} onClick={handlePush} />
        <span className="repository-stash-anchor" ref={stashButtonHostRef}>
          <VerbToolbarButton glyph="▤" label={t("repository.verb.stash")} title={t("repository.verb.stashTitle")} count={null} disabled={verbBusy !== null || writeLocked} busy={verbBusy?.surface === "button" && verbBusy.verb === "stash"} outcome={verbOutcome?.verb === "stash" ? verbOutcome : null} settled={verbSettled && verbOutcome?.verb === "stash"} hinting={verbHinting} failedTitle={t("repository.verb.lastFailed")} onClick={handleStash} />
          {stashPromptOpen && <StashSavePopover t={t} hostRef={stashButtonHostRef} onSave={handleStashSave} onClose={() => setStashPromptOpen(false)} />}
        </span>
      </span></div>
      <div className="repository-checkout-tabs" role="tablist" aria-label={t("repository.tabs.aria")}>
        {checkoutTabs.map((tab) => <button
          key={tab.relPath || "\u0000root"}
          type="button"
          role="tab"
          className={`repository-checkout-tab${tab.relPath === repoRel ? " is-active" : ""}`}
          aria-selected={tab.relPath === repoRel}
          title={tab.relPath || tab.label}
          onClick={() => handleSelectRepository({ relPath: tab.relPath })}
        >
          <span className="repository-checkout-tab-label">{tab.label}</span>
          {tab.worktree && <i className="repository-checkout-tab-mark" title={t("repository.tabs.worktreeMark")}>wt</i>}
        </button>)}
      </div>
      {/* 동사 결과는 말풍선이 물러난 뒤에도 hover 재개방을 위해 남아 있으므로, 한 라이브 리전을 동기화와
          나눠 쓰면 남아 있는 동사 문면이 뒤이은 동기화 결과의 낭독을 영원히 가린다 — 리전을 분리한다. */}
      <span className="repository-sr-only" role="status">{syncHinting ? t("repository.sync.upToDate") : ""}</span>
      <span className="repository-sr-only" role="status">{verbOutcome ? verbOutcome.text : ""}</span>
      {syncNotice && syncNoticeMessage ? <div className={`repository-sync-toast is-${syncNotice.kind === "error" ? "error" : "success"}`} role="status"><span>{syncNoticeMessage}</span><button type="button" aria-label={t("repository.sync.dismiss")} onClick={() => setSyncNotice(null)}>✕</button></div> : null}
      {rowNotice ? <div className={`repository-sync-toast is-${rowNotice.kind}`} role="status"><span>{rowNotice.text}</span><button type="button" aria-label={t("repository.sync.dismiss")} onClick={() => setRowNotice(null)}>✕</button></div> : null}
      <div ref={layoutRef} className={`repository-ws-layout${isTreeDragging ? " is-dragging" : ""}`} style={{ "--ws-tree-width": `${treeWidth}px` } as React.CSSProperties}>
        <WorkspaceTree theaterId={ctx.theaterId ?? ""} t={t} repos={repos} reposError={reposError} reposTruncated={reposTruncated} scanDepth={scanDepth} worktrees={worktrees} worktreesError={worktreesError} refs={refs} refsError={refsError} changedFiles={changedFiles} selectedRel={repoRel} source={source} refFilter={refFilter} onRepository={handleSelectRepository} onScanDepth={setScanDepth} onRetryRepos={() => setReposRetry((value) => value + 1)} onReloadState={refreshRepositoryData} onRetryWorktrees={() => setWorktreesRetry((value) => value + 1)} onRetryRefs={() => setRefsRetry((value) => value + 1)} onSource={setSource} onRef={(ref) => { setRefFilter(ref); setSource("history"); }} onCompare={openCompare} onStashInspect={openStashInspect} onStashAction={handleStashRowAction} />
        <div className="repository-divider repository-ws-tree-divider" onPointerDown={handleTreeDividerDown} role="separator" aria-orientation="vertical" aria-label={t("repository.common.resizeSourceTree")} />
        <HistoryPanel key={`${ctx.theaterId ?? ""}:${repoRel}:${historyLandingEpoch}`} cacheScope={`${ctx.theaterId ?? ""}:${repoRel}`} ctx={ctx} repoRel={repoRel} externalRefreshToken={historyExternalRefreshToken} active refFilter={refFilter} wipFiles={wipFiles} workspace workspaceMain={workspaceMain} workspaceMainVisible={workspaceMainVisible} compareRequest={compareRequest} inspectRequest={inspectRequest} stashRequest={stashRequest} onStashAction={handleStashRowAction} onReturnToHistory={() => setSource("history")} onClearRef={() => setRefFilter(null)} onWip={() => setSource("changes")} />
      </div>
    </div>
  );
}

interface WorkspaceTreeProps {
  readonly theaterId?: string;
  readonly t: T;
  readonly repos: readonly RepoCandidate[];
  readonly reposError: boolean;
  readonly reposTruncated: boolean;
  readonly scanDepth: number;
  readonly worktrees: readonly WorktreeCandidate[];
  readonly worktreesError: boolean;
  readonly refs: Refs;
  readonly refsError: boolean;
  readonly changedFiles: ChangedFilesState;
  readonly selectedRel: string;
  readonly source: Source;
  readonly refFilter: string | null;
  readonly onRepository: (repo: RepoCandidate | WorktreeCandidate) => void;
  readonly onScanDepth: (depth: number) => void;
  readonly onRetryRepos: () => void;
  /** 로컬 저장소 상태(작업·스태시·refs·ahead)를 원격 fetch 없이 다시 읽는다. */
  readonly onReloadState: () => void;
  readonly onRetryWorktrees: () => void;
  readonly onRetryRefs: () => void;
  readonly onSource: (source: Source) => void;
  readonly onRef: (ref: string) => void;
  readonly onCompare: (base: string, head: string) => void;
  readonly onStashInspect: (stash: { readonly name: string; readonly sha: string; readonly subject: string }) => void;
  readonly onStashAction?: (action: "apply" | "pop" | "drop", name: string, sha: string) => void;
}

export function WorkspaceTree({ theaterId = "", t, repos, reposError, reposTruncated, scanDepth, worktrees, worktreesError, refs, refsError, changedFiles, selectedRel, source, refFilter, onRepository, onScanDepth, onRetryRepos, onReloadState, onRetryWorktrees, onRetryRefs, onSource, onRef, onCompare, onStashInspect, onStashAction }: WorkspaceTreeProps) {
  const [initialTreeState] = useState(() => readWorkspaceTreeState(theaterId));
  const [query, setQuery] = useState(initialTreeState?.query ?? "");
  const [collapsedSections, setCollapsedSections] = useState(() => new Set(initialTreeState?.collapsedSections ?? ["tags", "stashes"]));
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set(initialTreeState?.collapsedFolders ?? []));
  const [refContextMenu, setRefContextMenu] = useState<RefContextMenuState | null>(null);
  const [treeRef] = useState<RefObject<HTMLElement | null>>(() => ({ current: null }));
  const handleToggleRepoFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const rootRepos = repos.filter((repo) => repo.kind === "root").sort((a, b) => a.name.localeCompare(b.name));
  const nestedRepos = repos.filter((repo) => repo.kind === "nested");
  const nestedTree = buildRepoTree(nestedRepos);
  const matchRepository = (repo: RepoCandidate) => fuzzyMatch(query, repo.name) ?? fuzzyMatch(query, repo.relPath);
  const rootMatches = query ? rootRepos.filter((repo) => matchRepository(repo) !== null) : rootRepos;
  const nestedMatches = query ? nestedRepos.filter((repo) => matchRepository(repo) !== null) : nestedRepos;
  const matchedCount = rootMatches.length + nestedMatches.length;
  const branchCount = refs.branches.length + refs.remotes.filter((item) => !isRemoteHeadRef(item.ref)).length;
  const refRowCount = refs.branches.length + refs.remotes.length + refs.tags.length + refs.stashes.length;
  const changesCount = changedFiles.kind === "ok" ? changedFiles.files.length : 0;
  const sections = buildWorkspaceTreeSections({
    context: repos.length,
    changes: changesCount,
    worktrees: worktrees.length,
    branches: branchCount,
    tags: refs.tags.length,
    stashes: refs.stashes.length,
  }, t);
  const sectionHeader = (id: (typeof sections)[number]["id"]) => {
    const section = sections.find((item) => item.id === id)!;
    const collapsed = collapsedSections.has(id);
    return <button type="button" className="repository-ws-section-head" aria-expanded={!collapsed} onClick={() => {
      setCollapsedSections((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }}>
      <svg className="repository-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{section.label}</span><i>{section.count}</i>
    </button>;
  };
  const currentBranchRef = refs.branches.find((item) => item.current)?.ref ?? null;
  // 발견 검색창 하나가 트리 전체를 거른다 — 저장소뿐 아니라 브랜치·태그·스태시 행도 같은 질의를 따른다(Fork 문법).
  const refRows = (refSource: RefSource) => buildRefListGroups(refSource, refs).map((group) => ({ ...group, rows: query ? group.rows.filter((row) => fuzzyMatch(query, row.primary) !== null || (row.sub ? fuzzyMatch(query, row.sub) !== null : false)) : group.rows })).filter((group) => group.rows.length > 0).map((group) => <div key={group.label ?? refSource} className="repository-ws-ref-group">
    {group.label && <span className="repository-ws-ref-subhead">{t(group.label === "LOCAL" ? "repository.refs.local" : "repository.refs.remotes")}</span>}
    {/* 브랜치 행은 role=button 자손에 interactive content가 금지되므로(ARIA-in-HTML)
        래퍼 div + 형제 네이티브 버튼 2개(행 본체·비교 액션)로 구성한다 */}
    {group.rows.map((row) => (row.source === "branches" || row.source === "tags") && row.ref ? <div
      key={row.key}
      className={`repository-ws-tree-row${row.source === "branches" ? " is-branch" : " is-tag"}${row.current ? " is-current" : ""}${source === "history" && row.ref === refFilter ? " is-active" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setRefContextMenu({ row, anchor: { x: event.clientX, y: event.clientY } });
      }}
    >
      <button type="button" className="repository-ws-tree-row-main" onClick={() => onRef(row.ref!)}>
        <SourceIcon source={row.source} /><span>{row.primary}</span>{row.current && <i>HEAD</i>}
      </button>
      {refs.defaultBase && row.ref !== refs.defaultBase ? <button type="button" className="repository-tree-action" title={t("repository.compare.withBase")} aria-label={t("repository.compare.withBase")} onClick={() => onCompare(refs.defaultBase!, row.ref!)}>⇆</button> : null}
    </div> : <button type="button" key={row.key} className={`repository-ws-tree-row${row.current ? " is-current" : ""}`} disabled={!row.stashSha} onClick={() => { if (row.stashSha) onStashInspect({ name: row.sub ?? row.key, sha: row.stashSha, subject: row.primary }); }} onContextMenu={(event) => {
      if (row.source !== "stashes" || !onStashAction) return;
      event.preventDefault();
      setRefContextMenu({ row, anchor: { x: event.clientX, y: event.clientY } });
    }}>
      <SourceIcon source={row.source} /><span>{row.primary}</span>{row.current && <i>HEAD</i>}{row.sub && <i>{row.sub}</i>}
    </button>)}
  </div>);
  return <aside ref={treeRef} className="repository-ws-tree">
    <RepositoryDiscovery t={t} query={query} onQuery={setQuery} totalCount={repos.length} matchedCount={matchedCount} scanDepth={scanDepth} onScanDepth={onScanDepth} truncated={reposTruncated} onReload={onReloadState} onEnter={() => {
      const first = rootMatches[0] ?? nestedMatches[0];
      if (first) onRepository(first);
    }} />
    <WorkspaceTreeScroll theaterId={theaterId} query={query} collapsedSections={collapsedSections} collapsedFolders={collapsedFolders} initialScrollTop={initialTreeState?.scrollTop ?? 0} contentVersion={`${repos.length}:${worktrees.length}:${refRowCount}:${changesCount}:${collapsedSections.size}:${collapsedFolders.size}`}>
      <section className={`repository-ws-section${collapsedSections.has("context") ? " is-collapsed" : ""}`}>{sectionHeader("context")}
        {!collapsedSections.has("context") && (reposError ? <WorkspaceTreeError t={t} label={t("repository.discovery.loadReposFailed")} onRetry={onRetryRepos} /> : <>
          {rootMatches.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />)}
          {query ? nestedMatches.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={0} selectedRel={selectedRel} onRepository={onRepository} />) : <RepoTreeChildren node={nestedTree} depth={0} parentPath="" collapsedFolders={collapsedFolders} onToggleFolder={handleToggleRepoFolder} selectedRel={selectedRel} onRepository={onRepository} />}
          {query && matchedCount === 0 && <div className="repository-empty-row">{t("repository.discovery.noMatching")}</div>}
        </>)}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("working") ? " is-collapsed" : ""}`}>{sectionHeader("working")}
        {!collapsedSections.has("working") && <>
          <button type="button" className={`repository-ws-tree-row${source === "history" ? " is-active" : ""}`} onClick={() => onSource("history")}><SourceIcon source="history" /><span>{t("repository.source.history")}</span></button>
          <button type="button" className={`repository-ws-tree-row${source === "changes" ? " is-active" : ""}`} onClick={() => onSource("changes")}><SourceIcon source="changes" /><span>{t("repository.source.changes")}</span><i>{changesCount}</i></button>
        </>}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("worktrees") ? " is-collapsed" : ""}`}>{sectionHeader("worktrees")}
        {!collapsedSections.has("worktrees") && (worktreesError ? <WorkspaceTreeError t={t} label={t("repository.discovery.loadWorktreesFailed")} onRetry={onRetryWorktrees} /> : worktrees.filter((worktree) => !query || fuzzyMatch(query, worktree.name) !== null).map((worktree) => <button type="button" key={worktree.relPath} className={`repository-ws-tree-row${worktree.relPath === selectedRel ? " is-current" : ""}`} title={worktree.relPath} onClick={() => onRepository(worktree)}><SourceIcon source="worktrees" /><span>{worktree.name}</span>{worktree.current && <i>HEAD</i>}</button>))}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("branches") ? " is-collapsed" : ""}`}>{sectionHeader("branches")}
        {!collapsedSections.has("branches") && (refsError ? <WorkspaceTreeError t={t} label={t("repository.discovery.loadRefsFailed")} onRetry={onRetryRefs} /> : refRows("branches"))}
      </section>
      <section className={`repository-ws-section${collapsedSections.has("tags") ? " is-collapsed" : ""}`}>{sectionHeader("tags")}{!collapsedSections.has("tags") && !refsError && refRows("tags")}</section>
      <section className={`repository-ws-section${collapsedSections.has("stashes") ? " is-collapsed" : ""}`}>{sectionHeader("stashes")}{!collapsedSections.has("stashes") && !refsError && refRows("stashes")}</section>
    </WorkspaceTreeScroll>
    {refContextMenu && refContextMenu.row.source === "stashes" && onStashAction ? <StashRowContextMenu
      key={`${refContextMenu.row.key}:${refContextMenu.anchor.x}:${refContextMenu.anchor.y}`}
      anchor={refContextMenu.anchor}
      boundaryRef={treeRef}
      stashName={refContextMenu.row.sub ?? refContextMenu.row.key}
      stashSha={refContextMenu.row.stashSha ?? ""}
      t={t}
      onAction={onStashAction}
      onClose={() => setRefContextMenu(null)}
    /> : refContextMenu && refContextMenu.row.source !== "stashes" ? <RepositoryRefContextMenu
      key={`${refContextMenu.row.key}:${refContextMenu.anchor.x}:${refContextMenu.anchor.y}`}
      anchor={refContextMenu.anchor}
      boundaryRef={treeRef}
      rowRef={refContextMenu.row.ref!}
      currentRef={currentBranchRef}
      defaultBase={refs.defaultBase}
      t={t}
      onCompare={onCompare}
      onClose={() => setRefContextMenu(null)}
    /> : null}
  </aside>;
}

function clampRepositoryContextMenuPosition(anchor: { readonly x: number; readonly y: number }, bounds: DOMRect, menuSize: DOMRect, margin = 4) {
  const requestedLeft = anchor.x - bounds.left;
  const requestedTop = anchor.y - bounds.top;
  return {
    x: Math.max(margin, Math.min(requestedLeft, Math.max(margin, bounds.width - menuSize.width - margin))),
    y: Math.max(margin, Math.min(requestedTop, Math.max(margin, bounds.height - menuSize.height - margin))),
  };
}

function RepositoryRefContextMenu({ anchor, boundaryRef, rowRef, currentRef, defaultBase, t, onCompare, onClose }: {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly boundaryRef: RefObject<HTMLElement | null>;
  readonly rowRef: string;
  readonly currentRef: string | null;
  readonly defaultBase?: string;
  readonly t: T;
  readonly onCompare: (base: string, head: string) => void;
  readonly onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const boundary = boundaryRef.current;
    if (!menu || !boundary) return;
    const updatePosition = () => setPosition(clampRepositoryContextMenuPosition(anchor, boundary.getBoundingClientRect(), menu.getBoundingClientRect()));
    updatePosition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [anchor, boundaryRef]);
  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);
  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);
  const style: CSSProperties = position ? { left: position.x, top: position.y } : { left: 0, top: 0, visibility: "hidden" };
  const activate = (base: string | null | undefined) => {
    if (!base || base === rowRef) return;
    onClose();
    onCompare(base, rowRef);
  };
  return <div ref={menuRef} className="repository-context-menu" role="menu" style={style}>
    <button type="button" className="repository-context-menu-item" role="menuitem" disabled={!currentRef || currentRef === rowRef} onClick={() => activate(currentRef)}>{t("repository.compare.withCurrent")}</button>
    <button type="button" className="repository-context-menu-item" role="menuitem" disabled={!defaultBase || defaultBase === rowRef} onClick={() => activate(defaultBase)}>{t("repository.compare.withBase")}</button>
  </div>;
}

/**
 * Stash 버튼의 메시지 팝오버 — 즉시 실행 대신 메시지를 한 번 묻는다(M5).
 * 비워 두고 확정하면 git의 자동 문구("WIP on …")로 저장된다. Enter=저장, Esc=닫기.
 */
function StashSavePopover({ t, hostRef, onSave, onClose }: {
  readonly t: T;
  readonly hostRef: RefObject<HTMLSpanElement | null>;
  readonly onSave: (message: string) => void;
  readonly onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    const handleOutsidePointer = (event: PointerEvent) => {
      // 앵커(버튼 포함) 밖 클릭만 닫는다 — 버튼 재클릭은 토글 핸들러가 맡는다.
      if (event.target instanceof Node && host && !host.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [hostRef, onClose]);
  return <div className="repository-stash-popover" role="dialog" aria-label={t("repository.stash.savePrompt")} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <label className="repository-stash-popover-label" htmlFor="repository-stash-message">{t("repository.stash.savePrompt")}</label>
    <input
      id="repository-stash-message"
      ref={inputRef}
      type="text"
      className="repository-stash-popover-input"
      placeholder={t("repository.stash.savePlaceholder")}
      value={message}
      maxLength={500}
      onChange={(event) => setMessage(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onSave(message); } }}
    />
    <div className="repository-stash-popover-actions">
      <button type="button" className="repository-refresh-btn" onClick={() => onClose()}>{t("repository.stash.saveCancel")}</button>
      <button type="button" className="repository-refresh-btn repository-stash-popover-confirm" onClick={() => onSave(message)}>{t("repository.stash.saveConfirm")}</button>
    </div>
  </div>;
}

function StashRowContextMenu({ anchor, boundaryRef, stashName, stashSha, t, onAction, onClose }: {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly boundaryRef: RefObject<HTMLElement | null>;
  readonly stashName: string;
  readonly stashSha: string;
  readonly t: T;
  readonly onAction: (action: "apply" | "pop" | "drop", name: string, sha: string) => void;
  readonly onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  // drop은 이 메뉴의 유일한 파괴 동사 — 제품 공용 2단 무장 문법을 따른다.
  const [dropArmed, setDropArmed] = useState(false);
  const dropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const boundary = boundaryRef.current;
    if (!menu || !boundary) return;
    const updatePosition = () => setPosition(clampRepositoryContextMenuPosition(anchor, boundary.getBoundingClientRect(), menu.getBoundingClientRect()));
    updatePosition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [anchor, boundaryRef]);
  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);
  useEffect(() => () => { if (dropTimerRef.current !== null) clearTimeout(dropTimerRef.current); }, []);
  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);
  const style: CSSProperties = position ? { left: position.x, top: position.y } : { left: 0, top: 0, visibility: "hidden" };
  const run = (action: "apply" | "pop") => {
    onClose();
    onAction(action, stashName, stashSha);
  };
  const handleDrop = () => {
    if (!dropArmed) {
      setDropArmed(true);
      dropTimerRef.current = setTimeout(() => {
        dropTimerRef.current = null;
        setDropArmed(false);
      }, 1500);
      return;
    }
    if (dropTimerRef.current !== null) { clearTimeout(dropTimerRef.current); dropTimerRef.current = null; }
    onClose();
    onAction("drop", stashName, stashSha);
  };
  return <div ref={menuRef} className="repository-context-menu" role="menu" style={style}>
    <button type="button" className="repository-context-menu-item" role="menuitem" onClick={() => run("apply")}>{t("repository.stash.apply")}</button>
    <button type="button" className="repository-context-menu-item" role="menuitem" onClick={() => run("pop")}>{t("repository.stash.pop")}</button>
    <button type="button" className={`repository-context-menu-item repository-context-menu-danger${dropArmed ? " is-armed" : ""}`} role="menuitem" onClick={handleDrop}>{dropArmed ? t("repository.stash.dropArm") : t("repository.stash.drop")}</button>
  </div>;
}

function WorkspaceTreeScroll({ theaterId, query, collapsedSections, collapsedFolders, initialScrollTop, contentVersion, children }: {
  readonly theaterId: string;
  readonly query: string;
  readonly collapsedSections: ReadonlySet<string>;
  readonly collapsedFolders: ReadonlySet<string>;
  readonly initialScrollTop: number;
  readonly contentVersion: string;
  readonly children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(initialScrollTop);
  const restoredScrollTopRef = useRef<number | null>(initialScrollTop);
  const cacheFrameRef = useRef<number | null>(null);
  const snapshotRef = useRef({ theaterId, query, collapsedSections, collapsedFolders });
  snapshotRef.current = { theaterId, query, collapsedSections, collapsedFolders };
  const flushCache = useCallback(() => {
    const snapshot = snapshotRef.current;
    writeWorkspaceTreeState(snapshot.theaterId, {
      query: snapshot.query,
      collapsedSections: [...snapshot.collapsedSections],
      collapsedFolders: [...snapshot.collapsedFolders],
      scrollTop: scrollTopRef.current,
    });
  }, []);
  const scheduleCacheWrite = useCallback(() => {
    if (cacheFrameRef.current !== null) return;
    cacheFrameRef.current = requestAnimationFrame(() => {
      cacheFrameRef.current = null;
      flushCache();
    });
  }, [flushCache]);
  const updateTreeScroll = useCallback(() => {
    const tree = scrollRef.current;
    if (!tree || tree.clientHeight <= 0 || tree.scrollHeight <= 0) return;
    if (restoredScrollTopRef.current !== null) {
      const restoredScrollTop = restoredScrollTopRef.current;
      if (restoredScrollTop > 0 && tree.scrollHeight <= tree.clientHeight) return;
      tree.scrollTop = restoredScrollTop;
      restoredScrollTopRef.current = null;
    }
    scrollTopRef.current = tree.scrollTop;
    scheduleCacheWrite();
  }, [scheduleCacheWrite]);
  useLayoutEffect(() => {
    updateTreeScroll();
    const tree = scrollRef.current;
    if (!tree) return;
    const observer = new ResizeObserver(updateTreeScroll);
    observer.observe(tree);
    return () => observer.disconnect();
  }, [contentVersion, updateTreeScroll]);
  useEffect(() => {
    scheduleCacheWrite();
  }, [collapsedFolders, collapsedSections, query, scheduleCacheWrite, theaterId]);
  useEffect(() => () => {
    if (cacheFrameRef.current !== null) {
      cancelAnimationFrame(cacheFrameRef.current);
      cacheFrameRef.current = null;
    }
    flushCache();
  }, [flushCache]);
  return <div ref={scrollRef} className="repository-ws-tree-scroll" onScroll={updateTreeScroll}>{children}</div>;
}

function WorkspaceTreeError({ t, label, onRetry }: { readonly t: T; readonly label: string; readonly onRetry: () => void }) {
  return <div className="repository-ws-tree-error"><span>{label}</span><button type="button" onClick={onRetry}>{t("repository.common.retry")}</button></div>;
}


function SourceIcon({ source }: { readonly source: SourceIconKind }) { const path = source === "repositories" ? "M3 5h12v9H3zM5 3h8v2" : source === "worktrees" ? "M5 3v12M5 6h7M5 12h7" : source === "changes" ? "M3 4h12M3 9h12M3 14h12" : source === "history" ? "M4 4v10h10M7 7h6v5" : source === "branches" ? "M5 3v12M5 6h7M5 12h7" : source === "tags" ? "M3 4h8l4 4-7 7-5-5z" : "M4 5h10v9H4zM6 3h6"; return <svg viewBox="0 0 18 18" aria-hidden="true"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function RepositoryDiscovery({ t, query, onQuery, totalCount, matchedCount, scanDepth, onScanDepth, truncated, onReload, onEnter }: { readonly t: T; readonly query: string; readonly onQuery: (query: string) => void; readonly totalCount: number; readonly matchedCount: number; readonly scanDepth: number; readonly onScanDepth: (depth: number) => void; readonly truncated: boolean; readonly onReload: () => void; readonly onEnter: () => void }) {
  return <div className="repository-discovery">
    <input type="text" className="repository-filter-input" placeholder={t("repository.discovery.placeholder")} aria-label={t("repository.discovery.aria")} value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      onEnter();
    }} />
    {query ? <button type="button" className="repository-filter-clear" aria-label={t("repository.discovery.clearSearch")} onClick={() => onQuery("")}>✕</button> : null}
    <span className="repository-discovery-depth">{t("repository.discovery.depth")}
      <button type="button" className="repository-depth-step" aria-label={t("repository.discovery.scanShallower")} disabled={scanDepth <= SCAN_DEPTH_MIN} onClick={() => onScanDepth(scanDepth - 1)}>−</button>
      <output className="repository-depth-value">{scanDepth}</output>
      <button type="button" className="repository-depth-step" aria-label={t("repository.discovery.scanDeeper")} disabled={scanDepth >= SCAN_DEPTH_MAX} onClick={() => onScanDepth(scanDepth + 1)}>+</button>
    </span>
    {/* 작업 트리·스태시·ahead는 이 패널이 관측하지 않는다. 그 축을 다시 읽는 유일한 경로가
        원격 fetch(동기화)뿐이면, 자기 저장소의 상태를 알기 위해 네트워크를 호출해야 한다. */}
    <button type="button" className="repository-reload-state" aria-label={t("repository.common.reloadState")} title={t("repository.common.reloadState")} onClick={onReload}>↻</button>
    {/* 워크스페이스 트리에서 이 카운트는 숨겨진다 — 그러면 상한에 걸린 탐색이 완전한 목록으로 보인다.
        숫자는 접더라도 "한도에 걸렸다"는 사실은 접지 않는다. */}
    {truncated && <span className="repository-scan-limit" title={t("repository.discovery.countFoundLimited", { count: totalCount })}>{t("repository.scan.limitReached")}</span>}
    <span className="repository-scan-count">{query ? t("repository.discovery.countMatched", { matched: matchedCount, total: totalCount }) : truncated ? t("repository.discovery.countFoundLimited", { count: totalCount }) : t("repository.discovery.countFound", { count: totalCount })}</span>
  </div>;
}
interface RepoTreeCommonProps {
  readonly selectedRel: string;
  readonly onRepository: (repo: RepoCandidate) => void;
  readonly collapsedFolders: ReadonlySet<string>;
  readonly onToggleFolder: (path: string) => void;
}

function RepoTreeChildren({ node, depth, parentPath, selectedRel, onRepository, collapsedFolders, onToggleFolder }: { readonly node: RepoTreeNode; readonly depth: number; readonly parentPath: string } & RepoTreeCommonProps) {
  return <>
    {Object.entries(node.dirs).map(([key, child]) => <RepoTreeFolder key={key} dirKey={key} node={child} depth={depth} parentPath={parentPath} collapsedFolders={collapsedFolders} onToggleFolder={onToggleFolder} selectedRel={selectedRel} onRepository={onRepository} />)}
    {node.repos.map((repo) => <RepoLeafRow key={repo.relPath} repo={repo} depth={depth} selectedRel={selectedRel} onRepository={onRepository} />)}
  </>;
}

function RepoTreeFolder({ dirKey, node, depth, parentPath, selectedRel, onRepository, collapsedFolders, onToggleFolder }: { readonly dirKey: string; readonly node: RepoTreeNode; readonly depth: number; readonly parentPath: string } & RepoTreeCommonProps) {
  const { label, node: resolvedNode } = compressRepoFolder(dirKey, node);
  const path = parentPath ? `${parentPath}/${label}` : label;
  const collapsed = collapsedFolders.has(path);
  const indent = depth * 16 + 12;
  const total = countRepos(resolvedNode);
  return <div className={`repository-folder${collapsed ? " is-collapsed" : ""}`}>
    <button type="button" className="repository-folder-row" style={{ paddingLeft: `${indent}px`, gridTemplateColumns: "12px 15px 1fr auto" }} onClick={() => onToggleFolder(path)} aria-expanded={!collapsed}>
      <svg className="repository-folder-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="repository-folder-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 4a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="repository-folder-name">{label}</span>
      <span className="repository-folder-count">{total}</span>
    </button>
    {!collapsed && <RepoTreeChildren node={resolvedNode} depth={depth + 1} parentPath={path} collapsedFolders={collapsedFolders} onToggleFolder={onToggleFolder} selectedRel={selectedRel} onRepository={onRepository} />}
  </div>;
}

function RepoLeafRow({ repo, depth, selectedRel, onRepository, nameMatch }: { readonly repo: RepoCandidate; readonly depth: number; readonly nameMatch?: readonly number[] } & Pick<RepoTreeCommonProps, "selectedRel" | "onRepository">) {
  // 저장소 리프 아이콘을 폴더 아이콘 컬럼(padding-left 12 + chevron 12 + gap 6 = 30) 아래에 정렬한다.
  const indent = depth * 16 + 30;
  return <button type="button" title={repo.relPath} className={`repository-ref-row${repo.relPath === selectedRel ? " is-current" : ""}`} style={{ paddingLeft: `${indent}px` }} onClick={() => onRepository(repo)}>
    <SourceIcon source="repositories" />
    <span className="repository-ref-name">{nameMatch ? Array.from(repo.name).map((character, index) => nameMatch.includes(index) ? <b key={index} className="repository-ref-hl">{character}</b> : character) : repo.name}</span>{repo.relPath === selectedRel && <span className="repository-ref-mark">✓</span>}
    {repo.branch && <span className="repository-ref-sub">{repo.branch}</span>}
  </button>;
}
function RepositoryIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="2" y="4" width="6" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="7" width="10" height="1.5" rx="0.5" fill="currentColor" /><rect x="2" y="10" width="8" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" /><rect x="2" y="13" width="12" height="1.5" rx="0.5" fill="currentColor" /></svg>;
}

export const repositoryEntry: RailEntryDescriptor = {
  id: "repository",
  title: (locale) => getT(locale)("repository.panel.title"),
  icon: () => <RepositoryIcon />,
  panes: ["repository"],
};

/**
 * 소스 트리와 작업면이 아직 한 본문 안에 있다. 커밋 초안은 `hidden` 동시 마운트가
 * 지키므로, 페인이 갈라질 때 그 자리가 keepAlive로 옮겨 간다.
 */
export const repositoryPane: PaneDescriptor = {
  id: "repository",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("repository.panel.title"),
  render: (ctx) => <RepositoryPanel ctx={ctx} />,
  defaultWidth: 420,
  search: async ({ query, theaterId, limit, signal }) => {
    const repoRel = readStoredRepositoryRel(theaterId);
    const response = await fetch("/plugins/repository/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, repoRel, query, limit }),
      signal,
    });
    if (!response.ok) throw new Error("repository_search_failed");
    const result = await response.json() as RepositorySearchResult;
    return result.commits.map((commit) => ({
      id: `${result.repoRel}:${commit.fullHash}`,
      title: commit.subject,
      subtitle: commit.shortHash,
      activate: () => activateRepositorySearchTarget(theaterId, result.repoRel, commit.fullHash),
    }));
  },
};
