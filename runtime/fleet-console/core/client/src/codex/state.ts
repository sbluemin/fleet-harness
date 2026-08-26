import { fetchDrydock, fetchHealth, fetchSchemaCatalog, fetchSearch } from "./api.js";
import type { CodexHealthResponse, ConflictListItem, SchemaCatalogResponse, SearchEntry } from "./api.js";
import type { CodexKnowledgeScope } from "../../../host/codex/contracts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * 화면이 서버 사실을 어떤 방식으로 따라가고 있는지. `live`는 호스트 감시가 살아 있다는 뜻이고,
 * `polling`은 감시가 끊겨 주기 재검증으로 강등했다는 뜻이다.
 */
export type CodexLiveState = "live" | "polling" | "unknown";

export interface AppState {
  index: SearchEntry[];
  conflicts: ConflictListItem[];
  pendingPatchCount: number;
  schemaCatalog: SchemaCatalogResponse | null;
  currentWorkspaceId: string | null;
  loading: boolean;
  error: string | null;
  health: CodexHealthResponse | null;
  liveState: CodexLiveState;
  /** 마지막으로 서버 사실을 확인한 시각(epoch ms). 신선도 표기의 유일한 출처다. */
  lastCheckedAt: number | null;
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
  health: null,
  liveState: "unknown",
  lastCheckedAt: null,
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
  // 패널이 뜨는 동안 이 함수는 같은 워크스페이스로 두 번 불린다(마운트 한 번, Theater 배선 한 번).
  // 그때마다 감시 상태까지 지우면, 그 사이 도착한 "감시 중" 통지가 지워진 채 다시 올 일이 없어
  // 살아 있는 감시가 영영 "연결 전"으로 남는다 — 잊는 것은 워크스페이스가 실제로 바뀔 때만.
  const changed = state.currentWorkspaceId !== id;
  workspaceEpoch += 1;
  setState(changed
    ? { currentWorkspaceId: id, schemaCatalog: null, health: null, liveState: "unknown", lastCheckedAt: null }
    : { currentWorkspaceId: id, schemaCatalog: null });
}

export function setLiveState(next: CodexLiveState): void {
  if (state.liveState === next) return;
  setState({ liveState: next });
}

export async function loadInitialData(): Promise<void> {
  const theaterId = state.currentWorkspaceId;
  const capturedEpoch = workspaceEpoch;
  setState({ loading: true, error: null });
  try {
    const [searchResult, drydockList, schemaCatalog, health] = await Promise.all([
      fetchSearch(theaterId),
      fetchDrydock(theaterId, "pending").catch(() => null),
      fetchSchemaCatalog(theaterId).catch(() => null),
      fetchHealth(theaterId).catch(() => null),
    ]);
    if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;
    setState({
      index: searchResult.entries,
      pendingPatchCount: drydockList?.pendingCount ?? 0,
      schemaCatalog,
      health,
      loading: false,
      lastCheckedAt: Date.now(),
    });
  } catch (error) {
    if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;
    setState({ loading: false, error: errorMessage(error) });
  }
}

/**
 * 변한 범위만 다시 읽는다. 이벤트가 실어 온 것은 힌트일 뿐이므로 사실은 언제나 정식 API에서
 * 가져온다 — 이벤트 순서가 뒤바뀌거나 하나 유실돼도 화면은 서버를 따라간다.
 *
 * 상태 칩(health)은 어느 범위가 변하든 함께 다시 읽는다. 대기 수·충돌 수·drydock 결과가
 * 모두 그 한 칩에 모여 있어서, 범위별로 나누면 칩만 옛 숫자로 남는다.
 */
export async function revalidateScopes(scopes: readonly CodexKnowledgeScope[]): Promise<void> {
  const theaterId = state.currentWorkspaceId;
  const capturedEpoch = workspaceEpoch;
  const wanted = new Set(scopes);
  const needsIndex = wanted.has("wiki") || wanted.has("index");
  const needsQueue = wanted.has("queue");
  const needsSchema = wanted.has("schema");

  const [searchResult, drydockList, schemaCatalog, health] = await Promise.all([
    needsIndex ? fetchSearch(theaterId).catch(() => null) : Promise.resolve(null),
    needsQueue ? fetchDrydock(theaterId, "pending").catch(() => null) : Promise.resolve(null),
    needsSchema ? fetchSchemaCatalog(theaterId).catch(() => null) : Promise.resolve(null),
    fetchHealth(theaterId).catch(() => null),
  ]);
  if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;

  const next: Partial<AppState> = { lastCheckedAt: Date.now() };
  if (searchResult) {
    next.index = searchResult.entries;
    // 재검증이 성공했다면 이전 로드 실패는 더 이상 사실이 아니다.
    next.error = null;
  }
  if (drydockList) next.pendingPatchCount = drydockList.pendingCount;
  if (schemaCatalog) next.schemaCatalog = schemaCatalog;
  if (health) next.health = health;
  setState(next);
}

/** 전 범위 재검증 — 창 복귀·감시 강등 폴링처럼 "무엇이 변했는지 모를 때" 쓴다. */
export async function revalidateAll(): Promise<void> {
  await revalidateScopes(["wiki", "queue", "schema", "index", "conflicts"]);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function setState(next: Partial<AppState>): void {
  Object.assign(state, next);
  for (const listener of listeners) listener(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
