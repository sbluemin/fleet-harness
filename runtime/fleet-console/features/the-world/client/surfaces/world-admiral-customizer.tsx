import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useRef } from "react";

import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import type {
  WorldActorSpec,
  WorldAdmiralCape,
  WorldAdmiralHat,
  WorldAdmiralStyle,
  WorldAdmiralTrail,
} from "../../shared/world-types.js";
import { playDistrictHover, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  COSMETIC_UNLOCK_THRESHOLDS,
  isCosmeticUnlocked,
  setAdmiralCustomizerTab,
  setCommodoreGift,
  setStampBookOpen,
  useWorldStore,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export interface WorldAdmiralCustomizerProps {
  readonly style: WorldAdmiralStyle;
  readonly locale: ConsoleLocale | undefined;
  readonly onChangeStyle: (patch: Partial<WorldAdmiralStyle>) => void;
  readonly onPreviewChange?: (() => void) | undefined;
  readonly onClose: () => void;
  /** 시즌2: 사령관 선물 탭에 표시할 사령관 액터 목록. */
  readonly commodores?: readonly WorldActorSpec[] | undefined;
  /** 시즌2: 사령관별 선물 모자 상태 (미전달 시 스토어 `commodoreGifts` 사용). */
  readonly commodoreGifts?: Readonly<Record<string, WorldAdmiralHat>> | undefined;
  /** 시즌2: 사령관 모자 선물 콜백 (미전달 시 스토어 `setCommodoreGift` 직접 호출). */
  readonly onGiftHat?: ((commodoreId: string, hat: WorldAdmiralHat | null, commodoreName: string) => void) | undefined;
  /** Sprint 21: 미해금 외형 클릭 시 항해 수첩 안내 토스트 콜백. */
  readonly onLockedHint?: ((msg: string) => void) | undefined;
  /** Sprint 21: 항해 수첩 모달 열기 콜백. */
  readonly onOpenStampBook?: (() => void) | undefined;
}

type CustomizerTab = "self" | "gifts";

const ADMIRAL_TONES: readonly IdentityTone[] = [
  "crimson",
  "amber",
  "moss",
  "teal",
  "cerulean",
  "indigo",
  "plum",
  "rose",
];

const ADMIRAL_HATS: readonly {
  readonly id: WorldAdmiralHat;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
  readonly requiredStamps?: number | undefined;
}[] = [
  { id: "admiral", key: "theWorld.admiral.hat.admiral", icon: "hat", tone: "cerulean" },
  { id: "crown", key: "theWorld.admiral.hat.crown", icon: "crown", tone: "amber" },
  { id: "explorer", key: "theWorld.admiral.hat.explorer", icon: "compass", tone: "moss" },
  {
    id: "flower_crown",
    key: "theWorld.admiral.hat.flower_crown",
    icon: "sakura",
    tone: "rose",
    requiredStamps: COSMETIC_UNLOCK_THRESHOLDS.flower_crown,
  },
  { id: "none", key: "theWorld.admiral.hat.none", icon: "close", tone: "inherit" },
];

const ADMIRAL_CAPES: readonly {
  readonly id: WorldAdmiralCape;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
  readonly requiredStamps?: number | undefined;
}[] = [
  { id: "starlight", key: "theWorld.admiral.cape.starlight", icon: "cape", tone: "indigo" },
  { id: "hero", key: "theWorld.admiral.cape.hero", icon: "cape", tone: "rose" },
  { id: "forest", key: "theWorld.admiral.cape.forest", icon: "cape", tone: "moss" },
  {
    id: "aurora",
    key: "theWorld.admiral.cape.aurora",
    icon: "rainbow",
    tone: "cerulean",
    requiredStamps: COSMETIC_UNLOCK_THRESHOLDS.aurora,
  },
  { id: "none", key: "theWorld.admiral.cape.none", icon: "close", tone: "inherit" },
];

const ADMIRAL_TRAILS: readonly {
  readonly id: WorldAdmiralTrail;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
  readonly requiredStamps?: number | undefined;
}[] = [
  { id: "stardust", key: "theWorld.admiral.trail.stardust", icon: "sparkle", tone: "amber" },
  { id: "sakura", key: "theWorld.admiral.trail.sakura", icon: "sakura", tone: "rose" },
  {
    id: "rainbow",
    key: "theWorld.admiral.trail.rainbow",
    icon: "rainbow",
    tone: "teal",
    requiredStamps: COSMETIC_UNLOCK_THRESHOLDS.rainbow,
  },
  { id: "none", key: "theWorld.admiral.trail.none", icon: "close", tone: "inherit" },
];

const GIFT_HAT_OPTIONS: readonly {
  readonly id: WorldAdmiralHat | null;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "crown", key: "theWorld.admiral.hat.crown", icon: "crown", tone: "amber" },
  { id: "explorer", key: "theWorld.admiral.hat.explorer", icon: "compass", tone: "moss" },
  { id: "admiral", key: "theWorld.admiral.hat.admiral", icon: "hat", tone: "cerulean" },
  { id: null, key: "theWorld.admiral.giftDefault", icon: "close", tone: "inherit" },
];

/**
 * 우측 플로팅 글래스 「제독 몽글이 3D 드레스업 시즌 2」 시트.
 *
 * - 내 제독 탭: 8색 아이덴티티 톤 · 모자 4종 · 망토 4종 · 발걸음 궤적 4종 실시간 적용
 * - 사령관 선물 탭: 사령관별 3D 모자(황금 왕관 · 탐험가 모자 · 제독 모자 · 기본) 선물
 */
export const WorldAdmiralCustomizer = memo(function WorldAdmiralCustomizer({
  style,
  locale,
  onChangeStyle,
  onPreviewChange,
  onClose,
  commodores = [],
  commodoreGifts: commodoreGiftsProp,
  onGiftHat,
  onLockedHint,
  onOpenStampBook,
}: WorldAdmiralCustomizerProps) {
  const store = useWorldStore();
  const tab: CustomizerTab = store.admiralCustomizerTab;
  const focusedCommodoreId = store.admiralCustomizerFocusCommodoreId;
  const focusedGiftCardRef = useRef<HTMLDivElement | null>(null);
  const t = getWorldT(locale);
  const unlockedStampCount = store.unlockedStamps.length;
  const activeHatMeta = ADMIRAL_HATS.find((h) => h.id === style.hat) ?? ADMIRAL_HATS[0]!;
  const effectiveGifts = commodoreGiftsProp ?? store.commodoreGifts;
  const giftableCommodores = commodores.filter(
    (actor): actor is WorldActorSpec & { readonly commodoreId: string } =>
      actor.role === "commodore" && typeof actor.commodoreId === "string" && actor.commodoreId.length > 0,
  );

  useEffect(() => {
    if (tab !== "gifts" || !focusedCommodoreId) return;
    const id = window.requestAnimationFrame(() => {
      focusedGiftCardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [focusedCommodoreId, tab]);

  const handleLockedCosmeticClick = (requiredCount: number) => {
    playDistrictHover();
    onLockedHint?.(t("theWorld.stamps.lockedHint", { count: requiredCount }));
    if (onOpenStampBook) {
      onOpenStampBook();
    } else {
      onClose();
      setStampBookOpen(true);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClose]);

  const handleGiftSelect = (commodoreId: string, hat: WorldAdmiralHat | null, commodoreName: string) => {
    playDistrictSelect();
    if (onGiftHat) {
      onGiftHat(commodoreId, hat, commodoreName);
    } else {
      setCommodoreGift(commodoreId, hat);
    }
  };

  return (
    <aside
      className="the-world-customizer-sheet"
      data-tone={style.tone}
      role="dialog"
      aria-label={t("theWorld.admiral.aria")}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="the-world-drawer-crest" aria-hidden="true" />

      <header className="the-world-drawer-head">
        <div className="the-world-dialogue-speaker">
          <span className="the-world-qb-emblem" aria-hidden="true">
            <WorldIcon name={tab === "gifts" ? "gift" : "hat"} size={17} tone="amber" />
          </span>
          <div>
            <h2 className="the-world-dialogue-name">{t("theWorld.admiral.title")}</h2>
            <p className="the-world-dialogue-role">{t("theWorld.admiral.subtitle")}</p>
          </div>
        </div>

        <button
          type="button"
          className="the-world-btn is-icon-only"
          aria-label={t("theWorld.admiral.closeAria")}
          onClick={onClose}
        >
          <WorldIcon name="close" size={14} />
        </button>
      </header>

      {/* 시즌2 2탭 전환: 내 제독 / 사령관 선물 */}
      <div className="the-world-customizer-tabs" role="tablist" aria-label={t("theWorld.admiral.tabsAria")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "self"}
          className={`the-world-customizer-tab${tab === "self" ? " is-active" : ""}`}
          onClick={() => {
            playDistrictHover();
            setAdmiralCustomizerTab("self");
          }}
        >
          <WorldIcon name="hat" size={13} tone={tab === "self" ? "amber" : "cerulean"} />
          <span>{t("theWorld.admiral.tabSelf")}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "gifts"}
          className={`the-world-customizer-tab${tab === "gifts" ? " is-active" : ""}`}
          onClick={() => {
            playDistrictHover();
            setAdmiralCustomizerTab("gifts");
          }}
        >
          <WorldIcon name="gift" size={13} tone={tab === "gifts" ? "amber" : "rose"} />
          <span>{t("theWorld.admiral.tabGifts")}</span>
          {giftableCommodores.length > 0 ? (
            <span className="the-world-customizer-tab-count">{giftableCommodores.length}</span>
          ) : null}
        </button>
      </div>

      {tab === "self" ? (
        <div className="the-world-customizer-body">
          {/* 실시간 3D 제독 회전 안내 칩 */}
          <div className="the-world-customizer-hint">
            <WorldIcon name="cameraOrbit" size={13} tone="amber" />
            <span className="the-world-customizer-hint-text">{t("theWorld.admiral.dragHint")}</span>
            <span className="the-world-customizer-hat-chip">
              <WorldIcon name={activeHatMeta.icon} size={11} tone="amber" />
              <span>{t(activeHatMeta.key)}</span>
            </span>
          </div>

          {/* 8색 톤 스와치 */}
          <div className="the-world-admiral-section">
            <span className="the-world-district-section-label">{t("theWorld.admiral.toneLabel")}</span>
            <div
              className="the-world-admiral-swatches"
              role="group"
              aria-label={t("theWorld.admiral.toneGroupAria")}
            >
              {ADMIRAL_TONES.map((tone) => {
                const active = style.tone === tone;
                return (
                  <button
                    key={tone}
                    type="button"
                    className={`the-world-admiral-swatch${active ? " is-active" : ""}`}
                    data-tone={tone}
                    aria-label={t("theWorld.admiral.toneGroupAria")}
                    aria-pressed={active}
                    onClick={() => {
                      playDistrictHover();
                      onChangeStyle({ tone });
                      onPreviewChange?.();
                    }}
                  >
                    <span className="the-world-admiral-swatch-dot" data-tone={tone} />
                  </button>
                );
              })}
            </div>
          </div>

          {/* 모자 선택 (스탬프 보상 들꽃 화관 포함) */}
          <div className="the-world-admiral-section">
            <span className="the-world-district-section-label">{t("theWorld.admiral.hatLabel")}</span>
            <div
              className="the-world-admiral-hats"
              role="group"
              aria-label={t("theWorld.admiral.hatGroupAria")}
            >
              {ADMIRAL_HATS.map((hat) => {
                const active = style.hat === hat.id;
                const locked = !isCosmeticUnlocked(unlockedStampCount, hat.id);
                const lockedHint = locked && hat.requiredStamps
                  ? t("theWorld.stamps.lockedHint", { count: hat.requiredStamps })
                  : undefined;
                return (
                  <button
                    key={hat.id}
                    type="button"
                    className={`the-world-admiral-hat-pill${active ? " is-active" : ""}${locked ? " is-locked" : ""}`}
                    aria-pressed={active}
                    aria-label={lockedHint ? `${t(hat.key)} · ${lockedHint}` : undefined}
                    title={lockedHint}
                    onClick={() => {
                      if (locked && hat.requiredStamps) {
                        handleLockedCosmeticClick(hat.requiredStamps);
                        return;
                      }
                      playDistrictSelect();
                      onChangeStyle({ hat: hat.id });
                      onPreviewChange?.();
                    }}
                  >
                    <WorldIcon name={hat.icon} size={14} tone={active ? "amber" : hat.tone} />
                    <span className="the-world-admiral-hat-label">{t(hat.key)}</span>
                    {locked && hat.requiredStamps ? (
                      <span className="the-world-admiral-lock-badge" aria-hidden="true">
                        <WorldIcon name="trophy" size={10} tone="amber" />
                        <span>{Math.min(unlockedStampCount, hat.requiredStamps)}/{hat.requiredStamps}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 망토 선택 (스탬프 보상 오로라 망토 포함) */}
          <div className="the-world-admiral-section">
            <span className="the-world-district-section-label">{t("theWorld.admiral.capeLabel")}</span>
            <div
              className="the-world-admiral-hats"
              role="group"
              aria-label={t("theWorld.admiral.capeGroupAria")}
            >
              {ADMIRAL_CAPES.map((cape) => {
                const active = style.cape === cape.id;
                const locked = !isCosmeticUnlocked(unlockedStampCount, cape.id);
                const lockedHint = locked && cape.requiredStamps
                  ? t("theWorld.stamps.lockedHint", { count: cape.requiredStamps })
                  : undefined;
                return (
                  <button
                    key={cape.id}
                    type="button"
                    className={`the-world-admiral-hat-pill${active ? " is-active" : ""}${locked ? " is-locked" : ""}`}
                    aria-pressed={active}
                    aria-label={lockedHint ? `${t(cape.key)} · ${lockedHint}` : undefined}
                    title={lockedHint}
                    onClick={() => {
                      if (locked && cape.requiredStamps) {
                        handleLockedCosmeticClick(cape.requiredStamps);
                        return;
                      }
                      playDistrictSelect();
                      onChangeStyle({ cape: cape.id });
                      onPreviewChange?.();
                    }}
                  >
                    <WorldIcon name={cape.icon} size={14} tone={active ? "amber" : cape.tone} />
                    <span className="the-world-admiral-hat-label">{t(cape.key)}</span>
                    {locked && cape.requiredStamps ? (
                      <span className="the-world-admiral-lock-badge" aria-hidden="true">
                        <WorldIcon name="trophy" size={10} tone="amber" />
                        <span>{Math.min(unlockedStampCount, cape.requiredStamps)}/{cape.requiredStamps}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 발걸음 궤적 선택 (스탬프 보상 무지개 별똥별 포함) */}
          <div className="the-world-admiral-section">
            <span className="the-world-district-section-label">{t("theWorld.admiral.trailLabel")}</span>
            <div
              className="the-world-admiral-hats"
              role="group"
              aria-label={t("theWorld.admiral.trailGroupAria")}
            >
              {ADMIRAL_TRAILS.map((trail) => {
                const active = style.trail === trail.id;
                const locked = !isCosmeticUnlocked(unlockedStampCount, trail.id);
                const lockedHint = locked && trail.requiredStamps
                  ? t("theWorld.stamps.lockedHint", { count: trail.requiredStamps })
                  : undefined;
                return (
                  <button
                    key={trail.id}
                    type="button"
                    className={`the-world-admiral-hat-pill${active ? " is-active" : ""}${locked ? " is-locked" : ""}`}
                    aria-pressed={active}
                    aria-label={lockedHint ? `${t(trail.key)} · ${lockedHint}` : undefined}
                    title={lockedHint}
                    onClick={() => {
                      if (locked && trail.requiredStamps) {
                        handleLockedCosmeticClick(trail.requiredStamps);
                        return;
                      }
                      playDistrictSelect();
                      onChangeStyle({ trail: trail.id });
                      onPreviewChange?.();
                    }}
                  >
                    <WorldIcon name={trail.icon} size={14} tone={active ? "amber" : trail.tone} />
                    <span className="the-world-admiral-hat-label">{t(trail.key)}</span>
                    {locked && trail.requiredStamps ? (
                      <span className="the-world-admiral-lock-badge" aria-hidden="true">
                        <WorldIcon name="trophy" size={10} tone="amber" />
                        <span>{Math.min(unlockedStampCount, trail.requiredStamps)}/{trail.requiredStamps}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="the-world-customizer-body">
          <div className="the-world-customizer-hint">
            <WorldIcon name="gift" size={13} tone="rose" />
            <span className="the-world-customizer-hint-text">{t("theWorld.admiral.giftsHint")}</span>
          </div>

          {giftableCommodores.length === 0 ? (
            <div className="the-world-gazette-empty">
              <WorldIcon name="commodore" size={14} tone="cerulean" />
              <span>{t("theWorld.admiral.giftsEmpty")}</span>
            </div>
          ) : (
            <div className="the-world-gift-list">
              {giftableCommodores.map((actor) => {
                const currentGift = effectiveGifts[actor.commodoreId] ?? null;
                const isFocused = focusedCommodoreId === actor.commodoreId;
                return (
                  <div
                    key={actor.id}
                    ref={isFocused ? focusedGiftCardRef : undefined}
                    className={`the-world-gift-card${isFocused ? " is-focused" : ""}`}
                    data-tone={actor.tone}
                  >
                    <div className="the-world-gift-card-head">
                      <span className="the-world-gazette-tone-dot" data-tone={actor.tone} aria-hidden="true" />
                      <span className="the-world-gift-card-name">{actor.name}</span>
                    </div>
                    <div
                      className="the-world-gift-pills"
                      role="group"
                      aria-label={t("theWorld.admiral.giftGroupAria", { name: actor.name })}
                    >
                      {GIFT_HAT_OPTIONS.map((opt) => {
                        const active = currentGift === opt.id;
                        return (
                          <button
                            key={opt.id ?? "default"}
                            type="button"
                            className={`the-world-gift-pill${active ? " is-active" : ""}`}
                            aria-pressed={active}
                            onClick={() => handleGiftSelect(actor.commodoreId, opt.id, actor.name)}
                          >
                            <WorldIcon name={opt.icon} size={12} tone={active ? "amber" : opt.tone} />
                            <span>{t(opt.key)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </aside>
  );
});
