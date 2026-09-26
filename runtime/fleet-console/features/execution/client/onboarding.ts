import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

// 이 기능의 온보딩 문구 — 투어·웰컴의 내용은 기능이 소유하고, 엔진은 순서만 정한다.
const messagesEn = {
  "quickLaunchPin.step1Title": "Keep Quick Launch at the bottom",
  "quickLaunchPin.step1Body": "Pin the composer and it docks to the bottom edge, so you can write while the work stays in view. It recedes into a single line when you look away, and the Quick Launch shortcut brings it back.",
  "quickLaunchFocusedMention.step1Title": "Address the panel in view",
  "quickLaunchFocusedMention.step1Body": "Turn this on and opening Quick Launch mentions the focused Operation. Type and send without picking. Backspace on an empty prompt clears it.",
  "quickLaunchSuggest.step1Title": "Refine the prompt before launch",
  "quickLaunchSuggest.step1Body": "Press this and your request is rewritten into a clear task brief: goal, scope, constraints, and open questions. It is a draft; the prompt changes only when you apply it. Experimental, from Settings.",
  "claudeOperations.step3Title": "Claude, one Gateway",
  "claudeOperations.step3Body": "Runs Claude Code with its built-in Claude models and the gateway models you enabled in Settings. You can switch models later with /model.",
  "chatMode.step2Title": "Write right here",
  "chatMode.step2Body": "This resting line is the panel's own composer — click it and it expands in place. Enter sends, Esc tucks it away, and drafts stay with this panel. Quick Launch mentions still work as a separate path.",
  "chatMode.step3Title": "The terminal is one click away",
  "chatMode.step3Body": "Switch back any time — it is the same session either way. Chat turns land in the terminal scrollback, and terminal work comes back into the chat.",
} as const;

const messagesKo: Record<keyof typeof messagesEn, string> = {
  "quickLaunchPin.step1Title": "Quick Launch를 하단에 두기",
  "quickLaunchPin.step1Body": "고정하면 컴포저가 화면 아래에 도킹돼, 작업 화면을 보면서 지시를 쓸 수 있습니다. 시선을 떼면 한 줄로 물러나고, Quick Launch 단축키로 다시 부릅니다.",
  "quickLaunchFocusedMention.step1Title": "보고 있는 패널에 보내기",
  "quickLaunchFocusedMention.step1Body": "켜 두면 Quick Launch를 열 때 포커스된 Operation이 멘션됩니다. 고르지 않고 바로 쓰고 보내면 됩니다. 빈 입력에서 Backspace로 지웁니다.",
  "quickLaunchSuggest.step1Title": "시작 전에 프롬프트 다듬기",
  "quickLaunchSuggest.step1Body": "누르면 요청을 목표·범위·제약·확인할 질문이 있는 작업 지시문으로 고쳐 씁니다. 초안일 뿐이라 적용해야 프롬프트가 바뀝니다. 설정의 실험 기능입니다.",
  "claudeOperations.step3Title": "하나의 Gateway로 실행하는 Claude입니다",
  "claudeOperations.step3Body": "Claude Code 내장 Claude 모델과 설정에서 켠 게이트웨이 모델을 함께 사용합니다. 실행 후 /model로 모델을 바꿀 수 있습니다.",
  "chatMode.step2Title": "바로 여기에서 씁니다",
  "chatMode.step2Body": "이 쉬는 한 줄이 패널의 컴포저입니다 — 누르면 그 자리에서 펼쳐집니다. Enter로 보내고 Esc로 물러나며, 초안은 이 패널에 남습니다. Quick Launch 멘션은 별도 경로로 그대로 동작합니다.",
  "chatMode.step3Title": "터미널은 한 번의 클릭 거리에 있습니다",
  "chatMode.step3Body": "언제든 터미널로 돌아갈 수 있습니다 — 어느 쪽이든 같은 세션입니다. 채팅 턴은 터미널 스크롤백에 남고, 터미널에서 한 작업은 채팅으로 다시 돌아옵니다.",
};

function T(key: keyof typeof messagesEn): LocalizedText {
  return (locale: ConsoleLocale) => createTranslator<keyof typeof messagesEn>({ en: messagesEn, ko: messagesKo }, locale)(key);
}

/** Quick Launch 컴포저·에이전트 Operation·채팅 보기의 투어. */
export const executionOnboarding: OnboardingContribution = {
  id: "execution",
  tours: [
    {
      id: "quick-launch-pin",
      // 컴포저를 직접 연 순간에만 뜬다 — 고정 버튼은 그 안에만 있고, 버튼을 누를 수 있을 때만 렌더하므로 존재가 곧 판정이다.
      spotlight: null,
      walkthrough: [
        { anchor: ".quick-launch-pin", title: T("quickLaunchPin.step1Title"), body: T("quickLaunchPin.step1Body") },
      ],
    },
    {
      id: "quick-launch-focused-mention",
      // 핀과 같은 자리의 옵트인 — 같은 마운트에서 연달아 뜨지 않게 한 박자 미룬다.
      spotlight: null,
      deferAfterAnotherTour: true,
      walkthrough: [
        { anchor: ".quick-launch-mention-focus", title: T("quickLaunchFocusedMention.step1Title"), body: T("quickLaunchFocusedMention.step1Body") },
      ],
    },
    {
      id: "quick-launch-suggest",
      // 실험 "런치 제안"의 버튼은 설정에서 켜고 프롬프트를 쓴 뒤에만 서므로 존재가 곧 판정이다.
      spotlight: null,
      deferAfterAnotherTour: true,
      walkthrough: [
        { anchor: ".quick-launch-suggest-trigger", title: T("quickLaunchSuggest.step1Title"), body: T("quickLaunchSuggest.step1Body") },
      ],
    },
    {
      id: "claude-operations",
      spotlight: null,
      walkthrough: [
        // 선택자는 의미 속성에 건다 — title/i18n 문자열에 걸면 라벨을 손보는 순간 앵커가 조용히 사라진다.
        { anchor: '[data-operation-launch-kind="claude"]', title: T("claudeOperations.step3Title"), body: T("claudeOperations.step3Body") },
      ],
    },
    {
      id: "chat-mode",
      // 채팅 보기는 사용자가 그 마운트에서 직접 채팅으로 전환했을 때만 앵커(data-chat-tour)를 세운다 — chatMode가 영속되므로,
      // 항상 세우면 리로드로 복원된 채팅 패널이 로드 화면에서 투어를 발화시킨다.
      spotlight: null,
      walkthrough: [
        { anchor: '[data-chat-tour="composer"]', title: T("chatMode.step2Title"), body: T("chatMode.step2Body") },
        { anchor: '[data-chat-tour="terminal"]', title: T("chatMode.step3Title"), body: T("chatMode.step3Body") },
      ],
    },
  ],
};
