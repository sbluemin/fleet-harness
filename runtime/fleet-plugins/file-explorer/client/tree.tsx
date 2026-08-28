import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { GitFileStatus, GitStatusResult } from "../server/tree-services.js";
import type { FileSearchItem, FileSearchResult, FolderEntry, FolderListResult } from "../server/types.js";
import { contextMenuAnchorFromRowRect, isTreeContextMenuKey, resolveContextMenuKeyboardAction, restoreContextMenuFocus } from "./context-menu.js";
import type { FileExplorerMessageKey } from "./i18n/index.js";
import { translateServerError } from "./i18n/index.js";
import type { FileSearchTarget } from "./search-navigation.js";

import { FileIcon, FolderIcon } from "./file-icon.js";
export interface PluginFilesClient {
  readonly listFolder: (relativePath?: string) => Promise<FolderListResult>;
}

interface FileTreeProps {
  readonly contextKey: string;
  readonly files: PluginFilesClient;
  readonly theaterId: string | null;
  readonly selectedPath: string | null;
  readonly revealTarget?: FileSearchTarget | null;
  readonly onSelect: (entry: FolderEntry) => void;
  readonly onSearchSelect?: (item: FileSearchItem) => void;
  readonly onContextMenu: (entry: FolderEntry, x: number, y: number) => void;
  readonly onEntriesRefreshed?: (result: FolderListResult) => void;
  /** 뷰어가 열어 둔 문서들의 부모 폴더 — 펼침 여부와 무관하게 변경을 지켜본다. */
  readonly watchedDirectories?: readonly string[];
  readonly t: Translate<FileExplorerMessageKey>;
}

export interface FileTreeHandle {
  readonly restoreContextMenuFocus: (relativePath: string) => HTMLElement | null;
  /** "/" 단축키의 착지점 — 패널 루트가 잡은 키를 필터 입력으로 넘긴다. */
  readonly focusFilter: () => void;
}

export interface FlatRow {
  readonly entry: FolderEntry;
  readonly depth: number;
  readonly isSelected: boolean;
  readonly isExpanded: boolean;
  readonly isLoading: boolean;
}

/** 목록 상한에 잘린 폴터 끝에 붙는 표식 행 — 포커스/선택 대상이 아니다. */
export interface CapRow {
  readonly type: "cap";
  readonly depth: number;
  readonly cap: number;
  readonly key: string;
}

/** VCS 날것(.git 등)이 숨겨졌음을 이름으로 밝히는 muted 행 — 펼침/포커스 불가. */
export interface VcsRow {
  readonly type: "vcs";
  readonly name: string;
  readonly depth: number;
  readonly key: string;
}

/** 작업 트리에서 삭제된 파일의 합성 행 — 실제 목록에 없으므로 정보 표시 전용, 포커스 불가. */
export interface GhostRow {
  readonly type: "ghost";
  readonly name: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly key: string;
}

/** 첫 펼침이 실패한 폴더 아래의 인라인 재시도 행 — 포커스/선택 대상이 아니다. */
export interface ExpandErrorRow {
  readonly type: "error";
  readonly relativePath: string;
  readonly depth: number;
  readonly key: string;
}

export type EntryRow = FlatRow & { readonly type: "entry" };
export type TreeRow = EntryRow | CapRow | VcsRow | GhostRow | ExpandErrorRow;

export function isEntryRow(row: TreeRow): row is EntryRow {
  return row.type === "entry";
}

function firstEntryPath(rows: readonly TreeRow[]): string | null {
  return rows.find(isEntryRow)?.entry.relativePath ?? null;
}

function hasEntryPath(rows: readonly TreeRow[], path: string | null): boolean {
  return path !== null && rows.some((row) => isEntryRow(row) && row.entry.relativePath === path);
}

export type TreeNavigationAction =
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "expand" }
  | { readonly kind: "collapse" }
  | { readonly kind: "activate" }
  | { readonly kind: "openMenu" }
  | { readonly kind: "none" };

export interface TreeNavigationOptions {
  readonly pageSize?: number;
  readonly shiftKey?: boolean;
}

const VIRTUALIZE_THRESHOLD = 200;
export const ROW_HEIGHT = 30;
export const TREE_PADDING_Y = 8;
const OVERSCAN = 5;
const PREFS_SHOW_HIDDEN = "fleet-console.fileExplorer.showHidden";
const PREFS_SORT_MODE = "fleet-console.fileExplorer.sortMode";
const PREFS_EXPANDED_PREFIX = "fleet-console.fileExplorer.expanded.";
/** Persist and restore share one cap so a saved expansion is always re-fetched. */
export const EXPANDED_PERSIST_CAP = 200;
/** 복원·재조회 팬아웃 동시 실행 상한 — 상한 없는 팬아웃은 필터에서 걷어낸 요청 폭주와 같은 것이다. */
export const FOLDER_FETCH_CONCURRENCY = 6;
const GIT_STATUS_DEBOUNCE_MS = 500;
export const FILTER_SEARCH_DEBOUNCE_MS = 180;
export const PALETTE_SEARCH_LIMIT = 200;
/** i18n cap interpolation for walkCapped — matches the server directory walk budget. */
const PALETTE_SEARCH_WALK_CAP = 500;
const TYPEAHEAD_RESET_MS = 1000;

// ═══ 정렬 ═══════════════════════════════════════════════════════════════════

export type SortMode = "name" | "modified" | "size";

/** 정렬 메뉴가 열거하는 전체 선택지 — 순환 버튼이 아니라 메뉴가 현재 값과 함께 보여준다. */
export const SORT_MODES: readonly SortMode[] = ["name", "modified", "size"];

/**
 * 한 수준의 엔트리를 정렬한다. 디렉터리는 항상 파일보다 앞이다.
 * name — 서버 순서(이미 dirs-first 이름순)를 그대로 쓴다.
 * modified — 최신 우선. 메타 없는 항목은 이름순 꼬리로 보낸다.
 * size — 파일은 큰 것 우선, 디렉터리는 이름순(크기 신호가 없다).
 */
export function sortEntries(entries: readonly FolderEntry[], mode: SortMode): readonly FolderEntry[] {
  if (mode === "name") return entries;
  const byName = (a: FolderEntry, b: FolderEntry) => a.name.localeCompare(b.name);
  const byMeta = (metaOf: (entry: FolderEntry) => number | undefined) =>
    (a: FolderEntry, b: FolderEntry): number => {
      const am = metaOf(a);
      const bm = metaOf(b);
      if (am === undefined && bm === undefined) return byName(a, b);
      if (am === undefined) return 1;
      if (bm === undefined) return -1;
      return bm - am || byName(a, b);
    };
  const dirs = entries.filter((entry) => entry.kind === "dir");
  const files = entries.filter((entry) => entry.kind !== "dir");
  if (mode === "modified") {
    const compare = byMeta((entry) => entry.mtimeMs);
    return [...dirs.slice().sort(compare), ...files.slice().sort(compare)];
  }
  return [...dirs, ...files.slice().sort(byMeta((entry) => entry.sizeBytes))];
}

export interface GitStatusBadge {
  readonly text: "M" | "U" | "D";
  readonly status: GitFileStatus;
  readonly messageKey:
    | "fileExplorer.git.modified"
    | "fileExplorer.git.untracked"
    | "fileExplorer.git.deleted";
}

export function mapGitStatusBadge(status: GitFileStatus | undefined): GitStatusBadge | null {
  if (status === "modified") {
    return { text: "M", status, messageKey: "fileExplorer.git.modified" };
  }
  if (status === "untracked") {
    return { text: "U", status, messageKey: "fileExplorer.git.untracked" };
  }
  if (status === "deleted") {
    return { text: "D", status, messageKey: "fileExplorer.git.deleted" };
  }
  return null;
}

export function triggerManualRefresh(
  refreshTree: () => void,
  refreshGitStatus: () => void | Promise<void>,
): void {
  refreshTree();
  void refreshGitStatus();
}

export function isCurrentContextRequest(requestContextKey: string, currentContextKey: string): boolean {
  return requestContextKey === currentContextKey;
}

export type FolderExpandFetch = "none" | "foreground" | "background";

export interface FolderExpandPlan {
  readonly nextExpanded: boolean;
  readonly fetch: FolderExpandFetch;
}

/** 접힘→펼침은 캐시가 있으면 즉시 그리고, 진행 중 요청은 합류한다. */
export function planFolderExpand(
  isCurrentlyExpanded: boolean,
  hasCachedResult: boolean,
  isInFlight: boolean,
): FolderExpandPlan {
  if (isCurrentlyExpanded) return { nextExpanded: false, fetch: "none" };
  if (isInFlight) return { nextExpanded: true, fetch: "none" };
  if (hasCachedResult) return { nextExpanded: true, fetch: "background" };
  return { nextExpanded: true, fetch: "foreground" };
}

// 탭 복귀 시 git 배지를 다시 읽을지 판정한다 — 외부 터미널의 add/commit 같은
// git 메타데이터 전용 변경은 fs.watch가 감지하지 못하므로 focus 복귀가 갱신 기회다.
export function shouldRefreshGitStatusOnVisibility(visibilityState: string): boolean {
  return visibilityState === "visible";
}

export type FileSearchScope = "files" | "contents";

export function paletteSearchRequestBody(
  theaterId: string,
  query: string,
  showHidden: boolean,
  scope: FileSearchScope = "files",
): {
  readonly theaterId: string;
  readonly query: string;
  readonly limit: number;
  readonly includeHidden: boolean;
  readonly scope: FileSearchScope;
  readonly kinds: readonly ["file"];
} {
  // 숨김 제외는 서버에서 후보를 만들기 전에 걸러야 한다. 내용 검색도 파일만 반환한다.
  return { theaterId, query, limit: PALETTE_SEARCH_LIMIT, includeHidden: showHidden, scope, kinds: ["file"] };
}

export function shouldClearFilterOnEscape(filterText: string): boolean {
  return filterText.length > 0;
}

function isWatchDegraded(state: string): boolean {
  return state === "degraded";
}

function parentRelativePath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
}

function nameOfRelativePath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? relativePath : relativePath.slice(slash + 1);
}

function expandedDepth(relativePath: string): number {
  if (!relativePath) return 0;
  return relativePath.split("/").length;
}

/**
 * 상한 있는 팬아웃 — paths를 최대 limit개씩만 동시에 처리한다.
 * 200개 펼침을 복원할 때 200개 POST를 한꺼번에 던지지 않기 위한 것이며,
 * 실패한 항목은 각 작업이 자체적으로 삼킨다(호출부 계약 유지).
 */
export async function runWithConcurrency(
  paths: readonly string[],
  limit: number,
  run: (path: string) => Promise<void>,
): Promise<void> {
  if (paths.length === 0) return;
  const width = Math.max(1, Math.min(limit, paths.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= paths.length) return;
      const path = paths[index];
      if (path === undefined) return;
      await run(path);
    }
  });
  await Promise.all(workers);
}

/** Shallowest-first, then name, truncated to the shared persist/restore cap. */
export function selectPersistableExpanded(
  expandedDirs: Iterable<string>,
  cap = EXPANDED_PERSIST_CAP,
): string[] {
  return [...expandedDirs]
    .sort((left, right) => {
      const depthDelta = expandedDepth(left) - expandedDepth(right);
      return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
    })
    .slice(0, cap);
}

export interface VirtualRowWindow {
  readonly startIdx: number;
  readonly endIdx: number;
  readonly offsetY: number;
  readonly totalHeight: number;
}

export function virtualRowWindow(
  scrollTop: number,
  containerHeight: number,
  rowCount: number,
): VirtualRowWindow {
  const contentScroll = scrollTop - TREE_PADDING_Y;
  const startIdx = Math.max(0, Math.floor(contentScroll / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(rowCount, Math.ceil((contentScroll + containerHeight) / ROW_HEIGHT) + OVERSCAN);
  return {
    startIdx,
    endIdx,
    offsetY: startIdx * ROW_HEIGHT,
    totalHeight: rowCount * ROW_HEIGHT,
  };
}

interface FilterTrieNode {
  readonly name: string;
  readonly relativePath: string;
  kind: "dir" | "file";
  readonly children: Map<string, FilterTrieNode>;
}

function ensureFilterNode(
  nodes: Map<string, FilterTrieNode>,
  name: string,
  relativePath: string,
  kind: "dir" | "file",
): FilterTrieNode {
  const existing = nodes.get(name);
  if (!existing) {
    const created: FilterTrieNode = { name, relativePath, kind, children: new Map() };
    nodes.set(name, created);
    return created;
  }
  if (kind === "dir") existing.kind = "dir";
  return existing;
}

function insertFilterPath(
  root: Map<string, FilterTrieNode>,
  relativePath: string,
  leafKind: "dir" | "file",
): void {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length === 0) return;
  let current = root;
  let prefix = "";
  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index] ?? "";
    prefix = prefix ? `${prefix}/${name}` : name;
    const isLeaf = index === parts.length - 1;
    const node = ensureFilterNode(current, name, prefix, isLeaf ? leafKind : "dir");
    current = node.children;
  }
}

function entriesFromTrie(nodes: Map<string, FilterTrieNode>): FolderEntry[] {
  const entries: FolderEntry[] = [...nodes.values()].map((node) => ({
    name: node.name,
    relativePath: node.relativePath,
    kind: node.kind,
  }));
  const byName = (left: FolderEntry, right: FolderEntry) => left.name.localeCompare(right.name);
  return [
    ...entries.filter((entry) => entry.kind === "dir").sort(byName),
    ...entries.filter((entry) => entry.kind !== "dir").sort(byName),
  ];
}

function folderResultFromEntries(relativePath: string, entries: readonly FolderEntry[]): FolderListResult {
  return {
    relativePath,
    parentRelativePath: relativePath === "" ? null : parentRelativePath(relativePath),
    entries,
  };
}

export interface SynthesizedFilterTree {
  readonly rootEntries: FolderEntry[];
  readonly childResults: Map<string, FolderListResult>;
}

/** Build a dirs-first tree from palette-search hits so matches stay in ancestor form. */
export function synthesizeFilterTree(
  matches: readonly FileSearchItem[],
  extraDirs: readonly string[] = [],
): SynthesizedFilterTree {
  const root = new Map<string, FilterTrieNode>();
  for (const dirPath of extraDirs) insertFilterPath(root, dirPath, "dir");
  for (const match of matches) insertFilterPath(root, match.relativePath, match.kind);
  const childResults = new Map<string, FolderListResult>();
  const visit = (nodes: Map<string, FilterTrieNode>, relativePath: string | null) => {
    const entries = entriesFromTrie(nodes);
    if (relativePath !== null) childResults.set(relativePath, folderResultFromEntries(relativePath, entries));
    for (const node of nodes.values()) {
      if (node.kind === "dir") visit(node.children, node.relativePath);
    }
  };
  visit(root, null);
  // Directory hits with no synthesized children still need an empty listing so auto-expand
  // can distinguish "fetched" dirs from "not yet listed" ones.
  for (const match of matches) {
    if (match.kind !== "dir" || childResults.has(match.relativePath)) continue;
    childResults.set(match.relativePath, folderResultFromEntries(match.relativePath, []));
  }
  for (const dirPath of extraDirs) {
    if (childResults.has(dirPath)) continue;
    childResults.set(dirPath, folderResultFromEntries(dirPath, []));
  }
  return { rootEntries: entriesFromTrie(root), childResults };
}

export interface GitDirRollup {
  readonly modified: number;
  readonly untracked: number;
  readonly deleted: number;
  readonly total: number;
}

export function rollupGitStatuses(
  statuses: ReadonlyMap<string, GitFileStatus>,
): ReadonlyMap<string, GitDirRollup> {
  const rollups = new Map<string, { modified: number; untracked: number; deleted: number; total: number }>();
  for (const [filePath, status] of statuses) {
    const normalized = filePath.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join("/");
      const current = rollups.get(dir) ?? { modified: 0, untracked: 0, deleted: 0, total: 0 };
      current[status] += 1;
      current.total += 1;
      rollups.set(dir, current);
    }
  }
  return rollups;
}

/** 트리 들여쓰기 지오메트리 — 행 높이 30px·수준당 16px 계약과 함께 가상화가 기대는 상수다. */
export const TREE_INDENT_PX = 16;
export const TREE_BASE_PADDING_PX = 12;
/** 인덴트 가이드 세로선의 좌측 오프셋(px) — 각 조상 수준의 chevron 열 중앙 아래에 선다. */
export function treeGuideOffsets(depth: number): number[] {
  return Array.from({ length: Math.max(0, depth) }, (_, level) => TREE_BASE_PADDING_PX + level * TREE_INDENT_PX + 5);
}

/**
 * type-ahead가 소비하는 키인지 — 한 글자 printable만.
 * "/"는 제외한다: 파일 이름에 들어갈 수 없는 경로 구분자이고, 필터 포커스 단축키가 이 키를 쓴다.
 */
export function isTypeaheadKey(
  key: string,
  modifiers: { readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean },
): boolean {
  return key.length === 1
    && key !== " "
    && key !== "/"
    && !modifiers.ctrlKey
    && !modifiers.metaKey
    && !modifiers.altKey;
}

/** 필터 포커스 단축키 판정 — 입력 계열 요소 위에서는 글자 입력을 가로채지 않는다. */
export function isFilterFocusShortcut(key: string, target: EventTarget | null): boolean {
  if (key !== "/") return false;
  if (!(target instanceof HTMLElement)) return true;
  return !(target instanceof HTMLInputElement)
    && !(target instanceof HTMLTextAreaElement)
    && !target.isContentEditable;
}

export function resolveTypeaheadIndex(
  rows: readonly TreeRow[],
  currentIndex: number,
  buffer: string,
): number | null {
  const needle = buffer.toLowerCase();
  if (!needle) return null;
  const matches: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row && isEntryRow(row) && row.entry.name.toLowerCase().startsWith(needle)) matches.push(index);
  }
  if (matches.length === 0) return null;
  return matches.find((index) => index > currentIndex) ?? matches[0] ?? null;
}

function pagedEntryIndex(
  rows: readonly TreeRow[],
  index: number,
  direction: 1 | -1,
  pageSize: number,
): number {
  const entryIndices: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.type === "entry") entryIndices.push(i);
  }
  if (entryIndices.length === 0) return index;
  const position = entryIndices.indexOf(index);
  const from = position < 0 ? 0 : position;
  const next = Math.max(0, Math.min(entryIndices.length - 1, from + direction * pageSize));
  return entryIndices[next] ?? index;
}

interface LevelMeta {
  /** 이 수준의 목록이 상한에서 잘린 경우의 상한 값 */
  readonly truncatedCap?: number;
  /** 이 수준에서 숨겨진 VCS 날것 이름 (.git 등) */
  readonly hiddenVcs?: readonly string[];
}

export interface BuildRowsOptions {
  readonly sortMode?: SortMode;
  /** 부모 폴더 상대경로("" = 루트) → 그 폴더에서 삭제된 파일 이름들. 고스트 행으로 합성된다. */
  readonly deletedByDir?: ReadonlyMap<string, readonly string[]>;
  /** 필터 합성 트리 — 자식 목록이 있는 디렉터리를 기본 펼친다. */
  readonly autoExpandAll?: boolean;
  /** 첫 펼침이 실패한 디렉터리. 펼친 채로 인라인 오류 행을 붙인다. */
  readonly failedDirs?: ReadonlySet<string>;
}

export function buildFlatRows(
  entries: readonly FolderEntry[],
  depth: number,
  selectedPath: string | null,
  expandedDirs: Set<string>,
  loadingDirs: Set<string>,
  childResults: Map<string, FolderListResult>,
  low: string,
  showHidden: boolean,
  ancestorFolders: ReadonlySet<string> = new Set(),
  filterCollapsedDirs: ReadonlySet<string> = new Set(),
  levelMeta: LevelMeta = {},
  levelKey = "",
  options: BuildRowsOptions = {},
): TreeRow[] {
  const rows: TreeRow[] = [];
  const sortMode = options.sortMode ?? "name";
  // VCS 표식 행은 디렉터리 구간에 이름순으로 끼워 넣는다 — 숨김 파일 표시 중이고 필터링이 아닐 때만.
  // 이름순이 아닌 정렬에서는 끼워 넣을 기준이 없으므로 수준 끝에 몰아 붙인다.
  const vcsNames = !low && showHidden && levelMeta.hiddenVcs
    ? [...levelMeta.hiddenVcs].sort((a, b) => a.localeCompare(b))
    : [];
  let vcsIdx = 0;
  const flushVcs = (beforeName?: string) => {
    for (;;) {
      const name = vcsNames[vcsIdx];
      if (name === undefined) return;
      if (sortMode === "name" && beforeName !== undefined && name.localeCompare(beforeName) >= 0) return;
      vcsIdx += 1;
      rows.push({ type: "vcs", name, depth, key: `vcs:${levelKey}:${name}` });
    }
  };
  // 삭제 고스트 행 — 삭제 파일은 목록에 실제 행이 없으므로 여기서 합성한다.
  // 필터가 켜져 있어도 유지한다. 이름 필터(low)가 있으면 이름에 바늘이 있는 것만 남긴다.
  const ghostNames = options.deletedByDir?.get(levelKey)
    ? [...(options.deletedByDir.get(levelKey) ?? [])]
      .filter((name) => showHidden || !name.startsWith("."))
      .filter((name) => !low || name.toLowerCase().includes(low))
      .sort((a, b) => a.localeCompare(b))
    : [];
  let ghostIdx = 0;
  const flushGhosts = (beforeName?: string) => {
    for (;;) {
      const name = ghostNames[ghostIdx];
      if (name === undefined) return;
      if (sortMode === "name" && beforeName !== undefined && name.localeCompare(beforeName) >= 0) return;
      ghostIdx += 1;
      const relativePath = levelKey ? `${levelKey}/${name}` : name;
      rows.push({ type: "ghost", name, relativePath, depth, key: `ghost:${relativePath}` });
    }
  };
  let filesStarted = false;
  for (const entry of sortEntries(entries, sortMode)) {
    if (!showHidden && entry.name.startsWith(".")) continue;
    const childResult = childResults.get(entry.relativePath);
    const children = childResult?.entries;
    const folderIdentity = childResult?.relativePath ?? entry.relativePath;
    const isCycle = entry.kind === "dir" && ancestorFolders.has(folderIdentity);
    // 잘린 목록은 비표시 항목에 매치가 숨어 있을 수 있으므로 잠재 매치로 취급해 캡 행을 살린다.
    const childMatch = entry.kind === "dir" && !isCycle
      && (hasFilterMatch(children ?? [], childResults, low, showHidden) || Boolean(low && childResult?.truncated));
    if (low) {
      const directMatch = entry.name.toLowerCase().includes(low);
      if (!directMatch && !childMatch) continue;
    }
    if (entry.kind === "dir") {
      flushVcs(entry.name);
    } else {
      if (!filesStarted) {
        // VCS 행은 "디렉터리 같은" 항목 — 첫 파일 행이 나오기 전에 남은 것을 밀어낸다.
        filesStarted = true;
        flushVcs();
      }
      // 고스트(삭제 파일)는 파일 구간에 이름순으로 끼워 넣는다.
      flushGhosts(entry.name);
    }
    const fetched = childResults.has(entry.relativePath);
    const isLoading = loadingDirs.has(entry.relativePath);
    const failed = options.failedDirs?.has(entry.relativePath) === true;
    const wantsExpanded = !filterCollapsedDirs.has(entry.relativePath)
      && (
        expandedDirs.has(entry.relativePath)
        || Boolean(low && childMatch)
        || Boolean(options.autoExpandAll && fetched)
      );
    // 자식을 아직 못 가져온 펼침은 그리지 않는다. 로딩 중이거나 실패 행을 붙일 때만 예외.
    const isExpanded = wantsExpanded && (fetched || isLoading || failed);
    rows.push({
      type: "entry",
      entry,
      depth,
      isSelected: selectedPath === entry.relativePath,
      isExpanded,
      isLoading,
    });
    if (entry.kind === "dir" && isExpanded && !isCycle) {
      if (children) {
        const nextAncestorFolders = new Set(ancestorFolders);
        nextAncestorFolders.add(folderIdentity);
        rows.push(...buildFlatRows(
          children,
          depth + 1,
          selectedPath,
          expandedDirs,
          loadingDirs,
          childResults,
          low,
          showHidden,
          nextAncestorFolders,
          filterCollapsedDirs,
          {
            // 안내문이 말하는 수는 "상한 상수"가 아니라 실제로 보여준 항목 수여야 한다 —
            // 분류에서 버려진 항목(끊긴 심링크·소켓)이 있으면 둘이 어긋난다.
            truncatedCap: childResult?.truncated ? childResult.entries.length : undefined,
            hiddenVcs: childResult?.hiddenVcsInternals,
          },
          folderIdentity,
          options,
        ));
      } else if (failed) {
        rows.push({
          type: "error",
          relativePath: entry.relativePath,
          depth: depth + 1,
          key: `error:${entry.relativePath}`,
        });
      }
    }
  }
  flushVcs();
  flushGhosts();
  if (levelMeta.truncatedCap !== undefined) {
    rows.push({ type: "cap", depth, cap: levelMeta.truncatedCap, key: `cap:${levelKey}` });
  }
  return rows;
}

function nextEntryIndex(rows: readonly TreeRow[], from: number, direction: 1 | -1): number | null {
  for (let i = from + direction; i >= 0 && i < rows.length; i += direction) {
    if (rows[i]?.type === "entry") return i;
  }
  return null;
}

export function resolveTreeNavigation(
  rows: readonly TreeRow[],
  index: number,
  key: string,
  options: TreeNavigationOptions = {},
): TreeNavigationAction {
  const row = rows[index];
  if (!row || row.type !== "entry") return { kind: "none" };
  if (isTreeContextMenuKey(key, options.shiftKey === true)) return { kind: "openMenu" };
  if (key === "PageDown" && options.pageSize !== undefined) {
    return { kind: "focus", index: pagedEntryIndex(rows, index, 1, Math.max(1, options.pageSize)) };
  }
  if (key === "PageUp" && options.pageSize !== undefined) {
    return { kind: "focus", index: pagedEntryIndex(rows, index, -1, Math.max(1, options.pageSize)) };
  }
  if (key === "ArrowDown") return { kind: "focus", index: nextEntryIndex(rows, index, 1) ?? index };
  if (key === "ArrowUp") return { kind: "focus", index: nextEntryIndex(rows, index, -1) ?? index };
  if (key === "Home") return { kind: "focus", index: nextEntryIndex(rows, -1, 1) ?? index };
  if (key === "End") return { kind: "focus", index: nextEntryIndex(rows, rows.length, -1) ?? index };
  if (key === "ArrowRight") {
    if (row.entry.kind !== "dir") return { kind: "none" };
    if (!row.isExpanded) return { kind: "expand" };
    // 첫 자식 엔트리로 내린다 — 중간의 VCS/캡 표식 행은 건어너뛴다.
    for (let i = index + 1; i < rows.length; i += 1) {
      const candidate = rows[i];
      if (!candidate || candidate.depth <= row.depth) break;
      if (candidate.type === "entry" && candidate.depth === row.depth + 1) return { kind: "focus", index: i };
    }
    return { kind: "none" };
  }
  if (key === "ArrowLeft") {
    if (row.entry.kind === "dir" && row.isExpanded) return { kind: "collapse" };
    for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
      const candidate = rows[parentIndex];
      if (candidate && candidate.type === "entry" && candidate.depth === row.depth - 1) return { kind: "focus", index: parentIndex };
    }
    return { kind: "none" };
  }
  if (key === "Enter" || key === " ") return { kind: "activate" };
  return { kind: "none" };
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { contextKey, files, theaterId, selectedPath, revealTarget, onSelect, onSearchSelect, onContextMenu, onEntriesRefreshed, watchedDirectories, t },
  ref,
) {
  const [result, setResult] = useState<FolderListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [childResults, setChildResults] = useState<Map<string, FolderListResult>>(new Map());
  const [filterText, setFilterText] = useState<string>("");
  const [searchScope, setSearchScope] = useState<FileSearchScope>("files");
  const [filterCollapsedDirs, setFilterCollapsedDirs] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [showHidden, setShowHidden] = useState<boolean>(() => readShowHidden());
  // 검색 요청은 최신 토글 값을 실어야 하고, 값이 바뀌면 질의를 다시 던져야 한다.
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const [sortMode, setSortMode] = useState<SortMode>(() => readSortMode());
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const [gitStatusResult, setGitStatusResult] = useState<GitStatusResult | null>(null);
  const [filterSearching, setFilterSearching] = useState(false);
  const [filterFailed, setFilterFailed] = useState(false);
  const [filterOutcome, setFilterOutcome] = useState<FileSearchResult | null>(null);
  const [expandFailedDirs, setExpandFailedDirs] = useState<Set<string>>(new Set());
  const [watchDegraded, setWatchDegraded] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const treeResizeObserverRef = useRef<ResizeObserver | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusPathRef = useRef<string | null>(null);
  const revealedRequestRef = useRef(0);
  const gitStatusRequestRef = useRef(0);
  const typeaheadRef = useRef({ buffer: "", at: 0 });

  // SSE 핸들러가 최신 상태를 참조하도록 ref로 유지
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const currentPathRef = useRef<string>(currentPath);
  currentPathRef.current = currentPath;
  const filesRef = useRef<PluginFilesClient>(files);
  filesRef.current = files;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const childResultsRef = useRef<Map<string, FolderListResult>>(childResults);
  childResultsRef.current = childResults;
  const onEntriesRefreshedRef = useRef(onEntriesRefreshed);
  onEntriesRefreshedRef.current = onEntriesRefreshed;
  const watchedDirectoriesRef = useRef<ReadonlySet<string>>(new Set());
  watchedDirectoriesRef.current = useMemo(() => new Set(watchedDirectories ?? []), [watchedDirectories]);
  const inFlightFoldersRef = useRef(new Map<string, Promise<void>>());
  const filterRequestRef = useRef(0);
  const isFiltering = filterText.trim().length > 0;
  const emitEntriesRefreshed = (result: FolderListResult) => {
    // 목록 결과를 통째로 넘긴다 — 뷰어는 truncated까지 봐야 "행이 없다"를 "파일이 없다"로 오독하지 않는다.
    onEntriesRefreshedRef.current?.(result);
  };

  const refreshGitStatus = useCallback(async () => {
    if (!theaterId) return;
    const requestId = ++gitStatusRequestRef.current;
    const requestContextKey = contextKey;
    try {
      const response = await fetch("/plugins/file-explorer/files/git-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId }),
      });
      if (!response.ok) return;
      const nextResult = await response.json() as GitStatusResult;
      if (
        requestId !== gitStatusRequestRef.current
        || !isCurrentContextRequest(requestContextKey, contextKeyRef.current)
      ) return;
      setGitStatusResult(nextResult);
    } catch {
      // Git 상태는 보조 신호다. 조회 실패는 파일 탐색을 방해하거나 오류 UI를 만들지 않는다.
    }
  }, [contextKey, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    setResult(null);
    setError(null);
    setCurrentPath("");
    setExpandedDirs(new Set());
    setChildResults(new Map());
    inFlightFoldersRef.current.clear();
    setFilterText("");
    setFilterCollapsedDirs(new Set());
    setScrollTop(0);
    setCursorPath(null);
    setGitStatusResult(null);
    setFilterSearching(false);
    setFilterFailed(false);
    setFilterOutcome(null);
    setExpandFailedDirs(new Set());
    setWatchDegraded(false);
  }, [contextKey, theaterId]);

  // 저장된 펼침 상태 복원 — 위 리셋 효과 다음에 선언되어 리셋 후에 실행된다.
  // 자식을 가져온 뒤에만 expanded로 올려 빈 펼침 행을 만들지 않는다.
  useEffect(() => {
    if (!theaterId) return;
    const stored = readExpandedDirs(contextKey);
    if (stored.length === 0) return;
    const requestContextKey = contextKey;
    void runWithConcurrency(stored, FOLDER_FETCH_CONCURRENCY, async (relPath) => {
      try {
        const r = await filesRef.current.listFolder(relPath);
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setChildResults((prev) => new Map(prev).set(relPath, r));
        emitEntriesRefreshed(r);
        setExpandedDirs((prev) => {
          if (prev.has(relPath)) return prev;
          const next = new Set(prev);
          next.add(relPath);
          expandedDirsRef.current = next;
          return next;
        });
      } catch {
        // 복원 실패는 접힌 채 둔다 — 사용자가 다시 펼치면 인라인 오류 행이 붙는다.
      }
    });
  }, [contextKey, theaterId]);

  // 펼침 상태 지속 — Theater별로 저장해 리로드 후 복원한다.
  useEffect(() => {
    if (!theaterId) return;
    saveExpandedDirs(contextKey, expandedDirs);
  }, [contextKey, expandedDirs, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    void refreshGitStatus();
    return () => { gitStatusRequestRef.current += 1; };
  }, [refreshGitStatus, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    // 탭 전환(visibilitychange)과 앱 복귀(window focus) 모두 갱신 기회다.
    // 나란히 둔 외부 터미널의 git add/commit은 fs.watch가 못 잡으므로.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshGitStatus();
      }, 200);
    };
    const handleVisibilityChange = () => {
      if (shouldRefreshGitStatusOnVisibility(document.visibilityState)) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", scheduleRefresh);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", scheduleRefresh);
    };
  }, [refreshGitStatus, theaterId]);

  useEffect(() => {
    if (!theaterId) return;
    const requestContextKey = contextKey;
    files.listFolder(currentPath || undefined).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setResult(r);
      setError(null);
      emitEntriesRefreshed(r);
    }).catch((e: unknown) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      const raw = e instanceof Error ? e.message : "Unable to load folder";
      setError(translateServerError(raw, t));
    });
  }, [contextKey, theaterId, currentPath, files, t]);

  useEffect(() => {
    if (!revealTarget || revealTarget.theaterId !== theaterId || revealTarget.requestId <= revealedRequestRef.current) return;
    let active = true;
    const requestContextKey = contextKey;
    const loadRevealPath = async () => {
      const rootResult = await files.listFolder();
      const nextResults = new Map<string, FolderListResult>();
      const nextExpanded = new Set<string>();
      const parts = revealTarget.relativePath.split("/").filter(Boolean);
      let parentPath = "";
      for (const part of parts.slice(0, -1)) {
        parentPath = parentPath ? `${parentPath}/${part}` : part;
        const folderResult = await files.listFolder(parentPath);
        nextResults.set(parentPath, folderResult);
        nextExpanded.add(parentPath);
      }
      if (!active || !isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setFilterText("");
      setFilterCollapsedDirs(new Set());
      if (parts.some((part) => part.startsWith("."))) {
        setShowHidden(true);
        saveShowHidden(true);
      }
      setCurrentPath("");
      setResult(rootResult);
      emitEntriesRefreshed(rootResult);
      setChildResults((current) => {
        const next = new Map(current);
        for (const [relativePath, folderResult] of nextResults) {
          next.set(relativePath, folderResult);
          emitEntriesRefreshed(folderResult);
        }
        return next;
      });
      setExpandedDirs((current) => new Set([...current, ...nextExpanded]));
      setCursorPath(revealTarget.relativePath);
    };
    void loadRevealPath().catch(() => undefined);
    return () => { active = false; };
  }, [contextKey, files, revealTarget, theaterId]);

  useEffect(() => {
    const query = filterText.trim();
    if (!theaterId || !query) {
      setFilterSearching(false);
      setFilterFailed(false);
      setFilterOutcome(null);
      return;
    }
    const requestId = ++filterRequestRef.current;
    const requestContextKey = contextKey;
    const controller = new AbortController();
    setFilterSearching(true);
    setFilterFailed(false);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/plugins/file-explorer/files/palette-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(paletteSearchRequestBody(theaterId, query, showHiddenRef.current, searchScope)),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("search_failed");
          const outcome = await response.json() as FileSearchResult;
          if (
            requestId !== filterRequestRef.current
            || !isCurrentContextRequest(requestContextKey, contextKeyRef.current)
          ) return;
          setFilterOutcome(outcome);
          setFilterSearching(false);
          setFilterFailed(false);
        } catch {
          if (controller.signal.aborted) return;
          if (
            requestId !== filterRequestRef.current
            || !isCurrentContextRequest(requestContextKey, contextKeyRef.current)
          ) return;
          setFilterFailed(true);
          setFilterSearching(false);
          setFilterOutcome(null);
        }
      })();
    }, FILTER_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [contextKey, filterText, searchScope, showHidden, theaterId]);

  const attachTreeRef = useCallback((node: HTMLDivElement | null) => {
    treeResizeObserverRef.current?.disconnect();
    treeResizeObserverRef.current = null;
    treeRef.current = node;
    if (!node) return;
    setScrollTop(node.scrollTop);
    setContainerHeight(node.clientHeight);
    const observer = new ResizeObserver(() => {
      if (treeRef.current === node) setContainerHeight(node.clientHeight);
    });
    observer.observe(node);
    treeResizeObserverRef.current = observer;
  }, []);

  useEffect(() => () => treeResizeObserverRef.current?.disconnect(), []);

  // SSE 자동 새로고침 — theaterId/files 변경 시 재구독, 언마운트 시 close
  useEffect(() => {
    if (!theaterId) return;

    let isFirstOpen = true;
    let gitStatusTimer: ReturnType<typeof setTimeout> | null = null;
    const url = `/plugins/file-explorer/files/watch?theaterId=${encodeURIComponent(theaterId)}`;
    const es = new EventSource(url);

    // 루트 재조회 성공 시 stale error를 함께 걷어 에러 화면에서 회복한다
    const reloadRoot = () => {
      const requestContextKey = contextKey;
      filesRef.current.listFolder(currentPathRef.current || undefined).then((r) => {
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setResult(r);
        setError(null);
        emitEntriesRefreshed(r);
      }).catch(() => {});
    };

    const doFullRefresh = () => {
      reloadRoot();
      // 재연결 풀 리프레시는 놓친 change 이벤트의 조정 경로이므로 git 배지도 함께 갱신한다
      void refreshGitStatus();
      const requestContextKey = contextKey;
      // 재연결 조정은 끊긴 동안 놓친 이벤트를 메우는 경로다 — 펼친 폴더뿐 아니라
      // 열린 문서를 품은(접혀 있을 수 있는) 폴더까지 봐야 낡음 표식이 복구된다.
      const reconcileDirs = [...new Set([...expandedDirsRef.current, ...watchedDirectoriesRef.current])];
      void runWithConcurrency(reconcileDirs, FOLDER_FETCH_CONCURRENCY, async (relPath) => {
        try {
          const r = await filesRef.current.listFolder(relPath);
          if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
          if (expandedDirsRef.current.has(relPath)) setChildResults((prev) => new Map(prev).set(relPath, r));
          emitEntriesRefreshed(r);
        } catch { /* 재연결 조정 실패는 다음 이벤트에서 회복된다 */ }
      });
    };

    es.addEventListener("change", (e) => {
      // 서버가 JSON 프레이밍한 상대경로 — 개행 포함 파일명도 안전하게 전달된다
      let relDir: string;
      try {
        relDir = JSON.parse((e as MessageEvent).data as string) as string;
      } catch {
        return;
      }
      if (typeof relDir !== "string") return;
      if (gitStatusTimer !== null) clearTimeout(gitStatusTimer);
      gitStatusTimer = setTimeout(() => {
        gitStatusTimer = null;
        void refreshGitStatus();
      }, GIT_STATUS_DEBOUNCE_MS);
      // 루트 레벨 변경 또는 현재 탐색 경로 변경
      if (relDir === "" || relDir === currentPathRef.current) {
        reloadRoot();
      }
      // 펼쳐진 폴더, 그리고 열린 문서를 품은 폴더는 재조회한다.
      // 후자를 빼면 검색으로 연 파일이나 부모를 접어 둔 파일은 디스크가 바뀌어도
      // 낡음 표식이 서지 않는다 — 표식은 이 목록의 mtime 비교로만 서기 때문이다.
      const watchedByViewer = watchedDirectoriesRef.current.has(relDir);
      if (relDir !== "" && (expandedDirsRef.current.has(relDir) || watchedByViewer)) {
        const requestContextKey = contextKey;
        filesRef.current.listFolder(relDir).then((r) => {
          if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
          // 펼쳐지지 않은 폴더의 목록은 트리 상태에 넣지 않는다 — 뷰어 신호용으로만 쓴다.
          if (expandedDirsRef.current.has(relDir)) setChildResults((prev) => new Map(prev).set(relDir, r));
          emitEntriesRefreshed(r);
        }).catch(() => {});
      }
    });

    es.addEventListener("state", (e) => {
      const state = (e as MessageEvent).data as string;
      setWatchDegraded(isWatchDegraded(state));
    });

    es.onopen = () => {
      if (isFirstOpen) {
        isFirstOpen = false;
        return;
      }
      // 재연결: 놓친 변경 보정을 위해 전체 재조회
      doFullRefresh();
    };

    return () => {
      if (gitStatusTimer !== null) clearTimeout(gitStatusTimer);
      es.close();
    };
  }, [contextKey, theaterId, files, refreshGitStatus]);

  const handleDirClick = useCallback((entry: FolderEntry) => {
    const relPath = entry.relativePath;
    const plan = planFolderExpand(
      expandedDirsRef.current.has(relPath),
      childResultsRef.current.has(relPath),
      inFlightFoldersRef.current.has(relPath),
    );
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (plan.nextExpanded) next.add(relPath);
      else next.delete(relPath);
      expandedDirsRef.current = next;
      return next;
    });
    if (!plan.nextExpanded) {
      setExpandFailedDirs((prev) => {
        if (!prev.has(relPath)) return prev;
        const next = new Set(prev);
        next.delete(relPath);
        return next;
      });
    }
    if (plan.fetch === "none") return;
    const requestContextKey = contextKey;
    const showSpinner = plan.fetch === "foreground";
    if (showSpinner) setLoadingDirs((prev) => new Set(prev).add(relPath));
    setExpandFailedDirs((prev) => {
      if (!prev.has(relPath)) return prev;
      const next = new Set(prev);
      next.delete(relPath);
      return next;
    });
    const request = files.listFolder(relPath).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setChildResults((prev) => new Map(prev).set(relPath, r));
      emitEntriesRefreshed(r);
      setExpandFailedDirs((prev) => {
        if (!prev.has(relPath)) return prev;
        const next = new Set(prev);
        next.delete(relPath);
        return next;
      });
    }).catch(() => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      // 캐시가 없는 첫 펼침 실패는 접지 않고 인라인 재시도 행을 붙인다.
      if (childResultsRef.current.has(relPath)) return;
      setExpandFailedDirs((prev) => new Set(prev).add(relPath));
    }).finally(() => {
      inFlightFoldersRef.current.delete(relPath);
      if (!showSpinner) return;
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setLoadingDirs((prev) => { const s = new Set(prev); s.delete(relPath); return s; });
    });
    inFlightFoldersRef.current.set(relPath, request);
  }, [contextKey, files]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.currentTarget as HTMLDivElement).scrollTop);
  }, []);

  const handleToggleHidden = useCallback(() => {
    setShowHidden((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PREFS_SHOW_HIDDEN, next ? "1" : "0");
      } catch {
        // localStorage 접근 실패 무시
      }
      return next;
    });
  }, []);

  const handleSelectSort = useCallback((mode: SortMode) => {
    setSortMode(mode);
    try {
      localStorage.setItem(PREFS_SORT_MODE, mode);
    } catch {
      // localStorage 접근 실패 무시
    }
  }, []);

  const refreshTree = useCallback(() => {
    if (!theaterId) return;
    const requestContextKey = contextKey;
    // 루트 재조회 — 성공 시 stale error를 걷어 에러 화면에서도 복구 가능하게 한다
    files.listFolder(currentPath || undefined).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setResult(r);
      setError(null);
      emitEntriesRefreshed(r);
    }).catch((e: unknown) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      const raw = e instanceof Error ? e.message : "Unable to load folder";
      setError(translateServerError(raw, t));
    });
    // 펼쳐진 모든 폴더 재조회 — 상한 있는 팬아웃으로
    void runWithConcurrency([...expandedDirs], FOLDER_FETCH_CONCURRENCY, async (relPath) => {
      try {
        const r = await files.listFolder(relPath);
        if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
        setChildResults((prev) => new Map(prev).set(relPath, r));
        emitEntriesRefreshed(r);
      } catch { /* 개별 폴더 실패는 조용히 둔다 — ↻로 재시도 */ }
    });
  }, [contextKey, files, currentPath, expandedDirs, theaterId, t]);

  const handleRefresh = useCallback(() => {
    triggerManualRefresh(refreshTree, refreshGitStatus);
  }, [refreshGitStatus, refreshTree]);

  const low = filterText.toLowerCase();
  const gitAvailable = gitStatusResult?.gitAvailable === true;
  const gitStatusByPath = useMemo(
    () => new Map(gitStatusResult?.statuses.map((entry) => [entry.path.replaceAll("\\", "/"), entry.status]) ?? []),
    [gitStatusResult],
  );
  const gitRollups = useMemo(() => rollupGitStatuses(gitStatusByPath), [gitStatusByPath]);

  // 삭제 파일의 고스트 행 데이터 — 실제 목록에 아직 남아 있는 경로(스테이지 삭제 등)는 제외한다.
  const deletedByDir = useMemo(() => {
    if (!gitAvailable) return new Map<string, readonly string[]>();
    const listedPaths = new Set<string>();
    for (const entry of result?.entries ?? []) listedPaths.add(entry.relativePath);
    for (const child of childResults.values()) {
      for (const entry of child.entries) listedPaths.add(entry.relativePath);
    }
    const grouped = new Map<string, string[]>();
    for (const [statusPath, status] of gitStatusByPath) {
      if (status !== "deleted" || listedPaths.has(statusPath)) continue;
      const slash = statusPath.lastIndexOf("/");
      const dir = slash < 0 ? "" : statusPath.slice(0, slash);
      const name = slash < 0 ? statusPath : statusPath.slice(slash + 1);
      const bucket = grouped.get(dir);
      if (bucket) bucket.push(name);
      else grouped.set(dir, [name]);
    }
    return grouped as ReadonlyMap<string, readonly string[]>;
  }, [childResults, gitAvailable, gitStatusByPath, result]);

  const flatRows = useMemo(() => {
    if (!result || isFiltering) return [];
    return buildFlatRows(
      result.entries,
      0,
      selectedPath,
      expandedDirs,
      loadingDirs,
      childResults,
      low,
      showHidden,
      new Set(),
      filterCollapsedDirs,
      { truncatedCap: result.truncated ? result.entries.length : undefined, hiddenVcs: result.hiddenVcsInternals },
      "",
      { sortMode, deletedByDir, autoExpandAll: false, failedDirs: expandFailedDirs },
    );
  }, [childResults, deletedByDir, expandFailedDirs, expandedDirs, filterCollapsedDirs, isFiltering, loadingDirs, low, result, selectedPath, showHidden, sortMode]);

  const hasOnlyHiddenEntries = !showHidden && result !== null && result.entries.length > 0 && flatRows.length === 0 && !filterText;

  const shouldVirtualize = flatRows.length > VIRTUALIZE_THRESHOLD;
  const windowed = shouldVirtualize
    ? virtualRowWindow(scrollTop, containerHeight, flatRows.length)
    : { startIdx: 0, endIdx: flatRows.length, offsetY: 0, totalHeight: flatRows.length * ROW_HEIGHT };
  const startIdx = windowed.startIdx;
  const endIdx = windowed.endIdx;
  const visibleRows = flatRows.slice(startIdx, endIdx);
  const totalHeight = windowed.totalHeight;
  const offsetY = windowed.offsetY;
  const selectedVisiblePath = selectedPath && hasEntryPath(flatRows, selectedPath)
    ? selectedPath
    : null;
  const resolvedCursorPath = hasEntryPath(flatRows, cursorPath)
    ? cursorPath
    : selectedVisiblePath ?? firstEntryPath(flatRows);
  const renderedCursorPath = hasEntryPath(visibleRows, resolvedCursorPath)
    ? resolvedCursorPath
    : firstEntryPath(visibleRows);

  const filterMatchCount = filterOutcome?.totalMatches ?? 0;

  useEffect(() => {
    if (renderedCursorPath !== cursorPath) setCursorPath(renderedCursorPath);
  }, [cursorPath, renderedCursorPath]);

  useLayoutEffect(() => {
    const path = pendingFocusPathRef.current;
    if (path === null || path !== renderedCursorPath) return;
    pendingFocusPathRef.current = null;
    rowRefs.current.get(path)?.focus();
  }, [renderedCursorPath, visibleRows]);

  useLayoutEffect(() => {
    if (!revealTarget || revealTarget.requestId <= revealedRequestRef.current) return;
    const rowIndex = flatRows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === revealTarget.relativePath);
    if (rowIndex < 0) return;
    setCursorPath(revealTarget.relativePath);
    if (shouldVirtualize && (rowIndex < startIdx || rowIndex >= endIdx)) {
      const nextScrollTop = Math.max(0, rowIndex * ROW_HEIGHT);
      if (treeRef.current) treeRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
      return;
    }
    const row = rowRefs.current.get(revealTarget.relativePath);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    revealedRequestRef.current = revealTarget.requestId;
  }, [endIdx, flatRows, revealTarget, shouldVirtualize, startIdx, visibleRows]);

  useImperativeHandle(ref, () => ({
    restoreContextMenuFocus: (relativePath) => restoreContextMenuFocus(
      relativePath,
      rowRefs.current,
      renderedCursorPath,
      treeRef.current,
    ),
    focusFilter: () => filterInputRef.current?.focus(),
  }), [renderedCursorPath]);

  const focusRow = (rowIndex: number) => {
    const row = flatRows[rowIndex];
    if (!row || row.type !== "entry") return;
    const path = row.entry.relativePath;
    if (path === renderedCursorPath) {
      // 경계(첫/마지막 행)에서는 커서가 그대로라 리렌더가 없다. 요청을 남겨두면 나중의 SSE 리렌더가
      // 그걸 소비해 사용자가 떠난 뒤 포커스를 훔치므로, 여기서 바로 처리하고 큐를 비운다.
      pendingFocusPathRef.current = null;
      rowRefs.current.get(path)?.focus();
      return;
    }
    pendingFocusPathRef.current = path;
    setCursorPath(path);
    if (shouldVirtualize && (rowIndex < startIdx || rowIndex >= endIdx)) {
      const nextScrollTop = Math.max(0, rowIndex * ROW_HEIGHT);
      if (treeRef.current) treeRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  };

  const openRowContextMenu = (row: EntryRow, x: number, y: number) => {
    setCursorPath(row.entry.relativePath);
    onContextMenu(row.entry, x, y);
  };

  const retryExpand = (relPath: string) => {
    const requestContextKey = contextKey;
    setExpandFailedDirs((prev) => {
      if (!prev.has(relPath)) return prev;
      const next = new Set(prev);
      next.delete(relPath);
      return next;
    });
    setLoadingDirs((prev) => new Set(prev).add(relPath));
    void files.listFolder(relPath).then((r) => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setChildResults((prev) => new Map(prev).set(relPath, r));
      emitEntriesRefreshed(r);
    }).catch(() => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setExpandFailedDirs((prev) => new Set(prev).add(relPath));
    }).finally(() => {
      if (!isCurrentContextRequest(requestContextKey, contextKeyRef.current)) return;
      setLoadingDirs((prev) => { const next = new Set(prev); next.delete(relPath); return next; });
    });
  };

  const handleTreeItemKeyDown = (row: EntryRow, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = flatRows.findIndex((candidate) => isEntryRow(candidate) && candidate.entry.relativePath === row.entry.relativePath);
    if (index < 0) return;
    const pageSize = Math.max(1, Math.floor(containerHeight / ROW_HEIGHT));
    const action = resolveTreeNavigation(flatRows, index, event.key, { pageSize, shiftKey: event.shiftKey });
    if (action.kind === "none") {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") event.preventDefault();
      if (!isTypeaheadKey(event.key, event)) return;
      event.preventDefault();
      const now = Date.now();
      const nextBuffer = now - typeaheadRef.current.at > TYPEAHEAD_RESET_MS
        ? event.key
        : `${typeaheadRef.current.buffer}${event.key}`;
      typeaheadRef.current = { buffer: nextBuffer, at: now };
      const target = resolveTypeaheadIndex(flatRows, index, nextBuffer);
      if (target !== null) focusRow(target);
      return;
    }
    event.preventDefault();
    if (action.kind === "openMenu") {
      event.stopPropagation();
      const anchor = contextMenuAnchorFromRowRect(event.currentTarget.getBoundingClientRect());
      openRowContextMenu(row, anchor.x, anchor.y);
      return;
    }
    if (action.kind === "focus") {
      focusRow(action.index);
      return;
    }
    if (action.kind === "expand") {
      if (isFiltering) {
        setFilterCollapsedDirs((current) => {
          const next = new Set(current);
          next.delete(row.entry.relativePath);
          return next;
        });
      } else {
        handleDirClick(row.entry);
      }
      return;
    }
    if (action.kind === "collapse") {
      if (row.entry.kind === "dir") {
        if (isFiltering) {
          setFilterCollapsedDirs((current) => new Set(current).add(row.entry.relativePath));
        } else {
          setExpandedDirs((current) => {
            const next = new Set(current);
            next.delete(row.entry.relativePath);
            expandedDirsRef.current = next;
            return next;
          });
        }
      }
      return;
    }
    activateRow(row);
  };

  const activateRow = (row: EntryRow) => {
    if (row.entry.kind !== "dir") {
      onSelect(row.entry);
      return;
    }
    if (!isFiltering) {
      handleDirClick(row.entry);
      return;
    }
    setFilterCollapsedDirs((current) => {
      const next = new Set(current);
      if (row.isExpanded) next.add(row.entry.relativePath);
      else next.delete(row.entry.relativePath);
      return next;
    });
  };

  const handleRowClick = (row: EntryRow) => {
    setCursorPath(row.entry.relativePath);
    activateRow(row);
  };

  const handleRowContextMenu = (row: EntryRow, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openRowContextMenu(row, event.clientX, event.clientY);
  };

  if (!theaterId) return <div className="fexp-tree-empty">{t("fileExplorer.status.selectTheater")}</div>;
  // 전체 에러 화면은 보여줄 트리가 아예 없을 때(초기 로드 실패)만 —
  // 이전 result가 있으면 트리를 유지해 ↻ 재시도 경로를 보존한다
  if (error && !result) return <div className="fexp-tree-error">{error}</div>;
  if (!result) return <div className="fexp-tree-loading">{t("fileExplorer.status.loading")}</div>;

  const renderTreeRow = (row: TreeRow) => {
    if (row.type === "cap") {
      return (
        <div
          key={row.key}
          className="fexp-tree-cap"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
          role="note"
        >
          {t("fileExplorer.tree.listingCapped", { cap: row.cap })}
        </div>
      );
    }
    if (row.type === "vcs") {
      return (
        <div
          key={row.key}
          className="fexp-tree-vcs"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
        >
          {t("fileExplorer.tree.vcsHidden", { name: row.name })}
        </div>
      );
    }
    if (row.type === "ghost") {
      return (
        <div
          key={row.key}
          className="fexp-tree-ghost"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
          role="note"
          aria-label={t("fileExplorer.git.deletedGhost", { name: row.name })}
          title={t("fileExplorer.git.deletedGhost", { name: row.name })}
        >
          {treeGuideOffsets(row.depth).map((left) => (
            <span key={left} className="fexp-tree-guide" style={{ left: `${left}px` }} aria-hidden="true" />
          ))}
          <span className="fexp-tree-chevron" aria-hidden="true" />
          <span className="fexp-tree-icon" aria-hidden="true"><FileIcon name={row.name} /></span>
          <span className="fexp-tree-name">{row.name}</span>
          <span className="fexp-git-badge is-deleted" aria-hidden="true">D</span>
        </div>
      );
    }
    if (row.type === "error") {
      return (
        <div
          key={row.key}
          className="fexp-tree-error"
          style={{ paddingLeft: `${row.depth * 16 + 12}px` }}
          role="alert"
        >
          <span>{t("fileExplorer.tree.expandFailed")}</span>
          <button
            type="button"
            className="fexp-tree-error-retry"
            onClick={() => retryExpand(row.relativePath)}
          >
            {t("fileExplorer.tree.expandRetry")}
          </button>
        </div>
      );
    }
    return (
      <FlatTreeRow
        key={row.entry.relativePath}
        row={row}
        cursor={row.entry.relativePath === renderedCursorPath}
        rowRefs={rowRefs}
        gitAvailable={gitAvailable}
        gitStatus={gitStatusByPath.get(row.entry.relativePath)}
        rollup={row.entry.kind === "dir" ? gitRollups.get(row.entry.relativePath) : undefined}
        onEntryClick={handleRowClick}
        onContextMenu={handleRowContextMenu}
        onKeyDown={handleTreeItemKeyDown}
        t={t}
      />
    );
  };

  return (
    <div className="fexp-tree-container">
      <div className="fexp-head">
      <div className="fexp-filter">
        <div className="fexp-filter-box">
          <input
            ref={filterInputRef}
            type="text"
            className="fexp-filter-input"
            placeholder={t("fileExplorer.filter.placeholder")}
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setFilterCollapsedDirs(new Set());
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              if (!shouldClearFilterOnEscape(filterText)) return;
              event.preventDefault();
              event.stopPropagation();
              setFilterText("");
              setFilterCollapsedDirs(new Set());
            }}
            aria-label={t("fileExplorer.filter.aria")}
          />
          {!filterText && <span className="fexp-filter-hint" aria-hidden="true">/</span>}
        </div>
        {filterText && (
          <button
            type="button"
            className="fexp-filter-clear"
            onClick={() => {
              setFilterText("");
              setFilterCollapsedDirs(new Set());
            }}
            aria-label={t("fileExplorer.filter.clear")}
          >
            ✕
          </button>
        )}
        <div className="fexp-sort-wrap">
          <button
            ref={sortButtonRef}
            type="button"
            className="fexp-sort-btn"
            onClick={() => setSortMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            aria-label={t("fileExplorer.sort.open", { mode: t(SORT_MODE_LABEL_KEYS[sortMode]) })}
            title={t("fileExplorer.sort.open", { mode: t(SORT_MODE_LABEL_KEYS[sortMode]) })}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 3v9M4.5 12l-2-2M4.5 12l2-2M9 4.5h5M9 8h4M9 11.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="fexp-sort-label">{t(SORT_MODE_LABEL_KEYS[sortMode])}</span>
          </button>
          {sortMenuOpen && (
            <SortMenu
              sortMode={sortMode}
              t={t}
              triggerRef={sortButtonRef}
              onSelect={(mode) => {
                handleSelectSort(mode);
                setSortMenuOpen(false);
                sortButtonRef.current?.focus();
              }}
              onClose={(restoreFocus) => {
                setSortMenuOpen(false);
                if (restoreFocus) sortButtonRef.current?.focus();
              }}
            />
          )}
        </div>
        <button
          type="button"
          className="fexp-refresh-btn"
          onClick={handleRefresh}
          aria-label={t("fileExplorer.tree.refresh")}
          title={t("fileExplorer.tree.refresh")}
        >
          ↻
        </button>
        <button
          type="button"
          className={`fexp-hidden-toggle${showHidden ? " is-active" : ""}`}
          onClick={handleToggleHidden}
          aria-pressed={showHidden}
          aria-label={showHidden ? t("fileExplorer.tree.hideHidden") : t("fileExplorer.tree.showHidden")}
          title={showHidden ? t("fileExplorer.tree.hideHidden") : t("fileExplorer.tree.showHidden")}
        >
          {showHidden ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <ellipse cx="8" cy="8" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.4"/>
              <circle cx="8" cy="8" r="1.8" fill="currentColor"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <ellipse cx="8" cy="8" rx="5.5" ry="3.5" stroke="currentColor" strokeWidth="1.4"/>
              <circle cx="8" cy="8" r="1.8" fill="currentColor"/>
              <line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          )}
        </button>
      </div>
      {isFiltering && (
        <div className="fexp-search-scopes" role="group" aria-label={t("fileExplorer.filter.scopeAria")}>
          <button
            type="button"
            className={searchScope === "files" ? "is-active" : ""}
            aria-pressed={searchScope === "files"}
            onClick={() => setSearchScope("files")}
          >
            {t("fileExplorer.filter.files")}
          </button>
          <button
            type="button"
            className={searchScope === "contents" ? "is-active" : ""}
            aria-pressed={searchScope === "contents"}
            onClick={() => setSearchScope("contents")}
          >
            {t("fileExplorer.filter.contents")}
          </button>
        </div>
      )}
      {isFiltering && filterSearching && (
        <div className="fexp-filter-scan" role="status">
          {t("fileExplorer.filter.searchingAll")}
        </div>
      )}
      {isFiltering && !filterSearching && !filterFailed && (
        <div className="fexp-filter-scan" role="status">
          {t("fileExplorer.filter.resultCount", { count: filterMatchCount })}
        </div>
      )}
      {isFiltering && !filterSearching && !filterFailed && filterOutcome?.ignoredSkipped && (
        <div className="fexp-filter-cap" role="status">
          {t("fileExplorer.filter.ignoredHint")}
        </div>
      )}
      {isFiltering && !filterSearching && !filterFailed && filterOutcome?.walkCapped && (
        <div className="fexp-filter-cap" role="status">
          {t("fileExplorer.filter.capped", { matches: filterMatchCount, cap: PALETTE_SEARCH_WALK_CAP })}
        </div>
      )}
      {isFiltering && filterFailed && (
        <div className="fexp-filter-cap" role="alert">
          {t("fileExplorer.filter.searchFailed")}
        </div>
      )}
      {watchDegraded && (
        <div className="fexp-tree-degraded" role="status">
          {t("fileExplorer.tree.watchDegraded")}
        </div>
      )}
      {gitStatusResult?.truncated && (
        <div className="fexp-git-note" role="status">
          {t("fileExplorer.git.truncated", { cap: gitStatusResult.cap ?? 0 })}
        </div>
      )}
      </div>
      {isFiltering ? (
        <SearchResultList
          outcome={filterOutcome}
          searching={filterSearching}
          selectedPath={selectedPath}
          onSelect={(item) => onSearchSelect?.(item)}
          t={t}
        />
      ) : (
        <div
          ref={attachTreeRef}
          className="fexp-tree"
          role="tree"
          tabIndex={-1}
          aria-label={t("fileExplorer.tree.aria")}
          onScroll={shouldVirtualize ? handleScroll : undefined}
        >
          {false && result?.parentRelativePath !== null && (
            <button
              className="fexp-tree-up"
              type="button"
              onClick={() => setCurrentPath(result?.parentRelativePath ?? "")}
              aria-label={t("fileExplorer.tree.parentFolder")}
            >
              ↑ ..
            </button>
          )}
          {shouldVirtualize ? (
            <div style={{ height: totalHeight, position: "relative" }}>
              <div style={{ transform: `translateY(${offsetY}px)` }}>
                {visibleRows.map(renderTreeRow)}
              </div>
            </div>
          ) : (
            visibleRows.map(renderTreeRow)
          )}
          {flatRows.length === 0 && result.entries.length === 0 && (
            <div className="fexp-tree-empty">{t("fileExplorer.status.emptyFolder")}</div>
          )}
          {hasOnlyHiddenEntries && (
            <div className="fexp-tree-empty">{t("fileExplorer.status.onlyHiddenItems")}</div>
          )}
        </div>
      )}
    </div>
  );
});

interface SearchResultListProps {
  readonly outcome: FileSearchResult | null;
  readonly searching: boolean;
  readonly selectedPath: string | null;
  readonly onSelect: (item: FileSearchItem) => void;
  readonly t: Translate<FileExplorerMessageKey>;
}

function SearchResultList({ outcome, searching, selectedPath, onSelect, t }: SearchResultListProps) {
  const results = outcome?.files ?? [];
  if (results.length === 0 && !searching) {
    return <div className="fexp-search-results"><div className="fexp-tree-empty">{t("fileExplorer.status.noMatchingItems")}</div></div>;
  }
  return (
    <div className="fexp-search-results" role="listbox" aria-label={t("fileExplorer.filter.resultsAria")}>
      {results.map((item) => {
        const name = nameOfRelativePath(item.relativePath);
        const parent = parentRelativePath(item.relativePath);
        return (
          <button
            type="button"
            role="option"
            aria-selected={selectedPath === item.relativePath}
            key={`${item.relativePath}:${item.preview?.lineNumber ?? "path"}`}
            className={`fexp-search-result${selectedPath === item.relativePath ? " is-cur" : ""}`}
            onClick={() => onSelect(item)}
          >
            <span className="fexp-tree-icon" aria-hidden="true"><FileIcon name={name} /></span>
            <span className="fexp-search-result-main">
              <span className="fexp-search-result-path">
                {renderHighlightedPath(item.relativePath, item.pathRanges ?? [], name)}
              </span>
              {parent && <span className="fexp-search-result-parent">{parent}</span>}
              {item.preview && (
                <span className="fexp-search-preview">
                  <span className="fexp-search-line">{item.preview.lineNumber}</span>
                  <span>{renderHighlightedText(item.preview.text, item.preview.ranges)}</span>
                </span>
              )}
            </span>
            {item.source === "content" && <span className="fexp-search-kind">{t("fileExplorer.filter.contentMatch")}</span>}
          </button>
        );
      })}
      {outcome?.degraded === "walker" && (
        <div className="fexp-filter-cap" role="status">{t("fileExplorer.filter.degraded")}</div>
      )}
      {!searching && outcome && outcome.complete === false && (
        <div className="fexp-filter-scan" role="status">{t("fileExplorer.filter.partial")}</div>
      )}
    </div>
  );
}

function renderHighlightedPath(relativePath: string, ranges: readonly { readonly start: number; readonly end: number }[], name: string) {
  const nameStart = relativePath.length - name.length;
  const shifted = ranges
    .map((range) => ({ start: range.start - nameStart, end: range.end - nameStart }))
    .filter((range) => range.end > 0 && range.start < name.length)
    .map((range) => ({ start: Math.max(0, range.start), end: Math.min(name.length, range.end) }));
  return renderHighlightedText(name, shifted);
}

export function renderHighlightedText(text: string, ranges: readonly { readonly start: number; readonly end: number }[]) {
  const normalized = [...ranges]
    .filter((range) => range.start >= 0 && range.end > range.start && range.end <= text.length)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const fragments: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of normalized.entries()) {
    if (range.start < cursor) continue;
    if (range.start > cursor) fragments.push(text.slice(cursor, range.start));
    fragments.push(<mark key={`${range.start}:${range.end}:${index}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) fragments.push(text.slice(cursor));
  return fragments.length > 0 ? fragments : text;
}

function hasFilterMatch(
  entries: readonly FolderEntry[],
  childResults: Map<string, FolderListResult>,
  low: string,
  showHidden: boolean,
  visitedFolders: ReadonlySet<string> = new Set(),
): boolean {
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    if (e.name.toLowerCase().includes(low)) return true;
    if (e.kind === "dir") {
      const result = childResults.get(e.relativePath);
      if (result && !visitedFolders.has(result.relativePath)) {
        // 잘린 목록은 비표시 꼬리에 매치가 숨어 있을 수 있다 — 조상 사슬을 유지한다.
        if (result.truncated) return true;
        const nextVisitedFolders = new Set(visitedFolders);
        nextVisitedFolders.add(result.relativePath);
        if (hasFilterMatch(result.entries, childResults, low, showHidden, nextVisitedFolders)) return true;
      }
    }
  }
  return false;
}

interface FlatTreeRowProps {
  readonly row: EntryRow;
  readonly cursor: boolean;
  readonly rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  readonly gitAvailable: boolean;
  readonly gitStatus: GitFileStatus | undefined;
  readonly rollup: GitDirRollup | undefined;
  readonly onEntryClick: (row: EntryRow) => void;
  readonly onContextMenu: (row: EntryRow, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (row: EntryRow, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly t: Translate<FileExplorerMessageKey>;
}

function FlatTreeRow({ row, cursor, rowRefs, gitAvailable, gitStatus, rollup, onEntryClick, onContextMenu, onKeyDown, t }: FlatTreeRowProps) {
  const { entry, depth, isSelected, isExpanded, isLoading } = row;
  const isDir = entry.kind === "dir";
  // 디렉터리형 행이라도 정확 경로에 상태가 있으면 배지를 단다 —
  // dirty 서브모듈/디렉터리형 심링크는 git이 그 경로 자체를 보고한다.
  // 일반 디렉터리는 상태 항목 자체가 없어 자연스럽게 무배지.
  const gitBadge = gitAvailable ? mapGitStatusBadge(gitStatus) : null;
  const indent = depth * 16;
  const handleClick = useCallback(() => onEntryClick(row), [onEntryClick, row]);

  return (
    <button
      ref={(node) => {
        if (node) rowRefs.current.set(entry.relativePath, node);
        else rowRefs.current.delete(entry.relativePath);
      }}
      className={`fexp-tree-row${isSelected ? " is-cur" : ""}${isDir ? " is-dir" : " is-file"}`}
      style={{ paddingLeft: `${indent + 12}px` }}
      type="button"
      role="treeitem"
      tabIndex={cursor ? 0 : -1}
      aria-haspopup="menu"
      aria-level={depth + 1}
      aria-selected={isSelected}
      aria-expanded={isDir ? isExpanded : undefined}
      onClick={handleClick}
      onContextMenu={(event) => onContextMenu(row, event)}
      onKeyDown={(event) => onKeyDown(row, event)}
    >
      {treeGuideOffsets(depth).map((left) => (
        <span key={left} className="fexp-tree-guide" style={{ left: `${left}px` }} aria-hidden="true" />
      ))}
      <span className="fexp-tree-chevron" aria-hidden="true">
        {isDir && (
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M2.5 1.2 5.8 4 2.5 6.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="fexp-tree-icon" aria-hidden="true">
        {isDir ? <FolderIcon name={entry.name} open={isExpanded} /> : <FileIcon name={entry.name} />}
      </span>
      <span className="fexp-tree-name">{entry.name}</span>
      {isLoading && <span className="fexp-tree-spin" aria-hidden="true">⋯</span>}
      {isDir && rollup && rollup.total > 0 && (
        <span className="fexp-tree-rollup" aria-label={t("fileExplorer.git.rollupAria", { count: rollup.total })}>
          {rollup.modified > 0 && <span className="fexp-tree-rollup-mark is-modified" />}
          {rollup.untracked > 0 && <span className="fexp-tree-rollup-mark is-untracked" />}
          {rollup.deleted > 0 && <span className="fexp-tree-rollup-mark is-deleted" />}
        </span>
      )}
      {gitBadge && (
        <span className={`fexp-git-badge is-${gitBadge.status}`} aria-label={t(gitBadge.messageKey)}>
          {gitBadge.text}
        </span>
      )}
    </button>
  );
}

const SORT_MODE_LABEL_KEYS = {
  name: "fileExplorer.sort.name",
  modified: "fileExplorer.sort.modified",
  size: "fileExplorer.sort.size",
} as const satisfies Record<SortMode, FileExplorerMessageKey>;

interface SortMenuProps {
  readonly sortMode: SortMode;
  readonly t: Translate<FileExplorerMessageKey>;
  /** 바깥 클릭 판정에서 제외할 트리거 버튼 — 빼면 pointerdown 닫힘 뒤 click 토글이 메뉴를 되열어 버튼으로 닫을 수 없다. */
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly onSelect: (mode: SortMode) => void;
  readonly onClose: (restoreFocus: boolean) => void;
}

/** 정렬 선택 메뉴 — 순환 버튼과 달리 전체 선택지와 현재 값을 한 번에 보여준다. */
function SortMenu({ sortMode, t, triggerRef, onSelect, onClose }: SortMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, SORT_MODES.indexOf(sortMode)));

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => itemRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
    // 첫 마운트에서 현재 정렬 항목으로만 포커스를 옮긴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      // 트리거 버튼 위의 pointerdown은 버튼의 click 토글에 맡긴다 — 여기서 닫으면 토글이 되열어 버린다.
      if (triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [onClose, triggerRef]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveContextMenuKeyboardAction(activeIndex, event.key, SORT_MODES.length);
    if (action.kind === "close") {
      // preventDefault 없이 닫는다 — Tab의 자연스러운 포커스 이동을 보존.
      onClose(false);
      return;
    }
    if (action.kind === "none") return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "focus") {
      setActiveIndex(action.index);
      itemRefs.current[action.index]?.focus();
      return;
    }
    if (action.kind === "activate") {
      const mode = SORT_MODES[action.index];
      if (mode) onSelect(mode);
      return;
    }
    onClose(true);
  };

  return (
    <div
      ref={menuRef}
      className="fexp-context-menu fexp-sort-menu"
      role="menu"
      aria-label={t("fileExplorer.sort.menuAria")}
      onKeyDown={handleKeyDown}
    >
      {SORT_MODES.map((mode, index) => (
        <button
          key={mode}
          ref={(node) => { itemRefs.current[index] = node; }}
          className="fexp-context-menu-item fexp-sort-menu-item"
          type="button"
          role="menuitemradio"
          aria-checked={mode === sortMode}
          tabIndex={activeIndex === index ? 0 : -1}
          onClick={() => onSelect(mode)}
          onFocus={() => setActiveIndex(index)}
        >
          <span>{t(SORT_MODE_LABEL_KEYS[mode])}</span>
          <span className="fexp-sort-menu-check" aria-hidden="true">✓</span>
        </button>
      ))}
    </div>
  );
}

function readSortMode(): SortMode {
  try {
    const raw = localStorage.getItem(PREFS_SORT_MODE);
    return raw === "modified" || raw === "size" ? raw : "name";
  } catch {
    return "name";
  }
}

export function readExpandedDirs(contextKey: string): readonly string[] {
  try {
    const raw = localStorage.getItem(PREFS_EXPANDED_PREFIX + contextKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return selectPersistableExpanded(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

export function saveExpandedDirs(contextKey: string, expandedDirs: ReadonlySet<string>): void {
  try {
    const key = PREFS_EXPANDED_PREFIX + contextKey;
    if (expandedDirs.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(selectPersistableExpanded(expandedDirs)));
  } catch {
    // localStorage 접근 실패 무시
  }
}

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(PREFS_SHOW_HIDDEN) === "1";
  } catch {
    return false;
  }
}

function saveShowHidden(showHidden: boolean): void {
  try {
    localStorage.setItem(PREFS_SHOW_HIDDEN, showHidden ? "1" : "0");
  } catch {
    // localStorage 접근 실패 무시
  }
}
