import { fetchConflicts, fetchDrydock, fetchSchemaCatalog, fetchSearch } from "./api.js";
import type { ConflictListItem, SchemaCatalogResponse, SearchEntry } from "./api.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AppState {
  index: SearchEntry[];
  conflicts: ConflictListItem[];
  pendingPatchCount: number;
  schemaCatalog: SchemaCatalogResponse | null;
  currentWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
}

type StateListener = (state: AppState) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

const listeners = new Set<StateListener>();
let workspaceEpoch = 0;

// ─── State ────────────────────────────────────────────────────────────────────

const state: AppState = {
  index: [],
  conflicts: [],
  pendingPatchCount: 0,
  schemaCatalog: null,
  currentWorkspaceId: null,
  loading: false,
  error: null,
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function getState(): AppState {
  return state;
}

export function subscribeState(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// currentWorkspaceId 권위 SSoT — mount 시 initialWorkspaceId로 설정
export function setCurrentWorkspaceId(id: string | null): void {
  workspaceEpoch += 1;
  setState({ currentWorkspaceId: id, schemaCatalog: null });
}

export async function loadInitialData(): Promise<void> {
  const theaterId = state.currentWorkspaceId;
  const capturedEpoch = workspaceEpoch;
  setState({ loading: true, error: null });
  try {
    const [searchResult, drydockList, schemaCatalog] = await Promise.all([
      fetchSearch(theaterId),
      fetchDrydock(theaterId, "pending").catch(() => null),
      fetchSchemaCatalog(theaterId).catch(() => null),
    ]);
    if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;
    setState({
      index: searchResult.entries,
      pendingPatchCount: drydockList?.pendingCount ?? 0,
      schemaCatalog,
      loading: false,
    });
  } catch (error) {
    if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;
    setState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadConflicts(): Promise<void> {
  try {
    const conflicts = await fetchConflicts(state.currentWorkspaceId);
    setState({ conflicts });
  } catch {
    // conflicts 로드 실패는 silent — Navigator에서 진입점만 표시
  }
}

export function setPendingPatchCount(count: number): void {
  setState({ pendingPatchCount: count });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function setState(next: Partial<AppState>): void {
  Object.assign(state, next);
  for (const listener of listeners) listener(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
