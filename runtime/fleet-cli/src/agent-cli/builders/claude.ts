import type { ClaudeSubagentColor } from "@dotobokuri/fleet-carriers";

import type { AgentCliInjectionContext } from "../types.js";

interface ClaudeNativeAgentPayload {
  readonly color?: ClaudeSubagentColor;
  readonly description: string;
  readonly model?: string;
  readonly prompt: string;
}

export function buildClaudeNativeArgs(context: AgentCliInjectionContext): string[] {
  const systemPromptArg = context.replaceSystemPrompt ? "--system-prompt-file" : "--append-system-prompt-file";
  const args = [
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
  if (context.claudeSubagents && context.claudeSubagents.length > 0) {
    args.push("--agents", JSON.stringify(buildClaudeAgentsPayload(context.claudeSubagents)));
  }
  return args;
}

function buildClaudeAgentsPayload(
  subagents: NonNullable<AgentCliInjectionContext["claudeSubagents"]>,
): Record<string, ClaudeNativeAgentPayload> {
  return Object.fromEntries(
    subagents.map((subagent) => {
      const payload: ClaudeNativeAgentPayload = {
        ...(subagent.color ? { color: subagent.color } : {}),
        description: subagent.description,
        ...(subagent.model ? { model: subagent.model } : {}),
        prompt: subagent.prompt,
      };
      return [subagent.name, payload];
    }),
  );
}
