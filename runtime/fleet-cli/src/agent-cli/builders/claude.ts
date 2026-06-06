import type { AgentCliInjectionContext } from "../types.js";

export function buildClaudeNativeArgs(context: AgentCliInjectionContext): string[] {
  return [
    ...context.pluginRoots.flatMap((pluginRoot) => [
      "--plugin-dir",
      pluginRoot,
    ]),
    "--dangerously-skip-permissions",
  ];
}
