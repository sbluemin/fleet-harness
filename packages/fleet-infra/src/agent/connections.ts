/**
 * admiral/agent/connections — 세션 연결 관리 공개 API.
 *
 * poolKey로 식별자를 일반화.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { sessionRuntime } from "./internal/session-runtime.js";
import {
  engineDisconnect,
  engineDisconnectAll,
  engineCleanIdle,
} from "./internal/executor-engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** poolKey의 ACP sessionId 조회 */
export function getSessionIdFor(poolKey: string): string | undefined {
  return sessionRuntime.getCarrierSessionStore().get(poolKey);
}

/** poolKey의 executor 풀 클라이언트 종료 */
export async function disconnect(poolKey: string): Promise<boolean> {
  return engineDisconnect(poolKey);
}

/** executor 풀 전체 정리 */
export async function disconnectAll(): Promise<void> {
  await engineDisconnectAll();
}

/** busy가 아닌 executor 클라이언트 정리 */
export function cleanIdle(): void {
  engineCleanIdle();
}
