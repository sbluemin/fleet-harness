/**
 * Claude Code가 스스로 system에 넣는 줄을 agy로 보내기 전에 뗀다.
 *
 * Claude Code와 Agent SDK는 system 블록 맨 앞에 두 개를 둔다 — 결제 헤더(`x-anthropic-billing-header: …`)와
 * 정체성 한 줄(`You are Claude Code, …` / `You are a Claude agent, …`). 둘 다 블록 하나를 통째로 차지하고 그 뒤 블록이
 * Fleet 지침이므로, 블록 경계에서 정확히 일치하는 것만 뗀다(측정: Claude Code 2.1.325, 설정 켬·끔·append·하위 에이전트
 * 모두 같은 자리). 본문(기본 프롬프트)과 하위 에이전트 프롬프트는 여기서 건드리지 않는다 — 그 안에 Fleet 텍스트가
 * 섞일 수 있어 문자열 경계로 잘라 낼 근거가 없다. 본문은 Gemini 세션을 열 때 호스트가 설정을 꺼서 싣지 않는다.
 *
 * `instructions`는 블록들을 빈 줄 하나로 이은 문자열이다(downstream anthropic-messages protocol).
 */
const BILLING_HEADER = /^x-anthropic-billing-header:[^\n]*(?:\n\n|\n?$)/;
const IDENTITY_LINES: readonly string[] = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
];

export function stripClaudeCodeIdentity(instructions: string): string {
  let rest = instructions.replace(BILLING_HEADER, "");
  for (const line of IDENTITY_LINES) {
    if (rest === line) return "";
    if (rest.startsWith(`${line}\n\n`)) return rest.slice(line.length + 2);
  }
  return rest;
}
