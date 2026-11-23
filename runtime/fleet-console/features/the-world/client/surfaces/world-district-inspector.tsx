import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useState, type FormEvent } from "react";

import { MongleAvatar } from "../../../workspace/client/components/mongle-avatar.js";
import type {
  WorldActorSpec,
  WorldDevelopmentTier,
  WorldDistrictSpec,
  WorldTheaterStatus,
  WorldVillageBiome,
  WorldVillageSpec,
} from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { playDistrictHover, playDistrictSelect, playFlagPlant } from "../engine/world-audio.js";
import { getWorldT, type TheWorldMessageKey } from "../i18n/index.js";
import {
  clearDispatchFlag,
  exitTheWorld,
  placeDispatchFlag,
  setDistrictNote,
  setOperationFlag,
  setVillageBiome,
  useOperationFlag,
  type WorldOperationFlag,
  type WorldOperationFlagDeployInput,
} from "../world-store.js";
import { WorldIcon, type WorldIconName, type WorldIconTone } from "./world-icons.js";

export type { WorldOperationFlagDeployInput };

export interface WorldDistrictLinkedObjective {
  readonly id: string;
  readonly title: string;
  readonly status?: string | undefined;
}

export interface WorldDistrictInspectorProps {
  readonly district: WorldDistrictSpec;
  readonly village: WorldVillageSpec | null;
  readonly commodoreActor: WorldActorSpec | null;
  readonly linkedObjectives: readonly WorldDistrictLinkedObjective[];
  readonly locale: ConsoleLocale | undefined;
  readonly refreshing?: boolean | undefined;
  readonly hasDispatchFlag?: boolean | undefined;
  readonly districtNote?: string | undefined;
  readonly onClose: () => void;
  readonly onRefreshMetrics: () => void;
  readonly onMentionCommodore: (actorId: string) => void;
  readonly onTeleportToDistrict: (x: number, z: number, label: string) => void;
  readonly onOpenDialogue: (actorId: string) => void;
  readonly onFocusCommodore: (actorId: string) => void;
  readonly onOpenObjective: (commodoreActorId: string, objectiveId: string) => void;
  readonly onPlantDispatchFlag?: ((district: WorldDistrictSpec) => void) | undefined;
  readonly onClearDispatchFlag?: ((districtId: string) => void) | undefined;
  readonly onSelectVillageBiome?: ((commodoreId: string, biome: WorldVillageBiome) => void) | undefined;
  readonly onChangeNote?: ((districtId: string, note: string) => void) | undefined;
  readonly operationFlag?: WorldOperationFlag | null | undefined;
  readonly onDeployOperationFlag?: ((input: WorldOperationFlagDeployInput) => void) | undefined;
  readonly onClearOperationFlag?: (() => void) | undefined;
  readonly onOpenInConsole?: ((commodoreId: string, objectiveId?: string | null) => void) | undefined;
  readonly deps?: Pick<TheWorldClientDeps, "openCommodoreInConsole" | "openObjectiveInConsole" | "isReducedMotion"> | undefined;
}

const VILLAGE_BIOMES: readonly {
  readonly id: WorldVillageBiome;
  readonly key: TheWorldMessageKey;
  readonly icon: WorldIconName;
  readonly tone: WorldIconTone;
}[] = [
  { id: "meadow", key: "theWorld.biome.meadow", icon: "leaf", tone: "moss" },
  { id: "sakura", key: "theWorld.biome.sakura", icon: "sakura", tone: "rose" },
  { id: "citadel", key: "theWorld.biome.citadel", icon: "crown", tone: "cerulean" },
  { id: "autumn", key: "theWorld.biome.autumn", icon: "fire", tone: "amber" },
];

const TIER_NAME_KEYS: Readonly<Record<WorldDevelopmentTier, TheWorldMessageKey>> = {
  0: "theWorld.tier.0.name",
  1: "theWorld.tier.1.name",
  2: "theWorld.tier.2.name",
  3: "theWorld.tier.3.name",
  4: "theWorld.tier.4.name",
  5: "theWorld.tier.5.name",
};

const STATUS_KEYS: Readonly<Record<WorldTheaterStatus, TheWorldMessageKey>> = {
  available: "theWorld.district.statusAvailable",
  missing: "theWorld.district.statusMissing",
  unreadable: "theWorld.district.statusUnreadable",
};

const TIER_STEPS: readonly WorldDevelopmentTier[] = [1, 2, 3, 4, 5];

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * 다크 크리스탈 스타일 「구역 정보 카드 (District Inspector)」.
 *
 * - 상단 핵심 정보 우선 배치: 규모(파일/폴더/Tier) · 연결된 목표 · 제독 메모 · 작전 깃발.
 * - 장식용 마을 테마 바이옴은 하단 접이식 섹션으로 정리.
 * - 하단 풋터는 2열 2버튼(`지시하기`, `콘솔에서 열기`)으로 깔끔히 통일.
 * - 보안 불변식: 원시 파일시스템 절대경로(`path`)는 절대 표시하지 않고
 *   `label` · `status` · 짧은 `theaterId` 뱃지만 노출한다.
 */
export const WorldDistrictInspector = memo(function WorldDistrictInspector({
  district,
  village,
  commodoreActor,
  linkedObjectives,
  locale,
  refreshing = false,
  hasDispatchFlag = false,
  districtNote = "",
  onClose,
  onRefreshMetrics,
  onMentionCommodore,
  onTeleportToDistrict,
  onFocusCommodore,
  onOpenObjective,
  onPlantDispatchFlag,
  onClearDispatchFlag,
  onSelectVillageBiome,
  onChangeNote,
  operationFlag: operationFlagProp,
  onDeployOperationFlag,
  onClearOperationFlag,
  onOpenInConsole,
  deps,
}: WorldDistrictInspectorProps) {
  const t = getWorldT(locale);
  const storeOpFlag = useOperationFlag();
  const activeOpFlag = operationFlagProp !== undefined ? operationFlagProp : storeOpFlag;
  const isOpFlagHere = Boolean(
    activeOpFlag
    && (activeOpFlag.districtId === district.id
      || (!activeOpFlag.districtId && village && activeOpFlag.villageId === village.id)),
  );
  const commodoreActorId = commodoreActor?.id ?? `commodore:${district.commodoreId}`;
  const tierName = t(TIER_NAME_KEYS[district.tier]);
  const nextTier = district.tier < 5 ? ((district.tier + 1) as WorldDevelopmentTier) : null;
  const nextTierName = nextTier !== null ? t(TIER_NAME_KEYS[nextTier]) : "";
  const statusLabel = t(STATUS_KEYS[district.status]);
  const shortTheaterId = district.theaterId.slice(0, 8);
  const progressPct = Math.round(Math.max(0, Math.min(1, district.progress01)) * 100);
  const isScanning = refreshing || (!district.metricsLoaded && district.status === "available");
  const activeBiome: WorldVillageBiome = village?.biome ?? "meadow";
  const activeBiomeMeta = VILLAGE_BIOMES.find((b) => b.id === activeBiome) ?? VILLAGE_BIOMES[0]!;
  const [noteDraft, setNoteDraft] = useState(districtNote);
  const [opFlagFormOpen, setOpFlagFormOpen] = useState(false);
  const [opFlagDirective, setOpFlagDirective] = useState("");
  const [biomeExpanded, setBiomeExpanded] = useState(false);

  useEffect(() => {
    setNoteDraft(districtNote);
    setOpFlagFormOpen(false);
    setOpFlagDirective("");
  }, [district.id, districtNote]);

  const commitNote = (nextValue: string) => {
    const trimmed = nextValue.trim();
    if (onChangeNote) {
      onChangeNote(district.id, trimmed);
    } else {
      setDistrictNote(district.id, trimmed);
    }
  };

  const handleNoteSubmit = (e: FormEvent) => {
    e.preventDefault();
    commitNote(noteDraft);
  };

  const handleSelectBiome = (biome: WorldVillageBiome) => {
    playDistrictHover();
    if (onSelectVillageBiome) {
      onSelectVillageBiome(district.commodoreId, biome);
    } else {
      setVillageBiome(district.commodoreId, biome);
    }
  };

  const handleOpenInConsole = () => {
    playDistrictSelect();
    if (onOpenInConsole) {
      onOpenInConsole(district.commodoreId, null);
      return;
    }
    if (deps) {
      deps.openCommodoreInConsole(district.commodoreId, { tab: "info" });
      exitTheWorld({ reducedMotion: deps.isReducedMotion() });
      return;
    }
    exitTheWorld();
  };

  const hasFlagHere = isOpFlagHere || hasDispatchFlag;

  const handleDeployUnifiedFlag = (rawDirective: string) => {
    const directive = rawDirective.trim();
    const payload: WorldOperationFlagDeployInput = {
      villageId: village?.id ?? `village:${district.commodoreId}`,
      districtId: district.id,
      commodoreId: district.commodoreId,
      commodoreName: district.commodoreName,
      label: district.label,
      directive,
      x: district.x,
      z: district.z,
    };
    playFlagPlant();
    if (onDeployOperationFlag) {
      onDeployOperationFlag(payload);
    } else {
      setOperationFlag({
        ...payload,
        id: `opflag:${Date.now()}`,
        createdAt: Date.now(),
      });
    }
    if (onPlantDispatchFlag) onPlantDispatchFlag(district);
    else placeDispatchFlag(district.id, directive || district.label);
    setOpFlagDirective("");
    setOpFlagFormOpen(false);
  };

  const handleClearUnifiedFlag = () => {
    if (isOpFlagHere) {
      if (onClearOperationFlag) onClearOperationFlag();
      else setOperationFlag(null);
    }
    if (hasDispatchFlag) {
      if (onClearDispatchFlag) onClearDispatchFlag(district.id);
      else clearDispatchFlag(district.id);
    }
  };

  return (
    <aside
      className="the-world-district-card"
      role="dialog"
      aria-label={t("theWorld.district.inspectorAria", { name: district.label })}
      data-tone={district.tone}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="the-world-crest" aria-hidden="true" />

      <header className="the-world-district-head">
        <div className="the-world-district-title-col">
          <div className="the-world-district-title-row">
            <span className="the-world-tone-dot" data-tone={district.tone} />
            <h2 className="the-world-district-name" title={district.label}>
              {district.label}
            </h2>
            <span className="the-world-district-tier-pill" data-tone={district.tone}>
              {t("theWorld.tier.badge", { tier: district.tier })}
            </span>
          </div>
          <div className="the-world-district-subrow">
            <span className="the-world-district-id-chip">#{shortTheaterId}</span>
            <span className={`the-world-district-status is-${district.status}`}>
              {district.status !== "available" ? <WorldIcon name="warning" size={11} tone="warn" /> : null}
              <span>{statusLabel}</span>
            </span>
            <span className="the-world-district-tier-name">{tierName}</span>
            {hasFlagHere ? (
              <span className="the-world-district-flag-chip">
                <WorldIcon name="flag" size={10} tone="amber" />
                <span>{t("theWorld.district.flagActive")}</span>
              </span>
            ) : null}
          </div>
        </div>

        <div className="the-world-district-head-actions">
          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.district.teleportAria", { name: district.label })}
            title={t("theWorld.district.actionTeleport")}
            onClick={() => onTeleportToDistrict(district.x, district.z, district.label)}
          >
            <WorldIcon name="compass" size={14} tone="cerulean" />
          </button>
          <button
            type="button"
            className={`the-world-chat-icon-btn${isScanning ? " is-spinning" : ""}`}
            aria-label={t("theWorld.district.refreshAria")}
            title={t("theWorld.district.refreshTitle")}
            onClick={onRefreshMetrics}
          >
            <WorldIcon name="retry" size={14} tone="cerulean" />
          </button>
          <button
            type="button"
            className="the-world-chat-icon-btn"
            aria-label={t("theWorld.district.closeAria")}
            onClick={onClose}
          >
            <WorldIcon name="close" size={14} />
          </button>
        </div>
      </header>

      <div className="the-world-district-body">
        {/* 담당 사령관 & 소속 마을 요약 칩 */}
        <button
          type="button"
          className="the-world-district-owner"
          aria-label={t("theWorld.district.commodoreAria", { name: district.commodoreName })}
          onClick={() => onFocusCommodore(commodoreActorId)}
        >
          {commodoreActor ? (
            <MongleAvatar
              base={commodoreActor.baseId}
              tone={commodoreActor.tone}
              role={commodoreActor.role}
              state={commodoreActor.state}
              activity={commodoreActor.activity}
              size={24}
              label={commodoreActor.name}
              decorative
            />
          ) : (
            <span className="the-world-district-owner-fallback">
              <WorldIcon name="commodore" size={14} tone="amber" />
            </span>
          )}
          <div className="the-world-district-owner-meta">
            <span className="the-world-district-owner-name">{district.commodoreName}</span>
            {village ? (
              <span className="the-world-district-owner-sub">
                {t("theWorld.village.signSubtitle", {
                  tier: village.overallTier,
                  count: village.districts.length,
                })}
              </span>
            ) : null}
          </div>
          <WorldIcon name="approach" size={13} tone="cerulean" />
        </button>

        {/* 1) 규모(파일 · 폴더 · 총 항목) 3열 카드 — 최상단 운영 지표 */}
        <div className="the-world-district-metrics">
          <div className="the-world-district-metric-tile">
            <span className="the-world-district-metric-label">{t("theWorld.district.filesLabel")}</span>
            <span className="the-world-district-metric-value">
              {isScanning && !district.metricsLoaded ? "…" : formatNumber(district.fileCount)}
            </span>
          </div>
          <div className="the-world-district-metric-tile">
            <span className="the-world-district-metric-label">{t("theWorld.district.dirsLabel")}</span>
            <span className="the-world-district-metric-value">
              {isScanning && !district.metricsLoaded ? "…" : formatNumber(district.dirCount)}
            </span>
          </div>
          <div className="the-world-district-metric-tile is-emphasis">
            <span className="the-world-district-metric-label">{t("theWorld.district.totalLabel")}</span>
            <span className="the-world-district-metric-value">
              {isScanning && !district.metricsLoaded
                ? "…"
                : `${formatNumber(district.totalEntries)}${district.truncated ? "+" : ""}`}
            </span>
          </div>
        </div>

        {/* 2) Tier 발전도 5단계 게이지 */}
        <div className="the-world-district-progress-block">
          <div className="the-world-district-progress-head">
            <span className="the-world-district-section-label">{t("theWorld.district.progressLabel")}</span>
            <span className="the-world-district-progress-pct">{progressPct}%</span>
          </div>
          <div className="the-world-district-tier-track" aria-hidden="true">
            {TIER_STEPS.map((step) => {
              const filled = district.tier >= step;
              const isCurrent = district.tier === step - 1;
              return (
                <span
                  key={step}
                  className={`the-world-district-tier-seg${filled ? " is-filled" : ""}${isCurrent ? " is-next" : ""}`}
                  data-tone={district.tone}
                >
                  {isCurrent && progressPct > 0 ? (
                    <span
                      className="the-world-district-tier-seg-fill"
                      style={{ width: `${progressPct}%` }}
                    />
                  ) : null}
                </span>
              );
            })}
          </div>
          <div className="the-world-district-progress-caption">
            {isScanning && !district.metricsLoaded
              ? t("theWorld.district.metricsLoading")
              : nextTier !== null
                ? t("theWorld.district.nextTierRemaining", {
                  count: formatNumber(district.remainingToNext),
                  nextTier,
                  nextName: nextTierName,
                })
                : t("theWorld.district.maxTierReached")}
          </div>
          {district.truncated ? (
            <div className="the-world-district-truncated-note">
              {t("theWorld.district.truncatedNote")}
            </div>
          ) : null}
        </div>

        {/* 3) 연결된 목표 목록 (상단 우선 배치) */}
        <div className="the-world-district-objectives">
          <div className="the-world-district-objectives-head">
            <span className="the-world-district-section-label">{t("theWorld.district.objectivesHeading")}</span>
            <span className="the-world-district-objectives-count">{linkedObjectives.length}</span>
          </div>
          {linkedObjectives.length === 0 ? (
            <div className="the-world-district-objectives-empty">
              {t("theWorld.district.objectivesEmpty")}
            </div>
          ) : (
            <div className="the-world-district-objectives-list">
              {linkedObjectives.map((obj) => (
                <button
                  key={obj.id}
                  type="button"
                  className="the-world-district-objective-chip"
                  aria-label={t("theWorld.district.objectiveAria", { title: obj.title })}
                  onClick={() => onOpenObjective(commodoreActorId, obj.id)}
                >
                  <WorldIcon name="questMap" size={12} tone="moss" />
                  <span className="the-world-district-objective-title">{obj.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 4) 제독 메모 (인라인 저장 — localStorage 영속 + 3D 노란 메모핀 연동) */}
        <form className="the-world-district-note-block" onSubmit={handleNoteSubmit}>
          <span className="the-world-district-note-head">
            <WorldIcon name="note" size={11} tone="amber" />
            <span className="the-world-district-section-label">{t("theWorld.district.noteLabel")}</span>
          </span>
          <div className="the-world-district-note-row">
            <input
              type="text"
              className="the-world-district-note-input"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              placeholder={t("theWorld.district.notePlaceholder")}
              aria-label={t("theWorld.district.noteInputAria", { name: district.label })}
              maxLength={240}
            />
            <button
              type="submit"
              className="the-world-district-note-btn is-save"
              disabled={noteDraft.trim() === districtNote.trim()}
            >
              {t("theWorld.district.noteSave")}
            </button>
            {districtNote || noteDraft ? (
              <button
                type="button"
                className="the-world-district-note-btn"
                onClick={() => {
                  setNoteDraft("");
                  commitNote("");
                }}
              >
                {t("theWorld.district.noteClear")}
              </button>
            ) : null}
          </div>
        </form>

        {/* 5) 통합 작전 깃발 블록 (고유 aria-label 분리) */}
        <div className="the-world-district-opflag-block">
          {hasFlagHere ? (
            <div className="the-world-district-opflag-active">
              <div className="the-world-district-opflag-info">
                <WorldIcon name="flag" size={13} tone="amber" />
                <div className="the-world-district-opflag-copy">
                  <span className="the-world-district-opflag-kicker">
                    {t("theWorld.district.opFlagActive")}
                  </span>
                  <span className="the-world-district-opflag-text">
                    {activeOpFlag?.directive || district.label}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="the-world-district-note-btn is-opflag-clear"
                onClick={handleClearUnifiedFlag}
              >
                {t("theWorld.district.opFlagClear")}
              </button>
            </div>
          ) : (
            <>
              <div className="the-world-district-opflag-row">
                <button
                  type="button"
                  className={`the-world-district-opflag-trigger${opFlagFormOpen ? " is-active" : ""}`}
                  aria-label={t("theWorld.district.plantFlagOrderAria", { name: district.label })}
                  aria-expanded={opFlagFormOpen}
                  onClick={() => setOpFlagFormOpen((prev) => !prev)}
                >
                  <WorldIcon name="flag" size={13} tone="amber" />
                  <span>{t("theWorld.district.plantFlagOrder")}</span>
                </button>
                <button
                  type="button"
                  className="the-world-district-note-btn is-save"
                  aria-label={t("theWorld.district.plantFlagQuickAria", { name: district.label })}
                  onClick={() => handleDeployUnifiedFlag("")}
                >
                  {t("theWorld.district.plantFlagQuick")}
                </button>
              </div>
              {opFlagFormOpen ? (
                <form
                  className="the-world-opflag-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleDeployUnifiedFlag(opFlagDirective);
                  }}
                >
                  <input
                    type="text"
                    className="the-world-district-note-input"
                    value={opFlagDirective}
                    maxLength={240}
                    placeholder={t("theWorld.district.opFlagPlaceholder")}
                    aria-label={t("theWorld.district.plantFlagOrderAria", { name: district.label })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") setOpFlagFormOpen(false);
                    }}
                    onChange={(e) => setOpFlagDirective(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="the-world-district-note-btn is-save"
                  >
                    {t("theWorld.district.opFlagDeploy")}
                  </button>
                </form>
              ) : null}
            </>
          )}
        </div>

        {/* 6) 마을 테마 바이옴 — 하단 접이식 섹션 */}
        {village ? (
          <div className="the-world-district-biome-block the-world-district-biome-collapsible">
            <button
              type="button"
              className="the-world-district-biome-toggle"
              aria-expanded={biomeExpanded}
              aria-label={t("theWorld.district.biomeToggleAria")}
              onClick={() => {
                playDistrictHover();
                setBiomeExpanded((prev) => !prev);
              }}
            >
              <span className="the-world-district-biome-toggle-left">
                <WorldIcon name={activeBiomeMeta.icon} size={12} tone={activeBiomeMeta.tone} />
                <span className="the-world-district-section-label">{t("theWorld.biome.pickerLabel")}</span>
              </span>
              <span className="the-world-district-biome-toggle-right">
                <span className="the-world-district-biome-current">{t(activeBiomeMeta.key)}</span>
                <span className="the-world-tools-caret" aria-hidden="true">{biomeExpanded ? "▴" : "▾"}</span>
              </span>
            </button>

            {biomeExpanded ? (
              <div
                className="the-world-district-biome-pills the-world-biome-picker"
                role="group"
                aria-label={t("theWorld.biome.groupAria")}
              >
                {VILLAGE_BIOMES.map((item) => {
                  const active = activeBiome === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`the-world-district-biome-pill${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      onClick={() => handleSelectBiome(item.id)}
                    >
                      <WorldIcon name={item.icon} size={12} tone={active ? "amber" : item.tone} />
                      <span>{t(item.key)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 하단 2열 2버튼 액션 바: 지시하기 · 콘솔에서 열기 */}
      <footer className="the-world-district-actions">
        <button
          type="button"
          className="the-world-district-action is-primary"
          data-tone={district.tone}
          aria-label={t("theWorld.district.mentionAria", { name: district.commodoreName })}
          onClick={() => onMentionCommodore(commodoreActorId)}
        >
          <WorldIcon name="chat" size={13} tone="amber" />
          <span>{t("theWorld.district.actionOrder")}</span>
        </button>

        <button
          type="button"
          className="the-world-district-action"
          aria-label={t("theWorld.action.openInConsoleAria", { name: district.commodoreName })}
          onClick={handleOpenInConsole}
        >
          <WorldIcon name="portalExit" size={13} tone="cerulean" />
          <span>{t("theWorld.action.openInConsole")}</span>
        </button>
      </footer>
    </aside>
  );
});
