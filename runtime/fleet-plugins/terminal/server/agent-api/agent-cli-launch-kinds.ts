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
        title: cli.label,
        supportsInitialPrompt: true,
        ...(disabledReason ? { disabled: true, disabledReason } : {}),
      };
    });
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
