import { createClaudeFamilyCliDefinition } from "./factory.js";

export const claudeCli = createClaudeFamilyCliDefinition({
  id: "claude",
  label: "Claude",
});

// Console Launch 전용: Admiral 시스템 프롬프트 없이 wiki 스킬·Console 훅·위키 MCP만 싣는 순정에 가까운 Claude Code.
export const claudeNativeCli = createClaudeFamilyCliDefinition({
  id: "claude-native",
  label: "Claude (Native)",
});

// 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
export const claudeGatewayCli = createClaudeFamilyCliDefinition({
  id: "claude-gateway",
  label: "Claude (Gateway)",
});
