import { useSyncExternalStore } from "react";

import { MIN_TREE_PX, TREE_PANE_DEFAULT_WIDTH } from "./layout.js";

export type ViewState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "code"; relativePath: string; content: string; lang: string; truncated?: boolean }
  | { kind: "image"; relativePath: string; name: string; src: string }
  | { kind: "binary"; name: string }
  | { kind: "error"; message: string };

interface TheaterViewState {
  readonly selectedPath: string | null;
  readonly viewState: ViewState;
}

interface FileExplorerViewState extends TheaterViewState {
  readonly treePaneWidth: number;
}

type Listener = () => void;

const PREFS_TREE_PANE_WIDTH = "fleet-console.file-explorer.treePaneWidth";

const DEFAULT_THEATER_STATE: TheaterViewState = {
  selectedPath: null,
  viewState: { kind: "none" },
};

const DEFAULT_SERVER_SNAPSHOT: FileExplorerViewState = {
  ...DEFAULT_THEATER_STATE,
  treePaneWidth: TREE_PANE_DEFAULT_WIDTH,
};

const theaterStateMap = new Map<string, TheaterViewState>();
const snapshotMap = new Map<string, FileExplorerViewState>();
const listeners = new Set<Listener>();
let treePaneWidth = readTreePaneWidth();

export function useFileExplorerViewState(theaterId: string | null): FileExplorerViewState {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(theaterId),
    () => DEFAULT_SERVER_SNAPSHOT,
  );
}

export function setSelectedPath(theaterId: string | null, selectedPath: string | null): void {
  if (!theaterId) return;
  patchTheaterState(theaterId, { selectedPath });
}

export function setViewState(theaterId: string | null, viewState: ViewState): void {
  if (!theaterId) return;
  patchTheaterState(theaterId, { viewState });
}

export function setTreePaneWidth(nextWidth: number): void {
  treePaneWidth = clampStoredTreePaneWidth(nextWidth);
  try {
    localStorage.setItem(PREFS_TREE_PANE_WIDTH, String(treePaneWidth));
  } catch {
    // localStorage 접근 실패 무시
  }
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function getOrDefault(theaterId: string): TheaterViewState {
  return theaterStateMap.get(theaterId) ?? DEFAULT_THEATER_STATE;
}

function getSnapshot(theaterId: string | null): FileExplorerViewState {
  const key = theaterId ?? "__none__";
  const base = theaterId != null ? getOrDefault(theaterId) : DEFAULT_THEATER_STATE;
  const prev = snapshotMap.get(key);
  if (
    prev
    && prev.selectedPath === base.selectedPath
    && prev.viewState === base.viewState
    && prev.treePaneWidth === treePaneWidth
  ) {
    return prev;
  }
  const next = { ...base, treePaneWidth };
  snapshotMap.set(key, next);
  return next;
}

function patchTheaterState(theaterId: string, patch: Partial<TheaterViewState>): void {
  theaterStateMap.set(theaterId, { ...getOrDefault(theaterId), ...patch });
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function readTreePaneWidth(): number {
  try {
    return clampStoredTreePaneWidth(Number(localStorage.getItem(PREFS_TREE_PANE_WIDTH)));
  } catch {
    return TREE_PANE_DEFAULT_WIDTH;
  }
}

function clampStoredTreePaneWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return TREE_PANE_DEFAULT_WIDTH;
  return Math.max(MIN_TREE_PX, Math.round(width));
}
