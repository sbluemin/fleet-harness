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
    ...buildCustomAgentsArgs(context.customAgents),
    ...buildSettingsArgs(context.skillOverrides),
    "--dangerously-skip-permissions",
  ];
}

/**
 * `--settings`는 인라인 JSON을 받아 flag 소스로 병합한다. 사용자·프로젝트 설정을
 * 대체하지 않으므로 여기서는 Fleet이 강제하는 키만 싣는다.
 */
function buildSettingsArgs(
  skillOverrides: AgentCliInjectionContext["skillOverrides"],
): string[] {
  if (skillOverrides === undefined || Object.keys(skillOverrides).length === 0) return [];
  return ["--settings", JSON.stringify({ skillOverrides })];
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
