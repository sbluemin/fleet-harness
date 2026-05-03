import { fetchBacklinks, fetchEntry, fetchHealth, fetchIndex } from "./api";
import type { BacklinkEntry, HealthResponse, WikiEntryResponse, WikiIndexEntry } from "./api";

export interface AppState {
  health: HealthResponse | null;
  index: WikiIndexEntry[];
  currentEntry: WikiEntryResponse | null;
  backlinks: BacklinkEntry[];
  loading: boolean;
  error: string | null;
  recentIds: string[];
}

type StateListener = (state: AppState) => void;

const RECENT_STORAGE_KEY = "fleet-wiki-web-recent";
const listeners = new Set<StateListener>();
const state: AppState = {
  health: null,
  index: [],
  currentEntry: null,
  backlinks: [],
  loading: false,
  error: null,
  recentIds: readRecentIds(),
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
    const [health, index] = await Promise.all([fetchHealth(), fetchIndex()]);
    setState({ health, index, loading: false });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadEntry(id: string): Promise<void> {
  setState({ loading: true, error: null, currentEntry: null, backlinks: [] });
  try {
    const [currentEntry, backlinksResponse] = await Promise.all([
      fetchEntry(id),
      fetchBacklinks(id),
    ]);
    const recentIds = updateRecentIds(id);
    setState({
      currentEntry,
      backlinks: backlinksResponse.backlinks,
      recentIds,
      loading: false,
    });
  } catch (error) {
    setState({ loading: false, error: errorMessage(error) });
  }
}

export function clearCurrentEntry(): void {
  setState({ currentEntry: null, backlinks: [], error: null, loading: false });
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
