import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useConsoleLocale, useT } from "../../../core/client/src/i18n/index.js";
import { useFeatureRegistry } from "../../../core/client/src/integration/feature-registry.js";
import { buildCoreSettingsSections, collectPluginSettingsSections, resolveSettingsSectionId } from "./sections.js";
import { openSettingsSurface } from "./settings-door.js";

/**
 * 옛 `/settings` 주소의 데스크톱 어댑터.
 *
 * 페이지는 은퇴했지만 주소는 계속 열려야 한다 — 북마크, 이전 릴리스가 만든 링크, 데스크톱
 * 피커의 `/console/settings?section=remote-access`가 전부 이 문으로 들어온다. 어댑터는
 * 주소의 섹션을 레거시 id 매핑까지 거쳐 해석해 설정 모달을 그 자리로 열고, 주소는
 * 대화 중심 화면(/objectives)으로 갈아 끼운다(replace — Back이 유령 라우트를 다시 밟지 않도록).
 * 갈아 끼우기 전 한 프레임은 빈 셸이다 — 이 주소에는 따로 그리는 크롬이 없다.
 *
 * 폰은 이 어댑터를 타지 않는다. 폰에서는 목록-상세 페이지가 같은 섹션
 * 레지스트리의 모바일 표현으로 남는다(app.tsx의 라우트 분기).
 */
export function SettingsRouteAdapter() {
  const location = useLocation();
  const navigate = useNavigate();
  const registry = useFeatureRegistry();
  const locale = useConsoleLocale();
  const t = useT();

  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("section");
    const available = new Set<string>([
      ...buildCoreSettingsSections(t, null).map((section) => section.id),
      ...collectPluginSettingsSections(registry.providers, locale, t).map((section) => section.id),
    ]);
    const section = resolveSettingsSectionId(requested, available) ?? "appearance";
    openSettingsSurface(section);
    navigate("/objectives", { replace: true });
  }, [location.search, navigate, registry.providers, locale, t]);

  return null;
}
