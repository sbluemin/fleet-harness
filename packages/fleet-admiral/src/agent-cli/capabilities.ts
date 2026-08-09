import type { AgentCliId, AgentCliInjectionCapability } from "./types.js";

const AGENT_CLI_INJECTION_CAPABILITIES: Record<AgentCliId, AgentCliInjectionCapability> = {
  "claude-gateway": {
    builderId: "claude-gateway",
    enabled: true,
  },
};

export function getAgentCliInjectionCapability(
  cliId: AgentCliId,
): AgentCliInjectionCapability {
  return AGENT_CLI_INJECTION_CAPABILITIES[cliId];
}
