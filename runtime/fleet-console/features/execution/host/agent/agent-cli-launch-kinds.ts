import type { OperationLaunchKind, OperationLaunchVariantGroup } from "@fleet-console/sdk/operations";
import type { AiGatewaySelection } from "@fleet-console/ai-gateway";

import { buildModelRoster } from "../../../ai-gateway/host/model-roster.js";
import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

export { EFFORT_LABELS } from "../../../ai-gateway/host/model-roster.js";

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
  gatewaySelection?: AiGatewaySelection,
): OperationLaunchKind[] {
  return metadata
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: operationType,
        title: cli.label,
        ...(disabledReason
          ? { disabled: true, disabledReason }
          : cli.id === "claude"
            ? {
              variants: buildClaudeLaunchVariants(gatewaySelection),
              // 채팅으로 태어나는 길은 SDK 인수 계약 위에 서므로 Claude Gateway 종류에서만 열린다
              // (전환 경로의 `chat_unsupported`와 같은 판정). 다른 종류는 선언하지 않으므로
              // 컴포저의 시작 뷰 선택 자체가 서지 않는다.
              launchViews: ["terminal", "chat"] as const,
            }
            : {}),
      };
    });
}

/**
 * Claude 종류의 런치 행은 모델 로스터의 launch 투영 그대로다 — Settings › AI Gateway에서 켠 모델(Claude 항목 포함)이
 * Quick Launch·채팅 좌표·캔버스·Objectives 보드의 유일한 선택지다. 로스터가 비면 행도 없고, 모델 없이 띄운 실행은
 * 서버가 최후 폴백(sonnet)으로 연다.
 */
function buildClaudeLaunchVariants(selection?: AiGatewaySelection): readonly OperationLaunchVariantGroup[] {
  return selection ? buildModelRoster(selection, "launch") : [];
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
