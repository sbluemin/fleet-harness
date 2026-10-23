// 첫 페인트 전에 저장된 테마 힌트를 적용하는 파싱 블로킹 부트 스크립트.
// CSP(script-src 'self')가 인라인 스크립트를 금지하므로 public 자산으로 제공한다.
// 유효 id와 퇴역 id 이전 규칙은 store.ts의 readThemeId와 수동 동기화한다(플레인 JS라 import 불가).
(() => {
  retireGlassOpacityKeys();
  stampMobileAppearance();
  // iOS Safari·WKWebView는 문서에 touchstart 리스너가 없으면 :active를 걸지 않는다 — 모바일 누름 문법
  // (S-52 PR-0d, mobile-press.css)이 손가락이 닿는 순간 회색 면을 보이게 하는 빈 passive 리스너다.
  // 마우스·데스크톱 Electron에는 터치가 없어 아무 일도 하지 않는다.
  document.addEventListener("touchstart", () => {}, { passive: true });
  // 서버 주입이 권위값 — 힌트는 미주입 서빙 경로 폴백 전용이다.
  if (document.documentElement.getAttribute("data-theme-source") === "server") return;
  try {
    const theme = localStorage.getItem("fleet-console.theme-hint");
    // 퇴역 힌트도 같은 극성으로 옮긴다 — 다크 팔레트(instrument/maritime/carbon)는 dark, 라이트(whites와
    // 그 전의 daywatch/drydock)는 light. store.readStoredThemeHint와 극성이 일치해야 미주입 서빙 경로에서
    // 첫 페인트 플래시가 생기지 않는다.
    if (theme === "dark" || theme === "instrument" || theme === "maritime" || theme === "carbon") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else if (theme === "light" || theme === "whites" || theme === "daywatch" || theme === "drydock") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch {
    // localStorage 접근 불가 환경(사파리 프라이빗 등)에서는 기본 dark 유지.
  }
})();

// 모바일 팔레트(theme.css의 :root[data-view-mode="mobile"][data-mobile-scheme] 블록)가 첫 페인트부터
// 서도록 루트 속성을 미리 붙인다. data-view-mode는 원래 React effect가 첫 렌더 뒤에 붙여서, 그 사이
// 한 프레임은 데스크톱 팔레트로 그려졌다. 판정 규칙은 view-mode-store.ts의 createSnapshot과 수동
// 동기화한다(플레인 JS라 import 불가): Electron은 언제나 desktop, 명시 선호가 이기고, auto면
// FleetMobile UA 또는 폭 767px 이하. 같은 규칙이라 뒤이은 effect가 값을 뒤집지 않는다.
// 색상 모드·글자 배율은 mobile-appearance-store.ts와 같은 규칙이다(키·전역 이름·화이트리스트 수동
// 동기화): Fleet Mobile 앱이 문서 시작에 심은 window.__fleetMobileAppearance가 있으면 그것이 정본,
// 없으면 브라우저 저장값, "시스템"은 prefers-color-scheme. 데스크톱에서도 붙여 둔다 — 블록이
// view-mode와 함께만 매치되므로 무해하고, 창을 좁혀 모바일 배치로 넘어가는 순간 바로 팔레트가 선다.
function stampMobileAppearance() {
  const root = document.documentElement;
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent || "";
  const isMode = (value) => value === "system" || value === "dark" || value === "light";
  const isScale = (value) => value === "small" || value === "default" || value === "large";
  let preference = "auto";
  let colorMode = "system";
  let fontScale = "default";
  try {
    const storedView = localStorage.getItem("fleet-console.view-mode.preference");
    if (storedView === "mobile" || storedView === "desktop") preference = storedView;
    const storedMode = localStorage.getItem("fleet-console.mobile-color-mode");
    if (isMode(storedMode)) colorMode = storedMode;
    const storedScale = localStorage.getItem("fleet-console.mobile-font-scale");
    if (isScale(storedScale)) fontScale = storedScale;
  } catch {
    // 저장소가 막힌 환경에서는 auto·system·default로 판정한다.
  }
  const matches = (query) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const mobile = userAgent.includes("Electron")
    ? false
    : preference === "auto" ? /(?:^|\s)FleetMobile\/\d/.test(userAgent) || matches("(max-width: 767px)") : preference === "mobile";
  root.setAttribute("data-view-mode", mobile ? "mobile" : "desktop");
  let systemScheme = matches("(prefers-color-scheme: light)") ? "light" : "dark";
  const native = window.__fleetMobileAppearance;
  if (native && native.v === 1 && isMode(native.colorMode) && isScale(native.fontScale)
    && (native.systemScheme === "dark" || native.systemScheme === "light")) {
    colorMode = native.colorMode;
    fontScale = native.fontScale;
    systemScheme = native.systemScheme;
  }
  root.setAttribute("data-mobile-scheme", colorMode === "system" ? systemScheme : colorMode);
  root.setAttribute("data-mobile-font-scale", fontScale);
}

// 퇴역한 유리 불투명도 취향(묶음별 슬라이더·그 전의 리퀴드 글래스 스위치·더 옛 사이드바/레일 알파)이
// 남긴 기기 저장값을 지운다. 이제 아무것도 읽지 않으므로 화면에는 닿지 않는다 — 정리만 한다.
function retireGlassOpacityKeys() {
  try {
    for (const key of [
      "fleet-console.glass.window-opacity",
      "fleet-console.glass.bar-opacity",
      "fleet-console.glass.side-bar-opacity",
      "fleet-console.glass.rail-opacity",
      "fleet-console.glass.legacy-migrated",
      "fleet-console.glass-hint",
      "fleet-console.objectiveRecords.side-glass-alpha",
      "fleet-console.objectiveRecords.side-glass-blur",
      "fleet-console.rail.overlayAlpha",
    ]) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage 접근 불가 환경에서는 지울 기기 저장소도 없다.
  }
}
