/**
 * 온보딩 DOM 계약 — 투어 레이어와 배치 경계는 번들을 넘나드는 속성으로만 합의한다.
 *
 * - 레이어: 투어 카드가 떠 있는 동안 존재한다. 바깥 클릭 판정이 투어 카드 안의 클릭을 제 바깥으로 오인하지 않게 쓴다.
 * - 경계: 투어 카드가 앵커 대신 이 요소 옆에 서게 한다(메뉴·패널처럼 앵커를 품은 표면).
 *   값이 "anchor"면 세로는 앵커 높이에 맞춘다 — 키 큰 패널 안에서 구획을 차례로 짚을 때 쓴다.
 * - 작업 표면: 사용자가 열어 둔 패널처럼 화면 한쪽을 차지한 표면. 보이는 동안 그 바깥을 가리키는 스포트라이트는 비켜
 *   선다 — 화면 바깥 칩에 매달린 카드가 사용자가 지금 쓰는 표면의 컨트롤을 덮지 않게.
 */
export const ONBOARDING_TOUR_LAYER_ATTRIBUTE = "data-onboarding-tour-layer";
export const ONBOARDING_TOUR_LAYER_SELECTOR = `[${ONBOARDING_TOUR_LAYER_ATTRIBUTE}]`;
export const ONBOARDING_BOUNDARY_ATTRIBUTE = "data-onboarding-boundary";
export const ONBOARDING_BOUNDARY_SELECTOR = `[${ONBOARDING_BOUNDARY_ATTRIBUTE}]`;
export const ONBOARDING_WORK_SURFACE_ATTRIBUTE = "data-onboarding-work-surface";
export const ONBOARDING_WORK_SURFACE_SELECTOR = `[${ONBOARDING_WORK_SURFACE_ATTRIBUTE}]`;

export type OnboardingBoundaryMode = "" | "anchor";

/** JSX에 펼쳐 쓰는 경계 속성. */
export function onboardingBoundary(mode: OnboardingBoundaryMode = ""): Readonly<Record<string, string>> {
  return { [ONBOARDING_BOUNDARY_ATTRIBUTE]: mode };
}

/** JSX에 펼쳐 쓰는 작업 표면 속성. 숨겨진(hidden·aria-hidden) 표면은 열려 있지 않은 것으로 본다. */
export function onboardingWorkSurface(): Readonly<Record<string, string>> {
  return { [ONBOARDING_WORK_SURFACE_ATTRIBUTE]: "" };
}
