import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useState } from "react";

import { playDistrictHover, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  COSMETIC_UNLOCK_THRESHOLDS,
  WORLD_STAMP_IDS,
  type WorldStampId,
  type WorldUnlockableCosmeticKind,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export const WORLD_FISH_IDS = [
  "meadow_minnow",
  "golden_koi",
  "starlight_trout",
  "cherry_loach",
  "moon_jelly",
  "rainbow_carp",
  "star_shell",
  "message_bottle",
] as const;

export type WorldFishId = (typeof WORLD_FISH_IDS)[number];

export type WorldFishRarity = "common" | "rare" | "legendary";

export type WorldStampBookTab = "stamps" | "fish";

export interface WorldStampBookProps {
  readonly open: boolean;
  readonly unlockedStamps: readonly WorldStampId[];
  readonly caughtFishCounts?: Readonly<Record<string, number>> | undefined;
  readonly initialTab?: WorldStampBookTab | undefined;
  readonly locale: ConsoleLocale | undefined;
  readonly onOpenCustomizer?: (() => void) | undefined;
  readonly onClose: () => void;
}

const STAMP_META: Readonly<Record<WorldStampId, {
  readonly titleKey: TheWorldMessageKey;
  readonly descKey: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}>> = {
  first_dive: {
    titleKey: "theWorld.stamps.item.first_dive.title",
    descKey: "theWorld.stamps.item.first_dive.desc",
    icon: "sparkle",
    tone: "amber",
  },
  squadron_flight: {
    titleKey: "theWorld.stamps.item.squadron_flight.title",
    descKey: "theWorld.stamps.item.squadron_flight.desc",
    icon: "mapOverview",
    tone: "cerulean",
  },
  campfire_party: {
    titleKey: "theWorld.stamps.item.campfire_party.title",
    descKey: "theWorld.stamps.item.campfire_party.desc",
    icon: "fire",
    tone: "rose",
  },
  rain_umbrella_walk: {
    titleKey: "theWorld.stamps.item.rain_umbrella_walk.title",
    descKey: "theWorld.stamps.item.rain_umbrella_walk.desc",
    icon: "rain",
    tone: "teal",
  },
  photo_snap: {
    titleKey: "theWorld.stamps.item.photo_snap.title",
    descKey: "theWorld.stamps.item.photo_snap.desc",
    icon: "camera",
    tone: "indigo",
  },
  sky_ring_combo: {
    titleKey: "theWorld.stamps.item.sky_ring_combo.title",
    descKey: "theWorld.stamps.item.sky_ring_combo.desc",
    icon: "spin",
    tone: "amber",
  },
  tier5_citadel: {
    titleKey: "theWorld.stamps.item.tier5_citadel.title",
    descKey: "theWorld.stamps.item.tier5_citadel.desc",
    icon: "crown",
    tone: "moss",
  },
  objective_celebration: {
    titleKey: "theWorld.stamps.item.objective_celebration.title",
    descKey: "theWorld.stamps.item.objective_celebration.desc",
    icon: "confetti",
    tone: "amber",
  },
};

const FISH_META: Readonly<Record<WorldFishId, {
  readonly titleKey: TheWorldMessageKey;
  readonly descKey: TheWorldMessageKey;
  readonly rarity: WorldFishRarity;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}>> = {
  meadow_minnow: {
    titleKey: "theWorld.fishing.fish.meadow_minnow.title",
    descKey: "theWorld.fishing.fish.meadow_minnow.desc",
    rarity: "common",
    icon: "leaf",
    tone: "cerulean",
  },
  golden_koi: {
    titleKey: "theWorld.fishing.fish.golden_koi.title",
    descKey: "theWorld.fishing.fish.golden_koi.desc",
    rarity: "rare",
    icon: "crown",
    tone: "amber",
  },
  starlight_trout: {
    titleKey: "theWorld.fishing.fish.starlight_trout.title",
    descKey: "theWorld.fishing.fish.starlight_trout.desc",
    rarity: "rare",
    icon: "sparkle",
    tone: "indigo",
  },
  cherry_loach: {
    titleKey: "theWorld.fishing.fish.cherry_loach.title",
    descKey: "theWorld.fishing.fish.cherry_loach.desc",
    rarity: "common",
    icon: "sakura",
    tone: "rose",
  },
  moon_jelly: {
    titleKey: "theWorld.fishing.fish.moon_jelly.title",
    descKey: "theWorld.fishing.fish.moon_jelly.desc",
    rarity: "rare",
    icon: "moon",
    tone: "teal",
  },
  rainbow_carp: {
    titleKey: "theWorld.fishing.fish.rainbow_carp.title",
    descKey: "theWorld.fishing.fish.rainbow_carp.desc",
    rarity: "legendary",
    icon: "rainbow",
    tone: "amber",
  },
  star_shell: {
    titleKey: "theWorld.fishing.fish.star_shell.title",
    descKey: "theWorld.fishing.fish.star_shell.desc",
    rarity: "common",
    icon: "compass",
    tone: "cerulean",
  },
  message_bottle: {
    titleKey: "theWorld.fishing.fish.message_bottle.title",
    descKey: "theWorld.fishing.fish.message_bottle.desc",
    rarity: "legendary",
    icon: "mail",
    tone: "amber",
  },
};

const RARITY_LABEL_KEY: Readonly<Record<WorldFishRarity, TheWorldMessageKey>> = {
  common: "theWorld.fishing.rarityCommon",
  rare: "theWorld.fishing.rarityRare",
  legendary: "theWorld.fishing.rarityLegendary",
};

const REWARD_MILESTONES: readonly {
  readonly kind: WorldUnlockableCosmeticKind;
  readonly threshold: number;
  readonly labelKey: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  {
    kind: "flower_crown",
    threshold: COSMETIC_UNLOCK_THRESHOLDS.flower_crown,
    labelKey: "theWorld.stamps.rewardFlowerCrown",
    icon: "sakura",
    tone: "rose",
  },
  {
    kind: "aurora",
    threshold: COSMETIC_UNLOCK_THRESHOLDS.aurora,
    labelKey: "theWorld.stamps.rewardAuroraCape",
    icon: "cape",
    tone: "cerulean",
  },
  {
    kind: "rainbow",
    threshold: COSMETIC_UNLOCK_THRESHOLDS.rainbow,
    labelKey: "theWorld.stamps.rewardRainbowTrail",
    icon: "rainbow",
    tone: "teal",
  },
];

/**
 * 「별빛 항해 수첩」 2탭 모달 (`항해 스탬프` | `초원 어류 도감`).
 *
 * - 탭 1: 스탬프 진행도 바(`N / 8`) · 3단계 외형 보상 로드맵 · 2×4 스탬프 그리드
 * - 탭 2: 초원 어류 도감 진행도 바(`M / 8`) · 2×4 어류 카드(희귀도 배지 · 마리 수 · 미발견 실루엣)
 */
export const WorldStampBook = memo(function WorldStampBook({
  open,
  unlockedStamps,
  caughtFishCounts = {},
  initialTab = "stamps",
  locale,
  onOpenCustomizer,
  onClose,
}: WorldStampBookProps) {
  const t = getWorldT(locale);
  const [activeTab, setActiveTab] = useState<WorldStampBookTab>(initialTab);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  const unlockedSet = new Set<WorldStampId>(unlockedStamps);
  const totalStamps = WORLD_STAMP_IDS.length;
  const collectedStamps = unlockedSet.size;
  const stampProgressPct = totalStamps > 0 ? Math.min(100, Math.round((collectedStamps / totalStamps) * 100)) : 0;

  const totalFish = WORLD_FISH_IDS.length;
  let discoveredFish = 0;
  for (const fishId of WORLD_FISH_IDS) {
    if ((caughtFishCounts[fishId] ?? 0) > 0) discoveredFish += 1;
  }
  const fishProgressPct = totalFish > 0 ? Math.min(100, Math.round((discoveredFish / totalFish) * 100)) : 0;

  return (
    <div
      className="the-world-panel-backdrop"
      role="presentation"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="the-world-panel the-world-stamp-book"
        role="dialog"
        aria-modal="true"
        aria-label={t("theWorld.stamps.aria")}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <span className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name={activeTab === "fish" ? "sparkle" : "trophy"} size={18} tone="amber" />
            </span>
            <div>
              <h2 className="the-world-dialogue-name">{t("theWorld.stamps.title")}</h2>
              <p className="the-world-dialogue-role">{t("theWorld.stamps.subtitle")}</p>
            </div>
          </div>

          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.stamps.closeAria")}
            onClick={onClose}
          >
            <WorldIcon name="close" size={15} />
          </button>
        </header>

        {/* 상단 세그먼트 탭: 항해 스탬프 | 초원 어류 도감 */}
        <div className="the-world-stamp-tabs" role="tablist" aria-label={t("theWorld.fishing.tabsAria")}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "stamps"}
            className={`the-world-stamp-tab${activeTab === "stamps" ? " is-active" : ""}`}
            onClick={() => {
              playDistrictHover();
              setActiveTab("stamps");
            }}
          >
            <WorldIcon name="trophy" size={13} tone={activeTab === "stamps" ? "amber" : "cerulean"} />
            <span>{t("theWorld.fishing.tabStamps", { count: collectedStamps, total: totalStamps })}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "fish"}
            className={`the-world-stamp-tab${activeTab === "fish" ? " is-active" : ""}`}
            onClick={() => {
              playDistrictHover();
              setActiveTab("fish");
            }}
          >
            <WorldIcon name="sparkle" size={13} tone={activeTab === "fish" ? "amber" : "teal"} />
            <span>{t("theWorld.fishing.tabFish", { count: discoveredFish, total: totalFish })}</span>
          </button>
        </div>

        {activeTab === "stamps" ? (
          <div className="the-world-panel-body the-world-stamp-body">
            {/* 상단 진행도 바 */}
            <div className="the-world-stamp-progress">
              <div className="the-world-stamp-progress-head">
                <span className="the-world-stamp-progress-label">
                  <WorldIcon name="sparkle" size={13} tone="amber" />
                  <span>{t("theWorld.stamps.progressLabel", { count: collectedStamps, total: totalStamps })}</span>
                </span>
                <span className="the-world-stamp-progress-pct">{stampProgressPct}%</span>
              </div>
              <div className="the-world-stamp-progress-track" aria-hidden="true">
                <div
                  className="the-world-stamp-progress-fill"
                  style={{ width: `${stampProgressPct}%` }}
                />
              </div>
            </div>

            {/* 3단계 해금 보상 로드맵 */}
            <section className="the-world-stamp-rewards" aria-label={t("theWorld.stamps.rewardsHeading")}>
              <div className="the-world-stamp-rewards-head">
                <h3 className="the-world-qb-section-title">{t("theWorld.stamps.rewardsHeading")}</h3>
                {onOpenCustomizer ? (
                  <button
                    type="button"
                    className="the-world-stamp-customizer-btn"
                    onClick={() => {
                      playDistrictSelect();
                      onClose();
                      onOpenCustomizer();
                    }}
                  >
                    <WorldIcon name="hat" size={13} tone="amber" />
                    <span>{t("theWorld.stamps.openCustomizer")}</span>
                  </button>
                ) : null}
              </div>

              <div className="the-world-stamp-rewards-grid">
                {REWARD_MILESTONES.map((reward) => {
                  const unlocked = collectedStamps >= reward.threshold;
                  return (
                    <div
                      key={reward.kind}
                      className={`the-world-stamp-reward-card${unlocked ? " is-unlocked" : " is-locked"}`}
                    >
                      <span className="the-world-stamp-reward-icon" aria-hidden="true">
                        <WorldIcon name={reward.icon} size={16} tone={unlocked ? "amber" : reward.tone} />
                      </span>
                      <div className="the-world-stamp-reward-copy">
                        <span className="the-world-stamp-reward-name">{t(reward.labelKey)}</span>
                        <span className="the-world-stamp-reward-req">
                          {unlocked
                            ? t("theWorld.stamps.unlockedBadge")
                            : t("theWorld.stamps.unlockReq", { count: reward.threshold })}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 2×4 항해 스탬프 그리드 */}
            <div className="the-world-stamp-grid">
              {WORLD_STAMP_IDS.map((stampId) => {
                const meta = STAMP_META[stampId];
                const unlocked = unlockedSet.has(stampId);
                return (
                  <article
                    key={stampId}
                    className={`the-world-stamp-card${unlocked ? " is-unlocked" : " is-locked"}`}
                  >
                    <div className="the-world-stamp-card-top">
                      <span className="the-world-stamp-seal" aria-hidden="true">
                        <WorldIcon name={meta.icon} size={18} tone={unlocked ? "amber" : meta.tone} />
                      </span>
                      <span className={`the-world-stamp-card-badge${unlocked ? " is-unlocked" : ""}`}>
                        {unlocked ? t("theWorld.stamps.unlockedBadge") : t("theWorld.stamps.lockedBadge")}
                      </span>
                    </div>
                    <h4 className="the-world-stamp-card-title">{t(meta.titleKey)}</h4>
                    <p className="the-world-stamp-card-desc">{t(meta.descKey)}</p>
                  </article>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="the-world-panel-body the-world-stamp-body">
            {/* 어류 도감 진행도 바 */}
            <div className="the-world-stamp-progress">
              <div className="the-world-stamp-progress-head">
                <span className="the-world-stamp-progress-label">
                  <WorldIcon name="sparkle" size={13} tone="teal" />
                  <span>{t("theWorld.fishing.progressLabel", { count: discoveredFish, total: totalFish })}</span>
                </span>
                <span className="the-world-stamp-progress-pct">{fishProgressPct}%</span>
              </div>
              <div className="the-world-stamp-progress-track" aria-hidden="true">
                <div
                  className="the-world-stamp-progress-fill"
                  style={{ width: `${fishProgressPct}%` }}
                />
              </div>
            </div>

            {/* 2×4 초원 어류 도감 그리드 */}
            <div className="the-world-fish-grid">
              {WORLD_FISH_IDS.map((fishId) => {
                const meta = FISH_META[fishId];
                const count = caughtFishCounts[fishId] ?? 0;
                const caught = count > 0;
                return (
                  <article
                    key={fishId}
                    className={`the-world-fish-card is-${meta.rarity}${caught ? " is-caught" : " is-locked"}`}
                  >
                    <div className="the-world-fish-card-top">
                      <span className="the-world-fish-seal" aria-hidden="true">
                        <WorldIcon name={meta.icon} size={18} tone={caught ? meta.tone : "inherit"} />
                      </span>
                      <div className="the-world-fish-badges">
                        <span className={`the-world-fish-rarity is-${meta.rarity}`}>
                          {t(RARITY_LABEL_KEY[meta.rarity])}
                        </span>
                        {caught ? (
                          <span className="the-world-fish-count">
                            {t("theWorld.fishing.caughtCount", { count })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <h4 className="the-world-fish-card-title">
                      {caught ? t(meta.titleKey) : "???"}
                    </h4>
                    <p className="the-world-fish-card-desc">
                      {caught ? t(meta.descKey) : t("theWorld.fishing.lockedHint")}
                    </p>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
});
