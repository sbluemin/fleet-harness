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
  WorldPlayerEmote,
  WorldVillageSpec,
  WorldWeatherMode,
} from "../../shared/world-types.js";
import { BROOK_BRIDGES, brookProfile } from "./brook-geometry.js";
import type { WorldAnimMode, WorldExpression } from "./mongle-actor-rig.js";

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
  moveSpeed: number;
  carrying: boolean;
  hopBoost: number;
  speech: string;
  speechTimer: number;
  worldAnim: WorldAnimMode;
  expression: WorldExpression;
  animPhase: number;
  blush: number;
  gazeTargetX: number | null;
  gazeTargetZ: number | null;
  /** 동행 하늘 순찰 비행 고도(0=지상) 및 윙맨 뱅킹/피치 기울기. */
  flightAlt: number;
  flightRoll: number;
  flightPitch: number;
}

export interface CompanionFlightContext {
  readonly playerYaw: number;
  readonly playerTakeoffPhase: "none" | "charge" | "ascend";
  readonly playerTakeoffProgress: number;
  readonly playerFlying: boolean;
  readonly playerDiving: boolean;
  readonly playerBoosting?: boolean | undefined;
  readonly playerVx?: number | undefined;
  readonly playerVz?: number | undefined;
  readonly playerFlightAlt: number;
  readonly playerMoveSpeed: number;
  readonly playerFlightRoll: number;
  readonly playerFlightPitch: number;
  readonly playerBarrelRollTimer: number;
  readonly playerHeroLandTimer: number;
  readonly playerSittingAtCampfire: boolean;
  readonly onCompanionDutyReturn?: ((actor: WorldActorSpec) => void) | undefined;
}

interface ActorAnimState {
  emoteKind: "wave" | "cheer" | "spin" | "sit" | null;
  emoteTimer: number;
  emoteElapsed: number;
  surprisedTimer: number;
  banterTimer: number;
  banterPartnerX: number | null;
  banterPartnerZ: number | null;
  photoPoseTimer: number;
  photoLookX: number | null;
  photoLookZ: number | null;
  sleepyTimer: number;
  wasSleeping: boolean;
  sleepFxAccum: number;
  shakeTimer: number;
  shakeCooldown: number;
  shakeFxAccum: number;
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
  readonly label: string;
  readonly overallTier: number;
  readonly totalEntries: number;
  readonly topDistrictLabel: string | null;
  readonly topDistrictTier: number;
  readonly activeObjectiveCount: number;
  readonly completedObjectiveCount: number;
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
  chatPauseTimer: number;
  chatFaceX: number | null;
  chatFaceZ: number | null;
  rallying: boolean;
  rallyArrived: boolean;
  rallyHoldTimer: number;
  rallySpeech: string | null;
  rallyEmote: "cheer" | "wave";
  workingCommute: boolean;
  lastWorkDistrictId: string | null;
}

function brookCenterZAt(x: number): number {
  return brookProfile(x).centerZ;
}

const BRIDGE_CROSSINGS = BROOK_BRIDGES.map((bridge) => {
  const halfSpan = bridge.halfSpan + 1.05;
  const sinY = Math.sin(bridge.yaw);
  const cosY = Math.cos(bridge.yaw);
  const northX = bridge.x - sinY * halfSpan;
  const northZ = bridge.z - cosY * halfSpan;
  const southX = bridge.x + sinY * halfSpan;
  const southZ = bridge.z + cosY * halfSpan;
  return {
    x: bridge.x,
    z: bridge.z,
    north: { x: northX, z: northZ, faceX: bridge.x, faceZ: bridge.z } as PatrolWaypoint,
    mid: { x: bridge.x, z: bridge.z, faceX: southX, faceZ: southZ } as PatrolWaypoint,
    south: { x: southX, z: southZ, faceX: bridge.x, faceZ: bridge.z } as PatrolWaypoint,
  };
});

const MEADOW_EXCURSION_SPOTS: readonly PatrolWaypoint[] = [
  // 중앙 길드 회관 앞 광장
  { x: -0.4, z: -0.9, faceX: 0, faceZ: -5.2 },
  { x: 1.6, z: -1.4, faceX: 0, faceZ: -5.2 },
  // 제독 퀘스트 게시판 구경
  { x: 3.8, z: -1.8, faceX: 5.5, faceZ: -2.9 },
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

/** 모닥불(2.8, 1.0) 북·동·서쪽 카메라 맞은편 동행 합석 좌석(남쪽 벤치 2.8, 2.55 & 카메라 시야 가림 방지). */
const CAMPFIRE_COMPANION_SEATS: readonly { readonly x: number; readonly z: number }[] = [
  { x: 4.55, z: 0.45 },  // 0: 동북동
  { x: 3.75, z: -0.75 }, // 1: 북동
  { x: 2.80, z: -1.15 }, // 2: 북쪽 정면
  { x: 1.85, z: -0.75 }, // 3: 북서
  { x: 1.05, z: 0.45 },  // 4: 서북서
];

function vividToneHex(tone: keyof typeof PLUSH_VIVID_TONES): number {
  const rgb = PLUSH_VIVID_TONES[tone];
  const r = Math.min(255, Math.round(rgb[0] * 255));
  const g = Math.min(255, Math.round(rgb[1] * 255));
  const b = Math.min(255, Math.round(rgb[2] * 255));
  return (r << 16) | (g << 8) | b;
}

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
  /** 제독 4종 이동 궤적(별가루·벚꽃·무지개)용 부드러운 단색 부유 입자 (기존 InstancedMesh 풀 재사용). */
  spawnTrailSparkle(x: number, y: number, z: number, colorHex: number, scale?: number, driftUp?: boolean): void;
  /** 구역/마을 레벨업 축하 황금 다중 불꽃 + 상승 빛입자 축포 (기존 InstancedMesh 풀 재사용). */
  spawnLevelUpCelebration(x: number, z: number, colorHex?: number): void;
  /** Objective `done` 신규 전환 시 마을 상공 축하 불꽃놀이 + 주변 사령관 `cheer` 환호. */
  celebrateObjectiveDone(x: number, z: number, colorHex?: number): void;
  /** 전 사령관 긴급 소집 — 목교·정문을 거쳐 중앙 길드 광장 앞 반원 대형으로 신속 집결(4.2 m/s). */
  rallyAllToPlaza(): void;
  /** 함대 소집 종 집합 — 초원 전역의 대기 중 사령관 전원이 광장 반원으로 달려와 14초간 환호·인사한다. */
  triggerParadeBellRally(bellX: number, bellZ: number, speech: string): number;
  /** 제독 감정표현(손흔들기·환호·점프)에 반경 9.5m 내 사령관들이 돌아보고 따라 반응한다. */
  reactToPlayerEmote(emote: WorldPlayerEmote, playerPos: Vector3): void;
  /** 유성 급강하 착지 시 반경 16m 이내 사령관들이 놀람(`surprised`) → 환호(`cheer`) + 축포 환영. */
  reactToMeteorLanding(impactX: number, impactZ: number): void;
  /** 별빛 이륙 시 반경 14m 이내 사령관들이 깜짝(`surprised`) 쳐다본 뒤 손 흔들며(`wave` + `happy`) 배웅. */
  reactToStarTakeoff(x: number, z: number): void;
  /** 날씨 모드 동기화 (`rain` 시 가끔 빗물 털기 `shake` 모션 + 물방울 입자 발동). */
  setWeather(mode: WorldWeatherMode): void;
  /** 사령관/구역 실시간 작업 단계별 공방 파티클 FX (단일 InstancedMesh 풀, 0 할당). */
  emitWorkshopFx(x: number, y: number, z: number, kind: WorkshopFxKind): void;
  /** 두 마을/구역 사이로 빛나는 전령 비행 아크를 발사한다 (단일 캐시 머티리얼 + 트레일 입자). */
  spawnCourierArc(fromX: number, fromZ: number, toX: number, toZ: number, colorHex?: number): void;
  /** 함께 산책 · 모닥불 합석 · 하늘 순찰 V자 편대 동행 사령관 목록 지정 (빈 배열이면 전원 해산). */
  setCompanionActors(actorIds: readonly string[]): void;
  getCompanionActorIds(): readonly string[];
  /** 단체 포토 스튜디오 포즈: 반경 18m 이내 사령관/NPC가 카메라를 바라보며 2.8초간 `cheer` 포즈. */
  triggerPhotoGroupPose(cameraX: number, cameraZ: number): number;
  /** 제독 이모트 휠 떼창 리액션: 반경 11m 이내 사령관들이 이모트에 맞춰 함께 환호/손흔들기/회전 리액션. */
  triggerAdmiralEmoteReaction(playerX: number, playerZ: number, emote: string): number;
  /** 입장 웰컴 브리핑: 가장 가까운 사령관이 제독 앞 ~2.4m까지 달려와 점프·손흔들기와 함께 4.8초간 브리핑 말풍선 연출. */
  triggerWelcomeBriefing(playerX: number, playerZ: number, speech: string): string | null;
  /** 하늘 별빛 링 통과 시 비행 중인 동행 편대 전원에게 동기화 배럴롤 + 황금 스파클 버스트 발동. */
  triggerSquadronRingBoost(): number;
  update(
    dt: number,
    elapsed: number,
    nightFactor: number,
    playerPos: Vector3,
    focusedActorId: string | null,
    isWalkable: (x: number, z: number) => boolean,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
    companionCtx?: CompanionFlightContext,
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
  const navSteerStates = new Map<string, { detourSign: 1 | -1; detourTimer: number; stuckTimer: number }>();
  const steerOutScratch = { x: 0, z: 0, moved: 0, yaw: 0 };
  const STEER_PROBE_ANGLES: readonly number[] = [0.92, -0.92, 1.54, -1.54, 2.16, -2.16];

  /** 장애물 충돌 시 직진으로 끼이지 않고 접선 우회 각도(±52°/±88°/±124°)로 부드럽게 돌아가는 0-GC 이동 헬퍼. */
  function stepWithObstacleSteering(
    actorId: string,
    curX: number,
    curZ: number,
    targetX: number,
    targetZ: number,
    step: number,
    radius: number,
    dt: number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, actorRadius?: number) => { x: number; z: number },
  ): { x: number; z: number; moved: number; yaw: number } {
    const dx = targetX - curX;
    const dz = targetZ - curZ;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.0001 || step <= 0.0001) {
      steerOutScratch.x = curX;
      steerOutScratch.z = curZ;
      steerOutScratch.moved = 0;
      steerOutScratch.yaw = 0;
      return steerOutScratch;
    }

    let nav = navSteerStates.get(actorId);
    if (!nav) {
      nav = { detourSign: (actorId.length % 2 === 0 ? 1 : -1), detourTimer: 0, stuckTimer: 0 };
      navSteerStates.set(actorId, nav);
    }
    if (nav.detourTimer > 0) nav.detourTimer = Math.max(0, nav.detourTimer - dt);

    const baseDirX = dx / dist;
    const baseDirZ = dz / dist;
    const directRes = resolveMovement(curX, curZ, curX + baseDirX * step, curZ + baseDirZ * step, radius);
    const directMoved = Math.hypot(directRes.x - curX, directRes.z - curZ);
    const directForward = ((directRes.x - curX) * baseDirX + (directRes.z - curZ) * baseDirZ);

    // 직진 경로가 충분히 열려 있고 우회 유지 중이 아니면 그대로 직진
    if (nav.detourTimer <= 0 && directMoved >= step * 0.58 && directForward >= step * 0.45) {
      nav.stuckTimer = 0;
      steerOutScratch.x = directRes.x;
      steerOutScratch.z = directRes.z;
      steerOutScratch.moved = directMoved;
      steerOutScratch.yaw = Math.atan2(directRes.x - curX, directRes.z - curZ);
      return steerOutScratch;
    }

    // 직진이 막혔거나 코너 우회 유지 중이면 접선 우회 후보를 0-GC로 탐색
    let bestX = directRes.x;
    let bestZ = directRes.z;
    let bestMoved = directMoved;
    let bestScore = directMoved >= step * 0.58 ? directForward + directMoved * 0.35 : -1;
    let bestSign: 1 | -1 = nav.detourSign;

    // 우회 유지 중에는 직진이 완전히 열리면 우회 해제
    if (nav.detourTimer > 0 && directMoved >= step * 0.85 && directForward >= step * 0.78) {
      nav.detourTimer = 0;
      nav.stuckTimer = 0;
      steerOutScratch.x = directRes.x;
      steerOutScratch.z = directRes.z;
      steerOutScratch.moved = directMoved;
      steerOutScratch.yaw = Math.atan2(directRes.x - curX, directRes.z - curZ);
      return steerOutScratch;
    }

    for (let i = 0; i < STEER_PROBE_ANGLES.length; i += 1) {
      const ang = STEER_PROBE_ANGLES[i]! * nav.detourSign;
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const vx = baseDirX * cosA - baseDirZ * sinA;
      const vz = baseDirX * sinA + baseDirZ * cosA;
      const cand = resolveMovement(curX, curZ, curX + vx * step, curZ + vz * step, radius);
      const candMoved = Math.hypot(cand.x - curX, cand.z - curZ);
      if (candMoved < step * 0.32) continue;
      // 진행 거리 + 목표 근접 기여 + 기존 회전 방향 일관성 보너스(좌우 진동 방지)
      const candSign: 1 | -1 = ang >= 0 ? 1 : -1;
      const forwardDot = ((cand.x - curX) * baseDirX + (cand.z - curZ) * baseDirZ);
      const consistencyBonus = candSign === nav.detourSign ? step * 0.22 : 0;
      const score = candMoved * 0.85 + forwardDot * 0.55 + consistencyBonus;
      if (score > bestScore) {
        bestScore = score;
        bestX = cand.x;
        bestZ = cand.z;
        bestMoved = candMoved;
        bestSign = candSign;
      }
    }

    if (bestMoved >= step * 0.32) {
      nav.detourSign = bestSign;
      nav.detourTimer = Math.max(nav.detourTimer, 0.42);
      nav.stuckTimer = 0;
    } else {
      nav.stuckTimer += dt;
      if (nav.stuckTimer > 0.65) {
        nav.detourSign = nav.detourSign === 1 ? -1 : 1;
        nav.detourTimer = 0.55;
        nav.stuckTimer = 0;
      }
    }

    steerOutScratch.x = bestX;
    steerOutScratch.z = bestZ;
    steerOutScratch.moved = bestMoved;
    steerOutScratch.yaw = bestMoved > 0.002 ? Math.atan2(bestX - curX, bestZ - curZ) : Math.atan2(dx, dz);
    return steerOutScratch;
  }
  const animStates = new Map<string, ActorAnimState>();
  const huddleActivityTracker = new Map<string, { activity: string; calloutCooldown: number }>();
  const huddleGroupsScratch = new Map<string, LiveActorMotion[]>();
  const huddleSlotScratch = new Map<string, { x: number; z: number; hubX: number; hubZ: number }>();
  const projectiles: FlyingProjectile[] = [];
  const particles: BurstParticle[] = [];
  const pendingTimers = new Set<number>();
  let currentWeather: WorldWeatherMode = "clear";
  let companionActorIds: string[] = [];
  const companionStates = new Map<string, {
    barrelDelay: number;
    barrelTimer: number;
    prevHeroLand: boolean;
    sparkleAccum: number;
  }>();
  let welcomeBriefing: {
    actorId: string;
    targetX: number;
    targetZ: number;
    lookX: number;
    lookZ: number;
    speech: string;
    timer: number;
    arrived: boolean;
  } | null = null;

  function getOrCreateCompanionState(actorId: string) {
    let cs = companionStates.get(actorId);
    if (!cs) {
      cs = {
        barrelDelay: 0,
        barrelTimer: 0,
        prevHeroLand: false,
        sparkleAccum: 0,
      };
      companionStates.set(actorId, cs);
    }
    return cs;
  }

  function getOrCreateAnimState(actorId: string): ActorAnimState {
    let st = animStates.get(actorId);
    if (!st) {
      st = {
        emoteKind: null,
        emoteTimer: 0,
        emoteElapsed: 0,
        surprisedTimer: 0,
        banterTimer: 0,
        banterPartnerX: null,
        banterPartnerZ: null,
        photoPoseTimer: 0,
        photoLookX: null,
        photoLookZ: null,
        sleepyTimer: 0,
        wasSleeping: false,
        sleepFxAccum: 0,
        shakeTimer: 0,
        shakeCooldown: 7 + Math.random() * 11,
        shakeFxAccum: 0,
      };
      animStates.set(actorId, st);
    }
    return st;
  }

  function triggerActorEmote(actorId: string, kind: "wave" | "cheer" | "spin" | "sit", durationSec: number): void {
    const st = getOrCreateAnimState(actorId);
    st.emoteKind = kind;
    st.emoteTimer = Math.max(st.emoteTimer, durationSec);
    st.emoteElapsed = 0;
    st.sleepyTimer = 0;
    st.wasSleeping = false;
  }

  function mapWorkStepToAnim(workStep: string | null, activity: WorldActorSpec["activity"]): WorldAnimMode {
    const raw = (workStep ?? activity ?? "").toLowerCase();
    if (raw.includes("edit") || raw.includes("write")) return "work-edit";
    if (raw.includes("read") || raw.includes("search")) return "work-read";
    if (raw.includes("think") || raw.includes("plan")) return "work-think";
    return "work-run";
  }

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

  function spawnTrailSparkle(
    x: number,
    y: number,
    z: number,
    colorHex: number,
    scale = 0.68,
    driftUp = true,
  ) {
    const ang = Math.random() * Math.PI * 2;
    const horiz = 0.16 + Math.random() * 0.28;
    pushParticle({
      x,
      y,
      z,
      vx: Math.cos(ang) * horiz,
      vy: driftUp ? 0.68 + Math.random() * 0.55 : 0.22 + Math.random() * 0.28,
      vz: Math.sin(ang) * horiz,
      gravity: driftUp ? -0.12 : 0.65,
      scale: scale * (0.82 + Math.random() * 0.36),
      life: 0.78 + Math.random() * 0.32,
      maxLife: 1.1,
      colorHex,
      glowBoost: 1.48,
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

    // 인근 사령관/구성원 기쁨 점프 + 환호 모션
    for (const m of motionList) {
      if (Math.hypot(m.x - x, m.z - z) < 9.5) {
        m.hopBoost = Math.max(m.hopBoost, 1.65);
        triggerActorEmote(m.spec.id, "cheer", 2.2);
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

    // 3. 시냇물 북쪽↔남쪽을 건너야 하면 가장 가까운 아치 목교 3단 포인트(진입→중앙→출구)를 경유한다 (4개 목교 지원)
    const curSouth = curZ > brookCenterZAt(curX);
    const dstSouth = targetApproachZ > brookCenterZAt(targetApproachX);
    if (curSouth !== dstSouth && BRIDGE_CROSSINGS.length > 0) {
      const midX = (curX + targetApproachX) * 0.5;
      let bridge = BRIDGE_CROSSINGS[0]!;
      let bestBridgeDist = Math.abs(midX - bridge.x);
      for (let bi = 1; bi < BRIDGE_CROSSINGS.length; bi += 1) {
        const candidate = BRIDGE_CROSSINGS[bi]!;
        const d = Math.abs(midX - candidate.x);
        if (d < bestBridgeDist) {
          bestBridgeDist = d;
          bridge = candidate;
        }
      }
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
      let topDistrictLabel: string | null = null;

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
          topDistrictLabel = d.label;
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
        label: v.label,
        overallTier: v.overallTier,
        totalEntries: v.totalEntries,
        topDistrictLabel,
        topDistrictTier: Math.max(0, bestTier),
        activeObjectiveCount: v.activeObjectiveCount,
        completedObjectiveCount: v.completedObjectiveCount,
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

  let roadsideChatTurn = 0;

  function buildRoadsideChatPair(
    planA: VillagePatrolPlan,
    planB: VillagePatrolPlan,
    nameA: string,
    nameB: string,
  ): readonly [string, string] {
    const turn = roadsideChatTurn++ % 4;
    const shortA = planA.topDistrictLabel
      ? (planA.topDistrictLabel.length > 14 ? `${planA.topDistrictLabel.slice(0, 13)}…` : planA.topDistrictLabel)
      : planA.label;
    const shortB = planB.topDistrictLabel
      ? (planB.topDistrictLabel.length > 14 ? `${planB.topDistrictLabel.slice(0, 13)}…` : planB.topDistrictLabel)
      : planB.label;

    if (turn === 0) {
      return [
        planA.topDistrictTier > 0
          ? `[greet] ${nameB}님! 우리 ${shortA} 벌써 T${planA.topDistrictTier}예요!`
          : `[greet] ${nameB}님! 곧 첫 영지를 개척할 거예요!`,
        planB.totalEntries > 0
          ? `[cheer] 우와! 여긴 총 ${planB.totalEntries.toLocaleString()}항목 정리 중이에요!`
          : `[cheer] 기대돼요! 여기도 새 임무를 기다리며 초원을 가꾸고 있어요!`,
      ];
    }
    if (turn === 1) {
      return [
        planA.activeObjectiveCount > 0
          ? `[quest] 지금 목표 ${planA.activeObjectiveCount}건 진행 중이에요!`
          : planB.overallTier > 0
            ? `[greet] ${nameB}님 마을(T${planB.overallTier}) 산책 왔어요!`
            : `[greet] ${nameB}님 새 초원 마을 구경하러 산책 왔어요!`,
        planB.completedObjectiveCount > 0
          ? `[party] 여긴 벌써 목표 ${planB.completedObjectiveCount}건 완수했죠!`
          : `[greet] ${nameA}님 반가워요! ${shortB}도 들러보세요!`,
      ];
    }
    if (turn === 2) {
      return [
        planA.totalEntries > 0
          ? `[chat] ${shortA} 쪽 ${planA.totalEntries.toLocaleString()}항목이 쑥쑥 자라네요!`
          : `[chat] ${shortA} 터를 닦으면서 첫 프로젝트를 기다리고 있어요!`,
        planA.overallTier > 0
          ? `[cheer] ${nameA}님 마을 T${planA.overallTier} 진짜 멋져요! 화이팅!`
          : `[cheer] ${nameA}님 마을 새 출발 응원해요! 곧 멋진 영지가 될 거예요!`,
      ];
    }
    return [
      `[greet] 오늘 초원 바람 좋죠, ${nameB}님?`,
      planB.topDistrictTier > 0
        ? `[greet] 네! ${shortB}(T${planB.topDistrictTier}) 돌보고 잠깐 나왔어요!`
        : `[greet] 네! 새 영지 개척 준비하고 잠깐 산책 나왔어요!`,
    ];
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
        chatPauseTimer: 0,
        chatFaceX: null,
        chatFaceZ: null,
        rallying: false,
        rallyArrived: false,
        rallyHoldTimer: 0,
        rallySpeech: null,
        rallyEmote: "cheer",
        workingCommute: false,
        lastWorkDistrictId: null,
      };
      patrolStates.set(m.spec.id, st);
    }
    return st;
  }

  function rallyAllToPlaza(): void {
    const commodores = motionList.filter((m) => m.spec.role === "commodore");
    if (commodores.length === 0) return;

    const count = commodores.length;
    const centerX = 0;
    const centerZ = -0.8;
    const arcRadius = Math.min(4.6, 3.2 + count * 0.18);

    spawnBurst(0, 2.2, -1.6, 0xfbbf24, 24);

    for (let i = 0; i < count; i += 1) {
      const m = commodores[i]!;
      const t = count === 1 ? 0.5 : i / (count - 1);
      // 중앙 길드 회관(-Z) 앞 남쪽 반원 대형으로 정돈 배치
      const ang = -0.18 + t * (Math.PI + 0.36);
      const slotX = centerX + Math.cos(ang) * arcRadius;
      const slotZ = centerZ + Math.sin(ang) * (arcRadius * 0.82);
      const slotWp: PatrolWaypoint = {
        x: slotX,
        z: slotZ,
        faceX: 0,
        faceZ: -3.2,
      };

      const plan = m.spec.commodoreId ? villagePatrolPlans.get(m.spec.commodoreId) : undefined;
      const ps = getOrCreatePatrolState(m);
      ps.chatPauseTimer = 0;
      ps.workingCommute = false;
      ps.rallying = true;
      ps.rallyArrived = false;
      ps.rallyHoldTimer = 9.0;
      ps.rallySpeech = null;
      ps.rallyEmote = "cheer";
      ps.awayFromHome = true;
      ps.stuckTimer = 0;

      if (plan) {
        const route = buildWorldRoute(m.x, m.z, slotWp, plan, null);
        const firstHop = route.shift();
        if (firstHop) {
          m.tx = firstHop.x;
          m.tz = firstHop.z;
          ps.faceX = firstHop.faceX;
          ps.faceZ = firstHop.faceZ;
          ps.route = route;
        }
      } else {
        m.tx = slotX;
        m.tz = slotZ;
        ps.faceX = 0;
        ps.faceZ = -3.2;
        ps.route = [];
      }

      m.hopBoost = Math.max(m.hopBoost, 1.3);
      if (m.speechTimer < 900) {
        m.speech = "[rally] 긴급 소집! 중앙 광장으로 집결합니다!";
        m.speechTimer = 3.2;
      }
    }
  }

  function triggerParadeBellRally(bellX: number, bellZ: number, speech: string): number {
    const idleCommodores = motionList.filter(
      (m) =>
        m.spec.role === "commodore"
        && m.spec.state !== "running"
        && m.spec.activity === null
        && !m.spec.needsAttention,
    );
    if (idleCommodores.length === 0) return 0;

    const count = idleCommodores.length;
    const centerX = 0.0;
    const centerZ = -0.6;
    const arcRadius = Math.min(5.2, 3.2 + count * 0.24);

    spawnBurst(bellX, 2.35, bellZ, 0xfde047, 26);

    for (let i = 0; i < count; i += 1) {
      const m = idleCommodores[i]!;
      const t = count === 1 ? 0.5 : i / (count - 1);
      // 중앙 길드 회관 앞 남쪽 반원 대형으로 정렬해 제독과 종루를 바라본다
      const ang = -0.22 + t * (Math.PI + 0.44);
      const slotX = centerX + Math.cos(ang) * arcRadius;
      const slotZ = centerZ + Math.sin(ang) * (arcRadius * 0.84);
      const slotWp: PatrolWaypoint = {
        x: slotX,
        z: slotZ,
        faceX: bellX,
        faceZ: bellZ,
      };

      // 88m 외곽 마을에서 달려오는 사령관도 빠르게 집결하도록 38m 초과 시 반짝이며 광장 외곽으로 합류
      const distToPlaza = Math.hypot(m.x - centerX, m.z - centerZ);
      if (distToPlaza > 38.0) {
        const dirX = (m.x - centerX) / distToPlaza;
        const dirZ = (m.z - centerZ) / distToPlaza;
        m.x = centerX + dirX * 15.0;
        m.z = centerZ + dirZ * 15.0;
        spawnBurst(m.x, 1.4, m.z, 0xfde047, 8);
      }

      const plan = m.spec.commodoreId ? villagePatrolPlans.get(m.spec.commodoreId) : undefined;
      const ps = getOrCreatePatrolState(m);
      ps.chatPauseTimer = 0;
      ps.workingCommute = false;
      ps.rallying = true;
      ps.rallyArrived = false;
      ps.rallyHoldTimer = 14.0;
      ps.rallySpeech = speech;
      ps.rallyEmote = i % 2 === 0 ? "cheer" : "wave";
      ps.awayFromHome = true;
      ps.stuckTimer = 0;

      if (plan) {
        const route = buildWorldRoute(m.x, m.z, slotWp, plan, null);
        const firstHop = route.shift();
        if (firstHop) {
          m.tx = firstHop.x;
          m.tz = firstHop.z;
          ps.faceX = firstHop.faceX;
          ps.faceZ = firstHop.faceZ;
          ps.route = route;
        }
      } else {
        m.tx = slotX;
        m.tz = slotZ;
        ps.faceX = bellX;
        ps.faceZ = bellZ;
        ps.route = [];
      }

      m.hopBoost = Math.max(m.hopBoost, 1.35);
    }

    director.celebratingTimer = Math.max(director.celebratingTimer, 2.8);
    return count;
  }

  function resolveFieldActivityCallout(activity: string | null): string {
    switch (activity) {
      case "think":
        return "[think] 설계와 전략을 정리 중이에요!";
      case "read":
        return "[read] 관련 코드를 꼼꼼히 분석 중이에요!";
      case "edit":
        return "[edit] 핵심 구현을 다듬고 있어요!";
      case "run":
        return "[run] 테스트 검증을 실행 중이에요!";
      case "fetch":
        return "[fetch] 최신 자료를 확인하고 있어요!";
      case "delegate":
        return "[delegate] 팀원들과 작전을 조율 중이에요!";
      default:
        return "[work] 작전 목표를 진행 중이에요!";
    }
  }

  function reactToPlayerEmote(emote: WorldPlayerEmote, playerPos: Vector3): void {
    const burstColor = emote === "wave" ? 0x38bdf8 : emote === "cheer" ? 0xfbbf24 : 0xe879f9;
    spawnBurst(playerPos.x, playerPos.y + 1.35, playerPos.z, burstColor, 16);

    const waveLines = ["[greet] 안녕하세요 제독님!", "[greet] 반가워요! 오늘도 화이팅!"] as const;
    const cheerLines = ["[cheer] 함대 파이팅! 최고예요!", "[cheer] 기운이 불끈 나네요!"] as const;
    const jumpLines = ["[highfive] 같이 점프!! 얏호!", "[party] 껑충! 신난다!"] as const;
    const lines = emote === "wave" ? waveLines : emote === "cheer" ? cheerLines : jumpLines;

    let reacted = 0;
    for (const m of motionList) {
      if (Math.hypot(m.x - playerPos.x, m.z - playerPos.z) > 9.5) continue;
      m.hopBoost = Math.max(m.hopBoost, emote === "jump" ? 1.85 : emote === "cheer" ? 1.65 : 1.35);
      m.yaw = Math.atan2(playerPos.x - m.x, playerPos.z - m.z);
      triggerActorEmote(
        m.spec.id,
        emote === "wave" ? "wave" : emote === "cheer" ? "cheer" : "spin",
        emote === "jump" ? 1.6 : 1.9,
      );
      if (m.speechTimer < 900) {
        m.speech = lines[reacted % lines.length]!;
        m.speechTimer = 3.2;
      }
      const ps = patrolStates.get(m.spec.id);
      if (ps && !ps.rallying && !ps.workingCommute) {
        ps.chatPauseTimer = Math.max(ps.chatPauseTimer, 2.2);
        ps.chatFaceX = playerPos.x;
        ps.chatFaceZ = playerPos.z;
      }
      reacted += 1;
    }
  }

  function reactToMeteorLanding(impactX: number, impactZ: number): void {
    for (const m of motionList) {
      const d = Math.hypot(m.x - impactX, m.z - impactZ);
      if (d > 16.0) continue;
      m.yaw = Math.atan2(impactX - m.x, impactZ - m.z);
      m.hopBoost = Math.max(m.hopBoost, 1.28);
      const anim = getOrCreateAnimState(m.spec.id);
      anim.surprisedTimer = 0.45;
      const ps = patrolStates.get(m.spec.id);
      if (ps && !ps.rallying) {
        ps.chatPauseTimer = Math.max(ps.chatPauseTimer, 2.1);
        ps.chatFaceX = impactX;
        ps.chatFaceZ = impactZ;
      }
      const actorId = m.spec.id;
      scheduleTimeout(() => {
        const cur = motions.get(actorId);
        if (!cur) return;
        cur.hopBoost = Math.max(cur.hopBoost, 1.18);
        triggerActorEmote(actorId, "cheer", 1.6);
        spawnBurst(cur.x, 1.45, cur.z, 0xfde047, 6);
      }, 450);
    }
  }

  function reactToStarTakeoff(x: number, z: number): void {
    for (const m of motionList) {
      const d = Math.hypot(m.x - x, m.z - z);
      if (d > 14.0) continue;
      m.yaw = Math.atan2(x - m.x, z - m.z);
      m.hopBoost = Math.max(m.hopBoost, 0.85);
      const anim = getOrCreateAnimState(m.spec.id);
      anim.surprisedTimer = 0.45;
      const ps = patrolStates.get(m.spec.id);
      if (ps && !ps.rallying) {
        ps.chatPauseTimer = Math.max(ps.chatPauseTimer, 2.35);
        ps.chatFaceX = x;
        ps.chatFaceZ = z;
      }
      const actorId = m.spec.id;
      scheduleTimeout(() => {
        const cur = motions.get(actorId);
        if (!cur) return;
        cur.hopBoost = Math.max(cur.hopBoost, 0.72);
        triggerActorEmote(actorId, "wave", 1.85);
      }, 450);
    }
  }

  function celebrateObjectiveDone(x: number, z: number, colorHex = 0xfbbf24) {
    spawnLevelUpCelebration(x, z, colorHex);
    for (const m of motionList) {
      if (Math.hypot(m.x - x, m.z - z) <= 18.0) {
        m.hopBoost = Math.max(m.hopBoost, 1.55);
        triggerActorEmote(m.spec.id, "cheer", 2.8);
      }
    }
  }

  function setCompanionActors(actorIds: readonly string[]): void {
    const nextIds: string[] = [];
    const nextSet = new Set<string>();
    for (const rawId of actorIds) {
      if (!rawId || nextSet.has(rawId)) continue;
      nextSet.add(rawId);
      nextIds.push(rawId);
    }

    if (
      nextIds.length === companionActorIds.length
      && nextIds.every((id, i) => companionActorIds[i] === id)
    ) {
      return;
    }

    const prevSet = new Set(companionActorIds);
    for (const prevId of companionActorIds) {
      if (nextSet.has(prevId)) continue;
      companionStates.delete(prevId);
      const prev = motions.get(prevId);
      if (prev) {
        prev.flightAlt = 0;
        prev.flightRoll = 0;
        prev.flightPitch = 0;
        const ps = patrolStates.get(prevId);
        if (ps) {
          ps.route.length = 0;
          ps.waitTimer = 0.6;
        }
      }
    }

    companionActorIds = nextIds;

    for (const nextId of nextIds) {
      if (prevSet.has(nextId)) continue;
      companionStates.set(nextId, {
        barrelDelay: 0,
        barrelTimer: 0,
        prevHeroLand: false,
        sparkleAccum: 0,
      });
      const next = motions.get(nextId);
      if (next) {
        next.hopBoost = Math.max(next.hopBoost, 1.35);
        triggerActorEmote(nextId, "cheer", 1.2);
        spawnBurst(next.x, 1.5, next.z, 0xfde047, 12);
      }
    }
  }

  function getCompanionActorIds(): readonly string[] {
    return companionActorIds;
  }

  function triggerPhotoGroupPose(cameraX: number, cameraZ: number): number {
    let posed = 0;
    for (const m of motionList) {
      if (Math.hypot(m.x - cameraX, m.z - cameraZ) > 18.0) continue;
      const anim = getOrCreateAnimState(m.spec.id);
      anim.photoPoseTimer = 2.8;
      anim.photoLookX = cameraX;
      anim.photoLookZ = cameraZ;
      m.hopBoost = Math.max(m.hopBoost, 1.25);
      m.yaw = Math.atan2(cameraX - m.x, cameraZ - m.z);
      triggerActorEmote(m.spec.id, "cheer", 2.8);
      const ps = patrolStates.get(m.spec.id);
      if (ps && !ps.rallying) {
        ps.chatPauseTimer = Math.max(ps.chatPauseTimer, 2.8);
        ps.chatFaceX = cameraX;
        ps.chatFaceZ = cameraZ;
      }
      posed += 1;
    }
    return posed;
  }

  function triggerAdmiralEmoteReaction(playerX: number, playerZ: number, emote: string): number {
    const burstColor = emote === "wave"
      ? 0x38bdf8
      : emote === "stardust" || emote === "cheer"
        ? 0xfde047
        : emote === "twirl"
          ? 0xe879f9
          : 0x34d399;
    spawnBurst(playerX, 1.5, playerZ, burstColor, emote === "stardust" ? 26 : 16);

    let reacted = 0;
    for (const m of motionList) {
      if (Math.hypot(m.x - playerX, m.z - playerZ) > 11.0) continue;
      m.yaw = Math.atan2(playerX - m.x, playerZ - m.z);
      m.hopBoost = Math.max(m.hopBoost, emote === "twirl" ? 1.75 : emote === "sit" ? 0.45 : 1.35);
      const mappedKind: "wave" | "cheer" | "spin" | "sit" =
        emote === "wave"
          ? "wave"
          : emote === "twirl"
            ? "spin"
            : emote === "sit"
              ? "sit"
              : "cheer";
      triggerActorEmote(m.spec.id, mappedKind, emote === "sit" ? 2.6 : 1.9);
      const ps = patrolStates.get(m.spec.id);
      if (ps && !ps.rallying && !ps.workingCommute) {
        ps.chatPauseTimer = Math.max(ps.chatPauseTimer, 2.2);
        ps.chatFaceX = playerX;
        ps.chatFaceZ = playerZ;
      }
      reacted += 1;
    }
    return reacted;
  }

  function triggerWelcomeBriefing(playerX: number, playerZ: number, speech: string): string | null {
    let best: LiveActorMotion | null = null;
    let bestDist = Infinity;
    for (const m of motionList) {
      if (m.spec.role !== "commodore") continue;
      const d = Math.hypot(m.x - playerX, m.z - playerZ);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    if (!best) return null;

    const dx = best.x - playerX;
    const dz = best.z - playerZ;
    const d = Math.hypot(dx, dz);
    const dirX = d > 0.2 ? dx / d : 0.32;
    const dirZ = d > 0.2 ? dz / d : -0.95;
    const targetX = playerX + dirX * 2.4;
    const targetZ = playerZ + dirZ * 2.4;

    // 88m 넓은 맵에서 먼 마을 사령관도 ~1.2초 안에 달려오도록 14m 초과 시 반짝이며 근접 위치로 합류
    if (d > 14.0) {
      best.x = playerX + dirX * 7.4;
      best.z = playerZ + dirZ * 7.4;
      spawnBurst(best.x, 1.4, best.z, 0xfde047, 10);
    }

    welcomeBriefing = {
      actorId: best.spec.id,
      targetX,
      targetZ,
      lookX: playerX,
      lookZ: playerZ,
      speech,
      timer: 7.2,
      arrived: false,
    };
    return best.spec.id;
  }

  function triggerSquadronRingBoost(): number {
    let boosted = 0;
    for (let i = 0; i < companionActorIds.length; i += 1) {
      const id = companionActorIds[i]!;
      const m = motions.get(id);
      if (!m || m.flightAlt <= 1.2) continue;
      const cs = getOrCreateCompanionState(id);
      const rank = Math.floor(i / 2);
      const side = i % 2 === 0 ? 1 : -1;
      cs.barrelDelay = 0.04 + rank * 0.055 + (side < 0 ? 0.02 : 0);
      cs.barrelTimer = 0;
      m.hopBoost = Math.max(m.hopBoost, 1.15);
      m.expression = "happy";
      m.blush = 0.82;
      spawnBurst(m.x, m.flightAlt + 0.55, m.z, 0xfde047, 12);
      boosted += 1;
    }
    return boosted;
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
          navSteerStates.delete(id);
          animStates.delete(id);
          huddleActivityTracker.delete(id);
          const compIdx = companionActorIds.indexOf(id);
          if (compIdx >= 0) {
            companionActorIds.splice(compIdx, 1);
            companionStates.delete(id);
          }
          if (welcomeBriefing?.actorId === id) {
            welcomeBriefing = null;
          }
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
            moveSpeed: 0,
            carrying: false,
            hopBoost: 0.8,
            speech: spec.initialSpeech ?? "",
            speechTimer: spec.initialSpeech ? (spec.needsAttention ? 999 : 5.5) : 0,
            worldAnim: "idle",
            expression: "normal",
            animPhase: 0,
            blush: 0,
            gazeTargetX: null,
            gazeTargetZ: null,
            flightAlt: 0,
            flightRoll: 0,
            flightPitch: 0,
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
        triggerActorEmote(actorId, "wave", 1.85);
        m.speech = m.spec.role === "commodore"
          ? "[greet] 반가워요 제독님! 오늘 작전은 무엇인가요?"
          : m.spec.role === "commander"
            ? "[rally] 충성! 작전 구역 이상 없습니다!"
            : "[greet] 안녕하세요! 맡은 임무 진행 중이에요!";
        m.speechTimer = 3.8;
        spawnBurst(m.x, 1.55, m.z, 0x38bdf8, 16);
      } else if (emote === "cheer") {
        m.hopBoost = 1.8;
        triggerActorEmote(actorId, "cheer", 1.95);
        m.speech = "[cheer] 힘이 불끈 나네요! 맡겨만 주세요!";
        m.speechTimer = 3.8;
        spawnBurst(m.x, 1.65, m.z, 0xfbbf24, 22);
      } else {
        m.hopBoost = 1.75;
        triggerActorEmote(actorId, "spin", 1.65);
        m.speech = "[highfive] 점프 하이파이브! 최고의 호흡이에요!";
        m.speechTimer = 3.8;
        spawnBurst((m.x + playerPos.x) * 0.5, 1.6, (m.z + playerPos.z) * 0.5, 0xe879f9, 22);
      }
    },
    spawnBurst,
    spawnDust,
    spawnTrailSparkle,
    spawnLevelUpCelebration,
    celebrateObjectiveDone,
    rallyAllToPlaza,
    triggerParadeBellRally,
    reactToPlayerEmote,
    reactToMeteorLanding,
    reactToStarTakeoff,
    setWeather(mode) {
      currentWeather = mode;
    },
    emitWorkshopFx,
    spawnCourierArc,
    setCompanionActors,
    getCompanionActorIds,
    triggerPhotoGroupPose,
    triggerAdmiralEmoteReaction,
    triggerWelcomeBriefing,
    triggerSquadronRingBoost,
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
    update(dt, elapsed, nightFactor, playerPos, focusedActorId, isWalkable, resolveMovement, companionCtx) {
      if (director.celebratingTimer > 0) {
        director.celebratingTimer = Math.max(0, director.celebratingTimer - dt);
      }

      const isNight = nightFactor > 0.72;
      let nearestId: string | null = null;
      let nearestDist = 4.6;

      // 라이브 Objective 팀 회의 허들 계산 (같은 rootObjectiveId의 작업 중 지휘관+멤버가 마을 광장 홀로그램 테이블 둘레 r≈1.85m 집결)
      huddleGroupsScratch.clear();
      huddleSlotScratch.clear();
      for (let hi = 0; hi < motionList.length; hi += 1) {
        const hm = motionList[hi]!;
        if (hm.spec.role === "commodore") continue;
        const rootId = hm.spec.rootObjectiveId ?? hm.spec.objectiveId;
        if (!rootId) continue;
        let grp = huddleGroupsScratch.get(rootId);
        if (!grp) {
          grp = [];
          huddleGroupsScratch.set(rootId, grp);
        }
        grp.push(hm);
      }
      for (const grp of huddleGroupsScratch.values()) {
        if (grp.length < 2) continue;
        let hasActive = false;
        let hubX = grp[0]!.spec.homeX;
        let hubZ = grp[0]!.spec.homeZ;
        let foundVillageHub = false;
        for (let gi = 0; gi < grp.length; gi += 1) {
          const gm = grp[gi]!;
          if (gm.spec.state === "running" || gm.spec.activity !== null) {
            hasActive = true;
          }
          if (!foundVillageHub && gm.spec.commodoreId) {
            const vp = villagePatrolPlans.get(gm.spec.commodoreId);
            if (vp) {
              hubX = vp.centerX;
              hubZ = vp.centerZ;
              foundVillageHub = true;
            }
          }
        }
        if (!hasActive) continue;
        const huddleRadius = 1.85;
        for (let gi = 0; gi < grp.length; gi += 1) {
          const gm = grp[gi]!;
          const ang = (gi / grp.length) * Math.PI * 2 + 0.35;
          huddleSlotScratch.set(gm.spec.id, {
            x: hubX + Math.cos(ang) * huddleRadius,
            z: hubZ + Math.sin(ang) * huddleRadius,
            hubX,
            hubZ,
          });
        }
      }

      for (let idx = 0; idx < motionList.length; idx += 1) {
        const m = motionList[idx]!;
        if (m.speechTimer > 0 && m.speechTimer < 900) {
          m.speechTimer = Math.max(0, m.speechTimer - dt);
          if (m.speechTimer === 0) m.speech = "";
        }
        m.hopBoost = Math.max(0, m.hopBoost - dt * 1.9);

        const distToPlayer = Math.hypot(m.x - playerPos.x, m.z - playerPos.z);
        if (distToPlayer < nearestDist && m.flightAlt < 1.2) {
          nearestDist = distToPlayer;
          nearestId = m.spec.id;
        }

        const isFocused = m.spec.id === focusedActorId;
        if (isFocused && m.speechTimer > 0 && m.speechTimer < 900) {
          // 대화/상호작용 포커스 대상은 기존 길거리 잡담 말풍선을 즉시 정리해 3D 얼굴·이름표 가림을 방지한다
          m.speech = "";
          m.speechTimer = 0;
        }

        // 동행 사령관 편대(함께 산책 V자 행렬 · 모닥불 합석 · 하늘 순찰 V자 편대 비행 · 작업 시 개별 자동 복귀)
        const slotIndex = companionActorIds.indexOf(m.spec.id);
        if (slotIndex >= 0) {
          const dutyActive = m.spec.state === "running" || m.spec.needsAttention;
          if (dutyActive) {
            companionActorIds.splice(slotIndex, 1);
            companionStates.delete(m.spec.id);
            m.flightAlt = 0;
            m.flightRoll = 0;
            m.flightPitch = 0;
            const psDuty = patrolStates.get(m.spec.id);
            if (psDuty) {
              psDuty.route.length = 0;
              psDuty.workingCommute = false;
              psDuty.waitTimer = 0;
            }
            m.hopBoost = Math.max(m.hopBoost, 1.1);
            companionCtx?.onCompanionDutyReturn?.(m.spec);
            // 일반 워크플로우 루프로 자연스럽게 fall-through해 자기 마을로 달려간다
          } else if (!isFocused) {
            const cs = getOrCreateCompanionState(m.spec.id);
            const side = slotIndex % 2 === 0 ? 1 : -1;
            const rank = Math.floor(slotIndex / 2) + 1;

            const cYaw = companionCtx?.playerYaw ?? 0;
            const takeoffPhase = companionCtx?.playerTakeoffPhase ?? "none";
            const takeoffProgress = companionCtx?.playerTakeoffProgress ?? 0;
            const pFlying = companionCtx?.playerFlying ?? false;
            const pDiving = companionCtx?.playerDiving ?? false;
            const pFlightAlt = companionCtx?.playerFlightAlt ?? 0;
            const pMoveSpeed = companionCtx?.playerMoveSpeed ?? 0;
            const pFlightRoll = companionCtx?.playerFlightRoll ?? 0;
            const pFlightPitch = companionCtx?.playerFlightPitch ?? 0;
            const pBarrelRollTimer = companionCtx?.playerBarrelRollTimer ?? 0;
            const pHeroLandTimer = companionCtx?.playerHeroLandTimer ?? 0;
            const pCampfire = companionCtx?.playerSittingAtCampfire ?? false;

            const anim = getOrCreateAnimState(m.spec.id);
            if (anim.emoteTimer > 0) {
              anim.emoteTimer = Math.max(0, anim.emoteTimer - dt);
              anim.emoteElapsed += dt;
              if (anim.emoteTimer === 0) anim.emoteKind = null;
            }
            if (anim.photoPoseTimer > 0) {
              anim.photoPoseTimer = Math.max(0, anim.photoPoseTimer - dt);
            }

            const rightX = Math.cos(cYaw);
            const rightZ = -Math.sin(cYaw);
            const backX = -Math.sin(cYaw);
            const backZ = -Math.cos(cYaw);

            // 1) 1단계 줌인 화이팅 이륙 충전: 제독 양옆 부채꼴 대형으로 함께 화이팅 포즈!
            if (takeoffPhase === "charge") {
              const lat = side * (1.75 + (rank - 1) * 1.15);
              const back = (rank - 1) * 1.15;
              const slotX = playerPos.x + rightX * lat + backX * back;
              const slotZ = playerPos.z + rightZ * lat + backZ * back;
              const resolved = resolveMovement(m.x, m.z, m.x + (slotX - m.x) * Math.min(1, dt * 8), m.z + (slotZ - m.z) * Math.min(1, dt * 8), 0.44);
              m.x = resolved.x;
              m.z = resolved.z;
              m.tx = m.x;
              m.tz = m.z;
              m.flightAlt = 0;
              m.flightRoll = 0;
              m.flightPitch = 0;
              m.yaw = cYaw;
              m.moving = false;
              m.moveSpeed = 0;
              m.worldAnim = "takeoff-charge";
              m.animPhase = takeoffProgress;
              m.expression = "happy";
              m.blush = 0.78;
              m.gazeTargetX = null;
              m.gazeTargetZ = null;
              cs.prevHeroLand = false;
              continue;
            }

            // 2) 2단계 회오리 수직 상승: 편대 전체가 나란히 빙글빙글 회오리 급상승!
            if (takeoffPhase === "ascend") {
              const lat = side * (2.0 + (rank - 1) * 1.35);
              const back = 0.75 + (rank - 1) * 1.35;
              const slotX = playerPos.x + rightX * lat + backX * back;
              const slotZ = playerPos.z + rightZ * lat + backZ * back;
              const k = Math.min(1, dt * 7.5);
              m.x += (slotX - m.x) * k;
              m.z += (slotZ - m.z) * k;
              m.tx = m.x;
              m.tz = m.z;
              m.flightAlt += (Math.max(0, pFlightAlt - 0.25 * rank) - m.flightAlt) * Math.min(1, dt * 10);
              m.flightRoll = 0;
              m.flightPitch = 0;
              m.yaw = cYaw;
              m.moving = true;
              m.moveSpeed = 12;
              m.worldAnim = "takeoff-ascend";
              m.animPhase = takeoffProgress;
              m.expression = "happy";
              m.blush = 0.65;
              m.gazeTargetX = null;
              m.gazeTargetZ = null;
              cs.sparkleAccum += dt;
              const ascendSparkleInterval = 0.055 + Math.min(0.05, (rank - 1) * 0.015);
              if (cs.sparkleAccum >= ascendSparkleInterval) {
                cs.sparkleAccum = 0;
                spawnTrailSparkle(m.x, m.flightAlt + 0.3, m.z, 0xfde047, 0.62, false);
              }
              continue;
            }

            // 3) 하늘 순찰 V자 편대 동시 비행 (+ Shift 부스트 밀착 추종 · 미니 별꼬리 · Space 배럴롤 파도 전파!)
            if (pFlying) {
              const pBoosting = companionCtx?.playerBoosting ?? false;
              const pVx = companionCtx?.playerVx ?? 0;
              const pVz = companionCtx?.playerVz ?? 0;
              const lat = side * (2.1 + (rank - 1) * 1.75);
              const back = 1.6 + (rank - 1) * 1.65;
              const leadSec = pBoosting ? 0.055 : 0.03;
              const wingX = playerPos.x + pVx * leadSec + rightX * lat + backX * back;
              const wingZ = playerPos.z + pVz * leadSec + rightZ * lat + backZ * back;
              const wingAlt = Math.max(0.6, pFlightAlt - 0.28 * rank + Math.sin(elapsed * 2.7 + slotIndex * 0.9) * 0.28);
              const k = Math.min(1, dt * (pBoosting ? 16.5 : 8.5));
              m.x += (wingX - m.x) * k;
              m.z += (wingZ - m.z) * k;
              m.tx = wingX;
              m.tz = wingZ;
              m.flightAlt += (wingAlt - m.flightAlt) * Math.min(1, dt * (pBoosting ? 10.5 : 6.8));

              // 플레이어 배럴롤 감지 → V자 편대를 따라 앞줄→뒷줄 순차 파도처럼 360° 배럴롤!
              if (pBarrelRollTimer > 0.42 && cs.barrelDelay <= 0 && cs.barrelTimer <= 0) {
                cs.barrelDelay = 0.09 + (rank - 1) * 0.08 + (side < 0 ? 0.03 : 0);
              }
              let extraRoll = 0;
              if (cs.barrelDelay > 0) {
                cs.barrelDelay = Math.max(0, cs.barrelDelay - dt);
                if (cs.barrelDelay === 0) {
                  cs.barrelTimer = 0.55;
                }
              }
              if (cs.barrelTimer > 0) {
                cs.barrelTimer = Math.max(0, cs.barrelTimer - dt);
                const u = 1 - cs.barrelTimer / 0.55;
                const smoothU = u * u * (3 - 2 * u);
                extraRoll = smoothU * Math.PI * 2;
              }

              let dfYaw = cYaw - m.yaw;
              while (dfYaw > Math.PI) dfYaw -= Math.PI * 2;
              while (dfYaw < -Math.PI) dfYaw += Math.PI * 2;
              m.yaw += dfYaw * Math.min(1, dt * (pBoosting ? 13.0 : 8.5));
              m.moving = pMoveSpeed > 0.6;
              m.moveSpeed = pMoveSpeed;
              m.flightRoll = pFlightRoll + extraRoll;
              m.flightPitch = pFlightPitch;
              m.worldAnim = "fly";
              m.animPhase = 0;
              m.expression = pBoosting || pMoveSpeed > 20 ? "happy" : "normal";
              m.blush = pBoosting ? 0.72 : pMoveSpeed > 20 ? 0.55 : 0.25;
              m.gazeTargetX = null;
              m.gazeTargetZ = null;

              cs.sparkleAccum += dt;
              const flySparkleInterval = pBoosting
                ? 0.034 + Math.min(0.024, (rank - 1) * 0.006)
                : 0.09 + Math.min(0.06, (rank - 1) * 0.015);
              if (pMoveSpeed > 2.5 && cs.sparkleAccum >= flySparkleInterval) {
                cs.sparkleAccum = 0;
                const trailColor = pBoosting
                  ? (((Math.floor(elapsed * 24) + slotIndex) % 2 === 0) ? vividToneHex(m.spec.tone) : 0xffe57f)
                  : 0x7dd3fc;
                spawnTrailSparkle(
                  m.x + backX * 0.45,
                  m.flightAlt + 0.45,
                  m.z + backZ * 0.45,
                  trailColor,
                  pBoosting ? 0.68 : 0.55,
                  pBoosting,
                );
              }
              cs.prevHeroLand = false;
              continue;
            }

            // 4) 유성 급강하 편대 동반 착지
            if (pDiving) {
              const lat = side * (1.9 + (rank - 1) * 1.25);
              const back = 0.5 + (rank - 1) * 1.15;
              const diveX = playerPos.x + rightX * lat + backX * back;
              const diveZ = playerPos.z + rightZ * lat + backZ * back;
              const k = Math.min(1, dt * 9.5);
              m.x += (diveX - m.x) * k;
              m.z += (diveZ - m.z) * k;
              m.tx = diveX;
              m.tz = diveZ;
              m.flightAlt += (Math.max(0, pFlightAlt) - m.flightAlt) * Math.min(1, dt * 11.5);
              m.yaw = cYaw;
              m.moving = true;
              m.moveSpeed = Math.max(16, pMoveSpeed);
              m.flightRoll = pFlightRoll;
              m.flightPitch = pFlightPitch;
              m.worldAnim = "dive";
              m.animPhase = elapsed;
              m.expression = "happy";
              m.blush = 0.65;
              m.gazeTargetX = null;
              m.gazeTargetZ = null;
              cs.prevHeroLand = false;
              continue;
            }

            // 5) 유성 착지 직후 편대 동반 히어로 착지 → 기쁜 박수/환호!
            if (pHeroLandTimer > 0) {
              m.flightAlt *= Math.max(0, 1 - dt * 16);
              if (m.flightAlt < 0.04) m.flightAlt = 0;
              m.flightRoll = 0;
              m.flightPitch = 0;
              const safeLand = resolveMovement(m.x, m.z, m.x, m.z, 0.46);
              m.x = safeLand.x;
              m.z = safeLand.z;
              m.tx = m.x;
              m.tz = m.z;
              m.moving = false;
              m.moveSpeed = 0;
              m.worldAnim = "hero-land";
              m.animPhase = 1 - Math.min(1, pHeroLandTimer / 0.56);
              m.expression = "happy";
              m.blush = 0.72;
              m.gazeTargetX = playerPos.x;
              m.gazeTargetZ = playerPos.z;
              cs.prevHeroLand = true;
              continue;
            }

            if (cs.prevHeroLand) {
              cs.prevHeroLand = false;
              m.hopBoost = Math.max(m.hopBoost, 1.35);
              triggerActorEmote(m.spec.id, "cheer", 1.15);
              spawnBurst(m.x, 1.4, m.z, 0xfde047, 8);
            }

            // 지상 복귀 정리
            m.flightAlt *= Math.max(0, 1 - dt * 12);
            if (m.flightAlt < 0.02) m.flightAlt = 0;
            m.flightRoll *= Math.max(0, 1 - dt * 12);
            m.flightPitch *= Math.max(0, 1 - dt * 12);

            // 6) 모닥불 합석 동행: 모닥불(2.8, 1.0) 기준 북·동·서쪽(남쪽 벤치·카메라 맞은편 호)에 둘러앉아 불멍!
            if (pCampfire) {
              let seatX: number;
              let seatZ: number;
              const presetSeat = CAMPFIRE_COMPANION_SEATS[slotIndex];
              if (presetSeat) {
                seatX = presetSeat.x;
                seatZ = presetSeat.z;
              } else {
                const outerIdx = slotIndex - CAMPFIRE_COMPANION_SEATS.length;
                const outerCount = Math.max(1, companionActorIds.length - CAMPFIRE_COMPANION_SEATS.length);
                const theta = outerCount === 1
                  ? -Math.PI * 0.5
                  : -0.18 - (outerIdx / (outerCount - 1)) * (Math.PI - 0.36);
                seatX = 2.8 + Math.cos(theta) * 3.25;
                seatZ = 1.0 + Math.sin(theta) * 3.25;
              }
              const sd = Math.hypot(seatX - m.x, seatZ - m.z);
              if (sd > 0.36) {
                const step = Math.min(sd, 3.6 * dt);
                const resolved = resolveMovement(m.x, m.z, m.x + ((seatX - m.x) / sd) * step, m.z + ((seatZ - m.z) / sd) * step, 0.44);
                m.x = resolved.x;
                m.z = resolved.z;
                m.tx = seatX;
                m.tz = seatZ;
                m.yaw = Math.atan2(seatX - m.x, seatZ - m.z);
                m.moving = true;
                m.moveSpeed = 3.2;
                m.worldAnim = "walk";
                m.expression = "happy";
                m.blush = 0.35;
              } else {
                m.tx = m.x;
                m.tz = m.z;
                m.moving = false;
                m.moveSpeed = 0;
                const fireYaw = Math.atan2(2.8 - m.x, 1.0 - m.z);
                let df = fireYaw - m.yaw;
                while (df > Math.PI) df -= Math.PI * 2;
                while (df < -Math.PI) df += Math.PI * 2;
                m.yaw += df * Math.min(1, dt * 6.5);
                m.worldAnim = isNight ? "doze" : "sit";
                m.expression = isNight ? "sleepy" : "happy";
                m.blush = 0.48;
                m.gazeTargetX = 2.8;
                m.gazeTargetZ = 1.0;
              }
              continue;
            }

            // 7) 지상 함께 산책: 별 제독 뒤로 좌우 교대 V자 오리 행렬을 이뤄 경쾌하게 추종!
            const walkLat = side * (1.15 + (rank - 1) * 0.85);
            const walkBack = 1.75 + (rank - 1) * 1.35;
            const followX = playerPos.x + backX * walkBack + rightX * walkLat;
            const followZ = playerPos.z + backZ * walkBack + rightZ * walkLat;
            const followDist = Math.hypot(followX - m.x, followZ - m.z);

            if (followDist > 16.0) {
              // 강이나 장애물로 너무 멀어졌으면 부드럽게 별빛 워프 합류
              const safe = resolveMovement(playerPos.x, playerPos.z, followX, followZ, 0.46);
              m.x = safe.x;
              m.z = safe.z;
              spawnBurst(m.x, 1.35, m.z, 0xfde047, 8);
            }

            let companionActualSpd = 0;
            if (followDist > 0.85 && anim.photoPoseTimer <= 0) {
              const spd = followDist > 5.0 ? 5.8 : followDist > 2.6 ? 4.1 : 2.9;
              const step = Math.min(followDist - 0.55, spd * dt);
              if (step > 0.001) {
                const steered = stepWithObstacleSteering(m.spec.id, m.x, m.z, followX, followZ, step, 0.45, dt, resolveMovement);
                const moved = steered.moved;
                m.x = steered.x;
                m.z = steered.z;
                m.yaw = steered.yaw;
                m.moving = moved > 0.002;
                companionActualSpd = dt > 0.0001 ? moved / dt : 0;
              } else {
                m.moving = false;
              }
            } else {
              m.moving = false;
              const lookTargetX = anim.photoPoseTimer > 0 && anim.photoLookX !== null ? anim.photoLookX : playerPos.x;
              const lookTargetZ = anim.photoPoseTimer > 0 && anim.photoLookZ !== null ? anim.photoLookZ : playerPos.z;
              const targetYaw = Math.atan2(lookTargetX - m.x, lookTargetZ - m.z);
              let df = targetYaw - m.yaw;
              while (df > Math.PI) df -= Math.PI * 2;
              while (df < -Math.PI) df += Math.PI * 2;
              m.yaw += df * Math.min(1, dt * 6.5);
            }

            m.tx = followX;
            m.tz = followZ;
            m.moveSpeed = companionActualSpd;
            m.animPhase = anim.emoteTimer > 0 ? anim.emoteElapsed : 0;
            m.gazeTargetX = anim.photoPoseTimer > 0 && anim.photoLookX !== null ? anim.photoLookX : playerPos.x;
            m.gazeTargetZ = anim.photoPoseTimer > 0 && anim.photoLookZ !== null ? anim.photoLookZ : playerPos.z;

            if (anim.photoPoseTimer > 0) {
              m.worldAnim = "cheer";
              m.expression = "happy";
              m.blush = 0.85;
            } else if (anim.emoteTimer > 0 && anim.emoteKind) {
              m.worldAnim = anim.emoteKind;
              m.expression = "happy";
              m.blush = 0.8;
            } else if (m.moving) {
              m.worldAnim = companionActualSpd > 3.5 ? "sprint" : "walk";
              m.expression = "happy";
              m.blush = 0.25;
            } else {
              m.worldAnim = "idle";
              m.expression = "happy";
              m.blush = 0.35;
            }
            continue;
          }
        }

        // 비동행 액터는 비행 고도/기울기 0으로 깔끔히 유지
        m.flightAlt = 0;
        m.flightRoll = 0;
        m.flightPitch = 0;

        // 입장 웰컴 브리핑: 가장 가까운 사령관이 제독 앞 ~2.4m까지 달려와 점프·손흔들기 + 4.8초간 브리핑 말풍선 연출
        if (welcomeBriefing && welcomeBriefing.actorId === m.spec.id) {
          if (isFocused || (companionCtx?.playerFlying ?? false)) {
            welcomeBriefing = null;
          } else {
            welcomeBriefing.timer -= dt;
            if (welcomeBriefing.timer <= 0) {
              welcomeBriefing = null;
            } else {
              const anim = getOrCreateAnimState(m.spec.id);
              if (anim.emoteTimer > 0) {
                anim.emoteTimer = Math.max(0, anim.emoteTimer - dt);
                anim.emoteElapsed += dt;
                if (anim.emoteTimer === 0) anim.emoteKind = null;
              }
              const bDist = Math.hypot(welcomeBriefing.targetX - m.x, welcomeBriefing.targetZ - m.z);
              if (!welcomeBriefing.arrived && bDist > 0.55) {
                const step = Math.min(bDist, 4.9 * dt);
                const steered = stepWithObstacleSteering(
                  m.spec.id,
                  m.x,
                  m.z,
                  welcomeBriefing.targetX,
                  welcomeBriefing.targetZ,
                  step,
                  0.46,
                  dt,
                  resolveMovement,
                );
                const moved = steered.moved;
                m.x = steered.x;
                m.z = steered.z;
                m.tx = welcomeBriefing.targetX;
                m.tz = welcomeBriefing.targetZ;
                m.yaw = steered.yaw;
                m.moving = moved > 0.002;
                m.moveSpeed = dt > 0.0001 ? moved / dt : 0;
                m.worldAnim = m.moveSpeed > 3.5 ? "sprint" : "walk";
                m.expression = "happy";
                m.blush = 0.45;
                m.gazeTargetX = welcomeBriefing.lookX;
                m.gazeTargetZ = welcomeBriefing.lookZ;
                if (moved < 0.002 && bDist < 3.6) {
                  // 장애물로 더 가까이 못 가도 즉시 도착 처리해 브리핑 개시
                  welcomeBriefing.arrived = true;
                  welcomeBriefing.timer = Math.max(welcomeBriefing.timer, 4.8);
                  m.hopBoost = Math.max(m.hopBoost, 1.45);
                  triggerActorEmote(m.spec.id, "wave", 2.4);
                  m.speech = welcomeBriefing.speech;
                  m.speechTimer = 4.8;
                  spawnBurst(m.x, 1.55, m.z, 0xfde047, 12);
                }
              } else {
                if (!welcomeBriefing.arrived) {
                  welcomeBriefing.arrived = true;
                  welcomeBriefing.timer = 4.8;
                  m.hopBoost = Math.max(m.hopBoost, 1.45);
                  triggerActorEmote(m.spec.id, "wave", 2.4);
                  m.speech = welcomeBriefing.speech;
                  m.speechTimer = 4.8;
                  spawnBurst(m.x, 1.55, m.z, 0xfde047, 12);
                }
                m.tx = m.x;
                m.tz = m.z;
                m.moving = false;
                m.moveSpeed = 0;
                const lookYaw = Math.atan2(welcomeBriefing.lookX - m.x, welcomeBriefing.lookZ - m.z);
                let df = lookYaw - m.yaw;
                while (df > Math.PI) df -= Math.PI * 2;
                while (df < -Math.PI) df += Math.PI * 2;
                m.yaw += df * Math.min(1, dt * 7.5);
                m.worldAnim = anim.emoteTimer > 0 && anim.emoteKind ? anim.emoteKind : "idle";
                m.animPhase = anim.emoteTimer > 0 ? anim.emoteElapsed : 0;
                m.expression = "happy";
                m.blush = 0.72;
                m.gazeTargetX = welcomeBriefing.lookX;
                m.gazeTargetZ = welcomeBriefing.lookZ;
              }
              continue;
            }
          }
        }

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
            // 대화/상호작용 중인 사령관은 제자리에 멈춰 제독을 응대하고 길거리 잡담을 중단한다
            m.tx = m.x;
            m.tz = m.z;
            ps.route.length = 0;
            ps.chatPauseTimer = 0;
            ps.rallying = false;
            ps.workingCommute = false;
            const focusedAnim = animStates.get(m.spec.id);
            if (focusedAnim) {
              focusedAnim.banterTimer = 0;
              focusedAnim.banterPartnerX = null;
              focusedAnim.banterPartnerZ = null;
            }
          } else if (ps.rallying) {
            // 함대 상황실 긴급 소집: 목교·정문을 거쳐 중앙 길드 광장 앞 반원 대형으로 4.2 m/s 신속 집결
            const distToTarget = Math.hypot(m.tx - m.x, m.tz - m.z);
            if (distToTarget < 0.38 && ps.route.length > 0) {
              const nextHop = ps.route.shift()!;
              m.tx = nextHop.x;
              m.tz = nextHop.z;
              ps.faceX = nextHop.faceX;
              ps.faceZ = nextHop.faceZ;
              ps.stuckTimer = 0;
            } else if (distToTarget < 0.36 && ps.route.length === 0) {
              if (!ps.rallyArrived) {
                ps.rallyArrived = true;
                m.hopBoost = Math.max(m.hopBoost, 1.68);
                triggerActorEmote(m.spec.id, ps.rallyEmote, 2.4);
                if (m.speechTimer < 900) {
                  m.speech = ps.rallySpeech
                    ? `[cheer] ${ps.rallySpeech}`
                    : "[cheer] 집결 완료! 명령을 기다립니다!";
                  m.speechTimer = ps.rallySpeech ? 5.2 : 3.5;
                }
                spawnBurst(m.x, 1.5, m.z, 0xfbbf24, 10);
              }
              ps.rallyHoldTimer -= dt;
              if (ps.rallyHoldTimer <= 0) {
                ps.rallying = false;
                ps.rallySpeech = null;
                ps.waitTimer = 1.6 + Math.random() * 2.0;
              }
            }
            moveSpeed = ps.rallySpeech ? 5.0 : 4.2;
          } else if (ps.chatPauseTimer > 0) {
            // 길 위 사령관 수다 / 제독 감정표현 반응 중: 2.5초간 상대를 마주 보고 멈춰 서서 대화
            ps.chatPauseTimer = Math.max(0, ps.chatPauseTimer - dt);
            moveSpeed = 0;
            patrolFaceX = ps.chatFaceX ?? ps.faceX;
            patrolFaceZ = ps.chatFaceZ ?? ps.faceZ;
          } else if (!isWorking && m.spec.needsAttention && distToPlayer < 18.0) {
            // 긴급 확인이 필요한 유휴 사령관이 18m 이내에 있으면 제독에게 직접 다가가 손을 흔들며 주의를 끈다
            ps.route.length = 0;
            ps.workingCommute = false;
            patrolFaceX = playerPos.x;
            patrolFaceZ = playerPos.z;
            if (distToPlayer > 2.85) {
              const nx = (m.x - playerPos.x) / distToPlayer;
              const nz = (m.z - playerPos.z) / distToPlayer;
              const desiredX = playerPos.x + nx * 2.35;
              const desiredZ = playerPos.z + nz * 2.35;
              if (isWalkable(desiredX, desiredZ)) {
                m.tx = desiredX;
                m.tz = desiredZ;
              } else {
                m.tx = playerPos.x;
                m.tz = playerPos.z;
              }
              moveSpeed = 3.15;
            } else {
              m.tx = m.x;
              m.tz = m.z;
              moveSpeed = 0;
              if (m.hopBoost <= 0.02 && Math.sin(elapsed * 2.4 + idx) > 0.96) {
                m.hopBoost = 0.55;
              }
            }
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

            // 마실 중인 두 사령관이 3.2m 이내에서 마주치면(쿨다운 18초) 2.5초간 마주 보고 서서 실제 Fleet 상태 수다!
            if (m.moving && ps.greetCooldown <= 0) {
              for (let oi = 0; oi < motionList.length; oi += 1) {
                const other = motionList[oi]!;
                if (other === m || other.spec.role !== "commodore" || other.spec.id === focusedActorId) continue;
                const otherPlan = other.spec.commodoreId ? villagePatrolPlans.get(other.spec.commodoreId) : undefined;
                if (!otherPlan) continue;
                const ops = getOrCreatePatrolState(other);
                if (ops.greetCooldown > 0 || ops.chatPauseTimer > 0 || ops.rallying || ops.workingCommute) continue;
                if (Math.hypot(other.x - m.x, other.z - m.z) < 3.2) {
                  const [lineA, lineB] = buildRoadsideChatPair(patrolPlan, otherPlan, m.spec.name, other.spec.name);
                  const animA = getOrCreateAnimState(m.spec.id);
                  const animB = getOrCreateAnimState(other.spec.id);
                  animA.banterTimer = 2.6;
                  animA.banterPartnerX = other.x;
                  animA.banterPartnerZ = other.z;
                  animB.banterTimer = 2.6;
                  animB.banterPartnerX = m.x;
                  animB.banterPartnerZ = m.z;
                  ps.greetCooldown = 18;
                  ops.greetCooldown = 18;
                  ps.chatPauseTimer = 2.5;
                  ops.chatPauseTimer = 2.5;
                  ps.chatFaceX = other.x;
                  ps.chatFaceZ = other.z;
                  ops.chatFaceX = m.x;
                  ops.chatFaceZ = m.z;
                  m.hopBoost = Math.max(m.hopBoost, 0.72);
                  other.hopBoost = Math.max(other.hopBoost, 0.72);
                  if (m.speechTimer < 900) {
                    m.speech = lineA;
                    m.speechTimer = 3.4;
                  }
                  if (other.speechTimer < 900) {
                    other.speech = lineB;
                    other.speechTimer = 3.6;
                  }
                  moveSpeed = 0;
                  patrolFaceX = other.x;
                  patrolFaceZ = other.z;
                  break;
                }
              }
            }
          }

          if (patrolFaceX === null) {
            patrolFaceX = ps.faceX;
            patrolFaceZ = ps.faceZ;
          }
        } else if (isFocused) {
          // 상호작용 중인 대상은 제자리에 멈춰 서서 제독을 바라본다
          m.tx = m.x;
          m.tz = m.z;
        } else if (!m.carrying && huddleSlotScratch.has(m.spec.id)) {
          // 라이브 Objective 팀 회의 허들: 같은 목표의 지휘관·구성원이 마을 광장(r=1.85m)을 둘러싸고 마주 보며 협업 + 현장 중계!
          const hSlot = huddleSlotScratch.get(m.spec.id)!;
          m.tx = hSlot.x;
          m.tz = hSlot.z;
          patrolFaceX = hSlot.hubX;
          patrolFaceZ = hSlot.hubZ;
          moveSpeed = 3.2;

          if (m.spec.state === "running" || m.spec.activity !== null) {
            const actKey = m.spec.activity ?? "work";
            let tr = huddleActivityTracker.get(m.spec.id);
            if (!tr) {
              tr = { activity: actKey, calloutCooldown: 2.5 + (idx % 4) * 2.2 };
              huddleActivityTracker.set(m.spec.id, tr);
            }
            tr.calloutCooldown = Math.max(0, tr.calloutCooldown - dt);
            const changed = tr.activity !== actKey;
            if (changed) {
              tr.activity = actKey;
              tr.calloutCooldown = Math.min(tr.calloutCooldown, 0.8);
            }
            if (tr.calloutCooldown <= 0 && m.speechTimer <= 0) {
              m.speech = resolveFieldActivityCallout(m.spec.activity);
              m.speechTimer = 3.8;
              tr.calloutCooldown = 12.0 + Math.random() * 6.0;
            }
          }
        } else if (m.spec.state === "idle" && isNight && Math.hypot(m.spec.homeX - 2.8, m.spec.homeZ - 1.0) < 36) {
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
        let actualSpeed = 0;
        if (moveSpeed > 0.01 && dist > 0.08) {
          const step = Math.min(dist, moveSpeed * dt);
          const steered = stepWithObstacleSteering(m.spec.id, m.x, m.z, m.tx, m.tz, step, 0.46, dt, resolveMovement);
          const moved = steered.moved;
          m.x = steered.x;
          m.z = steered.z;
          m.yaw = steered.yaw;
          m.moving = moved > 0.002;
          actualSpeed = dt > 0.0001 ? moved / dt : 0;

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
                  actualSpeed = 0;
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
          actualSpeed = 0;
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

        // Sprint 7: 전용 애니메이션 모드 · 표정 · 볼터치 · 시선 · 수면/빗물털기 입자 상태 갱신
        m.moveSpeed = actualSpeed;
        const anim = getOrCreateAnimState(m.spec.id);
        if (anim.emoteTimer > 0) {
          anim.emoteTimer = Math.max(0, anim.emoteTimer - dt);
          anim.emoteElapsed += dt;
          if (anim.emoteTimer === 0) anim.emoteKind = null;
        }
        if (anim.surprisedTimer > 0) {
          anim.surprisedTimer = Math.max(0, anim.surprisedTimer - dt);
        }
        if (anim.banterTimer > 0) {
          anim.banterTimer = Math.max(0, anim.banterTimer - dt);
          if (anim.banterTimer === 0) {
            anim.banterPartnerX = null;
            anim.banterPartnerZ = null;
          }
        }
        if (anim.photoPoseTimer > 0) {
          anim.photoPoseTimer = Math.max(0, anim.photoPoseTimer - dt);
          if (anim.photoPoseTimer === 0) {
            anim.photoLookX = null;
            anim.photoLookZ = null;
          }
        }

        const actorWorking =
          m.spec.state === "running"
          || m.spec.activity !== null
          || (patrolPlan?.villageWorkStep ?? null) !== null;

        // 비 올 때 가끔 부르르 빗물 털어내기(`shake`) + 물방울 스플래시 입자
        if (currentWeather === "rain") {
          if (anim.shakeTimer > 0) {
            anim.shakeTimer = Math.max(0, anim.shakeTimer - dt);
            anim.shakeFxAccum += dt;
            if (anim.shakeFxAccum >= 0.085) {
              anim.shakeFxAccum = 0;
              const ang = Math.random() * Math.PI * 2;
              const spd = 1.4 + Math.random() * 1.4;
              pushParticle({
                x: m.x + Math.cos(ang) * 0.35,
                y: 0.95 + Math.random() * 0.35,
                z: m.z + Math.sin(ang) * 0.35,
                vx: Math.cos(ang) * spd,
                vy: 1.5 + Math.random() * 1.1,
                vz: Math.sin(ang) * spd,
                gravity: 6.2,
                scale: 0.42 + Math.random() * 0.2,
                life: 0.42,
                maxLife: 0.42,
                colorHex: 0xbae6fd,
                glowBoost: 1.25,
              });
            }
          } else {
            anim.shakeCooldown -= dt;
            if (anim.shakeCooldown <= 0 && !isFocused && !actorWorking && anim.emoteTimer <= 0) {
              anim.shakeTimer = 1.05;
              anim.shakeFxAccum = 0;
              anim.shakeCooldown = 11 + Math.random() * 12;
            }
          }
        } else {
          anim.shakeTimer = 0;
        }

        // 야간 유휴 수면(`sleep`) 진입 + 제독 근접/작업 시작 시 깜짝 기상(`surprised`)
        const canSleep = isNight && !actorWorking && !m.moving && !isFocused && distToPlayer > 4.2 && anim.emoteTimer <= 0 && anim.banterTimer <= 0;
        if (canSleep) {
          anim.sleepyTimer += dt;
        } else {
          if (anim.wasSleeping && (distToPlayer <= 4.2 || isFocused || actorWorking)) {
            anim.surprisedTimer = 0.85;
            m.hopBoost = Math.max(m.hopBoost, 0.92);
          }
          anim.sleepyTimer = 0;
          anim.wasSleeping = false;
        }

        const isSleeping = canSleep && anim.sleepyTimer > 4.5;
        if (isSleeping) {
          anim.wasSleeping = true;
          anim.sleepFxAccum += dt;
          if (anim.sleepFxAccum >= 1.15) {
            anim.sleepFxAccum = 0;
            pushParticle({
              x: m.x + (Math.random() - 0.5) * 0.25,
              y: 1.45,
              z: m.z + (Math.random() - 0.5) * 0.25,
              vx: 0.14 + (Math.random() - 0.5) * 0.15,
              vy: 0.72 + Math.random() * 0.25,
              vz: -0.08 + (Math.random() - 0.5) * 0.15,
              gravity: -0.18,
              scale: 0.52 + Math.random() * 0.22,
              life: 1.35,
              maxLife: 1.35,
              colorHex: 0xc4b5fd,
              glowBoost: 1.35,
            });
          }
        }

        const attentionBeckon =
          !isFocused
          && !m.moving
          && !actorWorking
          && m.spec.needsAttention
          && distToPlayer < 18.0;

        // 최종 애니메이션 모드 · 표정 · 볼터치 · 시선 타깃 결정
        m.gazeTargetX = attentionBeckon
          ? playerPos.x
          : anim.banterTimer > 0
            ? anim.banterPartnerX
            : null;
        m.gazeTargetZ = attentionBeckon
          ? playerPos.z
          : anim.banterTimer > 0
            ? anim.banterPartnerZ
            : null;
        m.animPhase = anim.emoteTimer > 0 ? anim.emoteElapsed : 0;

        if (director.celebratingTimer > 0 || anim.photoPoseTimer > 0) {
          m.worldAnim = "cheer";
          m.expression = "happy";
          m.blush = 0.88;
        } else if (anim.emoteTimer > 0 && anim.emoteKind) {
          m.worldAnim = anim.emoteKind;
          m.expression = "happy";
          m.blush = anim.emoteKind === "spin" ? 0.92 : 0.80;
        } else if (anim.surprisedTimer > 0) {
          m.worldAnim = "idle";
          m.expression = "surprised";
          m.blush = 0.35;
        } else if (anim.shakeTimer > 0) {
          m.worldAnim = "shake";
          m.expression = "surprised";
          m.blush = 0.18;
        } else if (m.moving) {
          m.worldAnim = actualSpeed > 3.35 ? "sprint" : "walk";
          m.expression = actualSpeed > 3.35 ? "focused" : "normal";
          m.blush = 0.08;
        } else if (attentionBeckon) {
          // 긴급 확인 필요 사령관이 제독 근처에서 손을 흔들며(`wave` + `surprised`) 주의 끌기
          m.worldAnim = "wave";
          m.expression = "surprised";
          m.blush = 0.44;
        } else if (anim.banterTimer > 0 || (m.speechTimer > 0.35 && m.speechTimer < 900)) {
          m.worldAnim = "talk";
          m.expression = "happy";
          m.blush = anim.banterTimer > 0 ? 0.52 : 0.35;
        } else if (actorWorking) {
          m.worldAnim = mapWorkStepToAnim(patrolPlan?.villageWorkStep ?? null, m.spec.activity);
          m.expression = "focused";
          m.blush = 0.0;
        } else if (isSleeping) {
          m.worldAnim = "sleep";
          m.expression = "sleepy";
          m.blush = 0.22;
        } else {
          m.worldAnim = "idle";
          m.expression = isFocused ? "happy" : "normal";
          m.blush = isFocused ? 0.42 : 0.0;
        }
      }

      // 캐릭터 상호 겹침 방지 소프트 분리 (비행 중인 동행 윙맨은 지상 분리에서 제외)
      for (let i = 0; i < motionList.length; i += 1) {
        const a = motionList[i]!;
        if (a.flightAlt > 1.2) continue;
        for (let j = i + 1; j < motionList.length; j += 1) {
          const b = motionList[j]!;
          if (b.flightAlt > 1.2) continue;
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
      navSteerStates.clear();
      animStates.clear();
      huddleActivityTracker.clear();
      huddleGroupsScratch.clear();
      huddleSlotScratch.clear();
      companionActorIds.length = 0;
      companionStates.clear();
      welcomeBriefing = null;
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
