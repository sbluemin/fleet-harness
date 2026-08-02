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
        anchor: ".command-band-triage-toggle",
        titleKey: "featureTour.triage.step3Title",
        bodyKey: "featureTour.triage.step3Body",
      },
    ],
  },
  {
    id: "claude-gateway",
    // Canvas controls 메뉴의 Claude Gateway 실행 항목 하나만 가리킨다. 선택자는 의미 속성에 건다 —
    // title/i18n 문자열에 걸면 라벨을 손보는 순간 앵커가 조용히 사라진다.
    spotlight: {
      anchor: '[data-operation-launch-kind="claude-gateway"]',
      titleKey: "featureTour.claudeGateway.spotlightTitle",
      bodyKey: "featureTour.claudeGateway.spotlightBody",
    },
    walkthrough: [],
  },
] as const;
