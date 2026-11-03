import type { ClaudeGatewayContextUsage } from "@fleet-console/agent-runtime/claude";

import type { AgentContextBreakdown } from "../../shared/agent.js";

/**
 * 자동 압축 예약분의 카테고리 이름과, 쓴 것이 아닌 카테고리들.
 *
 * 이름으로 가르는 것이 취약하다는 것은 안다. 다만 vendor는 이 둘을 구조적으로 구분해 주지 않으며(`isDeferred`는 다른 축이다),
 * 매칭이 어긋나면 미터가 늘 100%를 가리켜 곧바로 눈에 띈다 — 조용히 틀리는 실패가 아니다.
 */
export const CONTEXT_RESERVED_NAME = "Autocompact buffer";
export const CONTEXT_UNSPENT: ReadonlySet<string> = new Set([CONTEXT_RESERVED_NAME, "Free space"]);

/**
 * 자식의 문맥 내역을 화면 좌표의 내역으로 옮긴다. 총량은 vendor의 `total`이 아니라 카테고리 합이다 — 내역과 총량이
 * 같은 셈을 써야 한 화면에서 모순이 드러나지 않는다(채팅의 문맥 표시와 같은 규율).
 */
export function contextBreakdownOf(usage: ClaudeGatewayContextUsage): AgentContextBreakdown {
  const spent = usage.categories.filter((category) => !category.deferred && category.tokens > 0 && !CONTEXT_UNSPENT.has(category.name));
  const reserved = usage.categories.find((category) => category.name === CONTEXT_RESERVED_NAME);
  const slices = spent.map((category) => ({ name: category.name, tokens: category.tokens }));
  return {
    total: slices.reduce((sum, slice) => sum + slice.tokens, 0),
    max: usage.max,
    ...(reserved && reserved.tokens > 0 ? { reserved: reserved.tokens } : {}),
    ...(usage.compactAt === null ? {} : { compactAt: usage.compactAt }),
    slices,
    memoryFiles: usage.memoryFiles.map((file) => ({ name: file.path, tokens: file.tokens })),
    mcpTools: usage.mcpTools.map((tool) => ({ name: tool.name, tokens: tool.tokens, ...(tool.server ? { server: tool.server } : {}) })),
  };
}
