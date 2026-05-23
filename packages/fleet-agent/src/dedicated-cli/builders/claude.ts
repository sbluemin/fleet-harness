import type { DedicatedCliInjectionContext } from "../types.js";

export function buildClaudeNativeArgs(context: DedicatedCliInjectionContext): string[] {
  const systemPromptArg = context.replaceSystemPrompt ? "--system-prompt-file" : "--append-system-prompt-file";
  return [
    systemPromptArg,
    context.systemPromptFile,
    "--mcp-config",
    JSON.stringify({
      mcpServers: Object.fromEntries(
        context.mcpServers.map((server) => [
          server.name,
          {
          type: "http",
            url: server.endpointUrl,
          headers: {
              Authorization: `Bearer ${server.bearerToken}`,
          },
          },
        ]),
      ),
    }),
    "--dangerously-skip-permissions",
  ];
}
