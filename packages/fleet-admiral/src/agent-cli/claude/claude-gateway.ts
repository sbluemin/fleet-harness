import { createClaudeFamilyCliDefinition } from "./factory.js";

// Experimental: 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
// 라벨은 종류만 말한다. 실험 단계라는 사실은 Console 실행 메뉴가 배지로 표시하므로,
// 라벨에 겹쳐 적으면 배지와 함께 한 줄에 두 번 읽힌다.
export const claudeGatewayCli = createClaudeFamilyCliDefinition({
  id: "claude-gateway",
  label: "Claude (Gateway)",
});
