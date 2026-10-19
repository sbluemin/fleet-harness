import type { CoreMessageKey } from "./messages/index.js";

const en = {
  "chrome.launch.mentionErrorTrustRequired": "Trust has not been confirmed for this folder. Open a terminal in the folder and run claude. If the trust dialog appears, choose “Yes, I trust this folder”, then retry sending your message",
  "chrome.directoryBrowser.trustNotice": "Adding this folder also marks it as trusted. Only this folder and its descendants are affected.",
  "chrome.directoryBrowser.trustFailure": "Folder trust could not be saved. Open a terminal in this folder and run claude. If the folder trust dialog appears, choose “Yes, I trust this folder”, then retry adding the Theater. If it still fails, check the global settings file.",
  "chrome.directoryBrowser.trustLocked": "Settings are locked by another process. Wait a moment and retry adding this Theater.",
  "sidebar.theater.subagents.off": "Subagents start as usual. Running sessions follow from their next subagent call.",
  "sidebar.theater.prompt.scope": "Applies to new sessions opened in this Theater. Running sessions stay as they are.",
  "sidebar.theater.prompt.modeOn": "Default",
  "sidebar.theater.prompt.keptHelp": "Saved here but not applied while Default is selected.",
  "sidebar.theater.prompt.captionOn": "Only the default prompt is used.",
} satisfies Partial<Record<CoreMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "chrome.launch.mentionErrorTrustRequired": "이 폴더의 신뢰를 확인하지 못했습니다. 해당 폴더에서 터미널을 열고 claude를 실행한 뒤, 신뢰 확인 화면이 나타나면 “Yes, I trust this folder”를 선택해 주세요. 완료한 뒤 메시지 전달을 다시 시도하세요",
  "chrome.directoryBrowser.trustNotice": "추가하면 이 폴더를 신뢰하도록 설정합니다. 이 폴더와 하위 경로에만 적용됩니다.",
  "chrome.directoryBrowser.trustFailure": "폴더 신뢰 설정을 저장하지 못했습니다. 해당 폴더에서 터미널을 열고 claude를 실행한 뒤, 폴더 신뢰 확인 화면이 나타나면 “Yes, I trust this folder”를 선택해 주세요. 완료한 뒤 Theater 추가를 다시 시도하세요. 계속 실패하면 전역 설정 파일을 확인하세요.",
  "chrome.directoryBrowser.trustLocked": "다른 프로세스가 설정을 사용 중입니다. 잠시 뒤 Theater 추가를 다시 시도하세요.",
  "sidebar.theater.subagents.off": "평소처럼 서브에이전트를 띄웁니다. 실행 중인 세션도 다음 서브에이전트 호출부터 따릅니다.",
  "sidebar.theater.prompt.scope": "이 Theater에서 새로 여는 세션에 적용됩니다. 실행 중인 세션은 그대로입니다.",
  "sidebar.theater.prompt.modeOn": "기본",
  "sidebar.theater.prompt.keptHelp": "저장되지만 기본을 고른 동안에는 적용되지 않습니다.",
  "sidebar.theater.prompt.captionOn": "기본 프롬프트만 실립니다.",
};

export const MOBILE_MESSAGES = { en, ko };
