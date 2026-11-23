import {
  Box3,
  InstancedMesh,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Vector3,
  type Intersection,
} from "three";

import type { WorldCameraMode, WorldLifecycleState } from "../../shared/world-types.js";

/**
 * 데스크톱 3인칭 플레이어 물리 이동(`WASD`/방향키 가감속, `Shift` 질주, `Space` 점프, 장애물 슬라이딩 충돌) 및
 * 3인칭 어드벤처 추적(`follow`) · 초원 전역 패닝 조망(`orbit`) · 다이브/탈출 시네마틱 카메라 제어기.
 */

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  vy: number;
  /** 지면 대비 현재 점프 높이(m). */
  playerJumpY: number;
  /** 수직 점프 속도 (+상승 / -하강, 접지 시 0). */
  jumpVel: number;
  /** 착지 스쿼시 강도 (착지 순간 1.0 → 부드럽게 0으로 감쇠). */
  landSquash: number;
  /** 실제 수평 이동 속도 (m/s). */
  moveSpeed: number;
  /** 모닥불 벤치 착석 경과 초 (8초 초과 시 sit → doze 전환). */
  campfireSitSec: number;
  /** 별빛 상공 비행 고도 (지상 0, 자유 비행 ~18.0m). */
  flightAlt: number;
  /** 별빛 상공 자유 비행 활성 여부. */
  flying: boolean;
  /** 유성 급강하 착지 아크 진행 중 여부. */
  diving: boolean;
  /** 비행 중 `Shift` 별똥별 부스트 활성 여부. */
  boosting: boolean;
  /** 비행 회전 시 좌우 뱅킹 기울기 (rad). */
  flightRoll: number;
  /** 비행 전진·급강하 시 앞뒤 피치 기울기 (rad). */
  flightPitch: number;
  /** 별빛 2단계 이륙 시퀀스 단계 (`none` | `charge` 줌인 화이팅 | `ascend` 회오리 급상승). */
  takeoffPhase: "none" | "charge" | "ascend";
  /** 현재 이륙 단계 진행도 (0..1). */
  takeoffProgress: number;
  /** 유성 착지 직후 히어로 착지 포즈 잔여 초 (0.56 -> 0). */
  heroLandTimer: number;
  /** 비행 중 `Space` 360° 에일러론 배럴롤 잔여 초 (0.55 -> 0). */
  barrelRollTimer: number;
  yaw: number;
  walking: boolean;
  sprinting: boolean;
  onGround: boolean;
}

export interface CameraOccluder {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
  /** 선택적 하단 높이 (예: 지면에서 떠 있는 대형 수목 수관). 미지정 시 지면 높이를 사용한다. */
  readonly minY?: number | undefined;
}

export interface LandingVillageHint {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly gateAngle: number;
}

export interface LandingTargetOptions {
  /** 착지 후 아바타와 카메라가 정면으로 바라볼 월드 목표 X (예: 마을 광장 중심·랜드마크). */
  readonly lookAtX?: number | undefined;
  /** 착지 후 아바타와 카메라가 정면으로 바라볼 월드 목표 Z. */
  readonly lookAtZ?: number | undefined;
  /** true이면 추가 진입 오프셋 없이 지정 좌표에 직접 착지(충돌 슬라이딩만 보정). */
  readonly exactLanding?: boolean | undefined;
}

export type CameraFocusFraming = "none" | "dialogue" | "drawer" | "customizer" | "cinema";

export interface CinemaCameraTarget {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dist: number;
  readonly pitch: number;
}

export interface PlayerAndCameraController {
  readonly player: PlayerState;
  readonly cameraTarget: Vector3;
  /** 3인칭 카메라 차폐 회피(Spring-Arm)용 3D 메시/그룹(석문 기둥·담장·대형 수목 수관 등)을 등록한다 (프레임 루프 0-GC). */
  setCameraOccluders(objects: readonly Object3D[]): void;
  /** 마을 텔레포트·유성 착지 시 석문 기둥 뒤를 피해 탁 트인 광장 진입 지점과 정면 카메라 각도를 계산할 마을 배치 힌트를 동기화한다. */
  setVillageHints(villages: readonly LandingVillageHint[]): void;
  update(options: {
    readonly dt: number;
    readonly lifecycle: WorldLifecycleState;
    readonly cameraMode: WorldCameraMode;
    readonly reducedMotion: boolean;
    readonly inputLocked: boolean;
    readonly focusActorPos: { readonly x: number; readonly z: number } | null;
    readonly focusFraming?: CameraFocusFraming | undefined;
    readonly cinemaTarget?: CinemaCameraTarget | null | undefined;
    readonly companionCount?: number | undefined;
    readonly camera: PerspectiveCamera;
    readonly getGroundHeight: (x: number, z: number) => number;
    readonly resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number };
    readonly getCameraOccluders?: (() => readonly CameraOccluder[]) | undefined;
    readonly onDustParticle: (x: number, y: number, z: number) => void;
    readonly onOverviewAutoExit?: (() => void) | undefined;
    readonly onJump?: (() => void) | undefined;
    readonly onLand?: (() => void) | undefined;
    readonly onStandUp?: (() => void) | undefined;
    readonly onStarTakeoff?: (() => void) | undefined;
    readonly onStarTakeoffCharge?: (() => void) | undefined;
    readonly onStarTakeoffAscend?: (() => void) | undefined;
    readonly onMeteorDive?: (() => void) | undefined;
    readonly onMeteorImpact?: ((x: number, z: number) => void) | undefined;
    readonly onStarBoost?: (() => void) | undefined;
    readonly onFlightSpin?: (() => void) | undefined;
    readonly onBarrelRoll?: (() => void) | undefined;
  }): void;
  startMeteorDive(
    targetX: number,
    targetZ: number,
    getGroundHeight: (x: number, z: number) => number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
    options?: LandingTargetOptions,
  ): void;
  teleportTo(
    x: number,
    z: number,
    getGroundHeight: (x: number, z: number) => number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
    options?: LandingTargetOptions,
  ): void;
  approachPoint(
    targetX: number,
    targetZ: number,
    getGroundHeight: (x: number, z: number) => number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
  ): void;
  focusOrbitOn(x: number, z: number, getGroundHeight: (x: number, z: number) => number): void;
  /** 심시티 스타일 구역 선택 포커스 — 부드럽게 쿼터뷰로 틸트/줌하며 WASD 이동 또는 해제 시 복귀한다. */
  focusDistrict(x: number, z: number, radius: number, getGroundHeight: (x: number, z: number) => number): void;
  clearDistrictFocus(): void;
  /** 별빛 상공 자유 비행 모드 (`F` 키) — 항상 에이스 추격 시점으로 88m 초원 상공을 비행하며 해제/클릭 시 유성 급강하한다. */
  setOverviewMode(enabled: boolean): void;
  isOverviewMode(): boolean;
  /** 별빛 링 통과 시 단기 비행 가속 부스트(+14m/s, FOV 펀치)를 발동한다. */
  triggerSkyBoostBurst(durationSec?: number): void;
  /** `Shift` 대시 질주 상태 여부. */
  isSprinting(): boolean;
  /** 광장 모닥불 벤치 불멍 모드 — 벤치 `(2.8, 2.55)`에 앉아 모닥불 `(2.8, 1.0)`을 바라보는 슬로우 오빗 카메라 가동. */
  setCampfireSit(sitting: boolean): void;
  isSittingAtCampfire(): boolean;
  onPointerRotate(dx: number, dy: number): void;
  onWheelZoom(deltaY: number): void;
  dispose(): void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function createPlayerAndCameraController(): PlayerAndCameraController {
  const keys = new Set<string>();
  const player: PlayerState = {
    x: 0.4,
    y: 0.36,
    z: 2.2,
    vx: 0,
    vz: 0,
    vy: 0,
    playerJumpY: 0,
    jumpVel: 0,
    landSquash: 0,
    moveSpeed: 0,
    campfireSitSec: 0,
    flightAlt: 0,
    flying: false,
    diving: false,
    boosting: false,
    flightRoll: 0,
    flightPitch: 0,
    takeoffPhase: "none",
    takeoffProgress: 0,
    heroLandTimer: 0,
    barrelRollTimer: 0,
    yaw: Math.PI, // 정면의 길드 회관(-Z)을 바라보며 시작
    walking: false,
    sprinting: false,
    onGround: true,
  };

  // 지평선·길드회관·풍차·원경 산맥이 시원하게 한눈에 들어오는 어드벤처 카메라 각도
  let camYaw = 0.22;
  let camPitch = 0.28;
  let camDist = 9.8;
  let targetCamDist = 9.8;
  let smoothedEffDist = 9.8;
  let springArmDist = 9.8;
  let smoothedEffPitch = 0.28;
  let smoothedFov = 44;
  let cineProgress = 0;
  let prevLifecycle: WorldLifecycleState = "closed";
  let prevFocusFraming: CameraFocusFraming = "none";
  let autoDialogueYaw: number | null = null;
  let autoWarpCam: {
    yaw: number;
    pitch: number;
    dist: number;
    timer: number;
  } | null = null;
  let sittingAtCampfire = false;
  let jumpedFromGround = false;

  const CAMPFIRE_BENCH_X = 2.8;
  const CAMPFIRE_BENCH_Z = 2.55;
  const CAMPFIRE_FIRE_X = 2.8;
  const CAMPFIRE_FIRE_Z = 1.0;

  const orbitAnchor = new Vector3(0, 1.0, 1.5);
  const cameraTarget = new Vector3(0.4, 1.45, 2.2);

  // 심시티 구역 선택 시 일시적인 쿼터뷰 포커스 상태 & RTS 하늘 비행 모드 상태
  const ORBIT_CLAMP = 80;
  const FLIGHT_CLAMP = 84;
  const FLIGHT_TARGET_ALT = 18.0;
  const FLIGHT_MIN_GROUND_CLEARANCE = 3.2;
  const FLIGHT_MAX_WORLD_ALT = 36.0;
  const TAKEOFF_CHARGE_SEC = 0.52;
  const TAKEOFF_ASCEND_SEC = 0.78;
  const HERO_LAND_SEC = 0.56;
  const BARREL_ROLL_SEC = 0.55;
  let districtFocus: {
    x: number;
    y: number;
    z: number;
    dist: number;
    pitch: number;
  } | null = null;

  let overviewMode = false;
  let chaseManualOrbitTimer = 0;
  let chaseDist = 11.4;
  let chasePitch = 0.25;
  let flightCruiseAlt = FLIGHT_TARGET_ALT;
  let skyBoostBurstTimer = 0;
  let mediaReducedMotion = false;
  let reducedMotionMq: MediaQueryList | null = null;
  const onReducedMotionChange = (ev: MediaQueryListEvent) => {
    mediaReducedMotion = ev.matches;
  };
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    reducedMotionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mediaReducedMotion = reducedMotionMq.matches;
    reducedMotionMq.addEventListener("change", onReducedMotionChange);
  }

  // 유성 급강하 착지 아크 상태 & 2단계 이륙 시퀀스 · 배럴롤 상태
  interface MeteorDiveState {
    startX: number;
    startY: number;
    startZ: number;
    endX: number;
    endY: number;
    endZ: number;
    arcBoost: number;
    duration: number;
    elapsed: number;
    faceYaw: number;
    targetCamYaw: number;
  }
  let diveState: MeteorDiveState | null = null;
  let pendingTakeoffCue = false;
  let pendingChargeCue = false;
  let pendingAscendCue = false;
  let pendingDiveCue = false;
  let pendingLandDive = false;
  let takeoffElapsed = 0;
  let takeoffStartCamYaw = 0;
  let takeoffFrontCamYaw = 0;
  let flightClock = 0;
  let flightSpinWave = 0;
  let bankRollSmoothed = 0;
  let barrelRollDir = 1;
  let prevSpacePressed = false;
  let prevBoostActive = false;
  let autoLandingCamYaw: number | null = null;
  let snapSpringArmOnNextFrame = false;

  // 0-GC 3인칭 스프링-암(Spring-Arm) 3D 메시 차폐 회피 스크래치 풀
  const MIN_SPRING_ARM_DIST = 2.45;
  const occSourceObjects: Object3D[] = [];
  const occTraverseStack: Object3D[] = [];
  const occMeshList: Object3D[] = [];
  const occMeshBounds: Box3[] = [];
  const occCandidates: Object3D[] = [];
  const occHits: Intersection<Object3D>[] = [];
  const occRaycaster = new Raycaster();
  const occRayOrigin = new Vector3();
  const occRayDir = new Vector3();
  const occDesiredCam = new Vector3();
  const occSegmentBox = new Box3();
  let occBoundsDirty = false;

  // 마을 텔레포트·유성 착지 시 석문 기둥 뒤 회피 및 광장 정면 카메라 보정용 힌트 캐시
  let villageHints: readonly LandingVillageHint[] = [];

  function normalizeAngle(angle: number): number {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function rebuildOccluderCache(): void {
    occMeshList.length = 0;
    occTraverseStack.length = 0;
    for (let i = 0; i < occSourceObjects.length; i += 1) {
      const root = occSourceObjects[i]!;
      root.updateWorldMatrix(true, true);
      occTraverseStack.push(root);
      while (occTraverseStack.length > 0) {
        const node = occTraverseStack.pop()!;
        if (!node.visible) continue;
        if (node instanceof InstancedMesh) {
          if (node.count > 0 && node.geometry) {
            node.computeBoundingBox();
            if (node.boundingBox && !node.boundingBox.isEmpty()) {
              const idx = occMeshList.length;
              occMeshList.push(node);
              let box = occMeshBounds[idx];
              if (!box) {
                box = new Box3();
                occMeshBounds[idx] = box;
              }
              box.copy(node.boundingBox).applyMatrix4(node.matrixWorld);
            }
          }
        } else if (node instanceof Mesh && node.geometry) {
          if (!node.geometry.boundingBox) {
            node.geometry.computeBoundingBox();
          }
          if (node.geometry.boundingBox && !node.geometry.boundingBox.isEmpty()) {
            const idx = occMeshList.length;
            occMeshList.push(node);
            let box = occMeshBounds[idx];
            if (!box) {
              box = new Box3();
              occMeshBounds[idx] = box;
            }
            box.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
          }
        }
        const children = node.children;
        for (let ci = 0; ci < children.length; ci += 1) {
          occTraverseStack.push(children[ci]!);
        }
      }
    }
    occBoundsDirty = false;
  }

  function findContainingVillage(x: number, z: number): LandingVillageHint | null {
    let best: LandingVillageHint | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < villageHints.length; i += 1) {
      const v = villageHints[i]!;
      const d = Math.hypot(x - v.x, z - v.z);
      if (d <= v.radius + 2.4 && d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  interface ResolvedLanding {
    readonly x: number;
    readonly z: number;
    readonly endGy: number;
    readonly faceYaw: number;
    readonly targetCamYaw: number;
    readonly orbitX: number;
    readonly orbitZ: number;
  }

  function resolveLandingTarget(
    x: number,
    z: number,
    mode: "teleport" | "dive",
    getGroundHeight: (gx: number, gz: number) => number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
    options?: LandingTargetOptions,
  ): ResolvedLanding {
    const village = findContainingVillage(x, z);
    let fromX = x;
    let fromZ = z;
    let desiredX = x;
    let desiredZ = z;
    let lookX = options?.lookAtX;
    let lookZ = options?.lookAtZ;
    let orbitX = x;
    let orbitZ = z;

    if (options?.exactLanding) {
      if (village && lookX === undefined && lookZ === undefined) {
        lookX = village.x;
        lookZ = village.z;
      }
    } else if (village) {
      const gateCos = Math.cos(village.gateAngle);
      const gateSin = Math.sin(village.gateAngle);
      // 사령관 NPC(1.15m) 앞쪽이자 석문 기둥(radius - 0.25m) 안쪽의 탁 트인 광장 진입 지점
      const entryDist = Math.max(2.35, Math.min(village.radius - 2.65, village.radius * 0.42));
      const idealPlazaX = village.x + gateCos * entryDist;
      const idealPlazaZ = village.z + gateSin * entryDist;
      const gateX = village.x + gateCos * (village.radius - 0.25);
      const gateZ = village.z + gateSin * (village.radius - 0.25);

      const relX = x - village.x;
      const relZ = z - village.z;
      const distCenter = Math.hypot(relX, relZ);
      const dotAlongGate = relX * gateCos + relZ * gateSin;
      const perpDist = Math.abs(-relX * gateSin + relZ * gateCos);
      const distToGate = Math.hypot(x - gateX, z - gateZ);

      fromX = village.x;
      fromZ = village.z;

      if (mode === "teleport") {
        // 마을 중심 또는 정문 진입축 지정 → 석문 기둥 뒤를 피한 광장 정면 진입점으로 보정
        if (distCenter < 1.85 || (dotAlongGate > 0 && perpDist < 2.35) || distToGate < 2.8) {
          desiredX = idealPlazaX;
          desiredZ = idealPlazaZ;
          if (lookX === undefined && lookZ === undefined) {
            lookX = village.x;
            lookZ = village.z;
          }
          orbitX = village.x;
          orbitZ = village.z;
        } else {
          // 마을 내부 개별 구역 건물로 이동 → 건물 정면이 바라보는 마을 중심 방향으로 한 걸음 앞 광장에 착지
          const toCenterX = village.x - x;
          const toCenterZ = village.z - z;
          const dCenter = Math.hypot(toCenterX, toCenterZ) || 1;
          const step = Math.min(2.6, dCenter * 0.55);
          desiredX = x + (toCenterX / dCenter) * step;
          desiredZ = z + (toCenterZ / dCenter) * step;
          if (lookX === undefined && lookZ === undefined) {
            lookX = x;
            lookZ = z;
          }
        }
      } else {
        // 유성 급강하 착지: 석문 기둥·외곽 담장 바로 뒤를 클릭한 경우 안쪽 탁 트인 광장 진입 지점으로 보정
        if (distToGate < 2.8 || distCenter > village.radius - 2.0) {
          desiredX = idealPlazaX;
          desiredZ = idealPlazaZ;
        } else {
          desiredX = x;
          desiredZ = z;
        }
        if (lookX === undefined && lookZ === undefined) {
          lookX = village.x;
          lookZ = village.z;
        }
        orbitX = village.x;
        orbitZ = village.z;
      }
    } else if (mode === "teleport") {
      // 중앙 길드 광장 인근(원점 반경 9m 이내): 길드 회관 남쪽 앞마당에서 정면(-Z) 바라보도록 배치
      if (Math.hypot(x, z) < 9.0) {
        desiredX = x;
        desiredZ = z + 3.0;
        if (lookX === undefined && lookZ === undefined) {
          lookX = x;
          lookZ = z;
        }
      } else {
        // 마을 힌트 미동기화 폴백: Z+3.0 맹목 오프셋 금지(석문 뒤 착지 방지), 원점 바깥쪽(마을 내부 방향)을 정면으로 정렬
        desiredX = x;
        desiredZ = z;
      }
    }

    const safe = resolveMovement(fromX, fromZ, desiredX, desiredZ, 0.55);
    const endGy = Math.max(0.05, getGroundHeight(safe.x, safe.z));

    let faceYaw: number;
    if (lookX !== undefined && lookZ !== undefined && Math.hypot(lookX - safe.x, lookZ - safe.z) > 0.35) {
      faceYaw = Math.atan2(lookX - safe.x, lookZ - safe.z);
    } else if (village) {
      // 마을 중심 정중앙에 착지한 경우 정문 반대편(랜드마크 정면)을 바라보도록 정렬
      faceYaw = Math.atan2(-Math.cos(village.gateAngle), -Math.sin(village.gateAngle));
    } else if (mode === "teleport" && Math.hypot(safe.x, safe.z) >= 9.0) {
      faceYaw = Math.atan2(safe.x, safe.z);
    } else {
      const dx = safe.x - player.x;
      const dz = safe.z - player.z;
      faceYaw = Math.hypot(dx, dz) > 0.25 ? Math.atan2(dx, dz) : player.yaw;
    }

    const targetCamYaw = normalizeAngle(faceYaw + Math.PI);
    return {
      x: safe.x,
      z: safe.z,
      endGy,
      faceYaw,
      targetCamYaw,
      orbitX,
      orbitZ,
    };
  }

  function beginMeteorDiveTo(
    safeX: number,
    safeZ: number,
    endGy: number,
    faceYaw: number,
    targetCamYaw = normalizeAngle(faceYaw + Math.PI),
  ): void {
    const startX = player.x;
    const startY = player.y;
    const startZ = player.z;
    const dist = Math.hypot(safeX - startX, safeZ - startZ);
    const fromSky = player.flightAlt > 1.5 || overviewMode;
    const arcBoost = fromSky
      ? 2.4
      : Math.min(14.5, Math.max(7.2, dist * 0.34));
    const duration = fromSky
      ? Math.max(0.56, Math.min(0.80, 0.62 + dist * 0.004))
      : Math.max(0.52, Math.min(0.78, 0.58 + dist * 0.0045));

    districtFocus = null;
    overviewMode = false;
    sittingAtCampfire = false;
    pendingLandDive = false;
    autoLandingCamYaw = null;
    skyBoostBurstTimer = 0;
    player.takeoffPhase = "none";
    player.takeoffProgress = 0;
    player.heroLandTimer = 0;
    player.barrelRollTimer = 0;
    player.flying = false;
    player.diving = true;
    player.boosting = false;
    player.walking = false;
    player.sprinting = false;
    player.onGround = false;
    player.vx = 0;
    player.vz = 0;
    player.vy = 0;
    player.campfireSitSec = 0;
    jumpedFromGround = false;

    diveState = {
      startX,
      startY,
      startZ,
      endX: safeX,
      endY: endGy,
      endZ: safeZ,
      arcBoost,
      duration,
      elapsed: 0,
      faceYaw,
      targetCamYaw,
    };
    pendingDiveCue = true;
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) return;
    keys.add(event.code);
    if (event.code === "Space") {
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.code);
  };
  const onBlur = () => {
    keys.clear();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    player,
    cameraTarget,
    setCameraOccluders(objects) {
      occSourceObjects.length = 0;
      for (let i = 0; i < objects.length; i += 1) {
        const obj = objects[i];
        if (obj) occSourceObjects.push(obj);
      }
      occMeshList.length = 0;
      occCandidates.length = 0;
      occHits.length = 0;
      occBoundsDirty = occSourceObjects.length > 0;
    },
    setVillageHints(villages) {
      villageHints = villages;
    },
    startMeteorDive(targetX, targetZ, getGroundHeight, resolveMovement, options) {
      autoWarpCam = null;
      const landing = resolveLandingTarget(targetX, targetZ, "dive", getGroundHeight, resolveMovement, options);
      beginMeteorDiveTo(landing.x, landing.z, landing.endGy, landing.faceYaw, landing.targetCamYaw);
      orbitAnchor.set(
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, landing.orbitX)),
        Math.max(0.5, getGroundHeight(landing.orbitX, landing.orbitZ)) + 0.8,
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, landing.orbitZ)),
      );
    },
    teleportTo(x, z, getGroundHeight, resolveMovement, options) {
      const landing = resolveLandingTarget(x, z, "teleport", getGroundHeight, resolveMovement, options);
      const dist = Math.hypot(landing.x - player.x, landing.z - player.z);
      // 빠른 이동 도착 카메라: 마을·광장 정면 힌트(`landing.targetCamYaw`) 기반 약간 높은 후방 3/4 시점으로 자동 정렬
      const warpCamYaw = normalizeAngle(landing.targetCamYaw + 0.22);
      autoWarpCam = {
        yaw: warpCamYaw,
        pitch: 0.36,
        dist: Math.max(targetCamDist, 10.6),
        timer: 1.45,
      };
      if (overviewMode || player.flying || player.flightAlt > 1.5 || dist > 3.5) {
        beginMeteorDiveTo(landing.x, landing.z, landing.endGy, landing.faceYaw, warpCamYaw);
      } else {
        districtFocus = null;
        overviewMode = false;
        sittingAtCampfire = false;
        diveState = null;
        skyBoostBurstTimer = 0;
        player.flying = false;
        player.diving = false;
        player.boosting = false;
        player.flightAlt = 0;
        player.flightRoll = 0;
        player.flightPitch = 0;
        player.x = landing.x;
        player.z = landing.z;
        player.vx = 0;
        player.vz = 0;
        player.y = landing.endGy + 0.35;
        player.vy = 0;
        player.playerJumpY = 0;
        player.jumpVel = 0;
        player.landSquash = 0;
        player.moveSpeed = 0;
        player.campfireSitSec = 0;
        jumpedFromGround = false;
        player.yaw = landing.faceYaw;
        autoLandingCamYaw = warpCamYaw;
        snapSpringArmOnNextFrame = true;
      }
      orbitAnchor.set(
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, landing.orbitX)),
        Math.max(0.5, getGroundHeight(landing.orbitX, landing.orbitZ)) + 0.8,
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, landing.orbitZ)),
      );
    },
    approachPoint(targetX, targetZ, getGroundHeight, resolveMovement) {
      districtFocus = null;
      overviewMode = false;
      sittingAtCampfire = false;
      diveState = null;
      pendingLandDive = false;
      autoLandingCamYaw = null;
      autoWarpCam = null;
      snapSpringArmOnNextFrame = true;
      skyBoostBurstTimer = 0;
      player.flying = false;
      player.diving = false;
      player.boosting = false;
      player.flightAlt = 0;
      player.flightRoll = 0;
      player.flightPitch = 0;
      const dx = player.x - targetX;
      const dz = player.z - targetZ;
      const d = Math.hypot(dx, dz);
      const dirX = d > 0.25 ? dx / d : 0;
      const dirZ = d > 0.25 ? dz / d : 1;
      const desiredX = targetX + dirX * 2.15;
      const desiredZ = targetZ + dirZ * 2.15;
      const safe = resolveMovement(targetX, targetZ, desiredX, desiredZ, 0.52);
      player.x = safe.x;
      player.z = safe.z;
      player.vx = 0;
      player.vz = 0;
      player.y = Math.max(0.05, getGroundHeight(player.x, player.z)) + 0.15;
      player.vy = 0;
      player.playerJumpY = 0;
      player.jumpVel = 0;
      player.landSquash = 0;
      player.moveSpeed = 0;
      player.campfireSitSec = 0;
      jumpedFromGround = false;
      player.yaw = Math.atan2(targetX - player.x, targetZ - player.z);
      orbitAnchor.set(
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, targetX)),
        Math.max(0.5, getGroundHeight(targetX, targetZ)) + 0.9,
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, targetZ)),
      );
    },
    focusOrbitOn(x, z, getGroundHeight) {
      orbitAnchor.set(
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, x)),
        Math.max(0.5, getGroundHeight(x, z)) + 0.9,
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, z)),
      );
    },
    focusDistrict(x, z, radius, getGroundHeight) {
      overviewMode = false;
      sittingAtCampfire = false;
      autoLandingCamYaw = null;
      autoWarpCam = null;
      const clampedX = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, x));
      const clampedZ = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, z));
      const gy = Math.max(0.25, getGroundHeight(clampedX, clampedZ));
      const targetDist = Math.max(11.5, Math.min(22.0, radius * 4.4));
      const targetPitch = Math.max(0.56, Math.min(0.72, camPitch < 0.45 ? 0.62 : camPitch));
      districtFocus = {
        x: clampedX,
        y: gy + 0.85,
        z: clampedZ,
        dist: targetDist,
        pitch: targetPitch,
      };
      orbitAnchor.set(clampedX, gy + 0.9, clampedZ);
    },
    clearDistrictFocus() {
      districtFocus = null;
    },
    setOverviewMode(enabled) {
      if (enabled === overviewMode) return;
      overviewMode = enabled;
      if (enabled) {
        districtFocus = null;
        sittingAtCampfire = false;
        diveState = null;
        pendingLandDive = false;
        autoLandingCamYaw = null;
        autoWarpCam = null;
        skyBoostBurstTimer = 0;
        chaseManualOrbitTimer = 0;
        chaseDist = 11.4;
        chasePitch = 0.25;
        flightCruiseAlt = FLIGHT_TARGET_ALT;
        player.diving = false;
        player.flying = true;
        player.boosting = false;
        player.walking = false;
        player.vx = 0;
        player.vz = 0;
        player.moveSpeed = 0;
        player.flightAlt = 0;
        player.flightRoll = 0;
        player.flightPitch = 0;
        player.heroLandTimer = 0;
        player.barrelRollTimer = 0;
        bankRollSmoothed = 0;
        player.takeoffPhase = "charge";
        player.takeoffProgress = 0;
        takeoffElapsed = 0;
        // 2단계 상승 종료 시 제독 등 뒤 에이스 추격 시점으로 부드럽게 정렬
        takeoffStartCamYaw = player.yaw + Math.PI;
        takeoffFrontCamYaw = player.yaw + 0.28;
        pendingChargeCue = true;
        pendingTakeoffCue = true;
      } else if (player.takeoffPhase === "charge") {
        // 지상 충전 중 취소 시 깔끔하게 지상 복귀
        skyBoostBurstTimer = 0;
        player.takeoffPhase = "none";
        player.takeoffProgress = 0;
        player.flying = false;
        player.onGround = true;
      } else if (player.flying || player.flightAlt > 1.2) {
        // 비행/상승 중 F/Esc 종료 시 현재 위치 바로 아래 안전한 지면으로 부드러운 유성 급강하 착지 예약
        skyBoostBurstTimer = 0;
        player.takeoffPhase = "none";
        player.takeoffProgress = 0;
        pendingLandDive = true;
      }
    },
    isOverviewMode() {
      return overviewMode;
    },
    triggerSkyBoostBurst(durationSec = 1.8) {
      skyBoostBurstTimer = Math.max(skyBoostBurstTimer, Math.max(0.3, durationSec));
    },
    isSprinting() {
      return (player.sprinting && player.walking) || player.boosting;
    },
    setCampfireSit(sitting) {
      if (sitting === sittingAtCampfire) return;
      sittingAtCampfire = sitting;
      player.campfireSitSec = 0;
      if (sitting) {
        districtFocus = null;
        overviewMode = false;
        diveState = null;
        pendingLandDive = false;
        autoLandingCamYaw = null;
        autoWarpCam = null;
        skyBoostBurstTimer = 0;
        player.flying = false;
        player.diving = false;
        player.boosting = false;
        player.flightAlt = 0;
        player.flightRoll = 0;
        player.flightPitch = 0;
        player.x = CAMPFIRE_BENCH_X;
        player.z = CAMPFIRE_BENCH_Z;
        player.vx = 0;
        player.vz = 0;
        player.vy = 0;
        player.playerJumpY = 0;
        player.jumpVel = 0;
        player.landSquash = 0;
        player.moveSpeed = 0;
        player.walking = false;
        player.sprinting = false;
        player.onGround = true;
        jumpedFromGround = false;
        player.yaw = Math.atan2(CAMPFIRE_FIRE_X - CAMPFIRE_BENCH_X, CAMPFIRE_FIRE_Z - CAMPFIRE_BENCH_Z);
      }
    },
    isSittingAtCampfire() {
      return sittingAtCampfire;
    },
    onPointerRotate(dx, dy) {
      autoDialogueYaw = null;
      autoLandingCamYaw = null;
      autoWarpCam = null;
      camYaw -= dx * 0.0062;
      if (overviewMode) {
        chaseManualOrbitTimer = 2.4;
        chasePitch = Math.max(0.08, Math.min(0.85, chasePitch + dy * 0.0042));
      } else if (districtFocus) {
        districtFocus.pitch = Math.max(0.22, Math.min(1.16, districtFocus.pitch + dy * 0.0048));
      } else {
        camPitch = Math.max(0.12, Math.min(1.16, camPitch + dy * 0.0048));
      }
    },
    onWheelZoom(deltaY) {
      autoWarpCam = null;
      const clamped = Math.max(-180, Math.min(180, deltaY));
      if (overviewMode) {
        chaseDist = Math.max(7.5, Math.min(24.0, chaseDist * Math.exp(clamped * 0.0012)));
      } else if (districtFocus) {
        districtFocus.dist = Math.max(7.2, Math.min(34.0, districtFocus.dist * Math.exp(clamped * 0.0012)));
      } else {
        targetCamDist = Math.max(4.2, Math.min(40.0, targetCamDist * Math.exp(clamped * 0.0012)));
      }
    },
    update(opts) {
      if (opts.lifecycle !== prevLifecycle) {
        if (opts.lifecycle === "diving" || opts.lifecycle === "escaping") {
          cineProgress = 0;
        }
        prevLifecycle = opts.lifecycle;
      }

      if (opts.lifecycle === "diving") {
        cineProgress = Math.min(1, cineProgress + opts.dt / 1.1);
      } else if (opts.lifecycle === "escaping") {
        cineProgress = Math.min(1, cineProgress + opts.dt / 0.8);
      }

      if (pendingChargeCue) {
        pendingChargeCue = false;
        opts.onStarTakeoffCharge?.();
      }
      if (pendingTakeoffCue) {
        pendingTakeoffCue = false;
        opts.onStarTakeoff?.();
      }
      if (pendingAscendCue) {
        pendingAscendCue = false;
        opts.onStarTakeoffAscend?.();
      }
      if (pendingLandDive) {
        pendingLandDive = false;
        const landing = resolveLandingTarget(player.x, player.z, "dive", opts.getGroundHeight, opts.resolveMovement);
        beginMeteorDiveTo(landing.x, landing.z, landing.endGy, landing.faceYaw, landing.targetCamYaw);
      }
      if (pendingDiveCue) {
        pendingDiveCue = false;
        opts.onMeteorDive?.();
      }

      if (flightSpinWave > 0) {
        flightSpinWave = Math.max(0, flightSpinWave - opts.dt * 2.4);
      }
      if (player.heroLandTimer > 0) {
        player.heroLandTimer = Math.max(0, player.heroLandTimer - opts.dt);
      }
      if (player.barrelRollTimer > 0) {
        player.barrelRollTimer = Math.max(0, player.barrelRollTimer - opts.dt);
      }
      if (chaseManualOrbitTimer > 0) {
        chaseManualOrbitTimer = Math.max(0, chaseManualOrbitTimer - opts.dt);
      }
      if (skyBoostBurstTimer > 0) {
        skyBoostBurstTimer = Math.max(0, skyBoostBurstTimer - opts.dt);
      }

      const reduceMotion = opts.reducedMotion || mediaReducedMotion;

      if (diveState) {
        // 별똥별 유성 급강하 포물선 아크 (~0.72초)
        diveState.elapsed += opts.dt;
        const rawT = opts.reducedMotion ? 1 : Math.min(1, diveState.elapsed / diveState.duration);
        const xzEase = 1 - Math.pow(1 - rawT, 2.15);
        const prevX = player.x;
        const prevY = player.y;
        const prevZ = player.z;
        player.x = diveState.startX + (diveState.endX - diveState.startX) * xzEase;
        player.z = diveState.startZ + (diveState.endZ - diveState.startZ) * xzEase;
        const linearY = diveState.startY + (diveState.endY - diveState.startY) * rawT;
        player.y = linearY + 4 * diveState.arcBoost * rawT * (1 - rawT);
        const curGy = Math.max(-0.05, opts.getGroundHeight(player.x, player.z));
        player.flightAlt = Math.max(0, player.y - curGy);
        player.playerJumpY = player.flightAlt;
        player.jumpVel = opts.dt > 0.0005 ? (player.y - prevY) / opts.dt : -12;
        player.moveSpeed = opts.dt > 0.0005 ? Math.hypot(player.x - prevX, player.z - prevZ) / opts.dt : 24;
        player.yaw = diveState.faceYaw;
        player.flying = false;
        player.diving = true;
        player.boosting = false;
        player.walking = false;
        player.sprinting = false;
        player.onGround = false;
        player.flightRoll *= Math.max(0, 1 - opts.dt * 8);
        player.flightPitch += (0.78 - player.flightPitch) * Math.min(1, opts.dt * 12);
        prevBoostActive = false;

        // 착지 아크 동안 카메라 yaw를 마을 광장·랜드마크 정면(아바타 등 뒤)으로 부드럽게 정렬
        if (reduceMotion) {
          camYaw = diveState.targetCamYaw;
        } else {
          const diveYawDiff = normalizeAngle(diveState.targetCamYaw - camYaw);
          camYaw += diveYawDiff * (1 - Math.exp(-opts.dt * 7.5));
          camPitch += (0.28 - camPitch) * (1 - Math.exp(-opts.dt * 3.5));
        }

        if (rawT >= 1) {
          const impactX = diveState.endX;
          const impactZ = diveState.endZ;
          const settleYaw = diveState.targetCamYaw;
          player.x = impactX;
          player.z = impactZ;
          player.y = diveState.endY;
          player.vy = 0;
          player.vx = 0;
          player.vz = 0;
          player.flightAlt = 0;
          player.playerJumpY = 0;
          player.jumpVel = 0;
          player.moveSpeed = 0;
          player.flying = false;
          player.diving = false;
          player.boosting = false;
          player.flightRoll = 0;
          player.flightPitch = 0;
          player.onGround = true;
          player.landSquash = 1.0;
          player.heroLandTimer = HERO_LAND_SEC;
          diveState = null;
          if (reduceMotion) {
            camYaw = settleYaw;
            autoLandingCamYaw = null;
          } else {
            autoLandingCamYaw = Math.abs(normalizeAngle(settleYaw - camYaw)) > 0.02 ? settleYaw : null;
          }
          snapSpringArmOnNextFrame = true;
          opts.onMeteorImpact?.(impactX, impactZ);
        }
      } else if (overviewMode && player.takeoffPhase !== "none") {
        // 🌠 2단계 시네마틱 줌인 화이팅(`charge` 0~0.52s) → 빙글빙글 회오리 급상승(`ascend` 0.52~1.18s)
        const gyNow = Math.max(-0.05, opts.getGroundHeight(player.x, player.z));
        player.campfireSitSec = 0;
        player.flying = true;
        player.diving = false;
        player.boosting = false;
        player.walking = false;
        player.vx = 0;
        player.vz = 0;
        player.moveSpeed = 0;
        player.flightRoll = 0;
        player.flightPitch = 0;
        prevBoostActive = false;

        if (reduceMotion) {
          player.takeoffPhase = "none";
          player.takeoffProgress = 0;
          flightCruiseAlt = FLIGHT_TARGET_ALT;
          player.flightAlt = FLIGHT_TARGET_ALT;
          player.y = gyNow + FLIGHT_TARGET_ALT;
          player.playerJumpY = FLIGHT_TARGET_ALT;
          player.onGround = false;
          camYaw = takeoffStartCamYaw;
        } else if (player.takeoffPhase === "charge") {
          takeoffElapsed += opts.dt;
          player.takeoffProgress = Math.min(1, takeoffElapsed / TAKEOFF_CHARGE_SEC);
          player.flightAlt = 0;
          player.y = gyNow;
          player.playerJumpY = 0;
          player.jumpVel = 0;
          player.onGround = true;
          // 정면/3-4 클로즈업 각도로 부드럽게 회전해 화이팅 자세를 정면에서 감상
          let yawDiff = takeoffFrontCamYaw - camYaw;
          while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
          while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
          camYaw += yawDiff * (1 - Math.exp(-opts.dt * 11.0));

          if (takeoffElapsed >= TAKEOFF_CHARGE_SEC) {
            player.takeoffPhase = "ascend";
            player.takeoffProgress = 0;
            takeoffElapsed = 0;
            player.onGround = false;
            pendingAscendCue = true;
          }
        } else {
          // 2단계 `ascend`: 0 -> 18.0m 빙글빙글 회오리 급상승 (로켓 초기 점프를 부드럽게 완화해 전 구간 선명하게 추적)
          takeoffElapsed += opts.dt;
          const t = Math.min(1, takeoffElapsed / TAKEOFF_ASCEND_SEC);
          player.takeoffProgress = t;
          const prevAlt = player.flightAlt;
          const altEase = 1 - Math.pow(1 - t, 2.2);
          player.flightAlt = FLIGHT_TARGET_ALT * altEase;
          player.y = gyNow + player.flightAlt;
          player.playerJumpY = player.flightAlt;
          player.jumpVel = opts.dt > 0.0005 ? (player.flightAlt - prevAlt) / opts.dt : 22;
          player.onGround = false;

          let yawBack = takeoffStartCamYaw - camYaw;
          while (yawBack > Math.PI) yawBack -= Math.PI * 2;
          while (yawBack < -Math.PI) yawBack += Math.PI * 2;
          camYaw += yawBack * (1 - Math.exp(-opts.dt * 5.8));

          if (t >= 1) {
            player.takeoffPhase = "none";
            player.takeoffProgress = 0;
            flightCruiseAlt = FLIGHT_TARGET_ALT;
            player.flightAlt = FLIGHT_TARGET_ALT;
            flightClock = 0;
          }
        }
      } else if (opts.lifecycle === "open" && !opts.inputLocked) {
        let ix = 0;
        let iz = 0;
        if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
        if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
        if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
        if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
        const spacePressed = keys.has("Space");
        const spaceEdge = spacePressed && !prevSpacePressed;
        prevSpacePressed = spacePressed;
        player.sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight");

        // 불멍 중 WASD/방향키 또는 Space 입력 시 자동 기상!
        if (sittingAtCampfire && (ix !== 0 || iz !== 0 || spacePressed)) {
          sittingAtCampfire = false;
          player.campfireSitSec = 0;
          opts.onStandUp?.();
        }

        if (ix !== 0 || iz !== 0) {
          // WASD/방향키 이동 시작 시 구역 포커스·히어로 착지 포즈·자동 착지/워프 카메라 정렬 해제 (비행 중 WASD는 슈퍼맨 자유 비행!)
          districtFocus = null;
          autoLandingCamYaw = null;
          autoWarpCam = null;
          player.heroLandTimer = 0;
        }

        const cy = Math.cos(camYaw);
        const sy = Math.sin(camYaw);

        if (sittingAtCampfire) {
          // 모닥불 벤치 불멍 상태: 벤치에 앉아 모닥불을 바라보며 천천히 시네마틱 오빗
          player.campfireSitSec += opts.dt;
          player.x = CAMPFIRE_BENCH_X;
          player.z = CAMPFIRE_BENCH_Z;
          player.vx = 0;
          player.vz = 0;
          player.moveSpeed = 0;
          player.walking = false;
          player.sprinting = false;
          player.flying = false;
          player.boosting = false;
          player.flightAlt = 0;
          player.flightRoll = 0;
          player.flightPitch = 0;
          player.yaw = Math.atan2(CAMPFIRE_FIRE_X - CAMPFIRE_BENCH_X, CAMPFIRE_FIRE_Z - CAMPFIRE_BENCH_Z);
          if (!opts.reducedMotion) {
            camYaw += opts.dt * 0.14;
          }
        } else if (overviewMode) {
          // 🌠 별빛 상공 자유 비행 (`18.0m`, 에이스 추격 시점 단일화, `WASD` 24m/s ↔ 정지 호버, `Shift` 44m/s, 링 통과 +14m/s, `Space` 배럴롤)
          flightClock += opts.dt;
          player.campfireSitSec = 0;
          player.flying = true;
          player.diving = false;
          player.walking = false;
          player.onGround = false;

          const manualBoost = player.sprinting && (ix !== 0 || iz !== 0);
          const ringBurstFactor = skyBoostBurstTimer > 0 ? Math.min(1, skyBoostBurstTimer / 0.45) : 0;
          const boostNow = manualBoost || ringBurstFactor > 0;
          player.boosting = boostNow;
          if (manualBoost && !prevBoostActive) {
            opts.onStarBoost?.();
          }
          prevBoostActive = manualBoost;

          let targetVx = 0;
          let targetVz = 0;
          let targetBankRoll = 0;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const flySpeed = (manualBoost ? 44.0 : 24.0) + ringBurstFactor * 14.0;
            targetVx = mx * flySpeed;
            targetVz = mz * flySpeed;

            const targetRot = Math.atan2(mx, mz);
            let diff = targetRot - player.yaw;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            player.yaw += diff * Math.min(1, opts.dt * 9.5);
            targetBankRoll = Math.max(-0.52, Math.min(0.52, -diff * 0.72));
          } else if (ringBurstFactor > 0) {
            // 링 통과 부스트 중에는 별도 WASD 입력 없이도 진행 방향으로 경쾌하게 활공 가속
            const glideSpeed = 30.0 * ringBurstFactor;
            targetVx = Math.sin(player.yaw) * glideSpeed;
            targetVz = Math.cos(player.yaw) * glideSpeed;
          }

          const flyAccel = (ix !== 0 || iz !== 0) ? 7.5 : 5.6;
          player.vx += (targetVx - player.vx) * Math.min(1, opts.dt * flyAccel);
          player.vz += (targetVz - player.vz) * Math.min(1, opts.dt * flyAccel);

          const speedMag = Math.hypot(player.vx, player.vz);
          player.moveSpeed = speedMag < 0.08 ? 0 : speedMag;
          player.x = Math.max(-FLIGHT_CLAMP, Math.min(FLIGHT_CLAMP, player.x + player.vx * opts.dt));
          player.z = Math.max(-FLIGHT_CLAMP, Math.min(FLIGHT_CLAMP, player.z + player.vz * opts.dt));

          if (spaceEdge && player.barrelRollTimer <= 0.02) {
            player.barrelRollTimer = BARREL_ROLL_SEC;
            barrelRollDir = -barrelRollDir;
            flightSpinWave = 0.85;
            opts.onBarrelRoll?.();
            opts.onFlightSpin?.();
          }

          const gyUnder = Math.max(-0.05, opts.getGroundHeight(player.x, player.z));
          const minRelAlt = FLIGHT_MIN_GROUND_CLEARANCE;
          const maxRelAlt = Math.max(minRelAlt, FLIGHT_MAX_WORLD_ALT - gyUnder);

          // (#5) 에이스 비행 자유 고도 조절: E 상승 / Q 하강 최우선 + 전진 비행 중 카메라 피치에 따른 부드러운 고도 연동
          const altInput = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);
          if (altInput !== 0) {
            const altRate = player.sprinting ? 14.5 : 10.5;
            flightCruiseAlt += altInput * altRate * opts.dt;
          } else if (ix !== 0 || iz !== 0) {
            const pitchDelta = 0.25 - chasePitch;
            const excess = Math.sign(pitchDelta) * Math.max(0, Math.abs(pitchDelta) - 0.07);
            if (excess !== 0) {
              flightCruiseAlt += excess * 11.0 * Math.min(1.6, speedMag / 24.0) * opts.dt;
            }
          }
          flightCruiseAlt = Math.max(minRelAlt, Math.min(maxRelAlt, flightCruiseAlt));

          // (#10) 저모션 모드에서는 비행 바빙·배럴롤 상승·롤 흔들림 진폭을 25% 수준으로 부드럽게 완화
          const motionScale = reduceMotion ? 0.25 : 1.0;
          const bob = Math.sin(flightClock * 2.2) * 0.42 * motionScale;
          const spinLift = Math.sin(flightSpinWave * Math.PI) * 1.15 * motionScale;
          const desiredAlt = Math.max(minRelAlt, Math.min(maxRelAlt, flightCruiseAlt + bob + spinLift));
          const prevAlt = player.flightAlt;
          const altLerp = 1 - Math.exp(-opts.dt * (altInput !== 0 ? 7.8 : 5.2));
          player.flightAlt += (desiredAlt - player.flightAlt) * altLerp;
          player.y = gyUnder + player.flightAlt;
          player.playerJumpY = player.flightAlt;
          player.jumpVel = opts.dt > 0.0005 ? (player.flightAlt - prevAlt) / opts.dt : 0;

          bankRollSmoothed += (targetBankRoll * motionScale - bankRollSmoothed) * Math.min(1, opts.dt * 8.5);
          let barrelAdd = 0;
          if (player.barrelRollTimer > 0) {
            const rollT = 1 - player.barrelRollTimer / BARREL_ROLL_SEC;
            const rollEase = rollT < 0.5 ? 2 * rollT * rollT : 1 - Math.pow(-2 * rollT + 2, 2) / 2;
            barrelAdd = barrelRollDir * rollEase * Math.PI * 2;
          }
          player.flightRoll = bankRollSmoothed + barrelAdd;
          const climbPitchBias = Math.max(-0.24, Math.min(0.24, -player.jumpVel * 0.018));
          const targetPitch = Math.max(
            -0.28,
            Math.min(0.56, (speedMag / 44.0) * 0.42 + (boostNow ? 0.08 : 0) + climbPitchBias),
          );
          player.flightPitch += (targetPitch - player.flightPitch) * Math.min(1, opts.dt * 8.0);
        } else if (opts.cameraMode === "orbit") {
          // 초원 조망 모드에서는 WASD로 카메라 주시점을 넓은 초원(±80m) 위로 부드럽게 패닝!
          player.campfireSitSec = 0;
          player.walking = false;
          player.flying = false;
          player.boosting = false;
          player.vx = 0;
          player.vz = 0;
          player.moveSpeed = 0;
          prevBoostActive = false;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const panSpeed = (player.sprinting ? 34 : 20) * opts.dt;
            orbitAnchor.x = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, orbitAnchor.x + mx * panSpeed));
            orbitAnchor.z = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, orbitAnchor.z + mz * panSpeed));
            orbitAnchor.y = Math.max(0.5, opts.getGroundHeight(orbitAnchor.x, orbitAnchor.z)) + 0.9;
          }
        } else {
          // 3인칭 추적 모드: 부드러운 가감속 물리 이동(`Shift` 1.65x 대시 질주) + 슬라이딩 장애물 충돌
          player.campfireSitSec = 0;
          player.flying = false;
          player.boosting = false;
          prevBoostActive = false;
          player.flightRoll *= Math.max(0, 1 - opts.dt * 10);
          player.flightPitch *= Math.max(0, 1 - opts.dt * 10);
          let targetVx = 0;
          let targetVz = 0;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const maxSpd = player.sprinting ? 5.6 * 1.65 : 5.6;
            targetVx = mx * maxSpd;
            targetVz = mz * maxSpd;

            const targetRot = Math.atan2(mx, mz);
            let diff = targetRot - player.yaw;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            player.yaw += diff * Math.min(1, opts.dt * 13);
          }

          const accel = (ix !== 0 || iz !== 0) ? 16 : 14;
          player.vx += (targetVx - player.vx) * Math.min(1, opts.dt * accel);
          player.vz += (targetVz - player.vz) * Math.min(1, opts.dt * accel);

          const speedMag = Math.hypot(player.vx, player.vz);
          player.moveSpeed = speedMag;
          player.walking = speedMag > 0.35;

          if (speedMag > 0.02) {
            const nx = player.x + player.vx * opts.dt;
            const nz = player.z + player.vz * opts.dt;
            const resolved = opts.resolveMovement(player.x, player.z, nx, nz, 0.52);
            player.x = resolved.x;
            player.z = resolved.z;

            if (player.onGround && player.walking && Math.random() < opts.dt * (player.sprinting ? 16 : 6)) {
              opts.onDustParticle(player.x, player.y + 0.08, player.z);
            }
          }

          if (spacePressed && player.onGround) {
            player.vy = 7.1;
            player.onGround = false;
            player.landSquash = 0;
            jumpedFromGround = true;
            opts.onJump?.();
          }
        }
      } else {
        prevSpacePressed = false;
        prevBoostActive = false;
        player.vx *= Math.max(0, 1 - opts.dt * 14);
        player.vz *= Math.max(0, 1 - opts.dt * 14);
        player.moveSpeed = Math.hypot(player.vx, player.vz);
        player.walking = false;
        player.sprinting = false;
        player.boosting = false;
        player.flightRoll *= Math.max(0, 1 - opts.dt * 10);
        player.flightPitch *= Math.max(0, 1 - opts.dt * 10);
        // 상호작용 대상이 있으면 플레이어가 대상을 자연스럽게 마주본다
        if (opts.focusActorPos) {
          const targetRot = Math.atan2(opts.focusActorPos.x - player.x, opts.focusActorPos.z - player.z);
          let diff = targetRot - player.yaw;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          player.yaw += diff * Math.min(1, opts.dt * 9);
        }
      }

      const gy = Math.max(-0.05, opts.getGroundHeight(player.x, player.z));
      if (!player.flying && !player.diving) {
        const wasOnGround = player.onGround;
        player.vy -= 17.8 * opts.dt;
        player.y += player.vy * opts.dt;
        if (player.y <= gy) {
          player.y = gy;
          player.vy = 0;
          player.onGround = true;
          if (!wasOnGround && jumpedFromGround) {
            jumpedFromGround = false;
            player.landSquash = 1.0;
            opts.onDustParticle(player.x, gy + 0.06, player.z);
            opts.onLand?.();
          }
        }
        player.playerJumpY = Math.max(0, player.y - gy);
        player.flightAlt = 0;
        player.jumpVel = player.onGround ? 0 : player.vy;
      }
      if (player.landSquash > 0) {
        player.landSquash = Math.max(0, player.landSquash - opts.dt * 4.6);
      }

      // 카메라 주시점 보간 (제독 드레스업 클로즈업 > 관전 시네마 > RTS 하늘 조망 > 구역 포커스 > RPG 2샷 대화 / 우측 드로어 좌측 삼분할 > 모닥불 불멍 > 방사형 근접 > 일반 추적/조망)
      let desiredTargetX = opts.cameraMode === "orbit" ? orbitAnchor.x : player.x;
      let desiredTargetY = opts.cameraMode === "orbit" ? orbitAnchor.y : player.y + 1.12;
      let desiredTargetZ = opts.cameraMode === "orbit" ? orbitAnchor.z : player.z;
      const focusFraming = opts.focusFraming ?? "none";
      const customizerFraming = focusFraming === "customizer";
      const cinemaFraming = focusFraming === "cinema" && opts.cinemaTarget != null;
      const hasFocusActor = !customizerFraming && !cinemaFraming && !overviewMode && !districtFocus && !sittingAtCampfire && opts.focusActorPos !== null;
      const focusDistToPlayer = hasFocusActor && opts.focusActorPos
        ? Math.hypot(opts.focusActorPos.x - player.x, opts.focusActorPos.z - player.z)
        : Infinity;
      const dialogueFraming = hasFocusActor && focusFraming === "dialogue";
      const drawerFraming = hasFocusActor && focusFraming === "drawer";

      // 1단계 RPG 대화 진입 시 대화 축 우측·약간 높은 3/4 구도로 빼서 사령관 얼굴을 정면 개방, 드레스업 진입 시 제독 정면 클로즈업 (드래그 시 즉시 해제)
      if (focusFraming !== prevFocusFraming) {
        if (dialogueFraming && opts.focusActorPos && focusDistToPlayer > 0.25 && focusDistToPlayer < 12.0) {
          const npcToPlayerYaw = Math.atan2(player.x - opts.focusActorPos.x, player.z - opts.focusActorPos.z);
          autoDialogueYaw = npcToPlayerYaw + 0.92;
          autoWarpCam = null;
        } else if (customizerFraming) {
          autoDialogueYaw = player.yaw + 0.14;
          autoWarpCam = null;
        } else {
          autoDialogueYaw = null;
        }
        prevFocusFraming = focusFraming;
      }
      if (autoDialogueYaw !== null && (dialogueFraming || customizerFraming)) {
        const yawDiff = normalizeAngle(autoDialogueYaw - camYaw);
        if (Math.abs(yawDiff) < 0.015 || reduceMotion) {
          camYaw = autoDialogueYaw;
          autoDialogueYaw = null;
        } else {
          camYaw += yawDiff * (1 - Math.exp(-opts.dt * 7.2));
        }
      } else if (autoWarpCam && !overviewMode && !cinemaFraming && !dialogueFraming && !customizerFraming && !sittingAtCampfire) {
        // 빠른 이동(워프) 도착 시 마을·광장 정면이 탁 트이는 높은 후방 3/4 시점으로 부드럽게 정렬
        autoWarpCam.timer -= opts.dt;
        const yawDiff = normalizeAngle(autoWarpCam.yaw - camYaw);
        const warpLerp = reduceMotion ? 1 : 1 - Math.exp(-opts.dt * 5.8);
        camYaw += yawDiff * warpLerp;
        camPitch += (autoWarpCam.pitch - camPitch) * warpLerp;
        targetCamDist += (autoWarpCam.dist - targetCamDist) * warpLerp;
        if (
          autoWarpCam.timer <= 0
          || (Math.abs(yawDiff) < 0.018 && Math.abs(autoWarpCam.pitch - camPitch) < 0.012)
        ) {
          autoWarpCam = null;
          autoLandingCamYaw = null;
        }
      } else if (autoLandingCamYaw !== null && !overviewMode && !player.diving && !cinemaFraming && !sittingAtCampfire) {
        const landDiff = normalizeAngle(autoLandingCamYaw - camYaw);
        if (Math.abs(landDiff) < 0.015 || reduceMotion) {
          camYaw = autoLandingCamYaw;
          autoLandingCamYaw = null;
        } else {
          camYaw += landDiff * (1 - Math.exp(-opts.dt * 8.5));
        }
      } else if (cinemaFraming && !reduceMotion) {
        // 관전 / 작업 동반자 모드: 스포트라이트 대상을 중심으로 잔잔하고 영화적인 느린 오빗
        camYaw += opts.dt * 0.11;
      }
      const interactingClose =
        hasFocusActor
        && focusFraming === "none"
        && opts.cameraMode === "follow"
        && focusDistToPlayer < 9.0;

      const takeoffCharging = overviewMode && player.takeoffPhase === "charge";
      const takeoffAscending = overviewMode && player.takeoffPhase === "ascend";
      const aceChaseFraming = overviewMode
        && player.flying
        && player.takeoffPhase === "none";
      const ascendEase = takeoffAscending
        ? player.takeoffProgress * player.takeoffProgress * (3 - 2 * player.takeoffProgress)
        : 0;

      // 에이스 추격 시점 단일화: 비행 이동 중 별 제독 등 뒤(`player.yaw + π`)로 카메라가 부드럽게 자동 정렬 (마우스 드래그 시 자유 회전)
      if (aceChaseFraming && !opts.inputLocked && player.moveSpeed > 1.5 && chaseManualOrbitTimer <= 0 && !opts.reducedMotion) {
        const behindYaw = player.yaw + Math.PI;
        let chaseYawDiff = behindYaw - camYaw;
        while (chaseYawDiff > Math.PI) chaseYawDiff -= Math.PI * 2;
        while (chaseYawDiff < -Math.PI) chaseYawDiff += Math.PI * 2;
        camYaw += chaseYawDiff * (1 - Math.exp(-opts.dt * 3.8));
      }

      const campfireWithCompanions = sittingAtCampfire && !opts.inputLocked && (opts.companionCount ?? 0) > 0;
      if (customizerFraming) {
        // 실시간 3D 제독 드레스업: 타깃을 카메라 우측 벡터(+cos(camYaw)*0.82, -sin(camYaw)*0.82)로 밀고
        // 시야 높이와 거리를 미세 보정해 좌측 우물·소품이 제독 팔에 파고들지 않게 깔끔한 클로즈업 유지
        desiredTargetX = player.x + Math.cos(camYaw) * 0.82;
        desiredTargetY = player.y + 0.80;
        desiredTargetZ = player.z - Math.sin(camYaw) * 0.82;
      } else if (takeoffCharging) {
        // 1단계 이륙 충전(`0~0.52s`): 제독 정면 클로즈업으로 귀여운 화이팅 자세를 1:1 중심 고정 포착
        desiredTargetX = player.x;
        desiredTargetY = player.y + 0.55;
        desiredTargetZ = player.z;
      } else if (takeoffAscending) {
        // 2단계 회오리 급상승: 실제 별 제독 높이(`player.y + 0.55`)를 1:1 실시간 추적하며 정점에서 에이스 추격 시점으로 수평 전환
        const ascTargetX = player.x + Math.sin(player.yaw) * 0.9;
        const ascTargetZ = player.z + Math.cos(player.yaw) * 0.9;
        desiredTargetX = player.x + (ascTargetX - player.x) * ascendEase;
        desiredTargetY = player.y + 0.55;
        desiredTargetZ = player.z + (ascTargetZ - player.z) * ascendEase;
      } else if (player.diving) {
        // 별똥별 유성 급강하: 낙하 중인 별 제독을 극적으로 추적하며 착지점으로 급강하
        desiredTargetX = player.x;
        desiredTargetY = player.y + 0.85;
        desiredTargetZ = player.z;
      } else if (cinemaFraming && opts.cinemaTarget) {
        desiredTargetX = opts.cinemaTarget.x;
        desiredTargetY = opts.cinemaTarget.y;
        desiredTargetZ = opts.cinemaTarget.z;
      } else if (aceChaseFraming || overviewMode) {
        // 에이스 추격 시점: 별 제독 중심 + 진행 방향 약간 전방(+0.9m)을 쫓는 박진감 있는 3인칭 비행 프레이밍
        desiredTargetX = player.x + Math.sin(player.yaw) * 0.9;
        desiredTargetY = player.y + 0.55;
        desiredTargetZ = player.z + Math.cos(player.yaw) * 0.9;
      } else if (districtFocus && !opts.inputLocked) {
        desiredTargetX = districtFocus.x;
        desiredTargetY = districtFocus.y;
        desiredTargetZ = districtFocus.z;
      } else if (dialogueFraming && opts.focusActorPos) {
        // 1단계 RPG 대화: 타깃을 사령관 상체 중심 쪽(blendT 0.78)으로 두고 우측·약간 높은 3/4 시점으로 빼서
        // 사령관 얼굴이 상단 중앙~우측에 가림 없이 또렷하게 잡히고 제독은 좌하단 가장자리에 아담하게 들어오도록 프레이밍
        const blendT = focusDistToPlayer < 12.0 ? 0.78 : 1.0;
        const midX = player.x + (opts.focusActorPos.x - player.x) * blendT;
        const midZ = player.z + (opts.focusActorPos.z - player.z) * blendT;
        const midGy = Math.max(-0.05, opts.getGroundHeight(midX, midZ));
        desiredTargetX = midX - Math.cos(camYaw) * 0.18;
        desiredTargetY = midGy + 0.78;
        desiredTargetZ = midZ + Math.sin(camYaw) * 0.18;
      } else if (drawerFraming && opts.focusActorPos) {
        // 2단계 우측 사령관 수첩 드로어: 타깃을 카메라 우측 벡터(+cos(camYaw)*1.45, -sin(camYaw)*1.45)로 밀어
        // 3D 사령관·제독이 열린 좌측 57% 초원 정중앙에 가려짐 없이 선명하게 배치되도록 프레이밍
        const blendT = focusDistToPlayer < 12.0 ? 0.56 : 1.0;
        const baseX = player.x + (opts.focusActorPos.x - player.x) * blendT;
        const baseZ = player.z + (opts.focusActorPos.z - player.z) * blendT;
        const baseGy = Math.max(-0.05, opts.getGroundHeight(baseX, baseZ));
        desiredTargetX = baseX + Math.cos(camYaw) * 1.45;
        desiredTargetY = baseGy + 0.94;
        desiredTargetZ = baseZ - Math.sin(camYaw) * 1.45;
      } else if (sittingAtCampfire && !opts.inputLocked) {
        desiredTargetX = (CAMPFIRE_BENCH_X + CAMPFIRE_FIRE_X) * 0.5;
        desiredTargetY = gy + (campfireWithCompanions ? 0.85 : 0.92);
        desiredTargetZ = campfireWithCompanions
          ? CAMPFIRE_BENCH_Z * 0.35 + CAMPFIRE_FIRE_Z * 0.65
          : (CAMPFIRE_BENCH_Z + CAMPFIRE_FIRE_Z) * 0.5;
      } else if (interactingClose && opts.focusActorPos) {
        desiredTargetX = player.x + (opts.focusActorPos.x - player.x) * 0.42;
        desiredTargetZ = player.z + (opts.focusActorPos.z - player.z) * 0.42;
      }
      const inFocusFraming = dialogueFraming || drawerFraming || customizerFraming;
      const targetLerp = reduceMotion
        ? 1
        : 1 - Math.exp(-opts.dt * (takeoffCharging ? 15.0 : takeoffAscending ? 16.0 : player.diving ? 10.5 : aceChaseFraming ? 12.5 : cinemaFraming ? 2.2 : overviewMode ? 5.8 : sittingAtCampfire ? 4.5 : inFocusFraming ? 7.2 : 8.5));
      cameraTarget.x += (desiredTargetX - cameraTarget.x) * targetLerp;
      // 이륙 상승 구간에는 타깃 Y를 1:1 직접 동기화해 빙글빙글 오르는 제독이 절대 화면 아래로 밀리지 않도록 보장
      if (takeoffAscending) {
        cameraTarget.y = desiredTargetY;
      } else {
        cameraTarget.y += (desiredTargetY - cameraTarget.y) * targetLerp;
      }
      cameraTarget.z += (desiredTargetZ - cameraTarget.z) * targetLerp;

      // 줌 거리 및 추적↔조망↔2단계 이륙↔에이스 추격↔하늘 비행↔유성 급강하↔구역 포커스↔RPG/드로어/드레스업/시네마↔불멍 전환 보간
      const zoomLerp = reduceMotion ? 1 : 1 - Math.exp(-opts.dt * 10.0);
      camDist += (targetCamDist - camDist) * zoomLerp;

      // 상승 구간 로우앵글 곡선: 약간 아래-뒤쪽에서 올려다보며 동반 상승 → 정점에서 에이스 추격 수평 시점으로 자연 합류
      const ascendLowAngleWave = takeoffAscending
        ? Math.sin(Math.min(1, player.takeoffProgress / 0.86) * Math.PI)
        : 0;

      const focusDist = interactingClose ? Math.min(camDist, 7.6) : camDist;
      const desiredEffDist =
        customizerFraming
          ? 3.85
          : takeoffCharging
            ? 4.9
            : takeoffAscending
              ? 4.9 + (chaseDist - 4.9) * ascendEase
              : player.diving
                ? Math.max(camDist, 12.5 + player.flightAlt * 0.95)
                : cinemaFraming && opts.cinemaTarget
                  ? opts.cinemaTarget.dist
                  : aceChaseFraming || overviewMode
                    ? chaseDist
                    : districtFocus && !opts.inputLocked
                      ? districtFocus.dist
                      : dialogueFraming
                        ? 7.4
                        : drawerFraming
                          ? 7.2
                          : sittingAtCampfire && !opts.inputLocked
                            ? (campfireWithCompanions ? 4.9 + Math.min(3.3, (opts.companionCount ?? 0) * 0.44) : 4.45)
                            : opts.cameraMode === "orbit"
                              ? Math.max(28, camDist * 2.65)
                              : focusDist;
      const desiredEffPitch =
        customizerFraming
          ? 0.24
          : takeoffCharging
            ? 0.14
            : takeoffAscending
              ? (0.14 + (chasePitch - 0.14) * ascendEase) - ascendLowAngleWave * 0.30
              : player.diving
                ? Math.max(camPitch, 0.34 + Math.min(0.45, player.flightAlt * 0.028))
                : cinemaFraming && opts.cinemaTarget
                  ? opts.cinemaTarget.pitch
                  : aceChaseFraming || overviewMode
                    ? chasePitch
                    : districtFocus && !opts.inputLocked
                      ? districtFocus.pitch
                      : dialogueFraming
                        ? 0.29
                        : drawerFraming
                          ? 0.25
                          : sittingAtCampfire && !opts.inputLocked
                            ? (campfireWithCompanions ? 0.37 : 0.26)
                            : opts.cameraMode === "orbit"
                              ? Math.max(0.54, camPitch)
                              : camPitch;
      const modeLerp = reduceMotion
        ? 1
        : 1 - Math.exp(-opts.dt * (takeoffCharging ? 12.5 : takeoffAscending ? 13.5 : player.diving ? 6.8 : aceChaseFraming || overviewMode ? 7.5 : cinemaFraming ? 2.2 : sittingAtCampfire ? 4.5 : inFocusFraming ? 7.2 : 9.0));
      smoothedEffDist += (desiredEffDist - smoothedEffDist) * modeLerp;
      smoothedEffPitch += (desiredEffPitch - smoothedEffPitch) * modeLerp;

      // 질주(`Shift` 44→49) · 이륙 줌인(`42→60`) · 에이스 추격(`60→68`) · 링 통과 부스트(+7°) · 유성 급강하(`54`) 동적 FOV 부드러운 보간
      const ringBurstFov = skyBoostBurstTimer > 0 ? Math.min(1, skyBoostBurstTimer / 0.45) * 7 : 0;
      const rawDesiredFov =
        takeoffCharging
          ? 42
          : takeoffAscending
            ? 42 + 18 * ascendEase
            : player.diving
              ? 54
              : cinemaFraming
                ? 42
                : aceChaseFraming || overviewMode
                  ? (player.sprinting && player.moveSpeed > 2 ? 68 : 60) + ringBurstFov
                  : sittingAtCampfire && !opts.inputLocked
                    ? 42
                    : player.sprinting && player.walking
                      ? 49
                      : 44;
      // (#10) 저모션 모드에서는 급격한 FOV 변화폭을 25% 수준으로 부드럽게 완화
      const desiredFov = reduceMotion ? 44 + (rawDesiredFov - 44) * 0.25 : rawDesiredFov;
      const fovLerp = 1 - Math.exp(-opts.dt * (reduceMotion ? 4.5 : 7.5));
      smoothedFov += (desiredFov - smoothedFov) * fovLerp;

      let effDist = smoothedEffDist;
      let effPitch = smoothedEffPitch;
      let effYaw = camYaw;
      let effFov = smoothedFov;

      // 배럴롤 시 가벼운 카메라 흔들림/기울임 피드백 (저모션 모드에서는 25%로 완화)
      let barrelCamJitterY = 0;
      if (player.barrelRollTimer > 0 && aceChaseFraming) {
        const rollPhase = 1 - player.barrelRollTimer / BARREL_ROLL_SEC;
        const rollScale = reduceMotion ? 0.25 : 1.0;
        barrelCamJitterY = Math.sin(rollPhase * Math.PI * 2) * 0.22 * rollScale;
        effYaw += Math.sin(rollPhase * Math.PI) * 0.045 * barrelRollDir * rollScale;
      }

      if (!reduceMotion) {
        if (opts.lifecycle === "diving") {
          const ease = 1 - Math.pow(1 - cineProgress, 3);
          effDist = 52 + (effDist - 52) * ease;
          effPitch = 1.15 + (effPitch - 1.15) * ease;
          effYaw = (effYaw - 1.05) + 1.05 * ease;
          effFov = 68 + (46 - 68) * ease;
        } else if (opts.lifecycle === "escaping") {
          const ease = Math.pow(cineProgress, 2);
          effDist += 52 * ease;
          effPitch += (1.20 - effPitch) * ease;
          effYaw += 1.0 * ease;
          effFov = 46 + 22 * ease;
        }
      }

      if (Math.abs(opts.camera.fov - effFov) > 0.05) {
        opts.camera.fov = effFov;
        opts.camera.updateProjectionMatrix();
      }

      // 카메라 스프링-암(Spring-Arm) 0-GC 차폐 회피:
      // 1) 경량 실린더 차폐체(가로등·나무·건물·석문 기둥) 3-위스커(중앙/좌/우 프러스텀 여백) 스윕
      // 2) setCameraOccluders(objects)로 등록된 3D 메시/InstancedMesh(석문·담장·대형 수관) Box3 브로드페이즈 + 4-위스커 레이캐스트
      let finalDist = effDist;
      const hasCylinderOccluders = opts.getCameraOccluders !== undefined;
      const hasMeshOccluders = occSourceObjects.length > 0;
      const useSpringArm =
        opts.lifecycle === "open"
        && !overviewMode
        && !player.diving
        && opts.cameraMode === "follow"
        && (hasCylinderOccluders || hasMeshOccluders);
      if (useSpringArm) {
        const cosPitch = Math.cos(effPitch);
        const dirX = Math.sin(effYaw) * cosPitch;
        const dirY = Math.sin(effPitch);
        const dirZ = Math.cos(effYaw) * cosPitch;
        const rightX = Math.cos(effYaw);
        const rightZ = -Math.sin(effYaw);
        const baseCamX = cameraTarget.x + dirX * effDist;
        const baseCamY = cameraTarget.y + dirY * effDist;
        const baseCamZ = cameraTarget.z + dirZ * effDist;
        let minAllowedDist = effDist;

        if (hasCylinderOccluders) {
          const occluders = opts.getCameraOccluders!();
          if (occluders.length > 0) {
            for (let i = 0; i < occluders.length; i += 1) {
              const occ = occluders[i]!;
              const occBaseY = opts.getGroundHeight(occ.x, occ.z);
              const occMinY = occ.minY ?? occBaseY;
              const occMaxY = occBaseY + occ.height + 0.42;
              const coreR2 = occ.radius * occ.radius * 0.68;

              // w = 0 (중앙), -1 (좌 프러스텀), +1 (우 프러스텀)
              for (let w = -1; w <= 1; w += 1) {
                const origLat = w * 0.14;
                const endLat = w * 0.62;
                const ox = cameraTarget.x + rightX * origLat;
                const oz = cameraTarget.z + rightZ * origLat;
                const ex = baseCamX + rightX * endLat;
                const ez = baseCamZ + rightZ * endLat;
                const segDx = ex - ox;
                const segDz = ez - oz;
                const aQuad = segDx * segDx + segDz * segDz;
                if (aQuad <= 1e-4) continue;

                const fx = ox - occ.x;
                const fz = oz - occ.z;
                const distSqOrigin = fx * fx + fz * fz;
                if (distSqOrigin <= coreR2) continue;

                const padR = occ.radius + (w === 0 ? 0.42 : 0.24);
                const padR2 = padR * padR;
                const cQuad = distSqOrigin - padR2;

                if (cQuad <= 0) {
                  // 위스커 시작점이 외곽 패딩 경계 바로 옆에 있고 카메라 쪽이 차폐체 내부로 향할 때
                  const camDx = ex - occ.x;
                  const camDz = ez - occ.z;
                  if (fx * segDx + fz * segDz < 0 || camDx * camDx + camDz * camDz < padR2) {
                    if (baseCamY >= occMinY - 0.35 && baseCamY <= occMaxY) {
                      const pulled = Math.min(effDist, MIN_SPRING_ARM_DIST);
                      if (pulled < minAllowedDist) {
                        minAllowedDist = pulled;
                      }
                    }
                  }
                  continue;
                }

                const bQuad = 2 * (fx * segDx + fz * segDz);
                const disc = bQuad * bQuad - 4 * aQuad * cQuad;
                if (disc < 0) continue;
                const tHit = (-bQuad - Math.sqrt(disc)) / (2 * aQuad);
                if (tHit <= 0.02 || tHit >= 1.0) continue;
                const yHit = cameraTarget.y + dirY * (tHit * effDist);
                if (yHit >= occMinY - 0.35 && yHit <= occMaxY) {
                  const pulled = Math.min(effDist, Math.max(MIN_SPRING_ARM_DIST, tHit * effDist - 0.42));
                  if (pulled < minAllowedDist) {
                    minAllowedDist = pulled;
                  }
                }
              }
            }
          }
        }

        if (hasMeshOccluders) {
          if (occBoundsDirty) {
            rebuildOccluderCache();
          }
          if (occMeshList.length > 0) {
            occDesiredCam.set(baseCamX, baseCamY, baseCamZ);
            occSegmentBox.makeEmpty();
            occSegmentBox.expandByPoint(cameraTarget);
            occSegmentBox.expandByPoint(occDesiredCam);
            occSegmentBox.expandByScalar(0.85);

            occCandidates.length = 0;
            for (let i = 0; i < occMeshList.length; i += 1) {
              const mesh = occMeshList[i]!;
              if (!mesh.visible) continue;
              const box = occMeshBounds[i];
              if (box && occSegmentBox.intersectsBox(box)) {
                occCandidates.push(mesh);
              }
            }

            if (occCandidates.length > 0) {
              // 4-위스커: 중앙(0), 좌(-0.62), 우(+0.62), 상단(+0.34m, 석문 상인방·수목 수관 감지)
              for (let p = 0; p < 4; p += 1) {
                const origLat = p === 1 ? -0.14 : p === 2 ? 0.14 : 0;
                const endLat = p === 1 ? -0.62 : p === 2 ? 0.62 : 0;
                const endLiftY = p === 3 ? 0.34 : 0;

                occRayOrigin.set(
                  cameraTarget.x + rightX * origLat,
                  cameraTarget.y,
                  cameraTarget.z + rightZ * origLat,
                );
                occRayDir.set(
                  baseCamX + rightX * endLat - occRayOrigin.x,
                  baseCamY + endLiftY - occRayOrigin.y,
                  baseCamZ + rightZ * endLat - occRayOrigin.z,
                );
                const probeLen = occRayDir.length();
                if (probeLen <= 0.3) continue;
                occRayDir.multiplyScalar(1 / probeLen);

                occRaycaster.near = 0.25;
                occRaycaster.far = Math.min(probeLen, minAllowedDist + 0.45);
                occRaycaster.set(occRayOrigin, occRayDir);
                occHits.length = 0;
                occRaycaster.intersectObjects(occCandidates, false, occHits);
                if (occHits.length > 0) {
                  const hitDist = occHits[0]!.distance;
                  const pulled = Math.min(effDist, Math.max(MIN_SPRING_ARM_DIST, hitDist - 0.44));
                  if (pulled < minAllowedDist) {
                    minAllowedDist = pulled;
                  }
                }
              }
              occHits.length = 0;
              occCandidates.length = 0;
            }
          }
        }

        if (snapSpringArmOnNextFrame) {
          springArmDist = Math.min(effDist, minAllowedDist);
          snapSpringArmOnNextFrame = false;
        } else {
          const armLerp = reduceMotion
            ? 1
            : 1 - Math.exp(-opts.dt * (minAllowedDist < springArmDist ? 22.0 : 4.8));
          springArmDist += (minAllowedDist - springArmDist) * armLerp;
        }
        finalDist = Math.min(effDist, springArmDist);
      } else {
        springArmDist = effDist;
        snapSpringArmOnNextFrame = false;
      }

      const cxPos = cameraTarget.x + Math.sin(effYaw) * Math.cos(effPitch) * finalDist;
      const czPos = cameraTarget.z + Math.cos(effYaw) * Math.cos(effPitch) * finalDist;
      const groundUnderCam = opts.getGroundHeight(cxPos, czPos);
      const cyPos = Math.max(groundUnderCam + 0.85, cameraTarget.y + Math.sin(effPitch) * finalDist + barrelCamJitterY);

      opts.camera.position.set(cxPos, cyPos, czPos);
      opts.camera.lookAt(cameraTarget);
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (reducedMotionMq) {
        reducedMotionMq.removeEventListener("change", onReducedMotionChange);
        reducedMotionMq = null;
      }
      occSourceObjects.length = 0;
      occTraverseStack.length = 0;
      occMeshList.length = 0;
      occMeshBounds.length = 0;
      occCandidates.length = 0;
      occHits.length = 0;
      villageHints = [];
    },
  };
}
