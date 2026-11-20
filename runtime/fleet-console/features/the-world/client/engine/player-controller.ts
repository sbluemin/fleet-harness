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
  yaw: number;
  walking: boolean;
  sprinting: boolean;
  onGround: boolean;
}

export interface PlayerAndCameraController {
  readonly player: PlayerState;
  readonly cameraTarget: Vector3;
  update(options: {
    readonly dt: number;
    readonly lifecycle: WorldLifecycleState;
    readonly cameraMode: WorldCameraMode;
    readonly reducedMotion: boolean;
    readonly camera: PerspectiveCamera;
    readonly getGroundHeight: (x: number, z: number) => number;
    readonly resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number };
    readonly onDustParticle: (x: number, y: number, z: number) => void;
  }): void;
  teleportTo(
    x: number,
    z: number,
    getGroundHeight: (x: number, z: number) => number,
    resolveMovement: (curX: number, curZ: number, nextX: number, nextZ: number, radius?: number) => { x: number; z: number },
  ): void;
  focusOrbitOn(x: number, z: number, getGroundHeight: (x: number, z: number) => number): void;
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
    yaw: Math.PI, // 정면의 길드 회관(-Z)을 바라보며 시작
    walking: false,
    sprinting: false,
    onGround: true,
  };

  // 지평선·길드회관·풍차·원경 산맥이 시원하게 한눈에 들어오는 어드벤처 카메라 각도
  let camYaw = 0.22;
  let camPitch = 0.28;
  let camDist = 9.8;
  let cineProgress = 0;
  let prevLifecycle: WorldLifecycleState = "closed";

  const orbitAnchor = new Vector3(0, 1.0, 1.5);
  const cameraTarget = new Vector3(0.4, 1.45, 2.2);

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
      // 캠프 앞마당(남쪽 입구) 안전한 오솔길 지점으로 착지
      const rawX = x;
      const rawZ = z + 3.4;
      const safe = resolveMovement(rawX, rawZ + 1.0, rawX, rawZ, 0.55);
      player.x = safe.x;
      player.z = safe.z;
      player.vx = 0;
      player.vz = 0;
      player.y = Math.max(0.05, getGroundHeight(player.x, player.z)) + 0.85;
      player.vy = 0;
      player.yaw = Math.atan2(x - player.x, z - player.z);
      orbitAnchor.set(x, Math.max(0.5, getGroundHeight(x, z)) + 0.8, z);
    },
    focusOrbitOn(x, z, getGroundHeight) {
      orbitAnchor.set(x, Math.max(0.5, getGroundHeight(x, z)) + 0.9, z);
    },
    onPointerRotate(dx, dy) {
      camYaw -= dx * 0.0062;
      camPitch = Math.max(0.12, Math.min(1.16, camPitch + dy * 0.0048));
    },
    onWheelZoom(deltaY) {
      camDist = Math.max(4.4, Math.min(34.0, camDist + deltaY * 0.015));
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

      if (opts.lifecycle === "open") {
        let ix = 0;
        let iz = 0;
        if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
        if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
        if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
        if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
        player.sprinting = keys.has("ShiftLeft") || keys.has("ShiftRight");

        const cy = Math.cos(camYaw);
        const sy = Math.sin(camYaw);

        if (opts.cameraMode === "orbit") {
          // 초원 조망 모드에서는 WASD로 카메라 주시점을 넓은 초원 위로 부드럽게 패닝!
          player.walking = false;
          player.vx = 0;
          player.vz = 0;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const panSpeed = (player.sprinting ? 22 : 13) * opts.dt;
            orbitAnchor.x = Math.max(-38, Math.min(38, orbitAnchor.x + mx * panSpeed));
            orbitAnchor.z = Math.max(-38, Math.min(38, orbitAnchor.z + mz * panSpeed));
            orbitAnchor.y = Math.max(0.5, opts.getGroundHeight(orbitAnchor.x, orbitAnchor.z)) + 0.9;
          }
        } else {
          // 3인칭 추적 모드: 부드러운 가감속 물리 이동 + 슬라이딩 장애물 충돌
          let targetVx = 0;
          let targetVz = 0;
          if (ix !== 0 || iz !== 0) {
            const len = Math.hypot(ix, iz);
            const mx = cy * (ix / len) + sy * (iz / len);
            const mz = -sy * (ix / len) + cy * (iz / len);
            const maxSpd = player.sprinting ? 9.2 : 5.6;
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
          player.walking = speedMag > 0.35;

          if (speedMag > 0.02) {
            const nx = player.x + player.vx * opts.dt;
            const nz = player.z + player.vz * opts.dt;
            const resolved = opts.resolveMovement(player.x, player.z, nx, nz, 0.52);
            player.x = resolved.x;
            player.z = resolved.z;

            if (player.onGround && player.walking && Math.random() < opts.dt * (player.sprinting ? 14 : 6)) {
              opts.onDustParticle(player.x, player.y + 0.08, player.z);
            }
          }

          if (keys.has("Space") && player.onGround) {
            player.vy = 6.8;
            player.onGround = false;
          }
        }
      } else {
        player.walking = false;
      }

      const gy = Math.max(-0.05, opts.getGroundHeight(player.x, player.z));
      player.vy -= 17.5 * opts.dt;
      player.y += player.vy * opts.dt;
      if (player.y <= gy) {
        player.y = gy;
        player.vy = 0;
        player.onGround = true;
      }

      // 카메라 주시점 보간
      const desiredTargetX = opts.cameraMode === "orbit" ? orbitAnchor.x : player.x;
      const desiredTargetY = opts.cameraMode === "orbit" ? orbitAnchor.y : player.y + 1.12;
      const desiredTargetZ = opts.cameraMode === "orbit" ? orbitAnchor.z : player.z;
      cameraTarget.x += (desiredTargetX - cameraTarget.x) * Math.min(1, opts.dt * 9.5);
      cameraTarget.y += (desiredTargetY - cameraTarget.y) * Math.min(1, opts.dt * 9.5);
      cameraTarget.z += (desiredTargetZ - cameraTarget.z) * Math.min(1, opts.dt * 9.5);

      let effDist = opts.cameraMode === "orbit" ? Math.max(28, camDist * 2.65) : camDist;
      let effPitch = opts.cameraMode === "orbit" ? Math.max(0.54, camPitch) : camPitch;
      let effYaw = camYaw;
      let effFov = 46;

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

      const cxPos = cameraTarget.x + Math.sin(effYaw) * Math.cos(effPitch) * effDist;
      const czPos = cameraTarget.z + Math.cos(effYaw) * Math.cos(effPitch) * effDist;
      const groundUnderCam = opts.getGroundHeight(cxPos, czPos);
      const cyPos = Math.max(groundUnderCam + 0.85, cameraTarget.y + Math.sin(effPitch) * effDist);

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
