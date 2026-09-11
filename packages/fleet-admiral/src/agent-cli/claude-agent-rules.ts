/**
 * claude-agent-rules — 내장 서브에이전트 옵트아웃을 Claude Code 권한 규칙으로 옮긴다.
 *
 * Claude Code는 `Agent(<name>)` 꼴의 규칙으로 서브에이전트 하나를 가리킨다. 같은 목록이
 * argv 표면(`--settings`의 `permissions.deny`)과 SDK 표면(`disallowedTools`)에 실리므로
 * 규칙 철자는 이 한 곳이 소유한다 — 두 표면이 각자 문자열을 만들면 한쪽만 조용히 어긋난다.
 */

/** 옵트아웃 이름 목록 → `Agent(<name>)` 규칙 목록. 빈 목록이면 빈 배열(규칙을 싣지 않음). */
export function buildClaudeAgentDenyRules(disabledAgents: readonly string[] | undefined): string[] {
  if (!disabledAgents || disabledAgents.length === 0) return [];
  return [...new Set(disabledAgents)].map((name) => `Agent(${name})`);
}
