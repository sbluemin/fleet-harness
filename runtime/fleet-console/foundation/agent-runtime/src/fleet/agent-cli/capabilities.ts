import type { AgentCliId, AgentCliInjectionCapability } from "./types.js";

const AGENT_CLI_INJECTION_CAPABILITIES: Record<AgentCliId, AgentCliInjectionCapability> = {
  claude: {
    builderId: "claude",
    enabled: true,
  },
};

export function getAgentCliInjectionCapability(
  cliId: AgentCliId,
): AgentCliInjectionCapability {
  return AGENT_CLI_INJECTION_CAPABILITIES[cliId];
}
