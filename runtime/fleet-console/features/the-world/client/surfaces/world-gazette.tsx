import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useMemo } from "react";

import type {
  WorldActorSpec,
  WorldQuestBoardData,
  WorldSnapshot,
  WorldTimeMode,
  WorldVillageSpec,
  WorldWeatherMode,
} from "../../shared/world-types.js";
import { playDistrictHover, playDistrictSelect } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  openActorDialogue,
  requestWorldTeleport,
  useWorldStore,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export interface WorldGazetteProps {
  readonly open?: boolean | undefined;
  readonly snapshot: WorldSnapshot;
  readonly questData?: WorldQuestBoardData | undefined;
  readonly weatherMode?: WorldWeatherMode | undefined;
  readonly timeMode?: WorldTimeMode | undefined;
  readonly locale: ConsoleLocale | undefined;
  readonly onWarpToVillage?: ((village: WorldVillageSpec) => void) | undefined;
  readonly onTalkToCommodore?: ((actorId: string) => void) | undefined;
  readonly onClose: () => void;
}

const WEATHER_META: Readonly<Record<WorldWeatherMode, { readonly key: TheWorldMessageKey; readonly icon: WorldIconName; readonly tone: WorldIconTone }>> = {
  clear: { key: "theWorld.weather.clear", icon: "sun", tone: "amber" },
  sakura: { key: "theWorld.weather.sakura", icon: "sakura", tone: "rose" },
  rain: { key: "theWorld.weather.rain", icon: "rain", tone: "cerulean" },
  snow: { key: "theWorld.weather.snow", icon: "snow", tone: "teal" },
};

const TIME_META: Readonly<Record<WorldTimeMode, { readonly key: TheWorldMessageKey; readonly icon: WorldIconName; readonly tone: WorldIconTone }>> = {
  cycle: { key: "theWorld.hud.timeCycle", icon: "cycle", tone: "teal" },
  day: { key: "theWorld.hud.timeDay", icon: "sun", tone: "amber" },
  sunset: { key: "theWorld.hud.timeSunset", icon: "sunset", tone: "rose" },
  night: { key: "theWorld.hud.timeNight", icon: "moon", tone: "indigo" },
  realtime: { key: "theWorld.hud.timeRealtime", icon: "clock", tone: "cerulean" },
};

function stripSpeechTag(text: string): string {
  return text.replace(/^\[[a-z_-]+\]\s*/i, "").trim();
}

function formatGazetteDate(locale: ConsoleLocale | undefined): string {
  const tag = locale === "en" ? "en-US" : "ko-KR";
  try {
    return new Intl.DateTimeFormat(tag, {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function resolveDigestLine(
  actor: WorldActorSpec,
  t: ReturnType<typeof getWorldT>,
): string {
  const firstSummary = actor.summaryLines.find((line) => line.trim().length > 0);
  if (firstSummary) return firstSummary.trim();
  if (actor.initialSpeech) {
    const cleaned = stripSpeechTag(actor.initialSpeech);
    if (cleaned) return cleaned;
  }
  if (actor.needsAttention) return t("theWorld.gazette.digestAttentionLine");
  if (actor.state === "running") return t("theWorld.gazette.digestWorkingLine");
  return t("theWorld.gazette.digestIdleLine");
}

/**
 * 「오늘의 초원 일보 (Fleet Daily Gazette)」 프로스트 글래스 신문형 브리핑 모달.
 *
 * - 오늘 날짜 · 현재 날씨/시간대 무드 배지 · 4개 핵심 KPI(완료 작전 · 활성 마을 · 총 파일/폴더 · 최고 성장 MVP)
 * - 최근 완료 보고 목록 및 사령관별 한 줄 현황 다이제스트(클릭 시 즉시 워프 또는 대화 오픈)
 * - 보안 불변식: 원시 파일시스템 `path`는 절대 노출하지 않는다.
 */
export const WorldGazette = memo(function WorldGazette({
  open = true,
  snapshot,
  questData,
  weatherMode: weatherModeProp,
  timeMode: timeModeProp,
  locale,
  onWarpToVillage,
  onTalkToCommodore,
  onClose,
}: WorldGazetteProps) {
  const store = useWorldStore();
  const t = getWorldT(locale);
  const activeWeather = weatherModeProp ?? store.weatherMode;
  const activeTime = timeModeProp ?? store.timeMode;
  const weatherMeta = WEATHER_META[activeWeather];
  const timeMeta = TIME_META[activeTime];

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

  const dateLabel = useMemo(() => formatGazetteDate(locale), [locale]);

  const metrics = useMemo(() => {
    const villages = snapshot.villages;
    const totalEntries = villages.reduce((sum, v) => sum + v.totalEntries, 0);
    const villageCompleted = villages.reduce((sum, v) => sum + v.completedObjectiveCount, 0);
    const completedOps = Math.max(questData?.completedMissions.length ?? 0, villageCompleted);
    let mvp: WorldVillageSpec | null = null;
    for (const v of villages) {
      if (!mvp) {
        mvp = v;
        continue;
      }
      if (
        v.overallTier > mvp.overallTier
        || (v.overallTier === mvp.overallTier && v.totalEntries > mvp.totalEntries)
        || (v.overallTier === mvp.overallTier && v.totalEntries === mvp.totalEntries && v.completedObjectiveCount > mvp.completedObjectiveCount)
      ) {
        mvp = v;
      }
    }
    return {
      completedOps,
      villageCount: villages.length,
      totalEntries,
      mvp,
    };
  }, [questData?.completedMissions.length, snapshot.villages]);

  const commodores = useMemo(
    () => snapshot.actors.filter((actor) => actor.role === "commodore"),
    [snapshot.actors],
  );

  const villageByCommodore = useMemo(() => {
    const map = new Map<string, WorldVillageSpec>();
    for (const v of snapshot.villages) {
      map.set(v.commodoreId, v);
    }
    return map;
  }, [snapshot.villages]);

  const completedReports = useMemo(
    () => (questData?.completedMissions ?? []).slice(0, 6),
    [questData?.completedMissions],
  );

  if (!open) return null;

  const handleWarpVillage = (village: WorldVillageSpec) => {
    playDistrictSelect();
    onClose();
    if (onWarpToVillage) {
      onWarpToVillage(village);
    } else {
      requestWorldTeleport(village.x, village.z);
    }
  };

  const handleTalkActor = (actorId: string) => {
    playDistrictSelect();
    onClose();
    if (onTalkToCommodore) {
      onTalkToCommodore(actorId);
    } else {
      openActorDialogue(actorId);
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
        className="the-world-panel the-world-gazette-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("theWorld.gazette.aria")}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="the-world-crest" aria-hidden="true" />

        <header className="the-world-panel-head the-world-gazette-head">
          <div className="the-world-dialogue-speaker">
            <span className="the-world-qb-emblem" aria-hidden="true">
              <WorldIcon name="gazette" size={18} tone="amber" />
            </span>
            <div>
              <div className="the-world-gazette-masthead-row">
                <h2 className="the-world-dialogue-name">{t("theWorld.gazette.title")}</h2>
                <span className="the-world-gazette-date-pill">{dateLabel}</span>
              </div>
              <p className="the-world-dialogue-role">{t("theWorld.gazette.subtitle")}</p>
            </div>
          </div>

          <div className="the-world-gazette-head-right">
            <span className="the-world-gazette-mood-pill">
              <WorldIcon name={weatherMeta.icon} size={12} tone={weatherMeta.tone} />
              <span>{t(weatherMeta.key)}</span>
            </span>
            <span className="the-world-gazette-mood-pill">
              <WorldIcon name={timeMeta.icon} size={12} tone={timeMeta.tone} />
              <span>{t(timeMeta.key)}</span>
            </span>
            <button
              type="button"
              className="the-world-chat-icon-btn"
              aria-label={t("theWorld.gazette.closeAria")}
              onClick={onClose}
            >
              <WorldIcon name="close" size={15} />
            </button>
          </div>
        </header>

        <div className="the-world-panel-body the-world-gazette-body">
          {/* 상단 4 KPI 스트립 */}
          <div className="the-world-gazette-kpis">
            <div className="the-world-gazette-kpi">
              <span className="the-world-gazette-kpi-label">
                <WorldIcon name="trophy" size={12} tone="amber" />
                <span>{t("theWorld.gazette.kpiCompleted")}</span>
              </span>
              <strong className="the-world-gazette-kpi-value">{metrics.completedOps}</strong>
            </div>

            <div className="the-world-gazette-kpi">
              <span className="the-world-gazette-kpi-label">
                <WorldIcon name="warRoom" size={12} tone="teal" />
                <span>{t("theWorld.gazette.kpiVillages")}</span>
              </span>
              <strong className="the-world-gazette-kpi-value">{metrics.villageCount}</strong>
            </div>

            <div className="the-world-gazette-kpi">
              <span className="the-world-gazette-kpi-label">
                <WorldIcon name="scroll" size={12} tone="cerulean" />
                <span>{t("theWorld.gazette.kpiEntries")}</span>
              </span>
              <strong className="the-world-gazette-kpi-value">{metrics.totalEntries.toLocaleString()}</strong>
            </div>

            {metrics.mvp ? (
              <button
                type="button"
                className="the-world-gazette-kpi is-mvp"
                data-tone={metrics.mvp.tone}
                aria-label={t("theWorld.gazette.mvpWarpAria", { name: metrics.mvp.label })}
                onMouseEnter={() => playDistrictHover()}
                onClick={() => handleWarpVillage(metrics.mvp!)}
              >
                <span className="the-world-gazette-kpi-label">
                  <WorldIcon name="crown" size={12} tone="amber" />
                  <span>{t("theWorld.gazette.kpiMvp")}</span>
                </span>
                <strong className="the-world-gazette-kpi-mvp-name">
                  <span>{metrics.mvp.label}</span>
                  <span className="the-world-gazette-tier-chip">T{metrics.mvp.overallTier}</span>
                </strong>
                <span className="the-world-gazette-kpi-hint">
                  <WorldIcon name="compass" size={11} tone="amber" />
                  <span>{t("theWorld.gazette.kpiMvpWarpHint")}</span>
                </span>
              </button>
            ) : (
              <div className="the-world-gazette-kpi">
                <span className="the-world-gazette-kpi-label">
                  <WorldIcon name="crown" size={12} tone="amber" />
                  <span>{t("theWorld.gazette.kpiMvp")}</span>
                </span>
                <span className="the-world-gazette-kpi-empty">{t("theWorld.gazette.kpiMvpEmpty")}</span>
              </div>
            )}
          </div>

          {/* 2컬럼 기사 본문: 최근 완료 보고 + 사령관별 한 줄 현황 */}
          <div className="the-world-gazette-columns">
            <section className="the-world-gazette-col">
              <div className="the-world-gazette-section-head">
                <WorldIcon name="confetti" size={13} tone="amber" />
                <h3 className="the-world-qb-section-title">{t("theWorld.gazette.completedHeading")}</h3>
                <span className="the-world-district-objectives-count">{completedReports.length}</span>
              </div>

              {completedReports.length === 0 ? (
                <div className="the-world-gazette-empty">
                  <WorldIcon name="sparkle" size={15} tone="amber" />
                  <span>{t("theWorld.gazette.completedEmpty")}</span>
                </div>
              ) : (
                <div className="the-world-gazette-list">
                  {completedReports.map((mission) => (
                    <button
                      key={mission.id}
                      type="button"
                      className="the-world-gazette-row"
                      data-tone={mission.commodoreTone}
                      disabled={!mission.commodoreActorId}
                      onMouseEnter={() => playDistrictHover()}
                      onClick={() => {
                        if (mission.commodoreActorId) {
                          handleTalkActor(mission.commodoreActorId);
                        }
                      }}
                    >
                      <span className="the-world-gazette-tone-dot" data-tone={mission.commodoreTone} aria-hidden="true" />
                      <div className="the-world-gazette-row-copy">
                        <span className="the-world-gazette-row-title">{mission.title}</span>
                        <span className="the-world-gazette-row-meta">{mission.commodoreName}</span>
                      </div>
                      <WorldIcon name="trophy" size={13} tone="amber" />
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="the-world-gazette-col">
              <div className="the-world-gazette-section-head">
                <WorldIcon name="commodore" size={13} tone="cerulean" />
                <h3 className="the-world-qb-section-title">{t("theWorld.gazette.digestHeading")}</h3>
                <span className="the-world-district-objectives-count">{commodores.length}</span>
              </div>

              {commodores.length === 0 ? (
                <div className="the-world-gazette-empty">
                  <WorldIcon name="commodore" size={15} tone="cerulean" />
                  <span>{t("theWorld.gazette.digestEmpty")}</span>
                </div>
              ) : (
                <div className="the-world-gazette-list">
                  {commodores.map((actor) => {
                    const village = actor.commodoreId ? villageByCommodore.get(actor.commodoreId) : undefined;
                    const digestLine = resolveDigestLine(actor, t);
                    const statusClass = actor.needsAttention
                      ? " is-attention"
                      : actor.state === "running"
                        ? " is-working"
                        : "";
                    return (
                      <button
                        key={actor.id}
                        type="button"
                        className={`the-world-gazette-row${statusClass}`}
                        data-tone={actor.tone}
                        aria-label={t("theWorld.gazette.digestTalkAria", { name: actor.name })}
                        onMouseEnter={() => playDistrictHover()}
                        onClick={() => handleTalkActor(actor.id)}
                      >
                        <span className="the-world-gazette-tone-dot" data-tone={actor.tone} aria-hidden="true" />
                        <div className="the-world-gazette-row-copy">
                          <div className="the-world-gazette-row-top">
                            <span className="the-world-gazette-row-title">{actor.name}</span>
                            {village ? (
                              <span className="the-world-gazette-row-chips">
                                {village.activeObjectiveCount > 0 ? (
                                  <span className="the-world-gazette-mini-chip">
                                    {t("theWorld.gazette.activeCount", { count: village.activeObjectiveCount })}
                                  </span>
                                ) : null}
                                {village.completedObjectiveCount > 0 ? (
                                  <span className="the-world-gazette-mini-chip is-done">
                                    {t("theWorld.gazette.doneCount", { count: village.completedObjectiveCount })}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                          <span className="the-world-gazette-row-meta">{digestLine}</span>
                        </div>
                        <span className="the-world-gazette-talk-pill">
                          <WorldIcon name="chat" size={11} tone={actor.needsAttention ? "amber" : "cerulean"} />
                          <span>{t("theWorld.gazette.digestTalk")}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
});
