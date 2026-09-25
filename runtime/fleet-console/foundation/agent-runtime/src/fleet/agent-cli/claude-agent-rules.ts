/**
 * claude-agent-rules — 내장 서브에이전트 옵트아웃을 Claude Code 권한 규칙으로 옮긴다.
 *
 * Claude Code는 `Agent(<name>)` 꼴의 규칙으로 서브에이전트 하나를 가리킨다. 같은 목록이
 * argv 표면(`--settings`의 `permissions.deny`)과 SDK 표면(`disallowedTools`)에 실리므로
 * 규칙 철자는 이 한 곳이 소유한다 — 두 표면이 각자 문자열을 만들면 한쪽만 조용히 어긋난다.
 */

/** 모든 서브에이전트를 끄는 표식 — 이름을 세지 않고 도구 자체(`Agent`, 옛 이름 `Task`)를 막는다. */
export const ALL_SUBAGENTS = "*";

/**
 * 서브에이전트 규칙과 호출자가 끈 도구 이름을 한 deny 목록으로 합친다. 두 표면(`permissions.deny`·`disallowedTools`)이
 * 같은 목록을 받아야 하므로 병합도 이 한 곳이 한다 — 한쪽 정책을 싣느라 다른 쪽을 덮으면 안 된다.
 */
export function buildClaudeDenyRules(disabledAgents: readonly string[] | undefined, disabledTools: readonly string[] | undefined): string[] {
  return [...new Set([...buildClaudeAgentDenyRules(disabledAgents), ...(disabledTools ?? [])])];
}

/** 옵트아웃 이름 목록 → `Agent(<name>)` 규칙 목록. 빈 목록이면 빈 배열(규칙을 싣지 않음). `*` 가 있으면 도구 전체를 막는 규칙 둘만 싣는다. */
export function buildClaudeAgentDenyRules(disabledAgents: readonly string[] | undefined): string[] {
  if (!disabledAgents || disabledAgents.length === 0) return [];
  if (disabledAgents.includes(ALL_SUBAGENTS)) return ["Agent", "Task"];
  return [...new Set(disabledAgents)].map((name) => `Agent(${name})`);
}
