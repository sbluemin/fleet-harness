import { createClaudeFamilyCliDefinition } from "./factory.js";

// Console Launch 전용: Admiral 시스템 프롬프트 없이 wiki 스킬·Console 훅·위키 MCP만 싣는 순정에 가까운 Claude Code.
export const claudeNativeCli = createClaudeFamilyCliDefinition({
  id: "claude-native",
  label: "Claude (Native)",
});
