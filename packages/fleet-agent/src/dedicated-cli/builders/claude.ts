import type { DedicatedCliInjectionContext } from "../types.js";

export function buildClaudeNativeArgs(context: DedicatedCliInjectionContext): string[] {
  const systemPromptArg = context.replaceSystemPrompt ? "--system-prompt-file" : "--append-system-prompt-file";
  return [
    systemPromptArg,
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
