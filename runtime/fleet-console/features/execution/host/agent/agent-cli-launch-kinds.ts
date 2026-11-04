import type { ObjectiveLaunchKind, ObjectiveLaunchVariantGroup } from "../../../objectives/shared/records/types.js";
import type { ProviderStatusMap } from "@fleet-console/ai-gateway";

import { buildModelRoster, buildRosterFallbackGroup } from "../../../ai-gateway/host/model-roster.js";
import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

export { EFFORT_LABELS } from "../../../ai-gateway/host/model-roster.js";

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  objectiveRecordType: string,
  statuses?: ProviderStatusMap,
): ObjectiveLaunchKind[] {
  return metadata
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: objectiveRecordType,
        title: cli.label,
        ...(disabledReason
          ? { disabled: true, disabledReason }
          : cli.id === "claude"
            ? {
              variants: buildClaudeLaunchVariants(statuses),
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
 * Claude 종류의 런치 행은 모델 로스터의 launch 투영 그대로다 — 로그인된 공급자의 카탈로그 전체가
 * 새 세션·채팅 좌표·캔버스·Objectives 보드의 선택지다. 그 카탈로그가 비면(전부 로그아웃) 최후 폴백
 * (sonnet) 한 행의 폴백 띠만 서고, 표면은 그 띠를 폴백 표식으로 그린다.
 */
function buildClaudeLaunchVariants(statuses?: ProviderStatusMap): readonly ObjectiveLaunchVariantGroup[] {
  const roster = buildModelRoster("launch", statuses);
  return roster.length > 0 ? roster : [buildRosterFallbackGroup()];
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
