import type { DedicatedCliInjectionContext } from "../types.js";

export function buildClaudeNativeArgs(context: DedicatedCliInjectionContext): string[] {
  return [
    "--append-system-prompt-file",
    context.systemPromptFile,
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        "fleet-tools": {
          type: "http",
          url: context.endpointUrl,
          headers: {
            Authorization: `Bearer ${context.bearerToken}`,
          },
        },
      },
    }),
    "--dangerously-skip-permissions",
  ];
}
