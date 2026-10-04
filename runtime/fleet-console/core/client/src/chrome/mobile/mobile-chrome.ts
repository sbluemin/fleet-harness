import { reportMobileChrome } from "../../integration/mobile-appearance-store.js";
import { isMobileChoiceOpen } from "./mobile-choice-store.js";
import { getMobileDrawerOpen, getMobileSheetStack } from "./mobile-store.js";

/**
 * 지금 겹침(드로어·하단 시트·선택 팝업)에 맞는 시스템 바 면을 앱에 알린다(S-03, 브리지 `chrome` — 토큰 이름만).
 * 스크림이 덮는 동안 앱의 상태 바가 스크림 밖에 밝게 남지 않도록, 겹침이 하나라도 서면 위쪽은 더 어두운 면(`bg-deep`)이다.
 * 브리지에 스크림 색 토큰이 없어 가장 가까운 기존 토큰을 쓴다. 아래쪽은 하단 시트면 시트 면(`surface`), 그 밖의 겹침이면 `bg-deep`.
 */
export function reportShellChrome(): void {
  const drawer = getMobileDrawerOpen();
  const sheet = getMobileSheetStack().length > 0;
  const choice = isMobileChoiceOpen();
  const top = drawer || sheet || choice ? "bg-deep" : "bg";
  const bottom = sheet ? "surface" : drawer || choice ? "bg-deep" : "bg";
  reportMobileChrome(top, bottom);
}

/** 겹침을 스스로 세우는 표면(새 작업 시트·좌표 시트)이 열릴 때 — 시트와 같은 면이다. */
export function reportSheetChrome(): void {
  reportMobileChrome("bg-deep", "surface");
}
