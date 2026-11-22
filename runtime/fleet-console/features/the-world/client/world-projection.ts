import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { resolveMongleLook, useAvatarBook } from "../../workspace/client/avatar-events.js";
import {
  commodoreAvatarKey,
  mongleBase,
  mongleStateOf,
  objectiveRecordAvatarKey,
  type AvatarBook,
  type MongleActivity,
  type MongleState,
} from "../../workspace/shared/avatars.js";
import type { IdentityTone } from "../../workspace/shared/identity-tones.js";
import {
  computeDevelopmentProgress,
  type WorldDevelopmentTier,
  type WorldTheaterStatus,
} from "../shared/world-metrics-contract.js";
import type {
  WorldActorSpec,
  WorldDistrictSpec,
  WorldMissionItem,
  WorldSnapshot,
  WorldVillageBiome,
  WorldVillageSpec,
  WorldZoneSpec,
} from "../shared/world-types.js";
import type { TheWorldClientDeps } from "./deps.js";
import { getWorldT } from "./i18n/index.js";
import { useVillageBiomes, useWorldActive } from "./world-store.js";

/**
 * 실시간 플릿 콘솔 상태(사령관 목록 · Theater 발전도 지표 · Objective 클러스터 · 아바타 북)
 * → 3D 초원 마을(사령관별 마을 + Theater 구역) 스냅샷 순수 투영기.
 *
 * - 각 사령관(Commodore)은 고유 마을(Village)을 소유하며, 마을 내부는 배정된 Theater별 구역(District)으로 나뉜다.
 * - 각 구역의 파일+폴더 수(`totalEntries`)에 따라 Tier 0~5 발전도를 산출한다.
 * - 보안 불변식: 원시 파일시스템 절대경로(`path`)는 어떤 스펙에도 싣지 않는다.
 */

const PLAZA_X = 0;
const PLAZA_Z = -1.5;
const MAX_DISTRICTS_PER_VILLAGE = 12;
const MAX_VISIBLE_OUTPOSTS = 8;
const MAX_WORLD_PLACE_RADIUS = 78.0;

/** 시냇물 중심선 및 반폭 (`meadow-scene.ts`의 `brookProfile`과 동일 수식). */
function brookProfile(x: number): { readonly centerZ: number; readonly halfWidth: number } {
  const centerZ = 9.2 + Math.sin(x * 0.095) * 2.9 + Math.cos(x * 0.04) * 1.1;
  const pondBell = Math.exp(-Math.pow((x - 5.8) / 4.8, 2));
  const halfWidth = 1.45 + pondBell * 2.15;
  return { centerZ, halfWidth };
}

function nudgeClearOfBrook(x: number, z: number, clearance: number): { readonly x: number; readonly z: number } {
  if (Math.abs(x) >= 82) return { x, z };
  const bp = brookProfile(x);
  const minDist = bp.halfWidth + clearance;
  const dz = z - bp.centerZ;
  if (Math.abs(dz) >= minDist) return { x, z };
  const dir = dz >= 0 ? 1 : -1;
  return { x, z: bp.centerZ + dir * minDist };
}

function clampToWorldRadius(x: number, z: number, maxR: number): { readonly x: number; readonly z: number } {
  const r = Math.hypot(x, z);
  if (r <= maxR || r < 0.001) return { x, z };
  const s = maxR / r;
  return { x: x * s, z: z * s };
}

/**
 * 사령관 마을 앵커 프리셋 (이동 반경 88m, 중앙 광장 r>=24m 및 시냇물 z≈9.2±5 회피, 인접 마을 간격 ≥34~40m 보장).
 * 1링(0~6): 초원 핵심 경관 권역 / 2링(7~11): 외곽 확장 권역.
 */
const VILLAGE_ANCHOR_SLOTS: readonly { readonly x: number; readonly z: number }[] = [
  { x: -34.0, z: -24.0 }, // 0: 북서 초원
  { x: 34.0, z: -24.0 },  // 1: 북동 초원
  { x: 0.0, z: -40.0 },   // 2: 북쪽 언덕
  { x: 30.0, z: 40.0 },   // 3: 남동 벚꽃 언덕 (목교 건너)
  { x: -30.0, z: 39.0 },  // 4: 남서 강변 초원 (목교 건너)
  { x: -62.0, z: -5.0 },  // 5: 서쪽 초원
  { x: 63.0, z: -6.5 },   // 6: 동쪽 초원
  { x: 0.0, z: 60.0 },    // 7: 남쪽 계곡
  { x: -58.0, z: -46.0 }, // 8: 외곽 북서
  { x: 58.0, z: -46.0 },  // 9: 외곽 북동
  { x: -26.0, z: -66.0 }, // 10: 외곽 북북서
  { x: 26.0, z: -66.0 },  // 11: 외곽 북북동
];

const FALLBACK_OUTPOST_SLOTS: readonly { readonly x: number; readonly z: number }[] = [
  { x: -22.0, z: -4.0 },
  { x: 22.0, z: -4.0 },
  { x: -16.0, z: -28.0 },
  { x: 16.0, z: -28.0 },
  { x: -48.0, z: 34.0 },
  { x: 48.0, z: 34.0 },
  { x: -44.0, z: 52.0 },
  { x: 44.0, z: 52.0 },
];

function resolveVillageAnchor(idx: number, villageRadius: number): { readonly x: number; readonly z: number } {
  const preset = VILLAGE_ANCHOR_SLOTS[idx];
  if (preset) return preset;
  const overflowIdx = idx - VILLAGE_ANCHOR_SLOTS.length;
  const ringAngle = -Math.PI * 0.85 + overflowIdx * 0.56;
  const radius = Math.min(74.0, 68.0 + Math.floor(overflowIdx / 8) * 3.0);
  const rawX = Math.cos(ringAngle) * radius;
  const rawZ = Math.sin(ringAngle) * radius;
  const clear = nudgeClearOfBrook(rawX, rawZ, villageRadius + 2.0);
  return clampToWorldRadius(clear.x, clear.z, MAX_WORLD_PLACE_RADIUS - villageRadius * 0.5);
}

interface DistrictPlacement {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly rotationY: number;
}

function computeVillageLayout(
  theaterCount: number,
  vx: number,
  vz: number,
  gateAngle: number,
): { readonly villageRadius: number; readonly placements: readonly DistrictPlacement[] } {
  const count = Math.min(theaterCount, MAX_DISTRICTS_PER_VILLAGE);
  if (count <= 0) {
    return { villageRadius: 6.4, placements: [] };
  }

  const backAngle = gateAngle + Math.PI;
  if (count === 1) {
    const dist = 3.2;
    const dx = vx + Math.cos(backAngle) * dist;
    const dz = vz + Math.sin(backAngle) * dist;
    return {
      villageRadius: 7.2,
      placements: [
        {
          x: dx,
          z: dz,
          radius: 2.75,
          rotationY: Math.atan2(vx - dx, vz - dz),
        },
      ],
    };
  }

  // #21 QA 폴리싱 반영: 3개 이상 구역에서도 마을 중앙 광장 링 및 인접 구역 이중 선택 링이 서로 겹치지 않도록
  // 반경(`ringDist`)과 호 각도(`span`)에 여유 간격을 확보한다.
  if (count <= 6) {
    const configByCount: Readonly<Record<number, { readonly ringDist: number; readonly districtRadius: number; readonly span: number }>> = {
      2: { ringDist: 4.7, districtRadius: 2.6, span: 1.85 },
      3: { ringDist: 5.0, districtRadius: 2.55, span: Math.PI },
      4: { ringDist: 5.35, districtRadius: 2.4, span: 3.85 },
      5: { ringDist: 5.55, districtRadius: 2.3, span: 4.3 },
      6: { ringDist: 5.85, districtRadius: 2.15, span: 4.6 },
    };
    const cfg = configByCount[count]!;
    const villageRadius = Math.round((cfg.ringDist + cfg.districtRadius + 1.35) * 10) / 10;
    const placements: DistrictPlacement[] = [];
    for (let i = 0; i < count; i += 1) {
      const t = i / (count - 1);
      const angle = backAngle - cfg.span * 0.5 + cfg.span * t;
      const dx = vx + Math.cos(angle) * cfg.ringDist;
      const dz = vz + Math.sin(angle) * cfg.ringDist;
      placements.push({
        x: dx,
        z: dz,
        radius: cfg.districtRadius,
        rotationY: Math.atan2(vx - dx, vz - dz),
      });
    }
    return { villageRadius, placements };
  }

  // 7~12개 Theater: 2중 동심원 배치 (내부 5개 + 외부 최대 7개)
  const innerCount = 5;
  const outerCount = count - innerCount;
  const innerSpan = Math.PI * 1.44;
  const outerSpan = Math.PI * 1.62;
  const placements: DistrictPlacement[] = [];

  for (let i = 0; i < innerCount; i += 1) {
    const t = i / (innerCount - 1);
    const angle = backAngle - innerSpan * 0.5 + innerSpan * t;
    const dx = vx + Math.cos(angle) * 4.85;
    const dz = vz + Math.sin(angle) * 4.85;
    placements.push({
      x: dx,
      z: dz,
      radius: 2.05,
      rotationY: Math.atan2(vx - dx, vz - dz),
    });
  }

  for (let i = 0; i < outerCount; i += 1) {
    const t = outerCount === 1 ? 0.5 : i / (outerCount - 1);
    const angle = backAngle - outerSpan * 0.5 + outerSpan * t;
    const dx = vx + Math.cos(angle) * 8.25;
    const dz = vz + Math.sin(angle) * 8.25;
    placements.push({
      x: dx,
      z: dz,
      radius: 2.05,
      rotationY: Math.atan2(vx - dx, vz - dz),
    });
  }

  return { villageRadius: 11.4, placements };
}

function estimateVillageRadius(theaterCount: number): number {
  const count = Math.min(theaterCount, MAX_DISTRICTS_PER_VILLAGE);
  if (count <= 0) return 6.4;
  if (count === 1) return 7.2;
  if (count === 2) return 8.7;
  if (count === 3) return 8.9;
  if (count === 4) return 9.1;
  if (count === 5) return 9.2;
  if (count === 6) return 9.4;
  return 11.4;
}

// 오두막(-2.15, -2.35), 브리핑 테이블(0.55, -0.45), 모루(-3.25, 0.95), 터미널(3.15, 0.45)과 겹치지 않는 작업 위치
const MEMBER_OFFSETS: readonly { readonly dx: number; readonly dz: number }[] = [
  { dx: -2.15, dz: 1.45 },
  { dx: 1.95, dz: 1.35 },
  { dx: -0.45, dz: 2.45 },
  { dx: 2.15, dz: -1.15 },
  { dx: -2.45, dz: -0.45 },
];

const MEMBER_RUNNING_ACTIVITIES: readonly MongleActivity[] = ["edit", "read", "think", "run", "fetch"];

function resolveLookDetails(book: AvatarBook | null, key: string) {
  const resolved = resolveMongleLook(book, key);
  const spec = mongleBase(resolved.base);
  return {
    baseId: spec.id,
    shape: spec.shape,
    tone: spec.quaker ? spec.tone : (resolved.tone ?? spec.tone),
    quaker: spec.quaker ?? null,
    defaultNameKo: spec.name.ko,
    defaultNameEn: spec.name.en,
  };
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function buildWorldSnapshot(
  deps: TheWorldClientDeps,
  book: AvatarBook | null,
  villageBiomes: Readonly<Record<string, WorldVillageBiome>> = {},
): WorldSnapshot {
  const locale = deps.commodore.language();
  const t = getWorldT(locale);
  const isEn = locale === "en";
  const commodores = deps.readCommodores();
  const metricsByTheaterId = deps.readTheaterMetrics();
  const allClusters = deps.clusters.get().filter((cluster) => !cluster.row?.commodore);
  const clusters = allClusters.filter((cluster) => cluster.row?.glyph !== "done");
  const records = deps.readObjectiveRecords();
  const recordById = new Map(records.map((rec) => [rec.id, rec]));

  const zones: WorldZoneSpec[] = [
    {
      id: "plaza-main",
      kind: "plaza",
      label: t("theWorld.projection.plazaLabel"),
      x: PLAZA_X,
      z: PLAZA_Z,
      radius: 10.5,
      roofTone: "moss",
      commodoreId: commodores[0]?.commodoreId,
    },
  ];

  const villages: WorldVillageSpec[] = [];
  const villageByCommodoreId = new Map<string, WorldVillageSpec>();
  const actors: WorldActorSpec[] = [];

  // 1. 사령관별 마을(Village) + Theater 구역(District) + 사령관 NPC 투영
  commodores.forEach((row, idx) => {
    const snap = deps.commodore.read(row.commodoreId);
    const view = snap.view;
    const run = view?.run ?? row.run;
    const isRunning = run.phase === "turn";
    const isError = run.phase === "error";
    const openAsksCount = snap.asks.length;
    const hasAsk = openAsksCount > 0;
    const state: MongleState = hasAsk ? "decision" : isRunning ? "running" : isError ? "error" : "idle";
    const activity: MongleActivity | null = isRunning ? (run.step ?? "delegate") : null;
    const look = resolveLookDetails(book, commodoreAvatarKey(row.commodoreId));
    const commodoreName = row.alias ?? row.label ?? (isEn ? look.defaultNameEn : look.defaultNameKo);
    const rawModel = view?.run.session?.model ?? view?.state.model ?? view?.defaults.model ?? null;
    const rawEffort = view?.run.session?.effort ?? view?.state.effort ?? view?.defaults.effort ?? null;
    const effortChip = rawEffort === "medium" ? "MED" : rawEffort ? rawEffort.toUpperCase() : null;
    const modelLabel = rawModel ? `${rawModel}${effortChip ? ` · ${effortChip}` : ""}` : undefined;
    const theaterLabels = row.theaters.map((th) => th.label);

    const stateRoutines = view?.state.routines;
    const routineCount = stateRoutines
      ? stateRoutines.filter((r) => r.enabled).length
      : Object.keys(run.routineNextRuns ?? {}).length;

    const estRadius = estimateVillageRadius(row.theaters.length);
    const anchor = resolveVillageAnchor(idx, estRadius);
    const gateAngle = Math.atan2(PLAZA_Z - anchor.z, PLAZA_X - anchor.x);
    const { villageRadius, placements } = computeVillageLayout(row.theaters.length, anchor.x, anchor.z, gateAngle);
    const villageId = `village:${row.commodoreId}`;

    const commodoreAllClusters = allClusters.filter((cluster) => cluster.commodoreId === row.commodoreId);
    const commodoreClusters = commodoreAllClusters.filter((cluster) => cluster.row?.glyph !== "done");
    const completedObjectiveCount = commodoreAllClusters.length - commodoreClusters.length;
    const activeObjectiveCount = commodoreClusters.length;
    const anyClusterNeedsAttention = commodoreClusters.some(
      (cluster) =>
        cluster.row?.personTurnAt !== undefined
        || cluster.row?.glyph === "review"
        || cluster.members.some((m) => !m.pending && (m.awaitingInput === true || m.progress === "awaiting")),
    );
    const villageNeedsAttention = hasAsk || anyClusterNeedsAttention;
    const villageWorkStep: string | null = isRunning ? (run.step ?? "delegate") : null;
    const visibleTheaters = row.theaters.slice(0, MAX_DISTRICTS_PER_VILLAGE);

    let totalFiles = 0;
    let totalDirs = 0;
    let totalEntries = 0;
    let anyTruncated = false;
    let maxDistrictTier: WorldDevelopmentTier = 0;

    const districts: WorldDistrictSpec[] = visibleTheaters.map((theater, tIdx) => {
      const place = placements[tIdx]!;
      const metric = metricsByTheaterId[theater.theaterId];
      const metricsLoaded = metric !== undefined;
      const status: WorldTheaterStatus = metric?.status ?? (theater.status === "missing" ? "missing" : "available");
      const fileCount = status === "available" ? (metric?.fileCount ?? 0) : 0;
      const dirCount = status === "available" ? (metric?.dirCount ?? 0) : 0;
      const entries = status === "available" ? (metric?.totalEntries ?? (fileCount + dirCount)) : 0;
      const truncated = status === "available" && metric?.truncated === true;
      const dev = computeDevelopmentProgress(entries, truncated);

      totalFiles += fileCount;
      totalDirs += dirCount;
      totalEntries += entries;
      if (truncated) anyTruncated = true;
      if (dev.tier > maxDistrictTier) maxDistrictTier = dev.tier;

      const matchedClusters = commodoreClusters.filter(
        (cluster) => cluster.theaterId === theater.theaterId || visibleTheaters.length === 1,
      );
      const linkedObjectiveIds = matchedClusters.map((cluster) => cluster.root ?? cluster.id);
      const hasRunningCluster = matchedClusters.some(
        (cluster) =>
          (cluster.root ? recordById.get(cluster.root)?.status === "running" : false)
          || cluster.members.some((m) => !m.pending && m.progress === "running"),
      );
      const clusterNeedsAttention = matchedClusters.some(
        (cluster) =>
          cluster.row?.personTurnAt !== undefined
          || cluster.row?.glyph === "review"
          || cluster.members.some((m) => !m.pending && (m.awaitingInput === true || m.progress === "awaiting")),
      );
      const districtActiveWorkStep: string | null = status === "available"
        ? (villageWorkStep ?? (hasRunningCluster ? "edit" : null))
        : null;
      const districtNeedsAttention = clusterNeedsAttention || (hasAsk && (visibleTheaters.length === 1 || tIdx === 0));

      return {
        id: `district:${row.commodoreId}:${theater.theaterId}`,
        villageId,
        commodoreId: row.commodoreId,
        commodoreName,
        theaterId: theater.theaterId,
        label: theater.label,
        status,
        x: roundCoord(place.x),
        z: roundCoord(place.z),
        radius: place.radius,
        rotationY: roundCoord(place.rotationY),
        tone: look.tone,
        fileCount,
        dirCount,
        totalEntries: entries,
        truncated,
        metricsLoaded,
        tier: dev.tier,
        tierCode: dev.code,
        progress01: dev.progress01,
        remainingToNext: dev.remainingToNext,
        nextTierThreshold: dev.nextTierThreshold,
        linkedObjectiveIds,
        activeWorkStep: districtActiveWorkStep,
        needsAttention: districtNeedsAttention,
        hasError: isError,
      };
    });

    const overallDev = computeDevelopmentProgress(totalEntries, anyTruncated);
    const biome: WorldVillageBiome = villageBiomes[row.commodoreId] ?? "meadow";
    const village: WorldVillageSpec = {
      id: villageId,
      commodoreId: row.commodoreId,
      label: commodoreName,
      tone: look.tone,
      biome,
      x: roundCoord(anchor.x),
      z: roundCoord(anchor.z),
      radius: villageRadius,
      gateAngle: roundCoord(gateAngle),
      overallTier: overallDev.tier,
      overallTierCode: overallDev.code,
      maxDistrictTier,
      totalFiles,
      totalDirs,
      totalEntries,
      routineCount,
      completedObjectiveCount,
      activeObjectiveCount,
      workStep: villageWorkStep,
      needsAttention: villageNeedsAttention,
      hasError: isError,
      openAsksCount,
      districts,
    };

    villages.push(village);
    villageByCommodoreId.set(row.commodoreId, village);

    // 워프/HUD 구역 목록에도 각 사령관 마을을 노출한다.
    zones.push({
      id: villageId,
      kind: "village",
      label: commodoreName,
      x: village.x,
      z: village.z,
      radius: village.radius,
      roofTone: look.tone,
      commodoreId: row.commodoreId,
      overallTier: village.overallTier,
      districtCount: districts.length,
    });

    // 사령관 NPC는 정문 아치 기둥에 가리지 않도록 마을 중앙 원형 광장 안쪽 정면부에 배치한다.
    const npcOffset = districts.length === 0 ? 0.45 : 1.15;
    const npcX = roundCoord(village.x + Math.cos(gateAngle) * npcOffset);
    const npcZ = roundCoord(village.z + Math.sin(gateAngle) * npcOffset);

    const roleCommodore = t("theWorld.role.commodore");
    const statusText = isRunning
      ? t("theWorld.bridge.phaseTurn")
      : hasAsk
        ? `${t("theWorld.state.decision")} (${snap.asks.length})`
        : t("theWorld.bridge.phaseIdle");

    actors.push({
      id: `commodore:${row.commodoreId}`,
      role: "commodore",
      name: commodoreName,
      subtitle: theaterLabels.length > 0 ? `${roleCommodore} · ${theaterLabels[0]}` : roleCommodore,
      zoneId: villageId,
      homeX: npcX,
      homeZ: npcZ,
      baseId: look.baseId,
      shape: look.shape,
      tone: look.tone,
      quaker: look.quaker,
      state,
      activity,
      needsAttention: hasAsk,
      initialSpeech: idx === 0 ? `[greet] ${t("theWorld.projection.welcomeSpeech")}` : undefined,
      commodoreId: row.commodoreId,
      modelLabel,
      theaterLabels,
      askCount: snap.asks.length,
      summaryLines: [
        `${t("theWorld.bridge.statPhase")}: ${statusText}`,
        ...(modelLabel ? [isEn ? `Model: ${modelLabel}` : `모델: ${modelLabel}`] : []),
        isEn
          ? `Districts: ${theaterLabels.join(", ") || "Unlinked"}`
          : `소속 폴더: ${theaterLabels.join(", ") || "미연결"}`,
        `${t("theWorld.district.progressLabel")}: ${t("theWorld.village.signSubtitle", { tier: village.overallTier, count: districts.length })} · ${totalEntries.toLocaleString()}`,
      ],
    });
  });

  // 2. 활성 Objective 클러스터(지휘관 + 구성원) — 소속 사령관 마을 외곽 위성 캠프 투영
  const visibleClusters = clusters.slice(0, MAX_VISIBLE_OUTPOSTS);
  const satelliteCountByCommodore = new Map<string, number>();

  visibleClusters.forEach((cluster, cIdx) => {
    const ownerVillage = cluster.commodoreId ? villageByCommodoreId.get(cluster.commodoreId) : undefined;
    let slotX: number;
    let slotZ: number;

    if (ownerVillage) {
      const satIdx = satelliteCountByCommodore.get(ownerVillage.commodoreId) ?? 0;
      satelliteCountByCommodore.set(ownerVillage.commodoreId, satIdx + 1);
      // 마을 외곽 방사 방향(광장 반대편)으로 부채꼴 위성 배치해 마을·구역과 겹치지 않게 한다.
      const baseAngle = ownerVillage.gateAngle + Math.PI;
      const fanStep = satIdx === 0 ? 0 : (satIdx % 2 === 1 ? 1 : -1) * Math.ceil(satIdx / 2) * 0.46;
      const satAngle = baseAngle + fanStep;
      const satDist = ownerVillage.radius + 6.8;
      const rawX = ownerVillage.x + Math.cos(satAngle) * satDist;
      const rawZ = ownerVillage.z + Math.sin(satAngle) * satDist;
      const clear = nudgeClearOfBrook(rawX, rawZ, 7.2);
      const clamped = clampToWorldRadius(clear.x, clear.z, MAX_WORLD_PLACE_RADIUS);
      slotX = roundCoord(clamped.x);
      slotZ = roundCoord(clamped.z);
    } else {
      const fallback = FALLBACK_OUTPOST_SLOTS[cIdx % FALLBACK_OUTPOST_SLOTS.length]!;
      slotX = fallback.x;
      slotZ = fallback.z;
    }

    const zoneId = `outpost:${cluster.id}`;
    const cmdrObjId = cluster.root ?? cluster.avatarObjectiveId ?? cluster.id;
    const cmdrLook = resolveLookDetails(book, objectiveRecordAvatarKey(cmdrObjId));
    const cmdrRec = cluster.root ? recordById.get(cluster.root) : undefined;
    const awaitingReview = cluster.row?.glyph === "review";
    const personDecision = cluster.row?.personTurnAt !== undefined || awaitingReview;

    zones.push({
      id: zoneId,
      kind: "outpost",
      label: cluster.title,
      x: slotX,
      z: slotZ,
      radius: 6.4,
      roofTone: cmdrLook.tone,
      commodoreId: cluster.commodoreId,
      rootObjectiveId: cluster.root,
      fullWorkshop: cIdx % 2 === 0,
    });

    const missions: WorldMissionItem[] = cluster.members.map((m) => ({
      id: m.objectiveId,
      label: m.label,
      done: m.progress === "done",
      active: m.progress === "running" || m.progress === "awaiting",
    }));

    const cmdrState = mongleStateOf({
      session: cluster.root !== undefined,
      activity: cmdrRec?.status === "running" ? "running" : "idle",
      awaitingReview,
      personTurn: personDecision,
    });

    actors.push({
      id: `commander:${cmdrObjId}`,
      role: "commander",
      name: isEn ? cmdrLook.defaultNameEn : cmdrLook.defaultNameKo,
      subtitle: `${t("theWorld.role.commander")} · ${cluster.title}`,
      zoneId,
      homeX: roundCoord(slotX + 0.55),
      homeZ: roundCoord(slotZ + 1.15),
      baseId: cmdrLook.baseId,
      shape: cmdrLook.shape,
      tone: cmdrLook.tone,
      quaker: null,
      state: cmdrState,
      activity: cmdrState === "running" ? "delegate" : null,
      needsAttention: personDecision,
      commodoreId: cluster.commodoreId,
      objectiveId: cluster.root,
      rootObjectiveId: cluster.root,
      missions,
      summaryLines: [
        `${t("theWorld.bridge.goalsHeading")}: ${cluster.title}`,
        isEn
          ? `Crew: ${cluster.members.filter((m) => !m.pending).length} / ${cluster.members.length} steps`
          : `구성원: ${cluster.members.filter((m) => !m.pending).length}명 / 전체 단계 ${cluster.members.length}`,
      ],
    });

    const liveMembers = cluster.members.filter((m) => !m.pending).slice(0, MEMBER_OFFSETS.length);
    liveMembers.forEach((member, mIdx) => {
      const offset = MEMBER_OFFSETS[mIdx]!;
      const memLook = resolveLookDetails(book, objectiveRecordAvatarKey(member.objectiveId));
      const awaiting = member.awaitingInput === true || member.progress === "awaiting";
      const running = member.progress === "running";
      const done = member.progress === "done";
      const memState: MongleState = awaiting ? "awaiting" : running ? "running" : done ? "done" : "idle";
      const memAct: MongleActivity | null = running ? MEMBER_RUNNING_ACTIVITIES[mIdx % MEMBER_RUNNING_ACTIVITIES.length]! : null;

      actors.push({
        id: `member:${member.objectiveId}`,
        role: "member",
        name: member.name ?? (isEn ? memLook.defaultNameEn : memLook.defaultNameKo),
        subtitle: `${t("theWorld.role.member")} · ${member.label}`,
        zoneId,
        homeX: roundCoord(slotX + offset.dx),
        homeZ: roundCoord(slotZ + offset.dz),
        baseId: memLook.baseId,
        shape: memLook.shape,
        tone: memLook.tone,
        quaker: null,
        state: memState,
        activity: memAct,
        needsAttention: awaiting,
        commodoreId: cluster.commodoreId,
        objectiveId: member.objectiveId,
        rootObjectiveId: cluster.root,
        summaryLines: [
          isEn ? `Mission: ${member.label}` : `임무: ${member.label}`,
          ...(member.result
            ? [isEn ? `Output: ${member.result}` : `산출: ${member.result}`]
            : [isEn ? `Progress: ${member.progress}` : `진행: ${member.progress}`]),
        ],
      });
    });
  });

  const activeCount = actors.filter((a) => a.state === "running" || a.state === "awaiting" || a.state === "decision").length;
  const attentionCount = actors.filter((a) => a.needsAttention).length;

  return {
    zones,
    villages,
    actors,
    activeCount,
    totalPopulation: actors.length,
    attentionCount,
  };
}

export function useWorldSnapshot(deps: TheWorldClientDeps): WorldSnapshot {
  const book = useAvatarBook();
  const isWorldActive = useWorldActive();
  const villageBiomes = useVillageBiomes();
  const commodores = useSyncExternalStore(deps.subscribeCommodores, deps.readCommodores, deps.readCommodores);
  const clusters = useSyncExternalStore(deps.clusters.subscribe, deps.clusters.get, deps.clusters.get);
  const records = useSyncExternalStore(deps.subscribeObjectiveRecords, deps.readObjectiveRecords, deps.readObjectiveRecords);
  const theaterMetrics = useSyncExternalStore(
    deps.subscribeTheaterMetrics,
    deps.readTheaterMetrics,
    deps.readTheaterMetrics,
  );

  // LLM 스트리밍 중 text-delta마다 commodoreRevision이 20~60Hz로 올라가더라도,
  // 월드 스냅샷에 실제로 영향을 주는 굵은 상태(phase·step·asks·routines·model·effort)가 바뀔 때만 재투영한다.
  const readCoarseCommodoreKey = useCallback((): string => {
    const list = deps.readCommodores();
    let key = `${deps.commodore.language() ?? ""}|`;
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i]!;
      const id = row.commodoreId;
      const snap = deps.commodore.read(id);
      const view = snap.view;
      const run = view?.run ?? row.run;
      const phase = run.phase ?? "";
      const step = run.step ?? "";
      const routines = view?.state.routines
        ? view.state.routines.filter((r) => r.enabled).length
        : Object.keys(run.routineNextRuns ?? {}).length;
      const model = view?.run.session?.model ?? view?.state.model ?? view?.defaults.model ?? "";
      const effort = view?.run.session?.effort ?? view?.state.effort ?? view?.defaults.effort ?? "";
      key += `${id}:${phase}:${step}:${snap.asks.length}:${routines}:${model}:${effort}|`;
    }
    return key;
  }, [deps]);

  const coarseCommodoreKey = useSyncExternalStore(
    deps.commodore.subscribe,
    readCoarseCommodoreKey,
    readCoarseCommodoreKey,
  );

  // 더 월드가 열려 있을 때만 Theater 파일·폴더 지표를 서버에서 온디맨드 조회한다.
  const theaterSetKey = useMemo(
    () => commodores.map((c) => `${c.commodoreId}:${c.theaters.map((t) => `${t.theaterId}:${t.status}`).join(",")}`).join("|"),
    [commodores],
  );

  useEffect(() => {
    if (!isWorldActive) return;
    const hasExisting = Object.keys(theaterMetrics).length > 0;
    const hasNewTheater = hasExisting && commodores.some((c) =>
      c.theaters.some((t) => t.status === "available" && theaterMetrics[t.theaterId] === undefined),
    );
    void deps.ensureTheaterMetrics(hasNewTheater ? { refresh: true } : undefined);
    // theaterMetrics 자체 변경으로 재요청 루프가 돌지 않도록 isWorldActive와 theaterSetKey만 의존한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps, isWorldActive, theaterSetKey]);

  return useMemo(
    () => buildWorldSnapshot(deps, book, villageBiomes),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- coarseCommodoreKey와 theaterMetrics가 외부 스토어 변화를 반영한다.
    [deps, book, villageBiomes, coarseCommodoreKey, commodores, clusters, records, theaterMetrics],
  );
}
