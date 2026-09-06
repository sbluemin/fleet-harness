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
    id: "quick-launch-pin",
    // 컴포저를 직접 연 순간에만 뜬다 — 고정 버튼은 그 안에만 있고, 그 자리에서 짚어야 닿는다.
    // 컴포저가 이 버튼을 누를 수 있을 때만 렌더하므로 존재가 곧 판정이다. 상태 클래스로 걸러내면
    // 안 되는데, 옵저버가 class를 보지 않아(투어 자신이 앵커에 클래스를 붙였다 떼므로 볼 수도 없다)
    // 접힌 바를 펼쳐도 안내가 다시 계산되지 않는다.
    spotlight: null,
    walkthrough: [
      {
        anchor: ".quick-launch-pin",
        titleKey: "featureTour.quickLaunchPin.step1Title",
        bodyKey: "featureTour.quickLaunchPin.step1Body",
      },
    ],
  },
  {
    id: "quick-launch-focused-mention",
    // 핀과 같은 자리의 옵트인 — 버튼을 누를 수 있을 때만 렌더하므로 존재가 곧 판정이다.
    // 핀 투어와 같은 마운트에서 연달아 뜨지 않게 한 박자 미룬다. 다음 방문에서 제 순서에 뜬다.
    spotlight: null,
    deferAfterAnotherTour: true,
    walkthrough: [
      {
        anchor: ".quick-launch-mention-focus",
        titleKey: "featureTour.quickLaunchFocusedMention.step1Title",
        bodyKey: "featureTour.quickLaunchFocusedMention.step1Body",
      },
    ],
  },
  {
    id: "war-room",
    // 활성화 앵커(첫 non-null 앵커)는 두 조건을 동시에 만족해야 한다: War Room에서 항상 있을 것,
    // 그리고 War Room에서만 있을 것. 무대는 대기 건이, 덱은 살아 있는 Operation이 있어야 서고,
    // 모드 스위치는 다른 모드에서도 있어 투어가 조기 발화한다 — 남는 것은 War Room 전용 도구 트레이뿐이다.
    // (하단 대기 레일이 맡던 자리이며, 레일이 사라지면서 그 판정을 이 트레이가 승계했다.)
    // 도구는 의미 속성으로 짚는다 — 트레이 안의 순서나 아이콘이 바뀌어도 앵커가 살아남는다.
    spotlight: null,
    walkthrough: [
      {
        anchor: '[data-war-room-tool="density"]',
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
      {
        anchor: '[data-war-room-tool="spotlight"]',
        titleKey: "featureTour.warRoom.step5Title",
        bodyKey: "featureTour.warRoom.step5Body",
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
    // 대기열 레일(.is-narrow)도 같다 — 펼친 목록은 DOM에 있지만 display:none이라 앵커가 보이지 않는다.
    // 안내는 사용자가 레일을 고정해 목록을 펼쳤을 때 재생된다.
    spotlight: null,
    deferAfterAnotherTour: true,
    walkthrough: [
      {
        anchor: ".triage-side-bar:not(.is-closed):not(.is-narrow) .side-bar-status-section--awaiting:not(.side-bar-status-section--empty)",
        titleKey: "featureTour.warRoomSidebar.step1Title",
        bodyKey: "featureTour.warRoomSidebar.step1Body",
      },
      {
        anchor: ".triage-side-bar:not(.is-closed):not(.is-narrow) .triage-side-bar-minimized-shelf .side-bar-status-header",
        titleKey: "featureTour.warRoomSidebar.step2Title",
        bodyKey: "featureTour.warRoomSidebar.step2Body",
      },
      {
        anchor: ".triage-side-bar:not(.is-closed):not(.is-narrow) .side-bar-status-section--awaiting .side-bar-chip",
        titleKey: "featureTour.warRoomSidebar.step3Title",
        bodyKey: "featureTour.warRoomSidebar.step3Body",
      },
    ],
  },
  {
    id: "claude-operations",
    spotlight: null,
    walkthrough: [
      // 선택자는 의미 속성에 건다 — title/i18n 문자열에 걸면 라벨을 손보는 순간 앵커가 조용히 사라진다.
      {
        anchor: '[data-operation-launch-kind="claude"]',
        titleKey: "featureTour.claudeOperations.step3Title",
        bodyKey: "featureTour.claudeOperations.step3Body",
      },
    ],
  },
  {
    id: "chat-mode",
    // 앵커는 Terminal 플러그인의 Chat Mode 화면에 있다 — 크로스 번들 DOM 계약이라 클래스가
    // 아니라 전용 의미 속성(data-chat-tour)으로 짚는다. 플러그인은 사용자가 그 마운트에서
    // 직접 채팅 뷰로 전환했을 때만 앵커를 세운다(quick-launch-pin과 같은 판정) — chatMode가
    // payload에 영속되므로, 항상 세우면 리로드로 복원된 채팅 패널이 콘솔 로드 화면에서 투어를
    // 발화시킨다. 펄스 카드·영수증은 턴이 돌아야 생기는 표면이라 앵커로 삼지 않고 첫 스텝의
    // 문장이 대신 말한다.
    spotlight: null,
    walkthrough: [
      {
        anchor: '[data-chat-tour="log"]',
        titleKey: "featureTour.chatMode.step1Title",
        bodyKey: "featureTour.chatMode.step1Body",
      },
      {
        anchor: '[data-chat-tour="composer"]',
        titleKey: "featureTour.chatMode.step2Title",
        bodyKey: "featureTour.chatMode.step2Body",
      },
      {
        anchor: '[data-chat-tour="terminal"]',
        titleKey: "featureTour.chatMode.step3Title",
        bodyKey: "featureTour.chatMode.step3Body",
      },
    ],
  },
  {
    id: "remote-access",
    // 두 단계를 모두 쓰는 첫 투어다. 원격 접속은 실험 기능이라 존재를 먼저 알려야 하는데,
    // 설명할 항목은 전부 설정 화면에 있다. 그래서 어느 화면에서나 보이는 호스트 칩에
    // 스포트라이트로 존재만 알리고(한 스텝), 설정의 원격 접속 섹션에 들어온 순간 각 카드를
    // 순서대로 짚는다(워크스루).
    //
    // 두 단계를 한 투어로 묶는 것이 핵심이다 — featureTourCompletionBase가 워크스루 완료 시
    // 스포트라이트 시청 기록도 함께 남기므로, 설정에서 안내를 다 본 사용자에게 칩 하이라이트가
    // 뒤늦게 다시 뜨지 않는다. 투어 두 개로 나누면 그 연결이 끊어진다.
    spotlight: {
      anchor: ".host-switcher-chip",
      titleKey: "featureTour.remoteAccess.spotlightTitle",
      bodyKey: "featureTour.remoteAccess.spotlightBody",
    },
    // 활성화 앵커는 섹션 머리다 — 원격 접속 섹션이 열리면 항상 있다. 카드는 의미 속성으로 짚어
    // 네 카드가 공유하는 .remote-card 클래스나 배치 순서가 바뀌어도 앵커가 살아남는다.
    // 링크 카드는 리스너가 켜져 있을 때만 렌더되므로, 꺼져 있는 동안에는 그 스텝만 조용히 빠진다.
    walkthrough: [
      {
        anchor: ".remote-section-head",
        titleKey: "featureTour.remoteAccess.step1Title",
        bodyKey: "featureTour.remoteAccess.step1Body",
      },
      {
        anchor: '[data-remote-card="hosts"]',
        titleKey: "featureTour.remoteAccess.step2Title",
        bodyKey: "featureTour.remoteAccess.step2Body",
      },
      {
        anchor: '[data-remote-card="listener"]',
        titleKey: "featureTour.remoteAccess.step3Title",
        bodyKey: "featureTour.remoteAccess.step3Body",
      },
      {
        anchor: '[data-remote-card="identity"]',
        titleKey: "featureTour.remoteAccess.step4Title",
        bodyKey: "featureTour.remoteAccess.step4Body",
      },
      {
        anchor: '[data-remote-card="links"]',
        titleKey: "featureTour.remoteAccess.step5Title",
        bodyKey: "featureTour.remoteAccess.step5Body",
      },
    ],
  },
] as const;
