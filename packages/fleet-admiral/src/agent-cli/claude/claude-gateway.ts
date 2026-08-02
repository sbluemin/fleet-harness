import { createClaudeFamilyCliDefinition } from "./factory.js";

// Experimental: 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
export const claudeGatewayCli = createClaudeFamilyCliDefinition({
  id: "claude-gateway",
  label: "Claude (Gateway • Experimental)",
});
