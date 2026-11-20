import type { ConsoleLocale } from "@fleet-console/i18n";

import type { TheWorldClientDeps } from "../deps.js";
import { getWorldT } from "../i18n/index.js";
import { useWorldSnapshot } from "../world-projection.js";
import { enterTheWorld, useWorldStore } from "../world-store.js";

/**
 * 데스크톱 사이드바 하단 시스템 독(`ConversationSideBarBottom`)에 장착되는 「더 월드」 특수 진입 포털.
 */
export function PortalDockEntry({
  deps,
  locale,
}: {
  readonly deps: TheWorldClientDeps;
  readonly locale?: ConsoleLocale | undefined;
}) {
  const store = useWorldStore();
  const snapshot = useWorldSnapshot(deps, store.demoMode, store.extraDemoOutposts);
  if (deps.isMobileLayout()) return null;
  const t = getWorldT(locale ?? deps.commodore.language());

  const handleEnter = () => {
    const activeObj = deps.getActiveObjectiveId();
    const viewedCmdr = deps.getViewedCommodoreId();
    const initialActorId = activeObj
      ? (snapshot.actors.find((a) => a.objectiveId === activeObj)?.id ?? null)
      : viewedCmdr
        ? `commodore:${viewedCmdr}`
        : (snapshot.actors[0]?.id ?? null);
    enterTheWorld({
      reducedMotion: deps.isReducedMotion(),
      initialActorId,
    });
  };

  return (
    <button
      type="button"
      data-sidebar-footer-unit=""
      className="the-world-portal-btn"
      title={t("theWorld.portal.title")}
      aria-label={t("theWorld.portal.aria")}
      onClick={handleEnter}
    >
      <span
        className={`the-world-portal-orb${snapshot.attentionCount > 0 ? " is-attention" : ""}`}
        aria-hidden="true"
      />
      <span>{t("theWorld.portal.label")}</span>
      <span className="the-world-portal-count">
        ✦{snapshot.activeCount > 0 ? snapshot.activeCount : snapshot.totalPopulation}
      </span>
    </button>
  );
}
