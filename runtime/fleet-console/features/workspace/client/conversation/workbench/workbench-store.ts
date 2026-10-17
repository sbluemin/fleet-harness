import { useSyncExternalStore } from "react";

import type { ExpandedSurfaceOpenRequest } from "@fleet-console/sdk/expanded-surface";

import {
  CONVERSATION_WORKBENCH_API_PATH,
  EMPTY_WORKBENCH_LAYOUT,
  EMPTY_WORKBENCH_STACK,
  isWorkbenchEmpty,
  sanitizeLayoutBook,
  sanitizeWorkbenchParams,
  WORKBENCH_MAX_BELOW,
  WORKBENCH_MAX_COLUMNS,
  WORKBENCH_MAX_TILES_PER_COLUMN,
  workbenchTiles,
  type WorkbenchLayout,
  type WorkbenchStack,
  type WorkbenchTile,
  type WorkbenchTileSource,
} from "../../../shared/conversation-workbench.js";

/**
 * 대화별 도구 작업대 — 지금 보이는 대화(사령관·지휘관·일반 Operation)의 도구 칸 배치를 소유한다.
 *
 * 배치는 대화 키마다 하나이고 서버에 저장된다(`/api/v1/conversation-workbench`). 처음 붙을 때 한 번 읽고, 바뀐 대화의 배치만
 * 잠시 모아 쓴다. 칸이 무엇을 그리는지(파일 트리·Shell·브라우저)는 이 스토어가 모른다 — 칸의 출처(entry·surface·browser)와 자리만 안다.
 *
 * 포커스(어느 칸을 마지막에 만졌는가)는 저장하지 않는 화면 상태다.
 */

type Listener = () => void;

/** 칸을 놓는 자리 — 분할 영역의 기존 열, 새 열, 또는 대화 아래 줄. index 는 그 묶음 안에서 끼워 넣을 자리다. */
export type WorkbenchDropTarget =
  | { readonly area: "column"; readonly column: number; readonly index: number }
  | { readonly area: "new-column"; readonly at: number }
  | { readonly area: "below"; readonly index: number };

export type WorkbenchNudge = "up" | "down" | "left" | "right";

/** 칸의 지금 자리. */
export type WorkbenchTilePlace =
  | { readonly area: "column"; readonly column: number; readonly index: number }
  | { readonly area: "below"; readonly index: number };

const SAVE_DELAY_MS = 400;
const NON_CONVERSATION_KEY = "console";

const listeners = new Set<Listener>();
let layouts = new Map<string, WorkbenchLayout>();
let currentKey: string = NON_CONVERSATION_KEY;
let focusedTileId: string | null = null;
let loadState: "idle" | "loading" | "loaded" = "idle";
/** 서버 값이 도착하기 전에 이 화면에서 손댄 대화 — 도착한 값이 덮지 않는다. */
const touchedBeforeLoad = new Set<string>();
const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let tileSeq = 0;
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeWorkbench(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getWorkbenchVersion(): number {
  return version;
}

/** 지금 대화의 배치. 같은 상태에는 같은 객체다. */
export function getWorkbenchLayout(): WorkbenchLayout {
  return layouts.get(currentKey) ?? EMPTY_WORKBENCH_LAYOUT;
}

export function getWorkbenchKey(): string {
  return currentKey;
}

export function getWorkbenchFocusedTileId(): string | null {
  return focusedTileId;
}

export function useWorkbenchLayout(): WorkbenchLayout {
  return useSyncExternalStore(subscribeWorkbench, getWorkbenchLayout, getWorkbenchLayout);
}

export function useWorkbenchFocusedTileId(): string | null {
  return useSyncExternalStore(subscribeWorkbench, getWorkbenchFocusedTileId, () => null);
}

/** 대화 칸이 보이는 대화를 알린다. 대화가 아닌 화면(새 세션·빈 칸)은 null — 그 자리의 Console 도구는 한 배치를 함께 쓴다. */
export function setWorkbenchConversation(key: string | null): void {
  const next = key ?? NON_CONVERSATION_KEY;
  if (next === currentKey) return;
  currentKey = next;
  focusedTileId = null;
  notify();
}

// ── 저장 ──────────────────────────────────────────────────────────────────

/** 서버의 배치를 한 번 읽는다. 그 사이 이 화면에서 손댄 대화는 화면의 것이 이긴다. */
export function loadWorkbenchLayouts(): void {
  if (loadState !== "idle" || typeof fetch === "undefined") return;
  loadState = "loading";
  void fetch(CONVERSATION_WORKBENCH_API_PATH, { headers: { Accept: "application/json" } })
    .then(async (response) => (response.ok ? await response.json() as unknown : null))
    .catch(() => null)
    .then((body) => {
      loadState = "loaded";
      const book = sanitizeLayoutBook(body !== null && typeof body === "object" ? (body as { readonly layouts?: unknown }).layouts : null);
      const next = new Map(layouts);
      for (const [key, stored] of Object.entries(book)) {
        if (touchedBeforeLoad.has(key)) continue;
        next.set(key, stored.layout);
      }
      touchedBeforeLoad.clear();
      layouts = next;
      notify();
    });
}

function scheduleSave(key: string): void {
  dirty.add(key);
  if (saveTimer !== null) return;
  saveTimer = setTimeout(flushWorkbenchSaves, SAVE_DELAY_MS);
}

/** 모아 둔 배치를 지금 쓴다. 실패해도 화면의 배치는 그대로다 — 다음 변경이 다시 쓴다. */
export function flushWorkbenchSaves(): void {
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  if (typeof fetch === "undefined") { dirty.clear(); return; }
  for (const key of dirty) {
    const layout = layouts.get(key) ?? null;
    void fetch(CONVERSATION_WORKBENCH_API_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ key, layout: layout === null || isWorkbenchEmpty(layout) ? null : persistable(layout) }),
      keepalive: true,
    }).catch(() => undefined);
  }
  dirty.clear();
}

/** 저장하는 모양 — 펼침은 남기되(재시작 뒤에도 돌아온다) 화면 상태(포커스)는 싣지 않는다. */
function persistable(layout: WorkbenchLayout): WorkbenchLayout {
  return layout;
}

function commit(next: WorkbenchLayout, options: { readonly persist?: boolean } = {}): void {
  const key = currentKey;
  const previous = layouts.get(key) ?? EMPTY_WORKBENCH_LAYOUT;
  if (next === previous) return;
  const map = new Map(layouts);
  if (isWorkbenchEmpty(next)) map.delete(key);
  else map.set(key, next);
  layouts = map;
  if (loadState !== "loaded") touchedBeforeLoad.add(key);
  if (options.persist !== false) scheduleSave(key);
  notify();
}

// ── 순수 조작 ─────────────────────────────────────────────────────────────

interface MutableStack { tiles: WorkbenchTile[]; weights: number[] }
interface MutableLayout {
  columns: MutableStack[];
  columnWeights: number[];
  below: MutableStack;
  splitRatio: number | null;
  belowRatio: number | null;
  expandedTileId: string | null;
}

function thaw(layout: WorkbenchLayout): MutableLayout {
  return {
    columns: layout.columns.map((column) => ({ tiles: [...column.tiles], weights: [...column.weights] })),
    columnWeights: [...layout.columnWeights],
    below: { tiles: [...layout.below.tiles], weights: [...layout.below.weights] },
    splitRatio: layout.splitRatio,
    belowRatio: layout.belowRatio,
    expandedTileId: layout.expandedTileId,
  };
}

function freeze(layout: MutableLayout): WorkbenchLayout {
  const columns: WorkbenchStack[] = [];
  const columnWeights: number[] = [];
  layout.columns.forEach((column, index) => {
    if (column.tiles.length === 0) return;
    columns.push({ tiles: column.tiles, weights: column.weights });
    columnWeights.push(layout.columnWeights[index] ?? 1);
  });
  const tiles = new Set([...columns.flatMap((column) => column.tiles), ...layout.below.tiles].map((tile) => tile.id));
  return {
    columns,
    columnWeights,
    below: layout.below.tiles.length === 0 ? EMPTY_WORKBENCH_STACK : { tiles: layout.below.tiles, weights: layout.below.weights },
    splitRatio: layout.splitRatio,
    belowRatio: layout.belowRatio,
    expandedTileId: layout.expandedTileId !== null && tiles.has(layout.expandedTileId) ? layout.expandedTileId : null,
  };
}

function averageWeight(weights: readonly number[]): number {
  return weights.length === 0 ? 1 : weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
}

export function findWorkbenchTile(layout: WorkbenchLayout, tileId: string): { readonly tile: WorkbenchTile; readonly place: WorkbenchTilePlace } | null {
  for (let column = 0; column < layout.columns.length; column += 1) {
    const index = layout.columns[column]!.tiles.findIndex((tile) => tile.id === tileId);
    if (index !== -1) return { tile: layout.columns[column]!.tiles[index]!, place: { area: "column", column, index } };
  }
  const index = layout.below.tiles.findIndex((tile) => tile.id === tileId);
  return index === -1 ? null : { tile: layout.below.tiles[index]!, place: { area: "below", index } };
}

function sameSource(tile: WorkbenchTile, source: WorkbenchTileSource): boolean {
  if (tile.kind !== source.kind) return false;
  if (tile.kind === "entry" && source.kind === "entry") return tile.entryId === source.entryId;
  if (tile.kind === "surface" && source.kind === "surface") return tile.surfaceId === source.surfaceId;
  return tile.kind === "browser";
}

function nextTileId(): string {
  tileSeq += 1;
  return `t${Date.now().toString(36)}${tileSeq.toString(36)}`;
}

function removeTile(draft: MutableLayout, tileId: string): { readonly tile: WorkbenchTile; readonly weight: number } | null {
  for (let column = 0; column < draft.columns.length; column += 1) {
    const stack = draft.columns[column]!;
    const index = stack.tiles.findIndex((tile) => tile.id === tileId);
    if (index === -1) continue;
    const [tile] = stack.tiles.splice(index, 1);
    const [weight] = stack.weights.splice(index, 1);
    return { tile: tile!, weight: weight ?? 1 };
  }
  const index = draft.below.tiles.findIndex((tile) => tile.id === tileId);
  if (index === -1) return null;
  const [tile] = draft.below.tiles.splice(index, 1);
  const [weight] = draft.below.weights.splice(index, 1);
  return { tile: tile!, weight: weight ?? 1 };
}

/** 빈 열을 걷어 내며 열 번호가 어떻게 바뀌는지 돌려준다(걷힌 열은 -1). */
function dropEmptyColumns(draft: MutableLayout): number[] {
  const mapping: number[] = [];
  const columns: MutableStack[] = [];
  const weights: number[] = [];
  draft.columns.forEach((column, index) => {
    if (column.tiles.length === 0) { mapping.push(-1); return; }
    mapping.push(columns.length);
    columns.push(column);
    weights.push(draft.columnWeights[index] ?? 1);
  });
  draft.columns = columns;
  draft.columnWeights = weights;
  return mapping;
}

function insertAt(draft: MutableLayout, tile: WorkbenchTile, target: WorkbenchDropTarget): boolean {
  if (target.area === "below") {
    if (draft.below.tiles.length >= WORKBENCH_MAX_BELOW) return false;
    const at = Math.max(0, Math.min(draft.below.tiles.length, target.index));
    draft.below.tiles.splice(at, 0, tile);
    draft.below.weights.splice(at, 0, averageWeight(draft.below.weights));
    return true;
  }
  if (target.area === "new-column") {
    if (draft.columns.length >= WORKBENCH_MAX_COLUMNS) return false;
    const at = Math.max(0, Math.min(draft.columns.length, target.at));
    draft.columns.splice(at, 0, { tiles: [tile], weights: [1] });
    draft.columnWeights.splice(at, 0, averageWeight(draft.columnWeights));
    return true;
  }
  const column = draft.columns[target.column];
  if (column === undefined || column.tiles.length >= WORKBENCH_MAX_TILES_PER_COLUMN) return false;
  const at = Math.max(0, Math.min(column.tiles.length, target.index));
  column.tiles.splice(at, 0, tile);
  column.weights.splice(at, 0, averageWeight(column.weights));
  return true;
}

/** 새 칸의 기본 자리 — 첫 칸은 전체 높이 한 열, 다음 칸은 포커스한(없으면 마지막) 열 아래로 쌓고, 열이 차면 새 열, 그다음 대화 아래. */
function defaultTarget(draft: MutableLayout, placement: "split" | "below"): WorkbenchDropTarget | null {
  if (placement === "below" && draft.below.tiles.length < WORKBENCH_MAX_BELOW) return { area: "below", index: draft.below.tiles.length };
  if (draft.columns.length === 0) return { area: "new-column", at: 0 };
  let column = draft.columns.length - 1;
  if (focusedTileId !== null) {
    const focused = draft.columns.findIndex((stack) => stack.tiles.some((tile) => tile.id === focusedTileId));
    if (focused !== -1) column = focused;
  }
  if (draft.columns[column]!.tiles.length < WORKBENCH_MAX_TILES_PER_COLUMN) return { area: "column", column, index: draft.columns[column]!.tiles.length };
  const open = draft.columns.findIndex((stack) => stack.tiles.length < WORKBENCH_MAX_TILES_PER_COLUMN);
  if (draft.columns.length < WORKBENCH_MAX_COLUMNS) return { area: "new-column", at: draft.columns.length };
  if (open !== -1) return { area: "column", column: open, index: draft.columns[open]!.tiles.length };
  if (draft.below.tiles.length < WORKBENCH_MAX_BELOW) return { area: "below", index: draft.below.tiles.length };
  return null;
}

// ── 조작 ──────────────────────────────────────────────────────────────────

export interface OpenTileOptions {
  readonly placement?: "split" | "below";
  /** 같은 출처의 칸이 있으면 그 칸을 쓴다(기본). false 면 하나 더 연다. */
  readonly reuse?: boolean;
}

/** 칸을 연다. 같은 출처의 칸이 있으면 그 칸으로 포커스를 옮긴다(표면은 params 를 갈아탄다). 자리가 없으면 null. */
export function openWorkbenchTile(source: WorkbenchTileSource, options: OpenTileOptions = {}): string | null {
  const layout = getWorkbenchLayout();
  if (options.reuse !== false) {
    const existing = workbenchTiles(layout).find((tile) => sameSource(tile, source));
    if (existing) {
      let next = layout;
      if (existing.kind === "surface" && source.kind === "surface" && !sameParams(existing.params, source.params)) {
        next = replaceTile(layout, existing.id, { ...existing, params: sanitizeWorkbenchParams(source.params) });
      }
      // 펼친 다른 칸이 있으면 접는다 — 여는 것은 보려는 뜻이다.
      if (next.expandedTileId !== null && next.expandedTileId !== existing.id) next = { ...next, expandedTileId: null };
      commit(next);
      focusWorkbenchTile(existing.id);
      return existing.id;
    }
  }
  const draft = thaw(layout);
  const target = defaultTarget(draft, options.placement ?? "split");
  if (target === null) return null;
  const id = nextTileId();
  const tile: WorkbenchTile = source.kind === "surface"
    ? { id, kind: "surface", surfaceId: source.surfaceId, params: sanitizeWorkbenchParams(source.params) }
    : source.kind === "entry" ? { id, kind: "entry", entryId: source.entryId } : { id, kind: "browser" };
  if (!insertAt(draft, tile, target)) return null;
  draft.expandedTileId = null;
  focusedTileId = id;
  commit(freeze(draft));
  return id;
}

function replaceTile(layout: WorkbenchLayout, tileId: string, tile: WorkbenchTile): WorkbenchLayout {
  const swap = (stack: WorkbenchStack): WorkbenchStack => stack.tiles.some((candidate) => candidate.id === tileId)
    ? { tiles: stack.tiles.map((candidate) => (candidate.id === tileId ? tile : candidate)), weights: stack.weights }
    : stack;
  return { ...layout, columns: layout.columns.map(swap), below: swap(layout.below) };
}

function sameParams(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** 닫힌 표면 칸을 알릴 곳 — 확대 표면 스토어의 닫힘 통보 배달부가 묶인다. */
let surfaceClosed: (closed: readonly { readonly surfaceId: string; readonly instanceId: string; readonly params: Readonly<Record<string, string>> }[]) => void = () => undefined;

export function bindWorkbenchSurfaceCloseNotifier(notifier: typeof surfaceClosed): () => void {
  surfaceClosed = notifier;
  return () => { if (surfaceClosed === notifier) surfaceClosed = () => undefined; };
}

export function closeWorkbenchTile(tileId: string): void {
  const draft = thaw(getWorkbenchLayout());
  const removed = removeTile(draft, tileId);
  if (removed === null) return;
  dropEmptyColumns(draft);
  if (draft.expandedTileId === tileId) draft.expandedTileId = null;
  if (focusedTileId === tileId) focusedTileId = null;
  commit(freeze(draft));
  if (removed.tile.kind === "surface") surfaceClosed([{ surfaceId: removed.tile.surfaceId, instanceId: removed.tile.id, params: removed.tile.params }]);
}

function closeWhere(predicate: (tile: WorkbenchTile) => boolean): void {
  const targets = workbenchTiles(getWorkbenchLayout()).filter(predicate);
  for (const tile of targets) closeWorkbenchTile(tile.id);
}

export function moveWorkbenchTile(tileId: string, target: WorkbenchDropTarget): boolean {
  const layout = getWorkbenchLayout();
  const found = findWorkbenchTile(layout, tileId);
  if (found === null) return false;
  const draft = thaw(layout);
  const removed = removeTile(draft, tileId)!;
  let adjusted: WorkbenchDropTarget = target;
  // 같은 열 안에서 아래로 옮기면 빠진 자리만큼 끼울 자리가 당겨진다.
  if (target.area === "column" && found.place.area === "column" && found.place.column === target.column && found.place.index < target.index) {
    adjusted = { ...target, index: target.index - 1 };
  }
  if (target.area === "below" && found.place.area === "below" && found.place.index < target.index) {
    adjusted = { ...target, index: target.index - 1 };
  }
  const mapping = dropEmptyColumns(draft);
  if (adjusted.area === "column") {
    const column = mapping[adjusted.column];
    // 혼자 있던 열에 다시 놓으면(빠진 뒤 사라진 열) 제자리다.
    if (column === undefined || column === -1) return false;
    adjusted = { ...adjusted, column };
  } else if (adjusted.area === "new-column") {
    const at = adjusted.at;
    let shifted = at;
    for (let index = 0; index < Math.min(at, mapping.length); index += 1) if (mapping[index] === -1) shifted -= 1;
    adjusted = { area: "new-column", at: shifted };
  }
  if (!insertAt(draft, removed.tile, adjusted)) return false;
  focusedTileId = tileId;
  commit(freeze(draft));
  return true;
}

/** ⌥+화살표·⋮ 메뉴의 한 걸음 이동. 움직일 수 없으면 false. */
export function nudgeWorkbenchTile(tileId: string, direction: WorkbenchNudge): boolean {
  const layout = getWorkbenchLayout();
  const found = findWorkbenchTile(layout, tileId);
  if (found === null) return false;
  const { place } = found;
  if (place.area === "below") {
    if (direction === "left" && place.index > 0) return moveWorkbenchTile(tileId, { area: "below", index: place.index - 1 });
    if (direction === "right" && place.index < layout.below.tiles.length - 1) return moveWorkbenchTile(tileId, { area: "below", index: place.index + 2 });
    if (direction === "up") return moveToSplit(tileId);
    return false;
  }
  const column = layout.columns[place.column]!;
  if (direction === "up") return place.index > 0 && moveWorkbenchTile(tileId, { area: "column", column: place.column, index: place.index - 1 });
  if (direction === "down") return place.index < column.tiles.length - 1 && moveWorkbenchTile(tileId, { area: "column", column: place.column, index: place.index + 2 });
  const step = direction === "left" ? -1 : 1;
  const neighbour = layout.columns[place.column + step];
  if (neighbour !== undefined) {
    return neighbour.tiles.length < WORKBENCH_MAX_TILES_PER_COLUMN && moveWorkbenchTile(tileId, { area: "column", column: place.column + step, index: neighbour.tiles.length });
  }
  // 끝 열에서 바깥으로 — 그 열에 다른 칸이 있을 때만 새 열을 낸다(혼자면 제자리다).
  if (column.tiles.length < 2 || layout.columns.length >= WORKBENCH_MAX_COLUMNS) return false;
  return moveWorkbenchTile(tileId, { area: "new-column", at: direction === "left" ? 0 : layout.columns.length });
}

/** 「대화 아래로」. */
export function moveWorkbenchTileBelow(tileId: string): boolean {
  const layout = getWorkbenchLayout();
  return moveWorkbenchTile(tileId, { area: "below", index: layout.below.tiles.length });
}

/** 「오른쪽 분할로」 — 마지막 열 아래(차 있으면 새 열). */
function moveToSplit(tileId: string): boolean {
  const layout = getWorkbenchLayout();
  const last = layout.columns.length - 1;
  if (last >= 0 && layout.columns[last]!.tiles.length < WORKBENCH_MAX_TILES_PER_COLUMN) {
    return moveWorkbenchTile(tileId, { area: "column", column: last, index: layout.columns[last]!.tiles.length });
  }
  return moveWorkbenchTile(tileId, { area: "new-column", at: layout.columns.length });
}

export const moveWorkbenchTileToSplit = moveToSplit;

export function focusWorkbenchTile(tileId: string | null): void {
  if (focusedTileId === tileId) return;
  focusedTileId = tileId;
  notify();
}

export function setWorkbenchExpanded(tileId: string | null): void {
  const layout = getWorkbenchLayout();
  if (layout.expandedTileId === tileId) return;
  if (tileId !== null && findWorkbenchTile(layout, tileId) === null) return;
  commit({ ...layout, expandedTileId: tileId });
}

export function replaceWorkbenchTileParams(tileId: string, params: Readonly<Record<string, string>>): void {
  const layout = getWorkbenchLayout();
  const found = findWorkbenchTile(layout, tileId);
  if (found === null || found.tile.kind !== "surface") return;
  const clean = sanitizeWorkbenchParams(params);
  if (sameParams(found.tile.params, clean)) return;
  commit(replaceTile(layout, tileId, { ...found.tile, params: clean }));
}

export function setWorkbenchSplitRatio(ratio: number | null, options: { readonly persist?: boolean } = {}): void {
  const layout = getWorkbenchLayout();
  const next = ratio === null ? null : Math.min(0.92, Math.max(0.05, ratio));
  if (layout.splitRatio === next) return;
  commit({ ...layout, splitRatio: next }, options);
}

export function setWorkbenchBelowRatio(ratio: number | null, options: { readonly persist?: boolean } = {}): void {
  const layout = getWorkbenchLayout();
  const next = ratio === null ? null : Math.min(0.85, Math.max(0.08, ratio));
  if (layout.belowRatio === next) return;
  commit({ ...layout, belowRatio: next }, options);
}

/** 가중치 갈아 끼우기 — 열 사이(`columns`), 한 열 안(`column`), 대화 아래 줄(`below`). 끄는 동안은 persist 없이 따라간다. */
export function setWorkbenchWeights(
  target: { readonly area: "columns" } | { readonly area: "column"; readonly column: number } | { readonly area: "below" },
  weights: readonly number[],
  options: { readonly persist?: boolean } = {},
): void {
  const layout = getWorkbenchLayout();
  const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 1));
  if (target.area === "columns") {
    if (clean.length !== layout.columns.length) return;
    commit({ ...layout, columnWeights: clean }, options);
    return;
  }
  if (target.area === "below") {
    if (clean.length !== layout.below.tiles.length) return;
    commit({ ...layout, below: { tiles: layout.below.tiles, weights: clean } }, options);
    return;
  }
  const column = layout.columns[target.column];
  if (column === undefined || clean.length !== column.tiles.length) return;
  commit({ ...layout, columns: layout.columns.map((stack, index) => (index === target.column ? { tiles: stack.tiles, weights: clean } : stack)) }, options);
}

/** 끌기가 끝났다 — 그 사이 따라간 값을 쓴다. */
export function persistWorkbench(): void {
  scheduleSave(currentKey);
}

// ── 도구 질의 ─────────────────────────────────────────────────────────────

/** 칸으로 여는 레일 엔트리(도구) — 대화 칸이 지금 레지스트리에서 골라 알린다. 오른쪽 사이드바의 탭(대상의 탭·목표·설정)은 여기 없다. */
let toolEntryIds: ReadonlySet<string> = new Set();

export function setWorkbenchToolEntries(ids: Iterable<string>): void {
  toolEntryIds = new Set(ids);
}

export function ownsWorkbenchEntry(entryId: string): boolean {
  return toolEntryIds.has(entryId);
}

export function isWorkbenchEntryOpen(entryId: string): boolean {
  return workbenchTiles(getWorkbenchLayout()).some((tile) => tile.kind === "entry" && tile.entryId === entryId);
}

export function isWorkbenchSurfaceOpen(surfaceId: string): boolean {
  return workbenchTiles(getWorkbenchLayout()).some((tile) => tile.kind === "surface" && tile.surfaceId === surfaceId);
}

export function isWorkbenchBrowserOpen(): boolean {
  return workbenchTiles(getWorkbenchLayout()).some((tile) => tile.kind === "browser");
}

export function useWorkbenchBrowserOpen(): boolean {
  return useSyncExternalStore(subscribeWorkbench, isWorkbenchBrowserOpen, () => false);
}

export function openWorkbenchEntry(entryId: string): void {
  openWorkbenchTile({ kind: "entry", entryId });
}

export function closeWorkbenchEntry(entryId: string): void {
  closeWhere((tile) => tile.kind === "entry" && tile.entryId === entryId);
}

export function toggleWorkbenchEntry(entryId: string): void {
  if (isWorkbenchEntryOpen(entryId)) closeWorkbenchEntry(entryId);
  else openWorkbenchEntry(entryId);
}

export function openWorkbenchBrowser(): void {
  openWorkbenchTile({ kind: "browser" });
}

export function closeWorkbenchBrowser(): void {
  closeWhere((tile) => tile.kind === "browser");
}

export function toggleWorkbenchBrowser(): void {
  if (isWorkbenchBrowserOpen()) closeWorkbenchBrowser();
  else openWorkbenchBrowser();
}

// ── 확대 표면 호스트 ──────────────────────────────────────────────────────

interface SurfaceSnapshot {
  readonly instances: readonly { readonly instanceId: string; readonly surfaceId: string; readonly params: Readonly<Record<string, string>>; readonly weight: number }[];
  readonly focusedInstanceId: string | null;
}

let surfaceSnapshot: SurfaceSnapshot = { instances: [], focusedInstanceId: null };
let surfaceSnapshotVersion = -1;

/** 지금 대화의 표면 칸 — 확대 표면 스토어가 호스트 상태로 읽는다. 같은 상태에는 같은 객체다. */
export function getWorkbenchSurfaceSnapshot(): SurfaceSnapshot {
  if (surfaceSnapshotVersion === version) return surfaceSnapshot;
  surfaceSnapshotVersion = version;
  const instances = workbenchTiles(getWorkbenchLayout()).flatMap((tile) => tile.kind === "surface"
    ? [{ instanceId: tile.id, surfaceId: tile.surfaceId, params: tile.params, weight: 1 }]
    : []);
  const focused = instances.some((instance) => instance.instanceId === focusedTileId) ? focusedTileId : null;
  const previous = surfaceSnapshot;
  const same = previous.focusedInstanceId === focused
    && previous.instances.length === instances.length
    && previous.instances.every((instance, index) => {
      const next = instances[index]!;
      return instance.instanceId === next.instanceId && instance.surfaceId === next.surfaceId && instance.params === next.params;
    });
  if (!same) surfaceSnapshot = { instances, focusedInstanceId: focused };
  return surfaceSnapshot;
}

export function openWorkbenchSurface(request: ExpandedSurfaceOpenRequest): string {
  const params = request.params ?? {};
  return openWorkbenchTile({ kind: "surface", surfaceId: request.surfaceId, params }, { reuse: request.mode !== "split" }) ?? "";
}

export function closeWorkbenchSurfacesOf(surfaceId: string): void {
  closeWhere((tile) => tile.kind === "surface" && tile.surfaceId === surfaceId);
}

export function closeAllWorkbenchSurfaces(): void {
  closeWhere((tile) => tile.kind === "surface");
}

/** 대화를 드러낸다 — 펼친 칸을 접는다. */
export function revealWorkbenchConversation(): void {
  if (getWorkbenchLayout().expandedTileId !== null) setWorkbenchExpanded(null);
}

/** 테스트·핫 리로드 전용 — 모듈 상태를 비운다. */
export function resetWorkbenchForTest(): void {
  layouts = new Map();
  currentKey = NON_CONVERSATION_KEY;
  focusedTileId = null;
  loadState = "idle";
  touchedBeforeLoad.clear();
  dirty.clear();
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
  version += 1;
}
