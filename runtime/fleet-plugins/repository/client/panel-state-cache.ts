import type { DiffFileEntry } from "../server/types.js";

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

export type CompareResultSnapshot =
  | { readonly kind: "ok"; readonly base: string; readonly head: string; readonly files: readonly DiffFileEntry[]; readonly mergeBase?: string; readonly truncated?: boolean }
  | { readonly kind: "notice"; readonly reason: "no_git_repo" | "git_unavailable" }
  | { readonly kind: "error"; readonly message: string };

export interface CompareViewState {
  readonly result: CompareResultSnapshot | null;
  readonly selectedPath: string | null;
  readonly listPaneWidth: number;
  readonly scrollTop: number;
}

const workspaceTreeCache = new Map<string, WorkspaceTreeState>();
const repoViewCache = new Map<string, RepoViewState>();
const compareViewCache = new Map<string, CompareViewState>();

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
const compareViewKey = (theaterId: string, repoRel: string): string => `compare::${theaterId}::${repoRel}`;

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

export function readCompareViewState(theaterId: string, repoRel: string): CompareViewState | null {
  return readCacheEntry(compareViewCache, compareViewKey(theaterId, repoRel));
}

export function writeCompareViewState(theaterId: string, repoRel: string, entry: CompareViewState): void {
  writeCacheEntry(compareViewCache, compareViewKey(theaterId, repoRel), entry);
}

export function dropCompareViewState(theaterId: string, repoRel: string): void {
  compareViewCache.delete(compareViewKey(theaterId, repoRel));
}
