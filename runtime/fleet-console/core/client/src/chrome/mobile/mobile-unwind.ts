import { getMobilePluginDepth } from "./mobile-store.js";

/**
 * 루트 이동(드로어 목적지)을 하기 전에, 지금 루트 위에 쌓인 상세 항목 — 플러그인 depth와 설정 섹션 — 을 걷는다.
 * 걷지 않고 replace로 이동하면 맨 위 상세 항목이 새 루트로 바뀌고 옛 루트가 그 아래에 남아 뒤로가 엉뚱한 화면으로 간다.
 */
export function unwindDetailsThen(pathname: string, search: string, action: () => void): void {
  const settingsDetail = pathname.replace(/\/+$/, "").endsWith("/settings") && new URLSearchParams(search).has("section") ? 1 : 0;
  const count = getMobilePluginDepth() + settingsDetail;
  if (count <= 0) { action(); return; }
  const done = () => { window.removeEventListener("popstate", done); window.clearTimeout(timer); action(); };
  const timer = window.setTimeout(done, 400);
  window.addEventListener("popstate", done);
  window.history.go(-count);
}
