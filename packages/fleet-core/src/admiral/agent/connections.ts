/**
 * admiral/agent/connections — 세션 연결 관리 공개 API.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { getSessionId } from "./internal/session-runtime.js";
import {
  engineDisconnect,
  engineDisconnectAll,
  engineCleanIdle,
} from "./internal/executor-engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** carrierId의 ACP sessionId 조회 */
export function getSessionIdFor(carrierId: string): string | undefined {
  return getSessionId(carrierId);
}

/** carrierId의 executor 풀 클라이언트 종료 */
export async function disconnect(carrierId: string): Promise<boolean> {
  return engineDisconnect(carrierId);
}

/** executor 풀 전체 정리 */
export async function disconnectAll(): Promise<void> {
  await engineDisconnectAll();
}

/** busy가 아닌 executor 클라이언트 정리 */
export function cleanIdle(): void {
  engineCleanIdle();
}
