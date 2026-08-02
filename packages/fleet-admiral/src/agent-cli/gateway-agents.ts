/**
 * gateway-agents — claude-gateway 스폰 시 주입하는 커스텀 Agent 정의와
 * 내장 Agent 비활성화 목록.
 *
 * 파일 영속화 없이 `--agents` / `--disallowedTools`로만 전달한다. 모델 id는 반드시
 * `claude-gateway--*` 형태(toClaudeGatewayModelId)다. effort를 지원하는 모델은
 * ladder의 각 강도마다 Agent를 하나씩 만든다.
 */

import {
  buildGatewayModelConstraints,
  toClaudeGatewayModelId,
  type GatewayModel,
  type GatewayReasoningEffort,
} from "@dotobokuri/core-ai-gateway";

/** gateway 스폰에서 끄는 Claude Code 내장 Agent 타입. */
export const GATEWAY_DISABLED_BUILTIN_AGENTS = [
  "claude",
  "Explore",
  "general-purpose",
  "Plan",
] as const;

/**
 * Claude Code 내장 general-purpose Agent의 시스템 프롬프트와 동일한 본문.
 * (claude 2.1.220 바이너리에서 추출; 파일 에이전트가 아니라 인라인 `--agents` 주입용)
 */
export const GENERAL_PURPOSE_AGENT_PROMPT = [
  "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.",
  "When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.",
  "",
  "Your strengths:",
  "- Searching for code, configurations, and patterns across large codebases",
  "- Analyzing multiple files to understand system architecture",
  "- Investigating complex questions that require exploring many files",
  "- Performing multi-step research tasks",
  "",
  "Guidelines:",
  "- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.",
  "- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.",
  "- Be thorough: Check multiple locations, consider different naming conventions, look for related files.",
  "- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.",
  "- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.",
  "- You are already the dedicated agent for this task. Do the work directly — do not re-delegate your entire assignment to another single subagent.",
].join("\n");

export interface ClaudeCustomAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  /** Claude Code에 전달하는 모델 id. 반드시 `claude-gateway--*` 형태. */
  readonly model: string;
  /** effort를 지원하는 모델만 설정. */
  readonly effort?: GatewayReasoningEffort;
}

/** Agent 이름 → 정의. `--agents` JSON 객체와 동일 형태. */
export type ClaudeCustomAgents = Readonly<Record<string, ClaudeCustomAgentDefinition>>;

/**
 * 노출된 gateway 모델(+지원 강도)마다 커스텀 Agent 정의를 만든다.
 * 빈 목록이면 빈 객체를 반환한다(내장 비활성화와는 독립).
 */
export function buildGatewayCustomAgents(
  exposed: readonly GatewayModel[],
): ClaudeCustomAgents {
  const agents: Record<string, ClaudeCustomAgentDefinition> = {};
  for (const model of exposed) {
    const modelId = toClaudeGatewayModelId(model);
    // A host-native model's wire id is a bare alias (`opus`), which would make an
    // Agent type named after it collide with ordinary vocabulary. Names come from
    // the scoped catalog id instead, so `claude--opus` reads as `claude-opus`;
    // translated models keep deriving theirs from the wire id so existing Agent
    // type names — which callers pin — stay byte-identical.
    const nameSource = model.hostNative ? model.id : modelId;
    const constraints = buildGatewayModelConstraints(model);
    if (constraints.effortSupported) {
      for (const effort of constraints.effortLadder) {
        const name = toGatewayAgentName(nameSource, effort);
        agents[name] = {
          description: gatewayAgentDescription(model, modelId, effort),
          prompt: GENERAL_PURPOSE_AGENT_PROMPT,
          model: modelId,
          effort,
        };
      }
      continue;
    }
    const name = toGatewayAgentName(nameSource);
    agents[name] = {
      description: gatewayAgentDescription(model, modelId),
      prompt: GENERAL_PURPOSE_AGENT_PROMPT,
      model: modelId,
    };
  }
  return agents;
}

/** `--disallowedTools`에 넣을 구·신 Agent 선택자 목록. */
export function buildGatewayDisallowedAgentTools(
  agentTypes: readonly string[] = GATEWAY_DISABLED_BUILTIN_AGENTS,
): string[] {
  return agentTypes.flatMap((agentType) => [
    `Task(${agentType})`,
    `Agent(${agentType})`,
  ]);
}

/**
 * Claude Code Agent 타입 키로 쓸 안전한 이름.
 * `claude-gateway--cursor--claude-opus-5[1m]` + `high` → `cursor-claude-opus-5-1m-high`
 */
export function toGatewayAgentName(modelId: string, effort?: GatewayReasoningEffort): string {
  const stripped = modelId.startsWith("claude-gateway--")
    ? modelId.slice("claude-gateway--".length)
    : modelId;
  const base = stripped
    .replace(/\[1m\]/g, "-1m")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const stem = base.length > 0 ? base : "model";
  return effort === undefined ? stem : `${stem}-${effort}`;
}

function gatewayAgentDescription(
  model: GatewayModel,
  modelId: string,
  effort?: GatewayReasoningEffort,
): string {
  const effortPart = effort === undefined ? "no effort control" : `effort ${effort}`;
  const lead = model.hostNative
    ? `${model.displayName} (${modelId}), ${effortPart}. Runs on this session's own Anthropic subscription rather than a gateway provider's.`
    : `Gateway model ${model.displayName} (${modelId}), ${effortPart}.`;
  return [
    lead,
    "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
    "Use after calling gateway_models when this roster entry fits the stage.",
  ].join(" ");
}
