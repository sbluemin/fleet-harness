import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from "three";

import { PLUSH_VIVID_TONES } from "../../../workspace/shared/mongle-3d-glsl.js";
import type {
  WorldActorEmote,
  WorldActorSpec,
  WorldChoreographyCommand,
  WorldVillageSpec,
} from "../../shared/world-types.js";

/**
 * 사령관 · 지휘관 · 구성원 자율 생활 생태계 및 합동 연출 디렉터.
 *
 * - 건물·연못·우물·모닥불 슬라이딩 충돌 회피(`resolveMovement`) + 캐릭터 간 자연스러운 거리 유지(소프트 분리)
 * - 야간 모닥불 집결(광장 모닥불 2.8, 1.0 둘레 반원 착석), 플레이어 근접 시선 마주치기
 * - 목표 하달 · 전령 보고 하이파이브 · 선후행 바통 터치 · 완수 축포 연출
 */

export interface LiveActorMotion {
  spec: WorldActorSpec;
  x: number;
  z: number;
  tx: number;
  tz: number;
  yaw: number;
  moving: boolean;
  carrying: boolean;
  hopBoost: number;
  speech: string;
  speechTimer: number;
}

interface FlyingProjectile {
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  t: number;
  speed: number;
  arcHeight: number;
  trailColorHex: number | null;
  mesh: Mesh;
  onArrive?: (() => void) | undefined;
}

interface BurstParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  scale: number;
  life: number;
  maxLife: number;
  colorHex: number;
  glowBoost: number;
}

export type WorkshopFxKind = "smoke" | "spark" | "pulse" | "alert" | "ask";

interface PatrolWaypoint {
  readonly x: number;
  readonly z: number;
  readonly faceX: number;
  readonly faceZ: number;
  readonly districtId?: string | undefined;
}

interface VillagePatrolPlan {
  readonly commodoreId: string;
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  readonly plazaPoint: PatrolWaypoint;
  readonly gateExit: PatrolWaypoint;
  readonly districtPoints: readonly PatrolWaypoint[];
  readonly workTarget: PatrolWaypoint | null;
  readonly villageWorkStep: string | null;
}

interface ActorPatrolState {
  waitTimer: number;
  nextDistrictIdx: number;
  awayFromHome: boolean;
  startWithExcursion: boolean;
  route: PatrolWaypoint[];
  faceX: number | null;
  faceZ: number | null;
  lastX: number;
  lastZ: number;
  stuckTimer: number;
  greetCooldown: number;
  workingCommute: boolean;
  lastWorkDistrictId: string | null;
}

function brookCenterZAt(x: number): number {
  return 9.2 + Math.sin(x * 0.095) * 2.9 + Math.cos(x * 0.04) * 1.1;
}

function makeBridgeCrossing(x: number, yaw: number): {
  readonly x: number;
  readonly z: number;
  readonly north: PatrolWaypoint;
  readonly mid: PatrolWaypoint;
  readonly south: PatrolWaypoint;
} {
  const cz = brookCenterZAt(x);
  const pondBell = Math.exp(-Math.pow((x - 5.8) / 4.8, 2));
  const halfSpan = 1.45 + pondBell * 2.15 + 2.85;
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  const northX = x - sinY * halfSpan;
  const northZ = cz - cosY * halfSpan;
  const southX = x + sinY * halfSpan;
  const southZ = cz + cosY * halfSpan;
  return {
    x,
    z: cz,
    north: { x: northX, z: northZ, faceX: x, faceZ: cz },
    mid: { x, z: cz, faceX: southX, faceZ: southZ },
    south: { x: southX, z: southZ, faceX: x, faceZ: cz },
  };
}

const BRIDGE_CROSSINGS = [
  makeBridgeCrossing(8.6, 0.34),
  makeBridgeCrossing(-11.5, -0.26),
] as const;

const MEADOW_EXCURSION_SPOTS: readonly PatrolWaypoint[] = [
  // 중앙 길드 회관 앞 광장
  { x: -0.4, z: -0.9, faceX: 0, faceZ: -5.2 },
  { x: 1.6, z: -1.4, faceX: 0, faceZ: -5.2 },
  // 제독 퀘스트 게시판 구경
  { x: 3.4, z: -2.1, faceX: 4.8, faceZ: -3.4 },
  // 중앙 모닥불 둘레
  { x: 1.1, z: 1.5, faceX: 2.8, faceZ: 1.0 },
  { x: 4.4, z: 1.6, faceX: 2.8, faceZ: 1.0 },
  // 중앙 우물 & 이정표
  { x: -2.3, z: -1.9, faceX: -3.9, faceZ: -3.5 },
  // 시냇물 북안 산책로 (동/서 목교 앞)
  { x: 5.8, z: 5.5, faceX: 8.2, faceZ: 11.5 },
  { x: -10.2, z: 2.6, faceX: -11.5, faceZ: 7.6 },
  // 남쪽 강변 & 벚꽃 언덕 산책
  { x: 10.6, z: 19.0, faceX: 8.6, faceZ: 12.4 },
  { x: -9.8, z: 13.8, faceX: -11.5, faceZ: 7.6 },
];

const CAMPFIRE_NIGHT_SPOTS: readonly PatrolWaypoint[] = [
  { x: 1.1, z: 1.3, faceX: 2.8, faceZ: 1.0 },
  { x: 2.6, z: 3.1, faceX: 2.8, faceZ: 1.0 },
  { x: 4.5, z: 1.5, faceX: 2.8, faceZ: 1.0 },
  { x: 1.4, z: -0.5, faceX: 2.8, faceZ: 1.0 },
];

export interface ChoreographyDirector {
  readonly motions: Map<string, LiveActorMotion>;
  celebratingTimer: number;
  hasActiveFx(): boolean;
  syncActors(specs: readonly WorldActorSpec[]): void;
  /** 사령관별 마을 중앙 광장 ↔ Theater 구역 입구 산책·현장 출근 경로를 동기화한다. */
  syncVillagePatrols(villages: readonly WorldVillageSpec[]): void;
  applySpeech(actorId: string, text: string): void;
  playEmote(actorId: string, emote: WorldActorEmote, playerPos: Vector3): void;
  handleCommand(cmd: WorldChoreographyCommand): boolean;
  spawnBurst(x: number, y: number, z: number, colorHex: number, count?: number): void;
  spawnDust(x: number, y: number, z: number): void;
  /** 구역/마을 레벨업 축하 황금 다중 불꽃 + 상승 빛입자 축포 (기존 InstancedMesh 풀 재사용). */
  spawnLevelUpCelebration(x: number, z: number, colorHex?: number): void;
  /** 사령관/구역 실시간 작업 단계별 공방 파티클 FX (단일 InstancedMesh 풀, 0 할당). */
  emitWorkshopFx(x: number, y: number, z: number, kind: WorkshopFxKind): void;
  /** 두 마을/구역 사이로 빛나는 전령 비행 아크를 발사한다 (단일 캐시 머티리얼 + 트레일 입자). */
  spawnCourierArc(fromX: number, fromZ: number, toX: number, toZ: number, colorHex?: number): void;
  update(
    dt: number,
    elapsed: number,
    nightFactor: number,
    playerPos: Vector3,
    focusedActorId: string | null,
    isWalkable: (x: number, z: number) => boolean,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
  ): string | null;
  dispose(): void;
}

const MAX_PARTICLES = 384;

export function createChoreographyDirector(scene: Scene): ChoreographyDirector {
  const fxGroup = new Group();
  scene.add(fxGroup);

  const motions = new Map<string, LiveActorMotion>();
  let motionList: LiveActorMotion[] = [];
  const villagePatrolPlans = new Map<string, VillagePatrolPlan>();
  const patrolStates = new Map<string, ActorPatrolState>();
  const projectiles: FlyingProjectile[] = [];
  const particles: BurstParticle[] = [];
  const pendingTimers = new Set<number>();

  const projGeo = new BoxGeometry(0.36, 0.14, 0.52);
  const partGeo = new SphereGeometry(0.11, 8, 6);
  const projMatCache = new Map<number, MeshStandardMaterial>();

  const particleMat = new MeshBasicMaterial({ color: 0xffffff });
  const particleInstanced = new InstancedMesh(partGeo, particleMat, MAX_PARTICLES);
  particleInstanced.instanceMatrix.setUsage(DynamicDrawUsage);
  particleInstanced.frustumCulled = false;
  particleInstanced.count = 0;
  particleInstanced.visible = false;
  fxGroup.add(particleInstanced);

  const pMat4 = new Matrix4();
  const pPos = new Vector3();
  const pQuat = new Quaternion();
  const pScale = new Vector3();
  const pColor = new Color();

  function getProjectileMaterial(colorHex: number): MeshStandardMaterial {
    let mat = projMatCache.get(colorHex);
    if (!mat) {
      mat = new MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 1.15, roughness: 0.3 });
      projMatCache.set(colorHex, mat);
    }
    return mat;
  }

  function pushParticle(p: BurstParticle): void {
    if (particles.length >= MAX_PARTICLES) {
      // 풀 가득 시 가장 오래된 입자를 덮어써 메모리·draw call 상한을 일정하게 유지한다.
      particles[0] = p;
      return;
    }
    particles.push(p);
  }

  function scheduleTimeout(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      pendingTimers.delete(id);
      fn();
    }, ms);
    pendingTimers.add(id);
  }

  function spawnBurst(x: number, y: number, z: number, colorHex: number, count = 18) {
    for (let i = 0; i < count; i += 1) {
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 2.0 + Math.random() * 3.2;
      const col = i % 3 === 0 ? 0xfde047 : i % 3 === 1 ? colorHex : 0x7dd3fc;
      pushParticle({
        x,
        y,
        z,
        vx: Math.cos(ang) * spd,
        vy: 3.1 + Math.random() * 3.2,
        vz: Math.sin(ang) * spd,
        gravity: 4.2,
        scale: 0.75 + Math.random() * 0.65,
        life: 1.05,
        maxLife: 1.05,
        colorHex: col,
        glowBoost: 1.35,
      });
    }
  }

  function spawnDust(x: number, y: number, z: number) {
    pushParticle({
      x,
      y,
      z,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.5 + Math.random() * 0.35,
      vz: (Math.random() - 0.5) * 0.6,
      gravity: 1.8,
      scale: 0.8,
      life: 0.40,
      maxLife: 0.40,
      colorHex: 0xf1f5f9,
      glowBoost: 1.0,
    });
  }

  function emitWorkshopFx(x: number, y: number, z: number, kind: WorkshopFxKind) {
    if (kind === "smoke") {
      pushParticle({
        x: x + (Math.random() - 0.5) * 0.25,
        y,
        z: z + (Math.random() - 0.5) * 0.25,
        vx: 0.22 + (Math.random() - 0.5) * 0.28,
        vy: 0.95 + Math.random() * 0.45,
        vz: -0.14 + (Math.random() - 0.5) * 0.25,
        gravity: -0.25,
        scale: 1.15 + Math.random() * 0.55,
        life: 1.45,
        maxLife: 1.45,
        colorHex: 0xe2e8f0,
        glowBoost: 1.0,
      });
      return;
    }

    if (kind === "spark") {
      const count = 2;
      for (let i = 0; i < count; i += 1) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 0.9 + Math.random() * 1.4;
        pushParticle({
          x: x + (Math.random() - 0.5) * 0.3,
          y,
          z: z + (Math.random() - 0.5) * 0.3,
          vx: Math.cos(ang) * spd,
          vy: 2.3 + Math.random() * 1.6,
          vz: Math.sin(ang) * spd,
          gravity: 5.8,
          scale: 0.55 + Math.random() * 0.35,
          life: 0.52,
          maxLife: 0.52,
          colorHex: i === 0 ? 0xfbbf24 : 0xf97316,
          glowBoost: 1.5,
        });
      }
      return;
    }

    if (kind === "pulse") {
      const ang = Math.random() * Math.PI * 2;
      pushParticle({
        x: x + Math.cos(ang) * 0.45,
        y,
        z: z + Math.sin(ang) * 0.45,
        vx: Math.cos(ang) * 0.25,
        vy: 1.45 + Math.random() * 0.75,
        vz: Math.sin(ang) * 0.25,
        gravity: -0.15,
        scale: 0.72 + Math.random() * 0.35,
        life: 0.92,
        maxLife: 0.92,
        colorHex: 0x38bdf8,
        glowBoost: 1.45,
      });
      return;
    }

    if (kind === "alert") {
      const ang = Math.random() * Math.PI * 2;
      pushParticle({
        x: x + Math.cos(ang) * 0.32,
        y,
        z: z + Math.sin(ang) * 0.32,
        vx: Math.cos(ang) * 0.75,
        vy: 2.0 + Math.random() * 0.95,
        vz: Math.sin(ang) * 0.75,
        gravity: 3.4,
        scale: 0.78 + Math.random() * 0.32,
        life: 0.75,
        maxLife: 0.75,
        colorHex: 0xf43f5e,
        glowBoost: 1.55,
      });
      return;
    }

    // "ask" — 황금빛 질문 반짝임
    const ang = Math.random() * Math.PI * 2;
    pushParticle({
      x: x + Math.cos(ang) * 0.38,
      y,
      z: z + Math.sin(ang) * 0.38,
      vx: Math.cos(ang) * 0.18,
      vy: 1.35 + Math.random() * 0.65,
      vz: Math.sin(ang) * 0.18,
      gravity: -0.1,
      scale: 0.8 + Math.random() * 0.3,
      life: 1.05,
      maxLife: 1.05,
      colorHex: 0xfde047,
      glowBoost: 1.55,
    });
  }

  function launchProjectile(
    sx: number,
    sz: number,
    tx: number,
    tz: number,
    colorHex: number,
    speed: number,
    onArrive?: () => void,
    arcHeight = 3.5,
    trailColorHex: number | null = null,
  ) {
    const mesh = new Mesh(projGeo, getProjectileMaterial(colorHex));
    mesh.position.set(sx, 1.35, sz);
    fxGroup.add(mesh);
    projectiles.push({ sx, sz, tx, tz, t: 0, speed, arcHeight, trailColorHex, mesh, onArrive });
  }

  function spawnCourierArc(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    colorHex = 0x38bdf8,
  ) {
    const dist = Math.hypot(toX - fromX, toZ - fromZ);
    if (dist < 0.5) return;
    const arcHeight = Math.max(3.6, Math.min(8.8, dist * 0.24));
    const speed = Math.max(0.42, Math.min(1.15, 16 / Math.max(8, dist)));
    launchProjectile(
      fromX,
      fromZ,
      toX,
      toZ,
      colorHex,
      speed,
      () => {
        spawnBurst(toX, 1.65, toZ, colorHex, 10);
      },
      arcHeight,
      colorHex,
    );
  }

  function spawnLevelUpCelebration(x: number, z: number, colorHex = 0xfbbf24) {
    director.celebratingTimer = Math.max(director.celebratingTimer, 3.6);

    const emitStarburst = (bx: number, by: number, bz: number, count: number, burstScale: number) => {
      for (let i = 0; i < count; i += 1) {
        const ang = (i / count) * Math.PI * 2 + Math.random() * 0.35;
        const elev = 0.25 + Math.random() * 0.85;
        const spd = (2.1 + Math.random() * 3.1) * burstScale;
        const col = i % 4 === 0 ? 0xfef08a : i % 4 === 1 ? 0xfbbf24 : i % 4 === 2 ? colorHex : 0xffffff;
        pushParticle({
          x: bx,
          y: by,
          z: bz,
          vx: Math.cos(ang) * spd * Math.cos(elev),
          vy: 2.6 + Math.sin(elev) * spd * 1.15,
          vz: Math.sin(ang) * spd * Math.cos(elev),
          gravity: 4.1,
          scale: 0.78 + Math.random() * 0.62,
          life: 1.25 + Math.random() * 0.35,
          maxLife: 1.6,
          colorHex: col,
          glowBoost: 1.75,
        });
      }
    };

    // 1단계: 지상 중앙 황금 축포 + 상승 빛입자 회오리
    emitStarburst(x, 1.5, z, 28, 1.0);
    for (let i = 0; i < 18; i += 1) {
      const ang = (i / 18) * Math.PI * 2;
      const rad = 0.8 + (i % 3) * 0.55;
      pushParticle({
        x: x + Math.cos(ang) * rad,
        y: 0.35 + (i % 4) * 0.38,
        z: z + Math.sin(ang) * rad,
        vx: -Math.sin(ang) * 0.65,
        vy: 1.9 + Math.random() * 1.25,
        vz: Math.cos(ang) * 0.65,
        gravity: -0.35,
        scale: 0.68 + Math.random() * 0.38,
        life: 1.5 + Math.random() * 0.45,
        maxLife: 1.95,
        colorHex: i % 2 === 0 ? 0xfde047 : colorHex,
        glowBoost: 1.65,
      });
    }

    // 인근 사령관/구성원 기쁨 점프
    for (const m of motionList) {
      if (Math.hypot(m.x - x, m.z - z) < 9.5) {
        m.hopBoost = Math.max(m.hopBoost, 1.65);
      }
    }

    // 2~3단계: 공중 다중 황금 불꽃 연쇄 개화 (기존 InstancedMesh 풀 재사용, 머티리얼 생성 0)
    scheduleTimeout(() => {
      emitStarburst(x + 0.75, 2.9, z - 0.55, 22, 0.92);
    }, 260);
    scheduleTimeout(() => {
      emitStarburst(x - 0.7, 3.25, z + 0.55, 24, 0.96);
    }, 540);
  }

  let patrolSpawnOrder = 0;

  function buildWorldRoute(
    fromX: number,
    fromZ: number,
    dest: PatrolWaypoint,
    ownVillage: VillagePatrolPlan,
    destVillage: VillagePatrolPlan | null,
  ): PatrolWaypoint[] {
    const waypoints: PatrolWaypoint[] = [];
    const inOwnVillage = Math.hypot(fromX - ownVillage.centerX, fromZ - ownVillage.centerZ) < ownVillage.radius + 0.8;
    const destInOwnVillage = Math.hypot(dest.x - ownVillage.centerX, dest.z - ownVillage.centerZ) < ownVillage.radius + 0.8;

    let curX = fromX;
    let curZ = fromZ;

    // 1. 자기 마을 안에서 바깥으로 외출할 땐 정문 바깥을 경유해 담장을 돌아 나간다
    if (inOwnVillage && !destInOwnVillage) {
      waypoints.push(ownVillage.gateExit);
      curX = ownVillage.gateExit.x;
      curZ = ownVillage.gateExit.z;
    }

    // 2. 도착지가 특정 마을 안쪽이면 그 마을 정문 바깥을 먼저 경유할 예정
    const targetApproachX = destVillage && destVillage !== ownVillage
      ? destVillage.gateExit.x
      : destInOwnVillage && !inOwnVillage
        ? ownVillage.gateExit.x
        : dest.x;
    const targetApproachZ = destVillage && destVillage !== ownVillage
      ? destVillage.gateExit.z
      : destInOwnVillage && !inOwnVillage
        ? ownVillage.gateExit.z
        : dest.z;

    // 3. 시냇물 북쪽↔남쪽을 건너야 하면 가장 가까운 아치 목교 3단 포인트(진입→중앙→출구)를 경유한다
    const curSouth = curZ > brookCenterZAt(curX);
    const dstSouth = targetApproachZ > brookCenterZAt(targetApproachX);
    if (curSouth !== dstSouth) {
      const midX = (curX + targetApproachX) * 0.5;
      const bridge = Math.abs(midX - BRIDGE_CROSSINGS[0].x) <= Math.abs(midX - BRIDGE_CROSSINGS[1].x)
        ? BRIDGE_CROSSINGS[0]
        : BRIDGE_CROSSINGS[1];
      if (curSouth) {
        waypoints.push(bridge.south, bridge.mid, bridge.north);
      } else {
        waypoints.push(bridge.north, bridge.mid, bridge.south);
      }
    }

    // 4. 목적지 마을 정문 진입 경유
    if (destVillage && destVillage !== ownVillage) {
      waypoints.push(destVillage.gateExit);
    } else if (destInOwnVillage && !inOwnVillage) {
      waypoints.push(ownVillage.gateExit);
    }

    waypoints.push(dest);
    return waypoints;
  }

  function syncVillagePatrols(villages: readonly WorldVillageSpec[]) {
    villagePatrolPlans.clear();
    for (const v of villages) {
      const gateCos = Math.cos(v.gateAngle);
      const gateSin = Math.sin(v.gateAngle);
      const plazaPoint: PatrolWaypoint = {
        x: v.x + gateCos * 1.15,
        z: v.z + gateSin * 1.15,
        faceX: v.x + gateCos * 6.5,
        faceZ: v.z + gateSin * 6.5,
      };
      const gateExit: PatrolWaypoint = {
        x: v.x + gateCos * (v.radius + 2.35),
        z: v.z + gateSin * (v.radius + 2.35),
        faceX: v.x + gateCos * (v.radius + 7.5),
        faceZ: v.z + gateSin * (v.radius + 7.5),
      };

      const districtPoints: PatrolWaypoint[] = [];
      let activeWorkPoint: PatrolWaypoint | null = null;
      let highestTierPoint: PatrolWaypoint | null = null;
      let bestTier = -1;
      let bestEntries = -1;

      for (const d of v.districts) {
        const toCenterX = v.x - d.x;
        const toCenterZ = v.z - d.z;
        const len = Math.hypot(toCenterX, toCenterZ);
        const dirX = len > 0.01 ? toCenterX / len : Math.sin(d.rotationY);
        const dirZ = len > 0.01 ? toCenterZ / len : Math.cos(d.rotationY);
        // 건물 콜라이더(d.radius * 0.42 + actor 0.46) 바깥쪽 건물 정면 마당에 서도록 배치
        const standDist = Math.max(1.85, Math.min(d.radius * 0.78, 2.7));
        const wp: PatrolWaypoint = {
          x: d.x + dirX * standDist,
          z: d.z + dirZ * standDist,
          faceX: d.x,
          faceZ: d.z,
          districtId: d.id,
        };
        districtPoints.push(wp);

        if (!activeWorkPoint && (d.activeWorkStep !== null || d.needsAttention || d.hasError)) {
          activeWorkPoint = wp;
        }
        if (d.tier > bestTier || (d.tier === bestTier && d.totalEntries > bestEntries)) {
          bestTier = d.tier;
          bestEntries = d.totalEntries;
          highestTierPoint = wp;
        }
      }

      // 마을 정문 안쪽 맞이 광장 & 좌우 산책 포인트를 추가해 1구역/0구역 마을도 활기차게 순회하도록 구성
      const strollRad = Math.max(2.6, Math.min(v.radius * 0.56, 5.2));
      const gateLookout: PatrolWaypoint = {
        x: v.x + gateCos * strollRad,
        z: v.z + gateSin * strollRad,
        faceX: v.x + gateCos * (v.radius + 4),
        faceZ: v.z + gateSin * (v.radius + 4),
      };
      const leftAngle = v.gateAngle + 1.05;
      const rightAngle = v.gateAngle - 1.05;
      districtPoints.push(
        gateLookout,
        {
          x: v.x + Math.cos(leftAngle) * (strollRad * 0.85),
          z: v.z + Math.sin(leftAngle) * (strollRad * 0.85),
          faceX: v.x,
          faceZ: v.z,
        },
        {
          x: v.x + Math.cos(rightAngle) * (strollRad * 0.85),
          z: v.z + Math.sin(rightAngle) * (strollRad * 0.85),
          faceX: v.x,
          faceZ: v.z,
        },
      );

      villagePatrolPlans.set(v.commodoreId, {
        commodoreId: v.commodoreId,
        centerX: v.x,
        centerZ: v.z,
        radius: v.radius,
        plazaPoint,
        gateExit,
        districtPoints,
        workTarget: activeWorkPoint ?? highestTierPoint,
        villageWorkStep: v.workStep,
      });
    }
  }

  function getOrCreatePatrolState(m: LiveActorMotion): ActorPatrolState {
    let st = patrolStates.get(m.spec.id);
    if (!st) {
      const order = patrolSpawnOrder++;
      st = {
        // 입장 직후 0.4~1.8초 내 바로 출발 — 절반의 사령관은 첫 이동부터 광장/이웃 마을로 마실 나감!
        waitTimer: 0.4 + (order % 4) * 0.35 + Math.random() * 0.45,
        nextDistrictIdx: Math.floor(Math.random() * 6),
        awayFromHome: false,
        startWithExcursion: order % 2 === 0,
        route: [],
        faceX: null,
        faceZ: null,
        lastX: m.x,
        lastZ: m.z,
        stuckTimer: 0,
        greetCooldown: 0,
        workingCommute: false,
        lastWorkDistrictId: null,
      };
      patrolStates.set(m.spec.id, st);
    }
    return st;
  }

  let lastCommandNonce = 0;

  const director: ChoreographyDirector = {
    motions,
    celebratingTimer: 0,
    hasActiveFx() {
      return projectiles.length > 0 || director.celebratingTimer > 0;
    },
    syncActors(specs) {
      const nextIds = new Set(specs.map((s) => s.id));
      for (const id of [...motions.keys()]) {
        if (!nextIds.has(id)) {
          motions.delete(id);
          patrolStates.delete(id);
        }
      }
      for (const spec of specs) {
        const existing = motions.get(spec.id);
        if (existing) {
          existing.spec = spec;
        } else {
          motions.set(spec.id, {
            spec,
            x: spec.homeX,
            z: spec.homeZ,
            tx: spec.homeX,
            tz: spec.homeZ,
            yaw: 0.15,
            moving: false,
            carrying: false,
            hopBoost: 0.8,
            speech: spec.initialSpeech ?? "",
            speechTimer: spec.initialSpeech ? (spec.needsAttention ? 999 : 5.5) : 0,
          });
        }
      }
      motionList = [...motions.values()];
    },
    syncVillagePatrols,
    applySpeech(actorId, text) {
      const m = motions.get(actorId);
      if (!m) return;
      const alreadySpeaking = m.speechTimer > 0.5 && m.speech.length > 0;
      m.speech = text;
      m.speechTimer = 6.2;
      if (!alreadySpeaking) {
        m.hopBoost = Math.max(m.hopBoost, 1.15);
      }
    },
    playEmote(actorId, emote, playerPos) {
      const m = motions.get(actorId);
      if (!m) return;
      m.tx = m.x;
      m.tz = m.z;
      m.yaw = Math.atan2(playerPos.x - m.x, playerPos.z - m.z);
      if (emote === "greet") {
        m.hopBoost = 1.45;
        m.speech = m.spec.role === "commodore"
          ? "[greet] 반가워요 제독님! 오늘 작전은 무엇인가요?"
          : m.spec.role === "commander"
            ? "[rally] 충성! 작전 구역 이상 없습니다!"
            : "[greet] 안녕하세요! 맡은 임무 진행 중이에요!";
        m.speechTimer = 3.8;
        spawnBurst(m.x, 1.55, m.z, 0x38bdf8, 16);
      } else if (emote === "cheer") {
        m.hopBoost = 1.8;
        m.speech = "[cheer] 힘이 불끈 나네요! 맡겨만 주세요!";
        m.speechTimer = 3.8;
        spawnBurst(m.x, 1.65, m.z, 0xfbbf24, 22);
      } else {
        m.hopBoost = 1.75;
        m.speech = "[highfive] 점프 하이파이브! 최고의 호흡이에요!";
        m.speechTimer = 3.8;
        spawnBurst((m.x + playerPos.x) * 0.5, 1.6, (m.z + playerPos.z) * 0.5, 0xe879f9, 22);
      }
    },
    spawnBurst,
    spawnDust,
    spawnLevelUpCelebration,
    emitWorkshopFx,
    spawnCourierArc,
    handleCommand(cmd) {
      if (cmd.nonce === lastCommandNonce) return false;
      lastCommandNonce = cmd.nonce;

      const all = [...motions.values()];
      const commodore = all.find((m) => m.spec.role === "commodore");
      // 구성원이 있는 캠프 지휘관을 우선 선택해 협동 연출이 풍부하게 보이도록 함
      const commander = all.find(
        (m) => m.spec.role === "commander"
          && (!cmd.outpostId || m.spec.zoneId === cmd.outpostId)
          && all.some((sub) => sub.spec.role === "member" && sub.spec.zoneId === m.spec.zoneId),
      ) ?? all.find((m) => m.spec.role === "commander" && (!cmd.outpostId || m.spec.zoneId === cmd.outpostId))
        ?? all.find((m) => m.spec.role === "commander");
      const campMembers = commander
        ? all.filter((m) => m.spec.role === "member" && m.spec.zoneId === commander.spec.zoneId)
        : [];

      if (cmd.kind === "delegate" && commodore && commander) {
        commodore.hopBoost = 1.4;
        commodore.speech = "[quest] 새 작전 청사진 발송!";
        commodore.speechTimer = 3.5;

        launchProjectile(commodore.x, commodore.z, commander.x, commander.z, 0xfbbf24, 1.05, () => {
          commander.hopBoost = 1.45;
          commander.speech = "[rally] 전원 브리핑 테이블 앞 집결!";
          commander.speechTimer = 3.6;
          spawnBurst(commander.x, 1.5, commander.z, 0xf59e0b, 16);

          campMembers.forEach((mem, idx) => {
            const ang = idx * 0.85 - 0.8;
            mem.tx = commander.spec.homeX + Math.cos(ang) * 1.95;
            mem.tz = commander.spec.homeZ + 0.8 + Math.sin(ang) * 1.45;
            mem.speech = "[cheer] 집결 완료!";
            mem.speechTimer = 2.4;
          });

          scheduleTimeout(() => {
            campMembers.forEach((mem) => {
              const rgb = PLUSH_VIVID_TONES[mem.spec.tone];
              const hex = new Color(rgb[0], rgb[1], rgb[2]).getHex();
              launchProjectile(commander.x, commander.z, mem.spec.homeX, mem.spec.homeZ, hex, 1.5);
              mem.tx = mem.spec.homeX;
              mem.tz = mem.spec.homeZ;
              mem.hopBoost = 1.15;
            });
          }, 1_600);
        });
        return true;
      } else if (cmd.kind === "report" && commander) {
        const runner = campMembers[0] ?? all.find((m) => m.spec.id !== commander.spec.id);
        if (!runner) return false;
        runner.carrying = true;
        runner.speech = "[gift] 결과물 보고 갑니다!";
        runner.speechTimer = 3.5;
        runner.tx = commander.x - 1.1;
        runner.tz = commander.z + 0.45;

        scheduleTimeout(() => {
          runner.carrying = false;
          runner.hopBoost = 1.65;
          commander.hopBoost = 1.65;
          runner.speech = "[highfive] 점프 하이파이브!";
          commander.speech = `[greet] 수고했어 ${runner.spec.name}!`;
          runner.speechTimer = 3.0;
          commander.speechTimer = 3.0;
          spawnBurst((commander.x + runner.x) * 0.5, 1.6, (commander.z + runner.z) * 0.5, 0xe879f9, 24);
          scheduleTimeout(() => {
            runner.tx = runner.spec.homeX;
            runner.tz = runner.spec.homeZ;
          }, 1_400);
        }, 1_650);
        return true;
      } else if (cmd.kind === "handoff") {
        const pair = campMembers.length >= 2 ? campMembers : all.slice(0, 2);
        if (pair.length < 2) return false;
        const m1 = pair[0]!;
        const m2 = pair[1]!;
        const midX = (m1.spec.homeX + m2.spec.homeX) * 0.5;
        const midZ = (m1.spec.homeZ + m2.spec.homeZ) * 0.5;
        m1.carrying = true;
        m1.speech = "[baton] 커밋 바통 전달!";
        m1.speechTimer = 3.0;
        m1.tx = midX - 0.65;
        m1.tz = midZ;
        m2.tx = midX + 0.65;
        m2.tz = midZ;

        scheduleTimeout(() => {
          m1.carrying = false;
          m1.hopBoost = 1.45;
          m2.hopBoost = 1.45;
          m2.speech = "[tool] 바통 인수! 검증 시작!";
          m2.speechTimer = 3.2;
          spawnBurst(midX, 1.45, midZ, 0x38bdf8, 22);
          scheduleTimeout(() => {
            m1.tx = m1.spec.homeX;
            m1.tz = m1.spec.homeZ;
            m2.tx = m2.spec.homeX;
            m2.tz = m2.spec.homeZ;
          }, 1_350);
        }, 1_450);
        return true;
      } else if (cmd.kind === "celebrate") {
        if (all.length === 0) return false;
        director.celebratingTimer = 4.0;
        for (const m of all) {
          m.hopBoost = 1.7;
          m.speech = m.spec.role === "commodore" ? "[party] 초원 전 함대 목표 완수!" : "[party] 만세!! 성공이다!";
          m.speechTimer = 3.8;
        }
        spawnBurst(0, 2.4, -1.5, 0x74cc6e, 28);
        if (commander) spawnBurst(commander.x, 2.3, commander.z, 0xf59e0b, 26);
        return true;
      }
      return false;
    },
    update(dt, elapsed, nightFactor, playerPos, focusedActorId, isWalkable, resolveMovement) {
      if (director.celebratingTimer > 0) {
        director.celebratingTimer = Math.max(0, director.celebratingTimer - dt);
      }

      const isNight = nightFactor > 0.72;
      let nearestId: string | null = null;
      let nearestDist = 4.6;

      for (let idx = 0; idx < motionList.length; idx += 1) {
        const m = motionList[idx]!;
        if (m.speechTimer > 0 && m.speechTimer < 900) {
          m.speechTimer = Math.max(0, m.speechTimer - dt);
          if (m.speechTimer === 0) m.speech = "";
        }
        m.hopBoost = Math.max(0, m.hopBoost - dt * 1.9);

        const distToPlayer = Math.hypot(m.x - playerPos.x, m.z - playerPos.z);
        if (distToPlayer < nearestDist) {
          nearestDist = distToPlayer;
          nearestId = m.spec.id;
        }

        const isFocused = m.spec.id === focusedActorId;
        const patrolPlan = m.spec.role === "commodore" && m.spec.commodoreId
          ? villagePatrolPlans.get(m.spec.commodoreId)
          : undefined;
        let moveSpeed = m.carrying ? 4.8 : 2.65;
        let patrolFaceX: number | null = null;
        let patrolFaceZ: number | null = null;

        if (patrolPlan) {
          const ps = getOrCreatePatrolState(m);
          if (ps.greetCooldown > 0) ps.greetCooldown -= dt;
          const isWorking = m.spec.state === "running" || m.spec.activity !== null || patrolPlan.villageWorkStep !== null;

          if (isFocused) {
            // 대화/상호작용 중인 사령관은 제자리에 멈춰 제독을 응대한다
            m.tx = m.x;
            m.tz = m.z;
            ps.route.length = 0;
            ps.workingCommute = false;
          } else if (!isWorking && distToPlayer < 2.15) {
            // 제독이 [E] 상호작용 거리(2.15m 이내)로 바짝 다가오면 잠시 멈춰 응대한다
            m.tx = m.x;
            m.tz = m.z;
            ps.route.length = 0;
            ps.workingCommute = false;
            ps.waitTimer = Math.min(ps.waitTimer, 1.4);
          } else if (isWorking && patrolPlan.workTarget) {
            // 작업 시작 시 외출 중이었더라도 다리·정문을 거쳐 자기 마을 담당 Theater 앞으로 즉시 복귀 출근
            const wt = patrolPlan.workTarget;
            if (!ps.workingCommute || ps.lastWorkDistrictId !== (wt.districtId ?? null)) {
              const workRoute = buildWorldRoute(m.x, m.z, wt, patrolPlan, patrolPlan);
              const first = workRoute.shift();
              if (first) {
                m.tx = first.x;
                m.tz = first.z;
                ps.faceX = first.faceX;
                ps.faceZ = first.faceZ;
              }
              ps.route = workRoute;
              ps.workingCommute = true;
              ps.awayFromHome = false;
              ps.lastWorkDistrictId = wt.districtId ?? null;
              ps.stuckTimer = 0;
            } else if (Math.hypot(m.tx - m.x, m.tz - m.z) < 0.4 && ps.route.length > 0) {
              const nextHop = ps.route.shift()!;
              m.tx = nextHop.x;
              m.tz = nextHop.z;
              ps.faceX = nextHop.faceX;
              ps.faceZ = nextHop.faceZ;
            }
            moveSpeed = 3.75;
          } else if (!m.carrying) {
            // 대기 중인 사령관: 자기 마을 구역 순회 + 중앙 길드 광장·퀘스트 게시판·모닥불·시냇물 다리·이웃 마을까지 자유 산책!
            if (ps.workingCommute) {
              ps.workingCommute = false;
              ps.route.length = 0;
              ps.waitTimer = 1.5 + Math.random() * 1.8;
            }
            const distToTarget = Math.hypot(m.tx - m.x, m.tz - m.z);
            if (distToTarget < 0.35 && ps.route.length > 0) {
              // 다단계 경로(정문→목교→광장/이웃마을) 중간 경유지는 멈추지 않고 자연스럽게 이어서 걷는다
              const nextHop = ps.route.shift()!;
              m.tx = nextHop.x;
              m.tz = nextHop.z;
              ps.faceX = nextHop.faceX;
              ps.faceZ = nextHop.faceZ;
              ps.stuckTimer = 0;
            } else if (distToTarget < 0.28) {
              ps.waitTimer -= dt;
              if (ps.waitTimer <= 0) {
                const wantExcursion = ps.startWithExcursion
                  || (ps.awayFromHome ? Math.random() < 0.52 : Math.random() < (isNight ? 0.68 : 0.58));
                ps.startWithExcursion = false;

                let dest: PatrolWaypoint | null = null;
                let destVillage: VillagePatrolPlan | null = null;
                let nextAway = false;

                if (wantExcursion) {
                  // 1) 밤이면 중앙 모닥불 주변 방문 우선, 평상시엔 중앙 광장/게시판/강변/이웃 마을 다채롭게 선택
                  const roll = Math.random();
                  if (isNight && roll < 0.48) {
                    const spot = CAMPFIRE_NIGHT_SPOTS[Math.floor(Math.random() * CAMPFIRE_NIGHT_SPOTS.length)]!;
                    if (isWalkable(spot.x, spot.z)) {
                      dest = spot;
                      nextAway = true;
                    }
                  } else if (roll < 0.66) {
                    const spot = MEADOW_EXCURSION_SPOTS[Math.floor(Math.random() * MEADOW_EXCURSION_SPOTS.length)]!;
                    if (Math.hypot(spot.x - m.x, spot.z - m.z) > 2.2 && isWalkable(spot.x, spot.z)) {
                      dest = spot;
                      nextAway = true;
                    }
                  } else {
                    // 이웃 사령관 마을로 마실 가기!
                    const others = [...villagePatrolPlans.values()].filter((vp) => vp.commodoreId !== patrolPlan.commodoreId);
                    if (others.length > 0) {
                      const neighbor = others[Math.floor(Math.random() * others.length)]!;
                      const visitSpot = Math.random() < 0.5 ? neighbor.plazaPoint : neighbor.gateExit;
                      if (isWalkable(visitSpot.x, visitSpot.z)) {
                        dest = visitSpot;
                        destVillage = neighbor;
                        nextAway = true;
                      }
                    }
                  }
                }

                // 외출이 아니면 자기 마을 구역·광장 순회 (또는 외출 후 귀가)
                if (!dest) {
                  const count = patrolPlan.districtPoints.length;
                  if (count > 0) {
                    for (let attempt = 0; attempt < count; attempt += 1) {
                      const candidate = patrolPlan.districtPoints[(ps.nextDistrictIdx + attempt) % count]!;
                      if (
                        Math.hypot(candidate.x - m.x, candidate.z - m.z) > 1.4 &&
                        isWalkable(candidate.x, candidate.z)
                      ) {
                        dest = candidate;
                        destVillage = patrolPlan;
                        ps.nextDistrictIdx = (ps.nextDistrictIdx + attempt + 1) % count;
                        break;
                      }
                    }
                  }
                  if (!dest && isWalkable(patrolPlan.plazaPoint.x, patrolPlan.plazaPoint.z)) {
                    dest = patrolPlan.plazaPoint;
                    destVillage = patrolPlan;
                  }
                }

                if (dest) {
                  const fullRoute = buildWorldRoute(m.x, m.z, dest, patrolPlan, destVillage);
                  const firstHop = fullRoute.shift();
                  if (firstHop) {
                    m.tx = firstHop.x;
                    m.tz = firstHop.z;
                    ps.faceX = firstHop.faceX;
                    ps.faceZ = firstHop.faceZ;
                    ps.route = fullRoute;
                    ps.awayFromHome = nextAway;
                  }
                }
                ps.waitTimer = 2.2 + Math.random() * 2.6;
                ps.stuckTimer = 0;
              }
            }
            moveSpeed = ps.awayFromHome ? 2.45 : 2.15;

            // 산책 중 다른 사령관과 길 위에서 마주치면 반갑게 살짝 점프 인사!
            if (m.moving && ps.greetCooldown <= 0) {
              for (let oi = 0; oi < motionList.length; oi += 1) {
                const other = motionList[oi]!;
                if (other === m || other.spec.role !== "commodore") continue;
                if (Math.hypot(other.x - m.x, other.z - m.z) < 2.5) {
                  m.hopBoost = Math.max(m.hopBoost, 0.55);
                  ps.greetCooldown = 14;
                  break;
                }
              }
            }
          }

          patrolFaceX = ps.faceX;
          patrolFaceZ = ps.faceZ;
        } else if (isFocused) {
          // 상호작용 중인 대상은 제자리에 멈춰 서서 제독을 바라본다
          m.tx = m.x;
          m.tz = m.z;
        } else if (m.spec.state === "idle" && isNight && Math.hypot(m.spec.homeX - 2.8, m.spec.homeZ - 1.0) < 22) {
          // 밤이 되면 광장 인근의 유휴(idle) 에이전트들이 모닥불(2.8, 1.0) 둘레에 여유 있는 간격으로 둘러앉음
          const seatAngle = idx * 0.95 + 0.4;
          m.tx = 2.8 + Math.cos(seatAngle) * 2.15;
          m.tz = 1.0 + Math.sin(seatAngle) * 2.15;
        } else if (m.spec.state === "idle" && !isNight && Math.hypot(m.tx - m.spec.homeX, m.tz - m.spec.homeZ) > 3.0) {
          m.tx = m.spec.homeX;
          m.tz = m.spec.homeZ;
        } else if (!m.carrying && Math.hypot(m.tx - m.x, m.tz - m.z) < 0.14 && Math.random() < dt * 0.36) {
          const wander = m.spec.role === "member" ? 0.85 : 1.35;
          const cx = m.spec.homeX + (Math.random() - 0.5) * wander * 2;
          const cz = m.spec.homeZ + (Math.random() - 0.5) * wander * 2;
          if (isWalkable(cx, cz)) {
            m.tx = cx;
            m.tz = cz;
          }
        }

        const dx = m.tx - m.x;
        const dz = m.tz - m.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.08) {
          const step = Math.min(dist, moveSpeed * dt);
          const nx = m.x + (dx / dist) * step;
          const nz = m.z + (dz / dist) * step;
          const resolved = resolveMovement(m.x, m.z, nx, nz, 0.46);
          const moved = Math.hypot(resolved.x - m.x, resolved.z - m.z);
          m.x = resolved.x;
          m.z = resolved.z;
          m.yaw = Math.atan2(dx, dz);
          m.moving = moved > 0.002;

          // 산책/출근 중 장애물에 막혀 제자리걸음하면 부드럽게 도착 처리한다
          if (patrolPlan) {
            const ps = getOrCreatePatrolState(m);
            if (moved < step * 0.2) {
              ps.stuckTimer += dt;
              if (ps.stuckTimer > 0.85) {
                if (ps.route.length > 0) {
                  const skipHop = ps.route.shift()!;
                  m.tx = skipHop.x;
                  m.tz = skipHop.z;
                  ps.faceX = skipHop.faceX;
                  ps.faceZ = skipHop.faceZ;
                } else {
                  m.tx = m.x;
                  m.tz = m.z;
                  m.moving = false;
                  ps.waitTimer = 1.2 + Math.random() * 1.4;
                }
                ps.stuckTimer = 0;
              }
            } else {
              ps.stuckTimer = 0;
            }
            ps.lastX = m.x;
            ps.lastZ = m.z;
          }
        } else {
          m.moving = false;
          // 상호작용 중이거나 가까이 오면 플레이어를, 현장/산책 중이면 대상 건물을, 평상시에는 남쪽(+Z)을 자연스럽게 바라봄
          let desiredYaw = 0.15;
          if (isFocused || distToPlayer < 4.5) {
            desiredYaw = Math.atan2(playerPos.x - m.x, playerPos.z - m.z);
          } else if (patrolFaceX !== null && patrolFaceZ !== null) {
            desiredYaw = Math.atan2(patrolFaceX - m.x, patrolFaceZ - m.z);
          }
          let df = desiredYaw - m.yaw;
          while (df > Math.PI) df -= Math.PI * 2;
          while (df < -Math.PI) df += Math.PI * 2;
          m.yaw += df * Math.min(1, dt * (isFocused ? 9.0 : 5.5));
        }
      }

      // 캐릭터 상호 겹침 방지 소프트 분리 (서로 몸통이 파고들지 않게 밀어냄)
      for (let i = 0; i < motionList.length; i += 1) {
        const a = motionList[i]!;
        for (let j = i + 1; j < motionList.length; j += 1) {
          const b = motionList[j]!;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const d = Math.hypot(dx, dz);
          const minSep = 1.28;
          if (d > 0.001 && d < minSep) {
            const push = (minSep - d) * 0.5 * Math.min(1, dt * 10);
            const px = (dx / d) * push;
            const pz = (dz / d) * push;
            const ra = resolveMovement(a.x, a.z, a.x - px, a.z - pz, 0.44);
            const rb = resolveMovement(b.x, b.z, b.x + px, b.z + pz, 0.44);
            a.x = ra.x;
            a.z = ra.z;
            b.x = rb.x;
            b.z = rb.z;
          }
        }
      }

      // 모닥불 불티 (광장 모닥불 2.8, 1.0) — InstancedMesh 풀로 0 할당
      if (Math.random() < dt * 5.5) {
        const fx = 2.8 + (Math.random() - 0.5) * 0.32;
        const fz = 1.0 + (Math.random() - 0.5) * 0.32;
        pushParticle({
          x: fx,
          y: 0.72,
          z: fz,
          vx: (Math.random() - 0.5) * 0.4,
          vy: 1.35 + Math.random() * 0.7,
          vz: (Math.random() - 0.5) * 0.4,
          gravity: 1.6,
          scale: 0.62,
          life: 0.85,
          maxLife: 0.85,
          colorHex: 0xfb923c,
          glowBoost: 1.45,
        });
      }

      // 비행 투사체(전령 아크 포함) 갱신
      for (let i = projectiles.length - 1; i >= 0; i -= 1) {
        const pr = projectiles[i]!;
        pr.t += dt * pr.speed;
        const clampedT = Math.min(1, pr.t);
        const x = pr.sx + (pr.tx - pr.sx) * clampedT;
        const z = pr.sz + (pr.tz - pr.sz) * clampedT;
        const y = 1.45 + Math.sin(clampedT * Math.PI) * pr.arcHeight;
        pr.mesh.position.set(x, y, z);
        pr.mesh.rotation.y = Math.atan2(pr.tx - pr.sx, pr.tz - pr.sz);
        pr.mesh.rotation.z = elapsed * 5.0;
        if (pr.trailColorHex !== null && Math.random() < dt * 26) {
          pushParticle({
            x,
            y,
            z,
            vx: (Math.random() - 0.5) * 0.35,
            vy: 0.25 + Math.random() * 0.35,
            vz: (Math.random() - 0.5) * 0.35,
            gravity: 0.4,
            scale: 0.52,
            life: 0.42,
            maxLife: 0.42,
            colorHex: pr.trailColorHex,
            glowBoost: 1.45,
          });
        }
        if (pr.t >= 1) {
          fxGroup.remove(pr.mesh);
          pr.onArrive?.();
          projectiles.splice(i, 1);
        }
      }

      // 입자 일괄 갱신 (단일 InstancedMesh draw call)
      let writeIdx = 0;
      for (let i = 0; i < particles.length; i += 1) {
        const pt = particles[i]!;
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.z += pt.vz * dt;
        pt.vy -= pt.gravity * dt;
        pt.life -= dt;
        if (pt.life <= 0) continue;

        const lifeRatio = Math.max(0.15, pt.life / pt.maxLife);
        const s = pt.scale * (0.45 + 0.55 * lifeRatio);
        pPos.set(pt.x, pt.y, pt.z);
        pScale.set(s, s, s);
        pMat4.compose(pPos, pQuat, pScale);
        particleInstanced.setMatrixAt(writeIdx, pMat4);
        pColor.setHex(pt.colorHex);
        if (pt.glowBoost > 1) pColor.multiplyScalar(pt.glowBoost);
        particleInstanced.setColorAt(writeIdx, pColor);
        particles[writeIdx] = pt;
        writeIdx += 1;
      }
      particles.length = writeIdx;
      particleInstanced.count = writeIdx;
      particleInstanced.visible = writeIdx > 0;
      if (writeIdx > 0) {
        particleInstanced.instanceMatrix.needsUpdate = true;
        if (particleInstanced.instanceColor) particleInstanced.instanceColor.needsUpdate = true;
      }

      return nearestId;
    },
    dispose() {
      for (const id of pendingTimers) window.clearTimeout(id);
      pendingTimers.clear();
      villagePatrolPlans.clear();
      patrolStates.clear();
      projectiles.length = 0;
      particles.length = 0;
      particleInstanced.dispose();
      particleMat.dispose();
      for (const mat of projMatCache.values()) mat.dispose();
      projMatCache.clear();
      projGeo.dispose();
      partGeo.dispose();
      scene.remove(fxGroup);
    },
  };

  return director;
}
