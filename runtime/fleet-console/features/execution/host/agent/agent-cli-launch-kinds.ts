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
function buildClaudeLaunchVariants(statuses: ProviderStatusMap | undefined): readonly ObjectiveLaunchVariantGroup[] {
  const roster = buildModelRoster("launch", statuses);
  return roster.length > 0 ? roster : [buildRosterFallbackGroup()];
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
