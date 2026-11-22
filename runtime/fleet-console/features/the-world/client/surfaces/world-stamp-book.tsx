import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect } from "react";

import { playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  COSMETIC_UNLOCK_THRESHOLDS,
  WORLD_STAMP_IDS,
  type WorldStampId,
  type WorldUnlockableCosmeticKind,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export interface WorldStampBookProps {
  readonly open: boolean;
  readonly unlockedStamps: readonly WorldStampId[];
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
 * 「별빛 항해 수첩」 스탬프 수집 & 외형 보상 모달.
 *
 * - 상단 진행도 바(`N / 8 스탬프 수집`) + 3단계 외형 보상 로드맵(`들꽃 화관` · `오로라 망토` · `무지개 별똥별 꼬리`)
 * - 2×4 스탬프 그리드: 해금된 스탬프는 황금 글로우 배지, 미해금은 프로스트 실루엣 + 획득 힌트 표시
 */
export const WorldStampBook = memo(function WorldStampBook({
  open,
  unlockedStamps,
  locale,
  onOpenCustomizer,
  onClose,
}: WorldStampBookProps) {
  const t = getWorldT(locale);

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
  const totalCount = WORLD_STAMP_IDS.length;
  const collectedCount = unlockedSet.size;
  const progressPct = totalCount > 0 ? Math.min(100, Math.round((collectedCount / totalCount) * 100)) : 0;

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
              <WorldIcon name="trophy" size={18} tone="amber" />
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

        <div className="the-world-panel-body the-world-stamp-body">
          {/* 상단 진행도 바 */}
          <div className="the-world-stamp-progress">
            <div className="the-world-stamp-progress-head">
              <span className="the-world-stamp-progress-label">
                <WorldIcon name="sparkle" size={13} tone="amber" />
                <span>{t("theWorld.stamps.progressLabel", { count: collectedCount, total: totalCount })}</span>
              </span>
              <span className="the-world-stamp-progress-pct">{progressPct}%</span>
            </div>
            <div className="the-world-stamp-progress-track" aria-hidden="true">
              <div
                className="the-world-stamp-progress-fill"
                style={{ width: `${progressPct}%` }}
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
                const unlocked = collectedCount >= reward.threshold;
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
      </section>
    </div>
  );
});
