/**
 * gateway-agents — 게이트웨이 위임이 싣는 실행 계약.
 *
 * 한때 이 파일은 노출된 모델×강도마다 Agent 정체성을 만들었고, 호스트가 그 이름을 불러
 * 모델을 골랐다. 지금은 라우팅 Mod가 스폰 레코드의 모델을 직접 바꾸므로 이름이 필요 없다
 * (routing-table.ts). 남은 것은 그 방식이 날랐던 한 가지, 실행 계약뿐이다.
 */

import type { GatewayEffortExposure, GatewayReasoningEffort } from "../models.js";

export type { GatewayEffortExposure } from "../models.js";

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
 * Fleet 플러그인이 선언하는 이름. 플러그인 매니페스트와 이 상수가 갈라지면 스킬과 커맨드의
 * `fleet:` 스코프가 조용히 어긋난다.
 */
export const FLEET_PLUGIN_NAME = "fleet";

/**
 * 사용자가 고른 강도만 남긴 사다리. 순서는 카탈로그 사다리를 따른다. 선택이 없거나 사다리와
 * 하나도 겹치지 않으면 전체 사다리로 되돌린다.
 *
 * 이 좁히기는 **로스터 표시에만** 적용된다. 디스커버리(`/v1/models`)가 광고하는 사다리는
 * 그대로 두는데, 요청 강도를 카탈로그보다 좁게 강제하면 클램프가 요청 이하로만 내려가는
 * 성질 때문에 최상단만 남긴 모델이 일반 세션을 400으로 막는다.
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
