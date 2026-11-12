import type { ConsoleLocale } from "@fleet-console/i18n";
import { createTranslator } from "@fleet-console/i18n/translate";

export const browserEn = {
  "terminal.browser.title": "Fleet Browser",
  "terminal.browser.open": "Open Fleet Browser",
  "terminal.browser.focus": "Focus the Fleet Browser window",
  "terminal.browser.exit": "Close Fleet Browser",
  "terminal.browser.agentUsing": "The agent is using the Fleet Browser — click to open it",
  "terminal.browser.desktopOnly": "The Fleet Browser opens only in the Fleet Desktop app.",
  "terminal.browser.desktopMissing": "No Fleet Desktop window is showing this Console, so the browser can't open.",
  "terminal.browser.shared": "Browser paused: this Console is also open in a browser tab or on a phone.",
  "terminal.browser.viewerOpen": "Open the view-only browser",
  "terminal.browser.viewerLink": "View only — this screen can't open tabs",
  "terminal.browser.unmanaged": "This Console is not managed by Fleet Desktop, so the Fleet Browser has nowhere to run.",
  "terminal.browser.managerDisconnected": "This Console's managing Fleet Desktop is disconnected.",
  "terminal.browser.suggestions.title": "Address and search suggestions",
  "terminal.browser.suggestions.disclosure": "Sends search input to Google, but not URLs or local addresses.",
  "terminal.browser.suggestions.settingsFailed": "Couldn't save or load search suggestion settings. Try again.",
  "terminal.browser.requestFailed": "The browser could not complete that request.",
  "terminal.browser.terminalNotRunning": "This Session's terminal is not running, so nothing was pasted.",
  "terminal.browser.clipboardFailed": "Couldn't put the screenshot on the clipboard.",
  "terminal.browser.sharedFallback": "Opened in your browser because the Fleet Browser is paused",
  "terminal.chooser.noObjective": "This chat has no Fleet Browser",
  "terminal.chooser.sessionNotStarted": "This chat's session hasn't started yet",
};
export const browserKo: Record<keyof typeof browserEn, string> = {
  "terminal.browser.title": "플릿 브라우저",
  "terminal.browser.open": "플릿 브라우저 열기",
  "terminal.browser.focus": "플릿 브라우저 창으로 이동",
  "terminal.browser.exit": "플릿 브라우저 닫기",
  "terminal.browser.agentUsing": "에이전트가 플릿 브라우저를 쓰는 중이에요. 누르면 열려요",
  "terminal.browser.desktopOnly": "플릿 브라우저는 Fleet Desktop 앱에서만 열려요.",
  "terminal.browser.desktopMissing": "이 Console을 보고 있는 Fleet Desktop 창이 없어서 브라우저를 열 수 없어요.",
  "terminal.browser.shared": "브라우저가 일시 중지됐어요. 이 Console이 브라우저 탭이나 휴대폰에서도 열려 있어요.",
  "terminal.browser.viewerOpen": "보기 전용 브라우저 열기",
  "terminal.browser.viewerLink": "보기 전용이에요. 이 화면에서는 탭을 열 수 없어요",
  "terminal.browser.unmanaged": "이 Console은 Fleet Desktop이 관리하지 않아 플릿 브라우저가 실행될 곳이 없어요.",
  "terminal.browser.managerDisconnected": "이 Console을 관리하는 Fleet Desktop 연결이 끊겼어요.",
  "terminal.browser.suggestions.title": "주소 및 검색어 제안",
  "terminal.browser.suggestions.disclosure": "검색 입력을 Google로 보내며, URL·로컬 주소는 보내지 않아요.",
  "terminal.browser.suggestions.settingsFailed": "검색어 제안 설정을 저장하거나 불러오지 못했어요. 다시 시도해 주세요.",
  "terminal.browser.requestFailed": "브라우저가 요청을 처리하지 못했어요.",
  "terminal.browser.terminalNotRunning": "이 Session의 터미널이 실행 중이 아니라서 붙여넣지 못했어요.",
  "terminal.browser.clipboardFailed": "스크린샷을 클립보드에 올리지 못했어요.",
  "terminal.browser.sharedFallback": "플릿 브라우저가 일시 중지돼서 내 브라우저로 열었어요",
  "terminal.chooser.noObjective": "이 채팅에는 플릿 브라우저가 없어요",
  "terminal.chooser.sessionNotStarted": "이 채팅의 세션이 아직 시작되지 않았어요",
};
const messages = { en: browserEn, ko: browserKo };
const translators = { en: createTranslator(messages, "en"), ko: createTranslator(messages, "ko") };
export function getT(locale: ConsoleLocale | undefined) { return translators[locale ?? "en"]; }
