import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleTheaterSummary } from "@fleet-console/sdk/plugin";

import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { usePluginRegistry } from "../../../core/client/src/integration/plugin-registry.js";

interface TheaterContributionProps {
  readonly theater: ConsoleTheaterSummary;
  readonly active: boolean;
}

/**
 * 플러그인이 Theater 머리 바로 아래에 세우는 줄. 한 기여의 실패가 Theater 목록을 비우지 않도록 각각 경계로 감싸고,
 * 아무도 그리지 않으면 자리도 없다.
 */
export function TheaterContributionRows({ theater, active }: TheaterContributionProps) {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const rows = theaterContributions.filter((contribution) => contribution.row);
  if (rows.length === 0) return null;
  const context = { theater: { id: theater.id, label: theater.label }, active, language };
  return (
    <div className="side-bar-theater-contributions" data-theater-id={theater.id}>
      {rows.map((contribution) => (
        <PluginErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.row?.(context)}
        </PluginErrorBoundary>
      ))}
    </div>
  );
}

/** Theater 「…」 메뉴의 플러그인 항목 — 호스트의 시스템 프롬프트 항목 다음, 호스트의 구분선 앞에 선다. */
export function TheaterContributionMenuItems({ theater, active, onClose }: TheaterContributionProps & { readonly onClose: () => void }) {
  const { theaterContributions } = usePluginRegistry();
  const language = useConsoleLocale();
  const menus = theaterContributions.filter((contribution) => contribution.menu);
  if (menus.length === 0) return null;
  const context = { theater: { id: theater.id, label: theater.label }, active, language, onClose };
  return (
    <>
      {menus.map((contribution) => (
        <PluginErrorBoundary key={contribution.id} fallback={<></>}>
          {contribution.menu?.(context)}
        </PluginErrorBoundary>
      ))}
    </>
  );
}
