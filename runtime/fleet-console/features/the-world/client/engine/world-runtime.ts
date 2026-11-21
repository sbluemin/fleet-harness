import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Matrix4,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import {
  WORLD_NOTICE_BOARD_POS,
  type WorldActorEmote,
  type WorldCameraMode,
  type WorldChoreographyCommand,
  type WorldDistrictSpec,
  type WorldInteractionMode,
  type WorldLifecycleState,
  type WorldScreenLabel,
  type WorldSnapshot,
  type WorldTimeMode,
  type WorldVillageSpec,
} from "../../shared/world-types.js";
import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import { PLUSH_VIVID_TONES } from "../../../workspace/shared/mongle-3d-glsl.js";
import { createChoreographyDirector } from "./choreography-director.js";
import { createMeadowScene } from "./meadow-scene.js";
import { createMongleActorRig, type MongleActorRig } from "./mongle-actor-rig.js";
import { createPlayerAndCameraController } from "./player-controller.js";
import { createSkyAndLighting } from "./sky-and-lighting.js";
import { playFootstep } from "./world-audio.js";

/**
 * Three.js 0.187 메인 초원 월드 런타임 (성능 최적화 + 심시티 마을·구역 연동).
 *
 * - 단일 WebGL2 MSAA 렌더 타깃(`antialias: false`로 백버퍼 중복 MSAA 제거) + `PCFShadowMap` + `DPR ≤ 1.5`
 * - 주간(`nightFactor ≤ 0.02 && !hasActiveFx()`) `UnrealBloomPass` 자동 우회 + 야간 반해상도 블룸
 * - `skyLighting.updateShadowFocus()`로 56m 심시티 마을 전역 그림자 추적
 * - 2D 라벨 좌표는 React state 대신 Direct-DOM `onFramePositions`(스크래치 재사용)로 전달해
 *   유휴·카메라 이동 중 React 리렌더를 0Hz로 유지한다.
 */

export interface WorldRenderStats {
  readonly calls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly bloomEnabled: boolean;
}

export interface WorldActorLabelMeta {
  readonly actorId: string;
  readonly name: string;
  readonly role: WorldScreenLabel["role"];
  readonly tone: WorldScreenLabel["tone"];
  readonly quaker: WorldScreenLabel["quaker"];
  readonly speech: string;
  readonly isNearPlayer: boolean;
  readonly isSelected: boolean;
  readonly needsAttention: boolean;
}

export interface WorldFrameActorPosition {
  actorId: string;
  x: number;
  y: number;
  hitX: number;
  hitY: number;
  hitRadius: number;
  distance: number;
  visible: boolean;
  isDistant: boolean;
}

export interface WorldFrameVillagePosition {
  villageId: string;
  commodoreId: string;
  x: number;
  y: number;
  distance: number;
  visible: boolean;
}

export interface WorldFramePointPosition {
  x: number;
  y: number;
  visible: boolean;
}

export interface WorldFrameOverlayPositions {
  readonly actors: readonly WorldFrameActorPosition[];
  readonly actorCount: number;
  readonly player: WorldFramePointPosition;
  readonly playerWorldX: number;
  readonly playerWorldZ: number;
  readonly playerYaw: number;
  readonly villages: readonly WorldFrameVillagePosition[];
  readonly villageCount: number;
  readonly hoveredDistrict: WorldFramePointPosition;
  readonly noticeBoard: WorldFramePointPosition;
}

export interface WorldRuntimeConfig {
  readonly canvas: HTMLCanvasElement;
  readonly getFuzz: () => number;
  readonly isReducedMotion: () => boolean;
  readonly isLowerUnfocusedFrameRate: () => boolean;
  readonly onNearActorChanged: (actorId: string | null) => void;
  /** WASD 입력 등으로 하늘 조망 모드가 자동 해제될 때 스토어와 동기화한다. */
  readonly onOverviewAutoExit?: (() => void) | undefined;
  /** 액터 라벨의 구조적 변화(목록·말풍선·근접·선택·주의 상태)가 있을 때만 호출된다(평시 0Hz). */
  readonly onLabelsStructureChanged: (labels: readonly WorldActorLabelMeta[]) => void;
  /** 매 프레임 DOM `style.transform` 직접 갱신용 스크래치 좌표 콜백(React 리렌더 0). */
  readonly onFramePositions: (positions: WorldFrameOverlayPositions) => void;
}

export interface WorldRuntimeHandle {
  applySnapshot(snapshot: WorldSnapshot): void;
  setMode(options: {
    readonly lifecycle: WorldLifecycleState;
    readonly timeMode: WorldTimeMode;
    readonly cameraMode: WorldCameraMode;
    readonly interactionMode: WorldInteractionMode;
    readonly selectedActorId: string | null;
  }): void;
  setOverviewMode(enabled: boolean): void;
  setDistrictHighlight(hovered: WorldDistrictSpec | null, selected: WorldDistrictSpec | null): void;
  setDispatchFlags(flags: readonly { readonly x: number; readonly z: number; readonly tone: IdentityTone }[]): void;
  triggerLevelUpCelebration(x: number, z: number, tone?: IdentityTone): void;
  setQuestBoardAlert(urgentCount: number): void;
  focusDistrict(district: WorldDistrictSpec | null): void;
  spawnCourierBetweenActors(fromActorId: string, targetName: string): void;
  runChoreography(cmd: WorldChoreographyCommand): boolean;
  playEmote(actorId: string, emote: WorldActorEmote): void;
  approachActor(actorId: string): void;
  teleport(x: number, z: number): void;
  pushSpeech(actorId: string, text: string): void;
  pickActorAt(clientX: number, clientY: number): string | null;
  pickDistrictAt(clientX: number, clientY: number): WorldDistrictSpec | null;
  pickVillageAt(clientX: number, clientY: number): WorldVillageSpec | null;
  pickNoticeBoardAt(clientX: number, clientY: number): boolean;
  getActorScreenAnchor(actorId: string): WorldScreenLabel | null;
  getRenderStats(): WorldRenderStats;
  dispose(): void;
}

interface ProjectedScratch {
  x: number;
  y: number;
  w: number;
}

function projectPointInto(
  worldPos: Vector3,
  viewProj: Matrix4,
  cssW: number,
  cssH: number,
  out: ProjectedScratch,
): boolean {
  const e = viewProj.elements;
  const x = worldPos.x;
  const y = worldPos.y;
  const z = worldPos.z;
  const cx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
  const cy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
  const cw = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
  if (cw <= 0.15) return false;
  out.x = ((cx / cw) * 0.5 + 0.5) * cssW;
  out.y = (0.5 - (cy / cw) * 0.5) * cssH;
  out.w = cw;
  return true;
}

const MAX_VISIBLE_VILLAGE_SIGNS = 6;
const MAX_OVERVIEW_VILLAGE_SIGNS = 16;
const MAX_VILLAGE_SIGN_DIST = 54;
const MAX_OVERVIEW_SIGN_DIST = 165;
const MAX_ACTOR_LABEL_DIST = 58;
const MAX_PLAYER_LABEL_DIST = 44;
const VIEWPORT_MARGIN_X = 160;
const VIEWPORT_MARGIN_Y = 120;
const WORKSHOP_FX_INTERVAL_SEC = 0.34;

function isInsideViewport(x: number, y: number, cssW: number, cssH: number): boolean {
  return x >= -VIEWPORT_MARGIN_X
    && x <= cssW + VIEWPORT_MARGIN_X
    && y >= -VIEWPORT_MARGIN_Y
    && y <= cssH + VIEWPORT_MARGIN_Y;
}

declare global {
  interface Window {
    __fleetWorldPerf?: (() => WorldRenderStats) | undefined;
  }
}

export function createWorldRuntime(config: WorldRuntimeConfig): WorldRuntimeHandle {
  // EffectComposer가 4x MSAA 렌더 타깃을 소유하므로 기본 백버퍼 MSAA는 비활성화해 VRAM을 절감한다.
  const renderer = new WebGLRenderer({
    canvas: config.canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.info.autoReset = false;

  const scene = new Scene();
  const camera = new PerspectiveCamera(46, 16 / 9, 0.4, 260);

  // PMREM 기반 IBL 환경맵: 돌·목재·기와·금속 PBR 재질에 은은한 하늘 반사와 깊이감을 부여한다.
  const pmremGenerator = new PMREMGenerator(renderer);
  const envRoom = new RoomEnvironment();
  const envRT = pmremGenerator.fromScene(envRoom, 0.04);
  envRoom.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.42;

  const msaaTarget = new WebGLRenderTarget(800, 600, {
    type: HalfFloatType,
    samples: 4,
    depthBuffer: true,
  });
  const composer = new EffectComposer(renderer, msaaTarget);
  composer.addPass(new RenderPass(scene, camera));
  // 주간에는 블룸 패스를 자동 우회하고, 야간/연출 시에만 반해상도로 발광체를 부드럽게 블룸시킨다.
  const bloomPass = new UnrealBloomPass(new Vector2(400, 300), 0.12, 0.42, 1.12);
  bloomPass.enabled = false;
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
  let currentVillages: readonly WorldVillageSpec[] = [];
  let currentHoveredDistrict: WorldDistrictSpec | null = null;

  let currentLifecycle: WorldLifecycleState = "diving";
  let currentTimeMode: WorldTimeMode = "day";
  let currentCameraMode: WorldCameraMode = "follow";
  let currentInteractionMode: WorldInteractionMode = "closed";
  let selectedActorId: string | null = null;
  let prevSelectedActorId: string | null = null;

  let cssWidth = 800;
  let cssHeight = 600;
  const syncSize = () => {
    const parent = config.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    cssWidth = Math.max(320, Math.floor(rect.width));
    cssHeight = Math.max(240, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssWidth, cssHeight, false);
    composer.setSize(cssWidth, cssHeight);
    bloomPass.resolution.set(Math.max(160, Math.floor(cssWidth * 0.5)), Math.max(120, Math.floor(cssHeight * 0.5)));
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
    const normalizedDelta = e.deltaMode === 1 ? e.deltaY * 18 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
    playerCtrl.onWheelZoom(normalizedDelta);
  };

  config.canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  config.canvas.addEventListener("wheel", onWheel, { passive: false });

  // rAF 제로-할당 스크래치 객체들
  const viewProj = new Matrix4();
  const tempPos = new Vector3();
  const tempTint = new Vector3();
  const playerPosVec = new Vector3();
  const commanderPosPool: Vector3[] = Array.from({ length: 16 }, () => new Vector3());
  const commanderPositions: Vector3[] = [];
  const projTop: ProjectedScratch = { x: 0, y: 0, w: 0 };
  const projBody: ProjectedScratch = { x: 0, y: 0, w: 0 };
  const raycaster = new Raycaster();
  const pickNdc = new Vector2();

  const actorPosPool: WorldFrameActorPosition[] = [];
  const villagePosPool: WorldFrameVillagePosition[] = [];
  const topVillageIdx = new Int32Array(MAX_OVERVIEW_VILLAGE_SIGNS);
  const topVillageDist = new Float64Array(MAX_OVERVIEW_VILLAGE_SIGNS);
  const framePositions: {
    actors: WorldFrameActorPosition[];
    actorCount: number;
    player: WorldFramePointPosition;
    playerWorldX: number;
    playerWorldZ: number;
    playerYaw: number;
    villages: WorldFrameVillagePosition[];
    villageCount: number;
    hoveredDistrict: WorldFramePointPosition;
    noticeBoard: WorldFramePointPosition;
  } = {
    actors: actorPosPool,
    actorCount: 0,
    player: { x: 0, y: 0, visible: false },
    playerWorldX: 0,
    playerWorldZ: 0,
    playerYaw: 0,
    villages: villagePosPool,
    villageCount: 0,
    hoveredDistrict: { x: 0, y: 0, visible: false },
    noticeBoard: { x: 0, y: 0, visible: false },
  };

  let lastStructSig = "";
  let latestLabelMetas: WorldActorLabelMeta[] = [];
  const lastRenderStats: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    bloomEnabled: boolean;
  } = { calls: 0, triangles: 0, geometries: 0, textures: 0, bloomEnabled: false };

  const getRenderStats = (): WorldRenderStats => ({ ...lastRenderStats });
  if (typeof window !== "undefined") {
    window.__fleetWorldPerf = getRenderStats;
  }

  let rafId = 0;
  let disposed = false;
  let elapsed = 0;
  let workshopFxAccum = 0;
  let prevPlayerX = playerCtrl.player.x;
  let prevPlayerZ = playerCtrl.player.z;
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

    const interacting = currentInteractionMode !== "closed";
    const focusedActorId = interacting ? selectedActorId : null;
    const focusedMotion = focusedActorId ? director.motions.get(focusedActorId) ?? null : null;

    playerCtrl.update({
      dt,
      lifecycle: currentLifecycle,
      cameraMode: currentCameraMode,
      reducedMotion: config.isReducedMotion(),
      inputLocked: interacting,
      focusActorPos: focusedMotion ? { x: focusedMotion.x, z: focusedMotion.z } : null,
      camera,
      getGroundHeight: meadow.getGroundHeight,
      resolveMovement: meadow.resolveMovement,
      onDustParticle: director.spawnDust,
      onOverviewAutoExit: config.onOverviewAutoExit,
    });

    playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
    framePositions.playerWorldX = playerCtrl.player.x;
    framePositions.playerWorldZ = playerCtrl.player.z;
    framePositions.playerYaw = playerCtrl.player.yaw;

    // 플레이어 지상 보행 발소리 (풀밭 vs 목교 구분, 오디오 내부 280ms 쿨다운)
    if (dt > 0.001) {
      const movedDist = Math.hypot(playerCtrl.player.x - prevPlayerX, playerCtrl.player.z - prevPlayerZ);
      const speed = movedDist / dt;
      if (
        currentLifecycle === "open"
        && !playerCtrl.isOverviewMode()
        && playerCtrl.player.walking
        && speed > 0.45
        && speed < 24
      ) {
        playFootstep(meadow.isOnBridge(playerCtrl.player.x, playerCtrl.player.z));
      }
    }
    prevPlayerX = playerCtrl.player.x;
    prevPlayerZ = playerCtrl.player.z;

    const nearId = director.update(
      dt,
      elapsed,
      skyLighting.nightFactor,
      playerPosVec,
      focusedActorId,
      meadow.isWalkable,
      meadow.resolveMovement,
    );
    config.onNearActorChanged(nearId);

    // 살아 움직이는 공방 FX 에미터 주기 방출 (0 할당, 단일 InstancedMesh 풀)
    workshopFxAccum += dt;
    if (workshopFxAccum >= WORKSHOP_FX_INTERVAL_SEC) {
      workshopFxAccum -= WORKSHOP_FX_INTERVAL_SEC;
      const emitters = meadow.getLiveWorkshopEmitters();
      for (let ei = 0; ei < emitters.length; ei += 1) {
        const em = emitters[ei]!;
        director.emitWorkshopFx(em.x, em.y, em.z, em.kind);
      }
    }

    commanderPositions.length = 0;
    let cmdrIdx = 0;
    for (const m of director.motions.values()) {
      if (m.spec.role === "commander") {
        let vec = commanderPosPool[cmdrIdx];
        if (!vec) {
          vec = new Vector3();
          commanderPosPool.push(vec);
        }
        vec.set(m.x, meadow.getGroundHeight(m.x, m.z), m.z);
        commanderPositions.push(vec);
        cmdrIdx += 1;
      }
    }

    // 56m 확장 심시티 마을 전역에서 그림자가 끊기지 않도록 카메라 주시점으로 텍셀 스냅 추적한다.
    skyLighting.updateShadowFocus(playerCtrl.cameraTarget.x, playerCtrl.cameraTarget.z);
    skyLighting.update(dt, elapsed, currentTimeMode, playerPosVec, commanderPositions);
    scene.environmentIntensity = 0.42 * (1 - skyLighting.nightFactor * 0.65);
    meadow.update(dt, elapsed, skyLighting.nightFactor, skyLighting.sunDir);

    const useBloom = skyLighting.nightFactor > 0.02 || director.hasActiveFx();
    bloomPass.enabled = useBloom;
    if (useBloom) {
      bloomPass.threshold = 1.12 - skyLighting.nightFactor * 0.22;
      bloomPass.strength = 0.08 + skyLighting.nightFactor * 0.26;
    }

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

    // 사령관·지휘관·구성원 포즈 갱신 & Direct-DOM 투영 좌표 계산
    const isOpen = currentLifecycle === "open";
    let actorCount = 0;
    let structSig = isOpen ? "1" : "0";
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

      if (isOpen) {
        structSig += `|${m.spec.id}:${m.spec.name}:${m.spec.tone}:${m.spec.quaker ?? ""}:${isNearPlayer ? 1 : 0}:${isSelected ? 1 : 0}:${m.spec.needsAttention ? 1 : 0}:${m.speech}`;

        let slot = actorPosPool[actorCount];
        if (!slot) {
          slot = {
            actorId: "",
            x: 0,
            y: 0,
            hitX: 0,
            hitY: 0,
            hitRadius: 26,
            distance: 999,
            visible: false,
            isDistant: false,
          };
          actorPosPool.push(slot);
        }
        slot.actorId = m.spec.id;

        tempPos.set(m.x, gy + waddle + hop + 1.62 * roleScale, m.z);
        const topOk = projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop);
        tempPos.set(m.x, gy + 0.62 * roleScale, m.z);
        const bodyOk = topOk && projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projBody);

        if (
          topOk
          && bodyOk
          && projTop.w < MAX_ACTOR_LABEL_DIST
          && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
        ) {
          slot.x = projTop.x;
          slot.y = projTop.y;
          slot.hitX = projBody.x;
          slot.hitY = projBody.y;
          slot.hitRadius = Math.max(26, 360 / projBody.w);
          slot.distance = projTop.w;
          slot.visible = true;
          slot.isDistant = projTop.w > 25
            && !isSelected
            && !isNearPlayer
            && !m.spec.needsAttention
            && m.speech.length === 0;
        } else {
          slot.visible = false;
          slot.distance = 999;
          slot.isDistant = false;
        }
        actorCount += 1;
      }
    }
    framePositions.actorCount = actorCount;

    // 구조적 변화가 발생한 프레임에만 React 라벨 메타 목록 갱신 (유휴·이동 시 0Hz)
    if (structSig !== lastStructSig) {
      lastStructSig = structSig;
      const nextMetas: WorldActorLabelMeta[] = [];
      if (isOpen) {
        for (const m of director.motions.values()) {
          if (!actorRigs.has(m.spec.id)) continue;
          nextMetas.push({
            actorId: m.spec.id,
            name: m.spec.name,
            role: m.spec.role,
            tone: m.spec.tone,
            quaker: m.spec.quaker,
            speech: m.speech,
            isNearPlayer: nearId === m.spec.id,
            isSelected: selectedActorId === m.spec.id,
            needsAttention: m.spec.needsAttention,
          });
        }
      }
      latestLabelMetas = nextMetas;
      config.onLabelsStructureChanged(nextMetas);
    }

    // 플레이어 라벨 투영 (하늘 조망 모드에서는 숨김)
    const inOverview = playerCtrl.isOverviewMode();
    if (isOpen && !inOverview && currentCameraMode === "follow" && currentInteractionMode === "closed") {
      tempPos.set(p.x, p.y + pHop + 1.54, p.z);
      if (
        projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
        && projTop.w < MAX_PLAYER_LABEL_DIST
        && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
      ) {
        framePositions.player.x = projTop.x;
        framePositions.player.y = projTop.y;
        framePositions.player.visible = true;
      } else {
        framePositions.player.visible = false;
      }
    } else {
      framePositions.player.visible = false;
    }

    // 근접 사령관 마을 푯말 투영 (일반: 가까운 최대 6개 / 하늘 조망: 전 마을 최대 16개)
    const vLen = isOpen ? currentVillages.length : 0;
    framePositions.villageCount = vLen;
    if (vLen > 0) {
      const signLimit = inOverview ? MAX_OVERVIEW_VILLAGE_SIGNS : MAX_VISIBLE_VILLAGE_SIGNS;
      const signMaxDist = inOverview ? MAX_OVERVIEW_SIGN_DIST : MAX_VILLAGE_SIGN_DIST;
      topVillageIdx.fill(-1);
      topVillageDist.fill(signMaxDist);

      for (let i = 0; i < vLen; i += 1) {
        const v = currentVillages[i]!;
        let slot = villagePosPool[i];
        if (!slot) {
          slot = { villageId: "", commodoreId: "", x: 0, y: 0, distance: 999, visible: false };
          villagePosPool.push(slot);
        }
        slot.villageId = v.id;
        slot.commodoreId = v.commodoreId;
        slot.visible = false;

        // 하늘 조망에서는 마을 중심 상단, 일반 시점에서는 마을 입구 게이트 상단에 푯말 배치
        const signX = inOverview ? v.x : v.x + Math.cos(v.gateAngle) * (v.radius * 0.84);
        const signZ = inOverview ? v.z : v.z + Math.sin(v.gateAngle) * (v.radius * 0.84);
        const signY = meadow.getGroundHeight(signX, signZ) + (inOverview ? 4.4 : 3.45);
        tempPos.set(signX, signY, signZ);

        if (
          projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
          && projTop.w < signMaxDist
          && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
        ) {
          slot.x = projTop.x;
          slot.y = projTop.y;
          slot.distance = projTop.w;
          const d = projTop.w;
          const lastSlot = signLimit - 1;
          if (d < topVillageDist[lastSlot]!) {
            let pos = lastSlot;
            while (pos > 0 && d < topVillageDist[pos - 1]!) {
              topVillageDist[pos] = topVillageDist[pos - 1]!;
              topVillageIdx[pos] = topVillageIdx[pos - 1]!;
              pos -= 1;
            }
            topVillageDist[pos] = d;
            topVillageIdx[pos] = i;
          }
        } else {
          slot.distance = 999;
        }
      }

      for (let k = 0; k < signLimit; k += 1) {
        const vi = topVillageIdx[k]!;
        if (vi >= 0) villagePosPool[vi]!.visible = true;
      }
    }

    // 호버 중인 Theater 구역 미니 툴팁 투영
    if (isOpen && currentHoveredDistrict && currentInteractionMode === "closed") {
      const d = currentHoveredDistrict;
      const dgy = meadow.getGroundHeight(d.x, d.z);
      tempPos.set(d.x, dgy + 2.4 + d.tier * 0.32, d.z);
      if (
        projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
        && projTop.w < (inOverview ? 175 : 72)
        && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
      ) {
        framePositions.hoveredDistrict.x = projTop.x;
        framePositions.hoveredDistrict.y = projTop.y;
        framePositions.hoveredDistrict.visible = true;
      } else {
        framePositions.hoveredDistrict.visible = false;
      }
    } else {
      framePositions.hoveredDistrict.visible = false;
    }

    // 중앙 광장 3D 길드 퀘스트 게시판 푯말 투영 (Direct-DOM 0Hz)
    if (isOpen && currentInteractionMode === "closed") {
      const nbX = WORLD_NOTICE_BOARD_POS.x;
      const nbZ = WORLD_NOTICE_BOARD_POS.z;
      const nbY = meadow.getGroundHeight(nbX, nbZ) + 2.75;
      tempPos.set(nbX, nbY, nbZ);
      if (
        projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
        && projTop.w < (inOverview ? 165 : 48)
        && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
      ) {
        framePositions.noticeBoard.x = projTop.x;
        framePositions.noticeBoard.y = projTop.y;
        framePositions.noticeBoard.visible = true;
      } else {
        framePositions.noticeBoard.visible = false;
      }
    } else {
      framePositions.noticeBoard.visible = false;
    }

    renderer.info.reset();
    composer.render();
    lastRenderStats.calls = renderer.info.render.calls;
    lastRenderStats.triangles = renderer.info.render.triangles;
    lastRenderStats.geometries = renderer.info.memory.geometries;
    lastRenderStats.textures = renderer.info.memory.textures;
    lastRenderStats.bloomEnabled = useBloom;

    config.onFramePositions(framePositions);
  };

  rafId = requestAnimationFrame(tick);

  return {
    applySnapshot(snapshot) {
      currentVillages = snapshot.villages;
      meadow.syncZones(snapshot.zones, snapshot.villages);
      skyLighting.setStreetlampAnchors(meadow.streetlampAnchors);
      director.syncActors(snapshot.actors);
      director.syncVillagePatrols(snapshot.villages);

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
      currentInteractionMode = opts.interactionMode;
      selectedActorId = opts.selectedActorId;
      if (opts.selectedActorId && opts.selectedActorId !== prevSelectedActorId) {
        const targetMotion = director.motions.get(opts.selectedActorId);
        if (targetMotion && opts.cameraMode === "orbit") {
          playerCtrl.focusOrbitOn(targetMotion.x, targetMotion.z, meadow.getGroundHeight);
        }
      }
      prevSelectedActorId = opts.selectedActorId;
    },
    setOverviewMode(enabled) {
      playerCtrl.setOverviewMode(enabled);
    },
    setDistrictHighlight(hovered, selected) {
      currentHoveredDistrict = hovered;
      meadow.setDistrictHighlight(hovered, selected);
    },
    setDispatchFlags(flags) {
      meadow.setDispatchFlags(flags);
    },
    triggerLevelUpCelebration(x, z, tone) {
      let colorHex = 0xfbbf24;
      if (tone) {
        const rgb = PLUSH_VIVID_TONES[tone];
        colorHex = (Math.round(rgb[0] * 255) << 16)
          | (Math.round(rgb[1] * 255) << 8)
          | Math.round(rgb[2] * 255);
      }
      director.spawnLevelUpCelebration(x, z, colorHex);
    },
    setQuestBoardAlert(urgentCount) {
      meadow.setQuestBoardAlert(urgentCount);
    },
    focusDistrict(district) {
      if (district) {
        playerCtrl.focusDistrict(district.x, district.z, district.radius, meadow.getGroundHeight);
      } else {
        playerCtrl.clearDistrictFocus();
      }
    },
    spawnCourierBetweenActors(fromActorId, targetName) {
      const trimmedTarget = targetName.trim().toLowerCase();
      if (!trimmedTarget) return;

      const fromMotion = director.motions.get(fromActorId);
      let fromX = fromMotion?.x ?? 0;
      let fromZ = fromMotion?.z ?? 0;
      let colorHex = 0x38bdf8;
      if (fromMotion) {
        const rgb = PLUSH_VIVID_TONES[fromMotion.spec.tone];
        colorHex = (Math.round(rgb[0] * 255) << 16)
          | (Math.round(rgb[1] * 255) << 8)
          | Math.round(rgb[2] * 255);
      }

      // 수신 대상 액터 또는 마을 좌표 탐색
      let toX: number | null = null;
      let toZ: number | null = null;
      for (const m of director.motions.values()) {
        if (m.spec.id === fromActorId) continue;
        const lower = m.spec.name.toLowerCase();
        if (lower === trimmedTarget || lower.includes(trimmedTarget) || trimmedTarget.includes(lower)) {
          toX = m.x;
          toZ = m.z;
          break;
        }
      }
      if (toX === null || toZ === null) {
        for (const v of currentVillages) {
          const lower = v.label.toLowerCase();
          if (lower === trimmedTarget || lower.includes(trimmedTarget) || trimmedTarget.includes(lower)) {
            toX = v.x;
            toZ = v.z;
            break;
          }
        }
      }
      if (toX === null || toZ === null) return;
      director.spawnCourierArc(fromX, fromZ, toX, toZ, colorHex);
    },
    runChoreography(cmd) {
      return director.handleCommand(cmd);
    },
    playEmote(actorId, emote) {
      playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
      director.playEmote(actorId, emote, playerPosVec);
    },
    approachActor(actorId) {
      const targetMotion = director.motions.get(actorId);
      if (!targetMotion) return;
      playerCtrl.approachPoint(targetMotion.x, targetMotion.z, meadow.getGroundHeight, meadow.resolveMovement);
      director.spawnBurst(
        playerCtrl.player.x,
        meadow.getGroundHeight(playerCtrl.player.x, playerCtrl.player.z) + 0.9,
        playerCtrl.player.z,
        0x38bdf8,
        12,
      );
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
      for (let i = 0; i < framePositions.actorCount; i += 1) {
        const lbl = actorPosPool[i]!;
        if (!lbl.visible) continue;
        if (Math.hypot(mx - lbl.hitX, my - lbl.hitY) <= lbl.hitRadius) {
          return lbl.actorId;
        }
      }
      return null;
    },
    pickDistrictAt(clientX, clientY) {
      if (currentVillages.length === 0) return null;
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      pickNdc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      if (Math.abs(direction.y) < 1e-4) return null;

      // Zero-Mesh 2단 지면 평면 교차 근사 (1차 평균 마을 높이 → 2차 실제 지형 높이 보정)
      const t0 = (0.46 - origin.y) / direction.y;
      if (t0 <= 0 || t0 > 240) return null;
      const wx0 = origin.x + direction.x * t0;
      const wz0 = origin.z + direction.z * t0;
      const gy = meadow.getGroundHeight(wx0, wz0);
      const t1 = (gy - origin.y) / direction.y;
      if (t1 <= 0 || t1 > 240) return null;
      const wx = origin.x + direction.x * t1;
      const wz = origin.z + direction.z * t1;

      let best: WorldDistrictSpec | null = null;
      let bestDist = Infinity;
      for (let vi = 0; vi < currentVillages.length; vi += 1) {
        const v = currentVillages[vi]!;
        // 마을 바운딩 원 빠른 사전 필터링
        const vd = Math.hypot(wx - v.x, wz - v.z);
        if (vd > v.radius + 4.5) continue;
        for (let di = 0; di < v.districts.length; di += 1) {
          const d = v.districts[di]!;
          const dist = Math.hypot(wx - d.x, wz - d.z);
          if (dist <= d.radius + 0.55 && dist < bestDist) {
            bestDist = dist;
            best = d;
          }
        }
      }
      return best;
    },
    pickVillageAt(clientX, clientY) {
      if (currentVillages.length === 0) return null;
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      pickNdc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      if (Math.abs(direction.y) < 1e-4) return null;

      const t0 = (0.46 - origin.y) / direction.y;
      if (t0 <= 0 || t0 > 240) return null;
      const wx = origin.x + direction.x * t0;
      const wz = origin.z + direction.z * t0;

      let best: WorldVillageSpec | null = null;
      let bestDist = Infinity;
      for (let vi = 0; vi < currentVillages.length; vi += 1) {
        const v = currentVillages[vi]!;
        const vd = Math.hypot(wx - v.x, wz - v.z);
        if (vd <= v.radius + 1.5 && vd < bestDist) {
          bestDist = vd;
          best = v;
        }
      }
      return best;
    },
    pickNoticeBoardAt(clientX, clientY) {
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const mx = clientX - rect.left;
      const my = clientY - rect.top;

      // 1. 3D 게시판 상단 푯말/본체 화면 투영 근접 피킹
      if (framePositions.noticeBoard.visible) {
        if (Math.hypot(mx - framePositions.noticeBoard.x, my - (framePositions.noticeBoard.y + 34)) <= 56) {
          return true;
        }
      }

      // 2. Zero-Mesh 지면 평면 교차 피킹
      pickNdc.set(
        (mx / rect.width) * 2 - 1,
        -(my / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      if (Math.abs(direction.y) < 1e-4) return false;

      const nbY = meadow.getGroundHeight(WORLD_NOTICE_BOARD_POS.x, WORLD_NOTICE_BOARD_POS.z) + 1.1;
      const t = (nbY - origin.y) / direction.y;
      if (t <= 0 || t > 220) return false;
      const wx = origin.x + direction.x * t;
      const wz = origin.z + direction.z * t;
      return Math.hypot(wx - WORLD_NOTICE_BOARD_POS.x, wz - WORLD_NOTICE_BOARD_POS.z) <= WORLD_NOTICE_BOARD_POS.radius + 0.4;
    },
    getActorScreenAnchor(actorId) {
      const meta = latestLabelMetas.find((m) => m.actorId === actorId);
      if (!meta) return null;
      for (let i = 0; i < framePositions.actorCount; i += 1) {
        const pos = actorPosPool[i]!;
        if (pos.actorId === actorId && pos.visible) {
          return {
            ...meta,
            x: pos.x,
            y: pos.y,
            hitX: pos.hitX,
            hitY: pos.hitY,
            hitRadius: pos.hitRadius,
            distance: pos.distance,
          };
        }
      }
      return null;
    },
    getRenderStats,
    dispose() {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (typeof window !== "undefined" && window.__fleetWorldPerf === getRenderStats) {
        delete window.__fleetWorldPerf;
      }
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
      envRT.dispose();
      pmremGenerator.dispose();
      msaaTarget.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
}
