export const FEATURE_TOUR_LAYER_ATTRIBUTE = "data-feature-tour-layer";
export const FEATURE_TOUR_LAYER_SELECTOR = `[${FEATURE_TOUR_LAYER_ATTRIBUTE}]`;
export const FEATURE_TOUR_BOUNDARY_ATTRIBUTE = "data-feature-tour-boundary";
export const FEATURE_TOUR_BOUNDARY_SELECTOR = `[${FEATURE_TOUR_BOUNDARY_ATTRIBUTE}]`;

export interface FeatureTourStep {
  readonly anchor: string | null;
  readonly titleKey: string;
  readonly bodyKey: string;
}

export interface FeatureTour {
  readonly id: string;
  readonly spotlight: FeatureTourStep | null;
  readonly walkthrough: readonly FeatureTourStep[];
}

export const FEATURE_TOURS: readonly FeatureTour[] = [
  {
    id: "triage",
    // 버튼을 미리 소개하지 않고, 사용자가 선별 처리에 실제 진입했을 때만 안내한다.
    spotlight: null,
    walkthrough: [
      {
        anchor: ".canvas-operation.is-triage-stage",
        titleKey: "featureTour.triage.step1Title",
        bodyKey: "featureTour.triage.step1Body",
      },
      {
        anchor: ".canvas-triage-rail",
        titleKey: "featureTour.triage.step2Title",
        bodyKey: "featureTour.triage.step2Body",
      },
      {
        anchor: '[data-canvas-mode="warRoom"]',
        titleKey: "featureTour.triage.step3Title",
        bodyKey: "featureTour.triage.step3Body",
      },
    ],
  },
  {
    id: "claude-operations",
    // Claude가 세 갈래로 나뉜 사실은 셋을 차례로 짚어야 전해진다 — 하나만 비추면 나머지 둘과
    // 무엇이 다른지가 빠진다. 순서는 메뉴에 놓인 순서(Native → Classic → Gateway)를 따른다.
    // 이 투어는 주의를 한 번 환기할 뿐이고, 되짚어 볼 설명은 메뉴 항목에 상시 남는다.
    spotlight: null,
    walkthrough: [
      // 선택자는 의미 속성에 건다 — title/i18n 문자열에 걸면 라벨을 손보는 순간 앵커가 조용히 사라진다.
      {
        anchor: '[data-operation-launch-kind="claude-native"]',
        titleKey: "featureTour.claudeOperations.step1Title",
        bodyKey: "featureTour.claudeOperations.step1Body",
      },
      {
        anchor: '[data-operation-launch-kind="claude"]',
        titleKey: "featureTour.claudeOperations.step2Title",
        bodyKey: "featureTour.claudeOperations.step2Body",
      },
      {
        anchor: '[data-operation-launch-kind="claude-gateway"]',
        titleKey: "featureTour.claudeOperations.step3Title",
        bodyKey: "featureTour.claudeOperations.step3Body",
      },
    ],
  },
] as const;
