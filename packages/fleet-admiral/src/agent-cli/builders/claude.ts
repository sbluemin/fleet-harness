import type { AgentCliInjectionContext, AgentCliMcpServerArg } from "../types.js";

export function buildClaudeNativeArgs(context: AgentCliInjectionContext): string[] {
  return [
    ...buildResumeArgs(context.resumeSessionId),
    ...buildSystemPromptArgs(context),
    ...context.pluginRoots.flatMap((pluginRoot) => [
      "--plugin-dir",
      pluginRoot,
    ]),
    ...(context.mcpServers.length > 0 ? ["--mcp-config", buildClaudeMcpConfig(context.mcpServers)] : []),
    ...buildDisallowedAgentToolArgs(context.disallowedAgentTools),
    ...buildCustomAgentsArgs(context.customAgents),
    "--dangerously-skip-permissions",
  ];
}

function buildDisallowedAgentToolArgs(tools: readonly string[] | undefined): string[] {
  if (tools === undefined || tools.length === 0) return [];
  return ["--disallowedTools", ...tools];
}

function buildCustomAgentsArgs(
  agents: AgentCliInjectionContext["customAgents"],
): string[] {
  if (agents === undefined || Object.keys(agents).length === 0) return [];
  return ["--agents", JSON.stringify(agents)];
}

function buildResumeArgs(resumeSessionId: string | undefined): string[] {
  return resumeSessionId === undefined ? [] : ["--resume", resumeSessionId];
}

function buildSystemPromptArgs(context: AgentCliInjectionContext): string[] {
  // native 세션은 Admiral 시스템 프롬프트를 붙이지 않는다.
  if (context.systemPromptFile === undefined) return [];
  return ["--append-system-prompt-file", context.systemPromptFile];
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
