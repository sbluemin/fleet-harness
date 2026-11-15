/**
 * 모델 계열과 위임 강도의 저장 규칙. 호스트 정규화와 설정 화면이 같은 함수를 쓴다.
 *
 * 모델은 창·속도와 무관하게 단일 id를 갖는다. 계열 키도 그 id 자체다.
 */

/** 위임에 켜면 늘 포함하는 강도. */
export const AI_GATEWAY_BASE_EFFORTS = ["low", "medium"] as const;

/** 켠 모델에서만 고르는 강도. */
export const AI_GATEWAY_OPT_IN_EFFORTS = ["high", "xhigh", "max"] as const;

/**
 * 메뉴·실행·위임 후보가 같이 쓰는 로그인 술어.
 *
 * `signed_out`과 `not_connected`만 빠진다. 상태가 없으면 보인다.
 * Claude `not_connected`는 사용량 수집 동의가 꺼진 것이지 자격 로그아웃이 아니다.
 * 자격 확인이 로그아웃을 말할 때는 `signed_out`이다.
 */
export function isProviderCatalogVisible(status: string | null | undefined, provider?: string): boolean {
  if (provider === "claude" && status === "not_connected") return true;
  return status !== "signed_out" && status !== "not_connected";
}

export function aiGatewayModelFamilyKey(id: string): string {
  return id;
}

/**
 * 저장 강도 = 사다리 ∩ ({low, medium} ∪ 켠 high·xhigh·max).
 * 사다리 전체와 같으면 `undefined`(키 부재). `selected` 부재는 사다리 전체로 읽는다.
 * 빈 배열은 옵트인이 없는 기본값이다 — 부재와 같지 않다.
 */
export function canonicalEffortSelection(
  ladder: readonly string[],
  selected: readonly string[] | undefined,
): readonly string[] | undefined {
  if (ladder.length === 0) return undefined;
  const chosen = selected ?? ladder;
  const opted = new Set<string>(AI_GATEWAY_OPT_IN_EFFORTS.filter((level) => chosen.includes(level)));
  const next = ladder.filter((level) =>
    (AI_GATEWAY_BASE_EFFORTS as readonly string[]).includes(level) || opted.has(level));
  if (next.length === 0 || next.length === ladder.length) return undefined;
  return next;
}

/** 새로 켠 모델. low–high만 포함하고, 그 셋이 사다리 전체면 키를 남기지 않는다. */
export function defaultEffortSelection(ladder: readonly string[]): readonly string[] | undefined {
  return canonicalEffortSelection(ladder, ["high"]);
}

/**
 * 지능 점수로 권하는 역할. `lead`는 목표를 이끄는 자리, `overseer`는 그 위를 감독하는 자리다.
 * 점수와 기준값은 레지스트리(`models.json`)가 원천이고, 이 모듈은 둘을 받아 계산만 한다 —
 * 호스트(카탈로그·로스터)와 브라우저(선택기·라우팅 풀)가 같은 규칙을 쓰게 하는 유일한 자리다.
 * 표시용이다. 라우팅 판단은 이 값을 읽지 않는다.
 */
export type AiGatewayRole = "lead" | "overseer";
export type AiGatewayRoleThresholds = Readonly<Record<AiGatewayRole, number>>;

/** 점수가 닿는 가장 높은 역할. 점수가 없으면(`undefined`) 권하지 않는다 — 없는 점수는 낮은 점수가 아니다. */
export function recommendedRole(score: number | undefined, thresholds: AiGatewayRoleThresholds): AiGatewayRole | undefined {
  if (score === undefined) return undefined;
  const reached = (Object.entries(thresholds) as [AiGatewayRole, number][])
    .filter(([, threshold]) => score >= threshold)
    .sort(([, left], [, right]) => right - left);
  return reached[0]?.[0];
}

/**
 * `efforts`(낮은 단부터) 가운데 점수가 `threshold`에 처음 닿는 강도. 점수가 없는 단은 건너뛰고,
 * 어느 단도 닿지 않으면 `undefined`다.
 */
export function lowestQualifyingEffort(
  scores: Readonly<Partial<Record<string, number>>>,
  efforts: readonly string[],
  threshold: number,
): string | undefined {
  return efforts.find((effort) => {
    const score = scores[effort];
    return typeof score === "number" && score >= threshold;
  });
}
