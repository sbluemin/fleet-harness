import { fetchDrydock, fetchHealth, fetchSchemaCatalog, fetchSearch } from "./api.js";
import type { CodexHealthResponse, ConflictListItem, SchemaCatalogResponse, SearchEntry } from "./api.js";
import type { CodexKnowledgeScope } from "../../server/codex/contracts.js";

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
/**
 * 요청 일련번호. 같은 워크스페이스 안에서도 재검증은 겹치고(연달아 온 변화 힌트, 창 복귀와
 * 이벤트의 충돌), 나중에 시작한 요청이 먼저 끝나면 오래된 응답이 최신 사실을 덮어쓴다.
 */
let requestSeq = 0;
/**
 * 상태 조각마다 마지막으로 반영한 요청 번호. 무효화를 요청 단위가 아니라 조각 단위로 두는
 * 이유는, 서로 다른 범위의 재검증이 겹칠 때 한쪽이 다른 쪽을 통째로 버리면 안 되기 때문이다 —
 * 스키마를 다시 읽는 요청은 대기열을 가져오지도 않았으므로 대기열 결과를 무효로 만들 수 없다.
 */
const committedSeq: Record<"index" | "queue" | "schema" | "health", number> = {
  index: 0,
  queue: 0,
  schema: 0,
  health: 0,
};
/** loading·error는 초기 로드만의 상태다 — 그 경합은 따로 센다. */
let loadEpoch = 0;

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
  const seq = ++requestSeq;
  const myLoad = ++loadEpoch;
  setState({ loading: true, error: null });
  try {
    const [searchResult, drydockList, schemaCatalog, health] = await Promise.all([
      fetchSearch(theaterId),
      fetchDrydock(theaterId, "pending").catch(() => null),
      fetchSchemaCatalog(theaterId).catch(() => null),
      fetchHealth(theaterId).catch(() => null),
    ]);
    if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;
    const next: Partial<AppState> = { loading: myLoad === loadEpoch ? false : state.loading };
    if (commitSlot("index", seq)) next.index = searchResult.entries;
    if (commitSlot("queue", seq)) next.pendingPatchCount = drydockList?.pendingCount ?? 0;
    if (commitSlot("schema", seq)) next.schemaCatalog = schemaCatalog;
    if (commitSlot("health", seq)) next.health = health;
    next.lastCheckedAt = Date.now();
    setState(next);
  } catch (error) {
    if (state.currentWorkspaceId !== theaterId || workspaceEpoch !== capturedEpoch) return;
    // 나보다 새 로드가 이미 시작됐다면 이 실패는 낡은 소식이다 — 최신 화면에 옛 오류를
    // 씌우거나 진행 중인 로드의 loading을 대신 꺼서는 안 된다.
    if (myLoad !== loadEpoch) return;
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
  const seq = ++requestSeq;
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

  const next: Partial<AppState> = {};
  let committed = false;
  if (searchResult && commitSlot("index", seq)) {
    next.index = searchResult.entries;
    // 재검증이 성공했다면 이전 로드 실패는 더 이상 사실이 아니다.
    next.error = null;
    committed = true;
  }
  if (drydockList && commitSlot("queue", seq)) {
    next.pendingPatchCount = drydockList.pendingCount;
    committed = true;
  }
  if (schemaCatalog && commitSlot("schema", seq)) {
    next.schemaCatalog = schemaCatalog;
    committed = true;
  }
  if (health && commitSlot("health", seq)) {
    next.health = health;
    committed = true;
  }
  // 확인한 것이 없는데 시각을 밀면 신선도 표기가 거짓말을 한다. 이미 더 새 응답이 반영된
  // 뒤 도착한 낡은 응답도 마찬가지로 아무것도 확인해 주지 못한다.
  if (committed) next.lastCheckedAt = Date.now();
  setState(next);
}

/** 전 범위 재검증 — 창 복귀·감시 강등 폴링처럼 "무엇이 변했는지 모를 때" 쓴다. */
export async function revalidateAll(): Promise<void> {
  await revalidateScopes(["wiki", "queue", "schema", "index", "conflicts"]);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** 이 조각에 더 새 응답이 이미 반영됐다면 낡은 응답은 버린다. */
function commitSlot(slot: keyof typeof committedSeq, seq: number): boolean {
  if (seq <= committedSeq[slot]) return false;
  committedSeq[slot] = seq;
  return true;
}

function setState(next: Partial<AppState>): void {
  Object.assign(state, next);
  for (const listener of listeners) listener(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
