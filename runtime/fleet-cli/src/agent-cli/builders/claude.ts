import type { AgentCliInjectionContext } from "../types.js";

export function buildClaudeNativeArgs(context: AgentCliInjectionContext): string[] {
  return [
    "--plugin-dir",
    context.pluginRoot,
    "--dangerously-skip-permissions",
  ];
}
