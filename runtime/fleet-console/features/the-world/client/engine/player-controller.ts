import { PerspectiveCamera, Vector3 } from "three";

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
}

export type CameraFocusFraming = "none" | "dialogue" | "drawer" | "customizer";

export interface PlayerAndCameraController {
  readonly player: PlayerState;
  readonly cameraTarget: Vector3;
  update(options: {
    readonly dt: number;
    readonly lifecycle: WorldLifecycleState;
    readonly cameraMode: WorldCameraMode;
    readonly reducedMotion: boolean;
    readonly inputLocked: boolean;
    readonly focusActorPos: { readonly x: number; readonly z: number } | null;
    readonly focusFraming?: CameraFocusFraming | undefined;
    readonly camera: PerspectiveCamera;
    readonly getGroundHeight: (x: number, z: number) => number;
    readonly resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number };
    readonly getCameraOccluders?: (() => readonly CameraOccluder[]) | undefined;
    readonly onDustParticle: (x: number, y: number, z: number) => void;
    readonly onOverviewAutoExit?: (() => void) | undefined;
    readonly onJump?: (() => void) | undefined;
    readonly onLand?: (() => void) | undefined;
    readonly onStandUp?: (() => void) | undefined;
  }): void;
  teleportTo(
    x: number,
    z: number,
    getGroundHeight: (x: number, z: number) => number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
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
  /** RTS 하늘 조망 모드 (`M` 키) — 56m 초원 전체를 상공 쿼터뷰로 내려다보며 해제/구역 선택 시 급강하한다. */
  setOverviewMode(enabled: boolean): void;
  isOverviewMode(): boolean;
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
  let sittingAtCampfire = false;
  let jumpedFromGround = false;

  const CAMPFIRE_BENCH_X = 2.8;
  const CAMPFIRE_BENCH_Z = 2.55;
  const CAMPFIRE_FIRE_X = 2.8;
  const CAMPFIRE_FIRE_Z = 1.0;

  const orbitAnchor = new Vector3(0, 1.0, 1.5);
  const cameraTarget = new Vector3(0.4, 1.45, 2.2);

  // 심시티 구역 선택 시 일시적인 쿼터뷰 포커스 상태 & RTS 하늘 조망 모드 상태
  const ORBIT_CLAMP = 50;
  let districtFocus: {
    x: number;
    y: number;
    z: number;
    dist: number;
    pitch: number;
  } | null = null;

  let overviewMode = false;
  const overviewAnchor = new Vector3(0, 1.0, 4.0);
  let overviewDist = 86;
  let overviewPitch = 1.20;

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
    teleportTo(x, z, getGroundHeight, resolveMovement) {
      districtFocus = null;
      overviewMode = false;
      sittingAtCampfire = false;
      // 캠프·마을 앞마당(남쪽 입구) 안전한 오솔길 지점으로 착지
      const rawX = x;
      const rawZ = z + 3.0;
      const safe = resolveMovement(x, z, rawX, rawZ, 0.55);
      player.x = safe.x;
      player.z = safe.z;
      player.vx = 0;
      player.vz = 0;
      player.y = Math.max(0.05, getGroundHeight(player.x, player.z)) + 0.35;
      player.vy = 0;
      player.playerJumpY = 0;
      player.jumpVel = 0;
      player.landSquash = 0;
      player.moveSpeed = 0;
      player.campfireSitSec = 0;
      jumpedFromGround = false;
      player.yaw = Math.atan2(x - player.x, z - player.z);
      orbitAnchor.set(
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, x)),
        Math.max(0.5, getGroundHeight(x, z)) + 0.8,
        Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, z)),
      );
    },
    approachPoint(targetX, targetZ, getGroundHeight, resolveMovement) {
      districtFocus = null;
      overviewMode = false;
      sittingAtCampfire = false;
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
        overviewAnchor.set(0, 1.0, 4.0);
        overviewDist = 86;
        overviewPitch = 1.20;
      }
    },
    isOverviewMode() {
      return overviewMode;
    },
    isSprinting() {
      return player.sprinting && player.walking;
    },
    setCampfireSit(sitting) {
      if (sitting === sittingAtCampfire) return;
      sittingAtCampfire = sitting;
      player.campfireSitSec = 0;
      if (sitting) {
        districtFocus = null;
        overviewMode = false;
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
      camYaw -= dx * 0.0062;
      if (overviewMode) {
        overviewPitch = Math.max(0.70, Math.min(1.36, overviewPitch + dy * 0.0042));
      } else if (districtFocus) {
        districtFocus.pitch = Math.max(0.22, Math.min(1.16, districtFocus.pitch + dy * 0.0048));
      } else {
        camPitch = Math.max(0.12, Math.min(1.16, camPitch + dy * 0.0048));
      }
    },
    onWheelZoom(deltaY) {
      const clamped = Math.max(-180, Math.min(180, deltaY));
      if (overviewMode) {
        overviewDist = Math.max(46.0, Math.min(112.0, overviewDist * Math.exp(clamped * 0.0012)));
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

      if (opts.lifecycle === "open" && !opts.inputLocked) {
        let ix = 0;
        let iz = 0;
        if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
        if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
        if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
        if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
        const spacePressed = keys.has("Space");
        player.sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight");

        // 불멍 중 WASD/방향키 또는 Space 입력 시 자동 기상!
        if (sittingAtCampfire && (ix !== 0 || iz !== 0 || spacePressed)) {
          sittingAtCampfire = false;
          player.campfireSitSec = 0;
          opts.onStandUp?.();
        }

        if (ix !== 0 || iz !== 0) {
          // WASD/방향키 이동 시작 시 구역 포커스를 해제하고, 추적 모드에서 하늘 조망 중이면 부드럽게 급강하 복귀
          districtFocus = null;
          if (overviewMode && opts.cameraMode !== "orbit") {
            overviewMode = false;
            opts.onOverviewAutoExit?.();
          }
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
          player.yaw = Math.atan2(CAMPFIRE_FIRE_X - CAMPFIRE_BENCH_X, CAMPFIRE_FIRE_Z - CAMPFIRE_BENCH_Z);
          if (!opts.reducedMotion) {
            camYaw += opts.dt * 0.14;
          }
        } else if (overviewMode) {
          // RTS 하늘 조망(orbit 조합)에서는 WASD로 상공 주시점 패닝
          player.campfireSitSec = 0;
          player.walking = false;
          player.vx = 0;
          player.vz = 0;
          player.moveSpeed = 0;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const panSpeed = (player.sprinting ? 38 : 24) * opts.dt;
            overviewAnchor.x = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, overviewAnchor.x + mx * panSpeed));
            overviewAnchor.z = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, overviewAnchor.z + mz * panSpeed));
          }
        } else if (opts.cameraMode === "orbit") {
          // 초원 조망 모드에서는 WASD로 카메라 주시점을 넓은 초원(±50m) 위로 부드럽게 패닝!
          player.campfireSitSec = 0;
          player.walking = false;
          player.vx = 0;
          player.vz = 0;
          player.moveSpeed = 0;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const panSpeed = (player.sprinting ? 26 : 15) * opts.dt;
            orbitAnchor.x = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, orbitAnchor.x + mx * panSpeed));
            orbitAnchor.z = Math.max(-ORBIT_CLAMP, Math.min(ORBIT_CLAMP, orbitAnchor.z + mz * panSpeed));
            orbitAnchor.y = Math.max(0.5, opts.getGroundHeight(orbitAnchor.x, orbitAnchor.z)) + 0.9;
          }
        } else {
          // 3인칭 추적 모드: 부드러운 가감속 물리 이동(`Shift` 1.65x 대시 질주) + 슬라이딩 장애물 충돌
          player.campfireSitSec = 0;
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
        player.vx *= Math.max(0, 1 - opts.dt * 14);
        player.vz *= Math.max(0, 1 - opts.dt * 14);
        player.moveSpeed = Math.hypot(player.vx, player.vz);
        player.walking = false;
        player.sprinting = false;
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
      player.jumpVel = player.onGround ? 0 : player.vy;
      if (player.landSquash > 0) {
        player.landSquash = Math.max(0, player.landSquash - opts.dt * 4.6);
      }

      // 카메라 주시점 보간 (제독 드레스업 클로즈업 > RTS 하늘 조망 > 구역 포커스 > RPG 2샷 대화 / 우측 드로어 좌측 삼분할 > 모닥불 불멍 > 방사형 근접 > 일반 추적/조망)
      let desiredTargetX = opts.cameraMode === "orbit" ? orbitAnchor.x : player.x;
      let desiredTargetY = opts.cameraMode === "orbit" ? orbitAnchor.y : player.y + 1.12;
      let desiredTargetZ = opts.cameraMode === "orbit" ? orbitAnchor.z : player.z;
      const focusFraming = opts.focusFraming ?? "none";
      const customizerFraming = focusFraming === "customizer";
      const hasFocusActor = !customizerFraming && !overviewMode && !districtFocus && !sittingAtCampfire && opts.focusActorPos !== null;
      const focusDistToPlayer = hasFocusActor && opts.focusActorPos
        ? Math.hypot(opts.focusActorPos.x - player.x, opts.focusActorPos.z - player.z)
        : Infinity;
      const dialogueFraming = hasFocusActor && focusFraming === "dialogue";
      const drawerFraming = hasFocusActor && focusFraming === "drawer";

      // 1단계 RPG 대화 진입 시 NPC 정면 3/4 구도, 드레스업 진입 시 제독 정면 클로즈업 각도로 자동 정렬 (드래그 시 즉시 해제)
      if (focusFraming !== prevFocusFraming) {
        if (dialogueFraming && opts.focusActorPos && focusDistToPlayer > 0.25 && focusDistToPlayer < 12.0) {
          const npcToPlayerYaw = Math.atan2(player.x - opts.focusActorPos.x, player.z - opts.focusActorPos.z);
          autoDialogueYaw = npcToPlayerYaw + 0.56;
        } else if (customizerFraming) {
          autoDialogueYaw = player.yaw + 0.16;
        } else {
          autoDialogueYaw = null;
        }
        prevFocusFraming = focusFraming;
      }
      if (autoDialogueYaw !== null && (dialogueFraming || customizerFraming)) {
        let yawDiff = autoDialogueYaw - camYaw;
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        if (Math.abs(yawDiff) < 0.015 || opts.reducedMotion) {
          camYaw = autoDialogueYaw;
          autoDialogueYaw = null;
        } else {
          camYaw += yawDiff * (1 - Math.exp(-opts.dt * 6.5));
        }
      }
      const interactingClose =
        hasFocusActor
        && focusFraming === "none"
        && opts.cameraMode === "follow"
        && focusDistToPlayer < 9.0;

      if (customizerFraming) {
        // 실시간 3D 제독 드레스업: 타깃을 카메라 우측 벡터(+cos(camYaw)*0.95, -sin(camYaw)*0.95)로 밀어
        // 우측 플로팅 드레스업 시트를 피해 좌측 65% 열린 화면 정중앙에 제독 얼굴·모자를 클로즈업
        desiredTargetX = player.x + Math.cos(camYaw) * 0.95;
        desiredTargetY = player.y + 0.72;
        desiredTargetZ = player.z - Math.sin(camYaw) * 0.95;
      } else if (overviewMode && !opts.inputLocked) {
        desiredTargetX = overviewAnchor.x;
        desiredTargetY = overviewAnchor.y;
        desiredTargetZ = overviewAnchor.z;
      } else if (districtFocus && !opts.inputLocked) {
        desiredTargetX = districtFocus.x;
        desiredTargetY = districtFocus.y;
        desiredTargetZ = districtFocus.z;
      } else if (dialogueFraming && opts.focusActorPos) {
        // 1단계 RPG 대화: 제독·사령관 중간점을 겨냥하고 높이를 살짝 낮춰 하단 중앙 RPG 바 위쪽 65% 중앙에 2샷 프레이밍
        const blendT = focusDistToPlayer < 12.0 ? 0.48 : 1.0;
        const midX = player.x + (opts.focusActorPos.x - player.x) * blendT;
        const midZ = player.z + (opts.focusActorPos.z - player.z) * blendT;
        const midGy = Math.max(-0.05, opts.getGroundHeight(midX, midZ));
        desiredTargetX = midX;
        desiredTargetY = midGy + 0.78;
        desiredTargetZ = midZ;
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
        desiredTargetY = gy + 0.92;
        desiredTargetZ = (CAMPFIRE_BENCH_Z + CAMPFIRE_FIRE_Z) * 0.5;
      } else if (interactingClose && opts.focusActorPos) {
        desiredTargetX = player.x + (opts.focusActorPos.x - player.x) * 0.42;
        desiredTargetZ = player.z + (opts.focusActorPos.z - player.z) * 0.42;
      }
      const inFocusFraming = dialogueFraming || drawerFraming || customizerFraming;
      const targetLerp = opts.reducedMotion ? 1 : 1 - Math.exp(-opts.dt * (overviewMode ? 6.5 : sittingAtCampfire ? 4.5 : inFocusFraming ? 7.2 : 8.5));
      cameraTarget.x += (desiredTargetX - cameraTarget.x) * targetLerp;
      cameraTarget.y += (desiredTargetY - cameraTarget.y) * targetLerp;
      cameraTarget.z += (desiredTargetZ - cameraTarget.z) * targetLerp;

      // 줌 거리 및 추적↔조망↔하늘 조망↔구역 포커스↔RPG/드로어/드레스업↔불멍 전환을 프레임 레이트 독립 지수 감쇠로 부드럽게 보간
      const zoomLerp = opts.reducedMotion ? 1 : 1 - Math.exp(-opts.dt * 10.0);
      camDist += (targetCamDist - camDist) * zoomLerp;

      const focusDist = interactingClose ? Math.min(camDist, 7.6) : camDist;
      const desiredEffDist =
        customizerFraming
          ? 4.35
          : overviewMode && !opts.inputLocked
            ? overviewDist
            : districtFocus && !opts.inputLocked
              ? districtFocus.dist
              : dialogueFraming
                ? 6.1
                : drawerFraming
                  ? 7.2
                  : sittingAtCampfire && !opts.inputLocked
                    ? 4.45
                    : opts.cameraMode === "orbit"
                      ? Math.max(28, camDist * 2.65)
                      : focusDist;
      const desiredEffPitch =
        customizerFraming
          ? 0.18
          : overviewMode && !opts.inputLocked
            ? overviewPitch
            : districtFocus && !opts.inputLocked
              ? districtFocus.pitch
              : dialogueFraming
                ? 0.21
                : drawerFraming
                  ? 0.25
                  : sittingAtCampfire && !opts.inputLocked
                    ? 0.26
                    : opts.cameraMode === "orbit"
                      ? Math.max(0.54, camPitch)
                      : camPitch;
      const modeLerp = opts.reducedMotion ? 1 : 1 - Math.exp(-opts.dt * (overviewMode ? 6.5 : sittingAtCampfire ? 4.5 : inFocusFraming ? 7.2 : 9.0));
      smoothedEffDist += (desiredEffDist - smoothedEffDist) * modeLerp;
      smoothedEffPitch += (desiredEffPitch - smoothedEffPitch) * modeLerp;

      // 질주(`Shift`) 동적 FOV 44→49 부드러운 보간
      const desiredFov =
        overviewMode && !opts.inputLocked
          ? 50
          : sittingAtCampfire && !opts.inputLocked
            ? 42
            : player.sprinting && player.walking
              ? 49
              : 44;
      const fovLerp = opts.reducedMotion ? 1 : 1 - Math.exp(-opts.dt * 7.5);
      smoothedFov += (desiredFov - smoothedFov) * fovLerp;

      let effDist = smoothedEffDist;
      let effPitch = smoothedEffPitch;
      let effYaw = camYaw;
      let effFov = smoothedFov;

      if (!opts.reducedMotion) {
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

      // 카메라 스프링-암(Spring-Arm) 가림 방지: 가로등·나무·건물 실린더 관통 시 부드럽게 안쪽으로 당김
      let finalDist = effDist;
      const useSpringArm =
        opts.lifecycle === "open"
        && !overviewMode
        && opts.cameraMode === "follow"
        && opts.getCameraOccluders !== undefined;
      if (useSpringArm) {
        const occluders = opts.getCameraOccluders!();
        const dirX = Math.sin(effYaw) * Math.cos(effPitch);
        const dirY = Math.sin(effPitch);
        const dirZ = Math.cos(effYaw) * Math.cos(effPitch);
        const segDx = dirX * effDist;
        const segDz = dirZ * effDist;
        const aQuad = segDx * segDx + segDz * segDz;
        let minAllowedDist = effDist;

        if (aQuad > 1e-4 && occluders.length > 0) {
          for (let i = 0; i < occluders.length; i += 1) {
            const occ = occluders[i]!;
            const fx = cameraTarget.x - occ.x;
            const fz = cameraTarget.z - occ.z;
            const padR = occ.radius + 0.36;
            const cQuad = fx * fx + fz * fz - padR * padR;
            // 이미 타깃 자체가 실린더 안에 있는 특수 경우(예: 벤치 바로 옆)는 건너뜀
            if (cQuad <= 0) continue;
            const bQuad = 2 * (fx * segDx + fz * segDz);
            const disc = bQuad * bQuad - 4 * aQuad * cQuad;
            if (disc < 0) continue;
            const tHit = (-bQuad - Math.sqrt(disc)) / (2 * aQuad);
            if (tHit <= 0.08 || tHit >= 1.0) continue;
            const yHit = cameraTarget.y + dirY * (tHit * effDist);
            const occBaseY = opts.getGroundHeight(occ.x, occ.z);
            if (yHit <= occBaseY + occ.height + 0.35) {
              const pulled = Math.max(2.35, tHit * effDist - 0.38);
              if (pulled < minAllowedDist) {
                minAllowedDist = pulled;
              }
            }
          }
        }

        const armLerp = opts.reducedMotion
          ? 1
          : 1 - Math.exp(-opts.dt * (minAllowedDist < springArmDist ? 18.0 : 5.2));
        springArmDist += (minAllowedDist - springArmDist) * armLerp;
        finalDist = Math.min(effDist, springArmDist);
      } else {
        springArmDist = effDist;
      }

      const cxPos = cameraTarget.x + Math.sin(effYaw) * Math.cos(effPitch) * finalDist;
      const czPos = cameraTarget.z + Math.cos(effYaw) * Math.cos(effPitch) * finalDist;
      const groundUnderCam = opts.getGroundHeight(cxPos, czPos);
      const cyPos = Math.max(groundUnderCam + 0.85, cameraTarget.y + Math.sin(effPitch) * finalDist);

      opts.camera.position.set(cxPos, cyPos, czPos);
      opts.camera.lookAt(cameraTarget);
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    },
  };
}
