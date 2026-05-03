/**
 * admiral/agent/internal/post-connect — 연결 후 추론 설정 적용.
 *
 * session-engine과 executor-engine 모두 이 모듈에서 import.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  getReasoningEffortLevels,
  type CliType,
} from "@sbluemin/unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

interface ConfigClient {
  setConfigOption(configId: string, value: string): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 연결 후 reasoning effort 등을 세션에 적용 */
export async function applyPostConnectConfig(
  client: ConfigClient,
  cli: CliType,
  overrides?: { effort?: string },
): Promise<void> {
  if (overrides?.effort) {
    const levels = getReasoningEffortLevels(cli);
    if (Array.isArray(levels) && levels.length > 0) {
      try {
        await client.setConfigOption("reasoning_effort", overrides.effort);
      } catch (err) {
        console.warn(`[acp] setConfigOption 실패 (cli=${cli}, option=reasoning_effort)`, err);
      }
    }
  }
}
