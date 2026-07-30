// 첫 페인트 전에 저장된 테마 힌트를 적용하는 파싱 블로킹 부트 스크립트.
// CSP(script-src 'self')가 인라인 스크립트를 금지하므로 public 자산으로 제공한다.
// 유효 id 목록은 client types.ts의 ThemeId와 수동 동기화한다(플레인 JS라 import 불가).
(() => {
  // 서버 주입이 권위값 — 힌트는 미주입 서빙 경로 폴백 전용.
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
