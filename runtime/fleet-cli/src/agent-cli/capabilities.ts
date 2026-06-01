import type { AgentCliId, AgentCliInjectionCapability } from "./types.js";

export const AGENT_CLI_INJECTION_CAPABILITIES: Record<AgentCliId, AgentCliInjectionCapability> = {
  claude: {
    builderId: "claude-native",
    enabled: true,
  },
  "claude-kimi": {
    builderId: "claude-native",
    enabled: true,
  },
  codex: {
    builderId: "codex-native",
    enabled: true,
  },
};

export function getAgentCliInjectionCapability(
  cliId: AgentCliId,
): AgentCliInjectionCapability {
  return AGENT_CLI_INJECTION_CAPABILITIES[cliId];
}
