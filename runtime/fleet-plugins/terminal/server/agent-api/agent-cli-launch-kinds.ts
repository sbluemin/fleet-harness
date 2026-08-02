import type { OperationLaunchKind } from "@fleet-console/sdk/operations";

import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
): OperationLaunchKind[] {
  return metadata
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: operationType,
        title: resolveOperationTitle(cli),
        ...(disabledReason ? { disabled: true, disabledReason } : {}),
      };
    });
}

// (Classic)은 같은 CLI에 다른 변형이 함께 있을 때만 뜻이 있다. Claude는 Native·Gateway와 나란히
// 서므로 구분이 필요하지만, Codex에는 대비할 변형이 없어 접미가 있지도 않은 선택지를 암시한다.
function resolveOperationTitle(cli: AgentCliLaunchMetadata): string {
  return cli.id === "claude" ? `${cli.label} (Classic)` : cli.label;
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
