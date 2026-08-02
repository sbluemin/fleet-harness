import { createClaudeFamilyCliDefinition } from "./factory.js";

// Experimental: 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
// 실험 단계라는 사실은 라벨 괄호 안이 들고 있다 — 별도 표식을 두지 않으므로 이름만 보고
// 판단할 수 있어야 한다.
export const claudeGatewayCli = createClaudeFamilyCliDefinition({
  id: "claude-gateway",
  label: "Claude (Gateway • Experimental)",
});
