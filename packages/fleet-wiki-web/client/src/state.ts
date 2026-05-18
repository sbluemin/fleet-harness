import {
  fetchConflictDetail,
  fetchConflicts,
  fetchEntry,
  fetchHealth,
  fetchIndex,
  fetchIndexMarkdown,
  fetchLog,
  fetchQueueList,
} from "./api";
import type {
  BriefingHit,
  ConflictDetailResponse,
  ConflictListItem,
  HealthResponse,
  LogResponse,
  WikiEntryResponse,
  WikiIndexEntry,
} from "./api";

export interface AppState {
  health: HealthResponse | null;
  index: WikiIndexEntry[];
  currentEntry: WikiEntryResponse | null;
  currentMatchHint: BriefingHit | null;
  conflicts: ConflictListItem[];
  currentConflict: ConflictDetailResponse | null;
  indexMarkdown: string | null;
  log: LogResponse | null;
  loading: boolean;
  error: string | null;
  recentIds: string[];
  pendingPatchCount: number;
}

type StateListener = (state: AppState) => void;

const RECENT_STORAGE_KEY = "fleet-wiki-web-recent";
const listeners = new Set<StateListener>();
const state: AppState = {
  health: null,
  index: [],
  currentEntry: null,
  currentMatchHint: null,
  conflicts: [],
  currentConflict: null,
  indexMarkdown: null,
  log: null,
  loading: false,
  error: null,
  recentIds: readRecentIds(),
  pendingPatchCount: 0,
};

export function getState(): AppState {
  return state;
}

export function subscribeState(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadInitialData(): Promise<void> {
  setState({ loading: true, error: null });
  try {
    const [health, index, queueList] = await Promise.all([
      fetchHealth(),
      fetchIndex(),
      fetchQueueList("pending").catch(() => null),
    ]);
    setState({
      health,
      index,
      pendingPatchCount: queueList?.pendingCount ?? 0,
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadEntry(id: string): Promise<void> {
  setState({
    loading: true,
    error: null,
    currentEntry: null,
    currentMatchHint: state.currentMatchHint?.id === id ? state.currentMatchHint : null,
    currentConflict: null,
    indexMarkdown: null,
    log: null,
  });
  try {
    const currentEntry = await fetchEntry(id);
    const recentIds = updateRecentIds(id);
    setState({
      currentEntry,
      currentConflict: null,
      indexMarkdown: null,
      log: null,
      recentIds,
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadIndexMarkdownView(): Promise<void> {
  setState({ loading: true, error: null, currentEntry: null, currentConflict: null, log: null });
  try {
    setState({
      indexMarkdown: await fetchIndexMarkdown(),
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadLogView(limit: number): Promise<void> {
  setState({ loading: true, error: null, currentEntry: null, currentConflict: null, indexMarkdown: null });
  try {
    setState({
      log: await fetchLog(limit),
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadConflictsView(): Promise<void> {
  setState({ loading: true, error: null, currentEntry: null, currentConflict: null, indexMarkdown: null, log: null });
  try {
    setState({
      conflicts: await fetchConflicts(),
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadConflictDetailView(id: string): Promise<void> {
  setState({ loading: true, error: null, currentEntry: null, indexMarkdown: null, log: null });
  try {
    const [currentConflict, conflicts] = await Promise.all([
      fetchConflictDetail(id),
      fetchConflicts().catch(() => state.conflicts),
    ]);
    setState({
      currentConflict,
      conflicts,
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export function clearCurrentEntry(): void {
  setState({
    currentEntry: null,
    currentMatchHint: null,
    currentConflict: null,
    indexMarkdown: null,
    log: null,
    error: null,
    loading: false,
  });
}

export function rememberMatchHint(hit: BriefingHit | null): void {
  setState({ currentMatchHint: hit });
}

export function setPendingPatchCount(count: number): void {
  setState({ pendingPatchCount: count });
}

export function findIndexEntry(id: string): WikiIndexEntry | null {
  return state.index.find((entry) => entry.id === id) ?? null;
}

function setState(next: Partial<AppState>): void {
  Object.assign(state, next);
  for (const listener of listeners) listener(state);
}

function updateRecentIds(id: string): string[] {
  const recentIds = [id, ...state.recentIds.filter((recentId) => recentId !== id)].slice(0, 8);
  window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentIds));
  return recentIds;
}

function readRecentIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
