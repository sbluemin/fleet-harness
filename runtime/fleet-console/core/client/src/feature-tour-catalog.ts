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
    spotlight: {
      anchor: ".command-band-triage-toggle",
      titleKey: "featureTour.triage.spotlightTitle",
      bodyKey: "featureTour.triage.spotlightBody",
    },
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
] as const;
