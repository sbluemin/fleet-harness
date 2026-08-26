import type { CodexKnowledgeScope, CodexWatchState } from "../../../host/codex/contracts";
import { getState, revalidateAll, revalidateScopes, setLiveState, subscribeState } from "./state.js";

/**
 * 열려 있는 리더에게 "네가 보고 있는 것이 바뀌었다"고 알리는 브라우저 이벤트.
 *
 * 리더는 이 신호를 받아도 본문을 갈아끼우지 않는다 — 읽던 자리를 잃기 때문이다. 대신
 * 갱신 사실만 알리고, 언제 새로 읽을지는 읽는 사람이 정한다.
 */
export const CODEX_LIVE_CHANGED_EVENT = "codex-live-changed";

export interface CodexLiveChangedDetail {
  readonly scopes: readonly CodexKnowledgeScope[];
}

// 감시가 끊긴 워크스페이스의 폴백 주기. 사람이 문서를 읽는 리듬에 견줘 충분히 잦고,
// 유휴 요청으로는 눈에 띄지 않는 값이다.
const DEGRADED_POLL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let installed = false;
let watchStateByWorkspace = new Map<string, CodexWatchState>();
// 이 화면이 살아 있는 동안 "감시 중"을 이미 한 번 받아 본 워크스페이스. 두 번째부터는
// 새 스트림이 붙었다는 뜻이다.
let watchedSince = new Set<string>();
// 마지막으로 감시 상태를 맞춰 둔 워크스페이스. undefined는 "아직 한 번도"라는 뜻이다.
let syncedWorkspace: string | null | undefined = undefined;

function isCurrentWorkspace(workspaceId: string): boolean {
  return getState().currentWorkspaceId === workspaceId;
}

function stopPolling(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    void revalidateAll().catch(() => {});
  }, DEGRADED_POLL_MS);
}

function notifyReader(scopes: readonly CodexKnowledgeScope[]): void {
  document.dispatchEvent(
    new CustomEvent<CodexLiveChangedDetail>(CODEX_LIVE_CHANGED_EVENT, { detail: { scopes } }),
  );
}

/** SSE `codex:changed` 수신 지점. 이벤트는 힌트이므로 사실은 정식 API에서 다시 읽는다. */
export function applyCodexChanged(workspaceId: string, scopes: readonly CodexKnowledgeScope[]): void {
  if (!isCurrentWorkspace(workspaceId) || scopes.length === 0) return;
  // 리더에게는 재검증이 끝난 뒤 알린다 — 리더는 갱신된 카탈로그를 근거로 "내가 읽는 문서가
  // 정말 바뀌었는가"를 판정하므로, 먼저 알리면 옛 카탈로그를 보고 오판한다.
  void revalidateScopes(scopes).catch(() => {}).then(() => notifyReader(scopes));
}

/** SSE `codex:watch` 수신 지점. 감시가 끊기면 화면은 스스로 주기 재검증으로 강등한다. */
export function applyCodexWatchState(workspaceId: string, state: CodexWatchState): void {
  watchStateByWorkspace.set(workspaceId, state);
  if (!isCurrentWorkspace(workspaceId)) return;
  if (state === "degraded") {
    setLiveState("polling");
    startPolling();
    // 강등된 순간 이미 놓친 변화가 있을 수 있다.
    void revalidateAll().catch(() => {});
    return;
  }
  // 스트림이 끊겼다 붙는 사이의 변화는 이벤트로 오지 않는다 — 이 워크스페이스를 이미 보고
  // 있었다면 재연결은 곧 "놓친 것이 있을 수 있다"는 뜻이므로 한 번 따라잡는다.
  const reconnected = watchedSince.has(workspaceId);
  watchedSince.add(workspaceId);
  setLiveState("live");
  stopPolling();
  if (reconnected) void revalidateAll().catch(() => {});
}

/**
 * 워크스페이스가 바뀌면 감시 상태도 그 워크스페이스의 것으로 바꾼다. 아직 아무 통지도 받지
 * 못했다면 `unknown`으로 두는 편이 정직하다 — 살아 있다고 말할 근거가 아직 없다.
 */
export function syncCodexLiveWorkspace(workspaceId: string | null): void {
  syncedWorkspace = workspaceId;
  if (workspaceId === null) {
    setLiveState("unknown");
    stopPolling();
    return;
  }
  const known = watchStateByWorkspace.get(workspaceId) ?? null;
  if (known === "degraded") {
    setLiveState("polling");
    startPolling();
    return;
  }
  setLiveState(known === "watching" ? "live" : "unknown");
  stopPolling();
}

/**
 * 안전망: 화면으로 돌아왔을 때 다시 읽는다. 감시가 살아 있어도 SSE가 끊겼다 붙는 사이의
 * 변화는 이벤트로 오지 않으므로, 복귀는 언제나 재검증할 값어치가 있다.
 */
export function installCodexLiveRevalidation(): () => void {
  if (installed) return () => {};
  installed = true;
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    if (getState().currentWorkspaceId === null) return;
    void revalidateAll().catch(() => {});
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);

  /**
   * 감시 통지는 화면이 어느 워크스페이스를 보는지 정해지기 *전에* 도착한다 — 패널을 열면
   * 서버가 감시를 시작하고, 그 프레임이 POST 응답보다 먼저 오기 때문이다. 그래서 한 지점에서
   * 한 번만 맞추면 그 순간의 통지를 놓치고 살아 있는 감시가 영영 "연결 전"으로 남는다.
   * 워크스페이스가 정해지는 모든 전이에서 다시 맞춘다.
   */
  syncCodexLiveWorkspace(getState().currentWorkspaceId);
  const unsubscribe = subscribeState((state) => {
    if (state.currentWorkspaceId === syncedWorkspace) return;
    syncCodexLiveWorkspace(state.currentWorkspaceId);
  });

  return () => {
    installed = false;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    unsubscribe();
    stopPolling();
  };
}

/** 레일 탭 복귀처럼 "다시 보게 된" 순간의 재검증. */
export function revalidateCodexNow(): void {
  if (getState().currentWorkspaceId === null) return;
  void revalidateAll().catch(() => {});
}

/** 테스트 전용 — 모듈 스코프 감시 상태를 비운다. */
export function resetCodexLiveForTest(): void {
  watchStateByWorkspace = new Map();
  watchedSince = new Set();
  syncedWorkspace = undefined;
  stopPolling();
  installed = false;
}
