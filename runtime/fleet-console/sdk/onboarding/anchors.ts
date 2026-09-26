/**
 * 온보딩 DOM 계약 — 투어 레이어와 배치 경계는 번들을 넘나드는 속성으로만 합의한다.
 *
 * - 레이어: 투어 카드가 떠 있는 동안 존재한다. 바깥 클릭 판정이 투어 카드 안의 클릭을 제 바깥으로 오인하지 않게 쓴다.
 * - 경계: 투어 카드가 앵커 대신 이 요소 옆에 서게 한다(메뉴·패널처럼 앵커를 품은 표면).
 *   값이 "anchor"면 세로는 앵커 높이에 맞춘다 — 키 큰 패널 안에서 구획을 차례로 짚을 때 쓴다.
 */
export const ONBOARDING_TOUR_LAYER_ATTRIBUTE = "data-onboarding-tour-layer";
export const ONBOARDING_TOUR_LAYER_SELECTOR = `[${ONBOARDING_TOUR_LAYER_ATTRIBUTE}]`;
export const ONBOARDING_BOUNDARY_ATTRIBUTE = "data-onboarding-boundary";
export const ONBOARDING_BOUNDARY_SELECTOR = `[${ONBOARDING_BOUNDARY_ATTRIBUTE}]`;

export type OnboardingBoundaryMode = "" | "anchor";

/** JSX에 펼쳐 쓰는 경계 속성. */
export function onboardingBoundary(mode: OnboardingBoundaryMode = ""): Readonly<Record<string, string>> {
  return { [ONBOARDING_BOUNDARY_ATTRIBUTE]: mode };
}
