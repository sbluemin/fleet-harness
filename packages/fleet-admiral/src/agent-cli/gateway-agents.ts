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
  type GatewayCapabilityClass,
  type GatewayEffortExposure,
  type GatewayModel,
  type GatewayModelBenchmark,
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
 * ultra는 위임 정체성으로 내지 않는다. ultracode는 커스텀 Agent frontmatter의 일상 사다리
 * 단이 아니라 Operation launch factory가 `--effort ultracode`로 넘기는 세션 능력이다.
 * 정체성 로스터에 ultra를 올리면 frontmatter effort가 CLI 일상 단과 어긋난다. 이 사다리는
 * 정체성 생성(buildGatewayCustomAgents)과 로스터 셀렉터(model-loadout)가 함께 타는
 * 깔때기라, 여기서 걸러야 둘이 어긋나지 않는다.
 */
export function exposedEffortLadder(
  modelId: string,
  ladder: readonly GatewayReasoningEffort[],
  exposure: GatewayEffortExposure | undefined,
): readonly GatewayReasoningEffort[] {
  const deliverable = ladder.filter((rung) => rung !== "ultra");
  const chosen = exposure?.[modelId];
  if (chosen === undefined || chosen.length === 0) return deliverable;
  const narrowed = deliverable.filter((rung) => chosen.includes(rung));
  return narrowed.length > 0 ? narrowed : deliverable;
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
          description: gatewayAgentDescription({
            modelId,
            selector: toGatewayAgentSelector(modelId, effort),
            capabilityClass: constraints.capabilityClass,
            effort,
            benchmark: constraints.benchmark,
          }),
          prompt: GENERAL_PURPOSE_AGENT_PROMPT,
          model: modelId,
          effort,
        };
      }
      continue;
    }
    const name = toGatewayAgentName(modelId);
    agents[name] = {
      description: gatewayAgentDescription({
        modelId,
        selector: toGatewayAgentSelector(modelId),
        capabilityClass: constraints.capabilityClass,
        benchmark: constraints.benchmark,
      }),
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
 * `claude-gateway--cursor--grok-4.5[1m]` + `high` → `cursor-grok-4-5-1m-high`
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
 * Bench·fit 문장은 정체성마다 달라지는 유일한 품질 신호이므로 로스터를 다시 열기 전에
 * 이름만으로도 대역을 가를 수 있게 싣는다.
 */
function gatewayAgentDescription(input: {
  readonly modelId: string;
  readonly selector: string;
  readonly capabilityClass?: GatewayCapabilityClass;
  readonly effort?: GatewayReasoningEffort;
  readonly benchmark?: GatewayModelBenchmark;
}): string {
  const { modelId, selector, capabilityClass, effort, benchmark } = input;
  const effortPart = effort === undefined ? "no effort control" : `effort ${effort}`;
  // class 는 판단석 배정의 prior 라서 첫 문장에 실린다 — 여기 없으면 호스트는
  // 정체성을 고르는 순간에 로스터를 다시 열지 않는 한 등급을 볼 수 없다.
  const classPart = capabilityClass === undefined ? "no capability class" : `${capabilityClass} class`;
  const sentences = [
    `Gateway model ${modelId}, ${classPart}, ${effortPart}.`,
  ];
  const benchSentence = gatewayAgentBenchSentence(benchmark, effort, capabilityClass);
  if (benchSentence !== undefined) sentences.push(benchSentence);
  const fitSentence = gatewayAgentFitSentence(capabilityClass);
  if (fitSentence !== undefined) sentences.push(fitSentence);
  sentences.push(
    "Fleet execution agent that runs one mode — recon, decide, implement, or verify. Name the mode in the task.",
    "Use after calling gateway_models when this roster entry fits the stage.",
    `Select this identity by the agent type name ${selector}, colon included. The model id above is a value for a model field and is rejected wherever a name is expected.`,
  );
  if (effort !== undefined) {
    sentences.push(`That name already carries ${effort}, so pinning a reasoning effort alongside it is redundant.`);
  }
  return sentences.join(" ");
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function gatewayAgentBenchSentence(
  benchmark: GatewayModelBenchmark | undefined,
  effort: GatewayReasoningEffort | undefined,
  capabilityClass: GatewayCapabilityClass | undefined,
): string | undefined {
  const caveatClause = benchmark?.caveat
    ? "; score carries a caveat — read it via gateway_models before trusting it"
    : "";
  if (effort !== undefined) {
    const figures = benchmark?.rungs?.[effort];
    if (figures) {
      return `Bench ${benchmark!.source}: ${figures.score}% at ${effort} effort, ~${formatTokenCount(figures.tokensPerTask)} tokens/task${caveatClause}.`;
    }
    if (benchmark) {
      return `No bench figure at ${effort}; capability class is the prior at this rung.`;
    }
  } else if (benchmark?.overall) {
    return `Bench ${benchmark.source}: ${benchmark.overall.score}% overall, ~${formatTokenCount(benchmark.overall.tokensPerTask)} tokens/task${caveatClause}.`;
  } else if (benchmark?.rungs) {
    const scores = Object.values(benchmark.rungs).map((rung) => rung.score);
    return `Bench ${benchmark.source}: ${Math.min(...scores)}%–${Math.max(...scores)}% across measured rungs, serving rung unknown${caveatClause}.`;
  }
  if (!benchmark && capabilityClass !== undefined) {
    return "No bench evidence; capability class is the only prior.";
  }
  return undefined;
}

function gatewayAgentFitSentence(capabilityClass: GatewayCapabilityClass | undefined): string | undefined {
  // class 만으로 fit 을 단정하면 측정 우선 독트린과 모순된다. 실측된 light rung 이
  // 실측된 flagship 보다 높은 band 에 들 수 있으므로, class 는 명시적으로 약한 prior 다.
  switch (capabilityClass) {
    case "flagship":
      return "Class prior: judgment-seat candidate (decide, judge, synthesize) — the figures above, not the label, set its band.";
    case "standard":
      return "Class prior: mid lineup — measured figures outrank this label in either direction.";
    case "light":
      return "Class prior: light lineup — fits wide mechanical fans (recon, scan, extract, verify), though measured figures can still earn a band seat.";
    default:
      return undefined;
  }
}
