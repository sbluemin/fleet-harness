import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useRef } from "react";

import type { WorldDistrictSpec } from "../../shared/world-types.js";
import { getWorldT } from "../i18n/index.js";
import { WorldIcon } from "./world-icons.js";

export interface WorldDistrictQuickMenuProps {
  readonly district: WorldDistrictSpec;
  readonly clientX: number;
  readonly clientY: number;
  readonly hasDispatchFlag?: boolean | undefined;
  readonly locale: ConsoleLocale | undefined;
  readonly onClose: () => void;
  readonly onPlantFlagAndOrder: (district: WorldDistrictSpec) => void;
  readonly onClearFlag?: ((districtId: string) => void) | undefined;
  readonly onInspectDistrict: (districtId: string) => void;
  readonly onOpenDialogue: (commodoreActorId: string) => void;
  readonly onOpenGoals: (commodoreActorId: string) => void;
}

const MENU_ESTIMATED_WIDTH = 252;
const MENU_ESTIMATED_HEIGHT = 264;
const VIEWPORT_MARGIN = 12;

function clampMenuPosition(clientX: number, clientY: number): { left: number; top: number } {
  if (typeof window === "undefined") {
    return { left: clientX, top: clientY };
  }
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_ESTIMATED_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - MENU_ESTIMATED_HEIGHT - VIEWPORT_MARGIN);
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(clientX, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(clientY, maxTop)),
  };
}

/**
 * Theater 구역 우클릭 시 커서 위치에 열리는 다크 크리스탈 빠른 명령 메뉴.
 *
 * 보안 불변식: 원시 파일시스템 절대경로(`path`)는 절대 노출하지 않고
 * 구역 `label` · `tier` · 담당 사령관 이름만 표시한다.
 */
export const WorldDistrictQuickMenu = memo(function WorldDistrictQuickMenu({
  district,
  clientX,
  clientY,
  hasDispatchFlag = false,
  locale,
  onClose,
  onPlantFlagAndOrder,
  onClearFlag,
  onInspectDistrict,
  onOpenDialogue,
  onOpenGoals,
}: WorldDistrictQuickMenuProps) {
  const t = getWorldT(locale);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const commodoreActorId = `commodore:${district.commodoreId}`;
  const pos = clampMenuPosition(clientX, clientY);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="the-world-quick-menu"
      role="menu"
      aria-label={t("theWorld.quickDispatch.aria", { name: district.label })}
      data-tone={district.tone}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="the-world-crest" aria-hidden="true" />
      <header className="the-world-quick-menu-head">
        <span className="the-world-tone-dot" data-tone={district.tone} />
        <span className="the-world-quick-menu-title" title={district.label}>
          {district.label}
        </span>
        <span className="the-world-district-tier-pill" data-tone={district.tone}>
          {t("theWorld.tier.badge", { tier: district.tier })}
        </span>
      </header>

      <div className="the-world-quick-menu-list">
        <button
          type="button"
          role="menuitem"
          className="the-world-quick-menu-item is-primary"
          data-tone={district.tone}
          onClick={() => {
            onPlantFlagAndOrder(district);
            onClose();
          }}
        >
          <WorldIcon name="flag" size={14} tone="amber" />
          <span>{t("theWorld.quickDispatch.plantFlagOrder")}</span>
        </button>

        {hasDispatchFlag && onClearFlag ? (
          <button
            type="button"
            role="menuitem"
            className="the-world-quick-menu-item"
            onClick={() => {
              onClearFlag(district.id);
              onClose();
            }}
          >
            <WorldIcon name="close" size={14} tone="rose" />
            <span>{t("theWorld.district.clearFlag")}</span>
          </button>
        ) : null}

        <button
          type="button"
          role="menuitem"
          className="the-world-quick-menu-item"
          onClick={() => {
            onInspectDistrict(district.id);
            onClose();
          }}
        >
          <WorldIcon name="inspect" size={14} tone="cerulean" />
          <span>{t("theWorld.quickDispatch.inspectDistrict")}</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="the-world-quick-menu-item"
          onClick={() => {
            onOpenDialogue(commodoreActorId);
            onClose();
          }}
        >
          <WorldIcon name="chat" size={14} tone="teal" />
          <span>{t("theWorld.quickDispatch.openDialogue", { name: district.commodoreName })}</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="the-world-quick-menu-item"
          onClick={() => {
            onOpenGoals(commodoreActorId);
            onClose();
          }}
        >
          <WorldIcon name="questMap" size={14} tone="moss" />
          <span>{t("theWorld.quickDispatch.openGoals")}</span>
        </button>
      </div>
    </div>
  );
});
