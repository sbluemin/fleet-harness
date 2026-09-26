import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";
import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

// 이 기능의 온보딩 문구 — 투어·웰컴의 내용은 기능이 소유하고, 엔진은 순서만 정한다.
const messagesEn = {
  "remoteAccess.spotlightTitle": "Reach this console from another device",
  "remoteAccess.spotlightBody": "Remote access is experimental. Open Settings → Remote access to hand another device an access link, or to save another console you can open from Fleet Desktop.",
  "remoteAccess.step1Title": "Remote access is experimental",
  "remoteAccess.step1Body": "It works today, but how links and pairings behave can still change between releases. Turning it on opens this console to other devices, so read each card before you use it.",
  "remoteAccess.step2Title": "Consoles you can jump to",
  "remoteAccess.step2Body": "Paste an access link from another console and it lands in this list. Opening one from the host chip needs Fleet Desktop, because a browser cannot check a console's certificate.",
  "remoteAccess.step3Title": "Choose the address this console answers on",
  "remoteAccess.step3Body": "Choose the local listen endpoint and the public hostname and port your router forwards to it. Turning it off closes the listener and ends every remote session immediately.",
  "remoteAccess.step4Title": "This console's fingerprint",
  "remoteAccess.step4Body": "Access links carry it so the Fleet Console app can tell this console apart from an impostor. Rotating it unpairs every device at once.",
  "remoteAccess.step5Title": "Hand out an access link",
  "remoteAccess.step5Body": "A link is spent on first use and pairs one device. A full link lets that device run commands on this machine; a monitoring link cannot. Treat a link as a secret.",
} as const;

const messagesKo: Record<keyof typeof messagesEn, string> = {
  "remoteAccess.spotlightTitle": "다른 기기에서 이 콘솔에 접속할 수 있습니다",
  "remoteAccess.spotlightBody": "원격 접속은 실험 기능입니다. 설정 → 원격 접속에서 다른 기기에 액세스 링크를 건네거나, Fleet Desktop으로 열 수 있는 다른 콘솔을 저장할 수 있습니다.",
  "remoteAccess.step1Title": "원격 접속은 실험 기능입니다",
  "remoteAccess.step1Body": "지금도 동작하지만, 링크와 페어링이 처리되는 방식은 릴리스마다 달라질 수 있습니다. 켜면 이 콘솔이 다른 기기에 열리므로 각 항목을 읽어 보고 사용하세요.",
  "remoteAccess.step2Title": "건너갈 수 있는 콘솔 목록입니다",
  "remoteAccess.step2Body": "다른 콘솔의 액세스 링크를 붙여넣으면 이 목록에 들어옵니다. 호스트 칩에서 실제로 여는 데는 Fleet Desktop이 필요합니다 — 브라우저는 콘솔의 인증서를 대조할 수 없습니다.",
  "remoteAccess.step3Title": "이 콘솔이 응답할 주소를 고릅니다",
  "remoteAccess.step3Body": "로컬 수신 엔드포인트와 라우터가 그곳으로 전달할 공개 호스트 이름 및 포트를 고릅니다. 끄면 리스너가 닫히고 모든 원격 세션이 즉시 끝납니다.",
  "remoteAccess.step4Title": "이 콘솔의 지문입니다",
  "remoteAccess.step4Body": "액세스 링크가 이 지문을 실어, Fleet Console 앱이 이 콘솔과 사칭을 구분합니다. 지문을 갱신하면 연결된 모든 기기가 한 번에 끊깁니다.",
  "remoteAccess.step5Title": "액세스 링크를 건넵니다",
  "remoteAccess.step5Body": "링크는 처음 한 번만 쓰이고 기기 하나와 페어링됩니다. full 링크는 그 기기가 이 기계에서 명령을 실행할 수 있게 하고, monitoring 링크는 그럴 수 없습니다. 링크는 비밀로 다루세요.",
};

function T(key: keyof typeof messagesEn): LocalizedText {
  return (locale: ConsoleLocale) => createTranslator<keyof typeof messagesEn>({ en: messagesEn, ko: messagesKo }, locale)(key);
}

/**
 * 원격 접속 — 존재를 먼저 알려야 하는 실험 기능인데 설명할 항목은 전부 설정 화면에 있다. 그래서 어느 화면에서나 보이는
 * 호스트 칩에 스포트라이트로 존재만 알리고, 설정의 원격 접속 섹션에 들어온 순간 각 카드를 차례로 짚는다. 두 단계를 한
 * 투어로 묶어야 설정에서 안내를 다 본 사람에게 칩 하이라이트가 뒤늦게 다시 뜨지 않는다.
 */
export const remoteAccessOnboarding: OnboardingContribution = {
  id: "remote-access",
  tours: [
    {
      id: "remote-access",
      spotlight: { anchor: ".host-switcher-chip", title: T("remoteAccess.spotlightTitle"), body: T("remoteAccess.spotlightBody") },
      // 활성화 앵커는 섹션 머리다. 카드는 의미 속성으로 짚고, 링크 카드는 리스너가 켜져 있을 때만 렌더되므로 꺼져 있는 동안에는
      // 그 스텝만 조용히 빠진다.
      walkthrough: [
        { anchor: ".remote-section-head", title: T("remoteAccess.step1Title"), body: T("remoteAccess.step1Body") },
        { anchor: '[data-remote-card="hosts"]', title: T("remoteAccess.step2Title"), body: T("remoteAccess.step2Body") },
        { anchor: '[data-remote-card="listener"]', title: T("remoteAccess.step3Title"), body: T("remoteAccess.step3Body") },
        { anchor: '[data-remote-card="identity"]', title: T("remoteAccess.step4Title"), body: T("remoteAccess.step4Body") },
        { anchor: '[data-remote-card="links"]', title: T("remoteAccess.step5Title"), body: T("remoteAccess.step5Body") },
      ],
    },
  ],
};
