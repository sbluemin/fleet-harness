import { useSyncExternalStore } from "react";

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
  readonly splitRatio: number;
}

type Listener = () => void;

const DEFAULT_SPLIT_RATIO = 0.55;

const DEFAULT_THEATER_STATE: TheaterViewState = {
  selectedPath: null,
  viewState: { kind: "none" },
  splitRatio: DEFAULT_SPLIT_RATIO,
};

const theaterStateMap = new Map<string, TheaterViewState>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function getOrDefault(theaterId: string): TheaterViewState {
  return theaterStateMap.get(theaterId) ?? DEFAULT_THEATER_STATE;
}

function patchTheaterState(theaterId: string, patch: Partial<TheaterViewState>): void {
  theaterStateMap.set(theaterId, { ...getOrDefault(theaterId), ...patch });
  emit();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFileExplorerViewState(theaterId: string | null): TheaterViewState {
  return useSyncExternalStore(
    subscribe,
    () => theaterId != null ? getOrDefault(theaterId) : DEFAULT_THEATER_STATE,
    () => DEFAULT_THEATER_STATE,
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

export function setSplitRatio(theaterId: string | null, splitRatio: number): void {
  if (!theaterId) return;
  patchTheaterState(theaterId, { splitRatio });
}
