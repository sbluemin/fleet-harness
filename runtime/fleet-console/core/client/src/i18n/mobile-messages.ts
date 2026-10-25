import type { CoreMessageKey } from "./messages/index.js";

const en = {
  "chrome.launch.mentionErrorTrustRequired": "Trust has not been confirmed for this folder. Open a terminal in the folder and run claude. If the trust dialog appears, choose “Yes, I trust this folder”, then retry sending your message",
  "chrome.directoryBrowser.trustNotice": "Adding this folder also marks it as trusted. Only this folder and its descendants are affected.",
  "chrome.directoryBrowser.trustFailure": "Folder trust could not be saved. Open a terminal in this folder and run claude. If the folder trust dialog appears, choose “Yes, I trust this folder”, then retry adding the Theater. If it still fails, check the global settings file.",
  "chrome.directoryBrowser.trustLocked": "Settings are locked by another process. Wait a moment and retry adding this Theater.",
  "sidebar.theater.prompt.scope": "Applies to new sessions opened in this Theater. Running sessions stay as they are.",
  "sidebar.theater.prompt.modeOn": "Default",
  "sidebar.theater.prompt.keptHelp": "Saved here but not applied while Default is selected.",
  "sidebar.theater.prompt.captionOn": "Only the default prompt is used.",
} satisfies Partial<Record<CoreMessageKey, string>>;

const ko: Record<keyof typeof en, string> = {
  "chrome.launch.mentionErrorTrustRequired": "이 폴더를 아직 신뢰하지 않아요. 그 폴더에서 터미널을 열고 claude를 실행해 신뢰 확인 화면에서 “Yes, I trust this folder”를 고른 뒤 다시 보내 주세요",
  "chrome.directoryBrowser.trustNotice": "추가하면 이 폴더를 바로 신뢰해요. 이 폴더와 그 아래 경로에만 적용돼요.",
  "chrome.directoryBrowser.trustFailure": "폴더 신뢰 설정을 저장하지 못했어요. 그 폴더에서 터미널을 열고 claude를 실행해 신뢰 확인 화면에서 “Yes, I trust this folder”를 고른 뒤 Theater를 다시 추가해 주세요. 계속 안 되면 전역 설정 파일을 확인해 주세요.",
  "chrome.directoryBrowser.trustLocked": "다른 프로세스가 설정을 쓰고 있어요. 잠시 뒤 Theater를 다시 추가해 주세요.",
  "sidebar.theater.prompt.scope": "이 Theater에서 새로 여는 세션에 적용돼요. 실행 중인 세션은 그대로예요.",
  "sidebar.theater.prompt.modeOn": "기본",
  "sidebar.theater.prompt.keptHelp": "저장은 되지만, 기본을 고른 동안에는 적용되지 않아요.",
  "sidebar.theater.prompt.captionOn": "기본 프롬프트만 실려요.",
};

export const MOBILE_MESSAGES = { en, ko };
