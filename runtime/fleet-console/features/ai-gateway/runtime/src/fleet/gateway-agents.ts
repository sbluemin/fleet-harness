/**
 * gateway-agents — 게이트웨이 위임이 노출하는 강도 사다리와 플러그인 이름.
 *
 * 한때 이 파일은 노출된 모델×강도마다 Agent 정체성을 만들었고, 호스트가 그 이름을 불러
 * 모델을 골랐다. 지금은 Console이 위임마다 모델을 정하고(routing-assignment.ts) 라우팅 Mod가
 * 스폰 레코드를 고치므로 이름이 필요 없다. 그 방식이 날랐던 실행 계약은 Fleet 실행 정책이라
 * foundation의 `execution-contract.ts`가 소유한다.
 */

import type { GatewayEffortExposure, GatewayReasoningEffort } from "../models.js";

export type { GatewayEffortExposure } from "../models.js";

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
