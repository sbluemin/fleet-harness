import {
  ACESFilmicToneMapping,
  CircleGeometry,
  DynamicDrawUsage,
  GLSL3,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
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
  WORLD_CAMPFIRE_BENCH_POS,
  WORLD_GUILD_HALL_POS,
  WORLD_NOTICE_BOARD_POS,
  type WorldActorEmote,
  type WorldAdmiralHat,
  type WorldCameraMode,
  type WorldChoreographyCommand,
  type WorldDistrictSpec,
  type WorldInteractionMode,
  type WorldLifecycleState,
  type WorldPlayerEmote,
  type WorldScreenLabel,
  type WorldSnapshot,
  type WorldTimeMode,
  type WorldVillageSpec,
  type WorldWeatherMode,
} from "../../shared/world-types.js";
import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import { PLUSH_VIVID_TONES } from "../../../workspace/shared/mongle-3d-glsl.js";
import { createChoreographyDirector } from "./choreography-director.js";
import { createMeadowScene } from "./meadow-scene.js";
import {
  createMongleActorRig,
  type MongleActorRig,
  type WorldAnimMode,
  type WorldExpression,
} from "./mongle-actor-rig.js";
import {
  createPlayerAndCameraController,
  type CameraFocusFraming,
  type CameraOccluder,
} from "./player-controller.js";
import { createSkyAndLighting } from "./sky-and-lighting.js";
import {
  playFootstep,
  playJump,
  playMongleChirp,
  playRallyHorn,
  setRainAmbience,
  type WorldFootstepSurface,
} from "./world-audio.js";

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
  /** 거리·포커스 기반 2D 라벨 불투명도 LOD (0.38..1.0). */
  opacity?: number;
  /** 거리·포커스 기반 2D 라벨 스케일 LOD (0.84..1.0). */
  scale?: number;
  /** 말풍선과 상호작용 힌트 겹침 방지 수직 오프셋(px). */
  speechOffsetY?: number;
}

export interface WorldFrameMinimapActor {
  id: string;
  x: number;
  z: number;
  color: string;
  walking: boolean;
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
  readonly minimapActors: readonly WorldFrameMinimapActor[];
  readonly player: WorldFramePointPosition;
  readonly playerWorldX: number;
  readonly playerWorldZ: number;
  readonly playerYaw: number;
  readonly villages: readonly WorldFrameVillagePosition[];
  readonly villageCount: number;
  readonly hoveredDistrict: WorldFramePointPosition;
  readonly noticeBoard: WorldFramePointPosition;
  readonly guildHall: WorldFramePointPosition;
  readonly campfireBench: WorldFramePointPosition;
}

export interface WorldRuntimeConfig {
  readonly canvas: HTMLCanvasElement;
  readonly getFuzz: () => number;
  readonly isReducedMotion: () => boolean;
  readonly isLowerUnfocusedFrameRate: () => boolean;
  readonly onNearActorChanged: (actorId: string | null) => void;
  /** WASD 입력 등으로 하늘 조망 모드가 자동 해제될 때 스토어와 동기화한다. */
  readonly onOverviewAutoExit?: (() => void) | undefined;
  /** 모닥불 벤치 불멍 중 WASD/Space로 자동 기상할 때 스토어와 동기화한다. */
  readonly onCampfireStandUp?: (() => void) | undefined;
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
  setWeather(mode: WorldWeatherMode): void;
  triggerRainbow(durationSec?: number): void;
  setAdmiralStyle(tone: IdentityTone, hat: WorldAdmiralHat): void;
  setCustomizerMode(open: boolean): void;
  triggerCustomizerPreviewBounce(): void;
  setCampfireSit(sitting: boolean): void;
  rallyAllToPlaza(): void;
  playPlayerEmote(emote: WorldPlayerEmote): void;
  setDistrictHighlight(hovered: WorldDistrictSpec | null, selected: WorldDistrictSpec | null): void;
  setDispatchFlags(flags: readonly { readonly x: number; readonly z: number; readonly tone: IdentityTone }[]): void;
  setDistrictNotePins(pins: readonly { readonly x: number; readonly z: number }[]): void;
  triggerLevelUpCelebration(x: number, z: number, tone?: IdentityTone): void;
  setQuestBoardAlert(urgentCount: number): void;
  focusDistrict(district: WorldDistrictSpec | null): void;
  spawnCourierBetweenActors(fromActorId: string, targetName: string): void;
  spawnCourierBetweenVillages(fromVillage: WorldVillageSpec, toVillage: WorldVillageSpec): void;
  runChoreography(cmd: WorldChoreographyCommand): boolean;
  playEmote(actorId: string, emote: WorldActorEmote): void;
  approachActor(actorId: string): void;
  teleport(x: number, z: number): void;
  pushSpeech(actorId: string, text: string): void;
  pickActorAt(clientX: number, clientY: number): string | null;
  pickDistrictAt(clientX: number, clientY: number): WorldDistrictSpec | null;
  pickVillageAt(clientX: number, clientY: number): WorldVillageSpec | null;
  pickNoticeBoardAt(clientX: number, clientY: number): boolean;
  pickGuildHallAt(clientX: number, clientY: number): boolean;
  pickCampfireBenchAt(clientX: number, clientY: number): boolean;
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
const TOP_SIGN_SAFE_Y = 54;
const TOP_ACTOR_LABEL_SAFE_Y = 44;
const WORKSHOP_FX_INTERVAL_SEC = 0.34;
const MAX_ACTOR_AO_BLOBS = 64;
const EMPTY_OCCLUDERS: readonly CameraOccluder[] = [];

const TONE_HEX_CSS: Readonly<Record<IdentityTone, string>> = {
  crimson: "#fb7185",
  amber: "#fbbf24",
  moss: "#84cc16",
  teal: "#2dd4bf",
  cerulean: "#38bdf8",
  indigo: "#818cf8",
  plum: "#c084fc",
  rose: "#f472b6",
};

const AO_BLOB_VERTEX = /* glsl */ `
attribute float aOpacity;
out vec2 vUv;
out float vOpacity;
void main() {
  vUv = uv;
  vOpacity = aOpacity;
  vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;
}
`;

const AO_BLOB_FRAGMENT = /* glsl */ `
in vec2 vUv;
in float vOpacity;
out vec4 fragColor;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.1) * vOpacity;
  if (a < 0.004) discard;
  fragColor = vec4(0.02, 0.05, 0.03, a);
}
`;

type MeadowSceneS8 = ReturnType<typeof createMeadowScene> & {
  getSurfaceType?: ((x: number, z: number) => WorldFootstepSurface) | undefined;
  getCameraOccluders?: (() => readonly CameraOccluder[]) | undefined;
};

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
  const meadow = createMeadowScene(scene) as MeadowSceneS8;
  const playerCtrl = createPlayerAndCameraController();
  const director = createChoreographyDirector(scene);

  // 플레이어 + 모든 액터 발밑 배치 Soft AO 접촉 그림자 (단일 InstancedMesh 1 draw call, 점프 높이 반응)
  const aoBlobGeo = new CircleGeometry(0.86, 24);
  aoBlobGeo.rotateX(-Math.PI * 0.5);
  const aoOpacityArray = new Float32Array(MAX_ACTOR_AO_BLOBS);
  const aoOpacityAttr = new InstancedBufferAttribute(aoOpacityArray, 1);
  aoOpacityAttr.setUsage(DynamicDrawUsage);
  aoBlobGeo.setAttribute("aOpacity", aoOpacityAttr);
  const aoBlobMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    vertexShader: AO_BLOB_VERTEX,
    fragmentShader: AO_BLOB_FRAGMENT,
  });
  const aoBlobInstanced = new InstancedMesh(aoBlobGeo, aoBlobMat, MAX_ACTOR_AO_BLOBS);
  aoBlobInstanced.instanceMatrix.setUsage(DynamicDrawUsage);
  aoBlobInstanced.frustumCulled = false;
  aoBlobInstanced.renderOrder = 2;
  aoBlobInstanced.count = 0;
  scene.add(aoBlobInstanced);

  const aoMat4 = new Matrix4();
  const aoPos = new Vector3();
  const aoQuat = new Quaternion();
  const aoScale = new Vector3();

  // 플레이어 제독 3D 아바타 (⭐ 노란 통통 별빛 몽글이 — 도리는 사령관으로 자유 배정 가능)
  const playerRig = createMongleActorRig({
    baseId: 0,
    shape: "egg",
    tone: "amber",
    quaker: null,
    starlight: true,
    role: "commodore",
    scale: 0.94,
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
  const visibleActorIdx = new Int32Array(64);
  const actorHasSpeechFlags = new Uint8Array(64);
  const actorPriorityFlags = new Uint8Array(64);
  const minimapActorPool: WorldFrameMinimapActor[] = [];
  const minimapActorsOut: WorldFrameMinimapActor[] = [];
  const villagePosPool: WorldFrameVillagePosition[] = [];
  const topVillageIdx = new Int32Array(MAX_OVERVIEW_VILLAGE_SIGNS);
  const topVillageDist = new Float64Array(MAX_OVERVIEW_VILLAGE_SIGNS);
  const framePositions: {
    actors: WorldFrameActorPosition[];
    actorCount: number;
    minimapActors: WorldFrameMinimapActor[];
    player: WorldFramePointPosition;
    playerWorldX: number;
    playerWorldZ: number;
    playerYaw: number;
    villages: WorldFrameVillagePosition[];
    villageCount: number;
    hoveredDistrict: WorldFramePointPosition;
    noticeBoard: WorldFramePointPosition;
    guildHall: WorldFramePointPosition;
    campfireBench: WorldFramePointPosition;
  } = {
    actors: actorPosPool,
    actorCount: 0,
    minimapActors: minimapActorsOut,
    player: { x: 0, y: 0, visible: false },
    playerWorldX: 0,
    playerWorldZ: 0,
    playerYaw: 0,
    villages: villagePosPool,
    villageCount: 0,
    hoveredDistrict: { x: 0, y: 0, visible: false },
    noticeBoard: { x: 0, y: 0, visible: false },
    guildHall: { x: 0, y: 0, visible: false },
    campfireBench: { x: 0, y: 0, visible: false },
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
  let sprintDustAccum = 0;
  let stardustAccum = 0;
  let stardustStep = 0;
  let playerEmoteHop = 0;
  let playerEmoteKind: "wave" | "cheer" | "spin" | null = null;
  let customizerOpen = false;
  let playerEmoteTimer = 0;
  let playerEmotePhase = 0;
  let playerLookYaw = 0;
  let playerLookPitch = 0;
  let playerHatPos = 0;
  let playerHatVel = 0;
  let prevPlayerLiftY = 0;
  let currentWeather: WorldWeatherMode = "clear";
  let rainbowLookTimer = 0;
  let prevPlayerX = playerCtrl.player.x;
  let prevPlayerZ = playerCtrl.player.z;
  let prevNow = performance.now();
  let lastRenderNow = 0;

  interface ActorPoseSpring {
    lookYaw: number;
    lookPitch: number;
    prevLift: number;
    hatPos: number;
    hatVel: number;
  }
  const actorPoseSprings = new Map<string, ActorPoseSpring>();

  const clampSigned = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
  const angleDelta = (target: number, current: number) => {
    let d = target - current;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  };

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
    const interactionKey = currentInteractionMode as string;
    const isConversing = interactionKey === "dialogue" || interactionKey === "chat";
    const focusFraming: CameraFocusFraming =
      focusedMotion !== null
        ? interactionKey === "dialogue"
          ? "dialogue"
          : interactionKey === "chat" || interactionKey === "goals" || interactionKey === "info" || interactionKey === "settings"
            ? "drawer"
            : "none"
        : customizerOpen
          ? "customizer"
          : "none";

    const resolveSurface = (x: number, z: number): WorldFootstepSurface =>
      meadow.getSurfaceType?.(x, z) ?? (meadow.isOnBridge(x, z) ? "wood" : "grass");

    playerCtrl.update({
      dt,
      lifecycle: currentLifecycle,
      cameraMode: currentCameraMode,
      reducedMotion: config.isReducedMotion(),
      inputLocked: interacting || customizerOpen,
      focusActorPos: focusedMotion ? { x: focusedMotion.x, z: focusedMotion.z } : null,
      focusFraming,
      camera,
      getGroundHeight: meadow.getGroundHeight,
      resolveMovement: meadow.resolveMovement,
      getCameraOccluders: () => meadow.getCameraOccluders?.() ?? EMPTY_OCCLUDERS,
      onDustParticle: director.spawnDust,
      onOverviewAutoExit: config.onOverviewAutoExit,
      onJump: () => {
        playJump();
        // 별빛 요정 제독 도약 시 발끝·망토 뒤 작은 별무리 방출 (기존 InstancedMesh 풀 재사용, Draw Call +0)
        const pCur = playerCtrl.player;
        const bx = -Math.sin(pCur.yaw) * 0.24;
        const bz = -Math.cos(pCur.yaw) * 0.24;
        director.spawnBurst(pCur.x + bx, pCur.y + 0.26, pCur.z + bz, 0xc4b5fd, 5);
        director.emitWorkshopFx(pCur.x + bx, pCur.y + 0.44, pCur.z + bz, "ask");
      },
      onLand: () => {
        const px = playerCtrl.player.x;
        const py = playerCtrl.player.y;
        const pz = playerCtrl.player.z;
        const surface = resolveSurface(px, pz);
        playFootstep(surface);
        if (surface === "water") {
          director.spawnBurst(px, py + 0.10, pz, 0x7dd3fc, 8);
        } else {
          director.spawnDust(px, py + 0.06, pz);
          director.spawnDust(px + 0.16, py + 0.06, pz - 0.12);
          director.spawnDust(px - 0.16, py + 0.06, pz + 0.12);
        }
        // 착지 별빛 스파클(금빛·하늘빛)
        director.spawnBurst(px, py + 0.18, pz, 0xffe57f, 3);
        director.emitWorkshopFx(px, py + 0.28, pz, "pulse");
      },
      onStandUp: config.onCampfireStandUp,
    });

    if (playerEmoteHop > 0) {
      playerEmoteHop = Math.max(0, playerEmoteHop - dt * 1.9);
    }
    if (playerEmoteTimer > 0) {
      playerEmoteTimer = Math.max(0, playerEmoteTimer - dt);
      playerEmotePhase += dt;
      if (playerEmoteTimer === 0) {
        playerEmoteKind = null;
        playerEmotePhase = 0;
      }
    }
    if (rainbowLookTimer > 0) {
      rainbowLookTimer = Math.max(0, rainbowLookTimer - dt);
    }

    // `Shift` 대시 질주 시 지면 재질별 미세 먼지/물보라 파티클 방출 (기존 풀 재사용, Draw Call +0)
    if (currentLifecycle === "open" && playerCtrl.isSprinting() && playerCtrl.player.onGround) {
      sprintDustAccum += dt;
      if (sprintDustAccum >= 0.10) {
        sprintDustAccum = 0;
        const surface = resolveSurface(playerCtrl.player.x, playerCtrl.player.z);
        if (surface === "water") {
          director.spawnBurst(playerCtrl.player.x, playerCtrl.player.y + 0.10, playerCtrl.player.z, 0x7dd3fc, 3);
        } else {
          director.spawnDust(playerCtrl.player.x, playerCtrl.player.y + 0.08, playerCtrl.player.z);
        }
      }
    } else {
      sprintDustAccum = 0;
    }

    // ⭐ 별빛 요정 제독 미세 별가루 궤적 (기존 파티클 풀 재사용, Draw Call +0)
    // 걷기 ~3.5/s · 질주 ~12/s · 체공 ~7/s — 금빛(0xffe57f)·라벤더(0xc4b5fd)·하늘(0x7dd3fc) 은은한 흩날림
    if (currentLifecycle === "open" && !playerCtrl.isOverviewMode() && !config.isReducedMotion()) {
      const pCur = playerCtrl.player;
      const isAirborne = !pCur.onGround && pCur.playerJumpY > 0.12;
      const isSprintingNow = playerCtrl.isSprinting() && pCur.onGround;
      const isWalkingNow = pCur.walking && pCur.onGround && !isSprintingNow;
      if (isSprintingNow || isWalkingNow || isAirborne) {
        const interval = isSprintingNow ? 0.083 : isAirborne ? 0.14 : 0.285;
        stardustAccum += dt;
        if (stardustAccum >= interval) {
          stardustAccum -= interval;
          if (stardustAccum > interval) stardustAccum = 0;
          const backX = -Math.sin(pCur.yaw);
          const backZ = -Math.cos(pCur.yaw);
          const sideX = Math.cos(pCur.yaw);
          const sideZ = -Math.sin(pCur.yaw);
          const jitter = ((stardustStep % 5) - 2) * 0.11;
          const trailDist = isSprintingNow ? 0.44 : 0.30;
          const sx = pCur.x + backX * trailDist + sideX * jitter;
          const sz = pCur.z + backZ * trailDist + sideZ * jitter;
          const sy = pCur.y + (isAirborne ? 0.38 : isSprintingNow ? 0.32 + (stardustStep % 2) * 0.22 : 0.26);
          const phase = stardustStep % 3;
          stardustStep = (stardustStep + 1) % 30;
          if (isSprintingNow) {
            if (phase === 0) {
              director.emitWorkshopFx(sx, sy, sz, "ask");
            } else if (phase === 1) {
              director.spawnBurst(sx, sy, sz, 0xc4b5fd, 2);
            } else {
              director.emitWorkshopFx(sx, sy, sz, "pulse");
            }
          } else if (isAirborne) {
            director.emitWorkshopFx(sx, sy, sz, phase === 1 ? "pulse" : "ask");
          } else {
            // 일반 보행: 은은한 금빛·하늘빛 부유 입자 위주 + 매 3번째 발걸음 라벤더 별빛
            if (phase === 0) {
              director.emitWorkshopFx(sx, sy, sz, "ask");
            } else if (phase === 1) {
              director.emitWorkshopFx(sx, sy, sz, "pulse");
            } else {
              director.spawnBurst(sx, sy + 0.08, sz, 0xc4b5fd, 2);
            }
          }
        }
      } else {
        stardustAccum = 0;
      }
    } else {
      stardustAccum = 0;
    }

    playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
    framePositions.playerWorldX = playerCtrl.player.x;
    framePositions.playerWorldZ = playerCtrl.player.z;
    framePositions.playerYaw = playerCtrl.player.yaw;

    // 플레이어 지상 보행 발소리 (돌길·풀밭·나무다리·물가 재질별, 오디오 내부 280ms 쿨다운)
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
        playFootstep(resolveSurface(playerCtrl.player.x, playerCtrl.player.z));
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

    // 플레이어 아바타 포즈 · 전용 애니메이션 · 표정 · 2차 모자 스프링 · 시선 추적 갱신
    const p = playerCtrl.player;
    const pGround = Math.max(-0.05, meadow.getGroundHeight(p.x, p.z));
    const pHop = p.walking && p.onGround ? Math.abs(Math.sin(elapsed * (p.sprinting ? 15 : 10))) * 0.14 : 0;
    const pEmoteLift = playerEmoteHop > 0
      ? Math.sin(Math.min(1, playerEmoteHop) * Math.PI) * (playerEmoteKind === "spin" ? 0.68 : 0.42)
      : 0;
    const pTotalLift = p.playerJumpY + pHop + pEmoteLift;

    // 2차 물리 모자/왕관 스프링 (점프·착지·발걸음 수직 변화에 살짝 늦게 반응)
    const pLiftVel = dt > 0.0005 ? (pTotalLift - prevPlayerLiftY) / dt : 0;
    prevPlayerLiftY = pTotalLift;
    const hatTarget = clampSigned(-pLiftVel * 0.018 - p.landSquash * 0.11, 0.16);
    playerHatVel += ((hatTarget - playerHatPos) * 140 - playerHatVel * 14) * dt;
    playerHatPos = clampSigned(playerHatPos + playerHatVel * dt, 0.18);

    // 플레이어 전용 애니메이션 모드 & 표정 결정
    const sittingCampfire = playerCtrl.isSittingAtCampfire();
    let playerAnim: WorldAnimMode = "idle";
    let playerExpr: WorldExpression = "normal";
    let playerBlush = 0;
    if (playerEmoteTimer > 0 && playerEmoteKind) {
      playerAnim = playerEmoteKind;
      playerExpr = "happy";
      playerBlush = playerEmoteKind === "spin" ? 0.92 : 0.82;
    } else if (sittingCampfire) {
      if (p.campfireSitSec > 8.0) {
        playerAnim = "doze";
        playerExpr = "sleepy";
        playerBlush = 0.25;
      } else {
        playerAnim = "sit";
        playerExpr = "happy";
        playerBlush = 0.35;
      }
    } else if (!p.onGround || p.playerJumpY > 0.06) {
      playerAnim = "jump";
      playerExpr = p.jumpVel > 0.5 ? "happy" : "normal";
      playerBlush = 0.28;
    } else if (p.sprinting && p.walking) {
      playerAnim = "sprint";
      playerExpr = "focused";
    } else if (p.walking) {
      playerAnim = "walk";
      playerExpr = "normal";
    } else if (focusedMotion && isConversing) {
      playerAnim = "talk";
      playerExpr = "happy";
      playerBlush = 0.3;
    } else if (focusedMotion) {
      playerAnim = "idle";
      playerExpr = "focused";
      playerBlush = 0.12;
    } else if (customizerOpen) {
      // 실시간 3D 제독 드레스업 중: 기분 좋은 미소·은은한 볼터치·호흡 유지
      playerAnim = "idle";
      playerExpr = "happy";
      playerBlush = 0.28;
    }

    // 플레이어 부드러운 시선 추적 (드레스업 카메라 응시 → 포커스 상대 → 근접 NPC → 벚꽃/눈/무지개 하늘)
    const skyAdmire = currentWeather === "sakura" || currentWeather === "snow" || rainbowLookTimer > 0;
    let targetPLookYaw = 0;
    let targetPLookPitch = 0;
    const glanceActor = focusedMotion ?? (nearId ? director.motions.get(nearId) ?? null : null);
    if (customizerOpen) {
      const rel = angleDelta(Math.atan2(camera.position.x - p.x, camera.position.z - p.z), p.yaw);
      targetPLookYaw = clampSigned(rel / 1.35, 0.85);
      targetPLookPitch = 0.08;
    } else if (glanceActor) {
      const distG = Math.hypot(glanceActor.x - p.x, glanceActor.z - p.z);
      if (distG < 7.0 && distG > 0.2) {
        const rel = angleDelta(Math.atan2(glanceActor.x - p.x, glanceActor.z - p.z), p.yaw);
        targetPLookYaw = clampSigned(rel / 1.15, 1);
      }
    } else if (skyAdmire && !p.walking) {
      targetPLookPitch = 0.42;
      targetPLookYaw = Math.sin(elapsed * 0.65) * 0.35;
    }
    const lookLerp = Math.min(1, dt * 6.5);
    playerLookYaw += (targetPLookYaw - playerLookYaw) * lookLerp;
    playerLookPitch += (targetPLookPitch - playerLookPitch) * lookLerp;

    const fireWarmP = Math.max(0, 1 - Math.hypot(p.x - 2.8, p.z - 1.0) / 8.0) * skyLighting.nightFactor * 0.55;
    tempTint.set(
      skyLighting.avatarWorldTint.x + fireWarmP * 0.65,
      skyLighting.avatarWorldTint.y + fireWarmP * 0.32,
      skyLighting.avatarWorldTint.z + fireWarmP * 0.05,
    );
    playerRig.updatePose({
      x: p.x,
      groundY: pGround,
      liftY: pTotalLift,
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
      worldAnim: playerAnim,
      expression: playerExpr,
      animPhase: playerEmotePhase,
      moveSpeed: p.moveSpeed,
      jumpVel: p.jumpVel,
      landSquash: p.landSquash,
      lookYaw: playerLookYaw,
      lookPitch: playerLookPitch,
      blush: playerBlush,
      hatBounce: playerHatPos,
    });

    // 사령관·지휘관·구성원 포즈 갱신 · 배치 접촉 그림자(Soft AO) · 미니맵 산책 도트 · Direct-DOM 투영 계산
    const isOpen = currentLifecycle === "open";
    let actorCount = 0;
    let visibleCount = 0;
    let minimapActorCount = 0;
    let aoBlobCount = 0;
    let structSig = isOpen ? "1" : "0";
    let idx = 0;

    // 0번 AO Blob: 플레이어 제독 접촉 그림자 (점프 높이에 따라 크기·투명도 부드럽게 반응)
    {
      const pAoScale = 0.92 * Math.max(0.45, Math.min(1.06, 1 - pTotalLift * 0.28 + p.landSquash * 0.14));
      const pAoAlpha = Math.max(0.06, Math.min(0.44, 0.36 * (1 - pTotalLift * 0.42)));
      aoPos.set(p.x, pGround + 0.022, p.z);
      aoScale.set(pAoScale, 1, pAoScale);
      aoMat4.compose(aoPos, aoQuat, aoScale);
      aoBlobInstanced.setMatrixAt(aoBlobCount, aoMat4);
      aoOpacityArray[aoBlobCount] = pAoAlpha;
      aoBlobCount += 1;
    }

    for (const m of director.motions.values()) {
      idx += 1;
      const entry = actorRigs.get(m.spec.id);
      if (!entry) continue;
      const gy = Math.max(-0.05, meadow.getGroundHeight(m.x, m.z));
      const roleScale = m.spec.role === "commodore" ? 0.96 : m.spec.role === "commander" ? 0.82 : 0.70;
      const waddle = m.moving ? Math.abs(Math.sin(elapsed * 11 + idx)) * 0.11 : 0;
      const hop = m.hopBoost * Math.abs(Math.sin(elapsed * 10)) * 0.48
        + (director.celebratingTimer > 0 ? Math.abs(Math.sin(elapsed * 9 + idx)) * 0.40 : 0);
      const totalLift = waddle + hop;

      let sp = actorPoseSprings.get(m.spec.id);
      if (!sp) {
        sp = { lookYaw: 0, lookPitch: 0, prevLift: totalLift, hatPos: 0, hatVel: 0 };
        actorPoseSprings.set(m.spec.id, sp);
      }

      // NPC 2차 모자/왕관 바운스 스프링
      const liftVel = dt > 0.0005 ? (totalLift - sp.prevLift) / dt : 0;
      sp.prevLift = totalLift;
      const npcHatTarget = clampSigned(-liftVel * 0.016, 0.15);
      sp.hatVel += ((npcHatTarget - sp.hatPos) * 135 - sp.hatVel * 14) * dt;
      sp.hatPos = clampSigned(sp.hatPos + sp.hatVel * dt, 0.18);

      const isSelected = selectedActorId === m.spec.id;
      const isNearPlayer = nearId === m.spec.id;
      // RPG 대화(`dialogue`) 또는 우측 사령관 수첩 `대화`(`chat`) 탭 열림 중 포커스 NPC는 대화(`talk`/`happy`/시선) 유지
      const conversingFocus = isSelected && isConversing;

      // NPC 부드러운 시선 추적 (대화 중 포커스 제독 → 수다 상대 → 7m 이내 지나가는 제독 → 벚꽃/눈/무지개 하늘)
      let targetLookYaw = 0;
      let targetLookPitch = 0;
      const distPlayer = Math.hypot(p.x - m.x, p.z - m.z);
      if (conversingFocus || m.worldAnim !== "sleep") {
        if (conversingFocus && distPlayer > 0.25) {
          const rel = angleDelta(Math.atan2(p.x - m.x, p.z - m.z), m.yaw);
          targetLookYaw = clampSigned(rel / 1.15, 1);
          targetLookPitch = clampSigned((p.playerJumpY) * 0.35, 0.55);
        } else if (m.gazeTargetX !== null && m.gazeTargetZ !== null) {
          const rel = angleDelta(Math.atan2(m.gazeTargetX - m.x, m.gazeTargetZ - m.z), m.yaw);
          targetLookYaw = clampSigned(rel / 1.15, 1);
        } else if (distPlayer < 7.0 && distPlayer > 0.25) {
          const rel = angleDelta(Math.atan2(p.x - m.x, p.z - m.z), m.yaw);
          targetLookYaw = clampSigned(rel / 1.15, 1);
          targetLookPitch = clampSigned((p.playerJumpY) * 0.35, 0.55);
        } else if (skyAdmire && !m.moving) {
          targetLookPitch = 0.44;
          targetLookYaw = Math.sin(elapsed * 0.55 + idx) * 0.32;
        }
      }
      sp.lookYaw += (targetLookYaw - sp.lookYaw) * lookLerp;
      sp.lookPitch += (targetLookPitch - sp.lookPitch) * lookLerp;

      const fireWarm = Math.max(0, 1 - Math.hypot(m.x - 2.8, m.z - 1.0) / 8.0) * skyLighting.nightFactor * 0.55;
      tempTint.set(
        skyLighting.avatarWorldTint.x + fireWarm * 0.65,
        skyLighting.avatarWorldTint.y + fireWarm * 0.32,
        skyLighting.avatarWorldTint.z + fireWarm * 0.05,
      );

      const keepEmote = m.worldAnim === "wave" || m.worldAnim === "cheer" || m.worldAnim === "spin";
      const effAnim: WorldAnimMode = conversingFocus && !keepEmote ? "talk" : m.worldAnim;
      const effExpr: WorldExpression = conversingFocus && !keepEmote ? "happy" : m.expression;
      const effBlush = conversingFocus ? Math.max(m.blush, 0.42) : m.blush;

      entry.rig.updatePose({
        x: m.x,
        groundY: gy,
        liftY: totalLift,
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
        worldAnim: effAnim,
        expression: effExpr,
        animPhase: m.animPhase,
        moveSpeed: m.moveSpeed,
        jumpVel: m.hopBoost > 0.2 ? Math.cos(elapsed * 10) * m.hopBoost * 2.2 : 0,
        landSquash: 0,
        lookYaw: sp.lookYaw,
        lookPitch: sp.lookPitch,
        blush: effBlush,
        hatBounce: sp.hatPos,
      });

      // 배치 Soft AO 접촉 그림자 (점프/바운스 높이에 따라 크기·투명도 부드럽게 반응)
      if (aoBlobCount < MAX_ACTOR_AO_BLOBS) {
        const aAoScale = roleScale * Math.max(0.46, Math.min(1.04, 1 - totalLift * 0.28));
        const aAoAlpha = Math.max(0.06, Math.min(0.42, 0.34 * (1 - totalLift * 0.40)));
        aoPos.set(m.x, gy + 0.022, m.z);
        aoScale.set(aAoScale, 1, aAoScale);
        aoMat4.compose(aoPos, aoQuat, aoScale);
        aoBlobInstanced.setMatrixAt(aoBlobCount, aoMat4);
        aoOpacityArray[aoBlobCount] = aAoAlpha;
        aoBlobCount += 1;
      }

      // 미니맵 실시간 사령관 산책 도트 데이터 (0-GC 사전 할당 풀 재사용)
      if (m.spec.role === "commodore") {
        let dot = minimapActorPool[minimapActorCount];
        if (!dot) {
          dot = { id: "", x: 0, z: 0, color: "#38bdf8", walking: false };
          minimapActorPool.push(dot);
        }
        dot.id = m.spec.id;
        dot.x = m.x;
        dot.z = m.z;
        dot.color = TONE_HEX_CSS[m.spec.tone] ?? "#38bdf8";
        dot.walking = m.moving;
        minimapActorsOut[minimapActorCount] = dot;
        minimapActorCount += 1;
      }

      if (isOpen) {
        // RPG 대화(`dialogue`)·우측 수첩 채팅(`chat`) 중에는 포커스 대상의 3D 머리 위 말풍선 투영을 숨겨 이름표/얼굴 가림을 방지
        const effectiveSpeech = conversingFocus ? "" : m.speech;
        structSig += `|${m.spec.id}:${m.spec.name}:${m.spec.tone}:${m.spec.quaker ?? ""}:${isNearPlayer ? 1 : 0}:${isSelected ? 1 : 0}:${m.spec.needsAttention ? 1 : 0}:${effectiveSpeech}`;

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
            opacity: 1,
            scale: 1,
            speechOffsetY: 0,
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
          && projTop.y >= TOP_ACTOR_LABEL_SAFE_Y
          && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
        ) {
          const hasSpeech = effectiveSpeech.length > 0;
          const isPriority = isSelected || isNearPlayer || m.spec.needsAttention || hasSpeech;
          slot.x = projTop.x;
          slot.y = projTop.y;
          slot.hitX = projBody.x;
          slot.hitY = projBody.y;
          slot.hitRadius = Math.max(26, 360 / projBody.w);
          slot.distance = projTop.w;
          slot.visible = true;
          slot.isDistant = projTop.w > 25 && !isPriority;

          // 거리·포커스 기반 2D 라벨 LOD (`opacity` / `scale`) + 말풍선-힌트 간격 오프셋
          if (isPriority || projTop.w <= 16) {
            slot.opacity = 1;
            slot.scale = 1;
          } else {
            const distT = Math.max(0, Math.min(1, (projTop.w - 16) / 34));
            slot.opacity = Number((1 - distT * 0.56).toFixed(2));
            slot.scale = Number((1 - distT * 0.16).toFixed(2));
          }
          slot.speechOffsetY = hasSpeech && isNearPlayer ? -26 : 0;

          if (visibleCount < visibleActorIdx.length) {
            visibleActorIdx[visibleCount] = actorCount;
            actorHasSpeechFlags[actorCount] = hasSpeech ? 1 : 0;
            actorPriorityFlags[actorCount] = isPriority ? 1 : 0;
            visibleCount += 1;
          }
        } else {
          slot.visible = false;
          slot.distance = 999;
          slot.isDistant = false;
          slot.opacity = 0;
          slot.scale = 1;
          slot.speechOffsetY = 0;
        }
        actorCount += 1;
      }
    }
    framePositions.actorCount = actorCount;
    minimapActorsOut.length = minimapActorCount;

    // 배치 Soft AO 접촉 그림자 업로드 (단일 InstancedMesh 1 draw call)
    aoBlobInstanced.count = aoBlobCount;
    aoBlobInstanced.visible = aoBlobCount > 0;
    if (aoBlobCount > 0) {
      aoBlobInstanced.instanceMatrix.needsUpdate = true;
      aoOpacityAttr.needsUpdate = true;
    }

    // 0-GC 2D 레이블 충돌 회피(Greedy De-overlap): 우선순위(선택·근접·말풍선·근거리) 순 정렬 후 수직 분리
    if (visibleCount > 1) {
      for (let i = 1; i < visibleCount; i += 1) {
        const keyIdx = visibleActorIdx[i]!;
        const keyPrio = actorPriorityFlags[keyIdx]!;
        const keyDist = actorPosPool[keyIdx]!.distance;
        let j = i - 1;
        while (j >= 0) {
          const prevIdx = visibleActorIdx[j]!;
          const prevPrio = actorPriorityFlags[prevIdx]!;
          const prevDist = actorPosPool[prevIdx]!.distance;
          if (keyPrio > prevPrio || (keyPrio === prevPrio && keyDist < prevDist)) {
            visibleActorIdx[j + 1] = prevIdx;
            j -= 1;
          } else {
            break;
          }
        }
        visibleActorIdx[j + 1] = keyIdx;
      }

      const LABEL_SEP_X = 110;
      for (let i = 1; i < visibleCount; i += 1) {
        const curIdx = visibleActorIdx[i]!;
        const cur = actorPosPool[curIdx]!;
        const curH = actorHasSpeechFlags[curIdx] ? 54 : 30;
        for (let pass = 0; pass < 3; pass += 1) {
          let moved = false;
          for (let j = 0; j < i; j += 1) {
            const prevIdx = visibleActorIdx[j]!;
            const prev = actorPosPool[prevIdx]!;
            if (!prev.visible) continue;
            const minSepY = Math.max(curH, actorHasSpeechFlags[prevIdx] ? 54 : 30);
            if (Math.abs(cur.x - prev.x) < LABEL_SEP_X && Math.abs(cur.y - prev.y) < minSepY) {
              cur.y = prev.y - minSepY;
              moved = true;
            }
          }
          if (!moved) break;
        }
        // 충돌 회피로 상단 HUD 영역(`y < 44`) 위로 밀려난 라벨은 잘림 방지를 위해 숨김 처리
        if (cur.y < TOP_ACTOR_LABEL_SAFE_Y) {
          cur.visible = false;
          cur.opacity = 0;
        }
      }
    }

    // 구조적 변화가 발생한 프레임에만 React 라벨 메타 목록 갱신 (유휴·이동 시 0Hz)
    if (structSig !== lastStructSig) {
      lastStructSig = structSig;
      const nextMetas: WorldActorLabelMeta[] = [];
      if (isOpen) {
        for (const m of director.motions.values()) {
          if (!actorRigs.has(m.spec.id)) continue;
          const hideSpeech = isConversing && selectedActorId === m.spec.id;
          nextMetas.push({
            actorId: m.spec.id,
            name: m.spec.name,
            role: m.spec.role,
            tone: m.spec.tone,
            quaker: m.spec.quaker,
            speech: hideSpeech ? "" : m.speech,
            isNearPlayer: nearId === m.spec.id,
            isSelected: selectedActorId === m.spec.id,
            needsAttention: m.spec.needsAttention,
          });
        }
      }
      latestLabelMetas = nextMetas;
      config.onLabelsStructureChanged(nextMetas);
    }

    // 플레이어 라벨 투영 (하늘 조망·제독 드레스업 클로즈업 중에는 숨김)
    const inOverview = playerCtrl.isOverviewMode();
    if (isOpen && !inOverview && !customizerOpen && currentCameraMode === "follow" && currentInteractionMode === "closed") {
      tempPos.set(p.x, p.y + pHop + 1.54, p.z);
      if (
        projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
        && projTop.w < MAX_PLAYER_LABEL_DIST
        && projTop.y >= TOP_ACTOR_LABEL_SAFE_Y
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
          && projTop.y >= TOP_SIGN_SAFE_Y
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
        && projTop.y >= TOP_SIGN_SAFE_Y
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
        && projTop.y >= TOP_SIGN_SAFE_Y
        && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
      ) {
        framePositions.noticeBoard.x = projTop.x;
        framePositions.noticeBoard.y = projTop.y;
        framePositions.noticeBoard.visible = true;
      } else {
        framePositions.noticeBoard.visible = false;
      }

      // 중앙 길드 회관 「함대 상황실」 푯말 투영 (Direct-DOM 0Hz)
      const ghX = WORLD_GUILD_HALL_POS.x;
      const ghZ = WORLD_GUILD_HALL_POS.z;
      const ghY = meadow.getGroundHeight(ghX, ghZ) + 5.75;
      tempPos.set(ghX, ghY, ghZ);
      if (
        projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
        && projTop.w < (inOverview ? 165 : 54)
        && projTop.y >= TOP_SIGN_SAFE_Y
        && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
      ) {
        framePositions.guildHall.x = projTop.x;
        framePositions.guildHall.y = projTop.y;
        framePositions.guildHall.visible = true;
      } else {
        framePositions.guildHall.visible = false;
      }

      // 광장 모닥불 벤치 불멍 힌트 투영 (Direct-DOM 0Hz, 불멍 중이 아닐 때 근접 시 표시)
      const cbX = WORLD_CAMPFIRE_BENCH_POS.x;
      const cbZ = WORLD_CAMPFIRE_BENCH_POS.z;
      const distToBench = Math.hypot(p.x - cbX, p.z - cbZ);
      if (!inOverview && !playerCtrl.isSittingAtCampfire() && distToBench < 11.5) {
        const cbY = meadow.getGroundHeight(cbX, cbZ) + 1.35;
        tempPos.set(cbX, cbY, cbZ);
        if (
          projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop)
          && projTop.w < 26
          && projTop.y >= TOP_SIGN_SAFE_Y
          && isInsideViewport(projTop.x, projTop.y, cssWidth, cssHeight)
        ) {
          framePositions.campfireBench.x = projTop.x;
          framePositions.campfireBench.y = projTop.y;
          framePositions.campfireBench.visible = true;
        } else {
          framePositions.campfireBench.visible = false;
        }
      } else {
        framePositions.campfireBench.visible = false;
      }
    } else {
      framePositions.noticeBoard.visible = false;
      framePositions.guildHall.visible = false;
      framePositions.campfireBench.visible = false;
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
          actorPoseSprings.delete(id);
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
    setWeather(mode) {
      currentWeather = mode;
      skyLighting.setWeather(mode);
      meadow.setWeather(mode);
      director.setWeather(mode);
      setRainAmbience(mode === "rain");
    },
    triggerRainbow(durationSec = 16) {
      rainbowLookTimer = Math.max(rainbowLookTimer, durationSec);
      skyLighting.triggerRainbow(durationSec);
    },
    setAdmiralStyle(tone, hat) {
      playerRig.setAdmiralStyle(tone, hat);
    },
    setCustomizerMode(open) {
      customizerOpen = open;
    },
    triggerCustomizerPreviewBounce() {
      // 색상·모자 변경 시 0.95초간 기분 좋은 cheer 바운스 + happy 표정 + 볼터치 + 모자 2차 스프링 튕김 + 별빛 스파클 연출
      playerEmoteKind = "cheer";
      playerEmoteTimer = 0.95;
      playerEmotePhase = 0;
      playerEmoteHop = 0.85;
      playerHatVel -= 1.65;
      const px = playerCtrl.player.x;
      const py = playerCtrl.player.y;
      const pz = playerCtrl.player.z;
      director.spawnBurst(px, py + 1.05, pz, 0xc4b5fd, 6);
      director.spawnBurst(px, py + 0.92, pz, 0xffe57f, 4);
      director.emitWorkshopFx(px, py + 1.18, pz, "pulse");
    },
    setCampfireSit(sitting) {
      playerCtrl.setCampfireSit(sitting);
    },
    rallyAllToPlaza() {
      director.rallyAllToPlaza();
      playRallyHorn();
    },
    playPlayerEmote(emote) {
      playerEmoteKind = emote === "wave" ? "wave" : emote === "cheer" ? "cheer" : "spin";
      playerEmoteTimer = 1.8;
      playerEmotePhase = 0;
      playerEmoteHop = emote === "jump" ? 1.15 : 0.72;
      playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
      director.reactToPlayerEmote(emote, playerPosVec);
      playMongleChirp(emote === "cheer" ? 3 : emote === "jump" ? 5 : 0);
    },
    setDistrictHighlight(hovered, selected) {
      currentHoveredDistrict = hovered;
      meadow.setDistrictHighlight(hovered, selected);
    },
    setDispatchFlags(flags) {
      meadow.setDispatchFlags(flags);
    },
    setDistrictNotePins(pins) {
      meadow.setDistrictNotePins(pins);
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
      rainbowLookTimer = Math.max(rainbowLookTimer, 14);
      skyLighting.triggerRainbow(14);
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
    spawnCourierBetweenVillages(fromVillage, toVillage) {
      const rgb = PLUSH_VIVID_TONES[fromVillage.tone];
      const colorHex = (Math.round(rgb[0] * 255) << 16)
        | (Math.round(rgb[1] * 255) << 8)
        | Math.round(rgb[2] * 255);
      director.spawnCourierArc(fromVillage.x, fromVillage.z, toVillage.x, toVillage.z, colorHex);
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
    pickGuildHallAt(clientX, clientY) {
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const mx = clientX - rect.left;
      const my = clientY - rect.top;

      if (framePositions.guildHall.visible) {
        if (Math.hypot(mx - framePositions.guildHall.x, my - (framePositions.guildHall.y + 42)) <= 64) {
          return true;
        }
      }

      pickNdc.set((mx / rect.width) * 2 - 1, -(my / rect.height) * 2 + 1);
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      if (Math.abs(direction.y) < 1e-4) return false;
      const ghY = meadow.getGroundHeight(WORLD_GUILD_HALL_POS.x, WORLD_GUILD_HALL_POS.z) + 1.8;
      const t = (ghY - origin.y) / direction.y;
      if (t <= 0 || t > 220) return false;
      const wx = origin.x + direction.x * t;
      const wz = origin.z + direction.z * t;
      return Math.hypot(wx - WORLD_GUILD_HALL_POS.x, wz - WORLD_GUILD_HALL_POS.z) <= WORLD_GUILD_HALL_POS.radius;
    },
    pickCampfireBenchAt(clientX, clientY) {
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const mx = clientX - rect.left;
      const my = clientY - rect.top;

      if (framePositions.campfireBench.visible) {
        if (Math.hypot(mx - framePositions.campfireBench.x, my - framePositions.campfireBench.y) <= 52) {
          return true;
        }
      }

      pickNdc.set((mx / rect.width) * 2 - 1, -(my / rect.height) * 2 + 1);
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      if (Math.abs(direction.y) < 1e-4) return false;
      const cbY = meadow.getGroundHeight(WORLD_CAMPFIRE_BENCH_POS.x, WORLD_CAMPFIRE_BENCH_POS.z) + 0.55;
      const t = (cbY - origin.y) / direction.y;
      if (t <= 0 || t > 180) return false;
      const wx = origin.x + direction.x * t;
      const wz = origin.z + direction.z * t;
      return Math.hypot(wx - WORLD_CAMPFIRE_BENCH_POS.x, wz - WORLD_CAMPFIRE_BENCH_POS.z) <= WORLD_CAMPFIRE_BENCH_POS.radius;
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
      setRainAmbience(false);
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
      actorPoseSprings.clear();
      aoBlobInstanced.dispose();
      aoBlobGeo.dispose();
      aoBlobMat.dispose();
      scene.remove(aoBlobInstanced);
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
