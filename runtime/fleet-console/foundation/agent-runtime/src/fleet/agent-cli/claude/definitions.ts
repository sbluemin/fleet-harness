import { createClaudeFamilyCliDefinition } from "./factory.js";

// Claude Code's bare `fable` and `opus` aliases use their default context windows.
// Console launches their 1M coordinates while keeping the plain menu labels.
export const NATIVE_CLAUDE_MODEL_ALIASES = ["fable[1m]", "opus[1m]", "sonnet"] as const;
export const ALL_NATIVE_CLAUDE_MODEL_ALIASES = [
  "fable[1m]",
  "opus[1m]",
  "sonnet",
  "haiku",
  "opus",
  "fable",
  "sonnet[1m]",
] as const;
export const NATIVE_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** 네이티브 alias의 컨텍스트 선택은 바꾸지 않고 Claude Code에 전달한다. */
export function resolveNativeClaudeModelAlias(
  model: string,
): (typeof ALL_NATIVE_CLAUDE_MODEL_ALIASES)[number] | undefined {
  if (ALL_NATIVE_CLAUDE_MODEL_ALIASES.includes(model as (typeof ALL_NATIVE_CLAUDE_MODEL_ALIASES)[number])) {
    return model as (typeof ALL_NATIVE_CLAUDE_MODEL_ALIASES)[number];
  }
  return undefined;
}


// 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
export const claudeCli = createClaudeFamilyCliDefinition({
  id: "claude",
  label: "Claude",
});
