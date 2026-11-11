import type { GatewayEnabledModelsResponse } from "@fleet-console/ai-gateway";
import type { ConsoleMcpTool } from "../../execution/shared/tools.js";

/** 사령관·지휘관에게만 싣는 Gateway 서버 이름. 플러그인 등록 경로에서는 예약어다. */
export const FLEET_AI_GATEWAY_MCP_SERVER = "fleet-ai-gateway";

/** 지휘관이 받는 예약 서버의 instructions. 사령관은 `plan`/`commence`의 `commanderModel` 입력 설명에서 읽는다. */
export const COMMANDER_MODELS_INSTRUCTIONS = "Omit member model and effort by default; AI Gateway routing chooses them at muster. Specify a model from fleet-ai-gateway models only when its missions need a specific one.";

const MODELS_TOOL_DESCRIPTION =
  "Enabled models and allowed efforts for explicit selection. No quota data or ranking.";

/**
 * `models` 도구. 결과는 `GET /api/v1/ai-gateway/enabled-models` 본문과 같은 함수가 만든 값 그대로다.
 * 누가 부를 수 있는지는 이 도구가 아니라 싣는 쪽(사령관 세션 묶음·예약 서버 등록)이 정한다.
 */
export function createGatewayModelsTool(readEnabledModels: () => GatewayEnabledModelsResponse): ConsoleMcpTool {
  return {
    name: "models",
    description: MODELS_TOOL_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const body = readEnabledModels();
      return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body, isError: false };
    },
  };
}
