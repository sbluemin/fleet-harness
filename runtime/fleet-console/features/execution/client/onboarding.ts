import type { ConsoleLocale, LocalizedText } from "@fleet-console/i18n";
import { createTranslator } from "@fleet-console/i18n/translate";
import type { OnboardingContribution } from "../../onboarding/shared/types.js";

// 이 기능의 온보딩 문구 — 투어·웰컴의 내용은 기능이 소유하고, 엔진은 순서만 정한다.
const messagesEn = {
  "claudeObjectiveRecords.step3Title": "Claude, one Gateway",
  "claudeObjectiveRecords.step3Body": "Runs Claude Code with its built-in Claude models and the gateway models you enabled in Settings. You can switch models later with /model.",
  "chatMode.step2Title": "Write right here",
  "chatMode.step2Body": "This resting line is the panel's own composer — click it and it expands in place. Enter sends, Esc tucks it away, and drafts stay with this panel. New session '@' mentions still work as a separate path.",
  "chatMode.step3Title": "The terminal is one click away",
  "chatMode.step3Body": "Switch back any time — it is the same session either way. Chat turns land in the terminal scrollback, and terminal work comes back into the chat.",
} as const;

const messagesKo: Record<keyof typeof messagesEn, string> = {
  "claudeObjectiveRecords.step3Title": "하나의 Gateway로 실행하는 Claude입니다",
  "claudeObjectiveRecords.step3Body": "Claude Code 내장 Claude 모델과 설정에서 켠 게이트웨이 모델을 함께 사용합니다. 실행 후 /model로 모델을 바꿀 수 있습니다.",
  "chatMode.step2Title": "바로 여기에서 씁니다",
  "chatMode.step2Body": "이 쉬는 한 줄이 패널의 컴포저입니다 — 누르면 그 자리에서 펼쳐집니다. Enter로 보내고 Esc로 물러나며, 초안은 이 패널에 남습니다. 새 세션의 '@' 멘션은 별도 경로로 그대로 동작합니다.",
  "chatMode.step3Title": "터미널은 한 번의 클릭 거리에 있습니다",
  "chatMode.step3Body": "언제든 터미널로 돌아갈 수 있습니다 — 어느 쪽이든 같은 세션입니다. 채팅 턴은 터미널 스크롤백에 남고, 터미널에서 한 작업은 채팅으로 다시 돌아옵니다.",
};

function T(key: keyof typeof messagesEn): LocalizedText {
  return (locale: ConsoleLocale) => createTranslator<keyof typeof messagesEn>({ en: messagesEn, ko: messagesKo }, locale)(key);
}

/** 에이전트 Objective·채팅 보기의 투어. */
export const executionOnboarding: OnboardingContribution = {
  id: "execution",
  tours: [
    {
      id: "claude-objectiveRecords",
      spotlight: null,
      walkthrough: [
        // 선택자는 의미 속성에 건다 — title/i18n 문자열에 걸면 라벨을 손보는 순간 앵커가 조용히 사라진다.
        { anchor: '[data-objective-launch-kind="claude"]', title: T("claudeObjectiveRecords.step3Title"), body: T("claudeObjectiveRecords.step3Body") },
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
