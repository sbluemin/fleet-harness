import { createClaudeFamilyCliDefinition } from "./factory.js";

// Claude Code's bare `fable` and `opus` aliases use their default context windows.
// Console launches their 1M coordinates while keeping the plain menu labels.
export const NATIVE_CLAUDE_MODEL_ALIASES = ["fable[1m]", "opus[1m]", "sonnet"] as const;
export const NATIVE_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * 사다리 위의 단이 아니라 Claude Code 세션 모드다. `ultracode`는 xhigh 추론에 상시
 * dynamic workflow 오케스트레이션을 얹으므로 max보다 깊이 생각하는 단이 아니고, 세션 하나에만
 * 걸린다. 강도를 깊이로 읽는 표면(Analyst·Cowork)이 사다리를 늘렸다고 조용히 물려받지 않도록
 * 추론 사다리와 갈라 둔다. 게이트웨이 사다리의 `ultra`와는 다른 값이다 — Claude Code CLI는
 * `ultracode`를 받고 `ultra`를 거부한다.
 */
export const NATIVE_CLAUDE_SPECIAL_EFFORTS = ["ultracode"] as const;

/** 실행 인자로 받을 수 있는 native Claude Code 강도 전체. 추론 사다리 + 세션 모드. */
export const NATIVE_CLAUDE_LAUNCH_EFFORTS = [
  ...NATIVE_CLAUDE_EFFORTS,
  ...NATIVE_CLAUDE_SPECIAL_EFFORTS,
] as const;

const NATIVE_CLAUDE_MODEL_ALIAS_REWRITES = {
  fable: "fable[1m]",
  opus: "opus[1m]",
} as const satisfies Readonly<Record<string, (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number]>>;

/** Resolve a Console-native Claude Code model alias, rewriting legacy bare aliases to 1M coordinates. */
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
