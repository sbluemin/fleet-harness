import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

// 이 기능의 온보딩 문구 — 투어·웰컴의 내용은 기능이 소유하고, 엔진은 순서만 정한다.
const messagesEn = {
  "zenTaskbar.welcomeTitle": "Zen tools float in the corner",
  "zenTaskbar.welcomeBody": "Zen gives the whole canvas to your work. Open the sidebar from the floating tools to switch Theaters or handle anything needing attention. Drag the emblem to move the tools to another corner.",
  "zenTaskbar.welcomeNext": "Try it from the Zen button in the top bar.",
  "canvasModes.step1Title": "Two ways to work the canvas",
  "canvasModes.step1Body": "Cruise keeps panels where you drop them. Align all (Alt+F) lines every panel up at once, and drops them back where they were when you toggle it off. War Room brings up one waiting panel at a time, across every Theater.",
  "canvasModes.step2Title": "Each mode has its own tools",
  "canvasModes.step2Body": "In Cruise, hover or press the active mode to open its tools. War Room keeps auto-stage and deck density beside the mode switch in the floating tools.",
  "warRoom.step1Title": "War Room, one at a time",
  "warRoom.step1Body": "Whatever is waiting comes up one at a time, in the sidebar's attention queue order. These tools are War Room's own: this one cycles deck density 1.0x -> 1.6x, and pinch or Ctrl+wheel takes it anywhere from 1.0x to 2.0x.",
  "warRoom.step2Title": "One at a time",
  "warRoom.step2Body": "Only what is waiting stays on stage. Answer it and the next item takes the same spot. Alt+→ pushes the current item to the back; Alt+↓ twice sets it aside.",
  "warRoom.step3Title": "The deck watches the rest",
  "warRoom.step3Body": "Every live Operation across every Theater sits here while nothing needs you. Click a card to bring it up now; dormant panels are left out.",
  "warRoom.step5Title": "Auto-stage finished runs",
  "warRoom.step5Body": "Leave this on and a run that just finished takes the stage by itself. Turn it off to keep the order in your hands.",
  "cruiseSnap.step1Title": "Drag a panel up to split the screen",
  "cruiseSnap.step1Body": "Drag this caption toward the top edge and a layout bar comes down. Hover a slot to preview, drop to place. Push past the bar to the very top for the whole view. A side edge gives a half, a corner a quarter. Zoom returns to 100% on every snap. Snapped panels stay in their slots while the sidebar changes, and empty slots offer the next panel; zooming lets go of them.",
  "cruiseSnap.step2Title": "Or place it without dragging",
  "cruiseSnap.step2Body": "Rest the mouse on the whole-view button and the same layouts open. Alt+Up gives the active panel the whole view, Alt+Down returns it to its previous spot, and Cmd+Alt with Left or Right snaps it to a half.",
} as const;

const messagesKo: Record<keyof typeof messagesEn, string> = {
  "zenTaskbar.welcomeTitle": "Zen 도구가 모서리에 떠 있습니다",
  "zenTaskbar.welcomeBody": "Zen에서는 캔버스 전체를 작업에 씁니다. 부유 도구에서 사이드바를 열어 Theater를 오가고 「확인 필요」를 처리하세요. 앞블럼을 끌면 도구를 다른 모서리에 붙일 수 있습니다.",
  "zenTaskbar.welcomeNext": "상단 바의 Zen 버튼으로 켜 보세요.",
  "canvasModes.step1Title": "화면을 쓰는 두 가지 방식입니다",
  "canvasModes.step1Body": "Cruise는 패널을 놓은 자리에 그대로 둡니다. 모두 정렬(Alt+F)은 열린 패널을 한 번에 정렬했다가 끄면 원래 자리로 돌려놓습니다. War Room은 답을 기다리는 패널을 Theater 구분 없이 한 건씩 올립니다.",
  "canvasModes.step2Title": "모드마다 도구가 다릅니다",
  "canvasModes.step2Body": "Cruise에서는 켜진 모드에 마우스를 올리거나 누르면 도구가 펼쳐집니다. War Room에서는 부유 섬의 모드 옆에 자동 올리기와 덱 배율이 있습니다.",
  "warRoom.step1Title": "War Room은 한 번에 하나씩",
  "warRoom.step1Body": "기다리는 건이 사이드바 「확인 필요」 순서대로 하나씩 올라옵니다. 이 도구들은 War Room의 것입니다 — 여기서 덱 밀도를 1.0× → 1.6×로 순환하고, 핀치나 Ctrl+휠로는 1.0×~2.0× 사이 어디든 갈 수 있습니다.",
  "warRoom.step2Title": "한 번에 하나만 세웁니다",
  "warRoom.step2Body": "답을 기다리는 작업만 무대에 남습니다. 답을 보내면 다음 건이 같은 자리에 섭니다. Alt+→는 이번 건을 맨 뒤로 미루고, Alt+↓를 두 번 누르면 치워둡니다.",
  "warRoom.step3Title": "덱이 나머지를 지켜봅니다",
  "warRoom.step3Body": "기다리는 작업이 없는 동안 모든 Theater의 살아 있는 Operation이 여기 모입니다. 카드를 누르면 그 건이 바로 올라오고, 휴면 패널은 싣지 않습니다.",
  "warRoom.step5Title": "완료된 작업을 자동으로 올립니다",
  "warRoom.step5Body": "켜두면 방금 끝난 작업이 스스로 무대에 올라옵니다. 순서를 직접 쥐고 싶다면 끄면 됩니다.",
  "cruiseSnap.step1Title": "패널을 위로 끌면 화면이 나뉩니다",
  "cruiseSnap.step1Body": "이 캡션을 위쪽 가장자리로 끌면 분할 바가 내려옵니다. 칸 위에 머무르면 미리 보이고, 놓으면 그 자리에 들어갑니다. 바를 지나 맨 위까지 밀어 올리면 화면 전체입니다. 좌우 가장자리는 반쪽, 모서리는 사분면입니다. 스냅하면 줌이 100%로 돌아옵니다. 스냅한 패널은 사이드바가 바뀌어도 칸에 붙어 있고, 빈 칸은 다음 패널을 권합니다. 줌하면 풀립니다.",
  "cruiseSnap.step2Title": "끌지 않고 배치하려면",
  "cruiseSnap.step2Body": "전체 칸 버튼에 마우스를 잠시 올리면 같은 레이아웃이 열립니다. Alt↑는 활성 패널을 전체 칸에, Alt↓는 직전 자리로 되돌리고, ⌘⌥ + ←/→는 반쪽에 배치합니다.",
};

function T(key: keyof typeof messagesEn): LocalizedText {
  return (locale: ConsoleLocale) => createTranslator<keyof typeof messagesEn>({ en: messagesEn, ko: messagesKo }, locale)(key);
}

/** Zen 부유 도구를 알리는 웰컴과 캔버스(Cruise·War Room)의 투어. */
export const workspaceOnboarding: OnboardingContribution = {
  id: "workspace",
  // 업데이트한 사용자에게 Zen 부유 도구를 알린다. Zen은 켜기 전에는 보이지 않는 화면이라 투어가 짚을
  // 자리가 없으므로, 켜는 곳(상단 바의 Zen 버튼)을 알리는 데서 그친다.
  welcome: {
    title: T("zenTaskbar.welcomeTitle"),
    body: T("zenTaskbar.welcomeBody"),
    next: T("zenTaskbar.welcomeNext"),
    art: () => <ZenIslandWelcomeIllustration />,
  },
  tours: [
    {
      id: "canvas-modes",
      // 모드 스위치는 Operations 화면에 항상 있으므로 첫 방문에 바로 뜬다. 모드 이름의 뜻은 지금 세그먼트 툴팁에만 있어
      // hover하지 않으면 닿지 않는다.
      spotlight: null,
      walkthrough: [
        { anchor: ".command-band-mode-switch", title: T("canvasModes.step1Title"), body: T("canvasModes.step1Body") },
        { anchor: ".command-band-mode-tray", title: T("canvasModes.step2Title"), body: T("canvasModes.step2Body") },
      ],
    },
    {
      id: "war-room",
      // 활성화 앵커(첫 non-null 앵커)는 War Room에서 항상 있고 War Room에서만 있어야 한다 — 무대는 대기 건이, 덱은 살아 있는
      // Operation이 있어야 서고, 모드 스위치는 다른 모드에도 있어 투어가 조기 발화한다. 남는 것은 War Room 전용 도구 트레이다.
      // 도구는 의미 속성으로 짚는다 — 트레이 안의 순서나 아이콘이 바뀌어도 앵커가 살아남는다.
      spotlight: null,
      walkthrough: [
        { anchor: '[data-war-room-tool="density"]', title: T("warRoom.step1Title"), body: T("warRoom.step1Body") },
        { anchor: ".canvas-operation.is-triage-stage", title: T("warRoom.step2Title"), body: T("warRoom.step2Body") },
        { anchor: ".canvas-triage-deck", title: T("warRoom.step3Title"), body: T("warRoom.step3Body") },
        { anchor: '[data-war-room-tool="spotlight"]', title: T("warRoom.step5Title"), body: T("warRoom.step5Body") },
      ],
    },
    {
      id: "cruise-snap",
      // 앵커는 Cruise에서 펼쳐진 패널의 캡션 — 스냅은 캡션을 끄는 동작에서 시작하므로 그 자리에서 짚는다. War Room·companion·
      // Fleet Map에서는 캡션 드래그가 잠겨 스냅이 없고, 전체 칸을 쥔 화면에서는 나눠 쓸 칸이 없으니 캔버스 상태 클래스로
      // Cruise만 남긴다. 모두 정렬 묶음·덱 카드·최소화 패널의 캡션은 뺀다. 두 번째 스텝은 캡션의 전체 칸 버튼이다.
      // 첫 방문의 모드 투어와 겹치지 않게 한 박자 미룬다.
      spotlight: null,
      deferAfterAnotherTour: true,
      walkthrough: [
        { anchor: ".operations-canvas:not(.is-triage):not(.is-panel-snap-full):not(.is-companion-layout) .canvas-operation:not(.is-align-held):not(.is-deck-tile):not(.is-minimized) .canvas-operation-titlebar", title: T("cruiseSnap.step1Title"), body: T("cruiseSnap.step1Body") },
        { anchor: '.operations-canvas:not(.is-triage):not(.is-panel-snap-full):not(.is-companion-layout) .canvas-operation:not(.is-align-held):not(.is-deck-tile):not(.is-minimized) [data-snap-tour="menu"]', title: T("cruiseSnap.step2Title"), body: T("cruiseSnap.step2Body") },
      ],
    },
  ],
};

/** Zen 부유 도구 소개 — 아레나는 섬 뒤에서도 화면 가장자리까지 이어진다. */
export function ZenIslandWelcomeIllustration() {
  return (
    <svg viewBox="0 0 360 176" role="img" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="zen-island-welcome-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.2" fill="var(--text-tertiary)" opacity="0.35" />
        </pattern>
      </defs>
      {/* 캔버스(Map) — 사이드바 없이 가장자리까지 */}
      <rect x="8" y="8" width="344" height="160" rx="10" fill="var(--canvas-sea-mid)" stroke="var(--hairline)" />
      <rect x="8" y="8" width="344" height="160" rx="10" fill="url(#zen-island-welcome-dots)" />
      {/* 열린 Operation 두 장 */}
      <rect x="30" y="24" width="140" height="98" rx="8" fill="var(--surface-panel)" stroke="var(--hairline-strong)" />
      <rect x="30" y="24" width="140" height="20" rx="8" fill="none" stroke="var(--hairline-strong)" />
      <circle cx="42" cy="34" r="3" fill="var(--positive)" />
      <rect x="51" y="31.5" width="56" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.6" />
      <rect x="42" y="56" width="96" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.55" />
      <rect x="42" y="70" width="116" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.4" />
      <rect x="42" y="84" width="74" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.5" />
      <rect x="42" y="102" width="58" height="6" rx="3" fill="var(--brass)" opacity="0.75" />
      <rect x="186" y="36" width="144" height="86" rx="8" fill="var(--surface-panel)" stroke="var(--hairline)" />
      <rect x="186" y="36" width="144" height="20" rx="8" fill="none" stroke="var(--hairline)" />
      <circle cx="198" cy="46" r="3" fill="var(--aurora)" />
      <rect x="207" y="43.5" width="48" height="5" rx="2.5" fill="var(--text-secondary)" opacity="0.6" />
      <rect x="198" y="68" width="108" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.45" />
      <rect x="198" y="82" width="84" height="5" rx="2.5" fill="var(--text-tertiary)" opacity="0.4" />
      {/* 모서리에 뜬 도구 섬 — 맵은 그 뒤로 이어진다. */}
      <rect x="172" y="134" width="168" height="24" rx="7" fill="var(--surface-chrome)" stroke="var(--surface-rim-strong)" />
      <g fill="none" stroke="var(--text-secondary)" strokeWidth="1.2" strokeLinecap="round">
        <rect x="180" y="140" width="11" height="11" rx="2" /><path d="M184 140v11" />
        <rect x="202" y="141" width="9" height="8" rx="1.5" />
        <path d="m220 142 3 4-3 4M234 142h8M234 146h8M234 150h5" />
      </g>
      <circle cx="193" cy="140" r="3" fill="var(--aurora)" />
      <path d="M259 142l7 7m0-7-7 7" stroke="var(--coral)" strokeWidth="1.3" />
      <path d="M275 138v16" stroke="var(--surface-rim-strong)" />
      <circle cx="289" cy="146" r="6" fill="none" stroke="var(--brass)" strokeWidth="1.2" />
      <circle cx="289" cy="146" r="1.5" fill="var(--brass)" />
      <rect x="301" y="143" width="29" height="5" rx="2.5" fill="var(--text-primary)" opacity="0.75" />
    </svg>
  );
}
