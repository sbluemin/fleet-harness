/**
 * gateway-agents — claude-gateway 스폰 시 주입하는 커스텀 Agent 정의.
 *
 * 파일 영속화 없이 `--agents`로만 전달한다. 모델 id는 반드시
 * `claude-gateway--*` 형태(toClaudeGatewayModelId)다. effort를 지원하는 모델은
 * ladder의 각 강도마다 Agent를 하나씩 만든다.
 *
 * 게이트웨이 정의는 Claude Code 내장 Agent를 대체하지 않고 그 옆에 놓인다.
 * 내장 Agent를 끄면 상속(unpinned) 위임 자체가 막혀, 게이트웨이 세션에서
 * 세션 자신의 모델로 도는 작업을 아예 만들 수 없게 된다.
 */

import {
  buildGatewayModelConstraints,
  toClaudeGatewayModelId,
  type GatewayEffortExposure,
  type GatewayModel,
  type GatewayReasoningEffort,
} from "@dotobokuri/core-ai-gateway";

/**
 * Fleet gateway 커스텀 Agent용 단일 실행 프롬프트.
 * Carrier 4종(Vanguard/Nimitz/Genesis/Sentinel)의 전이 가능한 행동 불변식만 담으며,
 * 캐리어 request-block·`<report>`·`carrier_jobs` 계약은 넣지 않는다.
 * Claude Code 내장 general-purpose의 "search broadly / Be thorough" 기본값은 의도적으로 버린다.
 */
export const GENERAL_PURPOSE_AGENT_PROMPT = [
  "You are a Fleet execution agent. Do the assigned work directly; do not re-delegate the whole assignment.",
  "Treat host objective/scope/constraints/references as binding contracts. Do not silently re-plan, expand scope, or substitute a \"cleaner\" design — finish as instructed, then optionally suggest alternatives. On ambiguity or conflict, stop and report the blocker instead of guessing.",
  "",
  "Pick ONE mode from the task and stay in it:",
  "- recon: read-only facts; least-invasive evidence path; cite path:line",
  "- decide: read-only; one simplest viable recommendation; no implementation checklist",
  "- implement: edit within scope; verify what you changed; report compliance and any deviations",
  "- verify: hunt real defects with evidence+impact; PASS/FAIL; fix only if asked",
  "",
  "Search only as needed for the chosen mode. Prefer known paths over broad sweeps. Do not default to exhaustive multi-strategy hunting.",
  "NEVER create files unless they are absolutely necessary. ALWAYS prefer editing an existing file to creating a new one.",
  "NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.",
  "Final reply: concise essentials only — mode, what changed or found, key evidence (path:line when relevant), and blockers/deviations.",
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
 * Scoped gateway 모델 id(`kimi--k3-256k`) → 사용자가 정체성으로 내보낸 강도들.
 * 항목이 없으면 그 모델의 사다리 전체를 뜻한다. 정의는 선별을 소유하는
 * core-ai-gateway가 갖고, 여기서는 Agent 조립 어휘로 다시 내보내기만 한다.
 *
 * 이 좁히기는 **정체성 등록에만** 적용된다. 디스커버리(`/v1/models`)가 광고하는
 * 사다리는 그대로 두는데, 요청 강도를 카탈로그보다 좁게 강제하면 클램프가 요청
 * 이하로만 내려가는 성질 때문에 최상단만 남긴 모델이 일반 세션을 400으로 막는다.
 */
export type { GatewayEffortExposure } from "@dotobokuri/core-ai-gateway";

/**
 * 사용자가 고른 강도만 남긴 사다리. 순서는 카탈로그 사다리를 따른다.
 * 선택이 없거나 사다리와 하나도 겹치지 않으면 전체 사다리로 되돌린다 — 정체성이
 * 0개인 모델은 노출해 놓고 쓸 수 없는 상태라 어떤 선택보다도 나쁘다.
 */
export function exposedEffortLadder(
  modelId: string,
  ladder: readonly GatewayReasoningEffort[],
  exposure: GatewayEffortExposure | undefined,
): readonly GatewayReasoningEffort[] {
  const chosen = exposure?.[modelId];
  if (chosen === undefined || chosen.length === 0) return ladder;
  const narrowed = ladder.filter((rung) => chosen.includes(rung));
  return narrowed.length > 0 ? narrowed : ladder;
}

/**
 * 노출된 gateway 모델(+내보낸 강도)마다 커스텀 Agent 정의를 만든다.
 * 빈 목록이면 빈 객체를 반환한다(내장 비활성화와는 독립).
 */
export function buildGatewayCustomAgents(
  exposed: readonly GatewayModel[],
  exposure?: GatewayEffortExposure,
): ClaudeCustomAgents {
  const agents: Record<string, ClaudeCustomAgentDefinition> = {};
  for (const model of exposed) {
    const modelId = toClaudeGatewayModelId(model);
    const constraints = buildGatewayModelConstraints(model);
    if (constraints.effortSupported) {
      for (const effort of exposedEffortLadder(model.id, constraints.effortLadder, exposure)) {
        const name = toGatewayAgentName(modelId, effort);
        agents[name] = {
          description: gatewayAgentDescription(modelId, name, effort),
          prompt: GENERAL_PURPOSE_AGENT_PROMPT,
          model: modelId,
          effort,
        };
      }
      continue;
    }
    const name = toGatewayAgentName(modelId);
    agents[name] = {
      description: gatewayAgentDescription(modelId, name),
      prompt: GENERAL_PURPOSE_AGENT_PROMPT,
      model: modelId,
    };
  }
  return agents;
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

/**
 * 이 문자열은 호스트가 identity를 고를 때 읽는 유일한 신호다. 이름과 모델 id는 철자가
 * 다르고 서로 대체되지 않으므로, 둘을 잇는 문장이 여기 없으면 그 매핑은 어디에도 없다.
 */
function gatewayAgentDescription(
  modelId: string,
  name: string,
  effort?: GatewayReasoningEffort,
): string {
  const effortPart = effort === undefined ? "no effort control" : `effort ${effort}`;
  return [
    `Gateway model ${modelId}, ${effortPart}.`,
    "Fleet execution agent that runs one mode — recon, decide, implement, or verify. Name the mode in the task.",
    "Use after calling gateway_models when this roster entry fits the stage.",
    `Select this identity by the agent type name ${name}. The model id above is a value for a model field and is rejected wherever a name is expected.`,
    ...(effort === undefined
      ? []
      : [`That name already carries ${effort}, so pinning a reasoning effort alongside it is redundant.`]),
  ].join(" ");
}
