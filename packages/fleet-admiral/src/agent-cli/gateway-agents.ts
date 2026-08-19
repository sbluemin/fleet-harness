/**
 * gateway-agents — claude-gateway 세션이 등록하는 Agent 정의.
 *
 * 정의는 Fleet 플러그인의 `agents/` 디렉터리에 파일로 놓인다. 한때는 `--agents`
 * JSON으로 argv에 실어 보냈는데, 정의 하나가 1.9KB쯤이고 모델×강도마다 하나씩
 * 생기므로 로스터가 스무 개만 돼도 페이로드가 40KB에 이른다. Windows는 명령줄
 * 전체가 CreateProcess에서 32,767자, npm `.cmd` shim처럼 cmd.exe를 경유하는
 * 경로에서는 8,191자에서 잘리므로, 프롬프트를 한 글자도 싣기 전에 실행 자체가
 * 불가능해진다. 파일로 옮기면 argv에는 이미 있던 `--plugin-dir` 경로만 남는다.
 *
 * 대가는 이름이다. 플러그인이 실은 Agent는 `<plugin>:<name>`으로 등록되므로
 * 호스트가 고르는 철자가 `fleet:`을 얻는다 — 같은 플러그인이 싣는 스킬이 이미
 * `fleet:workflow`로 불리는 것과 같은 규칙이다.
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
 * 전이 가능한 행동 불변식만 담으며, 퇴역한 캐리어 위임 계약은 넣지 않는다.
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

/**
 * Fleet 플러그인이 선언하는 이름. Claude Code는 플러그인이 실은 Agent를
 * `<plugin>:<name>`으로 등록하므로, 이 값이 곧 정체성 철자의 앞부분이다.
 * 플러그인 매니페스트는 이 상수를 그대로 쓴다 — 둘이 갈라지면 호스트가 부르는
 * 이름과 Claude Code가 등록한 이름이 조용히 어긋난다.
 */
export const FLEET_PLUGIN_NAME = "fleet";

export interface ClaudeCustomAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  /** Claude Code에 전달하는 모델 id. 반드시 `claude-gateway--*` 형태. */
  readonly model: string;
  /** effort를 지원하는 모델만 설정. */
  readonly effort?: GatewayReasoningEffort;
}

/** Agent 이름(스코프 없는 파일 stem) → 정의. */
export type ClaudeCustomAgents = Readonly<Record<string, ClaudeCustomAgentDefinition>>;

/** 플러그인 `agents/` 아래에 놓일 파일 하나. */
export interface GatewayAgentFile {
  readonly fileName: string;
  readonly content: string;
}

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
 *
 * 모델 사다리는 launch 능력을 싣지 않는다. ultracode는 커스텀 Agent frontmatter의 일상
 * 사다리 단이 아니라 Operation launch factory가 `--effort ultracode`로 넘기는 세션 능력이라,
 * max에서 끝나는 카탈로그 사다리가 곧 정체성 사다리다. 이 사다리는 정체성 생성
 * (buildGatewayCustomAgents)과 로스터 셀렉터(model-loadout)가 함께 타는 깔때기라,
 * 여기서 좁혀야 둘이 어긋나지 않는다.
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
          description: gatewayAgentDescription({ modelId, effort }),
          prompt: GENERAL_PURPOSE_AGENT_PROMPT,
          model: modelId,
          effort,
        };
      }
      continue;
    }
    const name = toGatewayAgentName(modelId);
    agents[name] = {
      description: gatewayAgentDescription({ modelId }),
      prompt: GENERAL_PURPOSE_AGENT_PROMPT,
      model: modelId,
    };
  }
  return agents;
}

/**
 * 플러그인 `agents/`에 그대로 쓸 파일들. frontmatter의 `name`은 스코프 없는 stem이다 —
 * Claude Code는 `:`를 스코프 구분자로 예약해 두어, 이름에 넣으면 그 파일을 아예 읽지 않는다.
 *
 * 값은 전부 JSON 문자열로 적는다. JSON은 YAML 1.2의 부분집합이라 따옴표·백슬래시·개행이
 * 그대로 살고, `[1m]`처럼 흐름 시퀀스로 읽힐 수 있는 모델 id도 스칼라로 고정된다.
 */
export function buildGatewayAgentFiles(
  exposed: readonly GatewayModel[],
  exposure?: GatewayEffortExposure,
): readonly GatewayAgentFile[] {
  return Object.entries(buildGatewayCustomAgents(exposed, exposure)).map(([name, definition]) => ({
    fileName: `${name}.md`,
    content: [
      "---",
      `name: ${JSON.stringify(name)}`,
      `description: ${JSON.stringify(definition.description)}`,
      `model: ${JSON.stringify(definition.model)}`,
      ...(definition.effort === undefined ? [] : [`effort: ${JSON.stringify(definition.effort)}`]),
      "---",
      "",
      definition.prompt,
      "",
    ].join("\n"),
  }));
}

/**
 * 호스트가 정체성을 고를 때 쓰는 철자. 플러그인 스코프가 붙은 이 이름만 Agent 자리에
 * 넣을 수 있고, 스코프 없는 stem은 파일 이름일 뿐이다.
 */
export function toGatewayAgentSelector(modelId: string, effort?: GatewayReasoningEffort): string {
  return `${FLEET_PLUGIN_NAME}:${toGatewayAgentName(modelId, effort)}`;
}

/**
 * Agent 파일 이름과 frontmatter `name`에 쓰는 stem.
 * `claude-gateway--opencode--deepseek-v4-flash[1m]` + `high` → `opencode-deepseek-v4-flash-1m-high`
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
 * Agent 목록에 실리는 한 줄. 이 세션은 Fleet 시스템 프롬프트를 싣지 않고, 정체성 선택에
 * 필요한 사실(이름·modelId·capabilityClass·benchmark·effortLadder·공급자 allowance)은
 * `gateway_models`가 호출 시점에 통째로 보고한다. 그 표를 여기에 한 번 더 적으면 정체성
 * 스무 개마다 같은 문단이 복제되어 세션 창에 상주하는데, 읽는 쪽은 어차피 로스터를 부른
 * 뒤에 고른다 — 그래서 여기에는 사람이 목록에서 이 줄을 알아볼 만큼만 남긴다.
 *
 * 핀되지 않은 위임을 막고 어떻게 핀하는지 알리는 일은 모델 가드 훅이 맡는다.
 */
function gatewayAgentDescription(input: {
  readonly modelId: string;
  readonly effort?: GatewayReasoningEffort;
}): string {
  const scoped = input.modelId.startsWith("claude-gateway--")
    ? input.modelId.slice("claude-gateway--".length)
    : input.modelId;
  const label = scoped.replace("--", "/");
  return input.effort === undefined ? label : `${label} @${input.effort}`;
}
