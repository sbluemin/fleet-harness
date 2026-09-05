import { useSyncExternalStore } from "react";

import type { DiffFileEntry, LogCommitEntry, LogOrder, WorktreeCheckout } from "../server/types.js";

// ═══ history-order-preference ════════════════════════════════════════════════

const HISTORY_ORDER_KEY = "fleet-console.history.order";

/** 저장된 값이 없거나 알아볼 수 없으면 topo — 브랜치 체인이 끊기지 않는 쪽이 기본이다. */
export function readHistoryOrder(): LogOrder {
  try {
    return localStorage.getItem(HISTORY_ORDER_KEY) === "date" ? "date" : "topo";
  } catch {
    return "topo";
  }
}

export function saveHistoryOrder(order: LogOrder): void {
  try {
    localStorage.setItem(HISTORY_ORDER_KEY, order);
  } catch { /* ignore */ }
}

// ═══ history-cache ═══════════════════════════════════════════════════════════

// 이 캐시는 host와 상태를 조율하지 않고 repository 플러그인 client 번들 안에서만 재마운트 상태를 잇는다.
// 따라서 host/plugin이 별도 모듈 사본을 로드할 수 있는 경계에서도 모듈 스코프 저장소가 안전하다.
export const HISTORY_CACHE_LIMIT = 4;

export interface HistoryCacheEntry {
  readonly commits: readonly LogCommitEntry[];
  readonly checkouts: readonly WorktreeCheckout[];
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly scrollTop: number;
  readonly targetHash: string | null;
  readonly filterText: string;
}

const historyCache = new Map<string, HistoryCacheEntry>();

export function readHistoryCache(scope: string): HistoryCacheEntry | null {
  const entry = historyCache.get(scope);
  if (!entry) return null;
  historyCache.delete(scope);
  historyCache.set(scope, entry);
  return entry;
}

export function writeHistoryCache(scope: string, entry: HistoryCacheEntry): void {
  historyCache.delete(scope);
  historyCache.set(scope, entry);
  if (historyCache.size <= HISTORY_CACHE_LIMIT) return;
  const oldest = historyCache.keys().next().value;
  if (oldest !== undefined) historyCache.delete(oldest);
}

export function dropHistoryCache(scope: string): void {
  historyCache.delete(scope);
}

export function dropHistoryCacheForRepository(scope: string): void {
  for (const key of historyCache.keys()) {
    if (key === scope || key.startsWith(`${scope}::`)) historyCache.delete(key);
  }
}

// ═══ panel-state-cache ═══════════════════════════════════════════════════════

// 이 캐시는 host와 상태를 조율하지 않고 repository 플러그인 client 번들 안에서만 재마운트 상태를 잇는다.
// 따라서 host/plugin이 별도 모듈 사본을 로드할 수 있는 경계에서도 모듈 스코프 저장소가 안전하다.
export const PANEL_STATE_CACHE_LIMIT = 8;

export interface WorkspaceTreeState {
  readonly query: string;
  readonly collapsedSections: readonly string[];
  readonly collapsedFolders: readonly string[];
  readonly scrollTop: number;
}

export interface RepoViewState {
  readonly filterText: string;
  readonly refFilter: string | null;
  readonly scrollTop: number;
  readonly collapsedFolders: readonly string[];
}

export interface CommitDraft {
  readonly subject: string;
  readonly body: string;
  readonly amend: boolean;
}

// 초안은 플러그인 번들의 메모리에만 둔다. 체크아웃 전환과 패널 재개방은 넘지만 디스크에는 쓰지 않는다.
const commitDrafts = new Map<string, CommitDraft>();
const commitDraftKey = (theaterId: string, repoRel: string): string => JSON.stringify([theaterId, repoRel]);

export function readCommitDraft(theaterId: string, repoRel: string): CommitDraft | undefined {
  return commitDrafts.get(commitDraftKey(theaterId, repoRel));
}

export function writeCommitDraft(theaterId: string, repoRel: string, draft: CommitDraft): void {
  const key = commitDraftKey(theaterId, repoRel);
  if (!draft.subject && !draft.body && !draft.amend) commitDrafts.delete(key);
  else commitDrafts.set(key, draft);
}

const workspaceTreeCache = new Map<string, WorkspaceTreeState>();
const repoViewCache = new Map<string, RepoViewState>();

function readCacheEntry<T>(cache: Map<string, T>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCacheEntry<T>(cache: Map<string, T>, key: string, entry: T): void {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= PANEL_STATE_CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

const workspaceTreeKey = (theaterId: string): string => `tree::${theaterId}`;
const repoViewKey = (theaterId: string, repoRel: string): string => `view::${theaterId}::${repoRel}`;

export function readWorkspaceTreeState(theaterId: string): WorkspaceTreeState | null {
  return readCacheEntry(workspaceTreeCache, workspaceTreeKey(theaterId));
}

export function writeWorkspaceTreeState(theaterId: string, entry: WorkspaceTreeState): void {
  writeCacheEntry(workspaceTreeCache, workspaceTreeKey(theaterId), entry);
}

export function dropWorkspaceTreeState(theaterId: string): void {
  workspaceTreeCache.delete(workspaceTreeKey(theaterId));
}

export function readRepoViewState(theaterId: string, repoRel: string): RepoViewState | null {
  return readCacheEntry(repoViewCache, repoViewKey(theaterId, repoRel));
}

export function writeRepoViewState(theaterId: string, repoRel: string, entry: RepoViewState): void {
  writeCacheEntry(repoViewCache, repoViewKey(theaterId, repoRel), entry);
}

export function dropRepoViewState(theaterId: string, repoRel: string): void {
  repoViewCache.delete(repoViewKey(theaterId, repoRel));
}

// ═══ repository-view-store ═══════════════════════════════════════════════════

// ─── types ───────────────────────────────────────────────────────────────────

export interface SelectedFile {
  readonly entry: DiffFileEntry;
  readonly theaterId: string;
  readonly repoRel: string;
}

interface DiffViewState {
  readonly file: SelectedFile | null;
}

type DiffViewListener = () => void;

// ─── constants ───────────────────────────────────────────────────────────────

const diffViewListeners = new Set<DiffViewListener>();

let diffViewState: DiffViewState = { file: null };

// ─── functions ───────────────────────────────────────────────────────────────

function emitDiffView(): void {
  for (const listener of diffViewListeners) listener();
}

function subscribeDiffView(listener: DiffViewListener): () => void {
  diffViewListeners.add(listener);
  return () => { diffViewListeners.delete(listener); };
}

function getDiffViewSnapshot(): DiffViewState {
  return diffViewState;
}

export function getSelectedFile(theaterId: string | null, repoRel: string): SelectedFile | null {
  if (!diffViewState.file || diffViewState.file.theaterId !== theaterId || diffViewState.file.repoRel !== repoRel) return null;
  return diffViewState.file;
}

export function setSelectedFile(entry: DiffFileEntry, theaterId: string, repoRel: string): void {
  diffViewState = { file: { entry, theaterId, repoRel } };
  emitDiffView();
}

export function clearSelectedFile(): void {
  diffViewState = { file: null };
  emitDiffView();
}

// ═══ search-navigation ═══════════════════════════════════════════════════════

export interface RepositorySearchTarget {
  readonly theaterId: string;
  readonly repoRel: string;
  readonly fullHash: string;
  readonly requestId: number;
}

type SearchNavigationListener = () => void;

const searchNavigationListeners = new Set<SearchNavigationListener>();
let repositorySearchRequestId = 0;
let repositorySearchTarget: RepositorySearchTarget | null = null;

export function activateRepositorySearchTarget(theaterId: string, repoRel: string, fullHash: string): void {
  repositorySearchTarget = { theaterId, repoRel, fullHash, requestId: ++repositorySearchRequestId };
  emitSearchNavigation();
}

export function consumeRepositorySearchTarget(expected: RepositorySearchTarget): void {
  if (repositorySearchTarget?.requestId !== expected.requestId) return;
  repositorySearchTarget = null;
  emitSearchNavigation();
}

export function useRepositorySearchTarget(): RepositorySearchTarget | null {
  return useSyncExternalStore(subscribeSearchNavigation, getSearchNavigationSnapshot, getSearchNavigationSnapshot);
}

function subscribeSearchNavigation(listener: SearchNavigationListener): () => void {
  searchNavigationListeners.add(listener);
  return () => { searchNavigationListeners.delete(listener); };
}

function getSearchNavigationSnapshot(): RepositorySearchTarget | null {
  return repositorySearchTarget;
}

function emitSearchNavigation(): void {
  for (const listener of searchNavigationListeners) listener();
}

