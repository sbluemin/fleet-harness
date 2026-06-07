import type { AgentCliInjectionContext, AgentCliMcpServerArg } from "../types.js";

export function buildClaudeNativeArgs(context: AgentCliInjectionContext): string[] {
  const systemPromptArg = context.replaceSystemPrompt ? "--system-prompt-file" : "--append-system-prompt-file";
  return [
    systemPromptArg,
    requireSystemPromptFile(context),
    ...context.pluginRoots.flatMap((pluginRoot) => [
      "--plugin-dir",
      pluginRoot,
    ]),
    ...(context.mcpServers.length > 0 ? ["--mcp-config", buildClaudeMcpConfig(context.mcpServers)] : []),
    "--dangerously-skip-permissions",
  ];
}

function buildClaudeMcpConfig(servers: readonly AgentCliMcpServerArg[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      servers.map((server) => [server.name, {
        type: "http",
        url: server.endpointUrl,
        headers: {
          Authorization: `Bearer ${server.bearerToken}`,
        },
      }]),
    ),
  });
}

function requireSystemPromptFile(context: AgentCliInjectionContext): string {
  if (context.systemPromptFile) return context.systemPromptFile;
  throw new Error("Claude system prompt file is required for native injection");
}
