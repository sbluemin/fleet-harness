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
  WorldDemoPopulateMode,
  WorldMissionItem,
  WorldSnapshot,
  WorldZoneSpec,
} from "../shared/world-types.js";
import type { TheWorldClientDeps } from "./deps.js";

/**
 * 실시간 플릿 콘솔 상태(사령관 목록 · Objective 클러스터 · 아바타 북) → 3D 초원 마을 스냅샷 순수 투영기.
 *
 * 실제 사령관·지휘관·구성원이 있으면 저장된 `AvatarBook` 외형 그대로 초원 마을 광장과 각 목장/공방 캠프에 배치하고,
 * 격리 개발 환경처럼 진행 중인 캠프가 비어 있을 때는 `demoMode` 설정에 따라 시뮬레이션 샘플 캠프를 채운다.
 */

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

const DEMO_ACTIVITIES: readonly MongleActivity[] = ["edit", "read", "think", "run", "fetch"];

function resolveLookDetails(book: AvatarBook | null, key: string, fallbackBaseId?: number) {
  const resolved = resolveMongleLook(book, key);
  const baseId = !resolved.stored && fallbackBaseId !== undefined ? fallbackBaseId : resolved.base;
  const spec = mongleBase(baseId);
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
  demoMode: WorldDemoPopulateMode,
  extraDemoOutposts: number,
): WorldSnapshot {
  const commodores = deps.readCommodores();
  const clusters = deps.clusters.get().filter((cluster) => !cluster.row?.commodore && cluster.row?.glyph !== "done");
  const records = deps.readObjectiveRecords();
  const recordById = new Map(records.map((rec) => [rec.id, rec]));

  const zones: WorldZoneSpec[] = [
    {
      id: "plaza-main",
      kind: "plaza",
      label: commodores[0]?.alias ?? commodores[0]?.label ?? "중앙 길드 광장",
      x: 0,
      z: -1.5,
      radius: 10.5,
      roofTone: "moss",
      commodoreId: commodores[0]?.commodoreId,
    },
    {
      id: "garden-east",
      kind: "garden",
      label: commodores[1]?.alias ?? commodores[1]?.label ?? "동쪽 벚꽃 언덕",
      x: 12.5,
      z: 19.6,
      radius: 6.4,
      roofTone: "cerulean",
      commodoreId: commodores[1]?.commodoreId,
    },
  ];

  const actors: WorldActorSpec[] = [];

  // 1. 실제 사령관(Commodores) 투영 (길드 회관 앞마당 및 동쪽 벚꽃 언덕 파빌리온 앞)
  commodores.forEach((row, idx) => {
    const snap = deps.commodore.read(row.commodoreId);
    const view = snap.view;
    const isRunning = view?.run.phase === "turn";
    const hasAsk = snap.asks.length > 0;
    const state: MongleState = hasAsk ? "decision" : isRunning ? "running" : "idle";
    const activity: MongleActivity | null = isRunning ? (view?.run.step ?? "delegate") : null;
    const look = resolveLookDetails(book, commodoreAvatarKey(row.commodoreId), idx === 0 ? 16 : 1);
    const onGarden = idx > 0;
    const angle = idx * 1.3;
    const homeX = onGarden ? 12.5 + Math.cos(angle) * 2.1 : -0.4;
    const homeZ = onGarden ? 19.6 + Math.sin(angle) * 2.1 : -3.5;

    actors.push({
      id: `commodore:${row.commodoreId}`,
      role: "commodore",
      name: row.alias ?? row.label ?? look.defaultNameKo,
      subtitle: `사령관 · ${row.theaters[0]?.label ?? "Theater"}`,
      zoneId: onGarden ? "garden-east" : "plaza-main",
      homeX,
      homeZ,
      baseId: look.baseId,
      shape: look.shape,
      tone: look.tone,
      quaker: look.quaker,
      state,
      activity,
      needsAttention: hasAsk,
      initialSpeech: idx === 0 ? "넓은 초원 본부에 오신 걸 환영해요! ✦" : undefined,
      commodoreId: row.commodoreId,
      summaryLines: [
        `상태: ${isRunning ? "턴 실행 중" : hasAsk ? "질문 응답 대기" : "대기 중"}`,
        `소속 폴더: ${row.theaters.map((th) => th.label).join(", ") || "없음"}`,
      ],
    });
  });

  // 2. 실제 활성 Objective 클러스터(지휘관 + 구성원) 초원 캠프 투영
  const visibleClusters = clusters.slice(0, OUTPOST_SLOTS.length);
  visibleClusters.forEach((cluster, cIdx) => {
    const slot = OUTPOST_SLOTS[cIdx]!;
    const zoneId = `outpost:${cluster.id}`;
    const cmdrObjId = cluster.root ?? cluster.avatarObjectiveId ?? cluster.id;
    const cmdrLook = resolveLookDetails(book, objectiveRecordAvatarKey(cmdrObjId), (cIdx % 14) + 2);
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
      const memLook = resolveLookDetails(book, objectiveRecordAvatarKey(member.objectiveId), ((cIdx * 3 + mIdx + 3) % 15) + 1);
      const awaiting = member.awaitingInput === true || member.progress === "awaiting";
      const running = member.progress === "running";
      const done = member.progress === "done";
      const memState: MongleState = awaiting ? "awaiting" : running ? "running" : done ? "done" : "idle";
      const memAct: MongleActivity | null = running ? DEMO_ACTIVITIES[mIdx % DEMO_ACTIVITIES.length]! : null;

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

  // 3. 시뮬레이션/데모 채우기 (실제 캠프가 없을 때 자동 활성 또는 수동 ON)
  const shouldInjectDemo = demoMode === "on" || (demoMode === "auto" && visibleClusters.length === 0);
  if (shouldInjectDemo) {
    if (commodores.length === 0) {
      actors.push(
        {
          id: "demo:cmdr-tori",
          role: "commodore",
          name: "토리",
          subtitle: "진급 사령관 (Quaker) · fleet-harness",
          zoneId: "plaza-main",
          homeX: -0.5,
          homeZ: -3.5,
          baseId: 16,
          shape: "egg",
          tone: "moss",
          quaker: "tori",
          state: "running",
          activity: "delegate",
          needsAttention: false,
          initialSpeech: "초원 오솔길을 따라 캠프들을 둘러보세요! ✦",
          summaryLines: ["진급 퀘이커 사령관 #16", "초원 본부 지휘 중"],
          isDemo: true,
        },
        {
          id: "demo:cmdr-bori",
          role: "commodore",
          name: "보리",
          subtitle: "진급 사령관 (Quaker) · fleet-desktop",
          zoneId: "garden-east",
          homeX: 10.8,
          homeZ: 18.6,
          baseId: 17,
          shape: "egg",
          tone: "crimson",
          quaker: "bori",
          state: "idle",
          activity: null,
          needsAttention: false,
          summaryLines: ["진급 퀘이커 사령관 #17", "밤이 되면 광장 모닥불로 마실 나옴"],
          isDemo: true,
        },
        {
          id: "demo:cmdr-puff",
          role: "commodore",
          name: "몽이",
          subtitle: "별 배지 사령관 · fleet-docs",
          zoneId: "garden-east",
          homeX: 14.2,
          homeZ: 20.4,
          baseId: 1,
          shape: "bang",
          tone: "cerulean",
          quaker: null,
          state: "idle",
          activity: "think",
          needsAttention: false,
          summaryLines: ["일반 몽글 #1 + 왼쪽 위 금빛 별 배지"],
          isDemo: true,
        },
      );
    }

    const demoCamps: Array<{
      id: string;
      label: string;
      x: number;
      z: number;
      roofTone: IdentityTone;
      fullWorkshop: boolean;
      cmdr: { id: string; base: number; name: string; state: MongleState; speech: string; attention: boolean };
      members: Array<{ id: string; base: number; name: string; act: MongleActivity; state: MongleState; task: string; done: boolean }>;
    }> = [
      {
        id: "demo-outpost-alpha",
        label: "초원 셰이더 공방",
        x: -16.5,
        z: -9.5,
        roofTone: "amber",
        fullWorkshop: true,
        cmdr: { id: "demo:obj-alpha", base: 3, name: "떡이", state: "running", speech: "구성원 4명 전원 가동 중! 📡", attention: false },
        members: [
          { id: "demo:mem-kong", base: 4, name: "콩이", act: "edit", state: "running", task: "1. 몽글 솜결 3D 깊이 통합", done: true },
          { id: "demo:mem-kkot", base: 6, name: "꽃이", act: "read", state: "running", task: "2. 아키텍처 경계 문서 검토", done: false },
          { id: "demo:mem-mandu", base: 10, name: "만두", act: "run", state: "running", task: "3. 60fps 그림자 패스 실행", done: false },
          { id: "demo:mem-gureum", base: 2, name: "구름이", act: "think", state: "running", task: "4. 낮/밤 블룸 조명 조율", done: false },
        ],
      },
      {
        id: "demo-outpost-beta",
        label: "E2E 관측소 캠프",
        x: 16.5,
        z: -8.5,
        roofTone: "rose",
        fullWorkshop: false,
        cmdr: { id: "demo:obj-beta", base: 5, name: "방울이", state: "decision", speech: "📋 완료 기준 확인 부탁해요!", attention: true },
        members: [
          { id: "demo:mem-candy", base: 8, name: "사탕이", act: "fetch", state: "awaiting", task: "1. 포털 다이브/탈출 E2E 시나리오", done: false },
        ],
      },
    ];

    for (let extra = 0; extra < extraDemoOutposts; extra += 1) {
      const slot = OUTPOST_SLOTS[2 + extra];
      if (!slot) break;
      const baseNum = 12 + extra;
      const mb = mongleBase(baseNum);
      demoCamps.push({
        id: `demo-outpost-extra-${extra}`,
        label: `초원 개척 캠프 #${extra + 3}`,
        x: slot.x,
        z: slot.z,
        roofTone: slot.roofTone,
        fullWorkshop: extra % 2 === 0,
        cmdr: { id: `demo:obj-extra-${extra}`, base: baseNum, name: mb.name.ko, state: "running", speech: "새 초원 공방 캠프 개설 완료! ⛺", attention: false },
        members: [
          { id: `demo:mem-extra-${extra}`, base: baseNum + 1, name: mongleBase(baseNum + 1).name.ko, act: "edit", state: "running", task: "1. 신규 모듈 초기 구현", done: false },
        ],
      });
    }

    demoCamps.forEach((camp) => {
      // 이미 해당 위치 근처에 실제 Objective 캠프가 있다면 스킵하지 않고 비어 있는 다음 초원 슬롯으로 배치!
      let targetX = camp.x;
      let targetZ = camp.z;
      if (zones.some((z) => Math.hypot(z.x - targetX, z.z - targetZ) < 6.0)) {
        const freeSlot = OUTPOST_SLOTS.find((s) => !zones.some((z) => Math.hypot(z.x - s.x, z.z - s.z) < 6.0));
        if (!freeSlot) return;
        targetX = freeSlot.x;
        targetZ = freeSlot.z;
      }

      zones.push({
        id: camp.id,
        kind: "outpost",
        label: camp.label,
        x: targetX,
        z: targetZ,
        radius: 6.4,
        roofTone: camp.roofTone,
        fullWorkshop: camp.fullWorkshop,
      });

      const cb = mongleBase(camp.cmdr.base);
      actors.push({
        id: camp.cmdr.id,
        role: "commander",
        name: camp.cmdr.name,
        subtitle: `지휘관 · ${camp.label}`,
        zoneId: camp.id,
        homeX: targetX + 0.55,
        homeZ: targetZ + 1.15,
        baseId: cb.id,
        shape: cb.shape,
        tone: cb.tone,
        quaker: null,
        state: camp.cmdr.state,
        activity: "delegate",
        needsAttention: camp.cmdr.attention,
        initialSpeech: camp.cmdr.speech,
        missions: camp.members.map((m) => ({ id: m.id, label: m.task, done: m.done, active: !m.done })),
        summaryLines: [`초원 캠프: ${camp.label}`, `가동 구성원: ${camp.members.length}명`],
        isDemo: true,
      });

      camp.members.forEach((m, idx) => {
        const off = MEMBER_OFFSETS[idx]!;
        const mb = mongleBase(m.base);
        actors.push({
          id: m.id,
          role: "member",
          name: m.name,
          subtitle: `구성원 · ${m.task}`,
          zoneId: camp.id,
          homeX: targetX + off.dx,
          homeZ: targetZ + off.dz,
          baseId: mb.id,
          shape: mb.shape,
          tone: mb.tone,
          quaker: null,
          state: m.state,
          activity: m.act,
          needsAttention: m.state === "awaiting",
          initialSpeech: m.state === "awaiting" ? "🔔 실행 승인 기다려요!" : undefined,
          summaryLines: [`담당 임무: ${m.task}`, `현재 소품 연기: ${m.act}`],
          isDemo: true,
        });
      });
    });
  }

  const activeCount = actors.filter((a) => a.state === "running" || a.state === "awaiting" || a.state === "decision").length;
  const attentionCount = actors.filter((a) => a.needsAttention).length;

  return {
    zones,
    actors,
    activeCount,
    totalPopulation: actors.length,
    attentionCount,
    usingDemoActors: shouldInjectDemo,
  };
}

export function useWorldSnapshot(deps: TheWorldClientDeps, demoMode: WorldDemoPopulateMode, extraDemoOutposts: number): WorldSnapshot {
  const book = useAvatarBook();
  const commodoreRev = useSyncExternalStore(deps.commodore.subscribe, deps.commodore.revision, deps.commodore.revision);
  const commodores = useSyncExternalStore(deps.subscribeCommodores, deps.readCommodores, deps.readCommodores);
  const clusters = useSyncExternalStore(deps.clusters.subscribe, deps.clusters.get, deps.clusters.get);
  const records = useSyncExternalStore(deps.subscribeObjectiveRecords, deps.readObjectiveRecords, deps.readObjectiveRecords);

  return useMemo(
    () => buildWorldSnapshot(deps, book, demoMode, extraDemoOutposts),
    [deps, book, demoMode, extraDemoOutposts, commodoreRev, commodores, clusters, records],
  );
}
