/**
 * admiral/prompts — Admiral 시스템 프롬프트 관리
 *
 * ACP 시스템 프롬프트는 `createSystemPromptBuilder().build()`로 합성되며, 각 섹션은
 * `<fleet section="...">` 통일 태그로 감싸진다. 본문은 `./gateway.ts`가 단독으로 소유한다.
 * 호출자가 system prompt mode를 off로 선택하면 이 빌더를 호출하지 않는다.
 */

import { buildGatewaySystemPrompt } from "./gateway.js";

// ─────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────

export interface SystemPromptBuilder {
  build(): string;
}

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

/** ACP 프로바이더용 CLI 시스템 지침을 합성한다. */
export function createSystemPromptBuilder(): SystemPromptBuilder {
  return { build: () => buildGatewaySystemPrompt() };
}
