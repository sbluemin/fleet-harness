// 첫 페인트 전에 저장된 테마 힌트를 적용하는 파싱 블로킹 부트 스크립트.
// CSP(script-src 'self')가 인라인 스크립트를 금지하므로 public 자산으로 제공한다.
// 유효 id 목록은 client types.ts의 ThemeId와 수동 동기화한다(플레인 JS라 import 불가).
(() => {
  migrateLegacyGlassOff();
  stampMobileAppearance();
  // 서버 주입이 권위값 — 힌트는 미주입 서빙 경로 폴백 전용이다.
  if (document.documentElement.getAttribute("data-theme-source") === "server") return;
  try {
    const theme = localStorage.getItem("fleet-console.theme-hint");
    if (theme === "instrument" || theme === "maritime" || theme === "carbon" || theme === "whites") {
      document.documentElement.setAttribute("data-theme", theme);
    } else if (theme === "daywatch" || theme === "drydock") {
      // 퇴역 라이트 힌트는 whites로 폴백 — store.readStoredThemeHint와 극성이 일치해야
      // 미주입 서빙 경로에서 다크 base 첫 페인트 플래시가 생기지 않는다.
      document.documentElement.setAttribute("data-theme", "whites");
    }
  } catch {
    // localStorage 접근 불가 환경(사파리 프라이빗 등)에서는 기본 instrument 유지.
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

// 퇴역한 리퀴드 글래스 스위치를 꺼 두었던 사람은 이 기기에서 처음 뜰 때 네 유리 불투명도를
// 100%(완전 불투명)로 옮긴다 — 스위치가 사라져도 보던 화면이 그대로 남는다. 판단 근거는 서버
// 저장값(static-console이 data-glass-legacy로 주입)이고, 구 부트 힌트는 미주입 서빙 경로에서만 본다. 기기마다 한 번뿐이다.
// 키는 glass-opacity-store.ts와 수동 동기화한다(플레인 JS라 import 불가). 첫 페인트 앞에서
// 돌아야 유리가 한 번 스쳤다 불투명해지는 플래시가 없다.
function migrateLegacyGlassOff() {
  const root = document.documentElement;
  const legacyOff = root.getAttribute("data-glass-legacy") === "off";
  // 서버가 주입했으면 그 판단이 권위값이다 — 다른 기기에서 다시 켠 뒤 남은 낡은 힌트로 이관하지 않는다.
  const serverInjected = root.getAttribute("data-theme-source") === "server";
  root.removeAttribute("data-glass-legacy");
  try {
    if (localStorage.getItem("fleet-console.glass.legacy-migrated") === "1") return;
    if (legacyOff || (!serverInjected && localStorage.getItem("fleet-console.glass-hint") === "off")) {
      for (const group of ["window", "bar", "side-bar", "rail"]) {
        localStorage.setItem(`fleet-console.glass.${group}-opacity`, "100");
      }
    }
    localStorage.removeItem("fleet-console.glass-hint");
    localStorage.setItem("fleet-console.glass.legacy-migrated", "1");
  } catch {
    // localStorage 접근 불가 환경에서는 이관할 기기 저장소도 없다.
  }
}
