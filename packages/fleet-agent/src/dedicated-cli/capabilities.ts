import type { DedicatedCliId, DedicatedCliInjectionCapability } from "./types.js";

export const DEDICATED_CLI_INJECTION_CAPABILITIES: Record<DedicatedCliId, DedicatedCliInjectionCapability> = {
  claude: {
    builderId: "claude-native",
    enabled: true,
  },
  codex: {
    builderId: "codex-native",
    enabled: true,
  },
};

export function getDedicatedCliInjectionCapability(
  cliId: DedicatedCliId,
): DedicatedCliInjectionCapability {
  return DEDICATED_CLI_INJECTION_CAPABILITIES[cliId];
}
