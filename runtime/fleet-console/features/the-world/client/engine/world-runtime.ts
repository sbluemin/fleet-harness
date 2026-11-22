import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
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
  type WorldActorSpec,
  type WorldAdmiralCape,
  type WorldAdmiralHat,
  type WorldAdmiralStyle,
  type WorldAdmiralTrail,
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
import { brookProfile } from "./brook-geometry.js";
import { createChoreographyDirector } from "./choreography-director.js";
import {
  createFishingController,
  type CompanionAnglerPose,
  type FishingReelResult,
  type WorldFishingPhase,
} from "./fishing-controller.js";
import {
  createLivingWorkflowFx,
  type OperationFlagFxInput,
  type SkyRingPositionOut,
  type WorkingVillageFxInput,
} from "./living-workflow-fx.js";
import { createMeadowScene, MAILBOX_POS, PARADE_BELL_POS } from "./meadow-scene.js";
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
  type CinemaCameraTarget,
} from "./player-controller.js";
import { createSkyAndLighting } from "./sky-and-lighting.js";
import {
  playBarrelRoll,
  playEmoteSparkle,
  playFireworkBurst,
  playFishingBite,
  playFishingCast,
  playFishingCatch,
  playFootstep,
  playJump,
  playLevelUpFanfare,
  playMeteorDive,
  playMeteorImpact,
  playMongleChirp,
  playParadeBell,
  playRallyHorn,
  playSkyRingPass,
  playStarBoost,
  playStarTakeoffAscend,
  playStarTakeoffCharge,
  setBgmEnabled,
  setRainAmbience,
  updateBgmEnvironment,
  updateSpatialAmbience,
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

export interface WorldFrameRingGuide {
  visible: boolean;
  xPx: number;
  yPx: number;
  xPct: number;
  yPct: number;
  angleRad: number;
  distM: number;
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
  readonly guildHall: WorldFramePointPosition;
  readonly campfireBench: WorldFramePointPosition;
  readonly ringGuide: WorldFrameRingGuide;
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
  /** 관전/작업 동반자 시네마 모드의 현재 스포트라이트 대상이 바뀔 때 라벨을 전달한다. */
  readonly onCinemaSpotlight?: ((label: string) => void) | undefined;
  /** 동행 사령관이 실제 작업/확인 필요 상태에 돌입해 마을로 자동 복귀할 때 호출된다. */
  readonly onCompanionDutyReturn?: ((actorId: string, actorName: string) => void) | undefined;
  /** 하늘 순찰 중 별빛 링을 통과할 때 누적 콤보와 부스트 발동 여부를 전달한다. */
  readonly onSkyRingPass?: ((combo: number, boostTrigger: boolean) => void) | undefined;
  /** 별똥별 유성 급강하로 지면에 착지한 순간 호출된다. */
  readonly onMeteorLanded?: (() => void) | undefined;
  /** 중앙 광장 함대 소집 종 근접 여부가 바뀔 때 호출된다(edge-triggered). */
  readonly onNearParadeBellChange?: ((near: boolean) => void) | undefined;
  /** 중앙 광장 함대 우체통 근접 여부가 바뀔 때 호출된다(edge-triggered). */
  readonly onNearMailboxChange?: ((near: boolean) => void) | undefined;
  /** 시냇가 낚시 가능 수변 근접 여부가 바뀔 때 호출된다(edge-triggered). */
  readonly onNearFishingWaterChange?: ((near: boolean) => void) | undefined;
  /** 힐링 낚시 단계가 바뀔 때 호출된다. */
  readonly onFishingPhaseChange?: ((phase: WorldFishingPhase) => void) | undefined;
  /** 입질 윈도우를 놓쳐 물고기가 도망쳤을 때 호출된다. */
  readonly onFishingMissed?: (() => void) | undefined;
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
  setAuroraEnabled(enabled: boolean): void;
  setCinemaMode(enabled: boolean): void;
  setWeather(mode: WorldWeatherMode): void;
  triggerRainbow(durationSec?: number): void;
  setAdmiralStyle(style: WorldAdmiralStyle): void;
  setAdmiralStyle(
    tone: IdentityTone,
    hat: WorldAdmiralHat,
    cape?: WorldAdmiralCape,
    trail?: WorldAdmiralTrail,
  ): void;
  setCommodoreGifts(gifts: Readonly<Record<string, WorldAdmiralHat>>): void;
  setCustomizerMode(open: boolean): void;
  triggerCustomizerPreviewBounce(): void;
  setCampfireSit(sitting: boolean): void;
  setCompanionActors(actorIds: readonly string[]): void;
  triggerWelcomeBriefing(speech: string): void;
  spawnJointMissionArch(fromX: number, fromZ: number, toX: number, toZ: number, colorHex?: number): void;
  setMailboxUnread(hasUnread: boolean): void;
  pickMailboxAt(clientX: number, clientY: number): boolean;
  syncPondFish(speciesIds: readonly string[]): void;
  setOperationFlag(flag: OperationFlagFxInput | null, targetCommodoreId?: string | null): void;
  triggerVillageFirework(villageId?: string): void;
  triggerPhotoGroupPose(): void;
  triggerAdmiralEmote(emote: "cheer" | "wave" | "clap" | "twirl" | "stardust" | "sit"): void;
  captureSnapshotDataUrl(): string | null;
  rallyAllToPlaza(): void;
  ringParadeBell(rallySpeech: string): number;
  startFishing(): boolean;
  reelFishing(commodoreNames: readonly string[]): FishingReelResult;
  cancelFishing(): void;
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
  diveToPoint(x: number, z: number): void;
  pushSpeech(actorId: string, text: string): void;
  pickActorAt(clientX: number, clientY: number): string | null;
  pickDistrictAt(clientX: number, clientY: number): WorldDistrictSpec | null;
  pickVillageAt(clientX: number, clientY: number): WorldVillageSpec | null;
  pickGroundPointAt(clientX: number, clientY: number): { readonly x: number; readonly z: number } | null;
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
const MAX_VILLAGE_SIGN_DIST = 86;
const MAX_OVERVIEW_SIGN_DIST = 260;
const MAX_ACTOR_LABEL_DIST = 58;
const MAX_PLAYER_LABEL_DIST = 44;
const VIEWPORT_MARGIN_X = 160;
const VIEWPORT_MARGIN_Y = 120;
const TOP_SIGN_SAFE_Y = 54;
const TOP_ACTOR_LABEL_SAFE_Y = 44;
const WORKSHOP_FX_INTERVAL_SEC = 0.34;
const MAX_ACTOR_AO_BLOBS = 64;
const EMPTY_OCCLUDERS: readonly CameraOccluder[] = [];
const CO_FISH_BANK_OFFSETS = [-1.75, 1.75, -3.2] as const;

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

// 3D 유성 꼬리 리본 (Shooting Star Ribbon Trail, 28세그먼트 Additive GLSL3)
const METEOR_RIBBON_SEGMENTS = 28;
const METEOR_RIBBON_VERTEX = /* glsl */ `
out vec2 vUv;
out vec3 vWorldPos;
void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const METEOR_RIBBON_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform float uBoost;
uniform int uTrailMode;
in vec2 vUv;
in vec3 vWorldPos;
out vec4 fragColor;

vec3 rainbowPastel(float t) {
  vec3 c = 0.58 + 0.42 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
  return mix(c, vec3(1.0), 0.16);
}

void main() {
  float crossDist = abs(vUv.y * 2.0 - 1.0);
  float edge = clamp(1.0 - crossDist, 0.0, 1.0);
  float core = pow(edge, 2.8);
  float halo = pow(edge, 1.25);

  float headSoft = smoothstep(0.0, 0.10, vUv.x);
  float tailFade = pow(clamp(1.0 - vUv.x, 0.0, 1.0), 1.38);
  float camFade = smoothstep(2.4, 7.6, length(cameraPosition - vWorldPos));
  float shimmer = 0.86 + 0.14 * sin(vUv.x * 26.0 - uTime * 11.0);

  vec3 colHead = vec3(1.0, 0.98, 0.88);
  vec3 colMid = vec3(1.0, 0.84, 0.34);
  vec3 colTail = vec3(0.76, 0.66, 1.0);
  if (uTrailMode == 1) {
    colHead = vec3(1.0, 0.96, 0.98);
    colMid = vec3(1.0, 0.66, 0.84);
    colTail = vec3(0.95, 0.42, 0.72);
  } else if (uTrailMode == 2) {
    colMid = rainbowPastel(vUv.x * 1.15 - uTime * 0.45);
    colTail = rainbowPastel(vUv.x * 1.15 + 0.24 - uTime * 0.45);
  } else if (uTrailMode == 3) {
    colMid = vec3(0.96, 0.93, 0.78);
    colTail = vec3(0.68, 0.76, 0.95);
  }

  vec3 col = mix(colMid, colTail, smoothstep(0.15, 0.88, vUv.x));
  col = mix(col, colHead, core * 0.82);

  float modeGain = (uTrailMode == 3) ? 0.42 : 1.0;
  float alpha = (halo * 0.55 + core * 0.85) * headSoft * tailFade * camFade * shimmer * uAlpha * modeGain * (1.0 + uBoost * 0.42);
  if (alpha < 0.004) discard;
  fragColor = vec4(col * (1.1 + uBoost * 0.45), clamp(alpha, 0.0, 1.0));
}
`;

// 지면 별빛 스포트라이트 & 유성 착지 충격파 링 (단일 PlaneGeometry 재사용)
const STAR_GROUND_RING_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STAR_GROUND_RING_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uMode;
uniform float uProgress;
uniform vec3 uColor;
in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  if (uMode < 0.5) {
    // 비행 중 지면 별빛 스포트라이트 링 + 은은한 회전 4각 별 광채
    float pulse = 0.86 + 0.14 * sin(uTime * 3.4);
    float softDisc = pow(clamp(1.0 - r, 0.0, 1.0), 2.4) * 0.36;
    float outerRing = exp(-pow((r - 0.78) * 14.0, 2.0)) * 0.62;
    float innerRing = exp(-pow((r - 0.42) * 16.0, 2.0)) * 0.28;
    float ang = atan(p.y, p.x) + uTime * 0.85;
    float starRays = pow(abs(cos(ang * 2.0)), 6.0) * smoothstep(0.75, 0.05, r) * 0.34;
    float a = (softDisc + outerRing + innerRing + starRays) * pulse * 0.85;
    if (a < 0.004) discard;
    vec3 col = mix(uColor, vec3(1.0, 0.98, 0.88), softDisc + starRays);
    fragColor = vec4(col * 1.15, clamp(a, 0.0, 0.92));
  } else {
    // 착지 충격파 링 (0.4m -> 7.6m 확장, 이중 황금 파동)
    float fade = pow(clamp(1.0 - uProgress, 0.0, 1.0), 1.35);
    float ring1 = exp(-pow((r - 0.88) * 18.0, 2.0)) * 1.15;
    float ring2 = exp(-pow((r - 0.66) * 13.0, 2.0)) * 0.55;
    float coreFlash = pow(clamp(1.0 - r, 0.0, 1.0), 2.2) * pow(clamp(1.0 - uProgress * 2.2, 0.0, 1.0), 1.4) * 0.85;
    float a = (ring1 + ring2 + coreFlash) * fade;
    if (a < 0.004) discard;
    vec3 col = mix(uColor, vec3(1.0, 0.98, 0.90), clamp(ring1 * 0.55 + coreFlash, 0.0, 1.0));
    fragColor = vec4(col * 1.35, clamp(a, 0.0, 1.0));
  }
}
`;

type MeadowSceneS8 = ReturnType<typeof createMeadowScene> & {
  getSurfaceType?: ((x: number, z: number) => WorldFootstepSurface) | undefined;
  getCameraOccluders?: (() => readonly CameraOccluder[]) | undefined;
};

type MongleActorRigS13 = MongleActorRig & {
  setCape?: ((cape: WorldAdmiralCape) => void) | undefined;
  setHat?: ((hat: WorldAdmiralHat | null) => void) | undefined;
};

const TRAIL_STARDUST_COLORS = [0xffe57f, 0xc4b5fd, 0x7dd3fc] as const;
const TRAIL_SAKURA_COLORS = [0xf9a8d4, 0xfbcfe8, 0xf472b6] as const;
const TRAIL_RAINBOW_COLORS = [0xfca5a5, 0xfdba74, 0xfde047, 0x86efac, 0x7dd3fc, 0xa5b4fc, 0xd8b4fe] as const;
const CINEMA_CYCLE_SEC = 11.0;
const STREAM_BRIDGE_SPOTLIGHT = { x: 8.6, z: 12.35 } as const;

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
  const camera = new PerspectiveCamera(46, 16 / 9, 0.4, 720);

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
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  // 주간에는 블룸 패스를 자동 우회하고, 야간/연출 시에만 반해상도로 발광체를 부드럽게 블룸시킨다.
  const bloomPass = new UnrealBloomPass(new Vector2(400, 300), 0.12, 0.42, 1.12);
  bloomPass.enabled = false;
  composer.addPass(bloomPass);
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  const skyLighting = createSkyAndLighting(scene);
  const meadow = createMeadowScene(scene) as MeadowSceneS8;
  const playerCtrl = createPlayerAndCameraController();
  const director = createChoreographyDirector(scene);
  const livingWorkflowFx = createLivingWorkflowFx(scene, meadow.getGroundHeight);
  const fishing = createFishingController(scene);

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

  // 🌠 3D 쌍발 윙팁 별빛 리본 (Twin Wingtip Starlight Ribbons, 28세그먼트×2 0-GC 링버퍼, 지상 visible=false로 +0)
  const ribbonVertCount = METEOR_RIBBON_SEGMENTS * 2;
  const ribbonPositionsL = new Float32Array(ribbonVertCount * 3);
  const ribbonPositionsR = new Float32Array(ribbonVertCount * 3);
  const ribbonUvs = new Float32Array(ribbonVertCount * 2);
  const ribbonIndices = new Uint16Array((METEOR_RIBBON_SEGMENTS - 1) * 6);
  for (let i = 0; i < METEOR_RIBBON_SEGMENTS; i += 1) {
    const u = i / (METEOR_RIBBON_SEGMENTS - 1);
    ribbonUvs[i * 4 + 0] = u;
    ribbonUvs[i * 4 + 1] = 0;
    ribbonUvs[i * 4 + 2] = u;
    ribbonUvs[i * 4 + 3] = 1;
    if (i < METEOR_RIBBON_SEGMENTS - 1) {
      const bi = i * 2;
      const ii = i * 6;
      ribbonIndices[ii + 0] = bi;
      ribbonIndices[ii + 1] = bi + 1;
      ribbonIndices[ii + 2] = bi + 2;
      ribbonIndices[ii + 3] = bi + 1;
      ribbonIndices[ii + 4] = bi + 3;
      ribbonIndices[ii + 5] = bi + 2;
    }
  }
  const sharedRibbonUvAttr = new BufferAttribute(ribbonUvs, 2);
  const sharedRibbonIndexAttr = new BufferAttribute(ribbonIndices, 1);

  const ribbonGeoL = new BufferGeometry();
  const ribbonPosAttrL = new BufferAttribute(ribbonPositionsL, 3);
  ribbonPosAttrL.setUsage(DynamicDrawUsage);
  ribbonGeoL.setAttribute("position", ribbonPosAttrL);
  ribbonGeoL.setAttribute("uv", sharedRibbonUvAttr);
  ribbonGeoL.setIndex(sharedRibbonIndexAttr);

  const ribbonGeoR = new BufferGeometry();
  const ribbonPosAttrR = new BufferAttribute(ribbonPositionsR, 3);
  ribbonPosAttrR.setUsage(DynamicDrawUsage);
  ribbonGeoR.setAttribute("position", ribbonPosAttrR);
  ribbonGeoR.setAttribute("uv", sharedRibbonUvAttr);
  ribbonGeoR.setIndex(sharedRibbonIndexAttr);

  const ribbonMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: 0 },
      uBoost: { value: 0 },
      uTrailMode: { value: 0 },
    },
    vertexShader: METEOR_RIBBON_VERTEX,
    fragmentShader: METEOR_RIBBON_FRAGMENT,
  });
  const ribbonMeshL = new Mesh(ribbonGeoL, ribbonMat);
  ribbonMeshL.frustumCulled = false;
  ribbonMeshL.renderOrder = 4;
  ribbonMeshL.visible = false;
  scene.add(ribbonMeshL);

  const ribbonMeshR = new Mesh(ribbonGeoR, ribbonMat);
  ribbonMeshR.frustumCulled = false;
  ribbonMeshR.renderOrder = 4;
  ribbonMeshR.visible = false;
  scene.add(ribbonMeshR);

  const ribbonPtsXL = new Float32Array(METEOR_RIBBON_SEGMENTS);
  const ribbonPtsYL = new Float32Array(METEOR_RIBBON_SEGMENTS);
  const ribbonPtsZL = new Float32Array(METEOR_RIBBON_SEGMENTS);
  const ribbonPtsXR = new Float32Array(METEOR_RIBBON_SEGMENTS);
  const ribbonPtsYR = new Float32Array(METEOR_RIBBON_SEGMENTS);
  const ribbonPtsZR = new Float32Array(METEOR_RIBBON_SEGMENTS);
  let ribbonPrimed = false;
  let ribbonFade = 0;

  const updateSingleWingRibbon = (
    ptsX: Float32Array,
    ptsY: Float32Array,
    ptsZ: Float32Array,
    positions: Float32Array,
    posAttr: BufferAttribute,
    baseHalfW: number,
    playerYaw: number,
    camX: number,
    camY: number,
    camZ: number,
  ): void => {
    for (let i = 0; i < METEOR_RIBBON_SEGMENTS; i += 1) {
      const px = ptsX[i]!;
      const py = ptsY[i]!;
      const pz = ptsZ[i]!;
      const prevIdx = i === 0 ? 0 : i - 1;
      const nextIdx = i === METEOR_RIBBON_SEGMENTS - 1 ? i : i + 1;
      let tx = ptsX[prevIdx]! - ptsX[nextIdx]!;
      let ty = ptsY[prevIdx]! - ptsY[nextIdx]!;
      let tz = ptsZ[prevIdx]! - ptsZ[nextIdx]!;
      const tLen = Math.hypot(tx, ty, tz);
      if (tLen > 0.0005) {
        tx /= tLen;
        ty /= tLen;
        tz /= tLen;
      } else {
        tx = Math.sin(playerYaw);
        ty = 0;
        tz = Math.cos(playerYaw);
      }

      let vx = camX - px;
      let vy = camY - py;
      let vz = camZ - pz;
      const vLen = Math.hypot(vx, vy, vz);
      if (vLen > 0.001) {
        vx /= vLen;
        vy /= vLen;
        vz /= vLen;
      } else {
        vx = 0;
        vy = 1;
        vz = 0;
      }
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const sLen = Math.hypot(sx, sy, sz);
      if (sLen > 0.001) {
        sx /= sLen;
        sy /= sLen;
        sz /= sLen;
      } else {
        sx = Math.cos(playerYaw);
        sy = 0;
        sz = -Math.sin(playerYaw);
      }

      const u = i / (METEOR_RIBBON_SEGMENTS - 1);
      const halfW = baseHalfW * (1 - u * 0.92);
      const vi = i * 6;
      positions[vi + 0] = px - sx * halfW;
      positions[vi + 1] = py - sy * halfW;
      positions[vi + 2] = pz - sz * halfW;
      positions[vi + 3] = px + sx * halfW;
      positions[vi + 4] = py + sy * halfW;
      positions[vi + 5] = pz + sz * halfW;
    }
    posAttr.needsUpdate = true;
  };

  // 🌠 지면 별빛 스포트라이트 & 착지 충격파 링 (단일 PlaneGeometry 재사용, 비활성 시 Draw Call +0)
  const groundRingGeo = new PlaneGeometry(2, 2);
  groundRingGeo.rotateX(-Math.PI * 0.5);
  const groundRingColor = new Vector3(1.0, 0.86, 0.36);
  const groundRingMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uMode: { value: 0 },
      uProgress: { value: 0 },
      uColor: { value: groundRingColor },
    },
    vertexShader: STAR_GROUND_RING_VERTEX,
    fragmentShader: STAR_GROUND_RING_FRAGMENT,
  });
  const groundRingMesh = new Mesh(groundRingGeo, groundRingMat);
  groundRingMesh.frustumCulled = false;
  groundRingMesh.renderOrder = 3;
  groundRingMesh.visible = false;
  scene.add(groundRingMesh);

  let shockwaveTimer = 0;
  const SHOCKWAVE_DURATION = 0.65;
  let shockwaveX = 0;
  let shockwaveZ = 0;

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
  let currentActors: readonly WorldActorSpec[] = [];
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
  window.addEventListener("pointercancel", onPointerUp);
  config.canvas.addEventListener("wheel", onWheel, { passive: false });

  // rAF 제로-할당 스크래치 객체들 & 호이스팅 콜백
  const viewProj = new Matrix4();
  const tempPos = new Vector3();
  const tempTint = new Vector3();
  const playerPosVec = new Vector3();
  const focusActorPosScratch = { x: 0, z: 0 };
  const poseScratch = {
    x: 0,
    groundY: 0,
    liftY: 0,
    z: 0,
    yaw: 0,
    state: "idle" as WorldActorSpec["state"],
    activity: null as WorldActorSpec["activity"],
    carrying: false,
    needsAttention: false,
    isSelected: false,
    isNearPlayer: false,
    elapsed: 0,
    fuzz: 0,
    sunDir: skyLighting.sunDir,
    worldTint: tempTint,
    viewProj,
    worldAnim: "idle" as WorldAnimMode,
    expression: "normal" as WorldExpression,
    animPhase: 0,
    moveSpeed: 0,
    jumpVel: 0,
    landSquash: 0,
    lookYaw: 0,
    lookPitch: 0,
    blush: 0,
    hatBounce: 0,
    flightRoll: 0,
    flightPitch: 0,
    nightGlow: 0,
    rainUmbrella: 0,
  };
  const commanderPosPool: Vector3[] = Array.from({ length: 16 }, () => new Vector3());
  const commanderPositions: Vector3[] = [];
  const projTop: ProjectedScratch = { x: 0, y: 0, w: 0 };
  const projBody: ProjectedScratch = { x: 0, y: 0, w: 0 };
  const raycaster = new Raycaster();
  const pickNdc = new Vector2();

  const resolveSurface = (x: number, z: number): WorldFootstepSurface =>
    meadow.getSurfaceType?.(x, z) ?? (meadow.isOnBridge(x, z) ? "wood" : "grass");
  const getCameraOccludersFn = (): readonly CameraOccluder[] =>
    meadow.getCameraOccluders?.() ?? EMPTY_OCCLUDERS;
  const handleCompanionDutyReturn = (actor: WorldActorSpec): void => {
    config.onCompanionDutyReturn?.(actor.id, actor.name);
  };
  const companionFlightCtxScratch = {
    playerYaw: 0,
    playerTakeoffPhase: "none" as "none" | "charge" | "ascend",
    playerTakeoffProgress: 0,
    playerFlying: false,
    playerDiving: false,
    playerBoosting: false,
    playerVx: 0,
    playerVz: 0,
    playerFlightAlt: 0,
    playerMoveSpeed: 0,
    playerFlightRoll: 0,
    playerFlightPitch: 0,
    playerBarrelRollTimer: 0,
    playerHeroLandTimer: 0,
    playerSittingAtCampfire: false,
    onCompanionDutyReturn: handleCompanionDutyReturn,
  };
  const handleBobberSplash = (sx: number, sy: number, sz: number): void => {
    playFishingCast();
    director.spawnBurst(sx, sy + 0.10, sz, 0xbae6fd, 10);
    for (let k = 0; k < 4; k += 1) {
      const ang = (k / 4) * Math.PI * 2 + 0.35;
      director.spawnTrailSparkle(
        sx + Math.cos(ang) * 0.28,
        sy + 0.14,
        sz + Math.sin(ang) * 0.28,
        0xffffff,
        0.58,
        true,
      );
    }
  };

  const actorPosPool: WorldFrameActorPosition[] = [];
  const visibleActorIdx = new Int32Array(64);
  const actorHasSpeechFlags = new Uint8Array(64);
  const actorPriorityFlags = new Uint8Array(64);
  const villagePosPool: WorldFrameVillagePosition[] = [];
  const topVillageIdx = new Int32Array(MAX_OVERVIEW_VILLAGE_SIGNS);
  const topVillageDist = new Float64Array(MAX_OVERVIEW_VILLAGE_SIGNS);
  const companionAnglerPool: { id: string; x: number; y: number; z: number; yaw: number }[] = [
    { id: "", x: 0, y: 0.28, z: 0, yaw: 0 },
    { id: "", x: 0, y: 0.28, z: 0, yaw: 0 },
    { id: "", x: 0, y: 0.28, z: 0, yaw: 0 },
  ];
  const companionAnglersOut: CompanionAnglerPose[] = [];
  const activeCoFishingIds = new Set<string>();
  let companionAnglersSyncedNonEmpty = false;
  const nearestRingOut: SkyRingPositionOut = { x: 0, y: 0, z: 0, distM: 0 };
  const ringCamScratch = new Vector3();
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
    guildHall: WorldFramePointPosition;
    campfireBench: WorldFramePointPosition;
    ringGuide: WorldFrameRingGuide;
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
    guildHall: { x: 0, y: 0, visible: false },
    campfireBench: { x: 0, y: 0, visible: false },
    ringGuide: { visible: false, xPx: 0, yPx: 0, xPct: 50, yPct: 50, angleRad: 0, distM: 0 },
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
  let prevNearParadeBell = false;
  let prevNearMailbox = false;
  let prevNearFishingWater = false;
  let lastNotifiedFishingPhase: WorldFishingPhase = "idle";
  const notifyFishingPhase = (next: WorldFishingPhase): void => {
    if (next === lastNotifiedFishingPhase) return;
    lastNotifiedFishingPhase = next;
    config.onFishingPhaseChange?.(next);
  };
  const cancelFishingInternal = (): void => {
    if (fishing.getPhase() !== "idle") {
      fishing.cancel();
    }
    if (companionAnglersSyncedNonEmpty) {
      companionAnglersOut.length = 0;
      activeCoFishingIds.clear();
      fishing.syncCompanionAnglers(companionAnglersOut, elapsed);
      companionAnglersSyncedNonEmpty = false;
    }
    notifyFishingPhase("idle");
  };
  let spatialAmbienceAccum = 0;
  const spatialAmbienceScratch = {
    brookDist: 999,
    campfireDist: 999,
    forestDist: 999,
    isNight: false,
    isRain: false,
    active: false,
  };
  let sprintDustAccum = 0;
  let stardustAccum = 0;
  let stardustStep = 0;
  let playerEmoteHop = 0;
  let playerEmoteKind: "wave" | "cheer" | "spin" | "clap" | "twirl" | null = null;
  let rainUmbrellaLevel = 0;
  let customizerOpen = false;
  let cinemaMode = false;
  let cinemaTimer = 0;
  let cinemaStopIndex = 0;
  let lastCinemaSpotlight = "";
  let currentAdmiralTrail: WorldAdmiralTrail = "stardust";
  let currentCommodoreGifts: Record<string, WorldAdmiralHat> = {};
  let snapshotPrimed = false;
  const prevVillageDoneCounts = new Map<string, number>();
  let lastBgmNight = -1;
  let lastBgmWeather: WorldWeatherMode | null = null;
  const cinemaTargetScratch: { x: number; y: number; z: number; dist: number; pitch: number } = {
    x: 0,
    y: 1.0,
    z: 0,
    dist: 9.0,
    pitch: 0.30,
  };
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
  const isEnglishDoc = () =>
    typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("en");

  const resolveTrailColor = (trail: WorldAdmiralTrail, step: number): number | null => {
    if (trail === "none") return null;
    if (trail === "sakura") return TRAIL_SAKURA_COLORS[step % TRAIL_SAKURA_COLORS.length]!;
    if (trail === "rainbow") return TRAIL_RAINBOW_COLORS[step % TRAIL_RAINBOW_COLORS.length]!;
    return TRAIL_STARDUST_COLORS[step % TRAIL_STARDUST_COLORS.length]!;
  };

  const resolveToneHex = (tone: IdentityTone | undefined): number => {
    if (!tone) return 0xfbbf24;
    const rgb = PLUSH_VIVID_TONES[tone];
    return (Math.round(rgb[0] * 255) << 16)
      | (Math.round(rgb[1] * 255) << 8)
      | Math.round(rgb[2] * 255);
  };

  const applyGiftHatForSpec = (
    spec: { readonly id: string; readonly role: string; readonly commodoreId?: string | undefined },
    rig: MongleActorRig,
  ): void => {
    if (spec.role !== "commodore") return;
    const gift = (spec.commodoreId ? currentCommodoreGifts[spec.commodoreId] : undefined)
      ?? currentCommodoreGifts[spec.id]
      ?? null;
    (rig as MongleActorRigS13).setHat?.(gift);
  };

  const resolveCinemaSpotlight = (index: number): { readonly target: CinemaCameraTarget; readonly label: string } => {
    // 순회 후보: (1) 작업 중인 사령관들 → (2) 중앙 모닥불 → (3) 시냇물 목교 → (4) 최고 Tier 마을
    const stops: { x: number; y: number; z: number; dist: number; pitch: number; label: string }[] = [];
    for (const m of director.motions.values()) {
      if (m.spec.role !== "commodore") continue;
      const village = currentVillages.find((v) => v.commodoreId === m.spec.commodoreId);
      const working = m.spec.state === "running" || m.spec.activity !== null || (village?.workStep ?? null) !== null;
      if (working) {
        const gy = meadow.getGroundHeight(m.x, m.z);
        stops.push({
          x: m.x,
          y: gy + 0.92,
          z: m.z,
          dist: 7.4,
          pitch: 0.28,
          label: m.spec.name,
        });
      }
    }
    const en = isEnglishDoc();
    // 중앙 모닥불 광장
    const cfGy = meadow.getGroundHeight(WORLD_CAMPFIRE_BENCH_POS.faceX, WORLD_CAMPFIRE_BENCH_POS.faceZ);
    stops.push({
      x: WORLD_CAMPFIRE_BENCH_POS.faceX,
      y: cfGy + 0.85,
      z: WORLD_CAMPFIRE_BENCH_POS.faceZ,
      dist: 8.6,
      pitch: 0.30,
      label: en ? "Central Campfire" : "중앙 모닥불",
    });
    // 동쪽 시냇물 아치 목교
    const brGy = meadow.getGroundHeight(STREAM_BRIDGE_SPOTLIGHT.x, STREAM_BRIDGE_SPOTLIGHT.z);
    stops.push({
      x: STREAM_BRIDGE_SPOTLIGHT.x,
      y: brGy + 0.95,
      z: STREAM_BRIDGE_SPOTLIGHT.z,
      dist: 10.4,
      pitch: 0.34,
      label: en ? "Stream Bridge" : "시냇물 목교",
    });
    // 최고 발전 Tier 마을
    let topVillage: WorldVillageSpec | null = null;
    for (const v of currentVillages) {
      if (!topVillage || v.overallTier > topVillage.overallTier || (v.overallTier === topVillage.overallTier && v.totalEntries > topVillage.totalEntries)) {
        topVillage = v;
      }
    }
    if (topVillage) {
      const vGy = meadow.getGroundHeight(topVillage.x, topVillage.z);
      stops.push({
        x: topVillage.x,
        y: vGy + 1.35,
        z: topVillage.z,
        dist: 13.6,
        pitch: 0.42,
        label: `${topVillage.label} · ${topVillage.overallTierCode}`,
      });
    }
    const chosen = stops[Math.abs(index) % stops.length]!;
    cinemaTargetScratch.x = chosen.x;
    cinemaTargetScratch.y = chosen.y;
    cinemaTargetScratch.z = chosen.z;
    cinemaTargetScratch.dist = chosen.dist;
    cinemaTargetScratch.pitch = chosen.pitch;
    return { target: cinemaTargetScratch, label: chosen.label };
  };

  const resolvePlayerJump = (): void => {
    playJump();
    if (currentAdmiralTrail === "none") return;
    const pCur = playerCtrl.player;
    const bx = -Math.sin(pCur.yaw) * 0.24;
    const bz = -Math.cos(pCur.yaw) * 0.24;
    for (let k = 0; k < 5; k += 1) {
      const c = resolveTrailColor(currentAdmiralTrail, k);
      if (c !== null) {
        director.spawnTrailSparkle(
          pCur.x + bx + (Math.random() - 0.5) * 0.36,
          pCur.y + 0.24 + k * 0.05,
          pCur.z + bz + (Math.random() - 0.5) * 0.36,
          c,
          0.78,
          currentAdmiralTrail !== "sakura",
        );
      }
    }
  };

  const resolvePlayerLand = (): void => {
    const px = playerCtrl.player.x;
    const py = playerCtrl.player.y;
    const pz = playerCtrl.player.z;
    const surface = resolveSurface(px, pz);
    playFootstep(false, meadow.getSurfaceMaterial(px, pz));
    if (surface === "water") {
      director.spawnBurst(px, py + 0.10, pz, 0x7dd3fc, 8);
    } else {
      director.spawnDust(px, py + 0.06, pz);
      director.spawnDust(px + 0.16, py + 0.06, pz - 0.12);
      director.spawnDust(px - 0.16, py + 0.06, pz + 0.12);
    }
    if (currentAdmiralTrail !== "none") {
      for (let k = 0; k < 3; k += 1) {
        const c = resolveTrailColor(currentAdmiralTrail, k);
        if (c !== null) {
          director.spawnTrailSparkle(
            px + (Math.random() - 0.5) * 0.42,
            py + 0.18 + k * 0.05,
            pz + (Math.random() - 0.5) * 0.42,
            c,
            0.72,
            currentAdmiralTrail !== "sakura",
          );
        }
      }
    }
  };

  const resolveStarTakeoffCharge = (): void => {
    playStarTakeoffCharge();
    ribbonPrimed = false;
    const pCur = playerCtrl.player;
    director.reactToStarTakeoff(pCur.x, pCur.z);
    const theme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;
    for (let k = 0; k < 8; k += 1) {
      const c = resolveTrailColor(theme, k) ?? 0xffe57f;
      const ang = (k / 8) * Math.PI * 2;
      director.spawnTrailSparkle(
        pCur.x + Math.cos(ang) * 0.95,
        pCur.y + 0.32 + (k % 3) * 0.14,
        pCur.z + Math.sin(ang) * 0.95,
        c,
        0.84,
        true,
      );
    }
  };

  const resolveStarTakeoffAscend = (): void => {
    playStarTakeoffAscend();
    ribbonPrimed = false;
    const pCur = playerCtrl.player;
    const theme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;
    director.spawnBurst(pCur.x, pCur.y + 0.45, pCur.z, resolveTrailColor(theme, 0) ?? 0xffe57f, 14);
    for (let k = 0; k < 10; k += 1) {
      const c = resolveTrailColor(theme, k) ?? 0xffe57f;
      const ang = (k / 10) * Math.PI * 2;
      director.spawnTrailSparkle(
        pCur.x + Math.cos(ang) * 0.65,
        pCur.y + 0.28 + (k % 3) * 0.18,
        pCur.z + Math.sin(ang) * 0.65,
        c,
        0.94,
        true,
      );
    }
  };

  const resolveMeteorDive = (): void => {
    playMeteorDive();
    ribbonPrimed = false;
  };

  const resolveStarBoost = (): void => {
    playStarBoost();
  };

  const resolveBarrelRoll = (): void => {
    playBarrelRoll();
    const pCur = playerCtrl.player;
    const theme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;
    const sideX = Math.cos(pCur.yaw);
    const sideZ = -Math.sin(pCur.yaw);
    for (let k = 0; k < 12; k += 1) {
      const c = resolveTrailColor(theme, k) ?? 0xffe57f;
      const ang = (k / 12) * Math.PI * 2;
      const rX = Math.cos(ang) * 0.82;
      const rY = Math.sin(ang) * 0.82;
      director.spawnTrailSparkle(
        pCur.x + sideX * rX,
        pCur.y + 0.56 + rY,
        pCur.z + sideZ * rX,
        c,
        0.90,
        true,
      );
    }
  };

  const resolveMeteorImpact = (ix: number, iz: number): void => {
    playMeteorImpact();
    shockwaveX = ix;
    shockwaveZ = iz;
    shockwaveTimer = SHOCKWAVE_DURATION;
    const impactGy = Math.max(-0.05, meadow.getGroundHeight(ix, iz));
    const theme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;
    const burstColor = resolveTrailColor(theme, 0) ?? 0xffe57f;
    director.spawnBurst(ix, impactGy + 0.42, iz, burstColor, 22);
    for (let k = 0; k < 12; k += 1) {
      const c = resolveTrailColor(theme, k) ?? 0xffe57f;
      const ang = (k / 12) * Math.PI * 2;
      const rad = 0.55 + (k % 3) * 0.35;
      director.spawnTrailSparkle(
        ix + Math.cos(ang) * rad,
        impactGy + 0.22 + (k % 2) * 0.16,
        iz + Math.sin(ang) * rad,
        c,
        0.96,
        true,
      );
    }
    director.reactToMeteorLanding(ix, iz);
    livingWorkflowFx.resetSkyRingCombo();
    config.onMeteorLanded?.();
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
    const cinemaActiveNow = cinemaMode && !interacting && !customizerOpen && currentLifecycle === "open";
    let activeCinemaTarget: CinemaCameraTarget | null = null;
    if (cinemaActiveNow) {
      cinemaTimer += dt;
      if (cinemaTimer >= CINEMA_CYCLE_SEC) {
        cinemaTimer -= CINEMA_CYCLE_SEC;
        cinemaStopIndex += 1;
      }
      const spot = resolveCinemaSpotlight(cinemaStopIndex);
      activeCinemaTarget = spot.target;
      if (spot.label !== lastCinemaSpotlight) {
        lastCinemaSpotlight = spot.label;
        config.onCinemaSpotlight?.(spot.label);
      }
    }

    const focusFraming: CameraFocusFraming =
      focusedMotion !== null
        ? interactionKey === "dialogue"
          ? "dialogue"
          : interactionKey === "chat" || interactionKey === "goals" || interactionKey === "info" || interactionKey === "settings"
            ? "drawer"
            : "none"
        : customizerOpen
          ? "customizer"
          : cinemaActiveNow
            ? "cinema"
            : "none";

    if (
      fishing.getPhase() !== "idle"
      && (
        interacting
        || customizerOpen
        || cinemaActiveNow
        || playerCtrl.isOverviewMode()
        || playerCtrl.isSittingAtCampfire()
        || playerCtrl.player.flying
        || playerCtrl.player.diving
        || currentLifecycle !== "open"
      )
    ) {
      cancelFishingInternal();
    }
    const isFishingActive = fishing.getPhase() !== "idle";

    if (focusedMotion) {
      focusActorPosScratch.x = focusedMotion.x;
      focusActorPosScratch.z = focusedMotion.z;
    }

    playerCtrl.update({
      dt,
      lifecycle: currentLifecycle,
      cameraMode: currentCameraMode,
      reducedMotion: config.isReducedMotion(),
      inputLocked: interacting || customizerOpen || cinemaActiveNow || isFishingActive,
      focusActorPos: focusedMotion ? focusActorPosScratch : null,
      focusFraming,
      cinemaTarget: activeCinemaTarget,
      companionCount: director.getCompanionActorIds().length,
      camera,
      getGroundHeight: meadow.getGroundHeight,
      resolveMovement: meadow.resolveMovement,
      getCameraOccluders: getCameraOccludersFn,
      onDustParticle: director.spawnDust,
      onOverviewAutoExit: config.onOverviewAutoExit,
      onJump: resolvePlayerJump,
      onLand: resolvePlayerLand,
      onStandUp: config.onCampfireStandUp,
      onStarTakeoffCharge: resolveStarTakeoffCharge,
      onStarTakeoffAscend: resolveStarTakeoffAscend,
      onMeteorDive: resolveMeteorDive,
      onStarBoost: resolveStarBoost,
      onBarrelRoll: resolveBarrelRoll,
      onMeteorImpact: resolveMeteorImpact,
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

    // ⭐ 드레스업 시즌2 제독 4종 이동 궤적(`stardust`/`sakura`/`rainbow`/`none`, 기존 단일 파티클 풀 재사용, Draw Call +0)
    // 지상 보행·질주·체공 + 별빛 비행·유성 급강하 코멧 스파클 통합 처리
    if (
      currentLifecycle === "open"
      && !config.isReducedMotion()
      && (currentAdmiralTrail !== "none" || playerCtrl.player.flying || playerCtrl.player.diving)
    ) {
      const pCur = playerCtrl.player;
      const isChargeNow = pCur.takeoffPhase === "charge";
      const isAscendNow = pCur.takeoffPhase === "ascend";
      const isDivingNow = pCur.diving;
      const isFlyingNow = pCur.flying && !isChargeNow && !isAscendNow;
      const isAirborne = !isChargeNow && !isAscendNow && !isFlyingNow && !isDivingNow && !pCur.onGround && pCur.playerJumpY > 0.12;
      const isSprintingNow = !isChargeNow && !isAscendNow && !isFlyingNow && !isDivingNow && playerCtrl.isSprinting() && pCur.onGround;
      const isWalkingNow = !isChargeNow && !isAscendNow && !isFlyingNow && !isDivingNow && pCur.walking && pCur.onGround && !isSprintingNow;
      const trailTheme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;

      if (isChargeNow || isAscendNow || isDivingNow || isFlyingNow || isSprintingNow || isWalkingNow || isAirborne) {
        const interval = isAscendNow
          ? 0.028
          : isChargeNow
            ? 0.055
            : isDivingNow
              ? 0.032
              : isFlyingNow
                ? (pCur.boosting ? 0.055 : 0.11)
                : isSprintingNow
                  ? 0.083
                  : isAirborne
                    ? 0.14
                    : 0.285;
        stardustAccum += dt;
        if (stardustAccum >= interval) {
          stardustAccum -= interval;
          if (stardustAccum > interval) stardustAccum = 0;
          const colorHex = resolveTrailColor(trailTheme, stardustStep);
          stardustStep = (stardustStep + 1) % 42;
          if (isChargeNow) {
            // 1단계 화이팅 충전: 제독 주변에서 안쪽으로 모여들며 솟아오르는 황금 에너지 스파클
            const ang = elapsed * 7.5 + stardustStep * 1.15;
            const rad = Math.max(0.28, (1 - pCur.takeoffProgress) * 1.15 + 0.25);
            director.spawnTrailSparkle(
              pCur.x + Math.cos(ang) * rad,
              pCur.y + 0.25 + pCur.takeoffProgress * 0.55,
              pCur.z + Math.sin(ang) * rad,
              colorHex ?? 0xffe57f,
              0.78,
              true,
            );
          } else if (isAscendNow) {
            // 2단계 회오리 급상승: 아래로 뿜어지는 이중 나선 별가루 소용돌이
            const ang = elapsed * 18.0 + stardustStep * 0.9;
            const rad = 0.52 + (1 - pCur.takeoffProgress) * 0.35;
            director.spawnTrailSparkle(
              pCur.x + Math.cos(ang) * rad,
              Math.max(0.15, pCur.y - 0.18),
              pCur.z + Math.sin(ang) * rad,
              colorHex ?? 0xffe57f,
              0.92,
              false,
            );
            const color2 = resolveTrailColor(trailTheme, stardustStep + 1);
            if (color2 !== null) {
              director.spawnTrailSparkle(
                pCur.x - Math.cos(ang) * rad,
                Math.max(0.15, pCur.y - 0.32),
                pCur.z - Math.sin(ang) * rad,
                color2,
                0.76,
                false,
              );
            }
          } else {
            const backX = -Math.sin(pCur.yaw);
            const backZ = -Math.cos(pCur.yaw);
            const sideX = Math.cos(pCur.yaw);
            const sideZ = -Math.sin(pCur.yaw);
            const jitter = ((stardustStep % 5) - 2) * (isFlyingNow || isDivingNow ? 0.16 : 0.11);
            const trailDist = isDivingNow ? 0.55 : isFlyingNow ? 0.52 : isSprintingNow ? 0.44 : 0.30;
            const sx = pCur.x + backX * trailDist + sideX * jitter;
            const sz = pCur.z + backZ * trailDist + sideZ * jitter;
            const sy = pCur.y + (isDivingNow ? 0.62 : isFlyingNow ? 0.48 : isAirborne ? 0.38 : isSprintingNow ? 0.32 + (stardustStep % 2) * 0.22 : 0.26);
            if (colorHex !== null) {
              const driftUp = trailTheme !== "sakura";
              const scale = isDivingNow ? 0.94 : isFlyingNow ? (pCur.boosting ? 0.88 : 0.74) : isSprintingNow ? 0.78 : isAirborne ? 0.72 : 0.64;
              director.spawnTrailSparkle(sx, sy, sz, colorHex, scale, driftUp);
              if ((isSprintingNow || isDivingNow || (isFlyingNow && pCur.boosting)) && stardustStep % 2 === 0) {
                const color2 = resolveTrailColor(trailTheme, stardustStep + 1);
                if (color2 !== null) {
                  director.spawnTrailSparkle(sx - sideX * 0.18, sy + 0.12, sz - sideZ * 0.18, color2, scale * 0.82, driftUp);
                }
              }
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
        playFootstep(playerCtrl.isSprinting(), meadow.getSurfaceMaterial(playerCtrl.player.x, playerCtrl.player.z));
      }
    }
    prevPlayerX = playerCtrl.player.x;
    prevPlayerZ = playerCtrl.player.z;

    companionFlightCtxScratch.playerYaw = playerCtrl.player.yaw;
    companionFlightCtxScratch.playerTakeoffPhase = playerCtrl.player.takeoffPhase;
    companionFlightCtxScratch.playerTakeoffProgress = playerCtrl.player.takeoffProgress;
    companionFlightCtxScratch.playerFlying = playerCtrl.player.flying;
    companionFlightCtxScratch.playerDiving = playerCtrl.player.diving;
    companionFlightCtxScratch.playerBoosting = playerCtrl.player.boosting;
    companionFlightCtxScratch.playerVx = playerCtrl.player.vx;
    companionFlightCtxScratch.playerVz = playerCtrl.player.vz;
    companionFlightCtxScratch.playerFlightAlt = playerCtrl.player.flightAlt;
    companionFlightCtxScratch.playerMoveSpeed = playerCtrl.player.moveSpeed;
    companionFlightCtxScratch.playerFlightRoll = playerCtrl.player.flightRoll;
    companionFlightCtxScratch.playerFlightPitch = playerCtrl.player.flightPitch;
    companionFlightCtxScratch.playerBarrelRollTimer = playerCtrl.player.barrelRollTimer;
    companionFlightCtxScratch.playerHeroLandTimer = playerCtrl.player.heroLandTimer;
    companionFlightCtxScratch.playerSittingAtCampfire = playerCtrl.isSittingAtCampfire();

    const nearIdRaw = director.update(
      dt,
      elapsed,
      skyLighting.nightFactor,
      playerPosVec,
      focusedActorId,
      meadow.isWalkable,
      meadow.resolveMovement,
      companionFlightCtxScratch,
    );
    const nearId = (playerCtrl.player.flying || playerCtrl.player.diving) ? null : nearIdRaw;
    config.onNearActorChanged(nearId);

    // 리빙 워크플로우 3D 비주얼 FX (긴급 비콘 기둥 · 별빛 전령 구슬 · 마을 목표 진행 크리스탈 · 하늘 별빛 링 · 합동 아치 · 정문 결재 비콘)
    const prevFishingPhase = fishing.getPhase();
    const nextFishingPhase = fishing.update(
      dt,
      elapsed,
      playerCtrl.player.x,
      playerCtrl.player.y,
      playerCtrl.player.z,
      playerCtrl.player.yaw,
      handleBobberSplash,
    );
    if (nextFishingPhase !== "idle" && nextFishingPhase !== "caught") {
      // 낚시 중 별 제독이 찌 방향을 자연스럽게 마주보도록 회전 동기화
      const targetFishYaw = fishing.getCastTargetYaw();
      playerCtrl.player.yaw += angleDelta(targetFishYaw, playerCtrl.player.yaw) * Math.min(1, dt * 11.0);

      // 동행 사령관 최대 3명이 시냇가 양옆에 자리 잡고 함께 미니 낚싯대·찌 드리우기 (0-GC 풀링)
      const compIds = director.getCompanionActorIds();
      companionAnglersOut.length = 0;
      activeCoFishingIds.clear();
      if (compIds.length > 0) {
        const pProf = brookProfile(playerCtrl.player.x);
        const bankSign = playerCtrl.player.z >= pProf.centerZ ? 1 : -1;
        const slideLerp = Math.min(1, dt * 4.5);
        for (let ci = 0; ci < compIds.length && companionAnglersOut.length < CO_FISH_BANK_OFFSETS.length; ci += 1) {
          const cid = compIds[ci]!;
          const m = director.motions.get(cid);
          if (!m || m.flightAlt >= 0.5) continue;
          const slotIdx = companionAnglersOut.length;
          const bx = Math.max(-78, Math.min(78, playerCtrl.player.x + CO_FISH_BANK_OFFSETS[slotIdx]!));
          const bProf = brookProfile(bx);
          const bz = bProf.centerZ + bankSign * (bProf.halfWidth + 0.95);
          const nextPos = meadow.resolveMovement(
            m.x,
            m.z,
            m.x + (bx - m.x) * slideLerp,
            m.z + (bz - m.z) * slideLerp,
            0.48,
          );
          m.x = nextPos.x;
          m.z = nextPos.z;
          m.tx = nextPos.x;
          m.tz = nextPos.z;
          const faceWaterYaw = Math.atan2(0, bProf.centerZ - m.z);
          m.yaw += angleDelta(faceWaterYaw, m.yaw) * Math.min(1, dt * 10.0);
          m.moving = false;
          m.moveSpeed = 0;
          m.worldAnim = "fish-wait";
          m.expression = nextFishingPhase === "bite" ? "surprised" : "happy";
          m.blush = nextFishingPhase === "bite" ? 0.55 : 0.28;
          const pose = companionAnglerPool[slotIdx]!;
          pose.id = m.spec.id;
          pose.x = m.x;
          pose.y = meadow.getGroundHeight(m.x, m.z);
          pose.z = m.z;
          pose.yaw = m.yaw;
          companionAnglersOut.push(pose);
          activeCoFishingIds.add(m.spec.id);
        }
      }
      if (companionAnglersOut.length > 0 || companionAnglersSyncedNonEmpty) {
        fishing.syncCompanionAnglers(companionAnglersOut, elapsed);
        companionAnglersSyncedNonEmpty = companionAnglersOut.length > 0;
      }
    } else if (companionAnglersSyncedNonEmpty) {
      companionAnglersOut.length = 0;
      if (nextFishingPhase === "idle") {
        activeCoFishingIds.clear();
      }
      fishing.syncCompanionAnglers(companionAnglersOut, elapsed);
      companionAnglersSyncedNonEmpty = false;
    }
    if (nextFishingPhase !== prevFishingPhase) {
      if (nextFishingPhase === "bite") {
        playFishingBite();
      } else if (prevFishingPhase === "bite" && nextFishingPhase === "idle") {
        config.onFishingMissed?.();
      }
      notifyFishingPhase(fishing.getUiPhase());
    }

    const onGroundOpen =
      currentLifecycle === "open"
      && !playerCtrl.isOverviewMode()
      && !playerCtrl.player.flying
      && !playerCtrl.player.diving;
    const nearBellNow =
      onGroundOpen
      && Math.hypot(playerCtrl.player.x - PARADE_BELL_POS.x, playerCtrl.player.z - PARADE_BELL_POS.z) <= 3.1;
    if (nearBellNow !== prevNearParadeBell) {
      prevNearParadeBell = nearBellNow;
      config.onNearParadeBellChange?.(nearBellNow);
    }
    const nearMailboxNow =
      onGroundOpen
      && Math.hypot(playerCtrl.player.x - MAILBOX_POS.x, playerCtrl.player.z - MAILBOX_POS.z) <= MAILBOX_POS.radius + 1.55;
    if (nearMailboxNow !== prevNearMailbox) {
      prevNearMailbox = nearMailboxNow;
      config.onNearMailboxChange?.(nearMailboxNow);
    }
    const nearWaterNow =
      onGroundOpen
      && !playerCtrl.isSittingAtCampfire()
      && fishing.isNearWater(playerCtrl.player.x, playerCtrl.player.z);
    if (nearWaterNow !== prevNearFishingWater) {
      prevNearFishingWater = nearWaterNow;
      config.onNearFishingWaterChange?.(nearWaterNow);
    }

    livingWorkflowFx.setSkyRingsVisible(playerCtrl.isOverviewMode());
    if (playerCtrl.player.flying) {
      const ringHit = livingWorkflowFx.checkSkyRingPass(
        playerCtrl.player.x,
        playerCtrl.player.y,
        playerCtrl.player.z,
        true,
      );
      if (ringHit) {
        playerCtrl.triggerSkyBoostBurst(1.8);
        playSkyRingPass(ringHit.comboCount);
        director.triggerSquadronRingBoost();
        config.onSkyRingPass?.(ringHit.comboCount, ringHit.boostTrigger);
      }
    }
    livingWorkflowFx.update(dt, elapsed, currentVillages, currentActors);

    // 거리 기반 공간 자연음 (시냇물·모닥불·숲, 0.12s 스로틀, 0-GC)
    spatialAmbienceAccum += dt;
    if (spatialAmbienceAccum >= 0.12) {
      spatialAmbienceAccum = 0;
      spatialAmbienceScratch.brookDist = meadow.getNearestBrookDist(playerCtrl.player.x, playerCtrl.player.z);
      spatialAmbienceScratch.campfireDist = Math.hypot(playerCtrl.player.x - 2.8, playerCtrl.player.z - 1.0);
      spatialAmbienceScratch.forestDist = meadow.getNearestForestDist(playerCtrl.player.x, playerCtrl.player.z);
      spatialAmbienceScratch.isNight = skyLighting.getNightFactor() > 0.45;
      spatialAmbienceScratch.isRain = currentWeather === "rain";
      spatialAmbienceScratch.active = currentLifecycle === "open";
      updateSpatialAmbience(spatialAmbienceScratch);
    }

    // 우천 연잎 우산 부드러운 0↔1 개폐 보간
    const rainTarget = currentWeather === "rain" ? 1 : 0;
    rainUmbrellaLevel += (rainTarget - rainUmbrellaLevel) * Math.min(1, dt * 4.2);
    if (rainUmbrellaLevel < 0.005) rainUmbrellaLevel = 0;
    else if (rainUmbrellaLevel > 0.995) rainUmbrellaLevel = 1;

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
    if (Math.abs(skyLighting.nightFactor - lastBgmNight) > 0.05 || currentWeather !== lastBgmWeather) {
      lastBgmNight = skyLighting.nightFactor;
      lastBgmWeather = currentWeather;
      updateBgmEnvironment(skyLighting.nightFactor, currentWeather);
    }
    scene.environmentIntensity = 0.42 * (1 - skyLighting.nightFactor * 0.65);
    meadow.update(dt, elapsed, skyLighting.nightFactor, skyLighting.sunDir);

    const useBloom =
      skyLighting.nightFactor > 0.02
      || director.hasActiveFx()
      || playerCtrl.player.flying
      || playerCtrl.player.diving
      || shockwaveTimer > 0;
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
      ? Math.sin(Math.min(1, playerEmoteHop) * Math.PI) * (playerEmoteKind === "spin" || playerEmoteKind === "twirl" ? 0.68 : 0.42)
      : 0;
    const pTotalLift = p.playerJumpY + pHop + pEmoteLift;

    // 🌠 3D 쌍발 윙팁 별빛 리본 갱신 (좌/우 28세그먼트 0-GC 링버퍼, 에이스 추격 시점 눈부심 방지 · 정지 호버 감쇠)
    const ribbonActive = currentLifecycle === "open" && (p.diving || (p.flying && p.takeoffPhase !== "charge"));
    ribbonFade = ribbonActive
      ? Math.min(1, ribbonFade + dt * 6.5)
      : Math.max(0, ribbonFade - dt * 3.8);
    if (ribbonActive || ribbonFade > 0.005) {
      const fwdX = Math.sin(p.yaw);
      const fwdZ = Math.cos(p.yaw);
      const rightX = Math.cos(p.yaw);
      const rightZ = -Math.sin(p.yaw);
      const wingSpan = p.diving ? 0.42 : 0.56;
      const headBack = p.diving ? 0.48 : 0.54;
      const rollTiltY = Math.sin(p.flightRoll) * 0.24;
      const waveL = Math.sin(elapsed * 8.5) * 0.05;
      const waveR = Math.sin(elapsed * 8.5 + 1.6) * 0.05;

      const baseHeadX = p.x - fwdX * headBack;
      const baseHeadY = pGround + pTotalLift + 0.56;
      const baseHeadZ = p.z - fwdZ * headBack;
      const headXL = baseHeadX - rightX * wingSpan;
      const headYL = baseHeadY + rollTiltY + waveL;
      const headZL = baseHeadZ - rightZ * wingSpan;
      const headXR = baseHeadX + rightX * wingSpan;
      const headYR = baseHeadY - rollTiltY + waveR;
      const headZR = baseHeadZ + rightZ * wingSpan;

      if (!ribbonPrimed) {
        ribbonPrimed = true;
        for (let i = 0; i < METEOR_RIBBON_SEGMENTS; i += 1) {
          ribbonPtsXL[i] = headXL;
          ribbonPtsYL[i] = headYL;
          ribbonPtsZL[i] = headZL;
          ribbonPtsXR[i] = headXR;
          ribbonPtsYR[i] = headYR;
          ribbonPtsZR[i] = headZR;
        }
      } else {
        for (let i = METEOR_RIBBON_SEGMENTS - 1; i > 0; i -= 1) {
          ribbonPtsXL[i] = ribbonPtsXL[i - 1]!;
          ribbonPtsYL[i] = ribbonPtsYL[i - 1]!;
          ribbonPtsZL[i] = ribbonPtsZL[i - 1]!;
          ribbonPtsXR[i] = ribbonPtsXR[i - 1]!;
          ribbonPtsYR[i] = ribbonPtsYR[i - 1]!;
          ribbonPtsZR[i] = ribbonPtsZR[i - 1]!;
        }
        ribbonPtsXL[0] = headXL;
        ribbonPtsYL[0] = headYL;
        ribbonPtsZL[0] = headZL;
        ribbonPtsXR[0] = headXR;
        ribbonPtsYR[0] = headYR;
        ribbonPtsZR[0] = headZR;
      }

      const boostAmt = p.diving || p.takeoffPhase === "ascend" ? 1.0 : p.boosting ? 0.92 : Math.min(0.42, p.moveSpeed / 30);
      const speedT = p.diving || p.takeoffPhase === "ascend"
        ? 1.0
        : Math.max(0, Math.min(1, (p.moveSpeed - 1.2) / (7.5 - 1.2)));
      const hoverSpeedFade = speedT * speedT * (3 - 2 * speedT);
      const baseHalfW = p.diving || p.takeoffPhase === "ascend" ? 0.34 : p.boosting ? 0.28 : 0.19;
      const camX = camera.position.x;
      const camY = camera.position.y;
      const camZ = camera.position.z;

      updateSingleWingRibbon(
        ribbonPtsXL,
        ribbonPtsYL,
        ribbonPtsZL,
        ribbonPositionsL,
        ribbonPosAttrL,
        baseHalfW,
        p.yaw,
        camX,
        camY,
        camZ,
      );
      updateSingleWingRibbon(
        ribbonPtsXR,
        ribbonPtsYR,
        ribbonPtsZR,
        ribbonPositionsR,
        ribbonPosAttrR,
        baseHalfW,
        p.yaw,
        camX,
        camY,
        camZ,
      );
      ribbonMat.uniforms["uTime"]!.value = elapsed;
      ribbonMat.uniforms["uAlpha"]!.value = ribbonFade * hoverSpeedFade * (p.diving ? 0.88 : 0.62);
      ribbonMat.uniforms["uBoost"]!.value = boostAmt;
      ribbonMat.uniforms["uTrailMode"]!.value =
        currentAdmiralTrail === "sakura"
          ? 1
          : currentAdmiralTrail === "rainbow"
            ? 2
            : currentAdmiralTrail === "none"
              ? 3
              : 0;
      ribbonMeshL.visible = true;
      ribbonMeshR.visible = true;
    } else {
      ribbonMeshL.visible = false;
      ribbonMeshR.visible = false;
      ribbonPrimed = false;
    }

    // 🌠 지면 별빛 스포트라이트 & 착지 충격파 링 갱신 (단일 Mesh 재사용, 비활성 시 Draw Call +0)
    if (shockwaveTimer > 0) {
      shockwaveTimer = Math.max(0, shockwaveTimer - dt);
      const progress = 1 - shockwaveTimer / SHOCKWAVE_DURATION;
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const radius = 0.4 + easeOut * 7.2;
      const swGy = Math.max(-0.05, meadow.getGroundHeight(shockwaveX, shockwaveZ));
      if (currentAdmiralTrail === "sakura") {
        groundRingColor.set(1.0, 0.66, 0.84);
      } else if (currentAdmiralTrail === "rainbow") {
        groundRingColor.set(0.74, 0.88, 1.0);
      } else {
        groundRingColor.set(1.0, 0.86, 0.36);
      }
      groundRingMesh.position.set(shockwaveX, swGy + 0.09, shockwaveZ);
      groundRingMesh.scale.set(radius, 1, radius);
      groundRingMat.uniforms["uTime"]!.value = elapsed;
      groundRingMat.uniforms["uMode"]!.value = 1.0;
      groundRingMat.uniforms["uProgress"]!.value = progress;
      groundRingMesh.visible = shockwaveTimer > 0;
    } else if (currentLifecycle === "open" && p.flying && (p.flightAlt > 1.0 || p.takeoffPhase === "charge")) {
      if (currentAdmiralTrail === "sakura") {
        groundRingColor.set(1.0, 0.68, 0.86);
      } else if (currentAdmiralTrail === "rainbow") {
        groundRingColor.set(0.76, 0.88, 1.0);
      } else {
        groundRingColor.set(1.0, 0.86, 0.38);
      }
      const spotRadius = p.takeoffPhase === "charge"
        ? 1.15 + p.takeoffProgress * 0.85
        : p.boosting
          ? 2.65
          : 2.15;
      groundRingMesh.position.set(p.x, pGround + 0.07, p.z);
      groundRingMesh.scale.set(spotRadius, 1, spotRadius);
      groundRingMat.uniforms["uTime"]!.value = elapsed;
      groundRingMat.uniforms["uMode"]!.value = 0.0;
      groundRingMat.uniforms["uProgress"]!.value = 0.0;
      groundRingMesh.visible = true;
    } else {
      groundRingMesh.visible = false;
    }

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
    let playerAnimPhase = playerEmotePhase;
    if (p.diving) {
      playerAnim = "dive";
      playerExpr = "happy";
      playerBlush = 0.72;
    } else if (p.takeoffPhase === "charge") {
      playerAnim = "takeoff-charge";
      playerAnimPhase = p.takeoffProgress;
      playerExpr = "happy";
      playerBlush = 0.65;
    } else if (p.takeoffPhase === "ascend") {
      playerAnim = "takeoff-ascend";
      playerAnimPhase = p.takeoffProgress;
      playerExpr = "happy";
      playerBlush = 0.78;
    } else if (p.flying) {
      playerAnim = "fly";
      playerExpr = p.boosting ? "happy" : p.moveSpeed > 2.0 ? "focused" : "happy";
      playerBlush = p.boosting ? 0.58 : 0.30;
    } else if (p.heroLandTimer > 0) {
      playerAnim = "hero-land";
      playerAnimPhase = Math.max(0, Math.min(1, 1 - p.heroLandTimer / 0.56));
      playerExpr = "happy";
      playerBlush = 0.62;
    } else if (playerEmoteTimer > 0 && playerEmoteKind) {
      playerAnim = playerEmoteKind;
      playerExpr = "happy";
      playerBlush = playerEmoteKind === "spin" || playerEmoteKind === "twirl" ? 0.92 : 0.82;
    } else if (nextFishingPhase === "casting") {
      playerAnim = "fish-cast";
      playerAnimPhase = fishing.getCastProgress();
      playerExpr = "focused";
      playerBlush = 0.22;
    } else if (nextFishingPhase === "bite") {
      playerAnim = "fish-bite";
      playerExpr = "surprised";
      playerBlush = 0.58;
    } else if (nextFishingPhase === "waiting") {
      playerAnim = "fish-wait";
      playerExpr = "normal";
      playerBlush = 0.16;
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
    if (customizerOpen || p.takeoffPhase === "charge") {
      const rel = angleDelta(Math.atan2(camera.position.x - p.x, camera.position.z - p.z), p.yaw);
      targetPLookYaw = clampSigned(rel / 1.35, 0.85);
      targetPLookPitch = p.takeoffPhase === "charge" ? 0.18 : 0.08;
    } else if (p.flying || p.diving) {
      targetPLookYaw = clampSigned(-p.flightRoll * 1.1, 0.6);
      targetPLookPitch = p.diving ? -0.35 : -0.18;
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

    const nightFactor = skyLighting.getNightFactor();
    playerRig.setNightGlow(nightFactor);
    const fireWarmP = Math.max(0, 1 - Math.hypot(p.x - 2.8, p.z - 1.0) / 8.0) * nightFactor * 0.55;
    tempTint.set(
      skyLighting.avatarWorldTint.x + fireWarmP * 0.65,
      skyLighting.avatarWorldTint.y + fireWarmP * 0.32,
      skyLighting.avatarWorldTint.z + fireWarmP * 0.05,
    );
    poseScratch.x = p.x;
    poseScratch.groundY = pGround;
    poseScratch.liftY = pTotalLift;
    poseScratch.z = p.z;
    poseScratch.yaw = p.yaw;
    poseScratch.state = p.walking || p.flying || p.diving ? "running" : "idle";
    poseScratch.activity = p.sprinting || p.boosting ? "run" : null;
    poseScratch.carrying = false;
    poseScratch.needsAttention = false;
    poseScratch.isSelected = false;
    poseScratch.isNearPlayer = false;
    poseScratch.elapsed = elapsed;
    poseScratch.fuzz = fuzz;
    poseScratch.sunDir = skyLighting.sunDir;
    poseScratch.worldTint = tempTint;
    poseScratch.viewProj = viewProj;
    poseScratch.worldAnim = playerAnim;
    poseScratch.expression = playerExpr;
    poseScratch.animPhase = playerAnimPhase;
    poseScratch.moveSpeed = p.moveSpeed;
    poseScratch.jumpVel = p.jumpVel;
    poseScratch.landSquash = p.landSquash;
    poseScratch.lookYaw = playerLookYaw;
    poseScratch.lookPitch = playerLookPitch;
    poseScratch.blush = playerBlush;
    poseScratch.hatBounce = playerHatPos;
    poseScratch.flightRoll = p.flightRoll;
    poseScratch.flightPitch = p.flightPitch;
    poseScratch.nightGlow = nightFactor;
    poseScratch.rainUmbrella = 0;
    playerRig.updatePose(poseScratch);

    // 사령관·지휘관·구성원 포즈 갱신 · 배치 접촉 그림자(Soft AO) · Direct-DOM 투영 계산
    const isOpen = currentLifecycle === "open";
    let actorCount = 0;
    let visibleCount = 0;
    let aoBlobCount = 0;
    let structSig = isOpen ? "1" : "0";
    let idx = 0;

    // 0번 AO Blob: 플레이어 제독 접촉 그림자 (고도 2.2m 이상 비행 시 숨기고 지면 별빛 스포트라이트로 대체)
    if (pTotalLift < 2.2) {
      const pAoScale = 0.92 * Math.max(0.45, Math.min(1.06, 1 - pTotalLift * 0.28 + p.landSquash * 0.14));
      const pAoAlpha = Math.max(0.06, Math.min(0.44, 0.36 * (1 - pTotalLift * 0.42)));
      aoPos.set(p.x, pGround + 0.022, p.z);
      aoScale.set(pAoScale, 1, pAoScale);
      aoMat4.compose(aoPos, aoQuat, aoScale);
      aoBlobInstanced.setMatrixAt(aoBlobCount, aoMat4);
      aoOpacityArray[aoBlobCount] = pAoAlpha;
      aoBlobCount += 1;
    }

    const hidePhotobomb = focusFraming === "customizer";
    const camToPlayerDx = p.x - camera.position.x;
    const camToPlayerDz = p.z - camera.position.z;
    const camToPlayerLenSq = camToPlayerDx * camToPlayerDx + camToPlayerDz * camToPlayerDz;

    for (const m of director.motions.values()) {
      idx += 1;
      const entry = actorRigs.get(m.spec.id);
      if (!entry) continue;

      if (hidePhotobomb) {
        const dToPlayer = Math.hypot(m.x - p.x, m.z - p.z);
        let inSightCorridor = false;
        if (dToPlayer > 4.2 && camToPlayerLenSq > 0.01) {
          const tSeg = Math.max(
            0,
            Math.min(1.25, ((m.x - camera.position.x) * camToPlayerDx + (m.z - camera.position.z) * camToPlayerDz) / camToPlayerLenSq),
          );
          const projX = camera.position.x + camToPlayerDx * tSeg;
          const projZ = camera.position.z + camToPlayerDz * tSeg;
          inSightCorridor = Math.hypot(m.x - projX, m.z - projZ) < 2.2;
        }
        if (dToPlayer <= 4.2 || inSightCorridor) {
          entry.rig.group.visible = false;
          continue;
        }
      }
      entry.rig.group.visible = true;
      const gy = Math.max(-0.05, meadow.getGroundHeight(m.x, m.z));
      const roleScale = m.spec.role === "commodore" ? 0.96 : m.spec.role === "commander" ? 0.82 : 0.70;
      const waddle = m.moving && m.flightAlt < 0.6 ? Math.abs(Math.sin(elapsed * 11 + idx)) * 0.11 : 0;
      const hop = m.hopBoost * Math.abs(Math.sin(elapsed * 10)) * 0.48
        + (director.celebratingTimer > 0 ? Math.abs(Math.sin(elapsed * 9 + idx)) * 0.40 : 0);
      const totalLift = m.flightAlt + waddle + hop;

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

      // NPC 부드러운 시선 추적 (대화 중 포커스 제독 → 상공 비행 제독 올려다보기 → 수다 상대 → 7m 이내 지나가는 제독 → 벚꽃/눈/무지개 하늘)
      let targetLookYaw = 0;
      let targetLookPitch = 0;
      const distPlayer = Math.hypot(p.x - m.x, p.z - m.z);
      if (conversingFocus || m.worldAnim !== "sleep") {
        if (conversingFocus && distPlayer > 0.25) {
          const rel = angleDelta(Math.atan2(p.x - m.x, p.z - m.z), m.yaw);
          targetLookYaw = clampSigned(rel / 1.15, 1);
          targetLookPitch = clampSigned((p.playerJumpY) * 0.35, 0.55);
        } else if (p.flying && p.flightAlt > 2.0 && distPlayer < 22.0) {
          // 상공을 나는 별빛 제독 아래 22m 이내 사령관들이 고개를 들어 하늘을 올려다봄
          if (distPlayer > 0.35) {
            const rel = angleDelta(Math.atan2(p.x - m.x, p.z - m.z), m.yaw);
            targetLookYaw = clampSigned(rel / 1.15, 1);
          }
          targetLookPitch = 0.62;
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

      const keepEmote =
        m.worldAnim === "wave"
        || m.worldAnim === "cheer"
        || m.worldAnim === "spin"
        || m.worldAnim === "clap"
        || m.worldAnim === "twirl"
        || m.worldAnim === "takeoff-charge"
        || m.worldAnim === "takeoff-ascend"
        || m.worldAnim === "fly"
        || m.worldAnim === "dive"
        || m.worldAnim === "hero-land";
      const effAnim: WorldAnimMode = conversingFocus && !keepEmote ? "talk" : m.worldAnim;
      const effExpr: WorldExpression = conversingFocus && !keepEmote ? "happy" : m.expression;
      const effBlush = conversingFocus ? Math.max(m.blush, 0.42) : m.blush;
      const actorRainUmbrella =
        m.flightAlt < 0.6
        && effAnim !== "fly"
        && effAnim !== "dive"
        && effAnim !== "takeoff-ascend"
          ? rainUmbrellaLevel
          : 0;

      poseScratch.x = m.x;
      poseScratch.groundY = gy;
      poseScratch.liftY = totalLift;
      poseScratch.z = m.z;
      poseScratch.yaw = m.yaw + (director.celebratingTimer > 0 ? elapsed * 4.5 : 0);
      poseScratch.state = m.spec.state;
      poseScratch.activity = m.spec.activity;
      poseScratch.carrying = m.carrying;
      poseScratch.needsAttention = m.spec.needsAttention;
      poseScratch.isSelected = isSelected;
      poseScratch.isNearPlayer = isNearPlayer;
      poseScratch.elapsed = elapsed;
      poseScratch.fuzz = fuzz;
      poseScratch.sunDir = skyLighting.sunDir;
      poseScratch.worldTint = tempTint;
      poseScratch.viewProj = viewProj;
      poseScratch.worldAnim = effAnim;
      poseScratch.expression = effExpr;
      poseScratch.animPhase = m.animPhase;
      poseScratch.moveSpeed = m.moveSpeed;
      poseScratch.jumpVel = m.hopBoost > 0.2 ? Math.cos(elapsed * 10) * m.hopBoost * 2.2 : 0;
      poseScratch.landSquash = 0;
      poseScratch.lookYaw = sp.lookYaw;
      poseScratch.lookPitch = sp.lookPitch;
      poseScratch.blush = effBlush;
      poseScratch.hatBounce = sp.hatPos;
      poseScratch.flightRoll = m.flightRoll;
      poseScratch.flightPitch = m.flightPitch;
      poseScratch.nightGlow = nightFactor;
      poseScratch.rainUmbrella = actorRainUmbrella;
      entry.rig.updatePose(poseScratch);

      // 배치 Soft AO 접촉 그림자 (점프/바운스 높이에 따라 반응, 2.2m 이상 상공 비행 윙맨은 숨김)
      if (aoBlobCount < MAX_ACTOR_AO_BLOBS && totalLift < 2.2) {
        const aAoScale = roleScale * Math.max(0.46, Math.min(1.04, 1 - totalLift * 0.28));
        const aAoAlpha = Math.max(0.06, Math.min(0.42, 0.34 * (1 - totalLift * 0.40)));
        aoPos.set(m.x, gy + 0.022, m.z);
        aoScale.set(aAoScale, 1, aAoScale);
        aoMat4.compose(aoPos, aoQuat, aoScale);
        aoBlobInstanced.setMatrixAt(aoBlobCount, aoMat4);
        aoOpacityArray[aoBlobCount] = aAoAlpha;
        aoBlobCount += 1;
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

        tempPos.set(m.x, gy + totalLift + 1.62 * roleScale, m.z);
        const topOk = projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop);
        tempPos.set(m.x, gy + totalLift + 0.62 * roleScale, m.z);
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

    // 플레이어 라벨 투영 (하늘 조망·제독 드레스업 클로즈업·시네마 관전 중에는 숨김)
    const inOverview = playerCtrl.isOverviewMode();
    if (isOpen && !inOverview && !customizerOpen && !cinemaMode && currentCameraMode === "follow" && currentInteractionMode === "closed") {
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
        && projTop.w < (inOverview ? 260 : 88)
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
        && projTop.w < (inOverview ? 260 : 54)
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
        && projTop.w < (inOverview ? 260 : 62)
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

    // 비행 중 가장 가까운 다음 하늘 순찰 링 오프스크린 방향 가이드 (0-GC Direct-DOM, 화면 정면 안이면 자동 숨김)
    const rg = framePositions.ringGuide;
    if (
      isOpen
      && inOverview
      && p.flying
      && p.takeoffPhase === "none"
      && livingWorkflowFx.getNearestReadySkyRing(p.x, p.y, p.z, nearestRingOut)
    ) {
      tempPos.set(nearestRingOut.x, nearestRingOut.y, nearestRingOut.z);
      const projOk = projectPointInto(tempPos, viewProj, cssWidth, cssHeight, projTop);
      const onScreen = projOk
        && projTop.x >= cssWidth * 0.06
        && projTop.x <= cssWidth * 0.94
        && projTop.y >= cssHeight * 0.12
        && projTop.y <= cssHeight * 0.88;
      if (onScreen) {
        rg.visible = false;
      } else {
        ringCamScratch.set(nearestRingOut.x, nearestRingOut.y, nearestRingOut.z).applyMatrix4(camera.matrixWorldInverse);
        let dirX = ringCamScratch.x * camera.projectionMatrix.elements[0]!;
        let dirY = -ringCamScratch.y * camera.projectionMatrix.elements[5]!;
        const dirLen = Math.hypot(dirX, dirY);
        if (dirLen < 1e-4) {
          dirX = 0;
          dirY = 1;
        } else {
          dirX /= dirLen;
          dirY /= dirLen;
        }
        const scaleX = Math.abs(dirX) > 1e-4 ? 44 / Math.abs(dirX) : Infinity;
        const scaleY = Math.abs(dirY) > 1e-4 ? 38 / Math.abs(dirY) : Infinity;
        const s = Math.min(scaleX, scaleY);
        const xPct = Math.max(6, Math.min(94, 50 + dirX * s));
        const yPct = Math.max(12, Math.min(88, 50 + dirY * s));
        rg.visible = true;
        rg.xPct = xPct;
        rg.yPct = yPct;
        rg.xPx = (xPct / 100) * cssWidth;
        rg.yPx = (yPct / 100) * cssHeight;
        rg.angleRad = Math.atan2(dirY, dirX);
        rg.distM = nearestRingOut.distM;
      }
    } else {
      rg.visible = false;
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
      currentActors = snapshot.actors;
      meadow.syncZones(snapshot.zones, snapshot.villages);
      meadow.syncVillageBiomeParticles(
        snapshot.villages.map((v) => ({
          x: v.x,
          z: v.z,
          radius: v.radius,
          biome: v.biome,
        })),
      );
      skyLighting.setStreetlampAnchors(meadow.streetlampAnchors);
      director.syncActors(snapshot.actors);
      director.syncVillagePatrols(snapshot.villages);

      // 실시간 작업 중 사령관 마을 상공 홀로그램 설계도 + 공방 불꽃 FX 동기화
      const workingVillages: WorkingVillageFxInput[] = [];
      for (const v of snapshot.villages) {
        const hasWorkingActor = snapshot.actors.some(
          (a) => a.commodoreId === v.commodoreId && (a.state === "running" || a.activity !== null),
        );
        if (v.workStep !== null || hasWorkingActor) {
          workingVillages.push({
            id: v.id,
            x: v.x,
            z: v.z,
            radius: v.radius,
            accentHex: resolveToneHex(v.tone),
          });
        }
      }
      livingWorkflowFx.syncWorkingVillages(workingVillages);

      // Objective `done` 신규 전환 감지 → 해당 마을 상공 3D 불꽃놀이 + 주변 사령관 환호 + 팡파르 자동 발동
      let celebratedAny = false;
      for (const v of snapshot.villages) {
        const prevDone = prevVillageDoneCounts.get(v.id);
        if (snapshotPrimed && prevDone !== undefined && v.completedObjectiveCount > prevDone) {
          const accentHex = resolveToneHex(v.tone);
          director.celebrateObjectiveDone(v.x, v.z, accentHex);
          livingWorkflowFx.triggerVillageFirework(v.x, v.z, accentHex);
          celebratedAny = true;
        }
        prevVillageDoneCounts.set(v.id, v.completedObjectiveCount);
      }
      if (celebratedAny) {
        playFireworkBurst();
        playLevelUpFanfare();
        rainbowLookTimer = Math.max(rainbowLookTimer, 10);
        skyLighting.triggerRainbow(10);
      }
      snapshotPrimed = true;

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
        if (existing && existing.sig === sig) {
          applyGiftHatForSpec(spec, existing.rig);
          continue;
        }
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
        applyGiftHatForSpec(spec, rig);
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
      if (enabled) cancelFishingInternal();
      else livingWorkflowFx.resetSkyRingCombo();
      playerCtrl.setOverviewMode(enabled);
    },
    setAuroraEnabled(enabled) {
      skyLighting.setAuroraEnabled(enabled);
    },
    setCinemaMode(enabled) {
      if (enabled === cinemaMode) return;
      cinemaMode = enabled;
      cinemaTimer = 0;
      if (enabled) {
        playerCtrl.setOverviewMode(false);
        playerCtrl.clearDistrictFocus();
        cinemaStopIndex = 0;
        const spot = resolveCinemaSpotlight(0);
        lastCinemaSpotlight = spot.label;
        config.onCinemaSpotlight?.(spot.label);
      } else {
        lastCinemaSpotlight = "";
        config.onCinemaSpotlight?.("");
      }
    },
    setWeather(mode) {
      currentWeather = mode;
      skyLighting.setWeather(mode);
      meadow.setWeather(mode);
      director.setWeather(mode);
      setRainAmbience(mode === "rain");
      updateBgmEnvironment(skyLighting.nightFactor, mode);
    },
    triggerRainbow(durationSec = 16) {
      rainbowLookTimer = Math.max(rainbowLookTimer, durationSec);
      skyLighting.triggerRainbow(durationSec);
    },
    setAdmiralStyle(
      toneOrStyle: IdentityTone | WorldAdmiralStyle,
      hat?: WorldAdmiralHat,
      cape?: WorldAdmiralCape,
      trail?: WorldAdmiralTrail,
    ) {
      if (typeof toneOrStyle === "object") {
        playerRig.setAdmiralStyle(toneOrStyle.tone, toneOrStyle.hat);
        (playerRig as MongleActorRigS13).setCape?.(toneOrStyle.cape);
        currentAdmiralTrail = toneOrStyle.trail;
      } else {
        playerRig.setAdmiralStyle(toneOrStyle, hat ?? "admiral");
        if (cape !== undefined) {
          (playerRig as MongleActorRigS13).setCape?.(cape);
        }
        if (trail !== undefined) {
          currentAdmiralTrail = trail;
        }
      }
    },
    setCommodoreGifts(gifts) {
      const prevGifts = currentCommodoreGifts;
      currentCommodoreGifts = { ...gifts };
      for (const m of director.motions.values()) {
        if (m.spec.role !== "commodore") continue;
        const entry = actorRigs.get(m.spec.id);
        if (!entry) continue;
        const key = m.spec.commodoreId ?? m.spec.id;
        const prevHat = prevGifts[key] ?? prevGifts[m.spec.id];
        const nextHat = currentCommodoreGifts[key] ?? currentCommodoreGifts[m.spec.id];
        (entry.rig as MongleActorRigS13).setHat?.(nextHat ?? null);
        if (nextHat && nextHat !== prevHat && nextHat !== "none") {
          playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
          director.playEmote(m.spec.id, "cheer", playerPosVec);
          director.spawnBurst(m.x, meadow.getGroundHeight(m.x, m.z) + 1.35, m.z, 0xfde047, 14);
          playMongleChirp(4);
        }
      }
    },
    setCustomizerMode(open) {
      customizerOpen = open;
    },
    triggerCustomizerPreviewBounce() {
      // 색상·모자·망토·궤적 변경 시 0.95초간 기분 좋은 cheer 바운스 + happy 표정 + 볼터치 + 모자 2차 스프링 튕김 + 테마 스파클 연출
      playerEmoteKind = "cheer";
      playerEmoteTimer = 0.95;
      playerEmotePhase = 0;
      playerEmoteHop = 0.85;
      playerHatVel -= 1.65;
      const px = playerCtrl.player.x;
      const py = playerCtrl.player.y;
      const pz = playerCtrl.player.z;
      const burstTheme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;
      for (let k = 0; k < 8; k += 1) {
        const c = resolveTrailColor(burstTheme, k) ?? 0xffe57f;
        const ang = (k / 8) * Math.PI * 2;
        director.spawnTrailSparkle(
          px + Math.cos(ang) * 0.34,
          py + 0.92 + (k % 3) * 0.14,
          pz + Math.sin(ang) * 0.34,
          c,
          0.86,
          burstTheme !== "sakura",
        );
      }
    },
    setCampfireSit(sitting) {
      if (sitting) cancelFishingInternal();
      playerCtrl.setCampfireSit(sitting);
    },
    setCompanionActors(actorIds) {
      director.setCompanionActors(actorIds);
    },
    triggerWelcomeBriefing(speech) {
      director.triggerWelcomeBriefing(playerCtrl.player.x, playerCtrl.player.z, speech);
    },
    spawnJointMissionArch(fromX, fromZ, toX, toZ, colorHex) {
      livingWorkflowFx.spawnJointMissionArch(fromX, fromZ, toX, toZ, colorHex);
    },
    setMailboxUnread(hasUnread) {
      meadow.setMailboxUnread(hasUnread);
    },
    pickMailboxAt(clientX, clientY) {
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      pickNdc.set((mx / rect.width) * 2 - 1, -(my / rect.height) * 2 + 1);
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      if (Math.abs(direction.y) < 1e-4) return false;
      const mbY = meadow.getGroundHeight(MAILBOX_POS.x, MAILBOX_POS.z) + 0.95;
      const t = (mbY - origin.y) / direction.y;
      if (t <= 0 || t > 180) return false;
      const wx = origin.x + direction.x * t;
      const wz = origin.z + direction.z * t;
      return Math.hypot(wx - MAILBOX_POS.x, wz - MAILBOX_POS.z) <= MAILBOX_POS.radius + 0.45;
    },
    syncPondFish(speciesIds) {
      meadow.syncPondFish(speciesIds);
    },
    setOperationFlag(flag, targetCommodoreId) {
      if (!flag) {
        livingWorkflowFx.setOperationFlag(null);
        return;
      }
      let originX = flag.originX;
      let originZ = flag.originZ;
      let accentHex = flag.accentHex;
      if (targetCommodoreId) {
        for (const m of director.motions.values()) {
          if (m.spec.role === "commodore" && m.spec.commodoreId === targetCommodoreId) {
            if (originX === undefined) originX = m.x;
            if (originZ === undefined) originZ = m.z;
            if (accentHex === undefined) accentHex = resolveToneHex(m.spec.tone);
            const safe = meadow.resolveMovement(m.x, m.z, flag.x, flag.z, 0.55);
            m.tx = safe.x;
            m.tz = safe.z;
            m.hopBoost = Math.max(m.hopBoost, 1.15);
            director.spawnBurst(flag.x, meadow.getGroundHeight(flag.x, flag.z) + 1.1, flag.z, accentHex, 14);
            break;
          }
        }
      }
      livingWorkflowFx.setOperationFlag({
        ...flag,
        originX: originX ?? 0,
        originZ: originZ ?? -1.5,
        accentHex: accentHex ?? 0xfbbf24,
      });
    },
    triggerVillageFirework(villageId) {
      const targetVillage = villageId
        ? currentVillages.find((v) => v.id === villageId || v.commodoreId === villageId) ?? null
        : currentVillages[0] ?? null;
      const fxX = targetVillage?.x ?? 0;
      const fxZ = targetVillage?.z ?? -2.0;
      const accentHex = targetVillage ? resolveToneHex(targetVillage.tone) : 0xfbbf24;
      livingWorkflowFx.triggerVillageFirework(fxX, fxZ, accentHex);
      director.celebrateObjectiveDone(fxX, fxZ, accentHex);
      playFireworkBurst();
    },
    ringParadeBell(rallySpeech) {
      meadow.ringParadeBell();
      playParadeBell();
      director.spawnBurst(PARADE_BELL_POS.x, 2.35, PARADE_BELL_POS.z, 0xfde047, 22);
      return director.triggerParadeBellRally(PARADE_BELL_POS.x, PARADE_BELL_POS.z, rallySpeech);
    },
    startFishing() {
      if (
        currentLifecycle !== "open"
        || playerCtrl.isOverviewMode()
        || playerCtrl.player.flying
        || playerCtrl.player.diving
        || playerCtrl.isSittingAtCampfire()
      ) {
        return false;
      }
      const gy = Math.max(0.05, meadow.getGroundHeight(playerCtrl.player.x, playerCtrl.player.z));
      const started = fishing.startCast(playerCtrl.player.x, playerCtrl.player.z, playerCtrl.player.yaw, gy);
      if (started) {
        notifyFishingPhase("waiting");
      }
      return started;
    },
    reelFishing(commodoreNames) {
      const res = fishing.reelIn(skyLighting.getNightFactor() > 0.45, commodoreNames);
      if (res.outcome === "caught") {
        playFishingCatch(res.fish.rarity);
        playerEmoteKind = "cheer";
        playerEmoteTimer = 1.65;
        playerEmotePhase = 0;
        playerEmoteHop = 0.72;
        playerHatVel -= 1.25;
        director.spawnBurst(playerCtrl.player.x, playerCtrl.player.y + 1.35, playerCtrl.player.z, res.fish.colorHex, 16);
        if (activeCoFishingIds.size > 0) {
          playerPosVec.set(playerCtrl.player.x, playerCtrl.player.y, playerCtrl.player.z);
          const cheerLine = isEnglishDoc() ? "What a catch, Admiral!" : "제독님! 대어예요!";
          for (const cid of activeCoFishingIds) {
            director.playEmote(cid, "cheer", playerPosVec);
            director.applySpeech(cid, cheerLine);
          }
        }
        notifyFishingPhase("caught");
      } else if (res.outcome === "missed") {
        notifyFishingPhase("idle");
      }
      return res;
    },
    cancelFishing() {
      cancelFishingInternal();
    },
    triggerPhotoGroupPose() {
      director.triggerPhotoGroupPose(camera.position.x, camera.position.z);
      playerEmoteKind = "cheer";
      playerEmoteTimer = 2.6;
      playerEmotePhase = 0;
      playerEmoteHop = 0.72;
      playerHatVel -= 1.25;
      playEmoteSparkle("cheer");
    },
    triggerAdmiralEmote(emote) {
      const px = playerCtrl.player.x;
      const py = playerCtrl.player.y;
      const pz = playerCtrl.player.z;
      playEmoteSparkle(emote);
      if (emote === "sit") {
        cancelFishingInternal();
        playerCtrl.setCampfireSit(true);
        director.triggerAdmiralEmoteReaction(px, pz, "sit");
        return;
      }
      if (emote === "stardust") {
        playerEmoteKind = "cheer";
        playerEmoteTimer = 1.9;
        playerEmotePhase = 0;
        playerEmoteHop = 0.85;
        playerHatVel -= 1.5;
        director.spawnBurst(px, py + 1.35, pz, 0xfde047, 22);
        const burstTheme = currentAdmiralTrail === "none" ? "stardust" : currentAdmiralTrail;
        for (let k = 0; k < 14; k += 1) {
          const ang = (k / 14) * Math.PI * 2;
          const col = resolveTrailColor(burstTheme, k) ?? 0xfde047;
          director.spawnTrailSparkle(
            px + Math.cos(ang) * 0.65,
            py + 1.05 + (k % 3) * 0.22,
            pz + Math.sin(ang) * 0.65,
            col,
            0.95,
            true,
          );
        }
        director.triggerAdmiralEmoteReaction(px, pz, "stardust");
        return;
      }
      playerEmoteKind = emote === "wave"
        ? "wave"
        : emote === "clap"
          ? "clap"
          : emote === "twirl"
            ? "twirl"
            : "cheer";
      playerEmoteTimer = emote === "twirl" ? 1.55 : 1.9;
      playerEmotePhase = 0;
      playerEmoteHop = emote === "twirl" ? 1.15 : emote === "clap" ? 0.55 : 0.85;
      if (emote === "twirl") {
        playerHatVel -= 1.8;
      }
      director.triggerAdmiralEmoteReaction(px, pz, emote);
    },
    captureSnapshotDataUrl() {
      if (disposed) return null;
      try {
        composer.render();
        return renderer.domElement.toDataURL("image/png");
      } catch {
        return null;
      }
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
    diveToPoint(x, z) {
      playerCtrl.startMeteorDive(x, z, meadow.getGroundHeight, meadow.resolveMovement);
      director.spawnBurst(
        playerCtrl.player.x,
        playerCtrl.player.y + 0.55,
        playerCtrl.player.z,
        0xfde047,
        10,
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
      if (t0 <= 0 || t0 > 420) return null;
      const wx0 = origin.x + direction.x * t0;
      const wz0 = origin.z + direction.z * t0;
      const gy = meadow.getGroundHeight(wx0, wz0);
      const t1 = (gy - origin.y) / direction.y;
      if (t1 <= 0 || t1 > 420) return null;
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
      if (t0 <= 0 || t0 > 420) return null;
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
    pickGroundPointAt(clientX, clientY) {
      const rect = config.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      pickNdc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pickNdc, camera);
      const { origin, direction } = raycaster.ray;
      // 아래쪽 지면을 향한 광선만 허용 (하늘 클릭 제외)
      if (direction.y >= -1e-4) return null;

      const GROUND_CLAMP = 82;
      const t0 = -origin.y / direction.y;
      if (t0 <= 0 || t0 > 420) return null;
      const wx0 = Math.max(-GROUND_CLAMP, Math.min(GROUND_CLAMP, origin.x + direction.x * t0));
      const wz0 = Math.max(-GROUND_CLAMP, Math.min(GROUND_CLAMP, origin.z + direction.z * t0));

      // 2차 실제 지형 높이 보정
      const gy = meadow.getGroundHeight(wx0, wz0);
      const t1 = (gy - origin.y) / direction.y;
      const wx = t1 > 0 && t1 <= 420
        ? Math.max(-GROUND_CLAMP, Math.min(GROUND_CLAMP, origin.x + direction.x * t1))
        : wx0;
      const wz = t1 > 0 && t1 <= 420
        ? Math.max(-GROUND_CLAMP, Math.min(GROUND_CLAMP, origin.z + direction.z * t1))
        : wz0;

      const safe = meadow.resolveMovement(wx, wz, wx, wz, 0.55);
      return {
        x: Math.max(-GROUND_CLAMP, Math.min(GROUND_CLAMP, safe.x)),
        z: Math.max(-GROUND_CLAMP, Math.min(GROUND_CLAMP, safe.z)),
      };
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
      updateSpatialAmbience({
        brookDist: 999,
        campfireDist: 999,
        forestDist: 999,
        isNight: false,
        isRain: false,
        active: false,
      });
      setRainAmbience(false);
      setBgmEnabled(false);
      if (typeof window !== "undefined" && window.__fleetWorldPerf === getRenderStats) {
        delete window.__fleetWorldPerf;
      }
      resizeObserver.disconnect();
      config.canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
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
      ribbonGeoL.dispose();
      ribbonGeoR.dispose();
      ribbonMat.dispose();
      scene.remove(ribbonMeshL);
      scene.remove(ribbonMeshR);
      groundRingGeo.dispose();
      groundRingMat.dispose();
      scene.remove(groundRingMesh);
      playerRig.dispose();
      fishing.dispose();
      livingWorkflowFx.dispose();
      director.dispose();
      playerCtrl.dispose();
      meadow.dispose();
      skyLighting.dispose();
      envRT.dispose();
      pmremGenerator.dispose();
      renderPass.dispose();
      bloomPass.dispose();
      outputPass.dispose();
      msaaTarget.dispose();
      composer.dispose();
      renderer.dispose();
    },
  };
}
