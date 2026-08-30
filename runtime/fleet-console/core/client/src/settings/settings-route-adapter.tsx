import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useConsoleLocale, useT } from "../i18n/index.js";
import { openPane } from "../pane/pane-store.js";
import { usePluginRegistry } from "../plugin-registry.js";
import { openRailPanel, setRailChromeExpanded } from "../rail/rail-store.js";
import { buildCoreSettingsSections, collectPluginSettingsSections, resolveSettingsSectionId } from "./sections.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "./settings-pane.js";

/**
 * 옛 `/settings` 주소의 데스크톱 어댑터.
 *
 * 페이지는 은퇴했지만 주소는 계속 열려야 한다 — 북마크, 이전 릴리스가 만든 링크, 데스크톱
 * 피커의 `/console/settings?section=remote-access`가 전부 이 문으로 들어온다. 어댑터는
 * 주소의 섹션을 레거시 id 매핑까지 거쳐 해석해 설정 표면을 그 자리로 열고, 주소는
 * 캔버스로 갈아 끼운다(replace — Back이 유령 라우트를 다시 밟지 않도록).
 *
 * 폰은 이 어댑터를 타지 않는다. 레일이 없는 폰에서는 목록-상세 페이지가 같은 섹션
 * 레지스트리의 모바일 표현으로 남는다(app.tsx의 라우트 분기).
 */
export function SettingsRouteAdapter() {
  const location = useLocation();
  const navigate = useNavigate();
  const registry = usePluginRegistry();
  const locale = useConsoleLocale();
  const t = useT();

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("section");
    const available = new Set<string>([
      ...buildCoreSettingsSections(t, null).map((section) => section.id),
      ...collectPluginSettingsSections(registry.plugins, locale, t).map((section) => section.id),
    ]);
    const section = resolveSettingsSectionId(requested, available) ?? "appearance";
    openRailPanel(SETTINGS_RAIL_ENTRY_ID);
    openPane({ paneId: SETTINGS_PANE_ID, params: { section } });
    setRailChromeExpanded(true);
    navigate("/operations", { replace: true });
  }, [location.search, navigate, registry.plugins, locale, t]);

  return null;
}
