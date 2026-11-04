/**
 * 모델 계열과 위임 강도의 저장 규칙. 호스트 정규화와 설정 화면이 같은 함수를 쓴다.
 *
 * 계열 키는 id에서 `-fast`와 컨텍스트 접미사(`-524k`, `-1m`)를 벗긴 줄기다.
 * 접미사가 항상 쌍을 뜻하지는 않는다 — 짝이 없는 `…-fast`는 그 키의 유일한 변형이다.
 */

const FAST_SUFFIX = /-fast$/i;
const CONTEXT_SUFFIX = /-(\d+[km])$/i;

/** 위임에 켜면 늘 포함하는 강도. */
export const AI_GATEWAY_BASE_EFFORTS = ["low", "medium", "high"] as const;

/** 켠 모델에서만 고르는 강도. */
export const AI_GATEWAY_OPT_IN_EFFORTS = ["xhigh", "max"] as const;

export function aiGatewayModelFamilyKey(id: string): string {
  const stem = id.replace(FAST_SUFFIX, "");
  const context = CONTEXT_SUFFIX.exec(stem);
  return context ? stem.slice(0, context.index) : stem;
}

/**
 * 저장 강도 = 사다리 ∩ ({low, medium, high} ∪ 켠 xhigh·max).
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
  return canonicalEffortSelection(ladder, []);
}
