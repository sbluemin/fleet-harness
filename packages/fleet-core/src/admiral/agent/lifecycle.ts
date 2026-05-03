/**
 * admiral/agent/lifecycle — 세션 라이프사이클 공개 API.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { getOrInitState, resetState } from "./internal/state.js";
import { clearSessionsAndPreSpawn } from "./internal/session-engine.js";
import { onHostSessionChange } from "./internal/session-runtime.js";
import { engineDisconnectAll } from "./internal/executor-engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 호스트 세션 바인딩 — session_start/session_tree 이벤트에서 호출 */
export function bindHostSession(piSessionId: string): void {
  onHostSessionChange(piSessionId);
}

/** 모든 ACP 세션 정리 — session_shutdown 이벤트에서 호출 */
export async function shutdownAllSessions(): Promise<void> {
  const state = getOrInitState();
  await clearSessionsAndPreSpawn(state);
  await engineDisconnectAll();
  resetState();
}
