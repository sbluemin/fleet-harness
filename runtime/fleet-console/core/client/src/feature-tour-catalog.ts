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
  // 다른 투어가 같은 마운트에서 이미 끝났다면 시작하지 않는다 — 두 투어가 연달아 재생되면
  // 사용자에게는 스텝을 합친 것과 다르지 않다. 다음 방문에서 제 순서에 뜬다.
  readonly deferAfterAnotherTour?: boolean;
}

export const FEATURE_TOURS: readonly FeatureTour[] = [
  {
    id: "canvas-modes",
    // 모드 스위치는 Operations 화면에 항상 있으므로 첫 방문에 바로 뜬다. 모드 이름의 뜻은
    // 지금 세그먼트 툴팁에만 있어 hover하지 않으면 닿지 않는다.
    spotlight: null,
    walkthrough: [
      {
        anchor: ".command-band-mode-switch",
        titleKey: "featureTour.canvasModes.step1Title",
        bodyKey: "featureTour.canvasModes.step1Body",
      },
      {
        anchor: ".command-band-mode-tray",
        titleKey: "featureTour.canvasModes.step2Title",
        bodyKey: "featureTour.canvasModes.step2Body",
      },
    ],
  },
  {
    id: "war-room",
    // 활성화 앵커는 War Room에 들어가면 항상 있는 대기 레일이다 — 무대를 앞에 두면 대기 건이
    // 없는 진입에서 투어 전체가 조용히 사라진다. 무대 스텝은 있을 때만 재생된다.
    spotlight: null,
    walkthrough: [
      {
        anchor: ".canvas-triage-rail",
        titleKey: "featureTour.warRoom.step1Title",
        bodyKey: "featureTour.warRoom.step1Body",
      },
      {
        anchor: ".canvas-operation.is-triage-stage",
        titleKey: "featureTour.warRoom.step2Title",
        bodyKey: "featureTour.warRoom.step2Body",
      },
      {
        anchor: ".canvas-triage-deck",
        titleKey: "featureTour.warRoom.step3Title",
        bodyKey: "featureTour.warRoom.step3Body",
      },
      // 도구는 의미 속성으로 짚는다 — 트레이 안의 순서나 아이콘이 바뀌어도 앵커가 살아남는다.
      {
        anchor: '[data-war-room-tool="density"]',
        titleKey: "featureTour.warRoom.step4Title",
        bodyKey: "featureTour.warRoom.step4Body",
      },
      {
        anchor: '[data-war-room-tool="spotlight"]',
        titleKey: "featureTour.warRoom.step5Title",
        bodyKey: "featureTour.warRoom.step5Body",
      },
      {
        anchor: ".command-band-mode-switch",
        titleKey: "featureTour.warRoom.step6Title",
        bodyKey: "featureTour.warRoom.step6Body",
      },
    ],
  },
  {
    id: "war-room-sidebar",
    // 대기 섹션은 비어 있어도 렌더되므로 비지 않은 상태를 앵커 조건으로 삼는다 — 줄이 하나도
    // 없는 목록 앞에서 "순서를 가로챌 수 있다"고 말해도 짚을 대상이 없다.
    //
    // 접힌 사이드바(:not(.is-closed))도 같은 이유로 배제한다 — 접혀도 자식은 DOM에 남고 폭 0 +
    // visibility:hidden으로만 가려지므로, 배제하지 않으면 사용자가 본 적 없는 안내가 재생되고
    // 시청 기록에 그대로 남는다.
    spotlight: null,
    deferAfterAnotherTour: true,
    walkthrough: [
      {
        anchor: ".triage-side-bar:not(.is-closed) .side-bar-status-section--awaiting:not(.side-bar-status-section--empty)",
        titleKey: "featureTour.warRoomSidebar.step1Title",
        bodyKey: "featureTour.warRoomSidebar.step1Body",
      },
      {
        anchor: ".triage-side-bar:not(.is-closed) .triage-side-bar-caption",
        titleKey: "featureTour.warRoomSidebar.step2Title",
        bodyKey: "featureTour.warRoomSidebar.step2Body",
      },
      {
        anchor: ".triage-side-bar:not(.is-closed) .side-bar-status-section--awaiting .side-bar-chip",
        titleKey: "featureTour.warRoomSidebar.step3Title",
        bodyKey: "featureTour.warRoomSidebar.step3Body",
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
  {
    id: "classic-deprecation",
    // 런치 메뉴의 Classic 항목에만 닻을 건다 — 메뉴가 열려야 뜨고, Classic CLI가 없는 메뉴에는
    // 항목 자체가 없으니 안내도 함께 빠진다. CLI 미설치로 항목이 비활성이면 폐지 안내는 의미가
    // 없으므로(:disabled 제외) 쓸 수 있는 Classic이 있을 때만 재생한다.
    // 폐지는 점진적이라 "당장 옮겨라"가 아니라 "새로 만들 때는 새 종류를 고르라"는 1회성 스포트라이트다.
    spotlight: {
      anchor: '[data-operation-launch-kind="claude"]:not(:disabled)',
      titleKey: "featureTour.classicDeprecation.title",
      bodyKey: "featureTour.classicDeprecation.body",
    },
    walkthrough: [],
  },
] as const;
