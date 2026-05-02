/**
 * admiral/agent/connections — 세션 연결 관리 공개 API.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { getSessionId } from "./internal/session-runtime.js";

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** carrierId의 ACP sessionId 조회 */
export function getSessionIdFor(carrierId: string): string | undefined {
  return getSessionId(carrierId);
}
