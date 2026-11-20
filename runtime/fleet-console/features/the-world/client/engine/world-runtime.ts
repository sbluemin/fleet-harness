import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Matrix4,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import type {
  WorldCameraMode,
  WorldChoreographyCommand,
  WorldLifecycleState,
  WorldPlayerScreenLabel,
  WorldScreenLabel,
  WorldSnapshot,
  WorldTimeMode,
} from "../../shared/world-types.js";
import { createChoreographyDirector } from "./choreography-director.js";
import { createMeadowScene } from "./meadow-scene.js";
import { createMongleActorRig, type MongleActorRig } from "./mongle-actor-rig.js";
import { createPlayerAndCameraController } from "./player-controller.js";
import { createSkyAndLighting } from "./sky-and-lighting.js";

/**
 * Three.js 0.187 메인 초원 월드 런타임.
 *
 * WebGL2 MSAA 렌더 타깃 + `PCFSoftShadowMap`(2048px) + 주간 블룸 번짐 억제형 `UnrealBloomPass` + `OutputPass`(ACES Filmic)를 조합하며,
 * 탭 숨김·비포커스 감속(`lowerUnfocusedFrameRate`)·모션 감속(`reducedMotion`) 계약을 모두 준수한다.
 */

export interface WorldRuntimeConfig {
  readonly canvas: HTMLCanvasElement;
  readonly getFuzz: () => number;
  readonly isReducedMotion: () => boolean;
  readonly isLowerUnfocusedFrameRate: () => boolean;
  readonly onNearActorChanged: (actorId: string | null) => void;
  readonly onFrameOverlay: (
    labels: readonly WorldScreenLabel[],
    playerLabel: WorldPlayerScreenLabel | null,
  ) => void;
}

export interface WorldRuntimeHandle {
  applySnapshot(snapshot: WorldSnapshot): void;
  setMode(options: {
    readonly lifecycle: WorldLifecycleState;
    readonly timeMode: WorldTimeMode;
    readonly cameraMode: WorldCameraMode;
    readonly selectedActorId: string | null;
  }): void;
  runChoreography(cmd: WorldChoreographyCommand): void;
  teleport(x: number, z: number): void;
  pushSpeech(actorId: string, text: string): void;
  pickActorAt(clientX: number, clientY: number): string | null;
  dispose(): void;
}

function projectPoint(worldPos: Vector3, viewProj: Matrix4, cssW: number, cssH: number) {
  const e = viewProj.elements;
  const x = worldPos.x;
  const y = worldPos.y;
  const z = worldPos.z;
  const cx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
  const cy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
  const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
  if (cw <= 0.15) return null;
  return {
    x: ((cx / cw) * 0.5 + 0.5) * cssW,
    y: (0.5 - (cy / cw) * 0.5) * cssH,
    w: cw,
  };
}

export function createWorldRuntime(config: WorldRuntimeConfig): WorldRuntimeHandle {
  const renderer = new WebGLRenderer({
    canvas: config.canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(46, 16 / 9, 0.4, 220);

  const msaaTarget = new WebGLRenderTarget(800, 600, {
    type: HalfFloatType,
    samples: 4,
    depthBuffer: true,
  });
  const composer = new EffectComposer(renderer, msaaTarget);
  composer.addPass(new RenderPass(scene, camera));
  // 주간에는 흰 모자/구름이 번지지 않도록 threshold > 1.0으로 두고, 야간에 발광체만 은은히 블룸시킨다.
  const bloomPass = new UnrealBloomPass(new Vector2(800, 600), 0.12, 0.42, 1.12);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  const skyLighting = createSkyAndLighting(scene);
  const meadow = createMeadowScene(scene);
  const playerCtrl = createPlayerAndCameraController();
  const director = createChoreographyDirector(scene);

  // 플레이어 제독 3D 아바타 (진급 퀘이커 도리 Dori)
  const playerRig = createMongleActorRig({
    baseId: 18,
    shape: "egg",
    tone: "cerulean",
    quaker: "dori",
    role: "commodore",
    scale: 0.92,
  });
  scene.add(playerRig.group);

  const actorRigs = new Map<string, { sig: string; rig: MongleActorRig }>();

  let currentLifecycle: WorldLifecycleState = "diving";
  let currentTimeMode: WorldTimeMode = "day";
  let currentCameraMode: WorldCameraMode = "follow";
  let selectedActorId: string | null = null;
  let prevSelectedActorId: string | null = null;
  let latestLabels: WorldScreenLabel[] = [];

  let cssWidth = 800;
  let cssHeight = 600;
  const syncSize = () => {
    const parent = config.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    cssWidth = Math.max(320, Math.floor(rect.width));
    cssHeight = Math.max(240, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssWidth, cssHeight, false);
    composer.setSize(cssWidth, cssHeight);
    bloomPass.resolution.set(cssWidth, cssHeight);
    camera.aspect = cssWidth / cssHeight;
    camera.updateProjectionMatrix();
  };
  syncSize();
  const resizeObserver = new ResizeObserver(syncSize);
  if (config.canvas.parentElement) resizeObserver.observe(config.canvas.parentElement);

  // 포인터 회전 & 휠 줌 바인딩
  let dragging = false;
  let lx = 0;
  let ly = 0;
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    playerCtrl.onPointerRotate(e.clientX - lx, e.clientY - ly);
    lx = e.clientX;
    ly = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    playerCtrl.onWheelZoom(e.deltaY);
  };

  config.canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  config.canvas.addEventListener("wheel", onWheel, { passive: false });

  const viewProj = new Matrix4();
  const tempPos = new Vector3();
  const tempTint = new Vector3();
  const playerPosVec = new Vector3();
  const commanderPositions: Vector3[] = [];

  let rafId = 0;
  let disposed = false;
  let elapsed = 0;
  let prevNow = performance.now();
  let lastRenderNow = 0;

  const tick = (now: number) => {
    if (disposed) return;
    rafId = requestAnimationFrame(tick);
    if (document.hidden || currentLifecycle === "closed") {
      prevNow = now;
      return;
    }
    if (config.isLowerUnfocusedFrameRate() && !document.hasFocus() && now - lastRenderNow < 80) {
      return;
    }
    lastRenderNow = now;

    const dt = Math.min(0.05, (now - prevNow) * 0.001);
    prevNow = now;
    elapsed += dt;

    playerCtrl.update({
      dt,
      lifecycle: currentLifecycle,
      cameraMode: currentCameraMode,
      reducedMotion: config.isReducedMotion(),
      camera,
      getGroundHeight: meadow.getGroundHeight,
      resolveMovement: meadow.resolveMovement,
      onDustParticle: director.spawnDust,
    });

    playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
    const nearId = director.update(
      dt,
      elapsed,
      skyLighting.nightFactor,
      playerPosVec,
      meadow.isWalkable,
      meadow.resolveMovement,
    );
    config.onNearActorChanged(nearId);

    commanderPositions.length = 0;
    for (const m of director.motions.values()) {
      if (m.spec.role === "commander") {
        commanderPositions.push(new Vector3(m.x, meadow.getGroundHeight(m.x, m.z), m.z));
      }
    }

    skyLighting.update(dt, elapsed, currentTimeMode, playerPosVec, commanderPositions);
    meadow.update(elapsed, skyLighting.nightFactor, skyLighting.sunDir);
    bloomPass.threshold = 1.12 - skyLighting.nightFactor * 0.22;
    bloomPass.strength = 0.08 + skyLighting.nightFactor * 0.26;

    camera.updateMatrixWorld();
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    const fuzz = config.getFuzz();

    // 플레이어 아바타 포즈 갱신
    const p = playerCtrl.player;
    const pGround = Math.max(-0.05, meadow.getGroundHeight(p.x, p.z));
    const pHop = p.walking ? Math.abs(Math.sin(elapsed * (p.sprinting ? 15 : 10))) * 0.16 : 0;
    const fireWarmP = Math.max(0, 1 - Math.hypot(p.x - 2.8, p.z - 1.0) / 8.0) * skyLighting.nightFactor * 0.55;
    tempTint.set(
      skyLighting.avatarWorldTint.x + fireWarmP * 0.65,
      skyLighting.avatarWorldTint.y + fireWarmP * 0.32,
      skyLighting.avatarWorldTint.z + fireWarmP * 0.05,
    );
    playerRig.updatePose({
      x: p.x,
      groundY: pGround,
      liftY: (p.y - pGround) + pHop,
      z: p.z,
      yaw: p.yaw,
      state: p.walking ? "running" : "idle",
      activity: p.sprinting ? "run" : null,
      carrying: false,
      needsAttention: false,
      elapsed,
      fuzz,
      sunDir: skyLighting.sunDir,
      worldTint: tempTint,
      viewProj,
    });

    // 사령관·지휘관·구성원 포즈 & 화면 라벨 갱신
    const nextLabels: WorldScreenLabel[] = [];
    let idx = 0;
    for (const m of director.motions.values()) {
      idx += 1;
      const entry = actorRigs.get(m.spec.id);
      if (!entry) continue;
      const gy = Math.max(-0.05, meadow.getGroundHeight(m.x, m.z));
      const roleScale = m.spec.role === "commodore" ? 0.96 : m.spec.role === "commander" ? 0.82 : 0.70;
      const waddle = m.moving ? Math.abs(Math.sin(elapsed * 11 + idx)) * 0.14 : 0;
      const hop = m.hopBoost * Math.abs(Math.sin(elapsed * 10)) * 0.48
        + (director.celebratingTimer > 0 ? Math.abs(Math.sin(elapsed * 9 + idx)) * 0.40 : 0);

      const fireWarm = Math.max(0, 1 - Math.hypot(m.x - 2.8, m.z - 1.0) / 8.0) * skyLighting.nightFactor * 0.55;
      tempTint.set(
        skyLighting.avatarWorldTint.x + fireWarm * 0.65,
        skyLighting.avatarWorldTint.y + fireWarm * 0.32,
        skyLighting.avatarWorldTint.z + fireWarm * 0.05,
      );

      const isSelected = selectedActorId === m.spec.id;
      const isNearPlayer = nearId === m.spec.id;

      entry.rig.updatePose({
        x: m.x,
        groundY: gy,
        liftY: waddle + hop,
        z: m.z,
        yaw: m.yaw + (director.celebratingTimer > 0 ? elapsed * 4.5 : 0),
        state: m.spec.state,
        activity: m.spec.activity,
        carrying: m.carrying,
        needsAttention: m.spec.needsAttention,
        isSelected,
        isNearPlayer,
        elapsed,
        fuzz,
        sunDir: skyLighting.sunDir,
        worldTint: tempTint,
        viewProj,
      });

      if (currentLifecycle === "open") {
        tempPos.set(m.x, gy + waddle + hop + 1.62 * roleScale, m.z);
        const topProj = projectPoint(tempPos, viewProj, cssWidth, cssHeight);
        tempPos.set(m.x, gy + 0.62 * roleScale, m.z);
        const bodyProj = projectPoint(tempPos, viewProj, cssWidth, cssHeight);

        if (topProj && bodyProj && topProj.w < 58) {
          nextLabels.push({
            actorId: m.spec.id,
            name: m.spec.name,
            role: m.spec.role,
            tone: m.spec.tone,
            quaker: m.spec.quaker,
            x: topProj.x,
            y: topProj.y,
            hitX: bodyProj.x,
            hitY: bodyProj.y,
            hitRadius: Math.max(26, 360 / bodyProj.w),
            distance: topProj.w,
            speech: m.speech,
            isNearPlayer,
            isSelected,
            needsAttention: m.spec.needsAttention,
          });
        }
      }
    }

    latestLabels = nextLabels;
    let playerScreen: WorldPlayerScreenLabel | null = null;
    if (currentLifecycle === "open" && currentCameraMode === "follow") {
      tempPos.set(p.x, p.y + pHop + 1.54, p.z);
      const pp = projectPoint(tempPos, viewProj, cssWidth, cssHeight);
      if (pp && pp.w < 44) {
        playerScreen = { x: pp.x, y: pp.y, label: "나 (제독)" };
      }
    }

    composer.render();
    config.onFrameOverlay(nextLabels, playerScreen);
  };

  rafId = requestAnimationFrame(tick);

  return {
    applySnapshot(snapshot) {
      meadow.syncZones(snapshot.zones);
      skyLighting.setStreetlampAnchors(meadow.streetlampAnchors);
      director.syncActors(snapshot.actors);

      const validIds = new Set(snapshot.actors.map((a) => a.id));
      for (const [id, entry] of [...actorRigs.entries()]) {
        if (!validIds.has(id)) {
          scene.remove(entry.rig.group);
          entry.rig.dispose();
          actorRigs.delete(id);
        }
      }

      for (const spec of snapshot.actors) {
        const roleScale = spec.role === "commodore" ? 0.96 : spec.role === "commander" ? 0.82 : 0.70;
        const sig = `${spec.baseId}:${spec.shape}:${spec.tone}:${spec.quaker ?? ""}:${spec.role}`;
        const existing = actorRigs.get(spec.id);
        if (existing && existing.sig === sig) continue;
        if (existing) {
          scene.remove(existing.rig.group);
          existing.rig.dispose();
        }
        const rig = createMongleActorRig({
          baseId: spec.baseId,
          shape: spec.shape,
          tone: spec.tone,
          quaker: spec.quaker,
          role: spec.role,
          scale: roleScale,
        });
        scene.add(rig.group);
        actorRigs.set(spec.id, { sig, rig });
      }
    },
    setMode(opts) {
      currentLifecycle = opts.lifecycle;
      currentTimeMode = opts.timeMode;
      currentCameraMode = opts.cameraMode;
      selectedActorId = opts.selectedActorId;
      if (opts.selectedActorId && opts.selectedActorId !== prevSelectedActorId) {
        const targetMotion = director.motions.get(opts.selectedActorId);
        if (targetMotion && opts.cameraMode === "orbit") {
          playerCtrl.focusOrbitOn(targetMotion.x, targetMotion.z, meadow.getGroundHeight);
        }
      }
      prevSelectedActorId = opts.selectedActorId;
    },
    runChoreography(cmd) {
      director.handleCommand(cmd);
    },
    teleport(x, z) {
      playerCtrl.teleportTo(x, z, meadow.getGroundHeight, meadow.resolveMovement);
      director.spawnBurst(
        playerCtrl.player.x,
        meadow.getGroundHeight(playerCtrl.player.x, playerCtrl.player.z) + 1.0,
        playerCtrl.player.z,
        0x38bdf8,
        14,
      );
    },
    pushSpeech(actorId, text) {
      director.applySpeech(actorId, text);
    },
    pickActorAt(clientX, clientY) {
      const rect = config.canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      for (const lbl of latestLabels) {
        if (Math.hypot(mx - lbl.hitX, my - lbl.hitY) <= lbl.hitRadius) {
          return lbl.actorId;
        }
      }
      return null;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      config.canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      config.canvas.removeEventListener("wheel", onWheel);
      for (const entry of actorRigs.values()) {
        scene.remove(entry.rig.group);
        entry.rig.dispose();
      }
      actorRigs.clear();
      playerRig.dispose();
      director.dispose();
      playerCtrl.dispose();
      meadow.dispose();
      skyLighting.dispose();
      msaaTarget.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
}
