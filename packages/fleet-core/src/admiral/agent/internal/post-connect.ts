/**
 * admiral/agent/internal/post-connect — 연결 후 추론 설정 적용.
 *
 * session-engine과 executor-engine 모두 이 모듈에서 import.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import { getEffort, type CliType } from "@sbluemin/fleet-unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

interface ConfigClient {
  setConfigOption(configId: string, value: string): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 연결 후 effort 등을 세션에 적용 */
export async function applyPostConnectConfig(
  client: ConfigClient,
  cli: CliType,
  model: string,
  overrides?: { effort?: string },
): Promise<boolean> {
  if (overrides?.effort) {
    const modelEffort = getEffort(cli, model);
    if (modelEffort.supported && modelEffort.levels.includes(overrides.effort)) {
      try {
        await client.setConfigOption("effort", overrides.effort);
        return true;
      } catch (err) {
        const errorObj = typeof err === "object" && err !== null
          ? (err as {
              code?: unknown;
              message?: unknown;
              data?: { details?: unknown };
            })
          : null;
        console.warn("[acp] setConfigOption 실패", {
          cli,
          model,
          option: "effort",
          value: overrides.effort,
          code: errorObj?.code,
          details: errorObj?.data?.details,
          message: typeof errorObj?.message === "string"
            ? errorObj.message
            : String(err),
        });
      }
    }
  }
  return false;
}
