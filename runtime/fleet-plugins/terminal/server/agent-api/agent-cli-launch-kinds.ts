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

function resolveOperationTitle(cli: AgentCliLaunchMetadata): string {
  return cli.id === "claude" || cli.id === "codex" ? `${cli.label} (Classic)` : cli.label;
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
