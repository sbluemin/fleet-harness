import type { AgentCliInjectionContext } from "../types.js";

export function buildCursorNativeArgs(context: AgentCliInjectionContext): string[] {
  return [
    ...buildResumeArgs(context.resumeSessionId),
    ...context.pluginRoots.flatMap((pluginRoot) => [
      "--plugin-dir",
      pluginRoot,
    ]),
    "--sandbox",
    "disabled",
    "--force",
    ...(context.mcpServers.length > 0 ? ["--approve-mcps"] : []),
  ];
}

function buildResumeArgs(resumeSessionId: string | undefined): string[] {
  return resumeSessionId === undefined ? [] : ["--resume", resumeSessionId];
}
