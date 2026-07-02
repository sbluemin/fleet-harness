import type { AgentCliId } from "@dotobokuri/fleet-admiral";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";

import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

const UNSUPPORTED_AGENT_CLI_IDS: ReadonlySet<AgentCliId> = new Set(["claude-kimi", "claude-glm"]);

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
): OperationLaunchKind[] {
  return metadata
    .filter((cli) => !UNSUPPORTED_AGENT_CLI_IDS.has(cli.id))
    .map((cli) => {
      const disabledReason = resolveDisabledReason(cli);
      return {
        id: cli.id,
        type: operationType,
        title: cli.label,
        ...(disabledReason ? { disabled: true, disabledReason } : {}),
      };
    });
}

function resolveDisabledReason(cli: AgentCliLaunchMetadata): string | undefined {
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
