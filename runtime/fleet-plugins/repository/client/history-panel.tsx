import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icons.js";

import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import type { RepositoryContext } from "./repository-context.js";

import type { CommitResult, DiffFileEntry, LogCommitEntry, LogOrder, LogResult, WorktreeCheckout } from "../server/types.js";
import { FileRow, FilesViewToggle, readFilesViewMode, saveFilesViewMode, type FilesViewMode } from "./changed-files.js";
import { CompareInspector } from "./compare-inspector.js";
import { CommitBlobView, CommitTreeView, type CommitTreeSelection } from "./commit-tree.js";
import { DiffTreeView } from "./repository-tree.js";
import { GraphGutter, ROW_HEIGHT, laneColor } from "./graph.js";
import { layoutGraph, type GraphLayout, type GraphNode } from "./graph.js";
import { dropHistoryCache, readHistoryCache, readHistoryOrder, saveHistoryOrder, writeHistoryCache, type HistoryCacheEntry } from "./repository-state.js";
import { HunkView } from "./hunk-view.js";
import { getT, localeTag, readErrorSentence, type RepositoryMessageKey } from "./i18n/index.js";
import { formatCommitTime, refBadges, shortRefName, splitCommitSubject, type RefBadge, type RefBadgeKind } from "./repository-parsers.js";
import { DIFF_DIVIDER_WIDTH, HISTORY_DETAIL_PANE_MIN_HEIGHT, HISTORY_LOG_PANE_MIN_HEIGHT, buildHistoryStackTemplate, buildInspectorChangesGridTemplate, clampSplitPaneSize, installPointerDragLifecycle } from "./rail-layout.js";
import { SplitSeam, useSeamContainerSize } from "./split-seam.js";
import { StashInspector } from "./stash-inspector.js";
import { WORKSPACE_DOCK_MIN_HEIGHT, buildWorkspaceDockCollapsedTemplate, buildWorkspaceDockTemplate, detentForWorkspaceDockHeight, dragWorkspaceDockHeight, normalizeWorkspaceDockHeight, readWorkspaceDockHeight, saveWorkspaceDockHeight, settleWorkspaceDockHeight, workspaceDockDetents, type WorkspaceDockDetent, type WorkspaceDockDragResult } from "./workspace-layout.js";
import { consumeRepositorySearchTarget, useRepositorySearchTarget } from "./repository-state.js";

type T = Translate<RepositoryMessageKey>;

export type HistoryOkState = { readonly kind: "ok"; readonly commits: readonly LogCommitEntry[]; readonly checkouts: readonly WorktreeCheckout[]; readonly hasMore: boolean; readonly truncated: boolean };
type LoadState = { readonly kind: "loading" } | HistoryOkState | { readonly kind: "error"; readonly message: string };
type CommitTarget = { readonly fullHash: string; readonly entry?: LogCommitEntry };
type CompareAnchor = { readonly fullHash: string; readonly shortHash: string };
export type ComparePair = { readonly base: string; readonly head: string; readonly baseLabel: string; readonly headLabel: string };

/**
 * 비교의 base/head 방향을 정한다. 목록 위치로 정해서는 안 된다 — topo 정렬에서는 브랜치 체인이 통째로 먼저
 * 나오므로 위쪽 행이 아래쪽 행보다 오래된 커밋일 수 있고, 그때 base와 head가 뒤바뀌어 추가가 삭제로 보인다.
 * 방향은 목록이 실제로 보여 주는 커밋 시각으로 정하고, 앵커의 시각을 알 수 없을 때만
 * 사용자가 고른 순서(먼저 고른 쪽이 base)를 그대로 지킨다.
 */
export function chooseComparePair(
  anchor: { readonly fullHash: string; readonly shortHash: string; readonly authorAt: number | null },
  target: { readonly fullHash: string; readonly shortHash: string; readonly authorAt: number },
): ComparePair {
  const anchorIsOlder = anchor.authorAt === null || anchor.authorAt <= target.authorAt;
  const older = anchorIsOlder ? anchor : target;
  const newer = anchorIsOlder ? target : anchor;
  return { base: older.fullHash, head: newer.fullHash, baseLabel: older.shortHash, headLabel: newer.shortHash };
}
type InspectorState = { readonly kind: "loading" } | { readonly kind: "ok"; readonly result: CommitResult } | { readonly kind: "error"; readonly message: string };
type HistoryCacheRestore = { readonly state: HistoryOkState; readonly target: CommitTarget | null; readonly filterText: string; readonly scrollTop: number };

function readHistoryCacheRestore(historyCacheKey: string, pendingSearchTargetHash: string | null): HistoryCacheRestore | null {
  const entry = readHistoryCache(historyCacheKey);
  if (!entry || (pendingSearchTargetHash && !entry.commits.some((commit) => commit.fullHash === pendingSearchTargetHash))) return null;
  return buildHistoryCacheRestore(entry);
}

function buildHistoryCacheRestore(entry: HistoryCacheEntry): HistoryCacheRestore {
  const targetEntry = entry.targetHash ? entry.commits.find((commit) => commit.fullHash === entry.targetHash) : undefined;
  return {
    state: { kind: "ok", commits: entry.commits, checkouts: entry.checkouts, hasMore: entry.hasMore, truncated: entry.truncated },
    target: entry.targetHash ? { fullHash: entry.targetHash, entry: targetEntry } : null,
    filterText: entry.filterText,
    scrollTop: entry.scrollTop,
  };
}

export interface HistoryLoadGeneration {
  readonly theaterId: string | null | undefined;
  readonly repoRel: string;
  readonly refFilter: string | null;
  readonly order: LogOrder;
  readonly refreshToken: number;
}

const PREFS_LOG_PANE_HEIGHT = "fleet-console.history.logHeight";
const PREFS_HEADER_HEIGHT = "fleet-console.history.headerHeight";
const PREFS_FILE_LIST_WIDTH = "fleet-console.history.fileListWidth";
const LOG_PANE_DEFAULT_HEIGHT = 240;
const HEADER_DEFAULT_HEIGHT = 214;
const FILE_LIST_DEFAULT_WIDTH = 180;
const HISTORY_OVERSCAN_ROWS = 8;
const HISTORY_PAGE_SIZE = 200;

export interface HistoryWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
}

export interface HistoryWindowRow {
  readonly entry: LogCommitEntry;
  readonly graphNode: GraphNode;
  readonly visibleIndex: number;
  readonly commitIndex: number;
}

export function calculateHistoryWindow(itemCount: number, scrollTop: number, viewportHeight: number): HistoryWindow {
  const safeItemCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  const safeViewportHeight = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const maxScrollTop = Math.max(0, safeItemCount * ROW_HEIGHT - safeViewportHeight);
  const safeScrollTop = Math.min(Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0, maxScrollTop);
  const startIndex = Math.max(0, Math.floor(safeScrollTop / ROW_HEIGHT) - HISTORY_OVERSCAN_ROWS);
  const endIndex = Math.min(safeItemCount, Math.max(startIndex, Math.ceil((safeScrollTop + safeViewportHeight) / ROW_HEIGHT) + HISTORY_OVERSCAN_ROWS));
  return {
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * ROW_HEIGHT,
    bottomSpacerHeight: Math.max(0, (safeItemCount - endIndex) * ROW_HEIGHT),
  };
}

function isHistoryGenerationCurrent(request: HistoryLoadGeneration, current: HistoryLoadGeneration): boolean {
  return request.theaterId === current.theaterId
    && request.repoRel === current.repoRel
    && request.refFilter === current.refFilter
    && request.order === current.order
    && request.refreshToken === current.refreshToken;
}

export function appendHistoryPage(
  current: HistoryOkState,
  data: LogResult,
  requestGeneration: HistoryLoadGeneration,
  currentGeneration: HistoryLoadGeneration,
): HistoryOkState | null {
  if (!isHistoryGenerationCurrent(requestGeneration, currentGeneration)) return null;
  const existing = new Set(current.commits.map((commit) => commit.fullHash));
  // Offset 페이지 사이에서 ref가 움직이면 중복뿐 아니라 누락도 생길 수 있다. 여기서는 React key와
  // 그래프 인덱스 훼손을 막기 위해 중복 hash만 제거하며, 누락 해결에는 서버 커서가 별도로 필요하다.
  const appended = data.commits.filter((commit) => !existing.has(commit.fullHash));
  return {
    kind: "ok",
    commits: [...current.commits, ...appended],
    checkouts: data.checkouts,
    hasMore: data.hasMore,
    truncated: current.truncated || (data.truncated ?? false),
  };
}

export function getHistoryWindowRows(
  commitIndexes: ReadonlyMap<string, number>,
  visible: readonly LogCommitEntry[],
  layout: GraphLayout,
  window: HistoryWindow,
): readonly HistoryWindowRow[] {
  return visible.slice(window.startIndex, window.endIndex).map((entry, offset) => {
    const commitIndex = commitIndexes.get(entry.fullHash);
    if (commitIndex === undefined) throw new Error(`History commit missing from graph layout: ${entry.fullHash}`);
    return {
      entry,
      graphNode: layout.nodes[commitIndex]!,
      visibleIndex: window.startIndex + offset,
      commitIndex,
    };
  });
}

export function findDetachedCheckout(entry: LogCommitEntry, checkouts: readonly WorktreeCheckout[]): WorktreeCheckout | null { return checkouts.find((checkout) => checkout.branch === null && checkout.sha === entry.fullHash) ?? null; }
export function filterHistoryCommits(commits: readonly LogCommitEntry[], filterText: string): readonly LogCommitEntry[] {
  const value = filterText.toLowerCase();
  return value ? commits.filter((entry) => entry.subject.toLowerCase().includes(value) || entry.authorName.toLowerCase().includes(value) || entry.shortHash.toLowerCase().includes(value) || entry.fullHash.toLowerCase().includes(value) || entry.refs.some((ref) => ref.toLowerCase().includes(value)) || refBadges(entry).some((badge) => badge.label.toLowerCase().includes(value))) : commits;
}

export function isInspectorDismissKey(key: string): boolean { return key === "Escape"; }
export function aggregateWip(files: readonly DiffFileEntry[]): { files: number; additions: number; deletions: number } { return files.reduce((sum, file) => ({ files: sum.files + 1, additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { files: 0, additions: 0, deletions: 0 }); }
export function shouldShowWip(wip: { readonly files: number }, filterText: string, refFilter: string | null): boolean { return wip.files > 0 && !filterText && !refFilter; }

function CheckoutIcon({ current }: { readonly current: boolean }) { return current ? <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L5 8.7L9.5 3.5" stroke="currentColor" strokeWidth="1.5" /></svg> : <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M1.5 3.4h3l1 1.1h5v5.1a.9.9 0 01-.9.9H2.4a.9.9 0 01-.9-.9V4.3a.9.9 0 01.9-.9z" stroke="currentColor" strokeWidth="1.2" /></svg>; }
function BranchIcon() { return <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M3.6 3.9v4.2M3.6 8.1h3.1a1.7 1.7 0 001.7-1.7V4.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="3.6" cy="2.6" r="1.3" stroke="currentColor" strokeWidth="1.2" /><circle cx="8.4" cy="3.3" r="1.3" stroke="currentColor" strokeWidth="1.2" /></svg>; }
function TagIcon() { return <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><path d="M1.9 5.6V2.4a.6.6 0 01.6-.6h3.2L10.4 6a.8.8 0 010 1.1L7.1 10.4a.8.8 0 01-1.1 0z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="4.1" cy="4.1" r=".85" fill="currentColor" /></svg>; }
function RemoteIcon() { return <svg className="history-badge-icon" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.3" stroke="currentColor" strokeWidth="1.2" /><path d="M1.7 6h8.6M6 1.7c1.1 1.2 1.7 2.7 1.7 4.3S7.1 9.1 6 10.3C4.9 9.1 4.3 7.6 4.3 6S4.9 2.9 6 1.7z" stroke="currentColor" strokeWidth="1.1" /></svg>; }

/**
 * 뱃지 색조 — Fork처럼 ref 뱃지를 그래프와 같은 색 체계로 묶는다.
 * 체크아웃 위치(brass)와 태그(plum)는 어느 레인에 있든 같아야 하므로 CSS가 소유하고,
 * 나머지 브랜치·원격·워크트리만 자기 커밋의 레인 색을 물려받아 인라인으로 주입된다.
 */
function laneBadgeTone(kind: RefBadgeKind, checkout: WorktreeCheckout | null | undefined, lane: number | undefined): string | undefined {
  if (lane === undefined || checkout?.isCurrent || kind === "head" || kind === "tag") return undefined;
  return laneColor(lane);
}

function BadgeMark({ kind, checkout }: { readonly kind: RefBadgeKind; readonly checkout: WorktreeCheckout | null | undefined }) {
  if (kind === "tag") return <TagIcon />;
  if (kind === "remote") return <RemoteIcon />;
  if (checkout) return <CheckoutIcon current={checkout.isCurrent} />;
  if (kind === "head" || kind === "worktree") return <CheckoutIcon current={kind === "head"} />;
  return <BranchIcon />;
}

/** `lane`을 넘기지 않으면 색조를 CSS 기본값에 맡긴다 — 그래프가 없는 검사기 칩이 그 경로를 쓴다. */
function RefBadgeChip({ badge, checkout, lane, remoteDescription }: { readonly badge: RefBadge; readonly checkout?: WorktreeCheckout | null; readonly lane?: number; readonly remoteDescription?: string }) {
  const tone = laneBadgeTone(badge.kind, checkout, lane);
  return <span
    className={`history-badge history-badge--${badge.kind}${checkout?.isCurrent ? " is-current" : ""}${badge.hasRemote ? " has-remote" : ""}`}
    style={tone ? ({ "--badge-tone": tone } as CSSProperties) : undefined}
  >
    {badge.hasRemote && <span className="history-badge-mark history-badge-remote-mark" aria-hidden="true"><RemoteIcon /></span>}
    {badge.hasRemote && remoteDescription && <span className="repository-sr-only">{remoteDescription}</span>}
    <span className="history-badge-mark"><BadgeMark kind={badge.kind} checkout={checkout} /></span>
    <span className="history-badge-label">{badge.label}</span>
  </span>;
}

function ResponsiveBadgeGroup({ identity, children }: { readonly identity: string; readonly children: ReactNode }) {
  const groupRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const group = groupRef.current;
    const row = group?.closest<HTMLElement>(".history-commit-row-main");
    if (!group || !row) return;
    const measure = () => {
      // 먼저 전체 고유 폭으로 재서 들어갈 때만 남긴다. class toggle은 같은 layout frame 안에서 끝나므로
      // 긴 ref가 잠깐 잘려 보이지 않고, 숨긴 뒤에도 다음 실제 row resize에서 다시 판정할 수 있다.
      group.classList.remove("is-overflowing");
      group.classList.toggle("is-overflowing", row.scrollWidth > row.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [identity]);
  return <span ref={groupRef} className="history-commit-badges">{children}</span>;
}


export function CommitRow({ entry, checkouts, selected, picked = false, previewed = false, pin = null, graphNode, onRowActivate, onCompareAction, onSelect, rowRef, locale }: { readonly entry: LogCommitEntry; readonly checkouts: readonly WorktreeCheckout[]; readonly selected: boolean; readonly picked?: boolean; readonly previewed?: boolean; readonly pin?: CompareAnchor | null; readonly graphNode: import("./graph.js").GraphNode; readonly onRowActivate?: (entry: LogCommitEntry, shiftKey: boolean) => void; readonly onCompareAction?: (entry: LogCommitEntry) => void; readonly onSelect?: (entry: LogCommitEntry) => void; readonly rowRef?: (node: HTMLButtonElement | null) => void; readonly locale?: ConsoleLocale }) {
  const t = getT(locale);
  const badges = refBadges(entry); const detached = findDetachedCheckout(entry, checkouts);
  const activateRow = onRowActivate ?? ((selectedEntry: LogCommitEntry) => onSelect?.(selectedEntry));
  const compareLabel = !pin ? t("repository.compare.pinRow", { short: entry.shortHash }) : pin.fullHash === entry.fullHash ? t("repository.compare.unpinRow", { short: entry.shortHash }) : t("repository.compare.completeRow", { short: entry.shortHash, base: pin.shortHash });
  // Fork 문법 — Conventional Commit 접두만 볼드로 올려 커밋 종류를 훑어 읽게 한다. 규약 밖 제목은 통째로 한 티어에 둔다.
  const subject = splitCommitSubject(entry.subject);
  // Fork 문법: refs 뱃지는 제목 왼쪽(그래프 바로 뒤)에서 커밋의 정체를 먼저 알린다.
  return <div className={`history-commit-row${selected ? " is-selected" : ""}${entry.onHead ? "" : " is-off-head"}${picked ? " is-picked" : ""}${previewed ? " is-previewed" : ""}`} title={entry.onHead ? undefined : t("repository.history.offHead")}>
    <button ref={rowRef} type="button" className="history-commit-row-main" onClick={(event) => activateRow(entry, event.shiftKey)}>
      <ResponsiveBadgeGroup identity={`${entry.fullHash}:${badges.map((badge) => `${badge.kind}:${badge.label}:${badge.hasRemote ? "remote" : "local"}`).join("|")}:${detached ? "detached" : "attached"}`}>
        {badges.map((badge) => <RefBadgeChip
          key={`${badge.kind}:${badge.label}`}
          badge={badge}
          checkout={badge.kind === "branch" ? checkouts.find((item) => item.branch === badge.label) : null}
          lane={graphNode.lane}
          remoteDescription={badge.hasRemote ? t("repository.history.remoteTracked") : undefined}
        />)}
        {detached && <RefBadgeChip badge={{ kind: "worktree", label: t("repository.history.detached") }} checkout={detached} lane={graphNode.lane} />}
      </ResponsiveBadgeGroup>
      <span className="history-commit-subject" title={entry.subject}>{subject.prefix ? <><b className="history-commit-kind">{subject.prefix}</b> {subject.rest}</> : entry.subject}</span>
      {/* 본문이 더 있는 커밋만 표시한다 — 목록에서 "열어 볼 값이 있는 커밋"을 가려내는 Fork의 ↵ 마커. */}
      {entry.hasBody && <span className="history-commit-body-mark" aria-label={t("repository.history.hasBody")} title={t("repository.history.hasBody")}>↵</span>}
      <span className="history-commit-author"><span className="history-commit-avatar" aria-hidden="true">{initials(entry.authorName)}</span><span className="history-commit-author-name">{entry.authorName}</span></span>
      <span className="history-commit-sha">{entry.shortHash}</span>
      <span className="history-commit-time">{formatCommitTime(entry.authorAt, new Date(), locale)}</span>
      <span className="history-graph-gutter" aria-hidden="true"><GraphGutter node={graphNode} /></span>
    </button>
    {onCompareAction && <button type="button" className="history-row-compare" aria-label={compareLabel} onClick={() => onCompareAction(entry)}><Icon name="compare" size={12} /></button>}
  </div>;
}

export type InspectorTab = "details" | "changes" | "tree";
export type DockNeighbor = { readonly fullHash: string; readonly shortHash: string };

/** 독 머리줄이 소유자(HistoryPanel)에게서 받는 상태 — 크기·접힘·비교 무장·이웃 커밋. */
export interface DockControls {
  readonly collapsed: boolean;
  readonly detent: WorkspaceDockDetent;
  readonly arming: { readonly shortHash: string } | null;
  readonly child: DockNeighbor | null;
  readonly onCollapse: () => void;
  readonly onExpand: () => void;
  readonly onToggleFull: () => void;
  readonly onDisarm: () => void;
}

/** 적재된 목록에서 이 커밋을 부모로 둔 첫 커밋 — 자식 이동의 목적지. 미적재면 null. */
export function findLoadedChild(commits: readonly LogCommitEntry[], fullHash: string): DockNeighbor | null {
  const child = commits.find((entry) => entry.parents.includes(fullHash));
  return child ? { fullHash: child.fullHash, shortHash: child.shortHash } : null;
}

export function neighborShort(full: string): string { return full.slice(0, 9); }

/**
 * 독 머리줄 — 탭 · 정체성 · 부모/자식 이동 · 액션이 한 줄(36px)에 선다. 어느 탭에서도
 * "무엇을 보고 있는지"가 남고, 이동 버튼은 목적지를 이름에 쓴다. 비교 무장 중에는
 * 이 줄이 aurora 띠로 바뀌어 다음 조작을 말한다 — 독은 닫히지 않는다.
 */
function DockHeader({ t, tab, onTab, fileCount, shortHash, subject, lane, parent, child, dock, onNavigate, onPinCompare, onClose, onPreview }: {
  readonly t: T; readonly tab: InspectorTab; readonly onTab: (tab: InspectorTab) => void; readonly fileCount: number | null;
  readonly shortHash: string; readonly subject: string; readonly lane: number | null;
  readonly parent: DockNeighbor | null; readonly child: DockNeighbor | null; readonly dock: DockControls | null;
  readonly onNavigate: (target: DockNeighbor) => void; readonly onPinCompare?: () => void; readonly onClose: () => void;
  readonly onPreview: (fullHash: string | null) => void;
}) {
  const laneStyle = lane === null ? undefined : { color: laneColor(lane) } as CSSProperties;
  if (dock?.arming) {
    return <div className="repository-dock-arm" role="status">
      <span className="repository-dock-arm-base"><Icon name="compare" size={12} />{t("repository.compare.armBase", { short: dock.arming.shortHash })}</span>
      <span className="repository-dock-arm-hint">{t("repository.compare.armHint")}</span>
      <button type="button" className="repository-dock-btn" onClick={dock.onDisarm}>{t("repository.compare.armCancel")} <kbd>Esc</kbd></button>
    </div>;
  }
  const identity = <span className="repository-dock-identity"><Icon name="commit" size={14} className="repository-dock-mark" style={laneStyle} /><span className="repository-dock-sha">{shortHash}</span><span className="repository-dock-subject" title={subject}>{subject}</span></span>;
  if (dock?.collapsed) {
    return <div className="repository-dock-head is-collapsed">
      <button type="button" className="repository-dock-strip" title={t("repository.dock.expand")} onClick={dock.onExpand}>{identity}<span className="repository-dock-strip-hint">{t("repository.dock.expand")}<Icon name="expand" size={12} /></span></button>
      <button type="button" className="repository-dock-btn is-icon" aria-label={t("repository.history.closeInspector")} title={t("repository.history.closeInspector")} onClick={onClose}><Icon name="close" /></button>
    </div>;
  }
  const navButton = (kind: "parent" | "child", target: DockNeighbor | null) => {
    const label = t(kind === "parent" ? "repository.dock.parent" : "repository.dock.child");
    const title = target ? t(kind === "parent" ? "repository.dock.parentTitle" : "repository.dock.childTitle", { short: target.shortHash }) : t(kind === "parent" ? "repository.dock.parentNone" : "repository.dock.childNone");
    return <button type="button" className="repository-dock-btn repository-dock-nav" disabled={!target} title={title} aria-label={title}
      onMouseEnter={() => onPreview(target?.fullHash ?? null)} onMouseLeave={() => onPreview(null)} onFocus={() => onPreview(target?.fullHash ?? null)} onBlur={() => onPreview(null)}
      onClick={() => { if (target) { onPreview(null); onNavigate(target); } }}>{kind === "parent" ? <><Icon name="parent" size={13} />{label}</> : <>{label}<Icon name="child" size={13} /></>}</button>;
  };
  return <div className="repository-dock-head">
    <div className="repository-dock-tabs repository-segmented" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => onTab("details")}>{t("repository.history.details")}</button>
      <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => onTab("changes")}>{t("repository.source.changes")}{fileCount !== null && <span className="repository-source-count">{fileCount}</span>}</button>
      <button type="button" role="tab" aria-selected={tab === "tree"} onClick={() => onTab("tree")}>{t("repository.filetree.tab")}</button>
    </div>
    {identity}
    <div className="repository-dock-actions">
      {navButton("parent", parent)}{navButton("child", child)}
      <span className="repository-dock-sep" aria-hidden="true" />
      {onPinCompare && <button type="button" className="repository-dock-btn" title={t("repository.compare.pinAction")} onClick={onPinCompare}><Icon name="compare" size={13} />{t("repository.compare.pinShort")}</button>}
      {dock && <button type="button" className="repository-dock-btn is-icon" title={t(dock.detent === "full" ? "repository.dock.toHalf" : "repository.dock.toFull")} aria-label={t(dock.detent === "full" ? "repository.dock.toHalf" : "repository.dock.toFull")} onClick={dock.onToggleFull}><Icon name={dock.detent === "full" ? "chevron" : "expand"} /></button>}
      {dock && <button type="button" className="repository-dock-btn is-icon" title={t("repository.dock.collapse")} aria-label={t("repository.dock.collapse")} onClick={dock.onCollapse}><Icon name="chevron" /></button>}
      <button type="button" className="repository-dock-btn is-icon" aria-label={t("repository.history.closeInspector")} title={t("repository.history.closeInspector")} onClick={onClose}><Icon name="close" /></button>
    </div>
  </div>;
}

function CommitInspector({ ctx, repoRel, target, workspace, tab, onTab, lane, dock, onSelectCommit, onPinCompare, onClose, onPreview }: { readonly ctx: RepositoryContext; readonly repoRel: string; readonly target: CommitTarget; readonly workspace: boolean; readonly tab: InspectorTab; readonly onTab: (tab: InspectorTab) => void; readonly lane: number | null; readonly dock: DockControls | null; readonly onSelectCommit: (target: CommitTarget) => void; readonly onPinCompare?: () => void; readonly onClose: () => void; readonly onPreview: (fullHash: string | null) => void }) {
  const t = getT(ctx.language);
  const [state, setState] = useState<InspectorState>({ kind: "loading" }); const [selectedPath, setSelectedPath] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  // 트리 탭의 선택은 변경 목록과 다른 축이다 — 바뀌지 않은 파일도 고를 수 있다.
  const [treeSelection, setTreeSelection] = useState<CommitTreeSelection | null>(null);
  const [fileListWidth, setFileListWidth] = useState(() => readSize(PREFS_FILE_LIST_WIDTH, FILE_LIST_DEFAULT_WIDTH));
  const [fileDragging, setFileDragging] = useState(false);
  const [filesView, setFilesView] = useState<FilesViewMode>(readFilesViewMode);
  const changesRef = useRef<HTMLDivElement>(null); const disposeRef = useRef<(() => void) | null>(null); const fileListWidthRef = useRef(fileListWidth);
  const changesWidth = useSeamContainerSize(changesRef, "width", tab === "changes" || tab === "tree");
  const commit = useMemo(() => ({ fullHash: target.fullHash, theaterId: ctx.theaterId ?? "", repoRel }), [target.fullHash, ctx.theaterId, repoRel]);
  useEffect(() => { let cancelled = false; setState({ kind: "loading" }); setTreeSelection(null); /* 트리 선택은 커밋에 묶인다 — 다른 커밋으로 옮기면 옛 경로가 새 트리에서 file_not_found를 부른다 */ ctx.api.fetch("repository", "commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, ref: target.fullHash }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed"); return response.json() as Promise<CommitResult>; }).then((result) => { if (!cancelled) { setState({ kind: "ok", result }); setSelectedPath(result.files[0]?.path ?? null); } }).catch((error: unknown) => { if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" }); }); return () => { cancelled = true; }; }, [ctx.api, ctx.theaterId, repoRel, target.fullHash]);
  useEffect(() => () => disposeRef.current?.(), []);
  const applyFileListWidth = useCallback((next: number) => { fileListWidthRef.current = next; setFileListWidth(next); }, []);
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => { event.preventDefault(); const container = changesRef.current; if (!container) return; const start = fileListWidthRef.current; const startPointer = event.clientX; const size = container.getBoundingClientRect().width; disposeRef.current?.(); setFileDragging(true); disposeRef.current = installPointerDragLifecycle({ documentTarget: document, windowTarget: window, onMove: (moveEvent) => { const next = clampSplitPaneSize(start, (moveEvent as PointerEvent).clientX - startPointer, size, 120, 120); if (next !== null) applyFileListWidth(next); }, onFinish: () => { try { localStorage.setItem(PREFS_FILE_LIST_WIDTH, String(fileListWidthRef.current)); } catch { /* ignore */ } setFileDragging(false); disposeRef.current = null; } }); }, [applyFileListWidth]);
  const stepFileList = useCallback((delta: number) => { const container = changesRef.current; if (!container) return; const next = clampSplitPaneSize(fileListWidthRef.current, delta, container.getBoundingClientRect().width, 120, 120); if (next === null) return; applyFileListWidth(next); try { localStorage.setItem(PREFS_FILE_LIST_WIDTH, String(next)); } catch { /* ignore */ } }, [applyFileListWidth]);
  const files = state.kind === "ok" ? state.result.files : null;
  const selectedFile = files ? files.find((file) => file.path === selectedPath) ?? files[0] ?? null : null;
  const selectedIndex = files && selectedFile ? files.indexOf(selectedFile) : -1;
  const stepFile = useCallback((delta: number) => { if (!files || selectedIndex < 0) return; const next = files[selectedIndex + delta]; if (next) setSelectedPath(next.path); }, [files, selectedIndex]);
  // 부모는 로드 전엔 목록 항목의 parents로, 로드 뒤엔 커밋 메타로 안다 — 버튼이 로딩을 기다리지 않게.
  const parent: DockNeighbor | null = state.kind === "ok" ? (state.result.meta.parents[0] ? { fullHash: state.result.meta.parents[0].full, shortHash: state.result.meta.parents[0].short } : null) : (target.entry?.parents[0] ? { fullHash: target.entry.parents[0], shortHash: neighborShort(target.entry.parents[0]) } : null);
  const content = state.kind === "loading" ? <div className="history-inspector-empty">{t("repository.history.loadingCommit")}</div> : state.kind === "error" ? <div className="history-inspector-empty history-inspector-error">{readErrorSentence(t, state.message)}</div> : (() => {
    const { meta, files } = state.result;
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const entry = target.entry;
    const chooseFile = (file: DiffFileEntry, showChanges: boolean) => {
      setSelectedPath(file.path);
      if (showChanges) onTab("changes");
    };
    const chooseFilesView = (next: FilesViewMode) => {
      setFilesView(next);
      saveFilesViewMode(next);
    };
    const copySha = () => {
      const copiedPromise = navigator.clipboard?.writeText(target.fullHash);
      if (!copiedPromise) return;
      void copiedPromise.then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }).catch(() => undefined);
    };
    if (tab === "tree") {
      const treeSeam = <SplitSeam orientation="vertical" label={t("repository.history.resizeFileList")} value={fileListWidth} min={120} max={changesWidth === undefined ? undefined : changesWidth - 120 - DIFF_DIVIDER_WIDTH} dragging={fileDragging} readout={fileDragging ? `${Math.round(fileListWidth)}px` : null} onPointerDown={startDrag} onStep={stepFileList} />;
      const chosen = treeSelection && treeSelection.changed ? files.find((file) => file.path === treeSelection.changed!.path) ?? null : null;
      return <div className="history-changes-tab history-tree-tab"><div ref={changesRef} className="history-changes-columns" style={{ gridTemplateColumns: buildInspectorChangesGridTemplate(fileListWidth) }}>
        <div className="repository-ftree-scroll">{/* 폴더 캐시는 커밋에 묶인다 — 키로 리마운트해야 펼쳐 둔 하위 폴더가 옛 커밋의 항목을 계속 그리지 않는다 */}<CommitTreeView key={target.fullHash} ctx={ctx} repoRel={repoRel} fullHash={target.fullHash} commitFiles={files} selectedPath={treeSelection?.path ?? null} onSelect={setTreeSelection} /></div>
        {treeSeam}
        {treeSelection
          ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={treeSelection.path}>{treeSelection.path}</span>{chosen && <div><span className="history-file-counter">{t("repository.filetree.changedHere")}</span></div>}</div>{chosen ? <HunkView ctx={ctx} repoRel={repoRel} file={chosen} mode="unified" commit={commit} /> : <CommitBlobView ctx={ctx} repoRel={repoRel} fullHash={target.fullHash} path={treeSelection.path} />}</div>
          : <div className="history-inspector-empty">{t("repository.filetree.pickHint")}</div>}
      </div></div>;
    }
    // 세부 정보: 머리는 내용 높이다 — 고정 높이와 그 안의 디바이더가 있으면 독을 키워도 머리는 잘린 채 남고 파일 목록만 늘었다.
    if (tab === "details") return <div className="history-details-tab"><CommitHeader key={target.fullHash} meta={meta} entry={entry} fullHash={target.fullHash} copied={copied} onCopy={copySha} onParent={(full) => onSelectCommit({ fullHash: full })} locale={ctx.language} t={t} /><CommitFiles files={files} truncated={state.result.truncated} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, true)} t={t} /></div>;
    return <div className="history-changes-tab"><div ref={changesRef} className="history-changes-columns" style={{ gridTemplateColumns: buildInspectorChangesGridTemplate(fileListWidth) }}><CommitFiles files={files} truncated={state.result.truncated} selectedPath={selectedPath} additions={additions} deletions={deletions} viewMode={filesView} onViewMode={chooseFilesView} onSelect={(file) => chooseFile(file, false)} t={t} /><SplitSeam orientation="vertical" label={t("repository.history.resizeFileList")} value={fileListWidth} min={120} max={changesWidth === undefined ? undefined : changesWidth - 120 - DIFF_DIVIDER_WIDTH} dragging={fileDragging} readout={fileDragging ? `${Math.round(fileListWidth)}px` : null} onPointerDown={startDrag} onStep={stepFileList} />{selectedFile ? <div className="history-file-diff"><div className="history-file-repository-head"><span title={selectedFile.path}>{selectedFile.path}</span><div><span className="history-file-counter" aria-live="polite">{t("repository.dock.fileCounter", { index: selectedIndex + 1, count: files.length })}</span><button type="button" aria-label={t("repository.history.previousFile")} title={`${t("repository.history.previousFile")} (K)`} disabled={selectedIndex <= 0} onClick={() => stepFile(-1)}><Icon name="parent" size={13} /></button><button type="button" aria-label={t("repository.history.nextFile")} title={`${t("repository.history.nextFile")} (J)`} disabled={selectedIndex >= files.length - 1} onClick={() => stepFile(1)}><Icon name="child" size={13} /></button></div></div><HunkView ctx={ctx} repoRel={repoRel} file={selectedFile} mode="unified" commit={commit} /></div> : <div className="history-inspector-empty">{t("repository.history.noChangedFiles")}</div>}</div></div>;
  })();
  const shortHash = target.entry?.shortHash ?? target.fullHash.slice(0, 9);
  const subject = state.kind === "ok" ? state.result.meta.subject : target.entry?.subject ?? "";
  // 키보드 — Esc는 소유자가 겹을 벗기고, J/K는 변경 탭의 파일 이동, 1·2·3은 탭이다. 입력 요소 안에서는 건드리지 않는다.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const inField = (event.target as HTMLElement).closest("input, textarea, [contenteditable]");
    if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "j" || event.key === "k") { if (tab !== "changes") return; event.preventDefault(); stepFile(event.key === "j" ? 1 : -1); return; }
    if (event.key === "1" || event.key === "2" || event.key === "3") { event.preventDefault(); onTab((["details", "changes", "tree"] as const)[Number(event.key) - 1]!); }
  };
  return <div className={`history-inspector${workspace ? " repository-ws-inspector" : ""}${dock?.collapsed ? " is-collapsed" : ""}`} onKeyDown={handleKeyDown}>
    <DockHeader t={t} tab={tab} onTab={onTab} fileCount={files ? files.length : null} shortHash={shortHash} subject={subject} lane={lane} parent={parent} child={dock?.child ?? null} dock={dock} onNavigate={(next) => onSelectCommit({ fullHash: next.fullHash })} onPinCompare={workspace ? onPinCompare : undefined} onClose={onClose} onPreview={onPreview} />
    {!dock?.collapsed && content}
  </div>;
}

/** 커밋 머리 — 본문은 여섯 줄까지 보이고 그 너머는 "더 보기"로 펼친다. 머리가 내용 높이라 파일 목록을 밀어내지 않게. */
function CommitHeader({ meta, entry, fullHash, copied, onCopy, onParent, locale, t }: { readonly meta: CommitResult["meta"]; readonly entry?: LogCommitEntry; readonly fullHash: string; readonly copied: boolean; readonly onCopy: () => void; readonly onParent: (full: string) => void; readonly locale: ConsoleLocale | undefined; readonly t: T }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  // 여섯 줄은 시각적 줄이다 — 줄바꿈 문자를 세면 한 문단짜리 긴 본문이 감겨도 접히지 않는다. 접힌 상태로 그린 뒤 실제 넘침을 잰다.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) { setOverflowing(false); return; }
    const measure = () => setOverflowing(body.scrollHeight > body.clientHeight + 1 || body.classList.contains("is-expanded"));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [meta.body, expanded]);
  const longBody = overflowing;
  return <div className="history-inspector-head"><div className="history-inspector-subject" title={meta.subject}>{meta.subject}</div>{meta.body && <pre ref={bodyRef} className={`history-inspector-message${expanded ? " is-expanded" : " is-clamped"}`}>{meta.body}</pre>}{longBody && <button type="button" className="history-inspector-more" onClick={() => setExpanded((value) => !value)}>{t(expanded ? "repository.dock.showLess" : "repository.dock.showMore")}</button>}<div className="history-author"><span className="history-avatar">{initials(meta.authorName)}</span><span><b>{meta.authorName}</b><small>{meta.authorEmail}</small></span><time title={new Date(meta.authorAt * 1000).toLocaleString(localeTag(locale))}>{formatCommitTime(meta.authorAt, new Date(), locale)}</time></div><div className="history-inspector-ids"><button type="button" className={`history-sha-copy${copied ? " is-copied" : ""}`} onClick={onCopy}>{fullHash}<span>{copied ? t("repository.history.copied") : t("repository.history.copy")}</span></button>{meta.parents.map((parent) => <button type="button" className="history-parent" key={parent.full} onClick={() => onParent(parent.full)}>{t("repository.history.parent", { short: parent.short })}</button>)}</div>{entry && <div className="history-ref-chips">{refBadges(entry).map((badge) => <RefBadgeChip key={`${badge.kind}:${badge.label}`} badge={badge} remoteDescription={badge.hasRemote ? t("repository.history.remoteTracked") : undefined} />)}</div>}</div>;
}
function CommitFiles({ files, truncated, selectedPath, additions, deletions, viewMode, onViewMode, onSelect, t }: { readonly files: readonly DiffFileEntry[]; readonly truncated?: boolean; readonly selectedPath: string | null; readonly additions: number; readonly deletions: number; readonly viewMode: FilesViewMode; readonly onViewMode: (mode: FilesViewMode) => void; readonly onSelect: (file: DiffFileEntry) => void; readonly t: T }) { return <section className="history-commit-files"><div className="history-files-title"><span className="history-files-label">{t("repository.history.changedFiles")}</span><span className="history-files-stats">{files.length} <i>+{additions}</i> <em>−{deletions}</em></span><FilesViewToggle mode={viewMode} onMode={onViewMode} t={t} /></div><div className="history-files-scroll">{viewMode === "tree" ? <DiffTreeView files={files} selectedPath={selectedPath} onSelect={onSelect} /> : files.map((file) => <FileRow key={file.path} entry={file} isSelected={file.path === selectedPath} onSelect={onSelect} t={t} />)}</div>{truncated && <div className="history-truncated">{t("repository.commit.capped")}</div>}</section>; }

interface HistoryPanelProps {
  readonly ctx: RepositoryContext;
  readonly repoRel: string;
  readonly cacheScope?: string;
  readonly externalRefreshToken?: number;
  readonly active?: boolean;
  readonly refFilter?: string | null;
  readonly wipFiles: readonly DiffFileEntry[];
  readonly workspace?: boolean;
  readonly workspaceMain?: ReactNode;
  readonly workspaceMainVisible?: boolean;
  /** 작업 줄의 도구 호스트 — 주어지면 기록 툴바(필터·카운트·정렬·새로고침)를 그 안으로 포털한다. */
  readonly toolbarHost?: HTMLElement | null;
  readonly compareRequest?: { readonly base: string; readonly head: string; readonly baseLabel: string; readonly headLabel: string; readonly seq: number } | null;
  readonly inspectRequest?: { readonly fullHash: string; readonly seq: number } | null;
  readonly stashRequest?: { readonly name: string; readonly sha: string; readonly subject: string; readonly seq: number } | null;
  readonly onStashAction?: (action: "apply" | "pop" | "drop", name: string, sha: string) => Promise<boolean>;
  readonly onReturnToHistory?: () => void;
  readonly onInspectorOpenChange?: (open: boolean) => void;
  readonly onClearRef?: () => void;
  readonly onWip?: () => void;
}

export function HistoryPanel({ ctx, repoRel, cacheScope = `${ctx.theaterId ?? ""}:${repoRel}`, externalRefreshToken = 0, active = true, refFilter = null, wipFiles, workspace = false, workspaceMain, workspaceMainVisible = false, toolbarHost = null, compareRequest, inspectRequest, stashRequest, onStashAction, onReturnToHistory, onInspectorOpenChange, onClearRef, onWip }: HistoryPanelProps) {
  return <HistoryPanelBody key={cacheScope} ctx={ctx} repoRel={repoRel} cacheScope={cacheScope} externalRefreshToken={externalRefreshToken} active={active} refFilter={refFilter} wipFiles={wipFiles} workspace={workspace} workspaceMain={workspaceMain} workspaceMainVisible={workspaceMainVisible} toolbarHost={toolbarHost} compareRequest={compareRequest} inspectRequest={inspectRequest} stashRequest={stashRequest} onStashAction={onStashAction} onReturnToHistory={onReturnToHistory} onInspectorOpenChange={onInspectorOpenChange} onClearRef={onClearRef} onWip={onWip} />;
}

function HistoryPanelBody({ ctx, repoRel, cacheScope, externalRefreshToken, active, refFilter, wipFiles, workspace, workspaceMain, workspaceMainVisible, toolbarHost, compareRequest, inspectRequest, stashRequest, onStashAction, onReturnToHistory, onInspectorOpenChange, onClearRef, onWip }: Required<Pick<HistoryPanelProps, "active" | "cacheScope" | "ctx" | "externalRefreshToken" | "refFilter" | "repoRel" | "wipFiles" | "workspace" | "workspaceMainVisible">> & Pick<HistoryPanelProps, "workspaceMain" | "toolbarHost" | "compareRequest" | "inspectRequest" | "stashRequest" | "onStashAction" | "onReturnToHistory" | "onInspectorOpenChange" | "onClearRef" | "onWip">) {
  const t = getT(ctx.language);
  const [order, setOrder] = useState<LogOrder>(readHistoryOrder);
  // 정렬 축이 바뀌면 커밋 순서와 그래프 레이아웃이 통째로 달라지므로 캐시 슬롯도 분리한다.
  const historyCacheKey = `${cacheScope}::${refFilter ?? ""}::${order}`;
  const searchTarget = useRepositorySearchTarget();
  const pendingSearchTargetHash = searchTarget?.theaterId === ctx.theaterId && searchTarget.repoRel === repoRel ? searchTarget.fullHash : null;
  const [initialRestore] = useState(() => readHistoryCacheRestore(historyCacheKey, pendingSearchTargetHash));
  const [state, setState] = useState<LoadState>(initialRestore?.state ?? { kind: "loading" });
  const [target, setTarget] = useState<CommitTarget | null>(initialRestore?.target ?? null);
  const [pin, setPin] = useState<CompareAnchor | null>(null);
  const [comparePair, setComparePair] = useState<ComparePair | null>(null);
  const [stashTarget, setStashTarget] = useState<{ readonly name: string; readonly sha: string; readonly subject: string } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [filterText, setFilterText] = useState(initialRestore?.filterText ?? "");
  const [refreshToken, setRefreshToken] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [commitViewport, setCommitViewport] = useState({ scrollTop: initialRestore?.scrollTop ?? 0, height: 0 });
  const [logHeight, setLogHeight] = useState(readLogPaneHeight);
  const [tab, setTab] = useState<InspectorTab>("details");
  const [dockHeight, setDockHeight] = useState(() => readWorkspaceDockHeight("details"));
  const [dockDetent, setDockDetent] = useState<WorkspaceDockDetent>("free");
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [dragResult, setDragResult] = useState<WorkspaceDockDragResult | null>(null);
  const [previewHash, setPreviewHash] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const rootHeight = useSeamContainerSize(rootRef, "height");
  const listRef = useRef<HTMLDivElement>(null);
  const commitWindowRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const revealKeyRef = useRef<string | null>(initialRestore?.target ? `${initialRestore.target.fullHash}\x00${initialRestore.filterText}` : null);
  const pendingRevealRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const loadedCacheKeyRef = useRef<string | null>(initialRestore ? historyCacheKey : null);
  const loadedExternalRefreshTokenRef = useRef(externalRefreshToken);
  const loadedCommitsRef = useRef<readonly LogCommitEntry[] | null>(initialRestore?.state.commits ?? null);
  const stateCacheKeyRef = useRef<string | null>(initialRestore ? historyCacheKey : null);
  const restoredScrollTopRef = useRef<number | null>(initialRestore?.scrollTop ?? null);
  const scrollTopRef = useRef(initialRestore?.scrollTop ?? 0);
  const previousFilterTextRef = useRef(filterText);
  const previousRefFilterRef = useRef(refFilter);
  const dragDisposeRef = useRef<(() => void) | null>(null);
  const logHeightRef = useRef(logHeight);
  const dockHeightRef = useRef(dockHeight);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const lastDragRef = useRef<WorkspaceDockDragResult | null>(null);
  const handledCompareRequestSeqRef = useRef(0);
  const handledInspectRequestSeqRef = useRef(0);
  const handledStashRequestSeqRef = useRef(0);
  const generation = useMemo<HistoryLoadGeneration>(() => ({ theaterId: ctx.theaterId, repoRel, refFilter, order, refreshToken: refreshToken + externalRefreshToken }), [ctx.theaterId, externalRefreshToken, order, refFilter, refreshToken, repoRel]);
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const visible = useMemo(() => state.kind === "ok" ? filterHistoryCommits(state.commits, filterText) : [], [filterText, state]);
  const layout = useMemo(() => state.kind === "ok" ? layoutGraph(state.commits) : null, [state]);
  const commitIndexes = useMemo(() => new Map(state.kind === "ok" ? state.commits.map((entry, index) => [entry.fullHash, index]) : []), [state]);
  const setPinFrom = useCallback((anchor: CompareAnchor) => {
    setPin(anchor);
    setTarget(null);
    setComparePair(null);
    setStashTarget(null);
    setAnnounce(t("repository.compare.announcePinned", { short: anchor.shortHash }));
  }, [t]);
  // 독에서 "비교"를 누르면 독은 남고 머리줄이 무장 띠가 된다 — 보던 커밋을 잃지 않는다.
  const armFromDock = useCallback((anchor: CompareAnchor) => {
    setPin(anchor);
    setComparePair(null);
    setStashTarget(null);
    setAnnounce(t("repository.compare.announcePinned", { short: anchor.shortHash }));
  }, [t]);
  const unpin = useCallback(() => {
    setPin(null);
    setAnnounce(t("repository.compare.announceUnpinned"));
  }, [t]);
  const runPair = useCallback((a: CompareAnchor, b: LogCommitEntry) => {
    // 앵커는 shortHash만 들고 다니므로 시각은 적재된 목록에서 되찾는다 — 검사기에서 핀한 경우처럼
    // 호출부가 항목을 쥐고 있지 않은 경로까지 한자리에서 덮는다.
    const anchorIndex = commitIndexes.get(a.fullHash);
    const anchorEntry = state.kind === "ok" && anchorIndex !== undefined ? state.commits[anchorIndex] : undefined;
    const pair = chooseComparePair({ ...a, authorAt: anchorEntry?.authorAt ?? null }, b);
    setComparePair(pair);
    setPin(null);
    setTarget(null);
    setStashTarget(null);
    setAnnounce(t("repository.compare.announceResult", { base: pair.baseLabel, head: pair.headLabel }));
  }, [commitIndexes, state, t]);
  const onRowActivate = useCallback((entry: LogCommitEntry, shiftKey: boolean) => {
    // 기준이 고정돼 있으면 어떤 행이든 한 번의 클릭이 비교를 완성한다 — 무장 띠가 약속한 다음 조작.
    if (pin) {
      if (pin.fullHash === entry.fullHash) unpin(); else runPair(pin, entry);
      return;
    }
    if (!shiftKey) {
      setTarget({ fullHash: entry.fullHash, entry });
      setComparePair(null);
      setStashTarget(null);
      setDockCollapsed(false);
      return;
    }
    if (target && target.fullHash !== entry.fullHash) {
      runPair({ fullHash: target.fullHash, shortHash: target.entry?.shortHash ?? target.fullHash.slice(0, 9) }, entry);
      return;
    }
    setPinFrom({ fullHash: entry.fullHash, shortHash: entry.shortHash });
  }, [pin, runPair, setPinFrom, target, unpin]);
  const onCompareAction = useCallback((entry: LogCommitEntry) => {
    if (!pin) setPinFrom({ fullHash: entry.fullHash, shortHash: entry.shortHash });
    else if (pin.fullHash === entry.fullHash) unpin();
    else runPair(pin, entry);
  }, [pin, runPair, setPinFrom, unpin]);
  const wip = useMemo(() => aggregateWip(wipFiles), [wipFiles]);
  const showWip = shouldShowWip(wip, filterText, refFilter);
  const virtualWindow = calculateHistoryWindow(visible.length, commitViewport.scrollTop, commitViewport.height);
  const windowRows = state.kind === "ok" && layout ? getHistoryWindowRows(commitIndexes, visible, layout, virtualWindow) : [];
  const updateCommitViewport = useCallback(() => {
    const list = listRef.current;
    const commitWindow = commitWindowRef.current;
    if (!list || list.clientHeight <= 0 || list.scrollHeight <= 0) return;
    if (restoredScrollTopRef.current !== null) {
      list.scrollTop = restoredScrollTopRef.current;
      scrollTopRef.current = list.scrollTop;
      restoredScrollTopRef.current = null;
    }
    if (!commitWindow) return;
    const contentTop = commitWindow.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    scrollTopRef.current = list.scrollTop;
    setCommitViewport({
      scrollTop: Math.max(0, list.scrollTop - contentTop),
      height: list.clientHeight,
    });
  }, []);
  useLayoutEffect(() => {
    if (previousFilterTextRef.current === filterText) return;
    previousFilterTextRef.current = filterText;
    const list = listRef.current;
    if (list) list.scrollTop = 0;
    scrollTopRef.current = 0;
    setCommitViewport({ scrollTop: 0, height: list?.clientHeight ?? 0 });
  }, [filterText]);
  useEffect(() => {
    if (previousRefFilterRef.current === refFilter) return;
    previousRefFilterRef.current = refFilter;
    setTarget(null);
  }, [refFilter]);
  useEffect(() => {
    if (!compareRequest || compareRequest.seq === handledCompareRequestSeqRef.current) return;
    handledCompareRequestSeqRef.current = compareRequest.seq;
    setPin(null);
    setTarget(null);
    setStashTarget(null);
    setComparePair({ base: compareRequest.base, head: compareRequest.head, baseLabel: compareRequest.baseLabel, headLabel: compareRequest.headLabel });
    setAnnounce(t("repository.compare.announceResult", { base: compareRequest.baseLabel, head: compareRequest.headLabel }));
  }, [compareRequest, t]);
  useEffect(() => {
    if (!inspectRequest || inspectRequest.seq === handledInspectRequestSeqRef.current) return;
    handledInspectRequestSeqRef.current = inspectRequest.seq;
    setPin(null);
    setComparePair(null);
    setStashTarget(null);
    setTarget({ fullHash: inspectRequest.fullHash });
  }, [inspectRequest]);
  useEffect(() => {
    if (!stashRequest || stashRequest.seq === handledStashRequestSeqRef.current) return;
    handledStashRequestSeqRef.current = stashRequest.seq;
    setPin(null);
    setComparePair(null);
    setTarget(null);
    setStashTarget({ name: stashRequest.name, sha: stashRequest.sha, subject: stashRequest.subject });
  }, [stashRequest]);
  useEffect(() => {
    if (
      !searchTarget
      || searchTarget.theaterId !== ctx.theaterId
      || searchTarget.repoRel !== repoRel
      || state.kind !== "ok"
    ) return;
    const entry = state.commits.find((commit) => commit.fullHash === searchTarget.fullHash);
    if (!entry) return;
    setFilterText("");
    setComparePair(null);
    setStashTarget(null);
    setTarget({ fullHash: entry.fullHash, entry });
    consumeRepositorySearchTarget(searchTarget);
  }, [ctx.theaterId, repoRel, searchTarget, state]);
  useLayoutEffect(() => {
    if (!target) {
      revealKeyRef.current = null;
      pendingRevealRef.current = null;
      return;
    }
    const revealKey = `${target.fullHash}\x00${filterText}`;
    const isNewReveal = revealKeyRef.current !== revealKey;
    if (isNewReveal) {
      revealKeyRef.current = revealKey;
      pendingRevealRef.current = target.fullHash;
    } else if (pendingRevealRef.current !== target.fullHash) {
      return;
    }
    const row = rowRefs.current.get(target.fullHash);
    if (row) {
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
      pendingRevealRef.current = null;
      return;
    }
    const targetIndex = visible.findIndex((entry) => entry.fullHash === target.fullHash);
    const list = listRef.current;
    const commitWindow = commitWindowRef.current;
    if (targetIndex < 0 || !list || !commitWindow) return;
    const contentTop = commitWindow.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const rowTop = contentTop + targetIndex * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
    updateCommitViewport();
  }, [filterText, target, updateCommitViewport, virtualWindow.endIndex, virtualWindow.startIndex, visible]);
  // 숨은 마운트는 상태 보존용일 뿐이므로, 첫 활성화 전에는 log 조회 비용을 지불하지 않는다
  const [everActive, setEverActive] = useState(active);
  useEffect(() => { if (active) setEverActive(true); }, [active]);
  useEffect(() => {
    if (!everActive) return;
    const externalRefreshRequested = loadedExternalRefreshTokenRef.current !== externalRefreshToken;
    loadedExternalRefreshTokenRef.current = externalRefreshToken;
    const preservedExternalScrollTop = externalRefreshRequested
      ? listRef.current?.scrollTop ?? scrollTopRef.current
      : null;
    if (
      !externalRefreshRequested
      && loadedCacheKeyRef.current === historyCacheKey
      && (!pendingSearchTargetHash || loadedCommitsRef.current?.some((commit) => commit.fullHash === pendingSearchTargetHash))
    ) return;
    const restored = externalRefreshRequested ? null : readHistoryCacheRestore(historyCacheKey, pendingSearchTargetHash);
    if (restored) {
      loadedCacheKeyRef.current = historyCacheKey;
      loadedCommitsRef.current = restored.state.commits;
      stateCacheKeyRef.current = historyCacheKey;
      restoredScrollTopRef.current = restored.scrollTop;
      scrollTopRef.current = restored.scrollTop;
      previousFilterTextRef.current = restored.filterText;
      revealKeyRef.current = restored.target ? `${restored.target.fullHash}\x00${restored.filterText}` : null;
      pendingRevealRef.current = null;
      loadingMoreRef.current = false;
      setState(restored.state);
      setComparePair(null);
      setTarget(restored.target);
      setFilterText(restored.filterText);
      setCommitViewport({ scrollTop: restored.scrollTop, height: 0 });
      setLoadingMore(false);
      setLoadMoreError(null);
      return;
    }
    loadedCacheKeyRef.current = null;
    loadedCommitsRef.current = null;
    stateCacheKeyRef.current = null;
    if (!ctx.theaterId) {
      loadedCacheKeyRef.current = historyCacheKey;
      loadedCommitsRef.current = [];
      stateCacheKeyRef.current = historyCacheKey;
      setState({ kind: "ok", commits: [], checkouts: [], hasMore: false, truncated: false });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadMoreError(null);
    ctx.api.fetch("repository", "log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, limit: HISTORY_PAGE_SIZE, skip: 0, order, ...(refFilter ? { ref: refFilter } : {}) }) }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed");
      return response.json() as Promise<LogResult>;
    }).then((data) => {
      if (!cancelled) {
        loadedCacheKeyRef.current = historyCacheKey;
        loadedCommitsRef.current = data.commits;
        stateCacheKeyRef.current = historyCacheKey;
        if (preservedExternalScrollTop !== null) {
          restoredScrollTopRef.current = preservedExternalScrollTop;
          scrollTopRef.current = preservedExternalScrollTop;
        }
        setState({ kind: "ok", commits: data.commits, checkouts: data.checkouts, hasMore: data.hasMore, truncated: data.truncated ?? false });
      }
    }).catch((error: unknown) => {
      if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : "unknown" });
    });
    return () => { cancelled = true; };
  }, [ctx.api, ctx.theaterId, everActive, externalRefreshToken, historyCacheKey, order, pendingSearchTargetHash, refreshToken, refFilter, repoRel]);
  useEffect(() => {
    if (state.kind !== "ok" || stateCacheKeyRef.current !== historyCacheKey) return;
    const list = listRef.current;
    if (!list || list.clientHeight <= 0 || list.scrollHeight <= 0) return;
    writeHistoryCache(historyCacheKey, {
      commits: state.commits,
      checkouts: state.checkouts,
      hasMore: state.hasMore,
      truncated: state.truncated,
      scrollTop: scrollTopRef.current,
      targetHash: target?.fullHash ?? null,
      filterText,
    });
  }, [commitViewport.height, commitViewport.scrollTop, filterText, historyCacheKey, state, target]);
  useEffect(() => { onInspectorOpenChange?.(active && (target !== null || comparePair !== null)); }, [active, comparePair, onInspectorOpenChange, target]);
  // 독이 열리거나 이웃으로 옮겨 가면 선택 행이 한 번 맥동한다 — 목록이 "이 행이다"를 말한다.
  const targetHash = target?.fullHash ?? null;
  useEffect(() => {
    if (!targetHash || !workspace) return;
    const row = rowRefs.current.get(targetHash)?.parentElement;
    if (!row) return;
    row.classList.remove("is-arrived");
    void row.offsetWidth;
    row.classList.add("is-arrived");
    const clear = () => row.classList.remove("is-arrived");
    row.addEventListener("animationend", clear, { once: true });
    return clear;
  }, [targetHash, workspace]); useEffect(() => () => dragDisposeRef.current?.(), []);
  useLayoutEffect(() => {
    updateCommitViewport();
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(updateCommitViewport);
    observer.observe(list);
    return () => observer.disconnect();
  }, [showWip, updateCommitViewport, visible.length, workspaceMainVisible]);
  // 저장된 dock 높이는 현재 컨테이너 기준으로 정규화해 축소된 창에서 주 영역이 잘리지 않게 한다(저장값 자체는 보존).
  useLayoutEffect(() => {
    // 스태시 카드도 같은 독 그리드를 쓴다 — 대상에서 빠지면 축소된 창에서 저장된 높이가 컨테이너를 넘는다.
    if (!workspace || (target === null && comparePair === null && stashTarget === null)) return;
    const root = rootRef.current;
    if (!root) return;
    const normalize = () => {
      const height = root.getBoundingClientRect().height;
      const detents = workspaceDockDetents(height);
      // 정착점에 앉은 독은 창 크기를 따라 정착점 값으로 다시 잰다 — 절반은 계속 절반이다.
      const wanted = dockDetent === "half" ? detents.half : dockDetent === "full" ? detents.full : dockHeightRef.current;
      const next = normalizeWorkspaceDockHeight(wanted, height);
      if (next !== dockHeightRef.current) { dockHeightRef.current = next; setDockHeight(next); }
      // 저장값에서 되살아난 높이가 정착점과 같으면 그 정착점으로 읽는다 — 재마운트 뒤 토글·창 추종이 어긋나지 않게.
      if (dockDetent === "free") { const restored = detentForWorkspaceDockHeight(next, height); if (restored !== "free") setDockDetent(restored); }
    };
    normalize();
    const observer = new ResizeObserver(normalize);
    observer.observe(root);
    return () => observer.disconnect();
  }, [comparePair, dockDetent, stashTarget, workspace, target]);
  // 탭마다 기억한 높이로 옮긴다 — 세부 정보는 절반을 넘지 않고, 변경·파일 트리는 절반 아래로 내려가지 않는다.
  const applyDockForTab = useCallback((nextTab: InspectorTab) => {
    const root = rootRef.current;
    if (!root || !workspace) return;
    const detents = workspaceDockDetents(root.getBoundingClientRect().height);
    const remembered = readWorkspaceDockHeight(nextTab);
    const next = normalizeWorkspaceDockHeight(nextTab === "details" ? Math.min(remembered, detents.half) : Math.max(remembered, detents.half), root.getBoundingClientRect().height);
    dockHeightRef.current = next;
    setDockHeight(next);
    setDockDetent(next === detents.full ? "full" : next === detents.half ? "half" : "free");
  }, [workspace]);
  const chooseTab = useCallback((nextTab: InspectorTab) => {
    if (nextTab === tabRef.current) return;
    saveWorkspaceDockHeight(dockHeightRef.current, tabRef.current);
    setTab(nextTab);
    applyDockForTab(nextTab);
  }, [applyDockForTab]);
  const setDockTo = useCallback((detent: "half" | "full") => {
    const root = rootRef.current;
    if (!root) return;
    const next = workspaceDockDetents(root.getBoundingClientRect().height)[detent];
    dockHeightRef.current = next;
    setDockHeight(next);
    setDockDetent(detent);
    setDockCollapsed(false);
    saveWorkspaceDockHeight(next, tabRef.current);
  }, []);
  const stepDock = useCallback((delta: number) => {
    const root = rootRef.current;
    if (!root) return;
    const height = root.getBoundingClientRect().height;
    const detents = workspaceDockDetents(height);
    const next = normalizeWorkspaceDockHeight(dockHeightRef.current + delta, height);
    dockHeightRef.current = next;
    setDockHeight(next);
    setDockCollapsed(false);
    setDockDetent(next === detents.full ? "full" : next === detents.half ? "half" : "free");
    saveWorkspaceDockHeight(next, tabRef.current);
  }, []);
  const handleDivider = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const start = workspace ? dockHeightRef.current : logHeightRef.current;
    const startY = event.clientY;
    const height = root.getBoundingClientRect().height;
    dragDisposeRef.current?.();
    setIsDragging(true);
    dragDisposeRef.current = installPointerDragLifecycle({
      documentTarget: document,
      windowTarget: window,
      onMove: (moveEvent) => {
        const delta = (moveEvent as PointerEvent).clientY - startY;
        if (workspace) {
          const result = dragWorkspaceDockHeight(start, delta, height);
          if (result === null) return;
          lastDragRef.current = result;
          dockHeightRef.current = result.height;
          setDockHeight(result.height);
          setDragResult(result);
          return;
        }
        const next = clampSplitPaneSize(start, delta, height, HISTORY_LOG_PANE_MIN_HEIGHT, HISTORY_DETAIL_PANE_MIN_HEIGHT, DIFF_DIVIDER_WIDTH);
        if (next === null) return;
        logHeightRef.current = next;
        setLogHeight(next);
      },
      onFinish: () => {
        if (workspace) {
          const result = lastDragRef.current;
          lastDragRef.current = null;
          if (result?.detent === "collapse") {
            // 최소보다 더 끌어내렸다 — 접겠다는 뜻. 높이는 접기 전 값으로 되돌려 펼칠 때 그대로 돌아오게 한다.
            dockHeightRef.current = start;
            setDockHeight(start);
            setDockCollapsed(true);
          } else if (result) {
            const settled = settleWorkspaceDockHeight(result, height);
            dockHeightRef.current = settled;
            setDockHeight(settled);
            setDockDetent(result.detent === "free" ? "free" : result.detent);
            saveWorkspaceDockHeight(settled, tabRef.current);
          }
          setDragResult(null);
        } else {
          try { localStorage.setItem(PREFS_LOG_PANE_HEIGHT, String(logHeightRef.current)); } catch { /* ignore */ }
        }
        setIsDragging(false);
        dragDisposeRef.current = null;
      },
    });
  }, [workspace]);
  const loadMore = useCallback(() => {
    if (state.kind !== "ok" || !state.hasMore || loadingMoreRef.current || !ctx.theaterId) return;
    const requestGeneration = generation;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    ctx.api.fetch("repository", "log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId: ctx.theaterId, repoRel, limit: HISTORY_PAGE_SIZE, skip: state.commits.length, order, ...(refFilter ? { ref: refFilter } : {}) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json() as { readonly error?: string }).error ?? "git_failed");
      return response.json() as Promise<LogResult>;
    }).then((data) => {
      if (!isHistoryGenerationCurrent(requestGeneration, generationRef.current)) return;
      setState((current) => {
        if (current.kind !== "ok") return current;
        const next = appendHistoryPage(current, data, requestGeneration, generationRef.current);
        if (next) {
          loadedCommitsRef.current = next.commits;
          stateCacheKeyRef.current = historyCacheKey;
        }
        return next ?? current;
      });
    }).catch((error: unknown) => {
      if (!isHistoryGenerationCurrent(requestGeneration, generationRef.current)) return;
      setLoadMoreError(error instanceof Error ? error.message : "unknown");
    }).finally(() => {
      if (!isHistoryGenerationCurrent(requestGeneration, generationRef.current)) return;
      loadingMoreRef.current = false;
      setLoadingMore(false);
    });
  }, [ctx.api, ctx.theaterId, generation, historyCacheKey, order, refFilter, repoRel, state]);
  const toggleOrder = useCallback(() => {
    setOrder((current) => {
      const next: LogOrder = current === "topo" ? "date" : "topo";
      saveHistoryOrder(next);
      return next;
    });
  }, []);
  const refreshHistory = useCallback(() => {
    dropHistoryCache(historyCacheKey);
    loadedCacheKeyRef.current = null;
    loadedCommitsRef.current = null;
    stateCacheKeyRef.current = null;
    setRefreshToken((value) => value + 1);
  }, [historyCacheKey]);
  const detailOpen = target !== null || comparePair !== null || stashTarget !== null;
  // 변경 뷰에서는 독이 화면을 따라오지 않는다 — 한 줄 스트립으로 접혀 맥락만 남긴다. 독 자체의 접힘(⌄)도 같은 높이를 쓴다.
  const peekStrip = workspace && workspaceMainVisible && detailOpen;
  const stripCollapsed = workspace && !workspaceMainVisible && detailOpen && dockCollapsed && target !== null && !comparePair;
  const stackTemplate = detailOpen
    ? peekStrip ? "minmax(0, 1fr) auto"
      : stripCollapsed ? buildWorkspaceDockCollapsedTemplate()
        : workspace ? buildWorkspaceDockTemplate(dockHeight) : buildHistoryStackTemplate(logHeight)
    : undefined;
  const closeDetail = () => { setTarget(null); setComparePair(null); setStashTarget(null); setPin(null); setDockCollapsed(false); };
  const peekKindLabel = stashTarget ? t("repository.dock.peekStash") : comparePair ? t("repository.dock.peekCompare") : t("repository.dock.peekCommit");
  const peekBodyLabel = stashTarget ? stashTarget.subject
    : comparePair ? `${comparePair.baseLabel} ↔ ${comparePair.headLabel}`
    : target ? (target.entry?.subject ?? target.fullHash.slice(0, 9))
    : "";
  const peekTabLabel = t(tab === "details" ? "repository.history.details" : tab === "changes" ? "repository.source.changes" : "repository.filetree.tab");
  const targetIndex = target ? commitIndexes.get(target.fullHash) : undefined;
  const targetLane = layout && targetIndex !== undefined ? layout.nodes[targetIndex]?.lane ?? null : null;
  const child = target && state.kind === "ok" ? findLoadedChild(state.commits, target.fullHash) : null;
  const navigateTo = (next: CommitTarget) => {
    const index = commitIndexes.get(next.fullHash);
    const entry = state.kind === "ok" && index !== undefined ? state.commits[index] : undefined;
    setComparePair(null);
    setTarget(entry ? { fullHash: next.fullHash, entry } : next);
  };
  const dockControls: DockControls | null = workspace ? {
    collapsed: dockCollapsed,
    detent: dockDetent,
    arming: pin && target ? { shortHash: pin.shortHash } : null,
    child,
    onCollapse: () => { saveWorkspaceDockHeight(dockHeightRef.current, tabRef.current); setDockCollapsed(true); },
    onExpand: () => setDockCollapsed(false),
    onToggleFull: () => setDockTo(dockDetent === "full" ? "half" : "full"),
    onDisarm: unpin,
  } : null;
  const dragReadout = dragResult
    ? dragResult.limit === "min" && dragResult.detent === "collapse" ? t("repository.dock.detentCollapse")
      : dragResult.limit === "min" ? t("repository.dock.limitMin", { px: WORKSPACE_DOCK_MIN_HEIGHT })
        : dragResult.limit === "max" ? t("repository.dock.limitMax", { px: Math.round(rootRef.current ? workspaceDockDetents(rootRef.current.getBoundingClientRect().height).full : dockHeight) })
          : <>{Math.round(dragResult.height)}px · {rootRef.current ? Math.round(dragResult.height / rootRef.current.getBoundingClientRect().height * 100) : 0}%{dragResult.detent !== "free" && <em>{t(dragResult.detent === "full" ? "repository.dock.detentFull" : "repository.dock.detentHalf")}</em>}</>
    : null;
  const handleRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 겹을 하나씩 벗긴다: 비교 무장 → 검사기/비교 → 핀.
      if (pin && target) { unpin(); event.stopPropagation(); event.preventDefault(); return; }
      if (target || stashTarget) { closeDetail(); event.stopPropagation(); event.preventDefault(); return; }
      if (pin) { unpin(); event.stopPropagation(); event.preventDefault(); return; }
      if (comparePair) { setComparePair(null); event.stopPropagation(); event.preventDefault(); }
      return;
    }
    if (!target || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const parentFull = target.entry?.parents[0];
    const next = event.key === "ArrowUp" ? (parentFull ? { fullHash: parentFull } : null) : child ? { fullHash: child.fullHash } : null;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    navigateTo(next);
  };
  return <div ref={rootRef} className={`history-root${workspace ? " repository-ws-history" : ""}${isDragging ? " is-dragging" : ""}${stripCollapsed ? " is-dock-collapsed" : ""}`} style={stackTemplate ? { gridTemplateRows: stackTemplate } : undefined} onKeyDown={handleRootKeyDown} onTransitionEnd={(event) => { if (event.propertyName !== "grid-template-rows" || !target) return; rowRefs.current.get(target.fullHash)?.scrollIntoView({ block: "nearest" }); }}>
    <div className="history-list-pane" hidden={workspace && workspaceMainVisible}>
      {(() => {
        const toolbar = <div className="history-toolbar"><div className="history-filter"><Icon name="search" size={13} className="repository-discovery-glyph" /><input className="history-filter-input" placeholder={t("repository.common.filterPlaceholder")} value={filterText} onChange={(event) => setFilterText(event.target.value)} />{filterText && <button type="button" className="repository-quiet-button history-filter-clear" aria-label={t("repository.discovery.clearSearch")} onClick={() => setFilterText("")}><Icon name="close" size={12} /></button>}</div>{pin && <button type="button" className="repository-ref-chip repository-pin-chip" title={t("repository.compare.pinnedHint")} onClick={unpin}><Icon name="compare" size={12} />{t("repository.compare.pinnedChip", { short: pin.shortHash })}<Icon name="close" size={11} /></button>}{refFilter && <button type="button" className="repository-ref-chip" title={refFilter} onClick={onClearRef}><Icon name="branch" size={12} />{shortRefName(refFilter)}<Icon name="close" size={11} /></button>}{state.kind === "ok" && <><span className="history-count" title={t("repository.history.countLegend")}>{filterText ? `${visible.length}/${state.commits.length}` : state.commits.length}</span><button type="button" className="repository-quiet-button history-order-toggle" aria-label={t("repository.history.orderToggle")} title={t(order === "topo" ? "repository.history.orderTopoHint" : "repository.history.orderDateHint")} onClick={toggleOrder}><Icon name={order === "topo" ? "branch" : "clock"} size={13} /><span className="history-order-label">{t(order === "topo" ? "repository.history.orderTopo" : "repository.history.orderDate")}</span></button><button type="button" className="repository-quiet-button history-refresh" aria-label={t("repository.history.refresh")} title={t("repository.history.refresh")} onClick={refreshHistory}><Icon name="refresh" /></button></>}<span className="repository-sr-only" role="status">{announce}</span></div>;
        return toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar;
      })()}
      <div ref={listRef} className={`history-list${pin ? " is-arming" : ""}`} onScroll={updateCommitViewport}>{showWip && <button type="button" className="repository-wip-row" onClick={onWip}>{t("repository.history.uncommitted")} <span>{t(wip.files === 1 ? "repository.history.wipStats_one" : "repository.history.wipStats_other", { count: wip.files, additions: wip.additions, deletions: wip.deletions })}</span></button>}{state.kind === "loading" && <div className="history-empty">{t("repository.common.loading")}</div>}{state.kind === "error" && <div className="history-error">{readErrorSentence(t, state.message)}<button type="button" className="repository-refresh-btn" onClick={refreshHistory}>{t("repository.common.retry")}</button></div>}{state.kind === "ok" && state.commits.length === 0 && <div className="history-empty">{t("repository.history.empty")}</div>}{state.kind === "ok" && state.commits.length > 0 && visible.length === 0 && <div className="history-empty">{t("repository.common.noMatchingItems")}</div>}{state.kind === "ok" && layout && visible.length > 0 && <div ref={commitWindowRef} className="history-commit-window"><div className="history-window-spacer" aria-hidden="true" style={{ height: virtualWindow.topSpacerHeight }} />{windowRows.map(({ entry, graphNode }) => <CommitRow key={entry.fullHash} rowRef={(node) => { if (node) rowRefs.current.set(entry.fullHash, node); else rowRefs.current.delete(entry.fullHash); }} entry={entry} checkouts={state.checkouts} selected={target?.fullHash === entry.fullHash} picked={pin?.fullHash === entry.fullHash || comparePair?.base === entry.fullHash || comparePair?.head === entry.fullHash} previewed={previewHash === entry.fullHash} pin={pin} graphNode={graphNode} onRowActivate={onRowActivate} onCompareAction={onCompareAction} locale={ctx.language} />)}<div className="history-window-spacer" aria-hidden="true" style={{ height: virtualWindow.bottomSpacerHeight }} /></div>}{state.kind === "ok" && state.commits.length > 0 && <div className="history-pagination">{state.hasMore ? loadingMore ? <span>{t("repository.history.loadingMore")}</span> : <button type="button" className="repository-refresh-btn" onClick={loadMore}>{t("repository.history.loadMore")}</button> : <><span>{t("repository.history.end")}</span>{state.truncated && <span>{t("repository.history.capped")}</span>}</>}{loadMoreError && <span className="history-pagination-error">{readErrorSentence(t, loadMoreError)}</span>}</div>}</div>
    </div>
    {workspaceMain !== undefined && <div className="repository-ws-main" hidden={!workspaceMainVisible}>{workspaceMain}</div>}
    {peekStrip && <div className="repository-ws-peek">
      <button type="button" className="repository-ws-peek-main" title={t("repository.dock.peekReturn")} onClick={onReturnToHistory}>
        <span className="repository-seam-pill" aria-hidden="true" />
        <span className="repository-dock-dot" aria-hidden="true" style={comparePair ? { background: "var(--aurora)" } : targetLane !== null ? { background: laneColor(targetLane) } : undefined} />
        <span className="repository-ws-peek-kind">{target?.entry?.shortHash ?? peekKindLabel}</span>
        <span className="repository-ws-peek-label">{peekBodyLabel}</span>
        <span className="repository-ws-peek-return" aria-hidden="true"><b>{t("repository.dock.peekReturnTo")}</b>{target && <> · {peekTabLabel}</>}</span>
      </button>
      <button type="button" className="repository-ws-peek-close" aria-label={t("repository.dock.peekClose")} title={t("repository.dock.peekClose")} onClick={closeDetail}><Icon name="close" /></button>
    </div>}
    {detailOpen && !peekStrip && <>
      {stripCollapsed
        ? null
        : <SplitSeam orientation="horizontal" className="repository-ws-dock-seam" label={workspace ? t("repository.history.resizeDock") : t("repository.history.resizeLog")} value={workspace ? dockHeight : logHeight} min={WORKSPACE_DOCK_MIN_HEIGHT} max={workspace && rootHeight !== undefined ? workspaceDockDetents(rootHeight).full : undefined} dragging={isDragging} readout={dragReadout} limit={dragResult?.limit !== null && dragResult?.limit !== undefined} onPointerDown={handleDivider} onStep={workspace ? stepDock : undefined} onJump={workspace ? (edge) => setDockTo(edge === "start" ? "half" : "full") : undefined} onToggle={workspace ? () => setDockTo(dockDetent === "full" ? "half" : "full") : undefined} />}
      <div className="history-inspector-shelf">{comparePair ? <CompareInspector ctx={ctx} repoRel={repoRel} pair={comparePair} onSwap={() => setComparePair({ base: comparePair.head, head: comparePair.base, baseLabel: comparePair.headLabel, headLabel: comparePair.baseLabel })} onClose={() => setComparePair(null)} /> : target ? <CommitInspector ctx={ctx} repoRel={repoRel} target={target} workspace={workspace} tab={tab} onTab={chooseTab} lane={targetLane} dock={dockControls} onSelectCommit={navigateTo} onPinCompare={() => armFromDock({ fullHash: target.fullHash, shortHash: target.entry?.shortHash ?? target.fullHash.slice(0, 9) })} onClose={closeDetail} onPreview={setPreviewHash} /> : stashTarget ? <StashInspector ctx={ctx} repoRel={repoRel} stash={stashTarget} workspace={workspace} onAction={onStashAction} onClose={() => setStashTarget(null)} /> : null}</div>
    </>}
  </div>;
}
function readLogPaneHeight(): number { return readSize(PREFS_LOG_PANE_HEIGHT, LOG_PANE_DEFAULT_HEIGHT, HISTORY_LOG_PANE_MIN_HEIGHT); }
function readSize(key: string, fallback: number, minimum = 0): number { try { const value = Number.parseFloat(localStorage.getItem(key) ?? ""); if (Number.isFinite(value) && value >= minimum) return value; } catch { /* ignore */ } return fallback; }
function initials(name: string): string { return name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("") || "?"; }
function HistoryIcon() { return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 3v12M10 7v8M14 11v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /><path d="M5 7c1.8 0 2.4 0 5 0M10 11c1.4 0 2.2 0 4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>; }
