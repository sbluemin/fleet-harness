import { createClaudeFamilyCliDefinition } from "./factory.js";

// Claude Code's bare `opus` alias is the default context window. Console's Opus
// row launches the 1M coordinate (`opus[1m]`) while the menu label stays "Opus".
export const NATIVE_CLAUDE_MODEL_ALIASES = ["fable", "opus[1m]", "sonnet"] as const;
export const NATIVE_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const NATIVE_CLAUDE_MODEL_ALIAS_REWRITES = {
  opus: "opus[1m]",
} as const satisfies Readonly<Record<string, (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number]>>;

/** Resolve a Console-native Claude Code model alias, rewriting legacy `opus` to `opus[1m]`. */
export function resolveNativeClaudeModelAlias(
  model: string,
): (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number] | undefined {
  const rewritten =
    NATIVE_CLAUDE_MODEL_ALIAS_REWRITES[model as keyof typeof NATIVE_CLAUDE_MODEL_ALIAS_REWRITES] ?? model;
  return NATIVE_CLAUDE_MODEL_ALIASES.includes(rewritten as (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number])
    ? (rewritten as (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number])
    : undefined;
}


// 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
export const claudeGatewayCli = createClaudeFamilyCliDefinition({
  id: "claude-gateway",
  label: "Claude (Gateway)",
});
