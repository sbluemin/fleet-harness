/**
 * gateway-skills — claude-gateway 세션에서 끄고 들어가는 Claude Code 내장 스킬.
 *
 * `--settings`의 `skillOverrides`로만 전달하며 파일에 남기지 않는다. 이 override는
 * 프로세스 단위 스킬 레지스트리 필터라, 메인 세션은 물론 같은 프로세스에서 도는
 * 모든 서브에이전트(주입한 gateway 커스텀 Agent 포함)의 스킬 목록에서도 사라진다.
 * Agent 정의쪽 `skills`는 메인 세션에만 걸리는 허용목록이라 이 용도로 쓸 수 없다.
 */

/** `skillOverrides`가 받는 값. `off`는 모델 목록과 사용자 슬래시 호출 양쪽에서 감춘다. */
export type ClaudeSkillOverride = "on" | "name-only" | "user-invocable-only" | "off";

/**
 * gateway 세션이 싣지 않는 내장 스킬.
 *
 * `claude-api`는 Anthropic API 레퍼런스다. 트리거가 `claude-*` 모델 이름과 LLM
 * 관련 작업 전반을 잡아 gateway 경로에서 쉽게 발동하는데, 정작 이 세션이 부리는
 * 모델은 게이트웨이가 중개하는 타사 백엔드다. 본문은 매 턴 다시 실리는 사용자
 * 텍스트 블록이라 발동 한 번이 세션 내내 창을 잡아먹는다.
 */
export const GATEWAY_DISABLED_CLAUDE_SKILLS: readonly string[] = ["claude-api"];

/** 스킬 이름 목록 → `skillOverrides` 맵. 빈 목록이면 undefined(설정을 싣지 않음). */
export function buildDisabledSkillOverrides(
  skillNames: readonly string[],
): Readonly<Record<string, ClaudeSkillOverride>> | undefined {
  if (skillNames.length === 0) return undefined;
  return Object.fromEntries(skillNames.map((name) => [name, "off" as const]));
}
