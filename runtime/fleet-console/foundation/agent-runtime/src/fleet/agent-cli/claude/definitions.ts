import { createClaudeFamilyCliDefinition } from "./factory.js";

// The installed Claude Code resolves Fable, Opus, Sonnet, and Haiku as native 1M.
// Console's execution id is one `<family>[1m]` coordinate per family. Bare aliases
// are accepted and folded; menu labels stay the plain family name.
const NATIVE_CANONICAL_ALIAS = {
  fable: "fable[1m]",
  "fable[1m]": "fable[1m]",
  opus: "opus[1m]",
  "opus[1m]": "opus[1m]",
  sonnet: "sonnet[1m]",
  "sonnet[1m]": "sonnet[1m]",
  haiku: "haiku[1m]",
  "haiku[1m]": "haiku[1m]",
} as const;

export const NATIVE_CLAUDE_MODEL_ALIASES = ["fable[1m]", "opus[1m]", "sonnet[1m]", "haiku[1m]"] as const;
export const ALL_NATIVE_CLAUDE_MODEL_ALIASES = [
  "fable[1m]",
  "opus[1m]",
  "sonnet[1m]",
  "haiku[1m]",
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;
export const NATIVE_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** bare·`[1m]` 입력을 실행 정준 id(`<family>[1m]`)로 접는다. 네 가족 밖이면 undefined. */
export function resolveNativeClaudeModelAlias(
  model: string,
): (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number] | undefined {
  return NATIVE_CANONICAL_ALIAS[model as keyof typeof NATIVE_CANONICAL_ALIAS];
}


// 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
export const claudeCli = createClaudeFamilyCliDefinition({
  id: "claude",
  label: "Claude",
});
