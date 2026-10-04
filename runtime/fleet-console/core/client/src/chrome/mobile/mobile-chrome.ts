import { reportMobileChrome } from "../../integration/mobile-appearance-store.js";
import { isMobileChoiceOpen } from "./mobile-choice-store.js";
import { getMobileDrawerOpen, getMobileSheetStack } from "./mobile-store.js";

/**
 * 지금 겹침(드로어·하단 시트·선택 팝업)에 맞는 시스템 바 면을 앱에 알린다(S-03, 브리지 `chrome` — 토큰 이름만).
 * 스크림이 덮는 동안 앱의 상태 바가 스크림 밖에 밝게 남지 않도록, 시트·팝업이 서면 위쪽은 스크림을 합성한 면(`scrim`, 브리지 v1.5 —
 * 앱이 모르면 스토어가 `bg-deep`으로 대신 보낸다)이고 드로어는 `bg-deep`이다. 아래쪽은 하단 시트면 시트 면(`surface`), 선택 팝업이면 `scrim`, 드로어면 `bg-deep`.
 */
export function reportShellChrome(): void {
  const drawer = getMobileDrawerOpen();
  const sheet = getMobileSheetStack().length > 0;
  const choice = isMobileChoiceOpen();
  const top = sheet || choice ? "scrim" : drawer ? "bg-deep" : "bg";
  // 선택 팝업은 스크림이 화면 전체를 덮으므로 아래 바도 스크림 면이다(S-03 정정). 하단 시트는 시트 면.
  const bottom = sheet ? "surface" : choice ? "scrim" : drawer ? "bg-deep" : "bg";
  reportMobileChrome(top, bottom);
}

/** 겹침을 스스로 세우는 표면(새 작업 시트·좌표 시트)이 열릴 때 — 시트와 같은 면이다. */
export function reportSheetChrome(): void {
  reportMobileChrome("scrim", "surface");
}
