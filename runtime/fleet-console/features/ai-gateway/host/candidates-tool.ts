import type { GatewayCandidatesResponse } from "@fleet-console/ai-gateway";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";

/** 사령관·지휘관에게만 싣는 Gateway 서버 이름. 플러그인 등록 경로에서는 예약어다. */
export const FLEET_AI_GATEWAY_MCP_SERVER = "fleet-ai-gateway";

const CANDIDATES_TOOL_DESCRIPTION =
  "Current eligible models and allowed efforts, ordered by quota headroom (most first). Unknown pressure is unmeasured, not low pressure.";

/**
 * `candidates` 도구. 결과는 `GET /api/v1/ai-gateway/candidates` 본문과 같은 함수가 만든 값 그대로다.
 * 누가 부를 수 있는지는 이 도구가 아니라 싣는 쪽(사령관 세션 묶음·예약 서버 등록)이 정한다.
 */
export function createGatewayCandidatesTool(readCandidates: () => GatewayCandidatesResponse): ConsoleMcpTool {
  return {
    name: "candidates",
    description: CANDIDATES_TOOL_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const body = readCandidates();
      return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: false };
    },
  };
}
