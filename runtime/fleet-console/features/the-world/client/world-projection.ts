import { useMemo, useSyncExternalStore } from "react";

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
import type {
  WorldActorSpec,
  WorldMissionItem,
  WorldSnapshot,
  WorldZoneSpec,
} from "../shared/world-types.js";
import type { TheWorldClientDeps } from "./deps.js";

/**
 * 실시간 플릿 콘솔 상태(사령관 목록 · Objective 클러스터 · 아바타 북) → 3D 초원 마을 스냅샷 순수 투영기.
 *
 * 실제 사령관·지휘관·구성원을 저장된 `AvatarBook` 외형 그대로 초원 마을 광장과 각 목장/공방 캠프에 배치한다.
 */

// 사령관들이 다리 건너 한 곳에 몰리지 않도록 마을 전역의 개방된 명소에 여유 있게 분산 배치
const COMMODORE_ANCHORS: readonly { readonly x: number; readonly z: number; readonly zoneId: "plaza-main" | "garden-east" }[] = [
  { x: -0.4, z: -2.5, zoneId: "plaza-main" },   // 길드 회관 앞 중앙 광장
  { x: 7.4, z: 0.6, zoneId: "plaza-main" },     // 풍차 시계탑 남쪽 잔디
  { x: -5.4, z: 2.4, zoneId: "plaza-main" },    // 서쪽 소원 우물 너머 꽃밭
  { x: 4.6, z: 5.4, zoneId: "plaza-main" },     // 모닥불 남동쪽 다리 입구 잔디
  { x: 12.4, z: 23.4, zoneId: "garden-east" },  // 다리 건너 벚꽃 정원 언덕
  { x: -8.8, z: -2.2, zoneId: "plaza-main" },   // 북서쪽 목장 언덕
  { x: 9.6, z: -1.4, zoneId: "plaza-main" },    // 북동쪽 풍차 앞 초원
];

function resolveCommodoreAnchor(idx: number): { readonly x: number; readonly z: number; readonly zoneId: "plaza-main" | "garden-east" } {
  const preset = COMMODORE_ANCHORS[idx];
  if (preset) return preset;
  const overflowIdx = idx - COMMODORE_ANCHORS.length;
  const ringAngle = -Math.PI * 0.78 + overflowIdx * 0.62;
  const radius = 11.2 + Math.floor(overflowIdx / 5) * 3.0;
  return {
    x: Math.cos(ringAngle) * radius,
    z: Math.min(4.8, -1.5 + Math.sin(ringAngle) * radius),
    zoneId: "plaza-main",
  };
}

const OUTPOST_SLOTS: readonly { readonly x: number; readonly z: number; readonly roofTone: IdentityTone }[] = [
  { x: -16.5, z: -9.5, roofTone: "amber" },
  { x: 16.5, z: -8.5, roofTone: "rose" },
  { x: -15.0, z: 16.5, roofTone: "indigo" },
  { x: -23.5, z: 2.5, roofTone: "teal" },
  { x: 23.0, z: 3.0, roofTone: "plum" },
];

// 오두막(-2.15, -2.35), 브리핑 테이블(0.55, -0.45), 모루(-3.25, 0.95), 터미널(3.15, 0.45)과 겹치지 않는 여유로운 작업 위치
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
  };
}

export function buildWorldSnapshot(
  deps: TheWorldClientDeps,
  book: AvatarBook | null,
): WorldSnapshot {
  const commodores = deps.readCommodores();
  const clusters = deps.clusters.get().filter((cluster) => !cluster.row?.commodore && cluster.row?.glyph !== "done");
  const records = deps.readObjectiveRecords();
  const recordById = new Map(records.map((rec) => [rec.id, rec]));

  const gardenCommodore = commodores.find((_, idx) => resolveCommodoreAnchor(idx).zoneId === "garden-east");
  const zones: WorldZoneSpec[] = [
    {
      id: "plaza-main",
      kind: "plaza",
      label: "중앙 길드 광장",
      x: 0,
      z: -1.5,
      radius: 10.5,
      roofTone: "moss",
      commodoreId: commodores[0]?.commodoreId,
    },
    {
      id: "garden-east",
      kind: "garden",
      label: gardenCommodore?.alias ?? gardenCommodore?.label ?? "동쪽 벚꽃 언덕",
      x: 12.5,
      z: 19.6,
      radius: 6.4,
      roofTone: "cerulean",
      commodoreId: gardenCommodore?.commodoreId,
    },
  ];

  const actors: WorldActorSpec[] = [];

  // 1. 실제 사령관(Commodores) 투영 (중앙 광장·풍차 잔디·서쪽 꽃밭·강변·벚꽃 언덕 등 마을 전역 분산 배치)
  commodores.forEach((row, idx) => {
    const snap = deps.commodore.read(row.commodoreId);
    const view = snap.view;
    const isRunning = view?.run.phase === "turn";
    const hasAsk = snap.asks.length > 0;
    const state: MongleState = hasAsk ? "decision" : isRunning ? "running" : "idle";
    const activity: MongleActivity | null = isRunning ? (view?.run.step ?? "delegate") : null;
    const look = resolveLookDetails(book, commodoreAvatarKey(row.commodoreId));
    const anchor = resolveCommodoreAnchor(idx);
    const rawModel = view?.state.model ?? view?.defaults.model ?? null;
    const rawEffort = view?.state.effort ?? view?.defaults.effort ?? null;
    const effortChip = rawEffort === "medium" ? "MED" : rawEffort ? rawEffort.toUpperCase() : null;
    const modelLabel = rawModel ? `${rawModel}${effortChip ? ` · ${effortChip}` : ""}` : undefined;
    const theaterLabels = row.theaters.map((th) => th.label);

    actors.push({
      id: `commodore:${row.commodoreId}`,
      role: "commodore",
      name: row.alias ?? row.label ?? look.defaultNameKo,
      subtitle: theaterLabels.length > 0 ? `사령관 · ${theaterLabels[0]}` : "사령관",
      zoneId: anchor.zoneId,
      homeX: anchor.x,
      homeZ: anchor.z,
      baseId: look.baseId,
      shape: look.shape,
      tone: look.tone,
      quaker: look.quaker,
      state,
      activity,
      needsAttention: hasAsk,
      initialSpeech: idx === 0 ? "넓은 초원 본부에 오신 걸 환영해요! ✦" : undefined,
      commodoreId: row.commodoreId,
      modelLabel,
      theaterLabels,
      askCount: snap.asks.length,
      summaryLines: [
        `상태: ${isRunning ? "턴 실행 중" : hasAsk ? `질문 응답 대기 (${snap.asks.length}건)` : "대기 중"}`,
        ...(modelLabel ? [`모델: ${modelLabel}`] : []),
        `소속 폴더: ${theaterLabels.join(", ") || "미연결"}`,
      ],
    });
  });

  // 2. 실제 활성 Objective 클러스터(지휘관 + 구성원) 초원 캠프 투영
  const visibleClusters = clusters.slice(0, OUTPOST_SLOTS.length);
  visibleClusters.forEach((cluster, cIdx) => {
    const slot = OUTPOST_SLOTS[cIdx]!;
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
      x: slot.x,
      z: slot.z,
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
      name: cmdrLook.defaultNameKo,
      subtitle: `지휘관 · ${cluster.title}`,
      zoneId,
      homeX: slot.x + 0.55,
      homeZ: slot.z + 1.15,
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
        `목표: ${cluster.title}`,
        `구성원: ${cluster.members.filter((m) => !m.pending).length}명 / 전체 단계 ${cluster.members.length}`,
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
        name: member.name ?? memLook.defaultNameKo,
        subtitle: `구성원 · ${member.label}`,
        zoneId,
        homeX: slot.x + offset.dx,
        homeZ: slot.z + offset.dz,
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
          `임무: ${member.label}`,
          ...(member.result ? [`산출: ${member.result}`] : [`진행: ${member.progress}`]),
        ],
      });
    });
  });

  const activeCount = actors.filter((a) => a.state === "running" || a.state === "awaiting" || a.state === "decision").length;
  const attentionCount = actors.filter((a) => a.needsAttention).length;

  return {
    zones,
    actors,
    activeCount,
    totalPopulation: actors.length,
    attentionCount,
  };
}

export function useWorldSnapshot(deps: TheWorldClientDeps): WorldSnapshot {
  const book = useAvatarBook();
  const commodoreRev = useSyncExternalStore(deps.commodore.subscribe, deps.commodore.revision, deps.commodore.revision);
  const commodores = useSyncExternalStore(deps.subscribeCommodores, deps.readCommodores, deps.readCommodores);
  const clusters = useSyncExternalStore(deps.clusters.subscribe, deps.clusters.get, deps.clusters.get);
  const records = useSyncExternalStore(deps.subscribeObjectiveRecords, deps.readObjectiveRecords, deps.readObjectiveRecords);

  return useMemo(
    () => buildWorldSnapshot(deps, book),
    [deps, book, commodoreRev, commodores, clusters, records],
  );
}
