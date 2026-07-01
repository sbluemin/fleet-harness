import type { AgentCliId } from "@dotobokuri/fleet-admiral";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";

import type { AgentCliLaunchMetadata } from "./agent-cli-launch-metadata.js";

const UNSUPPORTED_AGENT_CLI_IDS: ReadonlySet<AgentCliId> = new Set(["claude-kimi", "claude-glm"]);
const UNSUPPORTED_AGENT_CLI_DISABLED_REASON = "Not supported";

export function buildAgentCliLaunchKinds(
  metadata: readonly AgentCliLaunchMetadata[],
  operationType: string,
): OperationLaunchKind[] {
  return metadata.map((cli) => {
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
  if (UNSUPPORTED_AGENT_CLI_IDS.has(cli.id)) return UNSUPPORTED_AGENT_CLI_DISABLED_REASON;
  if (!cli.available) return "Not installed";
  if (!cli.signedIn) return "Sign in required";
  return undefined;
}
