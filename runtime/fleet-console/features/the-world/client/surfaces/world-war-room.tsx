import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useMemo, useState, type FormEvent } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type { WorldSnapshot, WorldVillageSpec } from "../../shared/world-types.js";
import { playDistrictHover, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT } from "../i18n/index.js";
import { WorldIcon } from "./world-icons.js";

export interface WorldWarRoomProps {
  readonly snapshot: WorldSnapshot;
  readonly locale: ConsoleLocale | undefined;
  readonly onClose: () => void;
  readonly onRallyAll: () => void;
  readonly onVisitVillage: (village: WorldVillageSpec) => void;
  readonly onBroadcastAll: (message: string) => Promise<number> | number | void;
}

interface RankedVillage {
  readonly village: WorldVillageSpec;
  readonly totalEntries: number;
}

/**
 * 다크 크리스탈 「함대 통합 상황실」 모달.
 *
 * 전 사령관 마을 발전도 KPI · 랭킹 워프 · 전 사령관 중앙 광장 긴급 소집 ·
 * `@all` 전체 사령관 공지 브로드캐스트를 한곳에서 제어한다.
 *
 * 보안 불변식: 원시 파일시스템 절대경로(`path`)는 절대 노출하지 않는다.
 */
export const WorldWarRoom = memo(function WorldWarRoom({
  snapshot,
  locale,
  onClose,
  onRallyAll,
  onVisitVillage,
  onBroadcastAll,
}: WorldWarRoomProps) {
  const t = getWorldT(locale);
  const [broadcastDraft, setBroadcastDraft] = useState("");
  const [sending, setSending] = useState(false);

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

  const actorByCommodoreId = useMemo(() => {
    const map = new Map<string, (typeof snapshot.actors)[number]>();
    for (const actor of snapshot.actors) {
      if (actor.role === "commodore" && actor.commodoreId) {
        map.set(actor.commodoreId, actor);
      }
    }
    return map;
  }, [snapshot.actors]);

  const { rankedVillages, totalDistricts, totalEntries, topTier } = useMemo(() => {
    let districts = 0;
    let entries = 0;
    let maxTier = 0;
    const ranked: RankedVillage[] = snapshot.villages.map((village) => {
      let villageEntries = 0;
      for (const d of village.districts) {
        villageEntries += d.totalEntries;
        if (d.tier > maxTier) maxTier = d.tier;
      }
      if (village.overallTier > maxTier) maxTier = village.overallTier;
      districts += village.districts.length;
      entries += villageEntries;
      return { village, totalEntries: villageEntries };
    });
    ranked.sort((a, b) => {
      if (b.village.overallTier !== a.village.overallTier) {
        return b.village.overallTier - a.village.overallTier;
      }
      if (b.totalEntries !== a.totalEntries) {
        return b.totalEntries - a.totalEntries;
      }
      return b.village.districts.length - a.village.districts.length;
    });
    return {
      rankedVillages: ranked,
      totalDistricts: districts,
      totalEntries: entries,
      topTier: maxTier,
    };
  }, [snapshot.villages]);

  const handleSubmitBroadcast = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = broadcastDraft.trim();
    if (!trimmed || sending || snapshot.villages.length === 0) return;
    setSending(true);
    try {
      await onBroadcastAll(trimmed);
      setBroadcastDraft("");
    } finally {
      setSending(false);
    }
  };

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
        className="the-world-panel the-world-war-room"
        role="dialog"
        aria-modal="true"
        aria-label={t("theWorld.warRoom.aria")}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head">
          <div className="the-world-dialogue-speaker">
            <span className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name="warRoom" size={18} tone="amber" />
            </span>
            <div>
              <h2 className="the-world-dialogue-name">{t("theWorld.warRoom.title")}</h2>
              <p className="the-world-dialogue-role">{t("theWorld.warRoom.subtitle")}</p>
            </div>
          </div>

          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.warRoom.closeAria")}
            onClick={onClose}
          >
            <WorldIcon name="close" size={15} />
          </button>
        </header>

        <div className="the-world-panel-body the-world-wr-body">
          {/* 상단 KPI 4종 요약 */}
          <div className="the-world-wr-kpis">
            <div className="the-world-wr-kpi">
              <span className="the-world-wr-kpi-label">{t("theWorld.warRoom.kpiVillages")}</span>
              <span className="the-world-wr-kpi-val">{snapshot.villages.length}</span>
            </div>
            <div className="the-world-wr-kpi">
              <span className="the-world-wr-kpi-label">{t("theWorld.warRoom.kpiDistricts")}</span>
              <span className="the-world-wr-kpi-val">{totalDistricts}</span>
            </div>
            <div className="the-world-wr-kpi">
              <span className="the-world-wr-kpi-label">{t("theWorld.warRoom.kpiEntries")}</span>
              <span className="the-world-wr-kpi-val">{totalEntries.toLocaleString()}</span>
            </div>
            <div className="the-world-wr-kpi is-emphasis">
              <span className="the-world-wr-kpi-label">{t("theWorld.warRoom.kpiTopTier")}</span>
              <span className="the-world-wr-kpi-val">{t("theWorld.tier.badge", { tier: topTier })}</span>
            </div>
          </div>

          {/* 전 사령관 긴급 소집 버튼 */}
          <button
            type="button"
            className="the-world-wr-rally-btn"
            aria-label={t("theWorld.warRoom.rallyAria")}
            disabled={snapshot.villages.length === 0}
            onClick={() => {
              onRallyAll();
            }}
          >
            <WorldIcon name="rally" size={16} tone="amber" />
            <span>{t("theWorld.warRoom.rallyBtn")}</span>
          </button>

          {/* 마을 발전도 랭킹 리스트 (클릭 시 즉시 워프) */}
          <section className="the-world-qb-section">
            <h3 className="the-world-qb-section-title">
              <WorldIcon name="trophy" size={13} tone="amber" />
              <span>{t("theWorld.warRoom.rankingHeading")}</span>
            </h3>
            {rankedVillages.length === 0 ? (
              <div className="the-world-qb-empty">
                <WorldIcon name="warRoom" size={20} tone="cerulean" />
                <span>{t("theWorld.warRoom.broadcastEmpty")}</span>
              </div>
            ) : (
              <div className="the-world-wr-ranking">
                {rankedVillages.map(({ village, totalEntries: vEntries }, idx) => {
                  const actor = actorByCommodoreId.get(village.commodoreId) ?? null;
                  return (
                    <button
                      key={village.id}
                      type="button"
                      className="the-world-wr-rank-row"
                      data-tone={village.tone}
                      aria-label={t("theWorld.warRoom.visitAria", { name: village.label })}
                      onMouseEnter={() => playDistrictHover()}
                      onClick={() => {
                        playDistrictSelect();
                        onVisitVillage(village);
                        onClose();
                      }}
                    >
                      <span className={`the-world-wr-rank-num${idx === 0 ? " is-first" : ""}`}>
                        #{idx + 1}
                      </span>
                      {actor ? (
                        <MongleAvatar
                          base={actor.baseId}
                          tone={actor.tone}
                          role={actor.role}
                          state={actor.state}
                          activity={actor.activity}
                          size={26}
                          label={actor.name}
                          decorative
                        />
                      ) : (
                        <span className="the-world-tone-dot" data-tone={village.tone} />
                      )}
                      <div className="the-world-wr-rank-main">
                        <span className="the-world-wr-rank-name">{village.label}</span>
                        <span className="the-world-wr-rank-meta">
                          {t("theWorld.village.signSubtitle", {
                            tier: village.overallTier,
                            count: village.districts.length,
                          })}
                          {vEntries > 0 ? ` · ${vEntries.toLocaleString()}` : ""}
                        </span>
                      </div>
                      <span className="the-world-district-tier-pill" data-tone={village.tone}>
                        {t("theWorld.tier.badge", { tier: village.overallTier })}
                      </span>
                      <WorldIcon name="compass" size={13} tone="cerulean" />
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* @all 전체 사령관 공지 브로드캐스트 폼 */}
          <section className="the-world-qb-section">
            <h3 className="the-world-qb-section-title">
              <WorldIcon name="mail" size={13} tone="cerulean" />
              <span>{t("theWorld.warRoom.broadcastHeading")}</span>
            </h3>
            <form className="the-world-wr-broadcast" onSubmit={handleSubmitBroadcast}>
              <input
                type="text"
                className="the-world-wr-broadcast-input"
                value={broadcastDraft}
                onChange={(e) => setBroadcastDraft(e.target.value)}
                placeholder={t("theWorld.warRoom.broadcastPlaceholder")}
                aria-label={t("theWorld.warRoom.broadcastHeading")}
                maxLength={280}
                disabled={sending || snapshot.villages.length === 0}
              />
              <button
                type="submit"
                className="the-world-primary-action"
                disabled={sending || !broadcastDraft.trim() || snapshot.villages.length === 0}
              >
                <WorldIcon name="rally" size={13} tone="amber" />
                <span>{t("theWorld.warRoom.broadcastSend")}</span>
              </button>
            </form>
          </section>
        </div>
      </section>
    </div>
  );
});
