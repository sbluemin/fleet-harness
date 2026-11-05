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
 * 자식 좌표를 실제 창으로 되돌리는 자. Gateway 모델 세션의 자식은 공급자 창을 Claude 좌표로 투영해 말하므로, 채팅의 문맥 표시와
 * 같은 함수·같은 정책 값으로 되돌린다. 예약분은 되돌리지 않고 실제 창과 실제 압축 지점의 차이로 갈아 끼운다.
 */
export interface ContextFrame {
  readonly max: number;
  readonly compactAt: number;
  readonly unproject: (tokens: number) => number;
}

/**
 * 자식의 문맥 내역을 화면 좌표의 내역으로 옮긴다. 총량은 vendor의 `total`이 아니라 카테고리 합이다 — 내역과 총량이
 * 같은 셈을 써야 한 화면에서 모순이 드러나지 않는다(채팅의 문맥 표시와 같은 규율).
 */
export function contextBreakdownOf(usage: ClaudeGatewayContextUsage, frame?: ContextFrame): AgentContextBreakdown {
  const real = (tokens: number) => frame ? frame.unproject(tokens) : tokens;
  const spent = usage.categories.filter((category) => !category.deferred && category.tokens > 0 && !CONTEXT_UNSPENT.has(category.name));
  const reserved = frame
    ? (usage.compactAt !== null && frame.max > frame.compactAt ? frame.max - frame.compactAt : 0)
    : usage.categories.find((category) => category.name === CONTEXT_RESERVED_NAME)?.tokens ?? 0;
  const compactAt = usage.compactAt === null ? null : frame ? frame.compactAt : usage.compactAt;
  const slices = spent.map((category) => ({ name: category.name, tokens: real(category.tokens) }));
  return {
    total: slices.reduce((sum, slice) => sum + slice.tokens, 0),
    max: frame ? frame.max : usage.max,
    ...(reserved > 0 ? { reserved } : {}),
    ...(compactAt === null ? {} : { compactAt }),
    slices,
    memoryFiles: usage.memoryFiles.map((file) => ({ name: file.path, tokens: real(file.tokens) })),
    mcpTools: usage.mcpTools.map((tool) => ({ name: tool.name, tokens: real(tool.tokens), ...(tool.server ? { server: tool.server } : {}) })),
    skills: skillRowsOf(usage, real),
  };
}

/** 스킬 목록의 행. 채팅 원장과 상주 세션이 같은 모양을 싣는다. */
export function skillRowsOf(usage: ClaudeGatewayContextUsage, real: (tokens: number) => number = (tokens) => tokens): AgentContextBreakdown["skills"] {
  return usage.skills.map((skill) => ({
    name: skill.name,
    tokens: real(skill.tokens),
    ...(skill.source ? { source: skill.source } : {}),
    ...(skill.plugin ? { plugin: skill.plugin } : {}),
  }));
}
