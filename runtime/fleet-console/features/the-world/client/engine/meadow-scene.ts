import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  GLSL3,
  Group,
  InstancedMesh,
  type Intersection,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  type Raycaster,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import {
  WORLD_NOTICE_BOARD_POS,
  type WorldDistrictSpec,
  type WorldVillageBiome,
  type WorldVillageSpec,
  type WorldWeatherMode,
  type WorldZoneSpec,
} from "../../shared/world-types.js";
import {
  BROOK_BRIDGES,
  BROOK_SPAN_HALF_X,
  brookProfile,
  distanceToBrookEdge,
  type BrookBridgeSpec,
} from "./brook-geometry.js";
import {
  createInstancedBucketBuilder,
  disposeObjectTree,
  getUnitGeometries,
  markSharedGeometry,
  markSharedMaterial,
  type InstancedBucketBuilder,
} from "./instanced-buckets.js";
import {
  BROOK_FRAGMENT,
  BROOK_VERTEX,
  CAMPFIRE_COAL_FRAGMENT,
  CAMPFIRE_COAL_VERTEX,
  CAMPFIRE_FLAME_FRAGMENT,
  CAMPFIRE_FLAME_VERTEX,
  FOUNTAIN_WATER_FRAGMENT,
  FOUNTAIN_WATER_VERTEX,
  HIGHLIGHT_FRAGMENT,
  HIGHLIGHT_VERTEX,
  HOLO_TABLE_RING_FRAGMENT,
  HOLO_TABLE_RING_VERTEX,
  ROAD_RIBBON_FRAGMENT,
  ROAD_RIBBON_VERTEX,
} from "./meadow-shaders.js";
import {
  createGateBannerTexture,
  createGatePlaqueTexture,
  createMeadowTexturePack,
  createVillageSignTexture,
} from "./meadow-textures.js";
import {
  createWorldAssetRegistry,
  type InstancedSlotTransform,
  type WorldModelSlot,
} from "./world-asset-registry.js";

/**
 * 넓게 펼쳐진 초원 마을(Meadow Village) + 심시티 스타일 사령관별 마을(Village) & Theater 구역(District) 3D 씬.
 *
 * - 지형 380×380m, 이동 반경 88m, 산맥 시작 r > 88m.
 * - 정적 자연물(나무·덤불·울타리·다리·가로등·벤치·접지 AO)과 마을/구역 건축물(Tier 0~5)을
 *   `instanced-buckets.ts`로 배칭해 수십~수백 구역에서도 draw call을 낮게 유지하고 GPU 누수를 0으로 억제한다.
 * - 심시티 구역 호버/선택용 공유 셰이더 하이라이트 링 2개만 상주시켜 `setDistrictHighlight`로 즉시 이동한다.
 */

export const WORLD_PLAY_RADIUS = 88;

/** 중앙 길드 광장 좌측 앞마당 「함대 소집 종 (Parade Bell)」 좌표 및 피킹 반경 (화단·이정표·우물 비충돌, 스폰 정면 시인성 확보). */
export const PARADE_BELL_POS = {
  x: -5.4,
  z: 2.3,
  radius: 1.75,
} as const;

/** 중앙 길드 광장 좌측 앞마당 「함대 우체통 (Fleet Mailbox)」 좌표 및 피킹 반경 (길드 회관·우물·화단과 1.3m+ 개방 통로 확보). */
export const MAILBOX_POS = {
  x: -4.1,
  z: -4.2,
  radius: 1.55,
} as const;

/** 중앙 광장 동남쪽 정원 「별빛 연못 (Starlight Pond)」 좌표 및 상호작용 반경 (모닥불 벤치·화단·도로·시냇물 비충돌). */
export const STARLIGHT_POND_POS = {
  x: 7.8,
  z: 2.2,
  radius: 2.3,
} as const;

export interface VillageBiomeParticleTarget {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly biome: WorldVillageBiome | "snow";
  readonly label?: string | undefined;
}

export type EffectiveVillageTheme = WorldVillageBiome | "snow";

const SNOW_THEME_RE = /설원|눈꽃|겨울|빙하|극지|설산|snow|winter|frost|glacier|ice|arctic/iu;
const AUTUMN_THEME_RE = /가을|단풍|낙엽|황혼|autumn|fall|maple|harvest/iu;
const SAKURA_THEME_RE = /벚꽃|사쿠라|봄꽃|화원|sakura|blossom|cherry/iu;
const CITADEL_THEME_RE = /성채|요새|시타델|citadel|fortress|castle|bastion/iu;

/**
 * 사용자 수동 바이옴 지정(`sakura`/`autumn`/`citadel`)이 없을 때(`meadow`),
 * 마을·사령관 이름 키워드와 조화되는 기본 테마 팔레트를 도출한다(수동 전환 100% 호환).
 */
export function resolveEffectiveVillageTheme(
  village: Pick<WorldVillageSpec, "biome" | "label">,
): EffectiveVillageTheme {
  if (village.biome !== "meadow") return village.biome;
  const label = village.label;
  if (SNOW_THEME_RE.test(label)) return "snow";
  if (AUTUMN_THEME_RE.test(label)) return "autumn";
  if (SAKURA_THEME_RE.test(label)) return "sakura";
  if (CITADEL_THEME_RE.test(label)) return "citadel";
  return "meadow";
}

const TONE_ROOF_HEX: Readonly<Record<IdentityTone, number>> = {
  crimson: 0xd94854,
  amber: 0xe58e1a,
  moss: 0x4ba85c,
  teal: 0x249e97,
  cerulean: 0x368be0,
  indigo: 0x5c62d6,
  plum: 0xb850c4,
  rose: 0xdc5888,
};

const TONE_CRYSTAL_HEX: Readonly<Record<IdentityTone, number>> = {
  crimson: 0xfb7185,
  amber: 0xfbbf24,
  moss: 0x4ade80,
  teal: 0x2dd4bf,
  cerulean: 0x38bdf8,
  indigo: 0x818cf8,
  plum: 0xe879f9,
  rose: 0xf472b6,
};

export interface CircleCollider {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

export type MeadowSurfaceType = "grass" | "stone" | "wood" | "water";

export type MeadowFootstepSurface = "wood" | "stone" | "grass";

export interface CameraOccluder {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
  /** 차폐 하단 시작 높이(m, 예: 수목 수관·성문 상인방). 미지정 시 0. */
  readonly minY?: number | undefined;
  readonly kind?: "gate" | "wall" | "tree" | "building" | "prop" | undefined;
}

export interface FishingSpotAnchor {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export type LiveWorkshopFxKind = "smoke" | "spark" | "pulse" | "alert" | "ask";

export interface LiveWorkshopEmitter {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly kind: LiveWorkshopFxKind;
}

export interface MeadowSceneHandle {
  readonly group: Group;
  readonly streetlampAnchors: readonly Vector3[];
  syncZones(zones: readonly WorldZoneSpec[], villages?: readonly WorldVillageSpec[]): void;
  setDistrictHighlight(hovered: WorldDistrictSpec | null, selected: WorldDistrictSpec | null): void;
  /** `theaterId`(또는 `districtId`) 기준으로 구역 호버 하이라이트 링·은은한 발광을 부드럽게 켜고 끈다. */
  setHoveredDistrict(theaterIdOrDistrictId: string | null): void;
  /** Tier 0~5 전 구역 건물 3D 레이캐스트용 히트 그룹(각 메시 `userData`에 `districtId`/`theaterId`/`district` 포함). */
  getDistrictHitGroup(): Group;
  /** Tier 0~5 전 구역 히트 타깃 목록(`Raycaster.intersectObjects` 직접 전달용). */
  getDistrictHitTargets(): readonly Object3D[];
  /** 사전 할당 버퍼로 0-GC 3D 구역 건물 레이캐스트를 수행한다. */
  raycastDistrict(raycaster: Raycaster): WorldDistrictSpec | null;
  /** 중앙 광장 3D 퀘스트 게시판의 긴급 알림 비콘(질문·승인·검토 > 0) 표시를 씬 리빌드 없이 전환한다. */
  setQuestBoardAlert(urgentCount: number): void;
  /** 우클릭/인스펙터로 꽂힌 RTS 홀로그램 작전 깃발을 씬 리빌드 없이 동기화한다. */
  setDispatchFlags(flags: readonly { readonly x: number; readonly z: number; readonly tone: IdentityTone }[]): void;
  /** 날씨 모드를 시냇물 빗방울 파문과 나비 생태계 가시성에 반영한다. */
  setWeather(mode: WorldWeatherMode): void;
  /** 제독 메모가 저장된 Theater 구역 상단에 황금 메모 핀을 씬 리빌드 없이 동기화한다. */
  setDistrictNotePins(pins: readonly { readonly x: number; readonly z: number }[]): void;
  /** 좌표가 동/서 아치 목교 데크 위인지 판별한다 (발소리 SFX 구분용). */
  isOnBridge(x: number, z: number): boolean;
  /** 좌표의 지면 재질을 판별한다 (돌길·광장=`stone`, 목교=`wood`, 시냇물=`water`, 초원=`grass`). */
  getSurfaceType(x: number, z: number): MeadowSurfaceType;
  /** 발소리 SFX용 지면 재질을 판별한다 (4개 목교=`"wood"`, 중앙 광장 석판·돌길·마을 석조 광장=`"stone"`, 초원=`"grass"`). */
  getSurfaceMaterial(x: number, z: number): MeadowFootstepSurface;
  /** 카메라 스프링-암 가림 방지용 경량 수직 실린더 목록(가로등·나무 수관·건물·성문·담장)을 반환한다. */
  getCameraOccluders(): readonly CameraOccluder[];
  /** `Raycaster` 기반 3인칭 카메라 차폐 회피(`setCameraOccluders`)에 등록할 경량 차폐 오브젝트 목록(0 렌더 비용). */
  getCameraOccluderObjects(): readonly Object3D[];
  /** 시냇가 상시 3D 낚시 포인트 표식 좌표 목록을 반환한다. */
  getFishingSpotAnchors(): readonly FishingSpotAnchor[];
  /** 실시간 작업/경보/질문 상태인 마을·구역의 3D 공방 FX 에미터 좌표를 반환한다. */
  getLiveWorkshopEmitters(): readonly LiveWorkshopEmitter[];
  /** 좌표에서 가장 가까운 시냇물 강변까지의 거리(m, 공간 음향용)를 반환한다. */
  getNearestBrookDist(x: number, z: number): number;
  /** 좌표에서 가장 가까운 숲 군락까지의 거리(m, 공간 음향용)를 반환한다. */
  getNearestForestDist(x: number, z: number): number;
  /** 중앙 광장 함대 소집 종(Parade Bell)을 약 2.2초간 경쾌하게 흔든다. */
  ringParadeBell(): void;
  /** 중앙 광장 3D 함대 우체통의 미확인 편지 깃발·황금 스파클 알림을 전환한다. */
  setMailboxUnread(hasUnread: boolean): void;
  /** 광장 3D 별빛 연못에 방생된 어종 ID 목록(최대 8종)을 동기화한다. */
  syncPondFish(speciesIds: readonly string[]): void;
  /** 마을별 바이옴(벚꽃/단풍/설원·성채/초원) 국지 낙화·낙엽·눈송이·민들레 파티클을 동기화한다. */
  syncVillageBiomeParticles(villages: readonly VillageBiomeParticleTarget[]): void;
  getGroundHeight(x: number, z: number): number;
  isWalkable(x: number, z: number): boolean;
  resolveMovement(curX: number, curZ: number, nextX: number, nextZ: number, actorRadius?: number): { x: number; z: number };
  update(dt: number, elapsed: number, nightFactor: number, sunDir: Vector3): void;
  dispose(): void;
}

interface AnimatedBanner {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly baseRotY: number;
  readonly phase: number;
  readonly colorHex: number;
  readonly width: number;
  readonly height: number;
}

interface AnimatedFlame {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly phase: number;
}

interface AnimatedCrystal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly phase: number;
  readonly colorHex: number;
}

interface AnimatedRoutineWindmill {
  readonly villageId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly faceYaw: number;
  readonly phase: number;
}

interface AnimatedStatusBeacon {
  readonly x: number;
  readonly y: number;
  readonly groundY: number;
  readonly z: number;
  readonly ringRadius: number;
  readonly colorHex: number;
  readonly pulseSpeed: number;
  readonly phase: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function isInBrookChannel(x: number, z: number, margin = 0): boolean {
  if (Math.abs(x) >= BROOK_SPAN_HALF_X + 1.5) return false;
  const bp = brookProfile(x);
  return Math.abs(z - bp.centerZ) < bp.halfWidth + margin;
}

export function createMeadowScene(scene: Scene): MeadowSceneHandle {
  const root = new Group();
  const dynamicWorldGroup = new Group();
  root.add(dynamicWorldGroup);

  const textures = createMeadowTexturePack();
  const assetRegistry = createWorldAssetRegistry();
  const customBladePivots: Object3D[] = [];

  // 공통 PBR 머티리얼 팔레트 — 전부 markSharedMaterial 등록해 rebuildWorld 시 보존, dispose 시 일괄 해제
  const sharedMaterials: (MeshStandardMaterial | MeshBasicMaterial)[] = [];
  const ownMat = <T extends MeshStandardMaterial | MeshBasicMaterial>(mat: T): T => {
    markSharedMaterial(mat);
    sharedMaterials.push(mat);
    return mat;
  };

  const matPlaster = ownMat(new MeshStandardMaterial({
    color: 0xfbf4e8,
    map: textures.plasterMap,
    bumpMap: textures.plasterBump,
    bumpScale: 0.045,
    roughness: 0.86,
  }));
  const matPlasterWarm = ownMat(new MeshStandardMaterial({
    color: 0xf2e2c4,
    map: textures.plasterMap,
    bumpMap: textures.plasterBump,
    bumpScale: 0.045,
    roughness: 0.88,
  }));
  const matTimber = ownMat(new MeshStandardMaterial({
    color: 0x6b452a,
    map: textures.woodMap,
    bumpMap: textures.woodBump,
    bumpScale: 0.055,
    roughness: 0.86,
  }));
  const matWood = ownMat(new MeshStandardMaterial({
    color: 0xa16a43,
    map: textures.woodMap,
    bumpMap: textures.woodBump,
    bumpScale: 0.05,
    roughness: 0.82,
  }));
  const matWoodLight = ownMat(new MeshStandardMaterial({
    color: 0xd9af7e,
    map: textures.woodMap,
    bumpMap: textures.woodBump,
    bumpScale: 0.042,
    roughness: 0.80,
  }));
  const matBark = ownMat(new MeshStandardMaterial({
    color: 0x734d33,
    map: textures.barkMap,
    bumpMap: textures.barkBump,
    bumpScale: 0.09,
    roughness: 0.92,
  }));
  const matStone = ownMat(new MeshStandardMaterial({
    color: 0xc2ccd7,
    map: textures.stoneMap,
    bumpMap: textures.stoneBump,
    bumpScale: 0.075,
    roughness: 0.86,
  }));
  const matStoneDark = ownMat(new MeshStandardMaterial({
    color: 0x8e9cab,
    map: textures.stoneMap,
    bumpMap: textures.stoneBump,
    bumpScale: 0.08,
    roughness: 0.88,
  }));
  const matMarble = ownMat(new MeshStandardMaterial({
    color: 0xe6edf5,
    map: textures.stoneMap,
    bumpMap: textures.stoneBump,
    bumpScale: 0.035,
    roughness: 0.58,
    metalness: 0.06,
  }));
  const matIron = ownMat(new MeshStandardMaterial({ color: 0x2f3b4c, roughness: 0.44, metalness: 0.56 }));
  const matBrass = ownMat(new MeshStandardMaterial({ color: 0xeab308, roughness: 0.30, metalness: 0.72 }));
  const matCanvas = ownMat(new MeshStandardMaterial({
    color: 0xfdf9f0,
    map: textures.plasterMap,
    roughness: 0.80,
    side: DoubleSide,
  }));
  const matParchment = ownMat(new MeshStandardMaterial({ color: 0xf3e5c0, map: textures.plasterMap, roughness: 0.88 }));
  const matTerracotta = ownMat(new MeshStandardMaterial({ color: 0xc86442, roughness: 0.82 }));
  const matWaterTile = markSharedMaterial(new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
    },
    vertexShader: FOUNTAIN_WATER_VERTEX,
    fragmentShader: FOUNTAIN_WATER_FRAGMENT,
  }));

  // 지붕 8색·나뭇잎 7색·깃발/꽃 색상을 instanceColor로 1 draw call 배칭하기 위한 백색 베이스 머티리얼
  const matRoofBase = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    map: textures.roofMap,
    bumpMap: textures.roofBump,
    bumpScale: 0.068,
    roughness: 0.74,
  }));
  const matFoliageBase = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    map: textures.foliageMap,
    bumpMap: textures.foliageBump,
    bumpScale: 0.075,
    roughness: 0.84,
  }));
  const matAccentBase = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.66,
  }));
  const matBannerBase = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.65,
    side: DoubleSide,
  }));
  const matCrystal = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x7dd3fc,
    emissiveIntensity: 0.85,
    roughness: 0.16,
    metalness: 0.18,
  }));

  const matWindow = ownMat(new MeshStandardMaterial({
    color: 0xfff3ba,
    emissive: 0xffb830,
    emissiveIntensity: 0.14,
    roughness: 0.26,
    metalness: 0.12,
  }));
  const matLanternGlass = ownMat(new MeshStandardMaterial({
    color: 0xfff5c0,
    emissive: 0xffc43d,
    emissiveIntensity: 0.22,
    roughness: 0.24,
  }));
  const matScreen = ownMat(new MeshStandardMaterial({
    color: 0x67e8f9,
    emissive: 0x22d3ee,
    emissiveIntensity: 0.65,
    roughness: 0.28,
  }));
  const matFlameOuter = markSharedMaterial(new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCore: { value: 0 },
      uNight: { value: 0 },
    },
    vertexShader: CAMPFIRE_FLAME_VERTEX,
    fragmentShader: CAMPFIRE_FLAME_FRAGMENT,
  }));
  const matFlameCore = markSharedMaterial(new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uCore: { value: 1 },
      uNight: { value: 0 },
    },
    vertexShader: CAMPFIRE_FLAME_VERTEX,
    fragmentShader: CAMPFIRE_FLAME_FRAGMENT,
  }));
  const matFlameCoal = markSharedMaterial(new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
    },
    vertexShader: CAMPFIRE_COAL_VERTEX,
    fragmentShader: CAMPFIRE_COAL_FRAGMENT,
  }));
  const matFlameEmber = ownMat(new MeshBasicMaterial({
    color: 0xffb347,
    transparent: true,
    opacity: 0.92,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  }));
  const contactShadowMat = ownMat(new MeshBasicMaterial({
    map: textures.contactShadowMap,
    transparent: true,
    depthWrite: false,
    opacity: 0.86,
  }));
  const matCloud = ownMat(new MeshStandardMaterial({ color: 0xfafcff, roughness: 0.96 }));
  const matSmoke = ownMat(new MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.95, transparent: true, opacity: 0.52 }));
  const matPad = ownMat(new MeshStandardMaterial({ color: 0x3da352, roughness: 0.75 }));
  const matLotus = ownMat(new MeshStandardMaterial({ color: 0xf9a8d4, roughness: 0.65 }));
  const matSnowCap = ownMat(new MeshStandardMaterial({
    color: 0xf0f7ff,
    map: textures.plasterMap,
    roughness: 0.80,
    metalness: 0.02,
  }));
  const matFishingSign = ownMat(new MeshStandardMaterial({
    map: textures.fishingSignMap,
    roughness: 0.68,
    side: DoubleSide,
  }));
  const matBlueprintEasel = ownMat(new MeshStandardMaterial({
    map: textures.blueprintEaselMap,
    roughness: 0.62,
  }));
  const matPlazaSignRight = ownMat(new MeshStandardMaterial({
    map: textures.plazaSignRightMap,
    roughness: 0.74,
    side: DoubleSide,
  }));
  const matPlazaSignLeft = ownMat(new MeshStandardMaterial({
    map: textures.plazaSignLeftMap,
    roughness: 0.74,
    side: DoubleSide,
  }));
  const matRoadSignRight = ownMat(new MeshStandardMaterial({
    map: textures.roadSignRightMap,
    roughness: 0.74,
    side: DoubleSide,
  }));
  const matRoadSignLeft = ownMat(new MeshStandardMaterial({
    map: textures.roadSignLeftMap,
    roughness: 0.74,
    side: DoubleSide,
  }));
  const matInvisibleHit = ownMat(new MeshBasicMaterial({ visible: false }));

  // 공용 표지판/배너 쿼드 · 구역 레이캐스트 히트 프록시 실린더 지오메트리 (dispose 시 일괄 해제)
  const signPlaqueGeo = markSharedGeometry(new PlaneGeometry(1, 1));
  const districtHitGeo = markSharedGeometry(new CylinderGeometry(1, 1, 1, 10));
  districtHitGeo.translate(0, 0.5, 0);
  const dynamicSignTextures: CanvasTexture[] = [];
  const dynamicSignMaterials: MeshStandardMaterial[] = [];

  function disposeDynamicSignResources(): void {
    for (const mat of dynamicSignMaterials) mat.dispose();
    dynamicSignMaterials.length = 0;
    for (const tex of dynamicSignTextures) tex.dispose();
    dynamicSignTextures.length = 0;
  }

  function createOwnedSignMaterial(tex: CanvasTexture, doubleSided = false): MeshStandardMaterial {
    dynamicSignTextures.push(tex);
    const mat = new MeshStandardMaterial({
      map: tex,
      roughness: 0.68,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      ...(doubleSided ? { side: DoubleSide } : {}),
    });
    markSharedMaterial(mat);
    dynamicSignMaterials.push(mat);
    return mat;
  }

  // 1. 초원 지형 메쉬 (380m x 380m 연속 지형, 이동 반경 88m + 정점 컬러 포장도로/마을 테라스/원경 산맥)
  const TERRAIN_SIZE = 380;
  const TERRAIN_SEG = 180;
  const terrainGeo = new PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEG, TERRAIN_SEG);
  terrainGeo.rotateX(-Math.PI * 0.5);
  const terrainColorAttr = new BufferAttribute(new Float32Array((TERRAIN_SEG + 1) * (TERRAIN_SEG + 1) * 3), 3);
  terrainGeo.setAttribute("color", terrainColorAttr);
  const terrainMat = new MeshStandardMaterial({
    vertexColors: true,
    map: textures.terrainMap,
    bumpMap: textures.terrainBump,
    bumpScale: 0.085,
    roughness: 0.90,
    metalness: 0.02,
  });
  const terrainMesh = new Mesh(terrainGeo, terrainMat);
  terrainMesh.receiveShadow = true;
  root.add(terrainMesh);

  // 2. 시냇물 & 연못 수면 메쉬 (|x| <= 86, S자 곡류 z≈8..22m 전체 커버)
  const brookGeo = new PlaneGeometry(196, 48, 160, 36);
  brookGeo.rotateX(-Math.PI * 0.5);
  const brookMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uRain: { value: 0 },
      uSunDir: { value: new Vector3(0.5, 0.85, 0.4) },
    },
    vertexShader: BROOK_VERTEX,
    fragmentShader: BROOK_FRAGMENT,
  });
  const brookMesh = new Mesh(brookGeo, brookMat);
  brookMesh.position.set(0, -0.09, 14.5);
  root.add(brookMesh);

  // 2b. 연속 곡선 흙길 리본 공유 머티리얼 (1 draw call 병합 BufferGeometry용, 지형 위 자연 페더링)
  const roadRibbonMat = markSharedMaterial(new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uNight: { value: 0 },
      uSunDir: { value: new Vector3(0.5, 0.85, 0.4) },
    },
    vertexShader: ROAD_RIBBON_VERTEX,
    fragmentShader: ROAD_RIBBON_FRAGMENT,
  }));

  // 3. 바람 따라 유유히 흘러가는 15개 비대칭 지브리 뭉게구름 (단일 InstancedMesh 1 draw call, 원형 회전 완전 제거)
  const unitGeos = getUnitGeometries();
  interface DriftingCloudPuff {
    readonly ox: number;
    readonly oy: number;
    readonly oz: number;
    readonly sx: number;
    readonly sy: number;
    readonly sz: number;
  }
  interface DriftingCloudSpec {
    readonly startAlong: number;
    readonly cross: number;
    readonly altY: number;
    readonly speed: number;
    readonly scale: number;
    readonly puffs: readonly DriftingCloudPuff[];
  }
  const CLOUD_PUFF_SHAPES: readonly (readonly DriftingCloudPuff[])[] = [
    // 길쭉한 적운형 (5퍼프)
    [
      { ox: 0, oy: 0, oz: 0, sx: 5.8, sy: 2.1, sz: 3.4 },
      { ox: 2.3, oy: -0.22, oz: 0.35, sx: 4.1, sy: 1.65, sz: 2.9 },
      { ox: -2.4, oy: -0.18, oz: -0.28, sx: 3.8, sy: 1.55, sz: 2.7 },
      { ox: 0.65, oy: 0.62, oz: -0.15, sx: 3.3, sy: 1.75, sz: 2.6 },
      { ox: -1.1, oy: 0.48, oz: 0.25, sx: 2.7, sy: 1.48, sz: 2.3 },
    ],
    // 동글동글 지브리 솜사탕형 (4퍼프)
    [
      { ox: 0, oy: 0.15, oz: 0, sx: 4.8, sy: 2.35, sz: 3.9 },
      { ox: 1.85, oy: -0.25, oz: -0.4, sx: 3.2, sy: 1.52, sz: 2.8 },
      { ox: -1.75, oy: -0.15, oz: 0.45, sx: 3.5, sy: 1.68, sz: 3.0 },
      { ox: -0.35, oy: 0.78, oz: -0.2, sx: 2.8, sy: 1.62, sz: 2.5 },
    ],
    // 작은 조각 구름 (3퍼프)
    [
      { ox: 0, oy: 0, oz: 0, sx: 3.9, sy: 1.55, sz: 2.6 },
      { ox: 1.5, oy: -0.12, oz: 0.22, sx: 2.6, sy: 1.24, sz: 2.1 },
      { ox: -1.35, oy: 0.18, oz: -0.18, sx: 2.4, sy: 1.28, sz: 2.0 },
    ],
    // 웅장한 여름 뭉게구름 (6퍼프)
    [
      { ox: 0, oy: 0.1, oz: 0, sx: 6.2, sy: 2.5, sz: 4.1 },
      { ox: 2.6, oy: -0.32, oz: 0.4, sx: 4.2, sy: 1.72, sz: 3.1 },
      { ox: -2.8, oy: -0.26, oz: -0.35, sx: 4.4, sy: 1.80, sz: 3.2 },
      { ox: 0.9, oy: 0.92, oz: 0.12, sx: 3.7, sy: 2.05, sz: 3.0 },
      { ox: -1.25, oy: 0.72, oz: -0.25, sx: 3.2, sy: 1.76, sz: 2.7 },
      { ox: 0.15, oy: 1.38, oz: -0.1, sx: 2.4, sy: 1.48, sz: 2.2 },
    ],
  ];
  // 바람 방향 (+X, +0.32Z) 정규화
  const CLOUD_WIND_LEN = Math.hypot(1.0, 0.32);
  const CLOUD_WIND_X = 1.0 / CLOUD_WIND_LEN;
  const CLOUD_WIND_Z = 0.32 / CLOUD_WIND_LEN;
  const CLOUD_PERP_X = -CLOUD_WIND_Z;
  const CLOUD_PERP_Z = CLOUD_WIND_X;
  const CLOUD_DRIFT_HALF = 155;
  const CLOUD_DRIFT_SPAN = CLOUD_DRIFT_HALF * 2;

  const driftingClouds: readonly DriftingCloudSpec[] = [
    { startAlong: -138, cross: -96, altY: 31.0, speed: 1.45, scale: 1.55, puffs: CLOUD_PUFF_SHAPES[0]! },
    { startAlong: -98, cross: -48, altY: 34.5, speed: 1.82, scale: 1.72, puffs: CLOUD_PUFF_SHAPES[3]! },
    { startAlong: -52, cross: -108, altY: 38.0, speed: 1.28, scale: 1.45, puffs: CLOUD_PUFF_SHAPES[1]! },
    { startAlong: -12, cross: -62, altY: 30.2, speed: 1.95, scale: 1.35, puffs: CLOUD_PUFF_SHAPES[2]! },
    { startAlong: 44, cross: -92, altY: 36.5, speed: 1.56, scale: 1.68, puffs: CLOUD_PUFF_SHAPES[0]! },
    { startAlong: 102, cross: -44, altY: 41.0, speed: 1.20, scale: 1.85, puffs: CLOUD_PUFF_SHAPES[3]! },
    { startAlong: -126, cross: 8, altY: 33.0, speed: 1.68, scale: 1.48, puffs: CLOUD_PUFF_SHAPES[1]! },
    { startAlong: -68, cross: 36, altY: 29.4, speed: 2.10, scale: 1.32, puffs: CLOUD_PUFF_SHAPES[2]! },
    { startAlong: 18, cross: 16, altY: 43.2, speed: 1.15, scale: 1.78, puffs: CLOUD_PUFF_SHAPES[3]! },
    { startAlong: 84, cross: 28, altY: 32.2, speed: 1.74, scale: 1.52, puffs: CLOUD_PUFF_SHAPES[0]! },
    { startAlong: -112, cross: 86, altY: 37.5, speed: 1.38, scale: 1.62, puffs: CLOUD_PUFF_SHAPES[1]! },
    { startAlong: -42, cross: 102, altY: 35.0, speed: 1.62, scale: 1.58, puffs: CLOUD_PUFF_SHAPES[0]! },
    { startAlong: 28, cross: 78, altY: 30.8, speed: 1.88, scale: 1.38, puffs: CLOUD_PUFF_SHAPES[2]! },
    { startAlong: 92, cross: 96, altY: 39.8, speed: 1.32, scale: 1.75, puffs: CLOUD_PUFF_SHAPES[3]! },
    { startAlong: 138, cross: -8, altY: 34.0, speed: 1.52, scale: 1.44, puffs: CLOUD_PUFF_SHAPES[1]! },
  ];
  const totalCloudPuffs = driftingClouds.reduce((sum, c) => sum + c.puffs.length, 0);
  const cloudInst = new InstancedMesh(unitGeos.sphere, matCloud, totalCloudPuffs);
  cloudInst.instanceMatrix.setUsage(DynamicDrawUsage);
  cloudInst.frustumCulled = false;
  root.add(cloudInst);

  // 4. 풍차 날개 그룹 (공유 지오메트리 재사용)
  const windmillBlades = new Group();
  const bladeHubGeo = markSharedGeometry(new CylinderGeometry(0.22, 0.26, 0.42, 12));
  const bladeSparGeo = markSharedGeometry(new BoxGeometry(0.11, 2.35, 0.09));
  const bladeSailGeo = markSharedGeometry(new BoxGeometry(0.56, 1.78, 0.03));
  const bladeRibGeo = markSharedGeometry(new BoxGeometry(0.58, 0.045, 0.05));
  const rotorHub = new Mesh(bladeHubGeo, matBrass);
  rotorHub.rotation.x = Math.PI * 0.5;
  windmillBlades.add(rotorHub);
  for (let i = 0; i < 4; i += 1) {
    const armGroup = new Group();
    armGroup.rotation.z = (i * Math.PI) / 2;
    const spar = new Mesh(bladeSparGeo, matTimber);
    spar.position.y = 1.22;
    spar.castShadow = true;
    const sail = new Mesh(bladeSailGeo, matCanvas);
    sail.position.set(0.26, 1.38, 0.02);
    sail.castShadow = true;
    const rib1 = new Mesh(bladeRibGeo, matWood);
    rib1.position.set(0.26, 0.85, 0.02);
    const rib2 = new Mesh(bladeRibGeo, matWood);
    rib2.position.set(0.26, 1.38, 0.02);
    const rib3 = new Mesh(bladeRibGeo, matWood);
    rib3.position.set(0.26, 1.92, 0.02);
    armGroup.add(spar, sail, rib1, rib2, rib3);
    windmillBlades.add(armGroup);
  }

  // 굴뚝 연기 4개 (공유 지오메트리)
  const smokeGeo = markSharedGeometry(new SphereGeometry(0.22, 8, 7));
  const smokePuffs: { mesh: Mesh; phase: number; baseX: number; baseY: number; baseZ: number }[] = [];

  // 동적 애니메이션 인스턴스 풀 (깃발·모닥불 불꽃·Tier 5 크리스탈 등대·루틴 미니 풍차·실시간 상태 비콘)
  const MAX_ANIM_BANNERS = 96;
  const MAX_ANIM_FLAMES = 48;
  const MAX_ANIM_CRYSTALS = 48;
  const MAX_ROUTINE_WINDMILLS = 24;
  const MAX_STATUS_BEACONS = 64;

  const bannerInstGeo = markSharedGeometry(new BoxGeometry(1, 1, 0.035));
  // 깃대 쪽(-X)이 회전축이 되도록 X +0.5 오프셋
  bannerInstGeo.translate(0.5, 0, 0);
  const bannerInstanced = new InstancedMesh(bannerInstGeo, matBannerBase, MAX_ANIM_BANNERS);
  bannerInstanced.instanceMatrix.setUsage(DynamicDrawUsage);
  bannerInstanced.frustumCulled = false;
  bannerInstanced.count = 0;
  root.add(bannerInstanced);

  /** 부드러운 물방울형 화염 껍질 지오메트리 (단순 원뿔 실루엣 제거, UV.y = 정규화 높이 0..1) */
  function createCampfireFlameGeometry(maxRadius: number, height: number, radialSegs: number, heightSegs: number): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let iy = 0; iy <= heightSegs; iy += 1) {
      const v = iy / heightSegs;
      const y = v * height;
      // 바닥 0.45 → h=0.26에서 통통한 화염 배(1.0) → 상단 0.04 부드러운 화염 끝
      const radiusProfile =
        v < 0.26
          ? 0.48 + 0.52 * Math.sin((v / 0.26) * Math.PI * 0.5)
          : Math.pow(Math.max(0.02, 1 - (v - 0.26) / 0.74), 1.35);
      const r = maxRadius * radiusProfile;
      for (let ix = 0; ix <= radialSegs; ix += 1) {
        const u = ix / radialSegs;
        const theta = u * Math.PI * 2;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        positions.push(c * r, y, s * r);
        normals.push(c, 0.22, s);
        uvs.push(u, v);
      }
    }

    const row = radialSegs + 1;
    for (let iy = 0; iy < heightSegs; iy += 1) {
      for (let ix = 0; ix < radialSegs; ix += 1) {
        const a = iy * row + ix;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return markSharedGeometry(geo);
  }

  const EMBERS_PER_FLAME = 4;
  const flameOuterGeo = createCampfireFlameGeometry(0.42, 0.96, 10, 6);
  const flameCoreGeo = createCampfireFlameGeometry(0.24, 0.66, 8, 5);
  const flameCoalGeo = markSharedGeometry(new PlaneGeometry(1.18, 1.18));
  flameCoalGeo.rotateX(-Math.PI * 0.5);
  const flameEmberGeo = markSharedGeometry(new SphereGeometry(0.032, 5, 4));

  const flameOuterInst = new InstancedMesh(flameOuterGeo, matFlameOuter, MAX_ANIM_FLAMES);
  flameOuterInst.instanceMatrix.setUsage(DynamicDrawUsage);
  flameOuterInst.frustumCulled = false;
  flameOuterInst.renderOrder = 2;
  flameOuterInst.count = 0;
  const flameCoreInst = new InstancedMesh(flameCoreGeo, matFlameCore, MAX_ANIM_FLAMES);
  flameCoreInst.instanceMatrix.setUsage(DynamicDrawUsage);
  flameCoreInst.frustumCulled = false;
  flameCoreInst.renderOrder = 3;
  flameCoreInst.count = 0;
  const flameCoalInst = new InstancedMesh(flameCoalGeo, matFlameCoal, MAX_ANIM_FLAMES);
  flameCoalInst.instanceMatrix.setUsage(DynamicDrawUsage);
  flameCoalInst.frustumCulled = false;
  flameCoalInst.renderOrder = 1;
  flameCoalInst.count = 0;
  const flameEmberInst = new InstancedMesh(flameEmberGeo, matFlameEmber, MAX_ANIM_FLAMES * EMBERS_PER_FLAME);
  flameEmberInst.instanceMatrix.setUsage(DynamicDrawUsage);
  flameEmberInst.frustumCulled = false;
  flameEmberInst.renderOrder = 4;
  flameEmberInst.count = 0;
  root.add(flameCoalInst, flameOuterInst, flameCoreInst, flameEmberInst);

  const crystalInst = new InstancedMesh(unitGeos.octahedron, matCrystal, MAX_ANIM_CRYSTALS);
  crystalInst.instanceMatrix.setUsage(DynamicDrawUsage);
  crystalInst.frustumCulled = false;
  crystalInst.count = 0;
  const crystalRingInst = new InstancedMesh(unitGeos.torusXZ, matBrass, MAX_ANIM_CRYSTALS);
  crystalRingInst.instanceMatrix.setUsage(DynamicDrawUsage);
  crystalRingInst.frustumCulled = false;
  crystalRingInst.count = 0;
  root.add(crystalInst, crystalRingInst);

  // 루틴 풍차 4엽 날개 단일 BufferGeometry (모든 루틴 마을 풍차를 1 draw call로 회전)
  function createMiniWindmillRotorGeometry(): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const pushQuad = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
      positions.push(
        ax, ay, 0, bx, by, 0, cx, cy, 0,
        ax, ay, 0, cx, cy, 0, dx, dy, 0,
      );
      for (let k = 0; k < 6; k += 1) normals.push(0, 0, 1);
    };
    for (let i = 0; i < 4; i += 1) {
      const ang = (i * Math.PI) / 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const rot = (x: number, y: number): [number, number] => [x * c - y * s, x * s + y * c];
      // 캔버스 날개 1엽 (중심에서 반경 0.24..1.32)
      const [x0, y0] = rot(0.05, 0.24);
      const [x1, y1] = rot(0.36, 0.24);
      const [x2, y2] = rot(0.32, 1.32);
      const [x3, y3] = rot(0.05, 1.32);
      pushQuad(x0, y0, x1, y1, x2, y2, x3, y3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geo.computeBoundingSphere();
    return markSharedGeometry(geo);
  }

  const routineRotorGeo = createMiniWindmillRotorGeometry();
  const routineRotorInst = new InstancedMesh(routineRotorGeo, matCanvas, MAX_ROUTINE_WINDMILLS);
  routineRotorInst.instanceMatrix.setUsage(DynamicDrawUsage);
  routineRotorInst.frustumCulled = false;
  routineRotorInst.count = 0;
  root.add(routineRotorInst);

  // 실시간 작업/질문/경보 상태 비콘 + 지면 펄스 링 (2 draw calls로 전 마을 상태 표현, 지형 리빌드 불필요)
  const matStatusBeacon = ownMat(new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
  }));
  const matStatusRing = ownMat(new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  }));
  const statusBeaconInst = new InstancedMesh(unitGeos.octahedron, matStatusBeacon, MAX_STATUS_BEACONS);
  statusBeaconInst.instanceMatrix.setUsage(DynamicDrawUsage);
  statusBeaconInst.frustumCulled = false;
  statusBeaconInst.count = 0;
  const statusRingInst = new InstancedMesh(unitGeos.torusXZ, matStatusRing, MAX_STATUS_BEACONS);
  statusRingInst.instanceMatrix.setUsage(DynamicDrawUsage);
  statusRingInst.frustumCulled = false;
  statusRingInst.count = 0;
  root.add(statusBeaconInst, statusRingInst);

  // 홀로그램 RTS 작전 깃발 풀 (씬 리빌드 없이 setDispatchFlags로 즉시 토글, 3 draw calls)
  const MAX_DISPATCH_FLAGS = 32;
  const dispatchPoleGeo = markSharedGeometry(new CylinderGeometry(0.055, 0.075, 2.75, 8));
  dispatchPoleGeo.translate(0, 1.375, 0);
  const dispatchPennantGeo = markSharedGeometry(new BoxGeometry(1.22, 0.66, 0.05));
  dispatchPennantGeo.translate(0.61, 0, 0);
  const matDispatchPennant = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffe49e,
    emissiveIntensity: 0.72,
    roughness: 0.24,
    metalness: 0.14,
    transparent: true,
    opacity: 0.92,
    side: DoubleSide,
  }));
  const matDispatchHalo = ownMat(new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  }));
  const dispatchPoleInst = new InstancedMesh(dispatchPoleGeo, matBrass, MAX_DISPATCH_FLAGS);
  dispatchPoleInst.instanceMatrix.setUsage(DynamicDrawUsage);
  dispatchPoleInst.frustumCulled = false;
  dispatchPoleInst.count = 0;
  const dispatchPennantInst = new InstancedMesh(dispatchPennantGeo, matDispatchPennant, MAX_DISPATCH_FLAGS);
  dispatchPennantInst.instanceMatrix.setUsage(DynamicDrawUsage);
  dispatchPennantInst.frustumCulled = false;
  dispatchPennantInst.count = 0;
  const dispatchHaloInst = new InstancedMesh(unitGeos.torusXZ, matDispatchHalo, MAX_DISPATCH_FLAGS);
  dispatchHaloInst.instanceMatrix.setUsage(DynamicDrawUsage);
  dispatchHaloInst.frustumCulled = false;
  dispatchHaloInst.count = 0;
  root.add(dispatchPoleInst, dispatchPennantInst, dispatchHaloInst);

  let activeDispatchFlags: {
    readonly x: number;
    readonly z: number;
    readonly groundY: number;
    readonly colorHex: number;
    readonly phase: number;
  }[] = [];

  // 제독 구역 메모 핀 풀 (메모가 있는 Theater 구역 상단에 은은하게 회전 부유, 씬 리빌드 0)
  const MAX_NOTE_PINS = 48;
  const notePinGeo = markSharedGeometry(new BoxGeometry(0.42, 0.48, 0.09));
  const matNotePin = ownMat(new MeshStandardMaterial({
    color: 0xfef08a,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.92,
    roughness: 0.24,
    metalness: 0.16,
  }));
  const notePinInst = new InstancedMesh(notePinGeo, matNotePin, MAX_NOTE_PINS);
  notePinInst.instanceMatrix.setUsage(DynamicDrawUsage);
  notePinInst.frustumCulled = false;
  notePinInst.count = 0;
  root.add(notePinInst);

  let activeNotePins: {
    readonly x: number;
    readonly z: number;
    readonly groundY: number;
    readonly phase: number;
  }[] = [];

  // 활성 작업 구역 3D 현장 시각화: 회전 홀로그램 작전 테이블/도면 링 + 지붕 굴뚝 연기 입자 (단일 InstancedMesh 재사용)
  const MAX_HOLO_TABLES = 24;
  const SMOKE_PUFFS_PER_ROOF = 4;
  const MAX_ACTIVE_SMOKE = MAX_HOLO_TABLES * SMOKE_PUFFS_PER_ROOF;

  const holoTableBaseGeo = markSharedGeometry(new CylinderGeometry(0.46, 0.56, 0.54, 8));
  holoTableBaseGeo.translate(0, 0.27, 0);
  const holoRingGeo = markSharedGeometry(new PlaneGeometry(1.75, 1.75));
  holoRingGeo.rotateX(-Math.PI * 0.5);
  const matHoloRing = markSharedMaterial(new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
    },
    vertexShader: HOLO_TABLE_RING_VERTEX,
    fragmentShader: HOLO_TABLE_RING_FRAGMENT,
  }));

  const holoTableInst = new InstancedMesh(holoTableBaseGeo, matStoneDark, MAX_HOLO_TABLES);
  holoTableInst.instanceMatrix.setUsage(DynamicDrawUsage);
  holoTableInst.frustumCulled = false;
  holoTableInst.count = 0;

  const holoRingInst = new InstancedMesh(holoRingGeo, matHoloRing, MAX_HOLO_TABLES);
  holoRingInst.instanceMatrix.setUsage(DynamicDrawUsage);
  holoRingInst.frustumCulled = false;
  holoRingInst.renderOrder = 4;
  holoRingInst.count = 0;

  const activeSmokeInst = new InstancedMesh(smokeGeo, matSmoke, MAX_ACTIVE_SMOKE);
  activeSmokeInst.instanceMatrix.setUsage(DynamicDrawUsage);
  activeSmokeInst.frustumCulled = false;
  activeSmokeInst.count = 0;
  root.add(holoTableInst, holoRingInst, activeSmokeInst);

  let activeHoloTables: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly colorHex: number;
    readonly phase: number;
  }[] = [];

  let activeChimneySmokes: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly phase: number;
  }[] = [];

  // 살아있는 초원 생태계: 파스텔 나비 16마리(butterfly.glb) + 시냇물 비단잉어 10마리(koi-fish.glb)
  let currentWeather: WorldWeatherMode = "clear";
  let rainStrength = 0;

  const ecosystemButterflyGroup = new Group();
  const ecosystemKoiGroup = new Group();
  root.add(ecosystemButterflyGroup, ecosystemKoiGroup);

  interface ButterflySeed {
    readonly anchorX: number;
    readonly anchorZ: number;
    readonly radiusX: number;
    readonly radiusZ: number;
    readonly baseAlt: number;
    readonly speed: number;
    readonly flapSpeed: number;
    readonly phase: number;
    readonly scale: number;
    readonly tintHex: number;
  }

  interface KoiSeed {
    readonly centerX: number;
    readonly spanX: number;
    readonly lateral: number;
    readonly speed: number;
    readonly phase: number;
    readonly scale: number;
  }

  const BUTTERFLY_PALETTE = [
    0xfef08a, 0xf9a8d4, 0x7dd3fc, 0xfdba74,
    0xc4b5fd, 0x86efac, 0xfda4af, 0xfde047,
  ] as const;

  const BUTTERFLY_ANCHORS: readonly [number, number][] = [
    [-4.9, -4.6], [6.6, -4.5], [-4.8, 1.5], [4.8, 3.6],
    [-3.8, -1.4], [1.6, 2.2], [-6.8, 5.2], [5.8, 7.6],
    [11.2, 6.2], [-10.5, 5.8], [14.5, 14.8], [-15.2, 13.5],
    [8.2, -2.6], [-8.4, -4.2], [2.4, 14.5], [-2.8, 13.8],
    [-34.0, -14.0], [34.0, -14.5], [-28.0, 30.0], [28.0, 31.0],
    [-54.0, 4.5], [54.0, 2.5], [0.0, -28.0], [0.0, 46.0],
    [-19.5, -14.8], [20.2, -15.4], [21.5, 25.5], [-21.5, 24.8],
    [-45.0, -24.5], [46.0, -24.5], [-46.0, 24.0], [46.0, 24.0],
    [-16.0, -48.0], [16.0, -48.0], [-14.0, 52.0], [14.0, 52.0],
  ];

  const butterflySeeds: readonly ButterflySeed[] = BUTTERFLY_ANCHORS.map(([ax, az], i) => ({
    anchorX: ax,
    anchorZ: az,
    radiusX: 1.5 + (i % 4) * 0.48,
    radiusZ: 1.3 + ((i + 2) % 4) * 0.44,
    baseAlt: 0.78 + (i % 3) * 0.34,
    speed: 0.44 + (i % 5) * 0.08,
    flapSpeed: 13.5 + (i % 4) * 2.2,
    phase: i * 1.43,
    scale: 0.85 + (i % 3) * 0.18,
    tintHex: BUTTERFLY_PALETTE[i % BUTTERFLY_PALETTE.length]!,
  }));

  const koiSeeds: readonly KoiSeed[] = [
    { centerX: 5.6, spanX: 3.6, lateral: -0.35, speed: 0.28, phase: 0.2, scale: 0.96 },
    { centerX: 6.2, spanX: 3.2, lateral: 0.38, speed: 0.24, phase: 2.1, scale: 1.08 },
    { centerX: 4.5, spanX: 2.9, lateral: 0.05, speed: 0.31, phase: 4.0, scale: 0.88 },
    { centerX: -2.4, spanX: 4.2, lateral: -0.22, speed: 0.26, phase: 1.1, scale: 1.00 },
    { centerX: -6.8, spanX: 3.8, lateral: 0.26, speed: 0.29, phase: 3.3, scale: 0.92 },
    { centerX: -14.8, spanX: 4.4, lateral: -0.18, speed: 0.25, phase: 5.2, scale: 1.04 },
    { centerX: -20.5, spanX: 3.6, lateral: 0.20, speed: 0.27, phase: 2.7, scale: 0.90 },
    { centerX: 13.2, spanX: 4.0, lateral: -0.24, speed: 0.30, phase: 0.8, scale: 1.02 },
    { centerX: 18.6, spanX: 3.8, lateral: 0.22, speed: 0.24, phase: 4.6, scale: 0.94 },
    { centerX: 0.8, spanX: 3.4, lateral: 0.30, speed: 0.32, phase: 1.8, scale: 0.86 },
    { centerX: -27.5, spanX: 4.6, lateral: 0.18, speed: 0.26, phase: 1.4, scale: 0.96 },
    { centerX: -34.0, spanX: 5.0, lateral: -0.22, speed: 0.25, phase: 0.9, scale: 1.02 },
    { centerX: -43.5, spanX: 4.8, lateral: 0.20, speed: 0.28, phase: 3.8, scale: 0.94 },
    { centerX: -52.0, spanX: 5.4, lateral: 0.24, speed: 0.23, phase: 3.1, scale: 0.95 },
    { centerX: -60.5, spanX: 4.6, lateral: -0.22, speed: 0.26, phase: 0.5, scale: 1.00 },
    { centerX: -68.0, spanX: 4.8, lateral: -0.18, speed: 0.27, phase: 5.0, scale: 0.92 },
    { centerX: -75.5, spanX: 4.2, lateral: 0.22, speed: 0.25, phase: 2.2, scale: 0.90 },
    { centerX: 26.5, spanX: 4.6, lateral: -0.16, speed: 0.27, phase: 4.1, scale: 0.98 },
    { centerX: 34.0, spanX: 5.0, lateral: 0.20, speed: 0.26, phase: 1.6, scale: 1.04 },
    { centerX: 43.0, spanX: 4.8, lateral: -0.20, speed: 0.29, phase: 5.4, scale: 0.92 },
    { centerX: 52.0, spanX: 5.2, lateral: -0.24, speed: 0.24, phase: 4.2, scale: 0.98 },
    { centerX: 60.5, spanX: 4.8, lateral: 0.22, speed: 0.27, phase: 1.2, scale: 0.96 },
    { centerX: 68.0, spanX: 4.6, lateral: 0.16, speed: 0.28, phase: 2.5, scale: 0.90 },
    { centerX: 75.5, spanX: 4.2, lateral: -0.20, speed: 0.25, phase: 3.9, scale: 0.94 },
  ];

  interface DynamicGlbInstancedLayer {
    readonly mesh: InstancedMesh;
    readonly baseLocalMat: Matrix4;
  }
  const butterflyLayers: DynamicGlbInstancedLayer[] = [];
  const koiLayers: DynamicGlbInstancedLayer[] = [];

  if (assetRegistry.hasCustomModel("butterfly")) {
    assetRegistry.mountInstancedSlot({
      slot: "butterfly",
      container: ecosystemButterflyGroup,
      transforms: butterflySeeds.map((seed, idx) => ({
        x: idx === 0 ? 0 : seed.anchorX,
        y: idx === 0 ? 0 : 1.0,
        z: idx === 0 ? 0 : seed.anchorZ,
        scale: 1,
        roofTintHex: seed.tintHex,
      })),
      castShadow: false,
      receiveShadow: false,
      onMounted: (meshes) => {
        for (const m of meshes) {
          const baseLocalMat = new Matrix4();
          m.getMatrixAt(0, baseLocalMat);
          m.instanceMatrix.setUsage(DynamicDrawUsage);
          m.frustumCulled = false;
          butterflyLayers.push({ mesh: m, baseLocalMat });
        }
      },
    });
  }

  if (assetRegistry.hasCustomModel("koi-fish")) {
    assetRegistry.mountInstancedSlot({
      slot: "koi-fish",
      container: ecosystemKoiGroup,
      transforms: koiSeeds.map((seed, idx) => ({
        x: idx === 0 ? 0 : seed.centerX,
        y: idx === 0 ? 0 : -0.22,
        z: idx === 0 ? 0 : brookProfile(seed.centerX).centerZ,
        scale: 1,
      })),
      castShadow: false,
      receiveShadow: false,
      onMounted: (meshes) => {
        for (const m of meshes) {
          const baseLocalMat = new Matrix4();
          m.getMatrixAt(0, baseLocalMat);
          m.instanceMatrix.setUsage(DynamicDrawUsage);
          m.frustumCulled = false;
          koiLayers.push({ mesh: m, baseLocalMat });
        }
      },
    });
  }

  let animatedBanners: AnimatedBanner[] = [];
  let animatedFlames: AnimatedFlame[] = [];
  let animatedCrystals: AnimatedCrystal[] = [];
  let animatedRoutineWindmills: AnimatedRoutineWindmill[] = [];
  let animatedStatusBeacons: AnimatedStatusBeacon[] = [];
  let liveWorkshopEmitters: LiveWorkshopEmitter[] = [];
  const workingVillageIds = new Set<string>();

  // 중앙 광장 3D 퀘스트 게시판 상단 긴급 알림 크리스탈/링 (씬 리빌드 없이 즉시 토글)
  const matQuestAlertCrystal = ownMat(new MeshStandardMaterial({
    color: 0xfef08a,
    emissive: 0xf59e0b,
    emissiveIntensity: 1.45,
    roughness: 0.20,
    metalness: 0.15,
  }));
  const matQuestAlertRing = ownMat(new MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  }));
  const questAlertGroup = new Group();
  const questAlertCrystal = new Mesh(unitGeos.octahedron, matQuestAlertCrystal);
  questAlertCrystal.scale.set(0.36, 0.58, 0.36);
  const questAlertRing = new Mesh(unitGeos.torusXZ, matQuestAlertRing);
  questAlertRing.scale.set(0.95, 0.45, 0.95);
  questAlertGroup.add(questAlertCrystal, questAlertRing);
  questAlertGroup.visible = false;
  root.add(questAlertGroup);
  let questBoardUrgentCount = 0;
  let questBoardBaseY = 0.36;

  // 중앙 광장 「함대 소집 종 (Parade Bell)」 동적 회전 청동 종 (공유 지오메트리 + 부드러운 진자 감쇠)
  const paradeBellMountGroup = new Group();
  const paradeBellSwingPivot = new Group();
  const bellCrownGeo = markSharedGeometry(new SphereGeometry(0.18, 12, 8));
  const bellBodyGeo = markSharedGeometry(new CylinderGeometry(0.15, 0.34, 0.42, 16));
  const bellRimGeo = markSharedGeometry(new CylinderGeometry(0.36, 0.38, 0.08, 16));
  const bellClapperGeo = markSharedGeometry(new SphereGeometry(0.085, 8, 6));
  const bellRopeGeo = markSharedGeometry(new CylinderGeometry(0.018, 0.018, 0.88, 8));
  const bellTasselGeo = markSharedGeometry(new SphereGeometry(0.055, 8, 6));
  const matBellRope = ownMat(new MeshStandardMaterial({ color: 0xe6d2a2, roughness: 0.86 }));
  const matBronzeBell = ownMat(new MeshStandardMaterial({
    color: 0xf5c542,
    emissive: 0xd97706,
    emissiveIntensity: 0.24,
    roughness: 0.24,
    metalness: 0.78,
  }));
  const bellCrown = new Mesh(bellCrownGeo, matBronzeBell);
  bellCrown.position.y = -0.06;
  bellCrown.castShadow = true;
  const bellBody = new Mesh(bellBodyGeo, matBronzeBell);
  bellBody.position.y = -0.28;
  bellBody.castShadow = true;
  const bellRim = new Mesh(bellRimGeo, matBrass);
  bellRim.position.y = -0.49;
  const bellClapper = new Mesh(bellClapperGeo, matIron);
  bellClapper.position.y = -0.54;
  const bellRope = new Mesh(bellRopeGeo, matBellRope);
  bellRope.position.set(0.26, -0.56, 0.08);
  const bellTassel = new Mesh(bellTasselGeo, matBronzeBell);
  bellTassel.position.set(0.26, -1.02, 0.08);
  paradeBellSwingPivot.add(bellCrown, bellBody, bellRim, bellClapper, bellRope, bellTassel);
  paradeBellMountGroup.add(paradeBellSwingPivot);
  root.add(paradeBellMountGroup);
  let paradeBellRingRemaining = 0;
  let paradeBellRingAge = 0;

  // 중앙 광장 「함대 우체통 (Fleet Mailbox)」 동적 회전 빨간 깃발 + 미확인 황금 편지/스파클
  const mailboxAnimGroup = new Group();
  const mailboxFlagPivot = new Group();
  mailboxFlagPivot.position.set(0.28, 1.06, 0.04);
  const mailboxFlagArmGeo = markSharedGeometry(new BoxGeometry(0.032, 0.34, 0.032));
  mailboxFlagArmGeo.translate(0, 0.17, 0);
  const mailboxFlagTabGeo = markSharedGeometry(new BoxGeometry(0.036, 0.12, 0.17));
  const mailboxEnvelopeGeo = markSharedGeometry(new BoxGeometry(0.32, 0.21, 0.045));
  const mailboxSealGeo = markSharedGeometry(new SphereGeometry(0.044, 8, 6));
  const mailboxSparkGeo = markSharedGeometry(new SphereGeometry(0.042, 6, 5));
  const matMailboxFlag = ownMat(new MeshStandardMaterial({
    color: 0xe63946,
    emissive: 0xdc2626,
    emissiveIntensity: 0.18,
    roughness: 0.42,
    metalness: 0.08,
  }));
  const matMailboxEnvelope = ownMat(new MeshStandardMaterial({
    color: 0xfef3c7,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.55,
    roughness: 0.36,
    metalness: 0.12,
  }));
  const matMailboxSpark = ownMat(new MeshBasicMaterial({
    color: 0xfde047,
    transparent: true,
    opacity: 0.9,
    blending: AdditiveBlending,
    depthWrite: false,
  }));
  const mailboxFlagArm = new Mesh(mailboxFlagArmGeo, matMailboxFlag);
  const mailboxFlagTab = new Mesh(mailboxFlagTabGeo, matMailboxFlag);
  mailboxFlagTab.position.set(0, 0.29, 0.085);
  mailboxFlagPivot.add(mailboxFlagArm, mailboxFlagTab);
  mailboxFlagPivot.rotation.x = Math.PI * 0.46;
  mailboxAnimGroup.add(mailboxFlagPivot);

  const mailboxUnreadGroup = new Group();
  mailboxUnreadGroup.visible = false;
  const mailboxEnvelopeMesh = new Mesh(mailboxEnvelopeGeo, matMailboxEnvelope);
  const mailboxSealMesh = new Mesh(mailboxSealGeo, matMailboxFlag);
  mailboxSealMesh.position.set(0, 0, 0.026);
  const mailboxEnvelopeWrap = new Group();
  mailboxEnvelopeWrap.add(mailboxEnvelopeMesh, mailboxSealMesh);
  mailboxUnreadGroup.add(mailboxEnvelopeWrap);
  const mailboxSparks: Mesh[] = [];
  for (let i = 0; i < 3; i += 1) {
    const sp = new Mesh(mailboxSparkGeo, matMailboxSpark);
    mailboxUnreadGroup.add(sp);
    mailboxSparks.push(sp);
  }
  mailboxAnimGroup.add(mailboxUnreadGroup);
  root.add(mailboxAnimGroup);
  let mailboxHasUnread = false;
  let mailboxFlagAngle = Math.PI * 0.46;

  // 중앙 광장 「별빛 연못 (Starlight Pond)」 방생 물고기·해파리·별조개·유리병 0-GC 풀 (최대 8종)
  const MAX_POND_FISH = 8;
  const pondFishGroup = new Group();
  pondFishGroup.visible = false;
  root.add(pondFishGroup);
  let pondWaterSurfaceY = 0.24;

  const pondFishBodyGeo = markSharedGeometry(new SphereGeometry(0.11, 10, 8));
  const pondFishTailGeo = markSharedGeometry(new ConeGeometry(0.068, 0.16, 4));
  const pondJellyBellGeo = markSharedGeometry(new SphereGeometry(0.125, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.58));
  const pondJellyTendrilGeo = markSharedGeometry(new CylinderGeometry(0.01, 0.005, 0.22, 5));
  pondJellyTendrilGeo.translate(0, -0.11, 0);
  const pondShellGeo = markSharedGeometry(new CylinderGeometry(0.13, 0.05, 0.048, 7));
  const pondBottleGeo = markSharedGeometry(new CylinderGeometry(0.062, 0.072, 0.22, 8));
  const pondBottleCorkGeo = markSharedGeometry(new CylinderGeometry(0.032, 0.028, 0.055, 6));
  const pondRippleGeo = markSharedGeometry(new RingGeometry(0.16, 0.24, 24));
  pondRippleGeo.rotateX(-Math.PI * 0.5);

  const POND_SPECIES_VISUALS: Readonly<Record<string, { readonly kind: "fish" | "jelly" | "shell" | "bottle"; readonly hex: number; readonly finHex: number; readonly scale: number }>> = {
    meadow_minnow: { kind: "fish", hex: 0x38bdf8, finHex: 0xe0f2fe, scale: 0.92 },
    cherry_loach: { kind: "fish", hex: 0xf472b6, finHex: 0xfce7f3, scale: 0.96 },
    golden_koi: { kind: "fish", hex: 0xfbbf24, finHex: 0xfef08a, scale: 1.18 },
    starlight_trout: { kind: "fish", hex: 0x60a5fa, finHex: 0xfef08a, scale: 1.06 },
    rainbow_carp: { kind: "fish", hex: 0x34d399, finHex: 0xfde047, scale: 1.24 },
    moon_jelly: { kind: "jelly", hex: 0xc084fc, finHex: 0xf5d0fe, scale: 1.0 },
    star_shell: { kind: "shell", hex: 0xfcd34d, finHex: 0xfffbeb, scale: 1.0 },
    message_bottle: { kind: "bottle", hex: 0x6ee7b7, finHex: 0xfef3c7, scale: 1.0 },
  };

  interface PondFishSlot {
    readonly root: Group;
    readonly fishWrap: Group;
    readonly fishTailPivot: Group;
    readonly fishMat: MeshStandardMaterial;
    readonly finMat: MeshStandardMaterial;
    readonly jellyWrap: Group;
    readonly shellWrap: Group;
    readonly bottleWrap: Group;
    kind: "fish" | "jelly" | "shell" | "bottle";
    isRainbow: boolean;
    readonly phase: number;
    readonly speed: number;
    readonly radiusX: number;
    readonly radiusZ: number;
    readonly depthOffset: number;
  }

  const pondJellyMat = ownMat(new MeshStandardMaterial({
    color: 0xd8b4fe,
    emissive: 0x9333ea,
    emissiveIntensity: 0.72,
    roughness: 0.22,
    transparent: true,
    opacity: 0.78,
    side: DoubleSide,
  }));
  const pondShellMat = ownMat(new MeshStandardMaterial({
    color: 0xfcd34d,
    emissive: 0xd97706,
    emissiveIntensity: 0.42,
    roughness: 0.28,
    metalness: 0.24,
  }));
  const pondBottleMat = ownMat(new MeshStandardMaterial({
    color: 0x6ee7b7,
    emissive: 0x059669,
    emissiveIntensity: 0.45,
    roughness: 0.16,
    transparent: true,
    opacity: 0.72,
  }));
  const pondCorkMat = ownMat(new MeshStandardMaterial({ color: 0xb47843, roughness: 0.84 }));
  const pondRippleMat = ownMat(new MeshBasicMaterial({
    color: 0xe0f2fe,
    transparent: true,
    opacity: 0.42,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  }));

  const pondSlots: PondFishSlot[] = [];
  for (let i = 0; i < MAX_POND_FISH; i += 1) {
    const slotRoot = new Group();
    slotRoot.visible = false;

    const fishMat = ownMat(new MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0c4a6e,
      emissiveIntensity: 0.34,
      roughness: 0.28,
      metalness: 0.14,
    }));
    const finMat = ownMat(new MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0x78350f,
      emissiveIntensity: 0.24,
      roughness: 0.34,
    }));

    const fishWrap = new Group();
    const fBody = new Mesh(pondFishBodyGeo, fishMat);
    fBody.scale.set(0.58, 0.74, 1.52);
    fishWrap.add(fBody);
    const fDorsal = new Mesh(pondFishTailGeo, finMat);
    fDorsal.position.set(0, 0.095, -0.02);
    fDorsal.rotation.x = -0.62;
    fDorsal.scale.set(0.38, 0.76, 0.9);
    fishWrap.add(fDorsal);
    const fishTailPivot = new Group();
    fishTailPivot.position.set(0, 0, -0.16);
    const fTail = new Mesh(pondFishTailGeo, finMat);
    fTail.position.set(0, 0, -0.06);
    fTail.rotation.x = -Math.PI * 0.5;
    fTail.scale.set(0.32, 0.95, 0.82);
    fishTailPivot.add(fTail);
    fishWrap.add(fishTailPivot);
    slotRoot.add(fishWrap);

    const jellyWrap = new Group();
    jellyWrap.visible = false;
    const jBell = new Mesh(pondJellyBellGeo, pondJellyMat);
    jellyWrap.add(jBell);
    for (let t = 0; t < 3; t += 1) {
      const a = (t / 3) * Math.PI * 2;
      const jt = new Mesh(pondJellyTendrilGeo, pondJellyMat);
      jt.position.set(Math.cos(a) * 0.055, -0.01, Math.sin(a) * 0.055);
      jellyWrap.add(jt);
    }
    slotRoot.add(jellyWrap);

    const shellWrap = new Group();
    shellWrap.visible = false;
    const shLower = new Mesh(pondShellGeo, pondShellMat);
    shLower.rotation.x = 0.2;
    const shUpper = new Mesh(pondShellGeo, pondShellMat);
    shUpper.position.set(0, 0.055, -0.03);
    shUpper.rotation.x = -0.78;
    const shPearl = new Mesh(mailboxSparkGeo, matMailboxEnvelope);
    shPearl.position.set(0, 0.02, 0.01);
    shellWrap.add(shLower, shUpper, shPearl);
    slotRoot.add(shellWrap);

    const bottleWrap = new Group();
    bottleWrap.visible = false;
    const bBody = new Mesh(pondBottleGeo, pondBottleMat);
    const bCork = new Mesh(pondBottleCorkGeo, pondCorkMat);
    bCork.position.y = 0.13;
    const bScroll = new Mesh(pondBottleCorkGeo, matMailboxEnvelope);
    bScroll.scale.set(0.95, 2.2, 0.95);
    bottleWrap.add(bBody, bCork, bScroll);
    bottleWrap.rotation.z = 0.72;
    slotRoot.add(bottleWrap);

    pondFishGroup.add(slotRoot);
    pondSlots.push({
      root: slotRoot,
      fishWrap,
      fishTailPivot,
      fishMat,
      finMat,
      jellyWrap,
      shellWrap,
      bottleWrap,
      kind: "fish",
      isRainbow: false,
      phase: i * 1.17 + 0.35,
      speed: 0.48 + (i % 4) * 0.11,
      radiusX: 0.62 + (i % 3) * 0.24,
      radiusZ: 0.56 + ((i + 1) % 3) * 0.22,
      depthOffset: -0.035 - (i % 3) * 0.022,
    });
  }

  const pondRippleMeshes: Mesh[] = [];
  for (let i = 0; i < 2; i += 1) {
    const rm = new Mesh(pondRippleGeo, pondRippleMat);
    rm.renderOrder = 5;
    pondFishGroup.add(rm);
    pondRippleMeshes.push(rm);
  }
  let activePondCount = 0;
  const pondRainbowColorScratch = new Color();

  // 살아있는 초원 생태계 3: 시냇물 오리 가족 (어미 하얀 오리 1 + 노란 아기 오리 3, 0-GC)
  const duckFamilyGroup = new Group();
  root.add(duckFamilyGroup);
  const duckBodyGeo = markSharedGeometry(new SphereGeometry(0.18, 10, 8));
  const duckHeadGeo = markSharedGeometry(new SphereGeometry(0.115, 9, 7));
  const duckBeakGeo = markSharedGeometry(new ConeGeometry(0.048, 0.11, 6));
  duckBeakGeo.rotateX(Math.PI * 0.5);
  const duckWingGeo = markSharedGeometry(new SphereGeometry(0.11, 8, 6));
  const duckEyeGeo = markSharedGeometry(new SphereGeometry(0.022, 6, 5));
  const matDuckWhite = ownMat(new MeshStandardMaterial({ color: 0xfffef8, roughness: 0.55 }));
  const matDucklingYellow = ownMat(new MeshStandardMaterial({ color: 0xfde047, roughness: 0.52 }));
  const matDuckBeak = ownMat(new MeshStandardMaterial({ color: 0xf97316, roughness: 0.45 }));
  const matDuckEye = ownMat(new MeshBasicMaterial({ color: 0x0f172a }));
  const matDuckWake = ownMat(new MeshBasicMaterial({
    color: 0xe0f2fe,
    transparent: true,
    opacity: 0.44,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  }));

  interface DuckActor {
    readonly group: Group;
    readonly headPivot: Group;
    readonly wakeMesh: Mesh;
    readonly lagDist: number;
    readonly bobPhase: number;
  }

  const duckActors: DuckActor[] = [];
  const DUCK_SPECS: readonly { readonly scale: number; readonly lagDist: number; readonly isMother: boolean }[] = [
    { scale: 1.0, lagDist: 0, isMother: true },
    { scale: 0.56, lagDist: 0.72, isMother: false },
    { scale: 0.52, lagDist: 1.32, isMother: false },
    { scale: 0.50, lagDist: 1.90, isMother: false },
  ];
  for (let i = 0; i < DUCK_SPECS.length; i += 1) {
    const spec = DUCK_SPECS[i]!;
    const matFeather = spec.isMother ? matDuckWhite : matDucklingYellow;
    const dGroup = new Group();
    dGroup.scale.setScalar(spec.scale);

    const body = new Mesh(duckBodyGeo, matFeather);
    body.scale.set(0.86, 0.72, 1.34);
    body.position.set(0, 0.08, 0);
    body.castShadow = true;
    dGroup.add(body);

    const tail = new Mesh(duckBeakGeo, matFeather);
    tail.position.set(0, 0.16, -0.22);
    tail.rotation.x = -0.55;
    tail.scale.set(1.2, 1.0, 1.25);
    dGroup.add(tail);

    const wingL = new Mesh(duckWingGeo, matFeather);
    wingL.position.set(-0.14, 0.10, -0.02);
    wingL.scale.set(0.38, 0.64, 1.25);
    const wingR = new Mesh(duckWingGeo, matFeather);
    wingR.position.set(0.14, 0.10, -0.02);
    wingR.scale.set(0.38, 0.64, 1.25);
    dGroup.add(wingL, wingR);

    const headPivot = new Group();
    headPivot.position.set(0, 0.22, 0.15);
    const head = new Mesh(duckHeadGeo, matFeather);
    headPivot.add(head);
    const beak = new Mesh(duckBeakGeo, matDuckBeak);
    beak.position.set(0, -0.015, 0.13);
    headPivot.add(beak);
    const eyeL = new Mesh(duckEyeGeo, matDuckEye);
    eyeL.position.set(-0.068, 0.032, 0.072);
    const eyeR = new Mesh(duckEyeGeo, matDuckEye);
    eyeR.position.set(0.068, 0.032, 0.072);
    headPivot.add(eyeL, eyeR);
    dGroup.add(headPivot);

    const wakeMesh = new Mesh(pondRippleGeo, matDuckWake);
    wakeMesh.position.set(0, 0.02, -0.10);
    wakeMesh.renderOrder = 5;
    dGroup.add(wakeMesh);

    duckFamilyGroup.add(dGroup);
    duckActors.push({
      group: dGroup,
      headPivot,
      wakeMesh,
      lagDist: spec.lagDist,
      bobPhase: i * 1.15,
    });
  }

  // 살아있는 초원 생태계 4: 하늘 지브리 하얀 철새 떼 (8마리, 유기적 리사주/S곡선 선회, 0-GC)
  const skyBirdsGroup = new Group();
  root.add(skyBirdsGroup);
  const birdBodyGeo = markSharedGeometry(new ConeGeometry(0.11, 0.68, 5));
  birdBodyGeo.rotateX(Math.PI * 0.5);
  const birdWingGeo = markSharedGeometry(new BoxGeometry(0.62, 0.028, 0.24));
  birdWingGeo.translate(0.31, 0, 0);
  const matSkyBird = ownMat(new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xe2e8f0,
    emissiveIntensity: 0.26,
    roughness: 0.48,
  }));

  interface SkyBirdActor {
    readonly group: Group;
    readonly wingL: Group;
    readonly wingR: Group;
    readonly timeLag: number;
    readonly offsetLat: number;
    readonly offsetY: number;
    readonly flapSpeed: number;
    readonly flapPhase: number;
    readonly scale: number;
  }

  const skyBirds: SkyBirdActor[] = [];
  for (let i = 0; i < 8; i += 1) {
    const bGroup = new Group();
    const scale = 0.88 + (i % 3) * 0.14;
    bGroup.scale.setScalar(scale);

    const body = new Mesh(birdBodyGeo, matSkyBird);
    bGroup.add(body);

    const wingL = new Group();
    wingL.position.set(-0.04, 0.02, 0.04);
    const wMeshL = new Mesh(birdWingGeo, matSkyBird);
    wMeshL.scale.x = -1;
    wingL.add(wMeshL);

    const wingR = new Group();
    wingR.position.set(0.04, 0.02, 0.04);
    const wMeshR = new Mesh(birdWingGeo, matSkyBird);
    wingR.add(wMeshR);

    bGroup.add(wingL, wingR);
    skyBirdsGroup.add(bGroup);

    const rank = Math.ceil(i / 2);
    const side = i === 0 ? 0 : (i % 2 === 1 ? -1 : 1);
    skyBirds.push({
      group: bGroup,
      wingL,
      wingR,
      timeLag: rank * 0.68 + (i % 2) * 0.22,
      offsetLat: side * (1.85 * rank + 0.45),
      offsetY: (i % 3 - 1) * 0.95,
      flapSpeed: 5.4 + (i % 4) * 0.45,
      flapPhase: i * 0.92,
      scale,
    });
  }

  // 살아있는 초원 생태계 5: 바이옴별 국지 낙화·단풍·눈송이·민들레 단일 InstancedMesh (280개, 1 draw call, 0-GC)
  const MAX_BIOME_PARTICLES = 280;
  const biomeParticleGeo = markSharedGeometry(new PlaneGeometry(0.18, 0.13));
  const biomeParticleMat = ownMat(new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.88,
    side: DoubleSide,
    depthWrite: false,
  }));
  const biomeParticleInst = new InstancedMesh(biomeParticleGeo, biomeParticleMat, MAX_BIOME_PARTICLES);
  biomeParticleInst.instanceMatrix.setUsage(DynamicDrawUsage);
  biomeParticleInst.frustumCulled = false;
  biomeParticleInst.count = 0;
  root.add(biomeParticleInst);

  interface BiomeParticleSlot {
    villageX: number;
    villageZ: number;
    villageRadius: number;
    kind: "sakura" | "autumn" | "snow" | "meadow";
    readonly angle: number;
    readonly radFrac: number;
    readonly phase: number;
    readonly fallSpeed: number;
    readonly swayAmp: number;
    readonly scale: number;
  }

  const biomeParticleSlots: BiomeParticleSlot[] = Array.from({ length: MAX_BIOME_PARTICLES }, (_, i) => ({
    villageX: 0,
    villageZ: 0,
    villageRadius: 7,
    kind: "meadow",
    angle: hash2(i * 1.73, 5.19) * Math.PI * 2,
    radFrac: 0.18 + Math.sqrt(hash2(i * 3.11, 9.43)) * 0.96,
    phase: hash2(i * 2.41, 13.7),
    fallSpeed: 0.11 + hash2(i * 4.27, 2.83) * 0.08,
    swayAmp: 0.65 + hash2(i * 5.09, 8.17) * 0.85,
    scale: 0.72 + hash2(i * 6.31, 4.13) * 0.62,
  }));
  let activeBiomeParticleCount = 0;

  const BIOME_PARTICLE_PALETTES = {
    sakura: [0xfbcfe8, 0xf9a8d4, 0xfda4af, 0xfff1f2],
    autumn: [0xdc2626, 0xea580c, 0xf59e0b, 0xfbbf24],
    snow: [0xffffff, 0xf0f9ff, 0xe0f2fe, 0xbae6fd],
    meadow: [0xfef9c3, 0xfde68a, 0xfffbeb, 0xd9f99d],
  } as const;
  const biomeParticleColorScratch = new Color();

  function resolveBiomeParticleKind(biome: string): "sakura" | "autumn" | "snow" | "meadow" {
    if (biome === "sakura" || biome === "blossom") return "sakura";
    if (biome === "autumn") return "autumn";
    if (biome === "citadel" || biome === "snow") return "snow";
    return "meadow";
  }

  function syncVillageBiomeParticlesInternal(villages: readonly VillageBiomeParticleTarget[]): void {
    if (villages.length === 0) {
      activeBiomeParticleCount = 0;
      biomeParticleInst.count = 0;
      return;
    }
    const perVillage = Math.max(1, Math.floor(MAX_BIOME_PARTICLES / villages.length));
    let count = 0;
    for (let vi = 0; vi < villages.length && count < MAX_BIOME_PARTICLES; vi += 1) {
      const v = villages[vi]!;
      let resolvedBiome: string = v.biome;
      if (v.biome === "meadow") {
        if (v.label) {
          resolvedBiome = resolveEffectiveVillageTheme({ biome: "meadow", label: v.label });
        } else {
          const matched = currentVillages.find((cv) => Math.hypot(cv.x - v.x, cv.z - v.z) < 0.5);
          if (matched) resolvedBiome = resolveEffectiveVillageTheme(matched);
        }
      }
      const kind = resolveBiomeParticleKind(resolvedBiome);
      const palette = BIOME_PARTICLE_PALETTES[kind];
      const limit = vi === villages.length - 1
        ? MAX_BIOME_PARTICLES - count
        : Math.min(perVillage, MAX_BIOME_PARTICLES - count);
      for (let k = 0; k < limit; k += 1) {
        const slot = biomeParticleSlots[count]!;
        slot.villageX = v.x;
        slot.villageZ = v.z;
        slot.villageRadius = Math.max(4.5, v.radius);
        slot.kind = kind;
        biomeParticleColorScratch.setHex(palette[(count + k) % palette.length]!);
        biomeParticleInst.setColorAt(count, biomeParticleColorScratch);
        count += 1;
      }
    }
    activeBiomeParticleCount = count;
    biomeParticleInst.count = count;
    if (biomeParticleInst.instanceColor) biomeParticleInst.instanceColor.needsUpdate = true;
  }

  // 심시티 구역 호버/선택 공유 하이라이트 링 + 부드러운 호버 발광 아우라 (0-GC)
  const highlightGeo = new PlaneGeometry(2, 2);
  highlightGeo.rotateX(-Math.PI * 0.5);
  const hoverHighlightMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new Color(0x38bdf8) },
      uTime: { value: 0 },
      uSelected: { value: 0 },
    },
    vertexShader: HIGHLIGHT_VERTEX,
    fragmentShader: HIGHLIGHT_FRAGMENT,
  });
  const selectedHighlightMat = new ShaderMaterial({
    glslVersion: GLSL3,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new Color(0xfbbf24) },
      uTime: { value: 0 },
      uSelected: { value: 1 },
    },
    vertexShader: HIGHLIGHT_VERTEX,
    fragmentShader: HIGHLIGHT_FRAGMENT,
  });
  const hoverAuraGeo = markSharedGeometry(new CylinderGeometry(0.96, 1.04, 0.44, 24, 1, true));
  hoverAuraGeo.translate(0, 0.22, 0);
  const hoverAuraMat = ownMat(new MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    side: DoubleSide,
    depthWrite: false,
  }));
  const hoverHighlightMesh = new Mesh(highlightGeo, hoverHighlightMat);
  hoverHighlightMesh.visible = false;
  hoverHighlightMesh.renderOrder = 3;
  const hoverAuraMesh = new Mesh(hoverAuraGeo, hoverAuraMat);
  hoverAuraMesh.visible = false;
  hoverAuraMesh.renderOrder = 3;
  const selectedHighlightMesh = new Mesh(highlightGeo, selectedHighlightMat);
  selectedHighlightMesh.visible = false;
  selectedHighlightMesh.renderOrder = 4;
  root.add(hoverHighlightMesh, hoverAuraMesh, selectedHighlightMesh);
  let hoverFadeAlpha = 0;
  let hoverDisplayedDistrict: WorldDistrictSpec | null = null;

  // 5. GPU 바람 파동(Wind Gust) 인스탄싱 풀잎(13,500개) & 들꽃(2,600개) & 야간 반딧불이(84개)
  const MAX_GRASS = 13500;
  const MAX_FLOWERS = 2600;
  const MAX_FIREFLIES = 84;
  const windTimeUniform = { value: 0 };
  const grassMaxHeightUniform = { value: 0.42 };
  const meadowNightUniform = { value: 0 };

  function createGrassTuftGeometry(): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const blades: readonly [number, number, number, number][] = [
      [-0.12, 0.28, -0.06, 0.036],
      [-0.04, 0.37, 0.05, 0.038],
      [0.02, 0.42, -0.02, 0.040],
      [0.09, 0.34, 0.06, 0.036],
      [0.14, 0.26, -0.05, 0.032],
    ];
    for (const [tipX, tipY, tipZ, halfW] of blades) {
      const baseX = tipX * 0.25;
      const baseZ = tipZ * 0.25;
      positions.push(
        baseX - halfW, 0, baseZ,
        baseX + halfW, 0, baseZ,
        tipX, tipY, tipZ,
      );
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    return geo;
  }

  const grassBladeGeo = createGrassTuftGeometry();
  const grassMat = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.84,
    metalness: 0.0,
    side: DoubleSide,
  });
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms["uWindTime"] = windTimeUniform;
    shader.uniforms["uGrassMaxH"] = grassMaxHeightUniform;
    shader.uniforms["uNight"] = meadowNightUniform;
    shader.vertexShader = `uniform float uWindTime;\nuniform float uGrassMaxH;\nvarying float vBladeH;\nvarying float vGust;\n` + shader.vertexShader
      .replace(
        "#include <beginnormal_vertex>",
        /* glsl */ `
        #include <beginnormal_vertex>
        // 지브리/야숨풍 잔디 쉐이딩: 3D V-fold 굴곡은 25% 남기고 나머지는 상향 법선으로 부드럽게 통합
        objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), 0.75));
        `,
      )
      .replace(
        "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>
      float bend = clamp(position.y / max(0.08, uGrassMaxH), 0.0, 1.0);
      vBladeH = bend;
      vGust = 0.0;
      #ifdef USE_INSTANCING
        vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        // 초원 전역을 대각선으로 훑고 지나가는 지브리풍 바람 파동(wind gust wave)
        float gustWave = sin(uWindTime * 1.15 - instPos.x * 0.085 - instPos.z * 0.065) * 0.5 + 0.5;
        float gust = smoothstep(0.28, 0.96, gustWave);
        vGust = gust;
        float flutter = sin(uWindTime * 2.2 + instPos.x * 0.34 + instPos.z * 0.28) * 0.12
                      + cos(uWindTime * 3.5 + instPos.x * 0.65) * 0.04;
        float sway = flutter + gust * 0.16;
        transformed.x += sway * bend * bend;
        transformed.z += (sway * 0.58 + gust * 0.06) * bend * bend;
        transformed.y -= gust * 0.045 * bend * bend;
      #endif
      `,
    );
    shader.fragmentShader = `uniform float uNight;\nvarying float vBladeH;\nvarying float vGust;\n` + shader.fragmentShader
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        #include <color_fragment>
        vec3 bladeGrad = mix(vec3(0.74, 0.84, 0.70), vec3(1.16, 1.20, 0.94), smoothstep(0.0, 1.0, vBladeH));
        // 바람이 스칠 때 잎끝이 햇살을 머금고 연둣빛으로 반짝이는 효과 (밤에는 차분하게 억제)
        bladeGrad *= mix(1.0, 1.10, vGust * vBladeH * (1.0 - uNight * 0.75));
        diffuseColor.rgb *= bladeGrad;
        // 야간 무드 대비: 밤에 형광 녹색 채도를 차분한 지브리 미드나잇 블루/슬레이트로 톤 다운
        float gLuma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 midnightBlade = mix(vec3(0.16, 0.27, 0.42), vec3(0.24, 0.38, 0.56), vBladeH) * max(0.35, gLuma * 1.45);
        diffuseColor.rgb = mix(diffuseColor.rgb, midnightBlade, uNight * 0.72);
        `,
      )
      .replace(
        "#include <normal_fragment_begin>",
        /* glsl */ `
        #include <normal_fragment_begin>
        normal = normalize(vNormal);
        `,
      );
  };
  let disposed = false;

  const grassInstanced = new InstancedMesh(grassBladeGeo, grassMat, MAX_GRASS);
  grassInstanced.receiveShadow = true;
  grassInstanced.frustumCulled = false;
  root.add(grassInstanced);

  if (assetRegistry.hasCustomModel("grass-tuft")) {
    const GRASS_GLB_TARGET_H = 0.44;
    void assetRegistry.loadSlotGeometry("grass-tuft", { targetHeight: GRASS_GLB_TARGET_H }).then((geo) => {
      if (disposed || !geo) return;
      grassInstanced.geometry = geo;
      grassMaxHeightUniform.value = GRASS_GLB_TARGET_H;
    });
  }

  function createWildflowerGeometry(): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const partTags: number[] = [];
    const pushTri = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
      tag: number,
    ) => {
      positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      partTags.push(tag, tag, tag);
    };
    const sw = 0.016;
    pushTri(-sw, 0, 0, sw, 0, 0, 0, 0.24, 0, 0);
    pushTri(0, 0, -sw, 0, 0, sw, 0, 0.24, 0, 0);

    const petals = 5;
    const pR = 0.115;
    for (let i = 0; i < petals; i += 1) {
      const a = (i / petals) * Math.PI * 2;
      const aL = a - 0.38;
      const aR = a + 0.38;
      pushTri(
        0, 0.238, 0,
        Math.cos(aL) * pR, 0.246, Math.sin(aL) * pR,
        Math.cos(aR) * pR, 0.246, Math.sin(aR) * pR,
        1,
      );
    }
    const cR = 0.042;
    for (let i = 0; i < 5; i += 1) {
      const a0 = (i / 5) * Math.PI * 2;
      const a1 = ((i + 1) / 5) * Math.PI * 2;
      pushTri(
        0, 0.258, 0,
        Math.cos(a0) * cR, 0.252, Math.sin(a0) * cR,
        Math.cos(a1) * cR, 0.252, Math.sin(a1) * cR,
        2,
      );
    }

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("aPart", new BufferAttribute(new Float32Array(partTags), 1));
    return geo;
  }

  const flowerHeadGeo = createWildflowerGeometry();
  const flowerMat = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.78,
    side: DoubleSide,
  });
  flowerMat.onBeforeCompile = (shader) => {
    shader.uniforms["uWindTime"] = windTimeUniform;
    shader.uniforms["uNight"] = meadowNightUniform;
    shader.vertexShader = `uniform float uWindTime;\nattribute float aPart;\nvarying float vPart;\n` + shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>
      vPart = aPart;
      #ifdef USE_INSTANCING
        vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float bend = clamp(position.y / 0.25, 0.0, 1.0);
        float sway = sin(uWindTime * 2.1 + instPos.x * 0.42 + instPos.z * 0.33) * 0.09 * bend;
        transformed.x += sway;
        transformed.z += sway * 0.5;
      #endif
      `,
    );
    shader.fragmentShader = `uniform float uNight;\nvarying float vPart;\n` + shader.fragmentShader
      .replace(
        "#include <normal_fragment_begin>",
        /* glsl */ `
        #include <normal_fragment_begin>
        normal = normalize(vNormal);
        `,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        #include <color_fragment>
        if (vPart < 0.5) {
          diffuseColor.rgb = vec3(0.28, 0.68, 0.28);
        } else if (vPart > 1.5) {
          diffuseColor.rgb = vec3(0.99, 0.80, 0.16);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.52, 0.64, 0.88), uNight * 0.60);
        `,
      );
  };
  const flowerInstanced = new InstancedMesh(flowerHeadGeo, flowerMat, MAX_FLOWERS);
  flowerInstanced.frustumCulled = false;
  root.add(flowerInstanced);

  const fireflyGeo = new SphereGeometry(0.065, 6, 6);
  const fireflyMat = new MeshBasicMaterial({ color: 0xeef97a, transparent: true, opacity: 0 });
  const fireflyInstanced = new InstancedMesh(fireflyGeo, fireflyMat, MAX_FIREFLIES);
  fireflyInstanced.instanceMatrix.setUsage(DynamicDrawUsage);
  fireflyInstanced.frustumCulled = false;
  root.add(fireflyInstanced);
  const fireflySeeds = Array.from({ length: MAX_FIREFLIES }, (_, i) => {
    const ang = (i / MAX_FIREFLIES) * Math.PI * 2 * 3.7;
    const rad = 6 + (i % 19) * 4.2;
    return {
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad,
      phase: i * 1.37,
    };
  });

  // 시냇물 횡단 아치 목교 4기 (중앙 2기 + 동/서 외곽 순환 목교 2기, brook-geometry.ts 단일 진실 공유)
  const BRIDGES: readonly BrookBridgeSpec[] = BROOK_BRIDGES;
  const BRIDGE_EAST = BRIDGES[0]!;
  const BRIDGE_WEST = BRIDGES[1]!;
  const BRIDGE_EAST_OUTER = BRIDGES[2]!;
  const BRIDGE_WEST_OUTER = BRIDGES[3]!;

  let currentSignature = "";
  let currentZones: readonly WorldZoneSpec[] = [];
  let currentVillages: readonly WorldVillageSpec[] = [];
  interface RoadSegment {
    readonly ax: number;
    readonly az: number;
    readonly bx: number;
    readonly bz: number;
    readonly width: number;
    readonly curveAmp: number;
    readonly curvePhase: number;
    readonly curveAmp2?: number | undefined;
    readonly curvePhase2?: number | undefined;
    readonly isMainRoad?: boolean | undefined;
    readonly isBridgeDeck?: boolean | undefined;
  }

  interface OrientedBoxClearZone {
    readonly cx: number;
    readonly cz: number;
    readonly halfW: number;
    readonly halfD: number;
    readonly cosY: number;
    readonly sinY: number;
  }

  let roadSegments: RoadSegment[] = [];
  let colliders: CircleCollider[] = [];
  let grassClearZones: CircleCollider[] = [];
  let grassClearBoxes: OrientedBoxClearZone[] = [];
  let cameraOccluders: CameraOccluder[] = [];
  let cameraOccluderObjects: Object3D[] = [];
  const districtHitGroup = new Group();
  districtHitGroup.name = "the-world-district-hit-group";
  districtHitGroup.userData["kind"] = "district-hit-group";
  let districtHitTargets: Object3D[] = [];
  const districtRaycastScratch: Intersection[] = [];
  let fishingSpotAnchors: FishingSpotAnchor[] = [];
  let forestAudioAnchors: { readonly x: number; readonly z: number }[] = [];
  const streetlampAnchors: Vector3[] = [];
  let lastHoveredDistrict: WorldDistrictSpec | null = null;
  let lastSelectedDistrict: WorldDistrictSpec | null = null;

  function evalRoadCurveOffset(seg: RoadSegment, t: number): number {
    if (Math.abs(seg.curveAmp) <= 0.001 && Math.abs(seg.curveAmp2 ?? 0) <= 0.001) return 0;
    // 양끝(광장·다리·마을 정문 앞마당)에서 값과 접선 기울기가 0으로 감쇠하는 C1 다중 하모닉 시골길 곡선
    const taper = Math.sin(t * Math.PI);
    const env = taper * taper;
    const h1 = Math.sin(t * Math.PI * 1.15 + seg.curvePhase) * seg.curveAmp;
    const h2 = seg.curveAmp2 ? Math.sin(t * Math.PI * 2.35 + (seg.curvePhase2 ?? 0)) * seg.curveAmp2 : 0;
    return env * (h1 + h2);
  }

  function sampleRoadPoint(
    seg: RoadSegment,
    t: number,
  ): { x: number; z: number; dirX: number; dirZ: number; perpX: number; perpZ: number } {
    const vx = seg.bx - seg.ax;
    const vz = seg.bz - seg.az;
    const len = Math.max(0.001, Math.hypot(vx, vz));
    const dirX = vx / len;
    const dirZ = vz / len;
    const perpX = -dirZ;
    const perpZ = dirX;
    const curve = evalRoadCurveOffset(seg, t);
    return {
      x: seg.ax + vx * t + perpX * curve,
      z: seg.az + vz * t + perpZ * curve,
      dirX,
      dirZ,
      perpX,
      perpZ,
    };
  }

  /** 도로까지 최단 거리 계산 (포장도로 정점 컬러 & 풀잎 제외 마스크용, 0-GC) */
  function minRoadDistance(x: number, z: number): { dist: number; halfWidth: number } {
    const plazaCourtDist = Math.hypot(x, z + 1.6);
    if (plazaCourtDist < 4.6) {
      return { dist: 0, halfWidth: 4.6 };
    }
    let bestDist = 999;
    let bestW = 1.35;
    for (const seg of roadSegments) {
      const vx = seg.bx - seg.ax;
      const vz = seg.bz - seg.az;
      const len2 = Math.max(0.001, vx * vx + vz * vz);
      const t = Math.max(0, Math.min(1, ((x - seg.ax) * vx + (z - seg.az) * vz) / len2));
      const invLen = 1 / Math.sqrt(len2);
      const perpX = -vz * invLen;
      const perpZ = vx * invLen;
      const curve = evalRoadCurveOffset(seg, t);
      const px = seg.ax + vx * t + perpX * curve;
      const pz = seg.az + vz * t + perpZ * curve;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestDist) {
        bestDist = d;
        bestW = seg.width;
      }
    }
    return { dist: bestDist, halfWidth: bestW };
  }

  function toBridgeLocal(bridge: BrookBridgeSpec, x: number, z: number): { localX: number; localZ: number } {
    const dx = x - bridge.x;
    const dz = z - bridge.z;
    const c = Math.cos(bridge.yaw);
    const s = Math.sin(bridge.yaw);
    return {
      localX: dx * c - dz * s,
      localZ: dx * s + dz * c,
    };
  }

  function fromBridgeLocal(bridge: BrookBridgeSpec, localX: number, localZ: number): { x: number; z: number } {
    const c = Math.cos(bridge.yaw);
    const s = Math.sin(bridge.yaw);
    return {
      x: bridge.x + localX * c + localZ * s,
      z: bridge.z - localX * s + localZ * c,
    };
  }

  function getBridgeDeckHeight(x: number, z: number): number | null {
    for (const bridge of BRIDGES) {
      const { localX, localZ } = toBridgeLocal(bridge, x, z);
      if (Math.abs(localX) <= bridge.deckHalfWidth && Math.abs(localZ) <= bridge.halfSpan) {
        const arch = Math.cos((localZ / bridge.halfSpan) * Math.PI * 0.5);
        return 0.34 + arch * 0.44;
      }
    }
    return null;
  }

  /** 연속 초원 지형 높이 계산 (마을 테라스 평탄화 + 88m 이후 산맥 상승 + 마른 골짜기 음수 침하 방지) */
  function getTerrainBaseHeight(x: number, z: number): number {
    const rCenter = Math.hypot(x, z);

    // 기본 초원 높이를 0.56으로 안정화하고 마른 저지대 하한을 0.24m로 클램프 → 오직 시냇물 수로만 0 이하로 파짐
    let h = 0.56
      + Math.sin(x * 0.065) * Math.cos(z * 0.062) * 0.42
      + Math.sin((x + z) * 0.11) * 0.14
      + Math.cos((x - z * 1.2) * 0.045) * 0.22;
    h = Math.max(0.24, h);

    // 원경 목초지 언덕 & 산맥 실루엣 (r > 88m 부터 부드럽게 솟아오름)
    if (rCenter > WORLD_PLAY_RADIUS) {
      const rimT = smoothstep(WORLD_PLAY_RADIUS, 178, rCenter);
      const ang = Math.atan2(z, x);
      const ridge = 1.0 + 0.46 * Math.sin(ang * 5.0 + 0.7) + 0.26 * Math.cos(ang * 9.0);
      h += rimT * rimT * 24.5 * ridge;
    }

    // 광장 · 정원 · 아웃포스트 평탄화 테라스
    for (const zone of currentZones) {
      if (zone.kind === "village") continue;
      const d = Math.hypot(x - zone.x, z - zone.z);
      const flatR = zone.kind === "plaza" ? 10.5 : 6.4;
      if (d < flatR + 5.5) {
        const w = 1 - smoothstep(flatR - 1.2, flatR + 5.5, d);
        const targetH = zone.kind === "plaza" ? 0.36 : zone.kind === "garden" ? 0.58 : 0.44;
        h = h * (1 - w) + targetH * w;
      }
    }

    // 사령관별 마을 평탄화 테라스 (발전도가 높을수록 살짝 돋운 기단 테라스)
    for (const village of currentVillages) {
      const d = Math.hypot(x - village.x, z - village.z);
      const flatR = village.radius + 0.9;
      if (d < flatR + 4.8) {
        const w = 1 - smoothstep(flatR - 0.8, flatR + 4.8, d);
        const targetH = 0.44 + Math.min(0.24, village.overallTier * 0.045);
        h = h * (1 - w) + targetH * w;
      }
    }

    // 시냇물 & 연못 수로 조각 (x 범위 -86..86 내)
    if (Math.abs(x) < BROOK_SPAN_HALF_X + 2) {
      const { centerZ, halfWidth } = brookProfile(x);
      const bd = Math.abs(z - centerZ);
      if (bd < halfWidth + 2.2) {
        const bankFactor = 1 - smoothstep(halfWidth * 0.55, halfWidth + 2.0, bd);
        const edgeFade = 1 - smoothstep(BROOK_SPAN_HALF_X - 10, BROOK_SPAN_HALF_X, Math.abs(x));
        h = h * (1 - bankFactor * edgeFade) + (-0.54) * (bankFactor * edgeFade);
      }
    }

    return h;
  }

  // 외곽 지평선 원경 수목 띠 (r = 95..128m, ~156그루, 충돌체 0, 공유 InstancedMesh 2 draw calls, 0-GC)
  function createHorizonCanopyGeometry(): BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    let vertCursor = 0;

    const pushConeTier = (baseY: number, tipY: number, baseR: number, segs: number) => {
      const h = tipY - baseY;
      const slopeLen = Math.hypot(baseR, h);
      const ny = baseR / slopeLen;
      const nr = h / slopeLen;
      const tipIdx = vertCursor;
      positions.push(0, tipY, 0);
      normals.push(0, 1, 0);
      vertCursor += 1;

      const ringStart = vertCursor;
      for (let i = 0; i <= segs; i += 1) {
        const a = (i / segs) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        positions.push(c * baseR, baseY, s * baseR);
        normals.push(c * nr, ny, s * nr);
        vertCursor += 1;
      }
      for (let i = 0; i < segs; i += 1) {
        indices.push(tipIdx, ringStart + i + 1, ringStart + i);
      }
    };

    // 지브리 알프스 2단 침엽/활엽 실루엣 (1개 지오메트리에 2단 수관 병합 → 1 draw call)
    pushConeTier(0.0, 1.72, 1.04, 7);
    pushConeTier(0.92, 2.86, 0.72, 7);

    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  const HORIZON_TREE_COUNT = 156;
  const horizonTrunkGeo = new CylinderGeometry(0.22, 0.42, 1.0, 5);
  horizonTrunkGeo.translate(0, 0.5, 0);
  const horizonCanopyGeo = createHorizonCanopyGeometry();

  const horizonTrunkDayTint = new Color(0x6b5140);
  const horizonTrunkNightTint = new Color(0x273245);
  const horizonCanopyDayTint = new Color(0xffffff);
  const horizonCanopyNightTint = new Color(0x476186);

  const horizonTrunkMat = ownMat(new MeshStandardMaterial({
    color: horizonTrunkDayTint.clone(),
    roughness: 0.94,
    metalness: 0.0,
  }));
  const horizonCanopyMat = ownMat(new MeshStandardMaterial({
    color: horizonCanopyDayTint.clone(),
    roughness: 0.90,
    metalness: 0.0,
    flatShading: true,
  }));

  const horizonTrunkInst = new InstancedMesh(horizonTrunkGeo, horizonTrunkMat, HORIZON_TREE_COUNT);
  const horizonCanopyInst = new InstancedMesh(horizonCanopyGeo, horizonCanopyMat, HORIZON_TREE_COUNT);
  horizonTrunkInst.frustumCulled = false;
  horizonCanopyInst.frustumCulled = false;

  const horizonPaletteNear = [0x3d7b56, 0x4c8a62, 0x59936a, 0x346f4e] as const;
  const horizonPaletteFar = [0x4c8276, 0x578d84, 0x457870, 0x62968d] as const;
  const horizonColorScratch = new Color();
  const horizonDummy = new Object3D();

  let horizonPlanted = 0;
  for (let i = 0; i < HORIZON_TREE_COUNT; i += 1) {
    const baseAngle = (i / HORIZON_TREE_COUNT) * Math.PI * 2;
    const angleJitter = (hash2(i * 1.91, 3.73) - 0.5) * 0.065;
    // 알프스 능선 군락 느낌을 위해 약간의 군집 파동 + 거리 분포(95..128m)
    const groveWave = Math.sin(baseAngle * 7.0 + 0.6) * 4.5 + Math.cos(baseAngle * 13.0) * 2.8;
    const rawR = 95.5 + hash2(i * 4.37, 11.29) * 32.0 + groveWave * 0.32;
    const distR = Math.max(95.0, Math.min(128.0, rawR));
    const ang = baseAngle + angleJitter;
    const tx = Math.cos(ang) * distR;
    const tz = Math.sin(ang) * distR;
    const groundY = getTerrainBaseHeight(tx, tz);
    if (groundY < 0.2) continue;

    const isBroad = hash2(i * 7.13, 2.17) > 0.68;
    const distFrac = (distR - 95.0) / 33.0;
    const sizeBoost = 0.86 + distFrac * 0.44 + hash2(i * 3.19, 8.41) * 0.42;
    const trunkH = (isBroad ? 1.85 : 2.35) * sizeBoost;
    const trunkR = (isBroad ? 0.68 : 0.54) * sizeBoost;
    const yaw = hash2(tx * 0.3, tz * 0.3) * Math.PI * 2;
    const tiltX = (hash2(i * 5.1, 1.3) - 0.5) * 0.07;
    const tiltZ = (hash2(i * 2.7, 9.1) - 0.5) * 0.07;

    horizonDummy.position.set(tx, groundY - 0.48, tz);
    horizonDummy.rotation.set(tiltX, yaw, tiltZ);
    horizonDummy.scale.set(trunkR, trunkH, trunkR);
    horizonDummy.updateMatrix();
    horizonTrunkInst.setMatrixAt(horizonPlanted, horizonDummy.matrix);

    const canopyW = (isBroad ? 2.65 : 1.95) * sizeBoost;
    const canopyH = (isBroad ? 1.95 : 2.85) * sizeBoost;
    horizonDummy.position.set(tx, groundY - 0.48 + trunkH * 0.72, tz);
    horizonDummy.rotation.set(tiltX, yaw, tiltZ);
    horizonDummy.scale.set(canopyW, canopyH, canopyW);
    horizonDummy.updateMatrix();
    horizonCanopyInst.setMatrixAt(horizonPlanted, horizonDummy.matrix);

    const pal = distFrac > 0.48 ? horizonPaletteFar : horizonPaletteNear;
    horizonColorScratch.setHex(pal[i % pal.length]!);
    horizonCanopyInst.setColorAt(horizonPlanted, horizonColorScratch);
    horizonPlanted += 1;
  }
  horizonTrunkInst.count = horizonPlanted;
  horizonCanopyInst.count = horizonPlanted;
  horizonTrunkInst.instanceMatrix.needsUpdate = true;
  horizonCanopyInst.instanceMatrix.needsUpdate = true;
  if (horizonCanopyInst.instanceColor) horizonCanopyInst.instanceColor.needsUpdate = true;
  root.add(horizonTrunkInst, horizonCanopyInst);

  function getGroundHeight(x: number, z: number): number {
    const bridgeY = getBridgeDeckHeight(x, z);
    const terrainY = getTerrainBaseHeight(x, z);
    return bridgeY !== null ? Math.max(terrainY, bridgeY) : terrainY;
  }

  function isWaterBlocked(x: number, z: number): boolean {
    if (getBridgeDeckHeight(x, z) !== null) return false;
    return getTerrainBaseHeight(x, z) < -0.02;
  }

  function isWalkable(x: number, z: number): boolean {
    if (Math.hypot(x, z) > WORLD_PLAY_RADIUS + 0.5) return false;
    if (isWaterBlocked(x, z)) return false;
    for (const col of colliders) {
      if (Math.hypot(x - col.x, z - col.z) < col.r) return false;
    }
    return true;
  }

  function resolveMovement(curX: number, curZ: number, nextX: number, nextZ: number, actorRadius = 0.45): { x: number; z: number } {
    let rx = nextX;
    let rz = nextZ;

    // 1. 외곽 목장 경계 (반경 88m 부드러운 원형 클램프)
    const distFromOrigin = Math.hypot(rx, rz);
    if (distFromOrigin > WORLD_PLAY_RADIUS) {
      const s = WORLD_PLAY_RADIUS / distFromOrigin;
      rx *= s;
      rz *= s;
    }

    // 2. 건물·나무·우물·모닥불 원형 슬라이딩 충돌 해소 (2패스 반복으로 인접 콜라이더 간 끼임·관통 방지)
    for (let pass = 0; pass < 2; pass += 1) {
      let pushed = false;
      for (const col of colliders) {
        const minR = col.r + actorRadius;
        const dx = rx - col.x;
        const dz = rz - col.z;
        const d = Math.hypot(dx, dz);
        if (d < minR) {
          if (d > 0.0001) {
            rx = col.x + (dx / d) * minR;
            rz = col.z + (dz / d) * minR;
          } else {
            rx = curX;
            rz = curZ;
          }
          pushed = true;
        }
      }
      if (!pushed) break;
    }

    // 3. 시냇물 침수 방지 (양쪽 목교 난간 슬라이딩 + 강변 슬라이딩)
    if (isWaterBlocked(rx, rz)) {
      let resolvedOnBridge = false;
      for (const bridge of BRIDGES) {
        const curBridge = toBridgeLocal(bridge, curX, curZ);
        if (Math.abs(curBridge.localX) <= bridge.deckHalfWidth && Math.abs(curBridge.localZ) <= bridge.halfSpan + 0.5) {
          const nextBridge = toBridgeLocal(bridge, rx, rz);
          const clampedLocalX = Math.max(-bridge.walkHalfWidth, Math.min(bridge.walkHalfWidth, nextBridge.localX));
          const clampedLocalZ = Math.max(-bridge.halfSpan, Math.min(bridge.halfSpan, nextBridge.localZ));
          const slid = fromBridgeLocal(bridge, clampedLocalX, clampedLocalZ);
          if (!isWaterBlocked(slid.x, slid.z)) {
            rx = slid.x;
            rz = slid.z;
            resolvedOnBridge = true;
            break;
          }
        }
      }
      if (!resolvedOnBridge) {
        if (!isWaterBlocked(rx, curZ)) {
          rz = curZ;
        } else if (!isWaterBlocked(curX, rz)) {
          rx = curX;
        } else {
          rx = curX;
          rz = curZ;
        }
      }
    }

    return { x: rx, z: rz };
  }

  // ─── InstancedBucketBuilder & GLB 인스탠싱 기반 고디테일 오브젝트 빌더 ───────────

  const INSTANCED_SLOT_TARGET_HEIGHTS: Partial<Record<WorldModelSlot, number>> = {
    "tree-oak": 3.65,
    "tree-pine": 4.15,
    "tree-blossom": 3.55,
    bush: 0.92,
    "district-tier1": 2.15,
    "district-tier2": 3.10,
    "district-tier3": 4.15,
    "district-tier4": 5.75,
    "district-tier5": 5.60,
    "village-gate-wood": 3.40,
    "village-gate-stone": 3.90,
    "village-signpost": 1.88,
    "river-rock": 0.52,
    reeds: 1.12,
    lilypad: 0.19,
    flowerbed: 0.62,
    "lantern-arch": 3.15,
    "trophy-statue": 2.45,
  };
  let instancedSlotQueues = new Map<WorldModelSlot, InstancedSlotTransform[]>();

  function queueInstancedSlot(slot: WorldModelSlot, tf: InstancedSlotTransform): void {
    let list = instancedSlotQueues.get(slot);
    if (!list) {
      list = [];
      instancedSlotQueues.set(slot, list);
    }
    list.push(tf);
  }

  function addGrassClearZone(x: number, z: number, r: number): void {
    grassClearZones.push({ x, z, r });
  }

  function addGrassClearBox(cx: number, cz: number, halfW: number, halfD: number, rotY = 0): void {
    grassClearBoxes.push({
      cx,
      cz,
      halfW,
      halfD,
      cosY: Math.cos(rotY),
      sinY: Math.sin(rotY),
    });
  }

  function isPointInGrassClearBoxes(x: number, z: number, extraPad = 0): boolean {
    for (let i = 0; i < grassClearBoxes.length; i += 1) {
      const box = grassClearBoxes[i]!;
      const dx = x - box.cx;
      const dz = z - box.cz;
      const localX = dx * box.cosY - dz * box.sinY;
      const localZ = dx * box.sinY + dz * box.cosY;
      if (Math.abs(localX) <= box.halfW + extraPad && Math.abs(localZ) <= box.halfD + extraPad) {
        return true;
      }
    }
    return false;
  }

  function addCameraOccluder(
    x: number,
    z: number,
    radius: number,
    height: number,
    minY?: number,
    kind?: CameraOccluder["kind"],
  ): void {
    cameraOccluders.push({
      x,
      z,
      radius,
      height,
      ...(minY !== undefined ? { minY } : {}),
      ...(kind !== undefined ? { kind } : {}),
    });
  }

  /**
   * 8개 사령관 마을(`도리` 포함) 입구·스폰·착지 직후 3인칭 카메라 후방/측면 시야 회랑 판정.
   * 이 회랑 안에 대형 수목·벚나무를 심지 않아 착지 직후 시야 가림을 원천 차단한다.
   */
  function isInVillageEntranceSightCorridor(tx: number, tz: number, extraLat = 0): boolean {
    for (let i = 0; i < currentVillages.length; i += 1) {
      const v = currentVillages[i]!;
      const gCos = Math.cos(v.gateAngle);
      const gSin = Math.sin(v.gateAngle);
      const dx = tx - v.x;
      const dz = tz - v.z;
      const along = dx * gCos + dz * gSin;
      const lateral = -dx * gSin + dz * gCos;
      if (along >= v.radius - 2.6 && along <= v.radius + 11.4 && Math.abs(lateral) < 5.6 + extraLat) {
        return true;
      }
    }
    return false;
  }

  function mountTexturedPlaque(
    parent: Group,
    mat: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    rotY: number,
    rotX = 0,
  ): Mesh {
    const m = new Mesh(signPlaqueGeo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rotX, rotY, 0, "YXZ");
    m.scale.set(width, height, 1);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function addContactShadow(
    b: InstancedBucketBuilder,
    x: number,
    z: number,
    radiusX: number,
    radiusZ = radiusX,
    rotY = 0,
  ): void {
    const gy = getTerrainBaseHeight(x, z);
    if (gy < 0.02) return;
    b.addPlane(
      contactShadowMat,
      [x, gy + 0.032, z],
      [radiusX * 2, 1, radiusZ * 2],
      rotY !== 0 ? [0, rotY, 0] : undefined,
      { renderOrder: 1 },
    );
  }

  function addFramedWindow(b: InstancedBucketBuilder, wx: number, wy: number, wz: number, rotY = 0, scale = 1, withFlowerBox = true): void {
    b.withFrame(wx, wy, wz, rotY, scale, () => {
      b.addBox(matTimber, [0, 0, 0], [0.68, 0.72, 0.08]);
      b.addBox(matWindow, [0, 0, 0.005], [0.54, 0.58, 0.09]);
      b.addBox(matTimber, [0, 0, 0.01], [0.045, 0.58, 0.11]);
      b.addBox(matTimber, [0, 0, 0.01], [0.54, 0.045, 0.11]);
      if (withFlowerBox) {
        b.addBox(matWood, [0, -0.40, 0.08], [0.72, 0.14, 0.18]);
        const flowerColors = [0xf43f5e, 0xfacc15, 0xf9a8d4];
        flowerColors.forEach((hex, idx) => {
          b.addSphere(matAccentBase, [(idx - 1) * 0.20, -0.30, 0.10], [0.15, 0.15, 0.15], undefined, { color: hex });
        });
      }
    });
  }

  function addTree(b: InstancedBucketBuilder, _parent: Group, tx: number, tz: number, scale: number, kind: "oak" | "pine" | "blossom" | "autumn" | "snow-pine", addCollider = true): void {
    const gy = getTerrainBaseHeight(tx, tz);
    if (gy < 0.08) return;
    const rotY = hash2(tx, tz) * Math.PI * 2;
    const slot: WorldModelSlot | null =
      kind === "autumn" || kind === "snow-pine"
        ? null
        : kind === "pine"
          ? "tree-pine"
          : kind === "blossom"
            ? "tree-blossom"
            : "tree-oak";

    if (slot && assetRegistry.hasCustomModel(slot)) {
      queueInstancedSlot(slot, { x: tx, y: gy, z: tz, rotationY: rotY, scale });
    } else {
      b.withFrame(tx, gy, tz, rotY, scale, () => {
        if (kind === "pine" || kind === "snow-pine") {
          const isSnowPine = kind === "snow-pine";
          b.addCylinder(matBark, [0, 0.18, 0], [0.60, 0.42, 0.60], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matBark, [0, 0.68, 0], [0.40, 1.35, 0.40], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          const tiers: readonly [number, number, number, number][] = isSnowPine
            ? [
                [2.48, 1.35, 1.36, 0x2a6668],
                [2.08, 1.24, 2.02, 0x34757a],
                [1.60, 1.15, 2.66, 0x458b92],
                [1.00, 0.98, 3.24, 0x5ea3aa],
              ]
            : [
                [2.48, 1.35, 1.36, 0x2f854b],
                [2.08, 1.24, 2.02, 0x2f854b],
                [1.60, 1.15, 2.66, 0x45a05a],
                [1.00, 0.98, 3.24, 0x45a05a],
              ];
          tiers.forEach(([diam, h, py, hex], tierIdx) => {
            b.addCone(matFoliageBase, [0, py, 0], [diam, h, diam], [0, tierIdx * 0.42, 0], {
              color: hex,
              castShadow: true,
              receiveShadow: true,
            });
            if (isSnowPine) {
              // 설원 소나무 층별 눈 모자(Snow Cap)
              b.addCone(matSnowCap, [0, py + h * 0.16, 0], [diam * 0.82, h * 0.68, diam * 0.82], [0, tierIdx * 0.42 + 0.15, 0], {
                castShadow: true,
                receiveShadow: true,
              });
            }
          });
        } else {
          b.addCylinder(matBark, [0, 0.18, 0], [0.74, 0.44, 0.74], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matBark, [0, 0.72, 0], [0.50, 1.48, 0.50], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matBark, [0.26, 1.22, 0.08], [0.19, 0.72, 0.19], [0, 0, -0.68], { tapered: true });
          b.addCylinder(matBark, [-0.24, 1.15, -0.10], [0.18, 0.62, 0.18], [0, 0, 0.62], { tapered: true });

          const baseHex = kind === "autumn" ? 0xcf4528 : kind === "blossom" ? 0xfba9cd : 0x3e9e4c;
          const midHex = kind === "autumn" ? 0xe87b22 : kind === "blossom" ? 0xfba9cd : 0x5cc458;
          const topHex = kind === "autumn" ? 0xf5ba32 : kind === "blossom" ? 0xffcce2 : 0x79d464;
          const puffs: readonly [number, number, number, number, number][] = [
            [0.0, 2.12, 0.0, 1.84, topHex],
            [0.36, 1.94, 0.28, 1.36, topHex],
            [-0.38, 1.92, -0.24, 1.32, topHex],
            [0.58, 1.56, 0.20, 1.30, midHex],
            [-0.56, 1.58, -0.26, 1.32, midHex],
            [0.14, 1.60, -0.54, 1.26, midHex],
            [-0.22, 1.54, 0.52, 1.22, baseHex],
          ];
          for (const [px, py, pz, diam, hex] of puffs) {
            b.addDodeca(matFoliageBase, [px, py, pz], [diam * 1.08, diam * 0.86, diam * 1.06], [px * 1.4, pz * 1.7, py * 0.6], {
              color: hex,
              castShadow: true,
              receiveShadow: true,
            });
          }
        }
      });
    }

    addContactShadow(b, tx, tz, 1.44 * scale, 1.44 * scale);
    addGrassClearZone(tx, tz, 1.22 * scale);
    // 줄기 + 대형 수관(카메라 고도 1.2~4.6m) 모두 차폐 대상으로 등록해 나뭇잎 카메라 침범 방지
    addCameraOccluder(tx, tz, 0.44 * scale, 1.65 * scale, 0, "tree");
    const canopyR = (kind === "pine" || kind === "snow-pine" ? 1.12 : 1.32) * scale;
    addCameraOccluder(tx, tz, canopyR, 4.55 * scale, 1.15 * scale, "tree");
    if (addCollider) {
      colliders.push({ x: tx, z: tz, r: 0.42 * scale });
    }
  }

  function addBushAndRockCluster(b: InstancedBucketBuilder, bx: number, bz: number, scale = 1.0): void {
    const gy = getTerrainBaseHeight(bx, bz);
    if (gy < 0.05) return;
    const rotY = hash2(bx, bz) * Math.PI * 2;
    if (assetRegistry.hasCustomModel("bush")) {
      queueInstancedSlot("bush", { x: bx, y: gy, z: bz, rotationY: rotY, scale });
    } else {
      b.withFrame(bx, gy, bz, rotY, scale, () => {
        b.addDodeca(matFoliageBase, [0, 0.26, 0], [1.04, 0.68, 0.95], undefined, { color: 0x4db556, receiveShadow: true });
        b.addDodeca(matFoliageBase, [0.34, 0.22, 0.14], [0.64, 0.60, 0.64], undefined, { color: 0x79d464, receiveShadow: true });
        b.addDodeca(matFoliageBase, [-0.18, 0.16, -0.26], [0.48, 0.46, 0.48], undefined, { color: 0x3e9e4c });
        b.addDodeca(matStone, [-0.36, 0.14, 0.18], [0.76, 0.44, 0.58], [0.22, 0.8, 0.14], { flat: true, receiveShadow: true });
        b.addDodeca(matStoneDark, [-0.56, 0.07, 0.32], [0.34, 0.18, 0.28], undefined, { flat: true });
      });
    }
    addContactShadow(b, bx, bz, 0.88 * scale, 0.78 * scale);
    addGrassClearZone(bx, bz, 0.96 * scale);
  }

  function addFenceRun(b: InstancedBucketBuilder, ax: number, az: number, bx: number, bz: number, posts: number): void {
    const yaw = Math.atan2(bx - ax, bz - az);
    const totalLen = Math.hypot(bx - ax, bz - az);
    const segLen = totalLen / Math.max(1, posts - 1);

    for (let i = 0; i < posts; i += 1) {
      const t = posts === 1 ? 0 : i / (posts - 1);
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      const py = getTerrainBaseHeight(px, pz);
      if (py < 0.05) continue;

      b.addBox(matWood, [px, py + 0.36, pz], [0.12, 0.78, 0.12], [0, yaw, 0]);
      addGrassClearZone(px, pz, 0.42);
      if (i < posts - 1) {
        const mx = ax + (bx - ax) * ((i + 0.5) / (posts - 1));
        const mz = az + (bz - az) * ((i + 0.5) / (posts - 1));
        const my = getTerrainBaseHeight(mx, mz);
        for (const ry of [0.28, 0.54]) {
          b.addBox(matWoodLight, [mx, my + ry, mz], [0.07, 0.08, segLen + 0.06], [0, yaw, 0]);
        }
      }
    }
  }

  function addHangingStreetlamp(b: InstancedBucketBuilder, lx: number, lz: number, armYaw = 0, registerLight = true): void {
    const gy = getTerrainBaseHeight(lx, lz);
    if (gy < 0.05) return;

    if (registerLight) {
      const worldBulbX = lx + Math.sin(armYaw) * 0.48;
      const worldBulbZ = lz + Math.cos(armYaw) * 0.48;
      streetlampAnchors.push(new Vector3(worldBulbX, gy + 0.18, worldBulbZ));
    }

    b.withFrame(lx, gy, lz, armYaw, 1, () => {
      b.addCylinder(matIron, [0, 0.12, 0], [0.38, 0.24, 0.38], undefined, { tapered: true });
      b.addCylinder(matIron, [0, 1.24, 0], [0.15, 2.25, 0.15], undefined, { tapered: true });
      b.addBox(matIron, [0, 2.34, 0.24], [0.06, 0.06, 0.58], [-0.14, 0, 0]);
      b.addBox(matIron, [0, 2.15, 0.14], [0.045, 0.36, 0.045], [0.65, 0, 0]);
      b.addCone(matIron, [0, 2.24, 0.48], [0.38, 0.16, 0.38]);
      b.addCylinder(matLanternGlass, [0, 2.08, 0.48], [0.24, 0.24, 0.24]);
      b.addCylinder(matIron, [0, 1.94, 0.48], [0.18, 0.06, 0.18], undefined, { tapered: true });
    });
    addContactShadow(b, lx, lz, 0.44, 0.44);
    addGrassClearZone(lx, lz, 0.68);
    addCameraOccluder(lx, lz, 0.30, 2.65, 0, "prop");
  }

  function addWoodenBench(b: InstancedBucketBuilder, bx: number, bz: number, yaw: number): void {
    const gy = getTerrainBaseHeight(bx, bz);
    if (gy < 0.05) return;
    b.withFrame(bx, gy, bz, yaw, 1, () => {
      b.addBox(matWoodLight, [0, 0.34, 0], [1.38, 0.09, 0.42], undefined, { receiveShadow: true });
      b.addBox(matWoodLight, [0, 0.54, -0.18], [1.34, 0.24, 0.07], [-0.14, 0, 0]);
      for (const lx of [-0.52, 0.52]) {
        b.addBox(matTimber, [lx, 0.17, 0.13], [0.10, 0.34, 0.10]);
        b.addBox(matTimber, [lx, 0.29, -0.15], [0.10, 0.58, 0.10]);
      }
    });
    addContactShadow(b, bx, bz, 0.90, 0.54, yaw);
    addGrassClearZone(bx, bz, 1.35);
  }

  function addWoodenSignpost(
    b: InstancedBucketBuilder,
    parent: Group,
    sx: number,
    sz: number,
    yaw: number,
    isPlaza = false,
  ): void {
    const sy = getTerrainBaseHeight(sx, sz);
    if (sy < 0.08) return;
    b.withFrame(sx, sy, sz, yaw, 1, () => {
      b.addCylinder(matBark, [0, 0.88, 0], [0.17, 1.78, 0.17], undefined, { tapered: true, castShadow: true });
      b.addBox(matWoodLight, [0.22, 1.50, 0], [0.94, 0.20, 0.06], [0, 0.34, 0]);
      b.addBox(matWood, [-0.20, 1.22, 0], [0.86, 0.20, 0.06], [0, -0.44, 0]);
      b.addSphere(matBrass, [0, 1.80, 0], [0.14, 0.14, 0.14]);
    });
    // 빈 나무 판자 방지: 양쪽 방향 화살표 안내 캔버스 텍스처 부착
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const topMat = isPlaza ? matPlazaSignRight : matRoadSignRight;
    const botMat = isPlaza ? matPlazaSignLeft : matRoadSignLeft;
    const placeArmDecals = (lx: number, ly: number, width: number, armRotY: number, mat: MeshStandardMaterial) => {
      const worldX = sx + lx * cosY;
      const worldZ = sz - lx * sinY;
      const totalYaw = yaw + armRotY;
      const nX = Math.sin(totalYaw) * 0.036;
      const nZ = Math.cos(totalYaw) * 0.036;
      mountTexturedPlaque(parent, mat, worldX + nX, sy + ly, worldZ + nZ, width, 0.17, totalYaw);
      mountTexturedPlaque(parent, mat, worldX - nX, sy + ly, worldZ - nZ, width, 0.17, totalYaw + Math.PI);
    };
    placeArmDecals(0.22, 1.50, 0.88, 0.34, topMat);
    placeArmDecals(-0.20, 1.22, 0.80, -0.44, botMat);

    addContactShadow(b, sx, sz, 0.52, 0.52);
    addGrassClearZone(sx, sz, 0.90);
    colliders.push({ x: sx, z: sz, r: 0.34 });
  }

  function registerBanner(x: number, y: number, z: number, baseRotY: number, colorHex: number, width = 0.92, height = 0.46): void {
    if (animatedBanners.length >= MAX_ANIM_BANNERS) return;
    animatedBanners.push({
      x,
      y,
      z,
      baseRotY,
      phase: x * 0.27 + z * 0.19,
      colorHex,
      width,
      height,
    });
  }

  function registerFlame(x: number, y: number, z: number, scale = 1): void {
    if (animatedFlames.length >= MAX_ANIM_FLAMES) return;
    animatedFlames.push({
      x,
      y,
      z,
      scale,
      phase: x * 0.41 + z * 0.37,
    });
  }

  function registerCrystal(x: number, y: number, z: number, scale: number, colorHex: number): void {
    if (animatedCrystals.length >= MAX_ANIM_CRYSTALS) return;
    animatedCrystals.push({
      x,
      y,
      z,
      scale,
      phase: x * 0.23 + z * 0.31,
      colorHex,
    });
  }

  /** 본부 길드 회관 & 풍차 시계탑 */
  function buildGrandGuildHall(b: InstancedBucketBuilder, parent: Group): void {
    const hx = 0;
    const hz = -7.2;
    const gy = getTerrainBaseHeight(hx, hz);

    smokePuffs.length = 0;
    for (let s = 0; s < 4; s += 1) {
      const sm = new Mesh(smokeGeo, matSmoke);
      parent.add(sm);
      smokePuffs.push({
        mesh: sm,
        phase: s * 0.25,
        baseX: hx - 1.85,
        baseY: gy + 4.65,
        baseZ: hz - 0.65,
      });
    }

    if (assetRegistry.hasCustomModel("guild-hall")) {
      const hall = new Group();
      hall.position.set(hx, gy, hz);
      assetRegistry.mountSlot({
        slot: "guild-hall",
        container: hall,
        targetHeight: 5.35,
        mountFallback: () => {},
        onMounted: (inst) => {
          const anchor = inst.anchors["smoke_anchor"];
          if (anchor) {
            hall.updateMatrixWorld(true);
            const world = anchor.clone().applyMatrix4(hall.matrixWorld);
            for (const puff of smokePuffs) {
              puff.baseX = world.x;
              puff.baseY = world.y;
              puff.baseZ = world.z;
            }
          }
        },
      });
      parent.add(hall);
    } else {
      b.withFrame(hx, gy, hz, 0, 1, () => {
        b.addBox(matStone, [0, 0.18, 0], [5.4, 0.36, 3.8], undefined, { castShadow: true, receiveShadow: true });
        b.addBox(matStoneDark, [0, 0.09, 2.12], [1.75, 0.18, 0.55], undefined, { receiveShadow: true });
        b.addBox(matPlaster, [0, 1.58, 0], [4.8, 2.45, 3.3], undefined, { castShadow: true, receiveShadow: true });

        for (const cx of [-2.38, -0.82, 0.82, 2.38]) {
          for (const cz of [-1.64, 1.64]) {
            b.addBox(matTimber, [cx, 1.58, cz], [0.13, 2.48, 0.13]);
          }
        }
        for (const by of [0.42, 1.55, 2.76]) {
          b.addBox(matTimber, [0, by, 1.65], [4.92, 0.11, 0.10]);
          b.addBox(matTimber, [0, by, -1.65], [4.92, 0.11, 0.10]);
        }

        b.addBox(matTimber, [0, 1.15, 1.66], [1.16, 1.58, 0.12]);
        b.addBox(matWood, [0, 1.12, 1.67], [0.96, 1.44, 0.14]);
        b.addSphere(matBrass, [-0.10, 1.08, 1.76], [0.09, 0.09, 0.09]);
        b.addSphere(matBrass, [0.10, 1.08, 1.76], [0.09, 0.09, 0.09]);

        b.addBox(matRoofBase, [0, 2.08, 2.04], [1.88, 0.12, 0.92], [0.22, 0, 0], { color: TONE_ROOF_HEX.amber, castShadow: true });
        for (const px of [-0.78, 0.78]) {
          b.addCylinder(matTimber, [px, 1.18, 2.36], [0.14, 1.68, 0.14], undefined, { tapered: true });
        }

        addFramedWindow(b, -1.58, 1.68, 1.66, 0, 1, true);
        addFramedWindow(b, 1.58, 1.68, 1.66, 0, 1, true);

        b.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
          y: 2.80,
          width: 4.9,
          height: 1.65,
          depth: 3.45,
          roofColor: TONE_ROOF_HEX.moss,
          castShadow: true,
          receiveShadow: true,
        });

        b.addBox(matStoneDark, [-1.85, 3.55, -0.65], [0.56, 1.85, 0.56], undefined, { castShadow: true });
        b.addBox(matStone, [-1.85, 4.50, -0.65], [0.68, 0.14, 0.68]);
      });
    }

    addContactShadow(b, hx, hz + 0.15, 3.55, 2.75);
    addGrassClearZone(hx, hz + 0.15, 3.95);
    addGrassClearBox(hx, hz + 0.15, 3.35, 2.55, 0);
    addCameraOccluder(hx, hz + 0.15, 2.85, 5.4, 0, "building");
    colliders.push({ x: hx, z: hz + 0.15, r: 2.95 });

    // 우측 풍차 시계탑 (길드 회관·퀘스트 게시판과 1.7~2.2m+ 개방 통로 확보)
    const mx = 6.2;
    const mz = -7.5;
    const mgy = getTerrainBaseHeight(mx, mz);
    const hasCustomWindmill = assetRegistry.hasCustomModel("windmill");
    windmillBlades.visible = !hasCustomWindmill;
    windmillBlades.position.set(mx, mgy + 3.55, mz + 1.25);

    if (hasCustomWindmill) {
      const mill = new Group();
      mill.position.set(mx, mgy, mz);
      assetRegistry.mountSlot({
        slot: "windmill",
        container: mill,
        targetHeight: 6.25,
        mountFallback: () => {},
        onMounted: (inst) => {
          windmillBlades.visible = false;
          if (inst.bladePivot) customBladePivots.push(inst.bladePivot);
        },
      });
      parent.add(mill);
    } else {
      b.withFrame(mx, mgy, mz, 0, 1, () => {
        b.addCylinder(matStone, [0, 0.47, 0], [2.65, 0.95, 2.65], undefined, { tapered: true, castShadow: true, receiveShadow: true });
        b.addCylinder(matPlaster, [0, 2.42, 0], [2.20, 3.05, 2.20], undefined, { tapered: true, castShadow: true, receiveShadow: true });
        b.addCylinder(matWood, [0, 1.15, 0], [2.52, 0.12, 2.52]);
        b.addCone(matRoofBase, [0, 4.55, 0], [2.16, 1.28, 2.16], undefined, { color: TONE_ROOF_HEX.cerulean, castShadow: true });
        b.addSphere(matBrass, [0, 5.24, 0], [0.24, 0.24, 0.24]);
        addFramedWindow(b, 0, 2.35, 1.02, 0, 0.76, false);
        b.addCylinder(matTimber, [0, 3.55, 0.96], [0.20, 0.65, 0.20], [Math.PI * 0.5, 0, 0]);
      });
    }

    parent.add(windmillBlades);
    addContactShadow(b, mx, mz, 2.05, 2.05);
    addGrassClearZone(mx, mz, 2.45);
    addCameraOccluder(mx, mz, 1.65, 6.4, 0, "building");
    colliders.push({ x: mx, z: mz, r: 1.55 });
  }

  /** 중앙 광장 우물 · 모닥불 · 이정표 · 벤치 · 길드 퀘스트 게시판 */
  function buildPlazaCommons(b: InstancedBucketBuilder, parent: Group): void {
    const courtY = getTerrainBaseHeight(0, -1.6);
    addGrassClearZone(0, -1.6, 5.45);
    for (let ring = 0; ring < 12; ring += 1) {
      const ang = (ring / 12) * Math.PI * 2;
      b.addCylinder(
        ring % 2 === 0 ? matStone : matStoneDark,
        [Math.cos(ang) * 3.5, courtY + 0.025, -1.6 + Math.sin(ang) * 3.5],
        [0.96, 0.05, 0.96],
        undefined,
        { receiveShadow: true },
      );
    }

    // 석조 소원 우물 (-3.8, -1.4)
    const wx = -3.8;
    const wz = -1.4;
    const wy = getTerrainBaseHeight(wx, wz);
    if (assetRegistry.hasCustomModel("well")) {
      const wellGroup = new Group();
      wellGroup.position.set(wx, wy, wz);
      assetRegistry.mountSlot({
        slot: "well",
        container: wellGroup,
        targetHeight: 2.45,
        mountFallback: () => {},
      });
      parent.add(wellGroup);
    } else {
      b.withFrame(wx, wy, wz, 0, 1, () => {
        b.addCylinder(matStoneDark, [0, 0.09, 0], [1.84, 0.18, 1.84], undefined, { tapered: true, receiveShadow: true });
        b.addCylinder(matStone, [0, 0.44, 0], [1.50, 0.68, 1.50], undefined, { castShadow: true, receiveShadow: true });
        b.addTorus(matStoneDark, [0, 0.78, 0], [1.42, 1.42, 1.42]);
        b.addCylinder(matWaterTile, [0, 0.66, 0], [1.20, 0.05, 1.20]);
        for (const px of [-0.66, 0.66]) {
          b.addBox(matTimber, [px, 1.12, 0], [0.11, 1.35, 0.11]);
        }
        b.addCylinder(matWood, [0, 1.46, 0], [0.14, 1.32, 0.14], [0, 0, Math.PI * 0.5]);
        b.addCylinder(matWood, [0, 1.08, 0], [0.26, 0.22, 0.26], undefined, { tapered: true });
        b.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
          y: 1.76,
          width: 1.62,
          height: 0.62,
          depth: 1.24,
          roofColor: TONE_ROOF_HEX.cerulean,
          includeGableWall: false,
          castShadow: true,
        });
      });
    }
    addContactShadow(b, wx, wz, 1.35, 1.35);
    addGrassClearZone(wx, wz, 1.55);
    addCameraOccluder(wx, wz, 0.95, 2.5);
    colliders.push({ x: wx, z: wz, r: 1.02 });

    // 광장 모닥불 (2.8, 1.0)
    const fx = 2.8;
    const fz = 1.0;
    const fy = getTerrainBaseHeight(fx, fz);
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      b.addDodeca(
        i % 2 === 0 ? matStone : matStoneDark,
        [fx + Math.cos(a) * 0.74, fy + 0.08, fz + Math.sin(a) * 0.74],
        [0.42, 0.26, 0.36],
        [a, a * 0.7, 0.2],
        { flat: true, receiveShadow: true },
      );
    }
    for (let l = 0; l < 3; l += 1) {
      b.addCylinder(matBark, [fx, fy + 0.12, fz], [0.18, 0.96, 0.18], [0, (l * Math.PI) / 3 + 0.2, Math.PI * 0.5]);
    }
    registerFlame(fx, fy + 0.12, fz, 1.0);
    addContactShadow(b, fx, fz, 1.15, 1.15);
    addGrassClearZone(fx, fz, 1.70);
    colliders.push({ x: fx, z: fz, r: 0.92 });

    addWoodenBench(b, fx + 1.95, fz - 0.15, -Math.PI * 0.45);
    addWoodenBench(b, fx - 0.25, fz + 1.95, Math.PI);

    // 나무 이정표 (-2.2, 1.9 — 방향 안내 캔버스 텍스처 적용)
    addWoodenSignpost(b, parent, -2.2, 1.9, 0, true);

    // 5. 중앙 광장 3D 길드 퀘스트 게시판 (WORLD_NOTICE_BOARD_POS: 북동쪽 가로등 옆, 풍차 비충돌)
    const nbx = WORLD_NOTICE_BOARD_POS.x;
    const nbz = WORLD_NOTICE_BOARD_POS.z;
    const nby = getTerrainBaseHeight(nbx, nbz);
    questBoardBaseY = nby;
    const nbYaw = Math.atan2(0 - nbx, -1.5 - nbz);
    if (assetRegistry.hasCustomModel("quest-board")) {
      const boardGroup = new Group();
      boardGroup.position.set(nbx, nby, nbz);
      boardGroup.rotation.y = nbYaw;
      assetRegistry.mountSlot({
        slot: "quest-board",
        container: boardGroup,
        targetHeight: 2.65,
        mountFallback: () => {},
      });
      parent.add(boardGroup);
    } else {
      b.withFrame(nbx, nby, nbz, nbYaw, 1, () => {
        // 석조 받침대
        b.addBox(matStone, [0, 0.08, 0], [2.15, 0.16, 0.78], undefined, { receiveShadow: true });
        // 원목 양기둥 + 받침 버팀목
        for (const px of [-0.88, 0.88]) {
          b.addBox(matTimber, [px, 1.12, 0], [0.16, 2.08, 0.16], undefined, { castShadow: true, receiveShadow: true });
          b.addBox(matWood, [px, 0.24, 0], [0.24, 0.20, 0.42]);
        }
        // 게시판 목재 프레임 & 코르크 보드 판
        b.addBox(matTimber, [0, 1.38, 0], [1.82, 1.16, 0.12], undefined, { castShadow: true, receiveShadow: true });
        b.addBox(matWoodLight, [0, 1.38, 0.02], [1.62, 0.96, 0.11]);
        b.addBox(matWood, [0, 0.84, 0.11], [1.74, 0.08, 0.16]);

        // 고정된 종이 의뢰서 4장 + 컬러 왁스 실 핀
        const notices: readonly [number, number, number, number, number, number][] = [
          [-0.46, 1.56, 0.36, 0.42, 0.06, TONE_ROOF_HEX.crimson],
          [0.04, 1.54, 0.38, 0.40, -0.05, TONE_ROOF_HEX.cerulean],
          [0.50, 1.58, 0.34, 0.38, 0.08, TONE_ROOF_HEX.amber],
          [-0.22, 1.10, 0.44, 0.34, -0.04, TONE_ROOF_HEX.moss],
        ];
        for (const [nx, ny, nw, nh, rotZ, pinHex] of notices) {
          b.addBox(matParchment, [nx, ny, 0.09], [nw, nh, 0.02], [0, 0, rotZ]);
          b.addSphere(matAccentBase, [nx, ny + nh * 0.36, 0.11], [0.065, 0.065, 0.065], undefined, { color: pinHex });
        }
        // 우하단 작은 봉인 두루마리 1장
        b.addBox(matParchment, [0.36, 1.12, 0.09], [0.38, 0.36, 0.02], [0, 0, 0.05]);
        b.addSphere(matBrass, [0.36, 1.25, 0.11], [0.07, 0.07, 0.07]);

        // 박공 지붕 차양
        b.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
          y: 2.02,
          width: 2.16,
          height: 0.54,
          depth: 0.96,
          roofColor: TONE_ROOF_HEX.amber,
          includeGableWall: false,
          castShadow: true,
          receiveShadow: true,
        });

        // 상단 황동 등불 (처마 아래 매달림)
        b.addCylinder(matBrass, [0, 2.26, 0.38], [0.06, 0.22, 0.06]);
        b.addCone(matIron, [0, 2.14, 0.38], [0.26, 0.10, 0.26]);
        b.addCylinder(matLanternGlass, [0, 2.00, 0.38], [0.18, 0.22, 0.18]);
        b.addSphere(matBrass, [0, 1.88, 0.38], [0.10, 0.10, 0.10]);
      });
    }
    questAlertGroup.position.set(nbx, nby + 3.05, nbz);
    addContactShadow(b, nbx, nbz, 1.25, 0.78, nbYaw);
    addGrassClearZone(nbx, nbz, 1.55);
    addCameraOccluder(nbx, nbz, 0.95, 2.7);
    colliders.push({ x: nbx, z: nbz, r: 0.88 });

    // 6. 중앙 광장 좌측 앞마당 「함대 소집 종 (Parade Bell)」 목재 종루 + 황금 청동 종
    const pbx = PARADE_BELL_POS.x;
    const pbz = PARADE_BELL_POS.z;
    const pby = getTerrainBaseHeight(pbx, pbz);
    const pbYaw = Math.atan2(0 - pbx, -1.5 - pbz);
    b.withFrame(pbx, pby, pbz, pbYaw, 1, () => {
      // 석조 받침대
      b.addBox(matStone, [0, 0.10, 0], [1.46, 0.20, 0.96], undefined, { receiveShadow: true });
      b.addBox(matStoneDark, [0, 0.24, 0], [1.22, 0.10, 0.74], undefined, { receiveShadow: true });
      // 아담한 목재 종루 양기둥 + 버팀목 + 상단 횡목
      for (const px of [-0.52, 0.52]) {
        b.addBox(matTimber, [px, 1.18, 0], [0.15, 1.90, 0.15], undefined, { castShadow: true, receiveShadow: true });
        b.addBox(matWood, [px, 0.42, 0], [0.22, 0.24, 0.44]);
        b.addBox(matWood, [px * 0.74, 1.78, 0], [0.34, 0.08, 0.10], [0, 0, px > 0 ? 0.65 : -0.65]);
      }
      b.addBox(matTimber, [0, 2.02, 0], [1.34, 0.16, 0.18], undefined, { castShadow: true });
      b.addCylinder(matBrass, [0, 1.92, 0], [0.09, 0.16, 0.09]);
      // 종루 미니 박공 지붕 + 상단 황금 장식
      b.addPitchedRoof(matRoofBase, matPlasterWarm, matTimber, {
        y: 2.12,
        width: 1.62,
        height: 0.58,
        depth: 1.08,
        roofColor: TONE_ROOF_HEX.crimson,
        includeGableWall: false,
        castShadow: true,
        receiveShadow: true,
      });
      b.addSphere(matBrass, [0, 2.74, 0], [0.15, 0.15, 0.15]);
      // 종루 처마 아래 소형 황금빛 걸이 등불 (야간 자동 점등, 기존 matLanternGlass 배칭 공유)
      b.addCylinder(matIron, [0.62, 2.02, 0.34], [0.025, 0.14, 0.025]);
      b.addCylinder(matBrass, [0.62, 1.94, 0.34], [0.11, 0.04, 0.11]);
      b.addCylinder(matLanternGlass, [0.62, 1.84, 0.34], [0.09, 0.16, 0.09]);
      b.addCylinder(matBrass, [0.62, 1.74, 0.34], [0.10, 0.035, 0.10]);
    });
    paradeBellMountGroup.position.set(pbx, pby + 1.90, pbz);
    paradeBellMountGroup.rotation.y = pbYaw;
    addContactShadow(b, pbx, pbz, 0.96, 0.76, pbYaw);
    addGrassClearZone(pbx, pbz, 1.32);
    addCameraOccluder(pbx, pbz, 0.68, 2.8);
    colliders.push({ x: pbx, z: pbz, r: 0.68 });

    // 7. 중앙 광장 「함대 우체통 (Fleet Mailbox)」 지브리풍 빨간 둥근 지붕 우체통 + 나무 기둥 + 투입구
    const mbx = MAILBOX_POS.x;
    const mbz = MAILBOX_POS.z;
    const mby = getTerrainBaseHeight(mbx, mbz);
    const mbYaw = Math.atan2(0 - mbx, 1.5 - mbz);
    b.withFrame(mbx, mby, mbz, mbYaw, 1, () => {
      // 석조 받침 + 원목 기둥 + 사선 받침대
      b.addCylinder(matStone, [0, 0.07, 0], [0.58, 0.14, 0.58], undefined, { tapered: true, receiveShadow: true });
      b.addBox(matTimber, [0, 0.54, 0], [0.15, 0.96, 0.15], undefined, { castShadow: true, receiveShadow: true });
      b.addBox(matWood, [0, 0.98, 0], [0.54, 0.08, 0.70], undefined, { castShadow: true });
      b.addBox(matWood, [0, 0.80, 0.15], [0.10, 0.34, 0.10], [0.58, 0, 0]);
      // 빨간 우체통 하단 몸체 + 둥근 아치 지붕
      b.addBox(matRoofBase, [0, 1.15, 0], [0.46, 0.28, 0.64], undefined, { color: TONE_ROOF_HEX.crimson, castShadow: true, receiveShadow: true });
      b.addCylinder(matRoofBase, [0, 1.29, 0], [0.46, 0.64, 0.46], [Math.PI * 0.5, 0, 0], { color: TONE_ROOF_HEX.crimson, castShadow: true });
      // 정면 투입구 + 황동 손잡이 + 작은 황동 문장
      b.addBox(matIron, [0, 1.24, 0.325], [0.30, 0.06, 0.03]);
      b.addSphere(matBrass, [0, 1.13, 0.335], [0.055, 0.055, 0.055]);
      b.addBox(matBrass, [0, 1.04, 0.325], [0.22, 0.035, 0.025]);
    });
    mailboxAnimGroup.position.set(mbx, mby, mbz);
    mailboxAnimGroup.rotation.y = mbYaw;
    addContactShadow(b, mbx, mbz, 0.62, 0.62, mbYaw);
    addGrassClearZone(mbx, mbz, 0.98);
    addCameraOccluder(mbx, mbz, 0.42, 1.65);
    colliders.push({ x: mbx, z: mbz, r: 0.48 });

    // 8. 중앙 광장 동남쪽 정원 「별빛 연못 (Starlight Pond)」 돌 테두리 + 반짝이는 수면 + 수련 잎 + 돌 등불
    const spx = STARLIGHT_POND_POS.x;
    const spz = STARLIGHT_POND_POS.z;
    const spy = getTerrainBaseHeight(spx, spz);
    pondWaterSurfaceY = spy + 0.15;
    b.withFrame(spx, spy, spz, 0, 1, () => {
      // 어두운 연못 바닥 + 에메랄드-별빛 물결 수면
      b.addCylinder(matStoneDark, [0, 0.04, 0], [3.26, 0.08, 3.10], undefined, { receiveShadow: true });
      b.addCylinder(matWaterTile, [0, 0.13, 0], [3.16, 0.05, 3.00]);
      // 자연스러운 타원형 이끼 돌 테두리 16개
      for (let i = 0; i < 16; i += 1) {
        const a = (i / 16) * Math.PI * 2;
        const rx = Math.cos(a) * 1.66;
        const rz = Math.sin(a) * 1.56;
        const h = 0.24 + (i % 3) * 0.05;
        b.addDodeca(
          i % 2 === 0 ? matStone : matStoneDark,
          [rx, h * 0.48, rz],
          [0.52 + (i % 2) * 0.08, h, 0.46],
          [0.12 * (i % 3), a, 0.08],
          { flat: true, castShadow: true, receiveShadow: true },
        );
      }
      // 수련 잎 3장 + 연분홍 연꽃 1송이
      const pondPads: readonly [number, number, number, boolean][] = [
        [-0.78, -0.52, 0.44, true],
        [-0.36, -0.82, 0.34, false],
        [0.72, 0.54, 0.40, false],
      ];
      for (const [lx, lz, lsz, hasLotus] of pondPads) {
        b.addCylinder(matPad, [lx, 0.165, lz], [lsz, 0.025, lsz]);
        if (hasLotus) {
          for (let p = 0; p < 5; p += 1) {
            const pa = (p / 5) * Math.PI * 2;
            b.addSphere(
              matAccentBase,
              [lx + Math.cos(pa) * 0.085, 0.21, lz + Math.sin(pa) * 0.085],
              [0.09, 0.06, 0.09],
              undefined,
              { color: 0xf9a8d4 },
            );
          }
          b.addSphere(matAccentBase, [lx, 0.23, lz], [0.065, 0.065, 0.065], undefined, { color: 0xfde047 });
        }
      }
      // 북동쪽 연못가 아담한 정원 돌 등불 (야간 온기 반사)
      const lx = 1.24;
      const lz = -1.24;
      b.addCylinder(matStoneDark, [lx, 0.14, lz], [0.46, 0.28, 0.46], undefined, { tapered: true, castShadow: true });
      b.addCylinder(matStone, [lx, 0.48, lz], [0.24, 0.42, 0.24], undefined, { castShadow: true });
      b.addCylinder(matLanternGlass, [lx, 0.80, lz], [0.26, 0.26, 0.26]);
      b.addCone(matStoneDark, [lx, 1.04, lz], [0.54, 0.24, 0.54], undefined, { castShadow: true });
      b.addSphere(matBrass, [lx, 1.18, lz], [0.09, 0.09, 0.09]);
    });
    addContactShadow(b, spx, spz, 2.05, 1.95);
    addGrassClearZone(spx, spz, 2.18);
    colliders.push({ x: spx, z: spz, r: 1.82 });
  }

  /** 시냇물 횡단 아치 목교(동/서 2기) + 연못 수련잎/연꽃/갈대 */
  function buildBrookBridgesAndFlora(b: InstancedBucketBuilder): void {
    const hasCustomBridge = assetRegistry.hasCustomModel("bridge");
    for (const bridge of BRIDGES) {
      // 다리 양끝 진입로와 중앙부 풀/꽃 관통 제거
      const endA = fromBridgeLocal(bridge, 0, -bridge.halfSpan);
      const endB = fromBridgeLocal(bridge, 0, bridge.halfSpan);
      addGrassClearZone(endA.x, endA.z, 2.25);
      addGrassClearZone(endB.x, endB.z, 2.25);
      addGrassClearZone(bridge.x, bridge.z, 2.40);
      if (hasCustomBridge) {
        // bridge.glb는 X축 스팬 6.3m, Z축 폭 2.41m 기준 → 로컬 Z 스팬과 90° 정렬 후 실제 강폭에 맞춰 스케일링
        queueInstancedSlot("bridge", {
          x: bridge.x,
          y: 0.06,
          z: bridge.z,
          rotationY: bridge.yaw + Math.PI * 0.5,
          scaleX: (bridge.halfSpan * 2) / 6.3,
          scaleY: 0.88,
          scaleZ: (bridge.deckHalfWidth * 2) / 2.4,
        });
        continue;
      }
      b.withFrame(bridge.x, 0, bridge.z, bridge.yaw, 1, () => {
        const halfSpan = bridge.halfSpan;
        const steps = 12;
        for (let i = 0; i <= steps; i += 1) {
          const u = (i / steps) * 2 - 1;
          const lz = u * halfSpan;
          const archY = 0.32 + Math.cos(u * Math.PI * 0.5) * 0.44;
          b.addBox(i % 2 === 0 ? matWood : matWoodLight, [0, archY, lz], [2.45, 0.12, 0.50], undefined, { receiveShadow: true });
          if (i % 3 === 0) {
            for (const side of [-1.14, 1.14]) {
              b.addBox(matTimber, [side, archY + 0.38, lz], [0.11, 0.78, 0.11]);
            }
          }
        }
        for (const side of [-1.14, 1.14]) {
          for (let i = 0; i < steps; i += 1) {
            const u0 = (i / steps) * 2 - 1;
            const u1 = ((i + 1) / steps) * 2 - 1;
            const z0 = u0 * halfSpan;
            const z1 = u1 * halfSpan;
            const y0 = 0.74 + Math.cos(u0 * Math.PI * 0.5) * 0.44;
            const y1 = 0.74 + Math.cos(u1 * Math.PI * 0.5) * 0.44;
            const segLen = Math.hypot(z1 - z0, y1 - y0);
            b.addBox(matWood, [side, (y0 + y1) * 0.5, (z0 + z1) * 0.5], [0.08, 0.08, segLen + 0.04], [-Math.atan2(y1 - y0, z1 - z0), 0, 0]);
          }
        }
      });
    }

    const padCoords: readonly [number, number, boolean][] = [
      [4.2, brookProfile(4.2).centerZ - 0.6, true],
      [5.1, brookProfile(5.1).centerZ + 0.9, false],
      [3.4, brookProfile(3.4).centerZ + 0.5, true],
      [-2.5, brookProfile(-2.5).centerZ - 0.3, false],
      [11.6, brookProfile(11.6).centerZ + 0.4, true],
      [-16.2, brookProfile(-16.2).centerZ + 0.3, true],
      [6.4, brookProfile(6.4).centerZ - 1.1, true],
      [-6.8, brookProfile(-6.8).centerZ + 0.35, true],
      [15.4, brookProfile(15.4).centerZ - 0.3, false],
      [-22.8, brookProfile(-22.8).centerZ - 0.35, true],
      [-29.5, brookProfile(-29.5).centerZ + 0.35, true],
      [-36.2, brookProfile(-36.2).centerZ - 0.28, false],
      [-43.0, brookProfile(-43.0).centerZ - 0.3, true],
      [-50.5, brookProfile(-50.5).centerZ + 0.32, false],
      [-58.5, brookProfile(-58.5).centerZ + 0.25, true],
      [-65.2, brookProfile(-65.2).centerZ - 0.26, true],
      [-72.0, brookProfile(-72.0).centerZ - 0.2, false],
      [-77.8, brookProfile(-77.8).centerZ + 0.22, true],
      [21.8, brookProfile(21.8).centerZ + 0.32, true],
      [29.0, brookProfile(29.0).centerZ - 0.35, true],
      [36.5, brookProfile(36.5).centerZ + 0.28, false],
      [44.5, brookProfile(44.5).centerZ + 0.3, true],
      [52.2, brookProfile(52.2).centerZ - 0.26, true],
      [60.0, brookProfile(60.0).centerZ - 0.25, false],
      [66.8, brookProfile(66.8).centerZ + 0.28, true],
      [73.5, brookProfile(73.5).centerZ + 0.2, true],
      [78.5, brookProfile(78.5).centerZ - 0.22, false],
    ];
    const hasCustomLilypad = assetRegistry.hasCustomModel("lilypad");
    for (const [px, pz, hasFlower] of padCoords) {
      if (hasCustomLilypad) {
        queueInstancedSlot("lilypad", {
          x: px,
          y: -0.085,
          z: pz,
          rotationY: hash2(px, pz) * Math.PI * 2,
          scale: 0.88 + hash2(pz, px) * 0.38,
        });
      } else {
        b.addCylinder(matPad, [px, -0.07, pz], [0.72, 0.03, 0.72]);
        if (hasFlower) {
          b.addCone(matLotus, [px, 0.01, pz], [0.28, 0.16, 0.28], [Math.PI, 0, 0]);
        }
      }
    }

    const reedSpots: readonly [number, number][] = [
      [-81.5, -1], [-79.5, 1], [-76.2, -1], [-73.0, -1], [-70.4, 1],
      [-66.5, 1], [-63.0, -1], [-59.0, -1], [-55.8, 1], [-52.5, 1],
      [-48.8, -1], [-45.0, -1], [-41.8, 1], [-38.5, 1], [-34.6, -1],
      [-31.0, -1], [-27.2, 1], [-22.5, -1], [-18.5, -1], [-16.4, 1],
      [-8.2, -1], [-6.5, 1], [-3.8, -1], [-1.2, -1], [0.9, 1],
      [2.4, 1], [3.2, -1], [6.2, 1], [11.8, -1], [14.2, 1],
      [15.2, -1], [17.8, 1], [19.6, 1], [22.4, -1], [25.0, 1],
      [27.5, 1], [31.2, -1], [34.5, -1], [37.8, 1], [41.0, 1],
      [44.8, -1], [48.5, -1], [51.8, 1], [55.0, 1], [58.8, -1],
      [62.5, -1], [65.8, 1], [69.0, 1], [72.8, -1], [76.5, -1],
      [79.2, 1], [81.8, -1],
    ];
    const hasCustomReeds = assetRegistry.hasCustomModel("reeds");
    for (const [rx, bankSide] of reedSpots) {
      if (BRIDGES.some((br) => Math.abs(rx - br.x) < 2.4)) continue;
      const bp = brookProfile(rx);
      const rz = bp.centerZ + bankSide * (bp.halfWidth + 0.18);
      if (hasCustomReeds) {
        const gy = Math.max(-0.08, getTerrainBaseHeight(rx, rz));
        queueInstancedSlot("reeds", {
          x: rx,
          y: gy - 0.04,
          z: rz,
          rotationY: hash2(rx, rz) * Math.PI * 2,
          scale: 0.85 + hash2(rz, rx) * 0.40,
        });
      } else if (bankSide < 0) {
        b.addCylinder(matFoliageBase, [rx, 0.18, rz], [0.055, 0.85, 0.055], undefined, { color: 0x3e9e4c });
        b.addCylinder(matTimber, [rx, 0.48, rz], [0.11, 0.24, 0.11]);
      }
    }

    // 시냇물 양쪽 강변 이끼 낀 강돌 클러스터 (river-rock.glb, |x| <= 82m 2배 밀도)
    if (assetRegistry.hasCustomModel("river-rock")) {
      const rockSpots: readonly [number, number][] = [
        [-81.0, -1], [-77.8, 1], [-74.5, 1], [-70.8, -1], [-67.0, -1],
        [-62.8, 1], [-58.5, 1], [-54.0, -1], [-49.5, -1], [-45.2, 1],
        [-41.0, 1], [-37.2, -1], [-33.5, -1], [-29.2, 1], [-25.5, 1],
        [-20.2, -1], [-15.2, -1], [-7.6, 1], [-4.2, -1], [0.4, 1],
        [2.6, -1], [4.8, 1], [12.4, 1], [13.8, -1], [17.5, 1],
        [20.8, -1], [25.2, 1], [29.4, -1], [33.2, 1], [37.0, 1],
        [41.4, -1], [45.5, -1], [49.8, 1], [54.0, 1], [58.6, -1],
        [63.5, -1], [67.8, 1], [72.0, 1], [76.0, -1], [79.5, -1],
        [81.8, 1],
      ];
      for (const [rx, bankSide] of rockSpots) {
        if (BRIDGES.some((br) => Math.abs(rx - br.x) < 2.8)) continue;
        const bp = brookProfile(rx);
        const rz = bp.centerZ + bankSide * (bp.halfWidth + 0.36);
        const gy = getTerrainBaseHeight(rx, rz);
        if (gy < -0.15) continue;
        queueInstancedSlot("river-rock", {
          x: rx,
          y: gy - 0.04,
          z: rz,
          rotationY: hash2(rx * 1.7, rz) * Math.PI * 2,
          scale: 0.78 + hash2(rz * 1.3, rx) * 0.48,
        });
      }
    }
  }

  /** 시냇가 상시 3D 낚시 포인트 표식 (나무 말뚝 + 작은 낚시 팻말 + 물결 랜턴 찌, 멀리서도 인지 가능) */
  function buildFishingSpotMarkers(b: InstancedBucketBuilder, parent: Group): void {
    const spots: readonly [number, number][] = [
      [1.4, -1],   // 중앙 광장 남측 정면 시냇가 대표 낚시 포인트
      [17.8, -1],  // 동부 연못 낚시 포인트
      [-23.5, -1], // 서부 강변 낚시 포인트
    ];
    for (const [fx, bankSide] of spots) {
      if (BRIDGES.some((br) => Math.abs(fx - br.x) < 4.0)) continue;
      const bp = brookProfile(fx);
      const fz = bp.centerZ + bankSide * (bp.halfWidth + 1.05);
      const fy = getTerrainBaseHeight(fx, fz);
      if (fy < 0.14) continue;
      const rd = minRoadDistance(fx, fz);
      if (rd.dist < rd.halfWidth + 0.85) continue;
      if (currentVillages.some((v) => Math.hypot(fx - v.x, fz - v.z) < v.radius + 1.8)) continue;

      // 광장/산책로 방향을 향해 팻말이 잘 보이도록 정렬 (북안은 -Z 쪽을 바라봄)
      const signYaw = bankSide < 0 ? Math.PI : 0;
      const cosY = Math.cos(signYaw);
      const sinY = Math.sin(signYaw);

      b.withFrame(fx, fy, fz, signYaw, 1, () => {
        // 강변 나무 데크 발판 + 2개의 짧은 계류 말뚝 + 로프 감김
        b.addBox(matWood, [0, 0.06, -0.52], [1.32, 0.10, 0.62], undefined, { receiveShadow: true });
        b.addBox(matWoodLight, [0, 0.06, -0.84], [1.26, 0.09, 0.24], undefined, { receiveShadow: true });
        b.addCylinder(matBark, [-0.56, 0.34, -0.68], [0.16, 0.72, 0.16], undefined, { tapered: true, castShadow: true });
        b.addCylinder(matBark, [0.56, 0.28, -0.62], [0.15, 0.58, 0.15], undefined, { tapered: true, castShadow: true });
        b.addTorus(matBellRope, [-0.56, 0.54, -0.68], [0.18, 0.22, 0.18]);
        // 높은 낚시 표식 나무 기둥 + 횡목 + 황동 걸이 고리 + 팻말 프레임
        b.addCylinder(matTimber, [0.02, 0.96, 0.05], [0.15, 1.94, 0.15], undefined, { tapered: true, castShadow: true });
        b.addSphere(matBrass, [0.02, 1.96, 0.05], [0.15, 0.15, 0.15]);
        b.addBox(matTimber, [0.34, 1.76, 0.05], [0.84, 0.09, 0.09], undefined, { castShadow: true });
        b.addBox(matWood, [0.16, 1.56, 0.05], [0.34, 0.07, 0.07], [0, 0, 0.72]);
        // 매달린 작은 낚시 팻말 목재 판 + 쇠고리 2개
        b.addCylinder(matIron, [0.22, 1.66, 0.05], [0.025, 0.16, 0.025]);
        b.addCylinder(matIron, [0.62, 1.66, 0.05], [0.025, 0.16, 0.025]);
        b.addBox(matWoodLight, [0.42, 1.38, 0.05], [0.74, 0.46, 0.055], undefined, { castShadow: true });
        // 횡목 끝 미니 야간 발광 찌 랜턴 (멀리서도 낚시 포인트 인지)
        b.addCylinder(matIron, [0.74, 1.66, 0.05], [0.02, 0.18, 0.02]);
        b.addCylinder(matLanternGlass, [0.74, 1.50, 0.05], [0.14, 0.18, 0.14]);
        b.addSphere(matAccentBase, [0.74, 1.59, 0.05], [0.13, 0.08, 0.13], undefined, { color: 0xef4444 });
      });

      // 앞/뒤 양면에 선명한 낚시터 캔버스 텍스처 팻말 부착
      const pLocalX = 0.42;
      const pLocalZ = 0.05;
      const px = fx + pLocalX * cosY + pLocalZ * sinY;
      const pz = fz - pLocalX * sinY + pLocalZ * cosY;
      const nX = sinY * 0.032;
      const nZ = cosY * 0.032;
      mountTexturedPlaque(parent, matFishingSign, px + nX, fy + 1.38, pz + nZ, 0.68, 0.42, signYaw);
      mountTexturedPlaque(parent, matFishingSign, px - nX, fy + 1.38, pz - nZ, 0.68, 0.42, signYaw + Math.PI);

      addContactShadow(b, fx, fz - 0.35, 0.95, 0.78, signYaw);
      addGrassClearZone(fx, fz - 0.35, 1.25);
      colliders.push({ x: fx, z: fz + 0.05, r: 0.36 });
      fishingSpotAnchors.push({ x: fx, z: fz, yaw: signYaw });
    }
  }

  // ─── 심시티 스타일 사령관 마을(Village) & Theater 구역(District Tier 0~5) 빌더 ──

  function buildDistrict(
    b: InstancedBucketBuilder,
    parent: Group,
    d: WorldDistrictSpec,
    villageTheme: EffectiveVillageTheme = "meadow",
  ): void {
    const gy = getTerrainBaseHeight(d.x, d.z);
    if (gy < 0.05) return;

    const toneHex = TONE_ROOF_HEX[d.tone];
    const crystalHex = TONE_CRYSTAL_HEX[d.tone];
    const fitScale = Math.min(1.06, Math.max(0.76, d.radius / 2.65));
    const districtSlot: WorldModelSlot | null =
      d.tier === 1 ? "district-tier1"
        : d.tier === 2 ? "district-tier2"
          : d.tier === 3 ? "district-tier3"
            : d.tier === 4 ? "district-tier4"
              : d.tier === 5 ? "district-tier5"
                : null;
    const hasCustomDistrict = Boolean(districtSlot && assetRegistry.hasCustomModel(districtSlot));

    const districtMeta: Record<string, unknown> = {
      kind: "district",
      districtId: d.id,
      theaterId: d.theaterId,
      villageId: d.villageId,
      commodoreId: d.commodoreId,
      tier: d.tier,
      district: d,
    };

    if (hasCustomDistrict && districtSlot) {
      queueInstancedSlot(districtSlot, {
        x: d.x,
        y: gy,
        z: d.z,
        rotationY: d.rotationY,
        scale: fitScale,
        roofTintHex: toneHex,
        userData: districtMeta,
      });
    } else b.withFrame(d.x, gy, d.z, d.rotationY, fitScale, () => {
      if (d.tier === 0) {
        // Tier 0 (확장 예정지): 코너 말뚝 4개 + 경계 로프 + 청사진 이젤 안내판 + 작은 깃대 + 이끼 바위
        const corner = 1.65;
        for (const cx of [-corner, corner]) {
          for (const cz of [-corner, corner]) {
            b.addCylinder(matBark, [cx, 0.30, cz], [0.12, 0.62, 0.12], undefined, { tapered: true, castShadow: true });
            b.addTorus(matBellRope, [cx, 0.50, cz], [0.13, 0.16, 0.13]);
          }
        }
        // 4개 말뚝을 잇는 자연스러운 처짐 경계 로프 (정면 +Z 중앙만 개방해 진입 가능한 확장 예정지 연출)
        const addRopeSpan = (ax: number, az: number, bx: number, bz: number) => {
          const midX = (ax + bx) * 0.5;
          const midZ = (az + bz) * 0.5;
          const halfLen = Math.hypot(bx - ax, bz - az) * 0.5;
          const segYaw = Math.atan2(bx - ax, bz - az);
          const sag = 0.085;
          const slope = Math.atan2(sag, halfLen);
          const lenSeg = Math.hypot(halfLen, sag) + 0.03;
          // 전반부(하강) + 후반부(상승) 2단 로프 처짐
          b.addBox(matBellRope, [(ax + midX) * 0.5, 0.50 - sag * 0.5, (az + midZ) * 0.5], [0.036, 0.036, lenSeg], [slope, segYaw, 0]);
          b.addBox(matBellRope, [(midX + bx) * 0.5, 0.50 - sag * 0.5, (midZ + bz) * 0.5], [0.036, 0.036, lenSeg], [-slope, segYaw, 0]);
        };
        addRopeSpan(-corner, corner, -corner, -corner); // 좌측
        addRopeSpan(-corner, -corner, corner, -corner); // 후면
        addRopeSpan(corner, -corner, corner, corner);   // 우측
        // 정면 입구 좌/우 짧은 보조 말뚝 + 개방 입구 로프 날개
        b.addCylinder(matBark, [-0.72, 0.27, corner], [0.10, 0.54, 0.10], undefined, { tapered: true });
        b.addCylinder(matBark, [0.72, 0.27, corner], [0.10, 0.54, 0.10], undefined, { tapered: true });
        addRopeSpan(-corner, corner, -0.72, corner);
        addRopeSpan(0.72, corner, corner, corner);

        // 목재 A-프레임 청사진 이젤 (좌중앙, 정면 광장을 향함)
        const ex = -0.48;
        const ez = -0.18;
        b.addBox(matTimber, [ex - 0.30, 0.62, ez + 0.14], [0.06, 1.32, 0.06], [-0.18, 0, -0.06], { castShadow: true });
        b.addBox(matTimber, [ex + 0.30, 0.62, ez + 0.14], [0.06, 1.32, 0.06], [-0.18, 0, 0.06], { castShadow: true });
        b.addBox(matTimber, [ex, 0.58, ez - 0.26], [0.06, 1.24, 0.06], [0.34, 0, 0], { castShadow: true });
        b.addBox(matWood, [ex, 0.66, ez + 0.16], [0.92, 0.07, 0.10], [-0.18, 0, 0]);
        b.addBox(matWoodLight, [ex, 0.96, ez + 0.09], [0.88, 0.64, 0.055], [-0.18, 0, 0], { castShadow: true });

        // 작은 페넌트 깃대
        b.addCylinder(matWood, [0.58, 0.95, -0.42], [0.09, 1.9, 0.09], undefined, { tapered: true });
        b.addSphere(matBrass, [0.58, 1.92, -0.42], [0.14, 0.14, 0.14]);
        // 바위 & 수풀 소품 (이젤과 비충돌)
        b.addDodeca(villageTheme === "snow" ? matSnowCap : matStone, [0.78, 0.16, 0.45], [0.64, 0.34, 0.52], [0.2, 0.7, 0.1], { flat: true, receiveShadow: true });
        b.addDodeca(matFoliageBase, [-1.05, 0.22, -0.78], [0.58, 0.42, 0.54], undefined, {
          color: villageTheme === "autumn" ? 0xe87b22 : villageTheme === "snow" ? 0x6ea8b0 : 0x5cc458,
        });
        return;
      }

      if (d.tier === 1) {
        // Tier 1 (개척 캠프): 사령관 색 줄무늬 삼각 천막 + 모닥불(천막과 충분한 간격) + 나무 표지판 + 통나무 의자
        b.addPitchedRoof(matRoofBase, matCanvas, matTimber, {
          x: -0.22,
          y: 0.02,
          z: -0.42,
          width: 2.02,
          height: 1.48,
          depth: 1.92,
          roofColor: toneHex,
          includeGableWall: true,
          castShadow: true,
          receiveShadow: true,
        });
        // 천막 입구 개구부
        b.addBox(matTimber, [-0.22, 0.55, 0.56], [0.64, 1.04, 0.08]);
        // 나무 표지판 (좌전면)
        b.addCylinder(matBark, [-1.22, 0.58, 0.96], [0.11, 1.18, 0.11], undefined, { tapered: true });
        b.addBox(matWoodLight, [-1.05, 0.96, 0.96], [0.68, 0.20, 0.06], [0, 0.24, 0]);
        // 모닥불 돌 테두리 + 장작 (우전면, 천막·통나무 의자와 비충돌)
        for (let i = 0; i < 6; i += 1) {
          const a = (i / 6) * Math.PI * 2;
          b.addDodeca(i % 2 === 0 ? matStone : matStoneDark, [1.08 + Math.cos(a) * 0.40, 0.07, 0.88 + Math.sin(a) * 0.40], [0.25, 0.15, 0.23], undefined, { flat: true });
        }
        b.addCylinder(matBark, [1.08, 0.09, 0.88], [0.11, 0.56, 0.11], [0, 0.4, Math.PI * 0.5]);
        b.addCylinder(matBark, [1.08, 0.09, 0.88], [0.11, 0.56, 0.11], [0, -0.5, Math.PI * 0.5]);
        // 통나무 의자 + 보급 상자
        b.addCylinder(matWood, [0.12, 0.18, 1.42], [0.34, 0.36, 0.34]);
        b.addBox(matWood, [-1.24, 0.22, -0.42], [0.46, 0.44, 0.44]);
        return;
      }

      if (d.tier === 2) {
        // Tier 2 (작은 공방 마을): 1층 하프팀버 오두막 + L자 나무 울타리 + 화분 + 오크통
        b.addBox(matStone, [0, 0.11, -0.25], [2.25, 0.22, 1.88], undefined, { receiveShadow: true });
        b.addBox(matPlaster, [0, 0.88, -0.25], [2.04, 1.36, 1.68], undefined, { castShadow: true, receiveShadow: true });
        for (const cx of [-1.00, 1.00]) {
          for (const cz of [-1.08, 0.58]) {
            b.addBox(matTimber, [cx, 0.88, cz], [0.10, 1.38, 0.10]);
          }
        }
        b.addBox(matTimber, [0, 1.54, -0.25], [2.10, 0.09, 1.74]);
        b.addBox(matWood, [-0.40, 0.68, 0.60], [0.54, 0.96, 0.09]);
        b.addSphere(matBrass, [-0.22, 0.66, 0.66], [0.06, 0.06, 0.06]);
        b.addBox(matStoneDark, [-0.40, 0.06, 0.82], [0.72, 0.12, 0.36]);
        addFramedWindow(b, 0.44, 0.92, 0.60, 0, 0.72, true);
        b.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
          y: 1.56,
          z: -0.25,
          width: 2.18,
          height: 0.98,
          depth: 1.80,
          roofColor: toneHex,
          castShadow: true,
          receiveShadow: true,
        });
        b.addBox(matStoneDark, [0.64, 2.02, -0.62], [0.34, 0.92, 0.34], undefined, { castShadow: true });

        // L자 나무 울타리
        for (const fx of [-1.55, -0.92, -0.28]) {
          b.addBox(matWood, [fx, 0.30, 1.32], [0.10, 0.60, 0.10]);
        }
        b.addBox(matWoodLight, [-0.92, 0.44, 1.32], [1.34, 0.07, 0.06]);
        b.addBox(matWoodLight, [-0.92, 0.24, 1.32], [1.34, 0.07, 0.06]);
        for (const fz of [0.65, 0.0, -0.68]) {
          b.addBox(matWood, [-1.55, 0.30, fz], [0.10, 0.60, 0.10]);
        }
        b.addBox(matWoodLight, [-1.55, 0.44, 0.32], [0.06, 0.07, 2.06]);

        // 화분 + 꽃 + 오크통
        b.addCylinder(matTerracotta, [0.98, 0.20, 0.98], [0.42, 0.38, 0.42], undefined, { tapered: true });
        b.addDodeca(matFoliageBase, [0.98, 0.46, 0.98], [0.46, 0.34, 0.46], undefined, { color: 0x5cc458 });
        b.addSphere(matAccentBase, [0.98, 0.58, 1.04], [0.14, 0.14, 0.14], undefined, { color: 0xf43f5e });
        b.addCylinder(matWood, [1.28, 0.26, 0.18], [0.44, 0.52, 0.44]);
        return;
      }

      if (d.tier === 3) {
        // Tier 3 (공방 지구): 2층 목조 공방(석조 1층 + 돌출 하프팀버 2층) + 조약돌 마당 + 가로등 + 화물상자/모루
        // 조약돌 바닥 패드
        b.addBox(matStone, [0, 0.03, 0.15], [3.55, 0.06, 3.35], undefined, { receiveShadow: true });
        // 1층 석조 작업실
        b.addBox(matStoneDark, [0, 0.60, -0.28], [2.25, 1.12, 1.85], undefined, { castShadow: true, receiveShadow: true });
        // 2층 돌출 하프팀버 공방
        b.addBox(matPlasterWarm, [0, 1.72, -0.28], [2.48, 1.16, 2.05], undefined, { castShadow: true, receiveShadow: true });
        for (const cx of [-1.22, 0, 1.22]) {
          for (const cz of [-1.29, 0.73]) {
            b.addBox(matTimber, [cx, 1.72, cz], [0.10, 1.18, 0.10]);
          }
        }
        b.addBox(matTimber, [0, 1.16, -0.28], [2.56, 0.11, 2.12]);
        b.addBox(matTimber, [0, 2.28, -0.28], [2.56, 0.10, 2.12]);

        // 1층 공방 정문 + 차양
        b.addBox(matWood, [-0.36, 0.56, 0.66], [0.64, 1.02, 0.09]);
        b.addBox(matRoofBase, [-0.36, 1.16, 0.92], [1.10, 0.08, 0.54], [0.24, 0, 0], { color: toneHex });

        // 2층 쌍둥이 격자 창문
        addFramedWindow(b, -0.60, 1.76, 0.76, 0, 0.68, true);
        addFramedWindow(b, 0.60, 1.76, 0.76, 0, 0.68, true);
        addFramedWindow(b, 0.58, 0.68, 0.66, 0, 0.64, false);

        // 박공지붕 + 돌 굴뚝
        b.addPitchedRoof(matRoofBase, matPlasterWarm, matTimber, {
          y: 2.30,
          z: -0.28,
          width: 2.58,
          height: 1.08,
          depth: 2.18,
          roofColor: toneHex,
          castShadow: true,
          receiveShadow: true,
        });
        b.addBox(matStoneDark, [-0.88, 2.86, -0.78], [0.40, 1.25, 0.40], undefined, { castShadow: true });

        // 적재된 화물상자 & 오크통 & 소형 모루
        b.addBox(matWood, [-1.32, 0.25, 0.98], [0.50, 0.46, 0.46]);
        b.addBox(matWoodLight, [-1.24, 0.64, 0.94], [0.36, 0.34, 0.36], [0, 0.32, 0]);
        b.addCylinder(matWood, [-0.74, 0.28, 1.18], [0.42, 0.52, 0.42]);
        b.addCylinder(matBark, [0.76, 0.24, 1.18], [0.44, 0.44, 0.44]);
        b.addBox(matIron, [0.76, 0.52, 1.18], [0.44, 0.16, 0.24]);
        return;
      }

      if (d.tier === 4) {
        // Tier 4 (번화가 지구): 복층 석조 건물 + 미니 시계탑 + 중앙 분수 + 코너 가로수
        // 정형 석재 테라스 바닥
        b.addBox(matStone, [0, 0.05, 0.12], [3.85, 0.10, 3.65], undefined, { receiveShadow: true });
        b.addBox(matMarble, [0, 0.08, 1.12], [2.40, 0.06, 1.40], undefined, { receiveShadow: true });

        // 본관 복층 석조 건물
        b.addBox(matStone, [-0.22, 0.62, -0.42], [2.42, 1.14, 1.78], undefined, { castShadow: true, receiveShadow: true });
        b.addBox(matPlaster, [-0.22, 1.78, -0.42], [2.36, 1.24, 1.72], undefined, { castShadow: true, receiveShadow: true });
        b.addBox(matStoneDark, [-0.22, 1.18, -0.42], [2.52, 0.12, 1.88]);
        b.addBox(matStoneDark, [-0.22, 2.38, -0.42], [2.52, 0.11, 1.88]);

        // 석조 아치 입구
        b.addBox(matStoneDark, [-0.22, 0.64, 0.50], [0.96, 1.12, 0.16]);
        b.addBox(matWood, [-0.22, 0.58, 0.54], [0.70, 0.98, 0.12]);
        addFramedWindow(b, -0.96, 0.70, 0.48, 0, 0.58, false);
        addFramedWindow(b, 0.52, 0.70, 0.48, 0, 0.58, false);
        addFramedWindow(b, -0.88, 1.80, 0.46, 0, 0.66, true);
        addFramedWindow(b, -0.22, 1.80, 0.46, 0, 0.66, true);
        addFramedWindow(b, 0.44, 1.80, 0.46, 0, 0.66, true);

        b.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
          x: -0.22,
          y: 2.40,
          z: -0.42,
          width: 2.48,
          height: 1.02,
          depth: 1.86,
          roofColor: toneHex,
          castShadow: true,
          receiveShadow: true,
        });

        // 우측 미니 시계탑
        b.addBox(matStone, [1.20, 1.72, -0.48], [0.88, 3.35, 0.88], undefined, { castShadow: true, receiveShadow: true });
        b.addBox(matStoneDark, [1.20, 3.38, -0.48], [0.98, 0.12, 0.98]);
        b.addCone(matRoofBase, [1.20, 4.02, -0.48], [1.14, 1.18, 1.14], [0, Math.PI * 0.25, 0], { color: toneHex, castShadow: true });
        b.addSphere(matBrass, [1.20, 4.64, -0.48], [0.16, 0.16, 0.16]);
        // 시계판 (발광)
        b.addCylinder(matLanternGlass, [1.20, 2.86, -0.02], [0.46, 0.06, 0.46], [Math.PI * 0.5, 0, 0]);
        b.addTorus(matBrass, [1.20, 2.86, -0.01], [0.50, 0.50, 0.50], [Math.PI * 0.5, 0, 0]);

        // 전면 광장 원형 석조 분수
        b.addCylinder(matStoneDark, [-0.15, 0.18, 1.26], [1.18, 0.26, 1.18], undefined, { receiveShadow: true });
        b.addTorus(matMarble, [-0.15, 0.32, 1.26], [1.12, 1.12, 1.12]);
        b.addCylinder(matWaterTile, [-0.15, 0.28, 1.26], [0.98, 0.05, 0.98]);
        b.addCylinder(matMarble, [-0.15, 0.52, 1.26], [0.22, 0.52, 0.22], undefined, { tapered: true });
        b.addCylinder(matWaterTile, [-0.15, 0.82, 1.26], [0.34, 0.08, 0.34]);

        // 좌우 미니 가로수 (컴팩트 스타일라이즈)
        for (const [tx, tz, leafHex] of [[-1.56, 1.25, 0x5cc458], [1.54, 1.22, 0xfba9cd]] as const) {
          b.addBox(matStoneDark, [tx, 0.14, tz], [0.56, 0.20, 0.56]);
          b.addCylinder(matBark, [tx, 0.62, tz], [0.16, 0.92, 0.16], undefined, { tapered: true });
          b.addDodeca(matFoliageBase, [tx, 1.32, tz], [0.96, 0.82, 0.96], undefined, { color: leafHex, castShadow: true });
        }
        return;
      }

      // Tier 5 (메트로폴리스 성채): 다층 길드홀 성채 + 중앙 첨탑 + 코너 뾰족탑 + 성벽 아치 + 빛나는 크리스탈 등대
      // 2단 대리석/석조 기단 테라스
      b.addBox(matStoneDark, [0, 0.08, 0.08], [4.15, 0.16, 3.95], undefined, { receiveShadow: true });
      b.addBox(matMarble, [0, 0.20, 0.04], [3.62, 0.14, 3.42], undefined, { receiveShadow: true });

      // 본성 홀
      b.addBox(matStone, [0, 1.02, -0.25], [2.62, 1.56, 2.08], undefined, { castShadow: true, receiveShadow: true });
      b.addBox(matMarble, [0, 1.82, -0.25], [2.76, 0.14, 2.22]);
      b.addBox(matPlaster, [0, 2.38, -0.25], [2.12, 1.02, 1.66], undefined, { castShadow: true, receiveShadow: true });
      b.addPitchedRoof(matRoofBase, matMarble, matTimber, {
        y: 2.88,
        z: -0.25,
        width: 2.22,
        height: 0.78,
        depth: 1.76,
        roofColor: toneHex,
        castShadow: true,
        receiveShadow: true,
      });

      // 중앙 다층 첨탑 (크리스탈 등대 받침)
      b.addCylinder(matMarble, [0, 3.45, -0.25], [1.12, 2.35, 1.12], undefined, { tapered: true, castShadow: true, receiveShadow: true });
      b.addCylinder(matStoneDark, [0, 4.58, -0.25], [1.22, 0.14, 1.22]);
      // 등대 받침 기둥 4개
      for (let k = 0; k < 4; k += 1) {
        const a = (k / 4) * Math.PI * 2 + Math.PI * 0.25;
        b.addCylinder(matBrass, [Math.cos(a) * 0.42, 4.92, -0.25 + Math.sin(a) * 0.42], [0.09, 0.62, 0.09]);
      }

      // 코너 뾰족탑 4기
      for (const tx of [-1.36, 1.36]) {
        for (const tz of [-1.26, 0.76]) {
          b.addCylinder(matStone, [tx, 1.48, tz], [0.66, 2.62, 0.66], undefined, { castShadow: true, receiveShadow: true });
          b.addCylinder(matMarble, [tx, 2.82, tz], [0.76, 0.12, 0.76]);
          b.addCone(matRoofBase, [tx, 3.44, tz], [0.84, 1.14, 0.84], undefined, { color: toneHex, castShadow: true });
          b.addSphere(matBrass, [tx, 4.04, tz], [0.13, 0.13, 0.13]);
        }
      }

      // 야경 발광 창문 행렬
      for (const wx of [-0.68, 0, 0.68]) {
        addFramedWindow(b, wx, 1.12, 0.80, 0, 0.56, false);
        addFramedWindow(b, wx, 2.36, 0.59, 0, 0.52, false);
      }

      // 전면 성벽 아치 게이트
      for (const gx of [-0.74, 0.74]) {
        b.addBox(matStone, [gx, 0.86, 1.48], [0.46, 1.38, 0.46], undefined, { castShadow: true });
        b.addBox(matMarble, [gx, 1.60, 1.48], [0.56, 0.12, 0.56]);
        b.addCylinder(matLanternGlass, [gx, 1.78, 1.48], [0.18, 0.24, 0.18]);
      }
      b.addBox(matStoneDark, [0, 1.42, 1.48], [1.56, 0.28, 0.42], undefined, { castShadow: true });
      b.addBox(matRoofBase, [0, 1.66, 1.48], [1.72, 0.16, 0.52], undefined, { color: toneHex });
    });

    // 프레임 바깥 월드 좌표 기반 동적 소품 등록 (깃발 · 불꽃 · 가로등 · 크리스탈 등대 · Tier 0 청사진)
    const cosY = Math.cos(d.rotationY);
    const sinY = Math.sin(d.rotationY);
    const toWorld = (lx: number, ly: number, lz: number) => ({
      x: d.x + (lx * cosY + lz * sinY) * fitScale,
      y: gy + ly * fitScale,
      z: d.z + (-lx * sinY + lz * cosY) * fitScale,
    });

    if (d.tier === 0) {
      const fPos = toWorld(0.58, 1.68, -0.42);
      registerBanner(fPos.x, fPos.y, fPos.z, d.rotationY + 0.2, toneHex, 0.58 * fitScale, 0.30 * fitScale);
      // 이젤 정면에 청사진 캔버스 텍스처 부착
      const bpPos = toWorld(-0.48, 0.96, -0.055);
      mountTexturedPlaque(
        parent,
        matBlueprintEasel,
        bpPos.x,
        bpPos.y,
        bpPos.z,
        0.78 * fitScale,
        0.56 * fitScale,
        d.rotationY,
        -0.18,
      );
    } else if (d.tier === 1) {
      // world-asset-registry.ts에서 보정된 EmberCore 중심 (0.88+0.38, 0.22, 0.82+0.26) × (2.15 / 2.785) ≈ (0.97, 0.17, 0.83)
      const fl = hasCustomDistrict ? toWorld(0.97, 0.17, 0.83) : toWorld(1.08, 0.12, 0.88);
      registerFlame(fl.x, fl.y, fl.z, (hasCustomDistrict ? 0.56 : 0.60) * fitScale);
      // 텐트 바닥판 경계 완화용 저채도 자연 자갈/눈 가장자리 톤 완충 링
      const skirtMat = villageTheme === "snow" ? matSnowCap : matStoneDark;
      for (let si = 0; si < 8; si += 1) {
        const ang = (si / 8) * Math.PI * 2 + 0.35;
        const sp = toWorld(Math.cos(ang) * 1.54, 0.03, Math.sin(ang) * 1.54);
        b.addDodeca(
          skirtMat,
          [sp.x, sp.y, sp.z],
          [0.44 * fitScale, 0.07, 0.36 * fitScale],
          [0, ang, 0],
          { flat: true, receiveShadow: true },
        );
      }
    } else if (d.tier === 3 && !hasCustomDistrict) {
      const lp = toWorld(1.38, 0, 1.18);
      addHangingStreetlamp(b, lp.x, lp.z, d.rotationY - 0.6, false);
    } else if (d.tier === 5) {
      // district-tier5.glb 중앙 등대 기단 상단(5.60m, z=-0.18) 위로 부유 크리스탈 배치
      const cp = hasCustomDistrict ? toWorld(0, 6.08, -0.18) : toWorld(0, 5.45, -0.25);
      registerCrystal(cp.x, cp.y, cp.z, 0.72 * fitScale, crystalHex);
      // 성채 중앙 등대는 야간 PointLight 앵커로도 활용
      streetlampAnchors.push(new Vector3(cp.x, gy + 2.8, cp.z));
    }

    // Tier 0~5 전 구역 안정적 3D 레이캐스트 히트 프록시 (GLB·폴백 모두 일관 피킹, 0 렌더 비용)
    const hitHeight =
      d.tier === 0 ? 1.95
        : d.tier === 1 ? 2.45
          : d.tier === 2 ? 3.40
            : d.tier === 3 ? 4.45
              : d.tier === 4 ? 6.05
                : 6.55;
    const hitRadius = Math.max(1.85, d.radius * 0.98);
    const hitMesh = new Mesh(districtHitGeo, matInvisibleHit);
    hitMesh.name = `district-hit:${d.theaterId}`;
    hitMesh.position.set(d.x, gy, d.z);
    hitMesh.scale.set(hitRadius, hitHeight * fitScale, hitRadius);
    hitMesh.userData = districtMeta;
    districtHitGroup.add(hitMesh);
    districtHitTargets.push(hitMesh);

    const padHalf = (d.tier >= 5 ? 2.38 : d.tier >= 4 ? 2.24 : d.tier >= 3 ? 2.08 : 1.92) * fitScale;
    addContactShadow(b, d.x, d.z, d.radius * 0.84, d.radius * 0.84);
    addGrassClearZone(d.x, d.z, Math.max(d.radius * 0.98, padHalf + 0.35));
    addGrassClearBox(d.x, d.z, padHalf + 0.45, padHalf + 0.45, d.rotationY);
    if (d.tier >= 1) {
      colliders.push({ x: d.x, z: d.z, r: d.radius * 0.42 });
      addCameraOccluder(d.x, d.z, d.radius * 0.62, districtRoofHeight(d.tier) + 0.6, 0, "building");
    }
  }

  /** 사령관별 마을(Village) — 경계 울타리/석조 담장 · Blender 정문 아치/푯말/배너 · 자갈길 · 바이옴(meadow/sakura/autumn/citadel/snow) · 내부 Theater 구역 */
  function buildVillage(b: InstancedBucketBuilder, parent: Group, v: WorldVillageSpec): void {
    const gy = getTerrainBaseHeight(v.x, v.z);
    if (gy < 0.05) return;

    const theme = resolveEffectiveVillageTheme(v);
    const isCitadelBiome = theme === "citadel";
    const isSakuraBiome = theme === "sakura";
    const isAutumnBiome = theme === "autumn";
    const isSnowTheme = theme === "snow";
    const toneHex = TONE_ROOF_HEX[v.tone];
    const gateCos = Math.cos(v.gateAngle);
    const gateSin = Math.sin(v.gateAngle);
    const gateFaceYaw = Math.atan2(gateCos, gateSin);

    // 1. 마을 중앙 광장 원형 문장 디스크 (#21 폴리싱: 구역 이중 선택 링과 겹치지 않게 콤팩트 비율 적용)
    b.addCylinder(
      isSnowTheme || isCitadelBiome || v.overallTier >= 4 ? matMarble : v.overallTier >= 2 ? matStone : matStoneDark,
      [v.x, gy + 0.03, v.z],
      [2.05, 0.06, 2.05],
      undefined,
      { receiveShadow: true },
    );
    b.addTorus(matAccentBase, [v.x, gy + 0.055, v.z], [1.90, 0.36, 1.90], undefined, { color: toneHex });

    // 2. 외곽 경계 아크 (입구 ±0.46 rad 개방)
    const boundaryR = v.radius - 0.15;
    const gapHalf = 0.46;
    const arcSpan = Math.PI * 2 - gapHalf * 2;
    const segCount = Math.max(10, Math.round((boundaryR * arcSpan) / 2.2));
    const isStoneWall = isCitadelBiome || v.overallTier >= 3;
    const isGrandWall = isCitadelBiome || v.overallTier >= 4;

    for (let i = 0; i <= segCount; i += 1) {
      const a0 = v.gateAngle + gapHalf + (i / segCount) * arcSpan;
      const px = v.x + Math.cos(a0) * boundaryR;
      const pz = v.z + Math.sin(a0) * boundaryR;
      const py = getTerrainBaseHeight(px, pz);
      if (py < 0.05) continue;

      const tangYaw = Math.atan2(-Math.sin(a0), Math.cos(a0));
      if (isStoneWall) {
        if (i % 2 === 0 || i === segCount) {
          b.addBox(isGrandWall ? matMarble : matStone, [px, py + 0.50, pz], [0.34, 1.0, 0.34], [0, tangYaw, 0]);
          if (isGrandWall) {
            b.addSphere(matBrass, [px, py + 1.06, pz], [0.16, 0.16, 0.16]);
          }
          addCameraOccluder(px, pz, 0.46, 1.45, 0, "wall");
        }
      } else {
        b.addBox(matWood, [px, py + 0.36, pz], [0.13, 0.76, 0.13], [0, tangYaw, 0]);
      }

      if (i < segCount) {
        const a1 = v.gateAngle + gapHalf + ((i + 1) / segCount) * arcSpan;
        const nx = v.x + Math.cos(a1) * boundaryR;
        const nz = v.z + Math.sin(a1) * boundaryR;
        const mx = (px + nx) * 0.5;
        const mz = (pz + nz) * 0.5;
        const my = getTerrainBaseHeight(mx, mz);
        const segLen = Math.hypot(nx - px, nz - pz);
        const segYaw = Math.atan2(nx - px, nz - pz);

        if (isStoneWall) {
          b.addBox(isGrandWall ? matStone : matStoneDark, [mx, my + 0.30, mz], [0.22, 0.60, segLen + 0.08], [0, segYaw, 0], { receiveShadow: true });
          if (isGrandWall) {
            b.addBox(matMarble, [mx, my + 0.63, mz], [0.28, 0.08, segLen + 0.10], [0, segYaw, 0]);
          }
          addCameraOccluder(mx, mz, 0.42, 1.15, 0, "wall");
        } else {
          b.addBox(matWoodLight, [mx, my + 0.52, mz], [0.07, 0.08, segLen + 0.06], [0, segYaw, 0]);
          b.addBox(matWoodLight, [mx, my + 0.28, mz], [0.07, 0.08, segLen + 0.06], [0, segYaw, 0]);
        }
      }
    }

    // 3. 마을 입구 문주(Blender 정문 아치 GLB 우선, 폴백 유지) + 성문 배너/현판 텍스처 + 마을 푯말
    const gateDist = v.radius - 0.25;
    const gx = v.x + gateCos * gateDist;
    const gz = v.z + gateSin * gateDist;
    const perpX = -gateSin;
    const perpZ = gateCos;
    const gateHalfW = 1.95;
    const gateCosYaw = Math.cos(gateFaceYaw);
    const gateSinYaw = Math.sin(gateFaceYaw);
    const toGateWorld = (ox: number, oy: number, oz: number, lx: number, ly: number, lz: number) => ({
      x: ox + lx * gateCosYaw + lz * gateSinYaw,
      y: oy + ly,
      z: oz - lx * gateSinYaw + lz * gateCosYaw,
    });

    const gateSlot: WorldModelSlot = isStoneWall ? "village-gate-stone" : "village-gate-wood";
    const hasCustomGate = assetRegistry.hasCustomModel(gateSlot);
    const gpy = getTerrainBaseHeight(gx, gz);
    if (hasCustomGate) {
      if (gpy >= 0.05) {
        queueInstancedSlot(gateSlot, {
          x: gx,
          y: gpy,
          z: gz,
          rotationY: gateFaceYaw,
          scale: 1.0,
          roofTintHex: toneHex,
        });
        addContactShadow(b, gx, gz, isStoneWall ? 2.55 : 2.15, 0.95, gateFaceYaw);
      }
    } else {
      for (const side of [-1, 1]) {
        const px = gx + perpX * gateHalfW * side;
        const pz = gz + perpZ * gateHalfW * side;
        const py = getTerrainBaseHeight(px, pz);
        if (py < 0.05) continue;

        if (isStoneWall) {
          b.addBox(isGrandWall ? matMarble : matStone, [px, py + 1.05, pz], [0.56, 2.1, 0.56], [0, gateFaceYaw, 0], { castShadow: true, receiveShadow: true });
          b.addBox(matStoneDark, [px, py + 2.15, pz], [0.68, 0.16, 0.68], [0, gateFaceYaw, 0]);
        } else {
          b.addCylinder(matTimber, [px, py + 0.92, pz], [0.26, 1.85, 0.26], undefined, { tapered: true, castShadow: true });
        }
        // 깃대 + 사령관 테마 색 깃발
        const poleH = isStoneWall ? 3.55 : 2.95;
        b.addCylinder(matWood, [px, py + poleH * 0.5, pz], [0.11, poleH, 0.11], undefined, { tapered: true });
        b.addSphere(matBrass, [px, py + poleH + 0.06, pz], [0.20, 0.20, 0.20]);
        registerBanner(px, py + poleH - 0.34, pz, gateFaceYaw + side * 0.4, toneHex, 0.96, 0.48);
      }

      // Tier 3+ 마을 입구 아치 횡목 / 석조 아치 상인방
      if (isStoneWall) {
        b.addBox(isGrandWall ? matMarble : matTimber, [gx, gpy + 2.26, gz], [gateHalfW * 2 + 0.72, 0.26, 0.38], [0, gateFaceYaw, 0], { castShadow: true });
        b.addBox(matRoofBase, [gx, gpy + 2.48, gz], [gateHalfW * 2 + 0.94, 0.18, 0.54], [0, gateFaceYaw, 0], { color: toneHex });
      }
    }

    // 성문 중앙 현판 & 좌/우 문장 배너 캔버스 텍스처 부착 (빈 판자/단색 천 제거, path/cwd 절대 미포함)
    if (gpy >= 0.05) {
      const gatePlaqueMat = createOwnedSignMaterial(
        createGatePlaqueTexture(v.label, toneHex, v.overallTier),
        true,
      );
      const gateBannerMat = createOwnedSignMaterial(
        createGateBannerTexture(v.label, toneHex, theme),
        true,
      );

      if (hasCustomGate && isStoneWall) {
        // village-gate-stone.glb 상인방 정면(z=+0.27) + 좌우 기둥 배너(x=±2.22, y=1.82)
        const plaquePos = toGateWorld(gx, gpy, gz, 0, 2.74, 0.27);
        mountTexturedPlaque(parent, gatePlaqueMat, plaquePos.x, plaquePos.y, plaquePos.z, 1.38, 0.42, gateFaceYaw);
        for (const side of [-1, 1]) {
          const bFront = toGateWorld(gx, gpy, gz, side * 2.22, 1.82, 0.005);
          mountTexturedPlaque(parent, gateBannerMat, bFront.x, bFront.y, bFront.z, 0.38, 1.18, gateFaceYaw);
          const bBack = toGateWorld(gx, gpy, gz, side * 2.22, 1.82, -0.14);
          mountTexturedPlaque(parent, gateBannerMat, bBack.x, bBack.y, bBack.z, 0.38, 1.18, gateFaceYaw + Math.PI);
        }
      } else if (hasCustomGate && !isStoneWall) {
        // village-gate-wood.glb CenterPlaque 정면(z=+0.205, y=2.52) + 좌우 목재 문주 배너(x=±1.70, y=1.75)
        const plaquePos = toGateWorld(gx, gpy, gz, 0, 2.52, 0.205);
        mountTexturedPlaque(parent, gatePlaqueMat, plaquePos.x, plaquePos.y, plaquePos.z, 0.72, 0.28, gateFaceYaw);
        for (const side of [-1, 1]) {
          const bFront = toGateWorld(gx, gpy, gz, side * 1.70, 1.75, 0.11);
          mountTexturedPlaque(parent, gateBannerMat, bFront.x, bFront.y, bFront.z, 0.28, 0.84, gateFaceYaw);
        }
      } else if (isStoneWall) {
        const plaquePos = toGateWorld(gx, gpy, gz, 0, 2.26, 0.21);
        mountTexturedPlaque(parent, gatePlaqueMat, plaquePos.x, plaquePos.y, plaquePos.z, 1.32, 0.38, gateFaceYaw);
      }
    }

    // 마을 정문 양쪽 문주·상인방 카메라 가림 방지 및 입구 잔디/꽃 정리
    addGrassClearZone(gx, gz, 2.85);
    addGrassClearBox(gx, gz, 2.85, 1.65, gateFaceYaw);
    for (const side of [-1, 1]) {
      addCameraOccluder(gx + perpX * gateHalfW * side, gz + perpZ * gateHalfW * side, 0.72, isStoneWall ? 4.0 : 3.4, 0, "gate");
    }
    if (isStoneWall) {
      addCameraOccluder(gx, gz, 1.70, 4.0, 2.25, "gate");
    }

    // 마을 입구 푯말 (오른쪽 바깥, Blender village-signpost.glb 우선 + 사령관 약칭/문양 캔버스 텍스처)
    const signX = gx + perpX * (gateHalfW + 1.05) + gateCos * 0.45;
    const signZ = gz + perpZ * (gateHalfW + 1.05) + gateSin * 0.45;
    const signY = getTerrainBaseHeight(signX, signZ);
    if (signY >= 0.05) {
      const hasCustomSignpost = assetRegistry.hasCustomModel("village-signpost");
      if (hasCustomSignpost) {
        queueInstancedSlot("village-signpost", {
          x: signX,
          y: signY,
          z: signZ,
          rotationY: gateFaceYaw,
          scale: 1.0,
          roofTintHex: toneHex,
        });
      } else {
        b.withFrame(signX, signY, signZ, gateFaceYaw, 1, () => {
          b.addCylinder(matBark, [0, 0.72, 0], [0.14, 1.44, 0.14], undefined, { tapered: true });
          b.addBox(matWoodLight, [0, 1.18, 0.04], [1.12, 0.42, 0.08]);
          b.addBox(matAccentBase, [0, 1.40, 0.04], [1.18, 0.08, 0.10], undefined, { color: toneHex });
        });
      }
      const villageSignMat = createOwnedSignMaterial(
        createVillageSignTexture(v.label, toneHex, v.overallTier, theme),
        false,
      );
      if (hasCustomSignpost) {
        // village-signpost.glb SignFace 정면 (center 0.01, 1.11, z=+0.132)
        const sp = toGateWorld(signX, signY, signZ, 0.01, 1.11, 0.132);
        mountTexturedPlaque(parent, villageSignMat, sp.x, sp.y, sp.z, 0.80, 0.37, gateFaceYaw);
      } else {
        const sp = toGateWorld(signX, signY, signZ, 0, 1.18, 0.09);
        mountTexturedPlaque(parent, villageSignMat, sp.x, sp.y, sp.z, 1.02, 0.36, gateFaceYaw);
      }
      addContactShadow(b, signX, signZ, 0.56, 0.56);
      addGrassClearZone(signX, signZ, 1.18);
    }

    // 입구 가로등 1기 (성채·가을 단풍·설원 테마이면 입구 양쪽 따뜻한 랜턴 연출)
    const lampX = gx - perpX * (gateHalfW + 0.85) + gateCos * 0.55;
    const lampZ = gz - perpZ * (gateHalfW + 0.85) + gateSin * 0.55;
    addHangingStreetlamp(b, lampX, lampZ, gateFaceYaw + Math.PI * 0.5, true);
    if (isCitadelBiome || isAutumnBiome || isSnowTheme) {
      const rightLampX = gx + perpX * (gateHalfW + 0.85) - gateCos * 0.85;
      const rightLampZ = gz + perpZ * (gateHalfW + 0.85) - gateSin * 0.85;
      addHangingStreetlamp(b, rightLampX, rightLampZ, gateFaceYaw - Math.PI * 0.5, isAutumnBiome || isSnowTheme);
    }

    // 3a. 마을 내부 코블스톤 디딤돌 패스 (정문 ↔ 마을 중앙 광장 ↔ 각 구역 입구, 추가 draw call 0)
    const laySteppingPath = (ax: number, az: number, bx: number, bz: number, startMargin: number, endMargin: number) => {
      const dx = bx - ax;
      const dz = bz - az;
      const dist = Math.hypot(dx, dz);
      const usable = dist - startMargin - endMargin;
      if (usable < 0.55) return;
      const steps = Math.max(2, Math.round(usable / 0.88));
      const dirX = dx / dist;
      const dirZ = dz / dist;
      const latX = -dirZ;
      const latZ = dirX;
      for (let si = 0; si <= steps; si += 1) {
        const dAlong = startMargin + (si / steps) * usable;
        const jitter = ((si % 2 === 0 ? 1 : -1) * 0.14) + (hash2(ax + si, az - si) - 0.5) * 0.10;
        const sx = ax + dirX * dAlong + latX * jitter;
        const sz = az + dirZ * dAlong + latZ * jitter;
        const sy = getTerrainBaseHeight(sx, sz);
        if (sy < 0.05) continue;
        const stoneMat = isCitadelBiome || isSnowTheme
          ? (si % 2 === 0 ? matMarble : matStone)
          : isSakuraBiome || isAutumnBiome
            ? (si % 2 === 0 ? matPlasterWarm : matStone)
            : (si % 2 === 0 ? matStone : matStoneDark);
        const diam = 0.62 + hash2(sx * 2.1, sz * 1.9) * 0.24;
        b.addCylinder(stoneMat, [sx, sy + 0.024, sz], [diam, 0.044, diam * 0.88], [0, hash2(sx, sz) * Math.PI, 0], {
          receiveShadow: true,
        });
      }
    };
    laySteppingPath(gx, gz, v.x, v.z, 0.75, 1.35);
    for (const district of v.districts) {
      laySteppingPath(v.x, v.z, district.x, district.z, 1.35, Math.max(1.55, district.radius * 0.66));
    }

    // 3b. 루틴 풍차 (routineCount > 0): 마을 입구 좌측 외곽에 미니 목조 풍차탑 + 회전 날개
    if (v.routineCount > 0) {
      const millAng = v.gateAngle - 0.58;
      const millDist = v.radius + 1.55;
      const mx = v.x + Math.cos(millAng) * millDist;
      const mz = v.z + Math.sin(millAng) * millDist;
      const my = getTerrainBaseHeight(mx, mz);
      if (my >= 0.05) {
        const millYaw = gateFaceYaw;
        b.withFrame(mx, my, mz, millYaw, 1, () => {
          b.addCylinder(matStone, [0, 0.34, 0], [1.56, 0.68, 1.56], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matPlasterWarm, [0, 1.48, 0], [1.24, 1.72, 1.24], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matWood, [0, 0.72, 0], [1.44, 0.10, 1.44]);
          b.addCone(matRoofBase, [0, 2.74, 0], [1.38, 0.92, 1.38], undefined, { color: toneHex, castShadow: true });
          b.addSphere(matBrass, [0, 3.24, 0], [0.16, 0.16, 0.16]);
          b.addCylinder(matLanternGlass, [0, 1.38, 0.58], [0.24, 0.32, 0.10]);
          b.addCylinder(matTimber, [0, 2.18, 0.58], [0.15, 0.42, 0.15], [Math.PI * 0.5, 0, 0]);
          b.addSphere(matBrass, [0, 2.18, 0.80], [0.18, 0.18, 0.18]);
        });
        addContactShadow(b, mx, mz, 1.15, 1.15);
        addGrassClearZone(mx, mz, 1.45);
        addCameraOccluder(mx, mz, 1.0, 3.4, 0, "building");
        colliders.push({ x: mx, z: mz, r: 0.95 });
        if (animatedRoutineWindmills.length < MAX_ROUTINE_WINDMILLS) {
          const axleX = mx + Math.sin(millYaw) * 0.82;
          const axleZ = mz + Math.cos(millYaw) * 0.82;
          animatedRoutineWindmills.push({
            villageId: v.id,
            x: axleX,
            y: my + 2.18,
            z: axleZ,
            faceYaw: millYaw,
            phase: mx * 0.21 + mz * 0.17,
          });
        }
      }
    }

    // 3c. 황금 업적 기념비 (completedObjectiveCount > 0, 최대 5기): 마을 진입로 좌우 정렬
    const trophyCount = Math.min(5, Math.max(0, v.completedObjectiveCount));
    for (let ti = 0; ti < trophyCount; ti += 1) {
      const side = ti % 2 === 0 ? 1 : -1;
      const rank = Math.floor(ti / 2);
      const forwardDist = gateDist + 1.45 + rank * 1.15;
      const lateralDist = gateHalfW + 1.25;
      const tx = v.x + gateCos * forwardDist + perpX * lateralDist * side;
      const tz = v.z + gateSin * forwardDist + perpZ * lateralDist * side;
      const ty = getTerrainBaseHeight(tx, tz);
      if (ty < 0.05) continue;

      const monumentScale = 0.88 + Math.min(0.24, ti * 0.05);
      b.withFrame(tx, ty, tz, gateFaceYaw, monumentScale, () => {
        b.addBox(matStoneDark, [0, 0.10, 0], [0.68, 0.20, 0.68], undefined, { receiveShadow: true });
        b.addBox(matMarble, [0, 0.28, 0], [0.52, 0.18, 0.52], undefined, { receiveShadow: true });
        b.addCylinder(matBrass, [0, 0.88, 0], [0.30, 1.05, 0.30], undefined, { tapered: true, castShadow: true });
        b.addTorus(matLanternGlass, [0, 1.40, 0], [0.32, 0.32, 0.32]);
        b.addOctahedron(matAccentBase, [0, 1.64, 0], [0.28, 0.42, 0.28], undefined, { color: toneHex });
      });
      addContactShadow(b, tx, tz, 0.46 * monumentScale, 0.46 * monumentScale);
      addGrassClearZone(tx, tz, 0.72 * monumentScale);
    }

    // 3d. 업적 해금 3D 마을 랜드마크 (lantern-arch.glb / trophy-statue.glb)
    // (#12) 벚꽃 등불 아치를 정면 입구→중앙→후면 Tier 3~5 시야축에서 측면/입구 외곽 동선으로 옮겨 성장 파노라마 시야를 완전 개방한다.
    if ((v.overallTier >= 3 || trophyCount >= 1) && assetRegistry.hasCustomModel("lantern-arch")) {
      const sideLat = Math.min(4.0, Math.max(2.9, v.radius * 0.38));
      const archCandidates: readonly [number, number, number][] = [
        [v.x + perpX * sideLat + gateCos * (gateDist * 0.52), v.z + perpZ * sideLat + gateSin * (gateDist * 0.52), gateFaceYaw - 0.36],
        [v.x - perpX * sideLat + gateCos * (gateDist * 0.52), v.z - perpZ * sideLat + gateSin * (gateDist * 0.52), gateFaceYaw + 0.36],
        [v.x + perpX * (gateHalfW + 2.25) + gateCos * (gateDist + 1.45), v.z + perpZ * (gateHalfW + 2.25) + gateSin * (gateDist + 1.45), gateFaceYaw - 0.28],
        [v.x - perpX * (gateHalfW + 2.25) + gateCos * (gateDist + 1.45), v.z - perpZ * (gateHalfW + 2.25) + gateSin * (gateDist + 1.45), gateFaceYaw + 0.28],
      ];
      for (const [ax, az, aYaw] of archCandidates) {
        const ay = getTerrainBaseHeight(ax, az);
        if (ay < 0.05 || isInBrookChannel(ax, az, 1.4)) continue;
        const hitsDistrict = v.districts.some((d) => Math.hypot(ax - d.x, az - d.z) < d.radius * 0.76 + 1.15);
        if (hitsDistrict) continue;
        queueInstancedSlot("lantern-arch", {
          x: ax,
          y: ay,
          z: az,
          rotationY: aYaw,
          scale: 1.0,
        });
        addContactShadow(b, ax, az, 1.55, 0.72, aYaw);
        addGrassClearZone(ax, az, 1.85);
        streetlampAnchors.push(new Vector3(ax, ay + 2.35, az));
        break;
      }
    }

    if ((v.overallTier >= 5 || trophyCount >= 2) && assetRegistry.hasCustomModel("trophy-statue")) {
      const statueCandidates: readonly [number, number][] = [
        [v.x - perpX * 2.35 - gateCos * 0.85, v.z - perpZ * 2.35 - gateSin * 0.85],
        [v.x + perpX * 2.35 - gateCos * 0.85, v.z + perpZ * 2.35 - gateSin * 0.85],
        [v.x - gateCos * 2.45, v.z - gateSin * 2.45],
        [v.x + perpX * (gateHalfW + 1.65) + gateCos * (gateDist * 0.72), v.z + perpZ * (gateHalfW + 1.65) + gateSin * (gateDist * 0.72)],
      ];
      for (const [sx, sz] of statueCandidates) {
        const sy = getTerrainBaseHeight(sx, sz);
        if (sy < 0.05) continue;
        const hitsDistrict = v.districts.some((d) => Math.hypot(sx - d.x, sz - d.z) < d.radius * 0.75 + 1.05);
        if (hitsDistrict) continue;
        queueInstancedSlot("trophy-statue", {
          x: sx,
          y: sy,
          z: sz,
          rotationY: gateFaceYaw,
          scale: 1.0,
        });
        addContactShadow(b, sx, sz, 0.96, 0.96);
        addGrassClearZone(sx, sz, 1.25);
        colliders.push({ x: sx, z: sz, r: 0.72 });
        addCameraOccluder(sx, sz, 0.72, 2.45, 0, "prop");
        break;
      }
    }

    // 4. 내부 Theater 구역(District) 건축물 배치
    if (v.districts.length === 0) {
      // 미배정 사령관 마을: 개척 대기 아늑한 벤치 & 모닥불 쉼터
      addWoodenBench(b, v.x - perpX * 2.1, v.z - perpZ * 2.1, gateFaceYaw + 0.6);
      const fireX = v.x - gateCos * 2.2;
      const fireZ = v.z - gateSin * 2.2;
      const fireY = getTerrainBaseHeight(fireX, fireZ);
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        b.addDodeca(matStone, [fireX + Math.cos(a) * 0.48, fireY + 0.07, fireZ + Math.sin(a) * 0.48], [0.28, 0.16, 0.24], undefined, { flat: true });
      }
      registerFlame(fireX, fireY + 0.10, fireZ, 0.68);
    } else {
      for (const district of v.districts) {
        buildDistrict(b, parent, district, theme);
      }
    }

    // 마을 광장 장식 화단 (flowerbed.glb — 벚꽃 바이옴이면 화단 추가 강조, 설원 테마는 눈 덮인 이끼 돌 악센트)
    if (isSnowTheme) {
      for (const side of [-1, 1]) {
        const mAng = v.gateAngle + Math.PI + side * 0.48;
        const mx = v.x + Math.cos(mAng) * (v.radius + 1.25);
        const mz = v.z + Math.sin(mAng) * (v.radius + 1.25);
        const my = getTerrainBaseHeight(mx, mz);
        if (my >= 0.08) {
          b.addDodeca(matSnowCap, [mx, my + 0.20, mz], [1.28, 0.46, 1.05], [0.1, mAng, 0], { flat: true, receiveShadow: true });
          b.addDodeca(matStone, [mx + 0.42 * side, my + 0.16, mz + 0.22], [0.64, 0.34, 0.56], [0.2, mAng, 0.1], { flat: true, receiveShadow: true });
          addGrassClearZone(mx, mz, 1.15);
        }
      }
    } else if (assetRegistry.hasCustomModel("flowerbed")) {
      const fbOffsets: readonly [number, number][] = isSakuraBiome
        ? [
            [perpX * 2.55 + gateCos * 1.65, perpZ * 2.55 + gateSin * 1.65],
            [-perpX * 2.55 + gateCos * 1.65, -perpZ * 2.55 + gateSin * 1.65],
            [perpX * 2.45 - gateCos * 1.55, perpZ * 2.45 - gateSin * 1.55],
            [-perpX * 2.45 - gateCos * 1.55, -perpZ * 2.45 - gateSin * 1.55],
          ]
        : [
            [perpX * 2.65 + gateCos * 1.45, perpZ * 2.65 + gateSin * 1.45],
            [-perpX * 2.65 + gateCos * 1.45, -perpZ * 2.65 + gateSin * 1.45],
          ];
      for (const [ox, oz] of fbOffsets) {
        const fbx = v.x + ox;
        const fbz = v.z + oz;
        const overlapsDistrict = v.districts.some((d) => Math.hypot(fbx - d.x, fbz - d.z) < d.radius * 0.72 + 0.85);
        if (overlapsDistrict) continue;
        const fby = getTerrainBaseHeight(fbx, fbz);
        if (fby < 0.05) continue;
        queueInstancedSlot("flowerbed", {
          x: fbx,
          y: fby,
          z: fbz,
          rotationY: hash2(fbx, fbz) * Math.PI * 2,
          scale: isSakuraBiome ? 0.96 : 0.86,
        });
        addContactShadow(b, fbx, fbz, 0.85, 0.85);
        addGrassClearZone(fbx, fbz, 1.15);
      }
    }

    // 마을 외곽 장식 나무 (바이옴·이름 키워드별 수종 차별화: snow → 설원 소나무, autumn → 단풍나무, sakura → 벚나무, citadel → 침엽수)
    for (const side of [-1, 1]) {
      const tAng = v.gateAngle + Math.PI + side * 0.92;
      const tx = v.x + Math.cos(tAng) * (v.radius + 2.05);
      const tz = v.z + Math.sin(tAng) * (v.radius + 2.05);
      const kind = isSnowTheme
        ? "snow-pine"
        : isAutumnBiome
          ? "autumn"
          : isSakuraBiome
            ? "blossom"
            : isCitadelBiome
              ? "pine"
              : (v.tone === "rose" || v.tone === "plum" ? "blossom" : side > 0 ? "oak" : "pine");
      addTree(b, parent, tx, tz, isSakuraBiome || isAutumnBiome || isSnowTheme ? 1.08 : 0.96, kind, true);
    }
    if (isSakuraBiome || isAutumnBiome || isSnowTheme) {
      // (#3) 측면 프레이밍 나무는 입구 카메라 시야 회랑 밖(gateAngle ± 1.12 rad, radius + 2.65m)에 배치해 착지 직후 시야 가림 차단
      for (const side of [-1, 1]) {
        if (side < 0 && v.routineCount > 0) continue;
        const eAng = v.gateAngle + side * 1.12;
        const tx = v.x + Math.cos(eAng) * (v.radius + 2.65);
        const tz = v.z + Math.sin(eAng) * (v.radius + 2.65);
        if (isInVillageEntranceSightCorridor(tx, tz)) continue;
        const sideKind = isSnowTheme ? "snow-pine" : isAutumnBiome ? "autumn" : "blossom";
        addTree(b, parent, tx, tz, 1.05, sideKind, true);
        if (isAutumnBiome) {
          const bAng = v.gateAngle + Math.PI + side * 0.42;
          const bx = v.x + Math.cos(bAng) * (v.radius + 1.35);
          const bz = v.z + Math.sin(bAng) * (v.radius + 1.35);
          const by = getTerrainBaseHeight(bx, bz);
          if (by >= 0.08) {
            b.addDodeca(matFoliageBase, [bx, by + 0.28, bz], [1.05, 0.72, 0.96], undefined, { color: 0xe87b22, receiveShadow: true });
            b.addDodeca(matFoliageBase, [bx + 0.32, by + 0.22, bz + 0.16], [0.68, 0.58, 0.68], undefined, { color: 0xf5ba32, receiveShadow: true });
            addContactShadow(b, bx, bz, 0.85, 0.78);
            addGrassClearZone(bx, bz, 0.95);
          }
        }
      }
      if (isAutumnBiome) {
        // 가을 단풍 마을 마당 가장자리 낙엽 산포 (기존 matFoliageBase 배칭 공유, 추가 draw call 0)
        const leafPalette = [0xd94832, 0xe87b22, 0xf5ba32] as const;
        const leafSeed = Math.abs(Math.sin(v.x * 12.9898 + v.z * 78.233)) * 6.283185;
        for (let li = 0; li < 20; li += 1) {
          const ang = (li / 20) * Math.PI * 2 + leafSeed + Math.sin(li * 3.7) * 0.14;
          let dGate = Math.abs(Math.atan2(Math.sin(ang - v.gateAngle), Math.cos(ang - v.gateAngle)));
          if (dGate < 0.34) continue;
          const rDist = v.radius - 0.85 + ((li * 0.37) % 1) * 2.15;
          const lx = v.x + Math.cos(ang) * rDist;
          const lz = v.z + Math.sin(ang) * rDist;
          const ly = getTerrainBaseHeight(lx, lz);
          if (ly < 0.08) continue;
          const lw = 0.24 + (li % 3) * 0.07;
          const ld = 0.18 + ((li + 1) % 3) * 0.06;
          const rotY = ang + (li % 5) * 0.62;
          b.addBox(matFoliageBase, [lx, ly + 0.022, lz], [lw, 0.024, ld], [0, rotY, 0], {
            color: leafPalette[li % leafPalette.length]!,
            receiveShadow: true,
          });
        }
      }
    }
  }

  /** 기존 Objective 초원 공방 캠프 및 사령관 정원 파빌리온 구축 */
  function buildZoneStructures(b: InstancedBucketBuilder, parent: Group, zone: WorldZoneSpec): void {
    if (zone.kind === "garden") {
      const gy = getTerrainBaseHeight(zone.x, zone.z);
      b.withFrame(zone.x, gy, zone.z, 0, 1, () => {
        b.addCylinder(matStoneDark, [0, 0.09, 0], [5.1, 0.18, 5.1], undefined, { tapered: true, receiveShadow: true });
        b.addCylinder(matStone, [0, 0.26, 0], [4.45, 0.24, 4.45], undefined, { tapered: true, receiveShadow: true });
        for (let k = 0; k < 6; k += 1) {
          const a = (k / 6) * Math.PI * 2 + 0.26;
          b.addCylinder(matPlaster, [Math.cos(a) * 1.72, 1.28, Math.sin(a) * 1.72], [0.24, 1.85, 0.24], undefined, { castShadow: true });
        }
        b.addCylinder(matWood, [0, 2.24, 0], [3.92, 0.16, 3.92]);
        b.addCone(matRoofBase, [0, 2.75, 0], [4.84, 0.92, 4.84], undefined, { color: TONE_ROOF_HEX.cerulean, castShadow: true });
        b.addCone(matRoofBase, [0, 3.32, 0], [2.76, 0.72, 2.76], undefined, { color: TONE_ROOF_HEX.cerulean, castShadow: true });
        b.addSphere(matBrass, [0, 3.74, 0], [0.26, 0.26, 0.26]);
      });
      addContactShadow(b, zone.x, zone.z, 3.05, 3.05);
      addGrassClearZone(zone.x, zone.z, 3.25);
      addCameraOccluder(zone.x, zone.z, 2.2, 3.8);
      addWoodenBench(b, zone.x - 3.1, zone.z + 0.6, 0.65);
      addTree(b, parent, zone.x + 3.6, zone.z + 1.2, 1.12, "blossom");
      addTree(b, parent, zone.x - 3.6, zone.z + 2.0, 1.02, "blossom");
      addHangingStreetlamp(b, zone.x - 3.6, zone.z - 1.6, 0.4);
      return;
    }

    if (zone.kind !== "outpost") return;

    const toneHex = TONE_ROOF_HEX[zone.roofTone];

    // 1. 하프팀버 공방 오두막
    const cx = zone.x - 2.15;
    const cz = zone.z - 2.35;
    const cgy = getTerrainBaseHeight(cx, cz);
    const faceYaw = Math.atan2(-cx, -cz) * 0.25 + 0.22;
    b.withFrame(cx, cgy, cz, faceYaw, 1, () => {
      b.addBox(matStone, [0, 0.12, 0], [2.95, 0.24, 2.45], undefined, { receiveShadow: true });
      b.addBox(matPlaster, [0, 1.10, 0], [2.68, 1.75, 2.18], undefined, { castShadow: true, receiveShadow: true });
      for (const px of [-1.33, 1.33]) {
        for (const pz of [-1.08, 1.08]) {
          b.addBox(matTimber, [px, 1.10, pz], [0.11, 1.78, 0.11]);
        }
      }
      b.addBox(matTimber, [0, 1.96, 0], [2.74, 0.10, 2.24]);
      b.addBox(matWood, [-0.48, 0.84, 1.10], [0.68, 1.22, 0.10]);
      b.addSphere(matBrass, [-0.24, 0.82, 1.17], [0.08, 0.08, 0.08]);
      b.addBox(matStoneDark, [-0.48, 0.07, 1.32], [0.88, 0.14, 0.42]);
      addFramedWindow(b, 0.56, 1.16, 1.10, 0, 0.82, true);
      b.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
        y: 1.98,
        width: 2.82,
        height: 1.18,
        depth: 2.32,
        roofColor: toneHex,
        castShadow: true,
        receiveShadow: true,
      });
      b.addBox(matStoneDark, [0.85, 2.55, -0.45], [0.42, 1.25, 0.42], undefined, { castShadow: true });
    });
    addContactShadow(b, cx, cz, 2.05, 1.85);
    addGrassClearZone(cx, cz, 2.25);
    addCameraOccluder(cx, cz, 1.85, 3.4);
    colliders.push({ x: cx, z: cz, r: 1.78 });

    // 2. 캠프 상징 컬러 깃발
    const fx = zone.x + 2.35;
    const fz = zone.z - 2.45;
    const fgy = getTerrainBaseHeight(fx, fz);
    b.addCylinder(matWood, [fx, fgy + 1.42, fz], [0.13, 2.85, 0.13], undefined, { tapered: true });
    b.addSphere(matBrass, [fx, fgy + 2.88, fz], [0.20, 0.20, 0.20]);
    registerBanner(fx, fgy + 2.52, fz, 0.15, toneHex, 0.92, 0.46);

    // 3. 4족 오크 작전 브리핑 테이블
    const tx = zone.x + 0.55;
    const tz = zone.z - 0.45;
    const tgy = getTerrainBaseHeight(tx, tz);
    b.withFrame(tx, tgy, tz, 0, 1, () => {
      b.addCylinder(matWood, [0, 0.64, 0], [1.92, 0.10, 1.92], undefined, { receiveShadow: true });
      for (let l = 0; l < 4; l += 1) {
        const la = (l / 4) * Math.PI * 2 + Math.PI * 0.25;
        b.addCylinder(matTimber, [Math.cos(la) * 0.62, 0.31, Math.sin(la) * 0.62], [0.12, 0.62, 0.12]);
      }
      b.addBox(matParchment, [0, 0.70, 0], [1.02, 0.03, 0.76], [0, 0.18, 0]);
      b.addCone(matAccentBase, [-0.18, 0.78, 0.08], [0.11, 0.14, 0.11], undefined, { color: toneHex });
      b.addCylinder(matBrass, [0.22, 0.76, -0.12], [0.09, 0.11, 0.09]);
      b.addCylinder(matLanternGlass, [-0.52, 0.78, -0.35], [0.16, 0.18, 0.16]);
    });
    colliders.push({ x: tx, z: tz, r: 0.92 });

    // 4. 공방 전문 설비
    if (zone.fullWorkshop !== false) {
      const ax = zone.x - 3.25;
      const az = zone.z + 0.95;
      const agy = getTerrainBaseHeight(ax, az);
      b.withFrame(ax, agy, az, 0.38, 1, () => {
        b.addCylinder(matWood, [0, 0.26, 0], [0.96, 0.52, 0.96], undefined, { tapered: true });
        b.addBox(matIron, [0, 0.58, 0], [0.48, 0.12, 0.30]);
        b.addBox(matIron, [0, 0.70, 0], [0.32, 0.14, 0.22]);
        b.addBox(matIron, [0, 0.82, 0], [0.56, 0.14, 0.26]);
        b.addCone(matIron, [0.42, 0.82, 0], [0.22, 0.34, 0.22], [0, 0, -Math.PI * 0.5]);
      });
      colliders.push({ x: ax, z: az, r: 0.65 });
      addGrassClearZone(ax, az, 0.95);

      const rx = zone.x + 3.15;
      const rz = zone.z + 0.45;
      const rgy = getTerrainBaseHeight(rx, rz);
      b.withFrame(rx, rgy, rz, -0.62, 1, () => {
        b.addBox(matWood, [0, 0.62, 0], [1.12, 0.08, 0.68]);
        for (const lx of [-0.46, 0.46]) {
          for (const lz of [-0.24, 0.24]) {
            b.addBox(matTimber, [lx, 0.31, lz], [0.07, 0.62, 0.07]);
          }
        }
        b.addBox(matStone, [0, 0.92, -0.06], [0.66, 0.54, 0.46]);
        b.addBox(matScreen, [0, 0.93, 0.16], [0.52, 0.38, 0.05]);
        b.addBox(matIron, [0, 0.68, 0.22], [0.48, 0.04, 0.18]);
      });
      colliders.push({ x: rx, z: rz, r: 0.72 });
      addGrassClearZone(rx, rz, 1.05);
    } else {
      const ox = zone.x + 2.75;
      const oz = zone.z + 0.95;
      const ogy = getTerrainBaseHeight(ox, oz);
      b.withFrame(ox, ogy, oz, 0.45, 1, () => {
        for (let k = 0; k < 3; k += 1) {
          const ka = (k / 3) * Math.PI * 2;
          b.addCylinder(matTimber, [Math.cos(ka) * 0.22, 0.48, Math.sin(ka) * 0.22], [0.06, 1.05, 0.06], [-Math.sin(ka) * 0.26, 0, Math.cos(ka) * 0.26]);
        }
        b.addSphere(matIron, [0, 0.98, 0], [0.22, 0.22, 0.22]);
        b.addCylinder(matBrass, [0, 1.12, 0.05], [0.22, 1.08, 0.22], [-1.05, 0, 0], { tapered: true });
        b.addCylinder(matScreen, [0, 1.38, 0.50], [0.27, 0.08, 0.27], [-1.05, 0, 0]);
        b.addBox(matWood, [-0.78, 0.21, 0.22], [0.58, 0.42, 0.48]);
        b.addBox(matAccentBase, [-0.78, 0.46, 0.22], [0.32, 0.08, 0.24], undefined, { color: toneHex });
      });
      colliders.push({ x: ox, z: oz, r: 0.72 });
      addGrassClearZone(ox, oz, 1.05);
    }

    addFenceRun(b, zone.x - 4.2, zone.z - 4.1, zone.x + 1.4, zone.z - 4.4, 4);
    addHangingStreetlamp(b, zone.x + 1.95, zone.z - 2.1, -0.5, false);
    addBushAndRockCluster(b, zone.x - 3.6, zone.z + 2.8, 0.95);
  }

  function applyHighlightMesh(mesh: Mesh, mat: ShaderMaterial, district: WorldDistrictSpec | null): void {
    if (!district) {
      mesh.visible = false;
      return;
    }
    const gy = getTerrainBaseHeight(district.x, district.z);
    mesh.visible = true;
    mesh.position.set(district.x, gy + 0.11, district.z);
    mesh.scale.setScalar(district.radius * 1.12);
    (mat.uniforms["uColor"]!.value as Color).setHex(TONE_CRYSTAL_HEX[district.tone]);
  }

  function syncHoverVisualTarget(hovered: WorldDistrictSpec | null, selected: WorldDistrictSpec | null): void {
    const effectiveHover = hovered && selected && hovered.id === selected.id ? null : hovered;
    if (effectiveHover) {
      hoverDisplayedDistrict = effectiveHover;
      const gy = getTerrainBaseHeight(effectiveHover.x, effectiveHover.z);
      hoverHighlightMesh.position.set(effectiveHover.x, gy + 0.11, effectiveHover.z);
      (hoverHighlightMat.uniforms["uColor"]!.value as Color).setHex(TONE_CRYSTAL_HEX[effectiveHover.tone]);
      hoverAuraMesh.position.set(effectiveHover.x, gy + 0.08, effectiveHover.z);
      hoverAuraMat.color.setHex(TONE_CRYSTAL_HEX[effectiveHover.tone]);
    }
  }

  /**
   * 모든 비-교량 오솔길 세그먼트를 지형 높이(+0.045m)에 밀착하는 단일 병합 BufferGeometry 리본 메쉬(1 draw call)로 생성한다.
   * 3점 횡단면(좌·중·우)으로 경사면 파고듦 없이 끊김 없는 연속 흙길을 보장한다.
   */
  function buildRoadRibbonMesh(segments: readonly RoadSegment[]): Mesh | null {
    const positions: number[] = [];
    const uvs: number[] = [];
    const endFades: number[] = [];
    const indices: number[] = [];
    let vertOffset = 0;

    for (const seg of segments) {
      if (seg.isBridgeDeck) continue;
      const segLen = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      if (segLen < 0.4) continue;
      const halfW = Math.max(1.52, seg.width * 1.16);
      const steps = Math.max(4, Math.ceil(segLen / 1.05));
      // 교차점/정문 접합부 틈새 방지를 위해 양끝을 0.45m 소폭 오버랩 후 끝단만 부드럽게 페이드
      const extT = Math.min(0.12, 0.45 / segLen);

      for (let i = 0; i <= steps; i += 1) {
        const uStep = i / steps;
        const tRaw = -extT + uStep * (1 + extT * 2);
        const t = Math.max(0, Math.min(1, tRaw));
        const pt = sampleRoadPoint(seg, t);
        // tRaw가 0..1 범위 밖이면 접선 방향으로 소폭 연장해 분기점 틈새 0
        const extraAlong = (tRaw - t) * segLen;
        const cx = pt.x + pt.dirX * extraAlong;
        const cz = pt.z + pt.dirZ * extraAlong;

        // 실제 접선 직교 벡터 계산 (곡선 구간 폭 왜곡 방지)
        const tNext = Math.min(1, t + 0.015);
        const tPrev = Math.max(0, t - 0.015);
        const pN = sampleRoadPoint(seg, tNext);
        const pP = sampleRoadPoint(seg, tPrev);
        const tx = pN.x - pP.x;
        const tz = pN.z - pP.z;
        const tLen = Math.max(0.0001, Math.hypot(tx, tz));
        const sideX = -tz / tLen;
        const sideZ = tx / tLen;

        const distFromEdge = Math.min(uStep, 1 - uStep) * (segLen + 0.9);
        const fade = smoothstep(0.0, 0.55, distFromEdge);

        const lx = cx - sideX * halfW;
        const lz = cz - sideZ * halfW;
        const rx = cx + sideX * halfW;
        const rz = cz + sideZ * halfW;

        const yLift = 0.048;
        const ly = Math.max(0.12, getTerrainBaseHeight(lx, lz)) + yLift;
        const cy = Math.max(0.12, getTerrainBaseHeight(cx, cz)) + yLift + 0.012;
        const ry = Math.max(0.12, getTerrainBaseHeight(rx, rz)) + yLift;

        const vCoord = uStep * segLen * 0.25;
        positions.push(lx, ly, lz, cx, cy, cz, rx, ry, rz);
        uvs.push(0, vCoord, 0.5, vCoord, 1, vCoord);
        endFades.push(fade, fade, fade);

        if (i < steps) {
          const row0 = vertOffset + i * 3;
          const row1 = row0 + 3;
          // 좌측 반폭 쿼드 (위에서 내려다볼 때 CCW: FrontSide)
          indices.push(row0, row0 + 1, row1, row0 + 1, row1 + 1, row1);
          // 우측 반폭 쿼드
          indices.push(row0 + 1, row0 + 2, row1 + 1, row0 + 2, row1 + 2, row1 + 1);
        }
      }
      vertOffset += (steps + 1) * 3;
    }

    if (positions.length === 0) return null;
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
    geo.setAttribute("aEndFade", new BufferAttribute(new Float32Array(endFades), 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    const mesh = new Mesh(geo, roadRibbonMat);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** 지형 정점 좌표/컬러 갱신, InstancedMesh 구조물/마을/구역 배칭, 풀잎·들꽃 인스탄싱 */
  function rebuildWorld(zones: readonly WorldZoneSpec[], villages: readonly WorldVillageSpec[]): void {
    disposeDynamicSignResources();
    disposeObjectTree(dynamicWorldGroup);
    while (dynamicWorldGroup.children.length > 0) {
      dynamicWorldGroup.remove(dynamicWorldGroup.children[0]!);
    }
    districtHitGroup.clear();
    dynamicWorldGroup.add(districtHitGroup);
    streetlampAnchors.length = 0;
    colliders = [];
    grassClearZones = [];
    grassClearBoxes = [];
    cameraOccluders = [];
    cameraOccluderObjects = [];
    districtHitTargets = [];
    fishingSpotAnchors = [];
    forestAudioAnchors = [];
    animatedBanners = [];
    animatedFlames = [];
    animatedCrystals = [];
    animatedRoutineWindmills = [];
    customBladePivots.length = 0;
    instancedSlotQueues = new Map();
    assetRegistry.clearActiveMixers();
    currentZones = zones;
    currentVillages = villages;

    // 1. 광장 ↔ 사령관 마을 정문 자연 S자 시골 오솔길 + 외곽 순환 산책로(4개 목교 연동) 생성
    roadSegments = [];
    const eastNorth = fromBridgeLocal(BRIDGE_EAST, 0, -BRIDGE_EAST.halfSpan - 0.35);
    const eastSouth = fromBridgeLocal(BRIDGE_EAST, 0, BRIDGE_EAST.halfSpan + 0.45);
    const westNorth = fromBridgeLocal(BRIDGE_WEST, 0, -BRIDGE_WEST.halfSpan - 0.35);
    const westSouth = fromBridgeLocal(BRIDGE_WEST, 0, BRIDGE_WEST.halfSpan + 0.45);
    const eastOuterNorth = fromBridgeLocal(BRIDGE_EAST_OUTER, 0, -BRIDGE_EAST_OUTER.halfSpan - 0.4);
    const eastOuterSouth = fromBridgeLocal(BRIDGE_EAST_OUTER, 0, BRIDGE_EAST_OUTER.halfSpan + 0.45);
    const westOuterNorth = fromBridgeLocal(BRIDGE_WEST_OUTER, 0, -BRIDGE_WEST_OUTER.halfSpan - 0.4);
    const westOuterSouth = fromBridgeLocal(BRIDGE_WEST_OUTER, 0, BRIDGE_WEST_OUTER.halfSpan + 0.45);

    // 중앙 광장 → 중앙 목교 2기 진입로 + 4개 목교 직선 교량 구간
    roadSegments.push({ ax: 1.0, az: 1.4, bx: eastNorth.x, bz: eastNorth.z, width: 1.35, curveAmp: 1.25, curvePhase: 0.45 });
    roadSegments.push({ ax: eastNorth.x, az: eastNorth.z, bx: eastSouth.x, bz: eastSouth.z, width: 1.35, curveAmp: 0, curvePhase: 0, isBridgeDeck: true });
    roadSegments.push({ ax: -1.8, az: 1.6, bx: westNorth.x, bz: westNorth.z, width: 1.30, curveAmp: -1.20, curvePhase: -0.35 });
    roadSegments.push({ ax: westNorth.x, az: westNorth.z, bx: westSouth.x, bz: westSouth.z, width: 1.30, curveAmp: 0, curvePhase: 0, isBridgeDeck: true });
    roadSegments.push({ ax: eastOuterNorth.x, az: eastOuterNorth.z, bx: eastOuterSouth.x, bz: eastOuterSouth.z, width: 1.25, curveAmp: 0, curvePhase: 0, isBridgeDeck: true });
    roadSegments.push({ ax: westOuterNorth.x, az: westOuterNorth.z, bx: westOuterSouth.x, bz: westOuterSouth.z, width: 1.25, curveAmp: 0, curvePhase: 0, isBridgeDeck: true });

    const villageGateNodes: {
      readonly v: WorldVillageSpec;
      readonly outerX: number;
      readonly outerZ: number;
      readonly isSouth: boolean;
    }[] = [];

    for (let vi = 0; vi < villages.length; vi += 1) {
      const v = villages[vi]!;
      const gCos = Math.cos(v.gateAngle);
      const gSin = Math.sin(v.gateAngle);
      const gateInnerX = v.x + gCos * (v.radius - 0.15);
      const gateInnerZ = v.z + gSin * (v.radius - 0.15);
      const gateOuterX = v.x + gCos * (v.radius + 2.8);
      const gateOuterZ = v.z + gSin * (v.radius + 2.8);
      const isSouth = v.z > brookProfile(v.x).centerZ + 1.5;
      villageGateNodes.push({ v, outerX: gateOuterX, outerZ: gateOuterZ, isSouth });

      // 1) 정문 앞마당 → 정문 입구 직선 에이프런 (울타리 측면 관통 방지)
      roadSegments.push({
        ax: gateOuterX,
        az: gateOuterZ,
        bx: gateInnerX,
        bz: gateInnerZ,
        width: 1.40,
        curveAmp: 0,
        curvePhase: 0,
      });
      // 2) 광장/남부 목교 남단 → 정문 앞마당 자연스러운 다중 하모닉 S자 시골 오솔길 (직선 바퀴살 느낌 탈피)
      const startPt = isSouth
        ? (v.x >= -2 ? eastSouth : westSouth)
        : { x: 0, z: -1.2 };
      const segLen = Math.hypot(gateOuterX - startPt.x, gateOuterZ - startPt.z);
      const sign = vi % 2 === 0 ? 1 : -1;
      const curveAmp = segLen >= 16 ? Math.min(5.2, Math.max(3.2, segLen * 0.115)) * sign : 1.15 * sign;
      const curveAmp2 = segLen >= 22 ? curveAmp * -0.34 : 0;
      const curvePhase = (hash2(v.x, v.z) - 0.5) * 0.55;
      const curvePhase2 = 0.65 + (hash2(v.z, v.x) - 0.5) * 0.6;
      roadSegments.push({
        ax: startPt.x,
        az: startPt.z,
        bx: gateOuterX,
        bz: gateOuterZ,
        width: 1.35,
        curveAmp,
        curvePhase,
        curveAmp2,
        curvePhase2,
        isMainRoad: true,
      });
    }

    // 1b. 외곽 순환 산책로(Outer Scenic Ring Loop): 동/서 외곽 목교 2기와 인접 마을 정문 앞마당을 자연 곡선으로 순환 연결
    const northLoop = villageGateNodes
      .filter((n) => !n.isSouth)
      .sort((a, b) => a.v.x - b.v.x);
    const southLoop = villageGateNodes
      .filter((n) => n.isSouth)
      .sort((a, b) => b.v.x - a.v.x);

    const pushScenicLoopLeg = (ax: number, az: number, bx: number, bz: number, idx: number, preferOutward: boolean) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 6.0) return;
      const midX = (ax + bx) * 0.5;
      const midZ = (az + bz) * 0.5;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      const perpX = -dz;
      const perpZ = dx;
      // 마을 중심과 겹치지 않는 방향으로 자연스러운 시골길 굽이(3.2..5.4m) 부여
      const baseAmp = Math.min(5.4, Math.max(3.2, len * 0.11));
      const dotOrigin = perpX * midX + perpZ * midZ;
      let dirSign = preferOutward ? (dotOrigin >= 0 ? 1 : -1) : (idx % 2 === 0 ? 1 : -1);
      // 후보 방향의 중점이 어떤 마을과 가까우면 반대 방향으로 자동 우회
      const candX = midX + perpX * baseAmp * dirSign;
      const candZ = midZ + perpZ * baseAmp * dirSign;
      const hitsVillage = villages.some((v) => Math.hypot(candX - v.x, candZ - v.z) < v.radius + 2.4);
      if (hitsVillage) dirSign = -dirSign;
      roadSegments.push({
        ax,
        az,
        bx,
        bz,
        width: 1.24,
        curveAmp: baseAmp * dirSign,
        curvePhase: (hash2(ax, bz) - 0.5) * 0.45,
        curveAmp2: baseAmp * -0.26 * dirSign,
        curvePhase2: 0.7,
        isMainRoad: len >= 20,
      });
    };

    if (northLoop.length > 0) {
      pushScenicLoopLeg(westOuterNorth.x, westOuterNorth.z, northLoop[0]!.outerX, northLoop[0]!.outerZ, 0, false);
      for (let i = 0; i < northLoop.length - 1; i += 1) {
        const a = northLoop[i]!;
        const b = northLoop[i + 1]!;
        pushScenicLoopLeg(a.outerX, a.outerZ, b.outerX, b.outerZ, i + 1, false);
      }
      const lastN = northLoop[northLoop.length - 1]!;
      pushScenicLoopLeg(lastN.outerX, lastN.outerZ, eastOuterNorth.x, eastOuterNorth.z, northLoop.length + 1, false);
    }
    if (southLoop.length > 0) {
      pushScenicLoopLeg(eastOuterSouth.x, eastOuterSouth.z, southLoop[0]!.outerX, southLoop[0]!.outerZ, 10, false);
      for (let i = 0; i < southLoop.length - 1; i += 1) {
        const a = southLoop[i]!;
        const b = southLoop[i + 1]!;
        pushScenicLoopLeg(a.outerX, a.outerZ, b.outerX, b.outerZ, 11 + i, false);
      }
      const lastS = southLoop[southLoop.length - 1]!;
      pushScenicLoopLeg(lastS.outerX, lastS.outerZ, westOuterSouth.x, westOuterSouth.z, 20, false);
    } else if (northLoop.length > 0) {
      pushScenicLoopLeg(eastOuterSouth.x, eastOuterSouth.z, westOuterSouth.x, westOuterSouth.z, 21, true);
    }
    for (const zSpec of zones) {
      if (zSpec.kind === "plaza" || zSpec.kind === "village") continue;
      if (zSpec.kind === "garden") {
        roadSegments.push({
          ax: eastSouth.x,
          az: eastSouth.z,
          bx: zSpec.x,
          bz: zSpec.z,
          width: 1.30,
          curveAmp: 0.45,
          curvePhase: 0.3,
        });
      } else if (zSpec.kind === "outpost") {
        const ownerVillage = zSpec.commodoreId ? villages.find((v) => v.commodoreId === zSpec.commodoreId) : undefined;
        if (ownerVillage) {
          roadSegments.push({
            ax: ownerVillage.x,
            az: ownerVillage.z,
            bx: zSpec.x,
            bz: zSpec.z,
            width: 1.15,
            curveAmp: 0.35,
            curvePhase: 0.5,
          });
        } else {
          roadSegments.push({
            ax: 0,
            az: -1.2,
            bx: zSpec.x * 0.92,
            bz: zSpec.z * 0.92,
            width: 1.25,
            curveAmp: 0.55,
            curvePhase: -0.4,
          });
        }
      }
    }

    // 2. 지형 정점 높이 & 정점 컬러 페인팅 (지브리 수채화 초원 패치 + 마을 테라스 바닥 승격)
    const posAttr = terrainGeo.attributes["position"] as BufferAttribute;
    const cGrassRich = new Color(0x4eb956);
    const cGrassSun = new Color(0x76d95f);
    const cGrassGold = new Color(0x95da5e);
    const cGrassDeep = new Color(0x348f48);
    const cPath = new Color(0xdac49b);
    const cGravel = new Color(0xcfc6b4);
    const cCobble = new Color(0xc7ccd4);
    const cCourtyard = new Color(0xd6dee8);
    const cSakuraFloor = new Color(0xe8d5dd);
    const cCitadelFloor = new Color(0xcfd9e6);
    const cAutumnFloor = new Color(0xe8cfa8);
    const cSnowFloor = new Color(0xeaf4fc);
    const cSnowRim = new Color(0xd6e8f8);
    const cBank = new Color(0xe2cda2);
    const cMountain = new Color(0x568d7a);
    const tmpCol = new Color();
    const villageThemes: readonly EffectiveVillageTheme[] = villages.map((v) => resolveEffectiveVillageTheme(v));

    for (let i = 0; i < posAttr.count; i += 1) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const vy = getTerrainBaseHeight(vx, vz);
      posAttr.setY(i, vy);

      const patch = Math.sin(vx * 0.12 + Math.cos(vz * 0.10) * 1.6) * 0.5 + 0.5;
      const sunHill = smoothstep(0.56, 1.05, vy);
      tmpCol.copy(cGrassRich).lerp(cGrassSun, patch * 0.62);
      tmpCol.lerp(cGrassGold, sunHill * 0.34 * patch);
      const shadePatch = Math.cos((vx - vz) * 0.075 + Math.sin(vx * 0.04) * 1.4) * 0.5 + 0.5;
      tmpCol.lerp(cGrassDeep, shadePatch * 0.34);

      // 오솔길 & 광장 석재 바닥 블렌딩 (시냇물 수로 외부에서는 저지대 절단 없이 100% 연속 유지)
      const roadInfo = minRoadDistance(vx, vz);
      if (roadInfo.dist < roadInfo.halfWidth + 1.05 && !isInBrookChannel(vx, vz, 0.25)) {
        const rw = 1 - smoothstep(roadInfo.halfWidth * 0.62, roadInfo.halfWidth + 1.05, roadInfo.dist);
        const isPlazaCore = Math.hypot(vx, vz + 1.6) < 4.5;
        tmpCol.lerp(isPlazaCore ? cCobble : cPath, rw * 0.88);
      }

      // 사령관별 마을 테라스 바닥 승격 (실효 테마 + 종합 발전도 연동)
      if (!isInBrookChannel(vx, vz, 0.2)) {
        for (let vi = 0; vi < villages.length; vi += 1) {
          const v = villages[vi]!;
          const theme = villageThemes[vi]!;
          const dv = Math.hypot(vx - v.x, vz - v.z);
          if (theme === "snow") {
            const outerR = v.radius + 2.6;
            if (dv < outerR) {
              const coreW = 1 - smoothstep(v.radius - 0.6, v.radius + 1.1, dv);
              const rimW = 1 - smoothstep(v.radius - 0.2, outerR, dv);
              tmpCol.lerp(cSnowRim, rimW * 0.72);
              tmpCol.lerp(cSnowFloor, coreW * 0.86);
              break;
            }
          } else if (dv < v.radius + 0.85) {
            const vw = 1 - smoothstep(v.radius - 0.8, v.radius + 0.85, dv);
            const floorColor =
              theme === "citadel" ? cCitadelFloor
                : theme === "sakura" ? cSakuraFloor
                  : theme === "autumn" ? cAutumnFloor
                    : v.overallTier >= 4 ? cCourtyard
                      : v.overallTier === 3 ? cCobble
                        : v.overallTier === 2 ? cGravel
                          : cPath;
            const strength =
              theme === "citadel" ? 0.88
                : theme === "autumn" ? 0.84
                  : theme === "sakura" ? 0.80
                    : v.overallTier >= 4 ? 0.88 : v.overallTier === 3 ? 0.80 : v.overallTier === 2 ? 0.72 : 0.62;
            tmpCol.lerp(floorColor, vw * strength);
            break;
          }
        }
      }

      // 시냇물 수로 주변 강변 블렌딩
      if (Math.abs(vx) < BROOK_SPAN_HALF_X + 2) {
        const bp = brookProfile(vx);
        if (Math.abs(vz - bp.centerZ) < bp.halfWidth + 2.2 && vy < 0.26) {
          const bw = 1 - smoothstep(-0.18, 0.26, vy);
          tmpCol.lerp(cBank, bw * 0.88);
        }
      }

      // 원경 산맥 안개빛 녹청색 블렌딩 (r > 90m)
      const rDist = Math.hypot(vx, vz);
      if (rDist > WORLD_PLAY_RADIUS + 2) {
        const mw = smoothstep(WORLD_PLAY_RADIUS + 2, 172, rDist);
        tmpCol.lerp(cMountain, mw * 0.65);
      }

      terrainColorAttr.setXYZ(i, tmpCol.r, tmpCol.g, tmpCol.b);
    }
    posAttr.needsUpdate = true;
    terrainColorAttr.needsUpdate = true;
    terrainGeo.computeVertexNormals();

    // 2b. 끊김 없는 연속 곡선 오솔길 리본 메쉬 (단일 병합 BufferGeometry, 1 draw call)
    const roadRibbonMesh = buildRoadRibbonMesh(roadSegments);
    if (roadRibbonMesh) {
      dynamicWorldGroup.add(roadRibbonMesh);
    }

    // 3. InstancedBucketBuilder로 모든 정적 건물·마을·구역·자연물 배칭
    const bucketBuilder = createInstancedBucketBuilder();

    buildGrandGuildHall(bucketBuilder, dynamicWorldGroup);
    buildPlazaCommons(bucketBuilder, dynamicWorldGroup);
    buildBrookBridgesAndFlora(bucketBuilder);
    buildFishingSpotMarkers(bucketBuilder, dynamicWorldGroup);

    for (const v of villages) {
      buildVillage(bucketBuilder, dynamicWorldGroup, v);
    }
    for (const zSpec of zones) {
      if (zSpec.kind === "village" || zSpec.kind === "plaza") continue;
      buildZoneStructures(bucketBuilder, dynamicWorldGroup, zSpec);
    }

    // 4. 광장 및 초원 외곽 풍경림 · 울타리 · 길가 가로등 · 갈림길 이정표 · 초원 쉼터 배치
    addHangingStreetlamp(bucketBuilder, -2.9, -3.5, 0.4, true);
    addHangingStreetlamp(bucketBuilder, 3.5, -4.4, -0.4, true);
    addHangingStreetlamp(bucketBuilder, 5.4, 5.6, -0.8, true);

    // 4a-1. 34~60m 장거리 마을 간 오솔길 양옆 길가 가로등 + 낮은 시골 울타리 + 정문 앞 디딤돌 (0 추가 draw call)
    for (let si = 0; si < roadSegments.length; si += 1) {
      const seg = roadSegments[si]!;
      if (!seg.isMainRoad) continue;
      const segLen = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      if (segLen < 18) continue;
      const stops: readonly number[] = segLen >= 38 ? [0.27, 0.53, 0.77] : [0.35, 0.67];
      for (let k = 0; k < stops.length; k += 1) {
        const pt = sampleRoadPoint(seg, stops[k]!);
        const side = (si + k) % 2 === 0 ? 1 : -1;
        const offset = seg.width + 1.15;
        const lx = pt.x + pt.perpX * offset * side;
        const lz = pt.z + pt.perpZ * offset * side;
        const ly = getTerrainBaseHeight(lx, lz);
        if (ly < 0.16 || isInBrookChannel(lx, lz, 1.4)) continue;
        if (Math.hypot(lx, lz) < 9.5 || Math.hypot(lx, lz) > WORLD_PLAY_RADIUS - 3.5) continue;
        if (zones.some((z) => z.kind !== "plaza" && Math.hypot(lx - z.x, lz - z.z) < z.radius + 2.0)) continue;
        if (villages.some((v) => Math.hypot(lx - v.x, lz - v.z) < v.radius + 2.2)) continue;
        if (streetlampAnchors.some((a) => Math.hypot(lx - a.x, lz - a.z) < 9.2)) continue;
        const armYaw = Math.atan2(-pt.perpX * side, -pt.perpZ * side);
        addHangingStreetlamp(bucketBuilder, lx, lz, armYaw, true);
      }

      // 긴 오솔길 중간 굽이에 소박한 목장 울타리(4기둥) + 반대편 디딤돌 포인트 배치
      if (segLen >= 24) {
        const midT = 0.44 + (si % 3) * 0.08;
        const fSide = si % 2 === 0 ? -1 : 1;
        const fSpanT = Math.min(0.14, 3.6 / segLen);
        const pA = sampleRoadPoint(seg, Math.max(0.15, midT - fSpanT));
        const pB = sampleRoadPoint(seg, Math.min(0.85, midT + fSpanT));
        const fOff = seg.width + 1.55;
        const fax = pA.x + pA.perpX * fOff * fSide;
        const faz = pA.z + pA.perpZ * fOff * fSide;
        const fbx = pB.x + pB.perpX * fOff * fSide;
        const fbz = pB.z + pB.perpZ * fOff * fSide;
        const fmx = (fax + fbx) * 0.5;
        const fmz = (faz + fbz) * 0.5;
        const fenceClear =
          !isInBrookChannel(fax, faz, 1.6)
          && !isInBrookChannel(fbx, fbz, 1.6)
          && !isInBrookChannel(fmx, fmz, 1.6)
          && Math.hypot(fmx, fmz) > 11.5
          && Math.hypot(fmx, fmz) < WORLD_PLAY_RADIUS - 4.0
          && !zones.some((z) => z.kind !== "plaza" && Math.hypot(fmx - z.x, fmz - z.z) < z.radius + 3.2)
          && !villages.some((v) => Math.hypot(fmx - v.x, fmz - v.z) < v.radius + 3.5);
        if (fenceClear) {
          addFenceRun(bucketBuilder, fax, faz, fbx, fbz, 4);
        }

        // 길 위 3개 조약돌 디딤돌 악센트 (시골길 디테일)
        const sPt = sampleRoadPoint(seg, 0.88);
        if (!isInBrookChannel(sPt.x, sPt.z, 1.5)) {
          for (let ds = -1; ds <= 1; ds += 1) {
            const sx = sPt.x + sPt.dirX * ds * 1.05 + sPt.perpX * (ds % 2 === 0 ? 0.22 : -0.20);
            const sz = sPt.z + sPt.dirZ * ds * 1.05 + sPt.perpZ * (ds % 2 === 0 ? 0.22 : -0.20);
            const sy = getTerrainBaseHeight(sx, sz);
            if (sy >= 0.16) {
              bucketBuilder.addCylinder(
                ds === 0 ? matStone : matStoneDark,
                [sx, sy + 0.055, sz],
                [0.64, 0.036, 0.54],
                [0, hash2(sx, sz) * Math.PI, 0],
                { receiveShadow: true },
              );
            }
          }
        }
      }
    }

    // 4a-2. 주요 갈림길 나무 방향 이정표 (0 추가 draw call)
    const crossroadSigns: readonly [number, number, number][] = [
      [2.2, -12.6, 0.18],
      [-12.8, -11.5, -0.52],
      [eastSouth.x + 2.4, eastSouth.z + 2.6, 2.85],
      [westSouth.x - 2.4, westSouth.z + 2.4, -2.75],
      [0.8, -26.0, 0.08],
      [-28.0, -5.5, -1.15],
      [28.5, -6.0, 1.15],
    ];
    for (const [sx, sz, syaw] of crossroadSigns) {
      const sy = getTerrainBaseHeight(sx, sz);
      if (sy < 0.18 || isInBrookChannel(sx, sz, 1.6)) continue;
      if (zones.some((z) => z.kind !== "plaza" && Math.hypot(sx - z.x, sz - z.z) < z.radius + 2.0)) continue;
      if (villages.some((v) => Math.hypot(sx - v.x, sz - v.z) < v.radius + 2.4)) continue;
      const rd = minRoadDistance(sx, sz);
      if (rd.dist < rd.halfWidth + 0.65) continue;
      addWoodenSignpost(bucketBuilder, dynamicWorldGroup, sx, sz, syaw, false);
    }

    // 나무·덤불 겹침 방지 트래커 + 들꽃 군락 앵커 풀
    const placedTrees: { readonly x: number; readonly z: number }[] = [];
    const gladeFlowerAnchors: { readonly x: number; readonly z: number; readonly count: number; readonly minR: number; readonly spread: number }[] = [];
    const tryAddMeadowTree = (
      tx: number,
      tz: number,
      sc: number,
      kind: "oak" | "pine" | "blossom",
      minRoadClear = 1.85,
      minTreeSpacing = 2.65,
    ): boolean => {
      const rCenter = Math.hypot(tx, tz);
      if (rCenter < 10.5 || rCenter > WORLD_PLAY_RADIUS - 1.5) return false;
      if (isInBrookChannel(tx, tz, 1.85)) return false;
      const gy = getTerrainBaseHeight(tx, tz);
      if (gy < 0.16) return false;
      if (zones.some((z) => z.kind !== "plaza" && Math.hypot(tx - z.x, tz - z.z) < z.radius + 2.5)) return false;
      if (villages.some((v) => Math.hypot(tx - v.x, tz - v.z) < v.radius + 2.7)) return false;
      // 모든 사령관 마을 정문·착지 후방 카메라 시야 회랑 내 수목 배치 차단
      if (isInVillageEntranceSightCorridor(tx, tz)) return false;
      const rd = minRoadDistance(tx, tz);
      if (rd.dist < rd.halfWidth + minRoadClear) return false;
      if (placedTrees.some((p) => Math.hypot(tx - p.x, tz - p.z) < minTreeSpacing)) return false;
      addTree(bucketBuilder, dynamicWorldGroup, tx, tz, sc, kind, true);
      placedTrees.push({ x: tx, z: tz });
      return true;
    };

    // 4a-3. 외곽 초원 전원 풍차 언덕 2곳 (windmill.glb + 나무 울타리 + 들꽃밭 + 그늘나무)
    const hillWindmillCandidates: readonly [number, number, number][] = [
      [-45.0, -56.0, 0.55],
      [48.0, 26.5, -2.15],
      [-52.0, 28.0, 2.25],
      [46.0, -56.0, -0.55],
    ];
    let placedHillWindmills = 0;
    const hasCustomWindmillModel = assetRegistry.hasCustomModel("windmill");
    for (const [wx, wz, wyaw] of hillWindmillCandidates) {
      if (placedHillWindmills >= 2) break;
      if (isInBrookChannel(wx, wz, 5.0)) continue;
      if (zones.some((z) => z.kind !== "plaza" && Math.hypot(wx - z.x, wz - z.z) < z.radius + 5.2)) continue;
      if (villages.some((v) => Math.hypot(wx - v.x, wz - v.z) < v.radius + 5.8)) continue;
      const rd = minRoadDistance(wx, wz);
      if (rd.dist < rd.halfWidth + 4.0) continue;
      const wgy = getTerrainBaseHeight(wx, wz);
      if (wgy < 0.20) continue;

      if (hasCustomWindmillModel) {
        const hillMill = new Group();
        hillMill.position.set(wx, wgy, wz);
        hillMill.rotation.y = wyaw;
        assetRegistry.mountSlot({
          slot: "windmill",
          container: hillMill,
          targetHeight: 5.85,
          mountFallback: () => {},
          onMounted: (inst) => {
            if (inst.bladePivot) customBladePivots.push(inst.bladePivot);
          },
        });
        dynamicWorldGroup.add(hillMill);
      } else {
        bucketBuilder.withFrame(wx, wgy, wz, wyaw, 0.92, () => {
          bucketBuilder.addCylinder(matStone, [0, 0.47, 0], [2.65, 0.95, 2.65], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          bucketBuilder.addCylinder(matPlasterWarm, [0, 2.42, 0], [2.20, 3.05, 2.20], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          bucketBuilder.addCone(matRoofBase, [0, 4.55, 0], [2.16, 1.28, 2.16], undefined, { color: TONE_ROOF_HEX.amber, castShadow: true });
          bucketBuilder.addSphere(matBrass, [0, 5.24, 0], [0.24, 0.24, 0.24]);
        });
      }
      addContactShadow(bucketBuilder, wx, wz, 2.1, 2.1);
      addGrassClearZone(wx, wz, 2.5);
      addCameraOccluder(wx, wz, 1.65, 6.0);
      colliders.push({ x: wx, z: wz, r: 1.55 });
      // 풍차 주변 전원 목장 울타리 + 벤치 + 화단 + 소나무/벚나무
      const cY = Math.cos(wyaw);
      const sY = Math.sin(wyaw);
      addFenceRun(bucketBuilder, wx - cY * 3.8 - sY * 2.4, wz + sY * 3.8 - cY * 2.4, wx + cY * 3.8 - sY * 2.4, wz - sY * 3.8 - cY * 2.4, 5);
      addWoodenBench(bucketBuilder, wx + sY * 2.8, wz + cY * 2.8, wyaw);
      if (assetRegistry.hasCustomModel("flowerbed")) {
        const fbX = wx + cY * 2.6 + sY * 1.4;
        const fbZ = wz - sY * 2.6 + cY * 1.4;
        queueInstancedSlot("flowerbed", { x: fbX, y: getTerrainBaseHeight(fbX, fbZ), z: fbZ, rotationY: wyaw, scale: 1.05 });
        addGrassClearZone(fbX, fbZ, 1.2);
      }
      tryAddMeadowTree(wx - cY * 4.4, wz + sY * 4.4, 1.26, placedHillWindmills === 0 ? "blossom" : "oak", 1.8, 2.6);
      tryAddMeadowTree(wx + cY * 4.6 - sY * 1.6, wz - sY * 4.6 - cY * 1.6, 1.32, "pine", 1.8, 2.6);
      gladeFlowerAnchors.push({ x: wx, z: wz, count: 28, minR: 2.8, spread: 4.5 });
      placedHillWindmills += 1;
    }

    // 4a-4. 마을 사이 넓은 공터 우물 쉼터 & 피크닉 정원 7곳 (well.glb + 벤치 + 화단 + 가로등 + 벚나무/참나무)
    const meadowGlades: readonly [number, number, "oak" | "blossom", number, boolean][] = [
      [-19.5, -14.8, "blossom", 0.55, true],
      [20.2, -15.4, "oak", -0.60, false],
      [21.5, 25.5, "blossom", -2.35, true],
      [-21.5, 24.8, "oak", 2.35, false],
      [-45.0, -24.5, "blossom", 0.85, false],
      [46.0, -24.5, "oak", -0.85, true],
      [0.0, -24.0, "blossom", 0.0, false],
      [-14.5, 48.0, "blossom", 2.65, false],
      [15.5, 49.0, "oak", -2.65, false],
    ];
    const hasCustomWell = assetRegistry.hasCustomModel("well");
    let placedGlades = 0;
    for (const [gx, gz, treeKind, faceYaw, withWell] of meadowGlades) {
      if (placedGlades >= 7) break;
      const gy = getTerrainBaseHeight(gx, gz);
      if (gy < 0.20 || isInBrookChannel(gx, gz, 3.6)) continue;
      if (zones.some((z) => z.kind !== "plaza" && Math.hypot(gx - z.x, gz - z.z) < z.radius + 3.8)) continue;
      if (villages.some((v) => Math.hypot(gx - v.x, gz - v.z) < v.radius + 4.2)) continue;
      const rd = minRoadDistance(gx, gz);
      if (rd.dist < rd.halfWidth + 3.0) continue;

      if (withWell) {
        if (hasCustomWell) {
          const wellGrp = new Group();
          wellGrp.position.set(gx, gy, gz);
          wellGrp.rotation.y = faceYaw;
          assetRegistry.mountSlot({ slot: "well", container: wellGrp, targetHeight: 2.35, mountFallback: () => {} });
          dynamicWorldGroup.add(wellGrp);
        } else {
          bucketBuilder.withFrame(gx, gy, gz, faceYaw, 0.92, () => {
            bucketBuilder.addCylinder(matStoneDark, [0, 0.09, 0], [1.80, 0.18, 1.80], undefined, { tapered: true, receiveShadow: true });
            bucketBuilder.addCylinder(matStone, [0, 0.44, 0], [1.46, 0.68, 1.46], undefined, { castShadow: true, receiveShadow: true });
            bucketBuilder.addCylinder(matWaterTile, [0, 0.66, 0], [1.16, 0.05, 1.16]);
            bucketBuilder.addPitchedRoof(matRoofBase, matPlaster, matTimber, {
              y: 1.72,
              width: 1.58,
              height: 0.60,
              depth: 1.20,
              roofColor: TONE_ROOF_HEX.cerulean,
              includeGableWall: false,
              castShadow: true,
            });
          });
        }
        addContactShadow(bucketBuilder, gx, gz, 1.30, 1.30);
        addGrassClearZone(gx, gz, 1.55);
        colliders.push({ x: gx, z: gz, r: 0.96 });
        tryAddMeadowTree(gx - Math.cos(faceYaw) * 2.8, gz + Math.sin(faceYaw) * 2.8, 1.18, treeKind, 1.6, 2.5);
        addWoodenBench(bucketBuilder, gx + Math.sin(faceYaw) * 2.2, gz + Math.cos(faceYaw) * 2.2, faceYaw);
        addHangingStreetlamp(bucketBuilder, gx + Math.cos(faceYaw) * 2.3, gz - Math.sin(faceYaw) * 2.3, faceYaw - 1.2, true);
      } else {
        tryAddMeadowTree(gx, gz, 1.20, treeKind, 1.6, 2.5);
        addWoodenBench(bucketBuilder, gx + Math.sin(faceYaw) * 1.95, gz + Math.cos(faceYaw) * 1.95, faceYaw);
        addBushAndRockCluster(bucketBuilder, gx - Math.cos(faceYaw) * 2.05, gz + Math.sin(faceYaw) * 2.05, 0.96);
        if (placedGlades % 2 === 0) {
          addHangingStreetlamp(bucketBuilder, gx - Math.sin(faceYaw) * 2.2, gz - Math.cos(faceYaw) * 2.2, faceYaw + Math.PI, true);
        }
      }

      const bedX = gx + Math.cos(faceYaw) * 2.15;
      const bedZ = gz - Math.sin(faceYaw) * 2.15;
      const bedY = getTerrainBaseHeight(bedX, bedZ);
      if (bedY >= 0.16 && !withWell) {
        if (assetRegistry.hasCustomModel("flowerbed")) {
          queueInstancedSlot("flowerbed", { x: bedX, y: bedY, z: bedZ, rotationY: faceYaw + 0.4, scale: 0.98 });
          addContactShadow(bucketBuilder, bedX, bedZ, 0.90, 0.90);
          addGrassClearZone(bedX, bedZ, 1.15);
        } else {
          addBushAndRockCluster(bucketBuilder, bedX, bedZ, 0.95);
        }
      }
      gladeFlowerAnchors.push({ x: gx, z: gz, count: 22, minR: 2.3, spread: 3.4 });
      placedGlades += 1;
    }

    // 4a-5. 강변 벚꽃·참나무 산책 풍경 (|x| <= 80m 시냇물 양안)
    const riversideTreeSpots: readonly [number, number, "blossom" | "oak" | "pine"][] = [
      [-76, -1, "pine"], [-68, 1, "blossom"], [-58, -1, "blossom"], [-49, 1, "oak"],
      [-40, -1, "blossom"], [-33, 1, "oak"], [-24, -1, "blossom"], [-18, 1, "blossom"],
      [-5, 1, "blossom"], [14, 1, "blossom"], [22, -1, "oak"], [30, 1, "blossom"],
      [39, -1, "blossom"], [48, 1, "oak"], [57, -1, "blossom"], [66, 1, "pine"],
      [75, -1, "blossom"], [80, 1, "oak"],
    ];
    for (const [rx, bankSide, kind] of riversideTreeSpots) {
      if (BRIDGES.some((br) => Math.abs(rx - br.x) < 4.5)) continue;
      const bp = brookProfile(rx);
      const tx = rx + (hash2(rx, bankSide) - 0.5) * 1.4;
      const tz = bp.centerZ + bankSide * (bp.halfWidth + 2.4 + hash2(bankSide, rx) * 1.6);
      const sc = 1.04 + hash2(tx, tz) * 0.34;
      if (tryAddMeadowTree(tx, tz, sc, kind, 1.7, 2.6)) {
        // 강변 나무 옆 작은 덤불/들꽃 포인트
        const bx = tx + (hash2(tz, tx) - 0.5) * 2.2;
        const bz = tz + bankSide * 1.25;
        if (!isInBrookChannel(bx, bz, 1.2) && minRoadDistance(bx, bz).dist > 2.4) {
          addBushAndRockCluster(bucketBuilder, bx, bz, 0.88 + hash2(bx, bz) * 0.28);
        }
        gladeFlowerAnchors.push({ x: tx, z: tz, count: 10, minR: 1.5, spread: 2.2 });
      }
    }

    // 4a-6. 중앙 광장 근접 시그니처 풍경림 (기존 포인트 유지)
    const plazaTrees: readonly [number, number, number, "oak" | "pine" | "blossom"][] = [
      [-7.2, -5.8, 1.18, "oak"],
      [-8.6, 1.5, 1.05, "pine"],
      [-5.8, 6.4, 1.08, "blossom"],
      [8.6, -4.2, 1.12, "oak"],
      [11.2, 1.8, 0.98, "pine"],
      [-14.5, -24.5, 1.24, "pine"],
      [14.5, -24.5, 1.22, "oak"],
    ];
    for (const [tx, tz, sc, kind] of plazaTrees) {
      const overlapsZone = zones.some((z) => z.kind !== "plaza" && Math.hypot(tx - z.x, tz - z.z) < z.radius + 2.4);
      const overlapsVillage = villages.some((v) => Math.hypot(tx - v.x, tz - v.z) < v.radius + 2.6);
      const rd = minRoadDistance(tx, tz);
      if (overlapsZone || overlapsVillage || isInVillageEntranceSightCorridor(tx, tz) || rd.dist < rd.halfWidth + 1.55) continue;
      addTree(bucketBuilder, dynamicWorldGroup, tx, tz, sc, kind);
      placedTrees.push({ x: tx, z: tz });
    }

    // 4a-7. 88m 대초원 자연 다목 숲 군락 26개 (~145~175그루 GPU GLB 인스탄싱, 마을·도로·시냇물 자동 회피)
    const forestGroves: readonly {
      readonly x: number;
      readonly z: number;
      readonly radius: number;
      readonly count: number;
      readonly primary: "oak" | "pine" | "blossom";
      readonly secondary: "oak" | "pine" | "blossom";
    }[] = [
      // 중권역 마을 사이 숲 군락 (r = 28..58m)
      { x: -16.5, z: -38.0, radius: 6.5, count: 5, primary: "pine", secondary: "oak" },
      { x: 16.5, z: -38.5, radius: 6.5, count: 5, primary: "oak", secondary: "blossom" },
      { x: -46.0, z: -12.0, radius: 7.0, count: 5, primary: "pine", secondary: "oak" },
      { x: 46.5, z: -13.0, radius: 7.0, count: 5, primary: "oak", secondary: "pine" },
      { x: -44.0, z: 22.0, radius: 7.2, count: 5, primary: "pine", secondary: "blossom" },
      { x: 44.5, z: 22.5, radius: 7.2, count: 5, primary: "blossom", secondary: "oak" },
      { x: -16.0, z: 48.0, radius: 6.8, count: 5, primary: "blossom", secondary: "oak" },
      { x: 16.5, z: 48.5, radius: 6.8, count: 5, primary: "oak", secondary: "pine" },
      { x: -44.0, z: -38.0, radius: 6.8, count: 5, primary: "pine", secondary: "oak" },
      { x: 44.0, z: -38.0, radius: 6.8, count: 5, primary: "oak", secondary: "blossom" },
      { x: 0.0, z: -56.0, radius: 7.5, count: 6, primary: "pine", secondary: "oak" },
      // 외곽 산기슭 울창한 숲 띠 (r = 66..84m)
      { x: -76.0, z: -26.0, radius: 8.5, count: 6, primary: "pine", secondary: "oak" },
      { x: -79.0, z: -4.0, radius: 8.0, count: 6, primary: "oak", secondary: "pine" },
      { x: -75.0, z: 24.0, radius: 8.5, count: 6, primary: "pine", secondary: "oak" },
      { x: -64.0, z: 46.0, radius: 8.2, count: 6, primary: "blossom", secondary: "oak" },
      { x: -46.0, z: 64.0, radius: 8.5, count: 6, primary: "oak", secondary: "pine" },
      { x: -24.0, z: 76.0, radius: 8.2, count: 6, primary: "pine", secondary: "oak" },
      { x: 0.0, z: 79.0, radius: 8.0, count: 6, primary: "blossom", secondary: "oak" },
      { x: 25.0, z: 75.0, radius: 8.2, count: 6, primary: "oak", secondary: "pine" },
      { x: 48.0, z: 62.0, radius: 8.5, count: 6, primary: "pine", secondary: "blossom" },
      { x: 66.0, z: 44.0, radius: 8.2, count: 6, primary: "blossom", secondary: "oak" },
      { x: 77.0, z: 22.0, radius: 8.5, count: 6, primary: "oak", secondary: "pine" },
      { x: 79.0, z: -6.0, radius: 8.0, count: 6, primary: "pine", secondary: "oak" },
      { x: 75.0, z: -30.0, radius: 8.5, count: 6, primary: "oak", secondary: "pine" },
      { x: 66.0, z: -56.0, radius: 8.5, count: 6, primary: "pine", secondary: "oak" },
      { x: 42.0, z: -72.0, radius: 8.5, count: 6, primary: "oak", secondary: "blossom" },
      { x: 10.0, z: -80.0, radius: 8.2, count: 6, primary: "pine", secondary: "oak" },
      { x: -12.0, z: -80.0, radius: 8.2, count: 6, primary: "pine", secondary: "oak" },
      { x: -42.0, z: -72.0, radius: 8.5, count: 6, primary: "blossom", secondary: "pine" },
      { x: -67.0, z: -56.0, radius: 8.5, count: 6, primary: "pine", secondary: "oak" },
    ];
    for (let gi = 0; gi < forestGroves.length; gi += 1) {
      const g = forestGroves[gi]!;
      let planted = 0;
      for (let ti = 0; ti < g.count; ti += 1) {
        const ang = (ti / g.count) * Math.PI * 2 + hash2(g.x + ti * 3.1, g.z) * 0.9;
        const rad = ti === 0 ? hash2(g.x, g.z) * 1.4 : (0.38 + hash2(g.z + ti * 2.3, g.x) * 0.62) * g.radius;
        const tx = g.x + Math.cos(ang) * rad;
        const tz = g.z + Math.sin(ang) * rad;
        const sc = 1.02 + hash2(tx * 1.3, tz * 1.7) * 0.54;
        const kind = ti % 3 === 1 ? g.secondary : g.primary;
        if (tryAddMeadowTree(tx, tz, sc, kind, 1.9, 2.75)) {
          planted += 1;
        }
      }
      if (planted > 0) {
        forestAudioAnchors.push({ x: g.x, z: g.z });
        // 숲 아래 하층 덤불·이끼 바위 2~3기 + 들꽃 링
        const bushCount = Math.min(3, 1 + Math.floor(planted / 2));
        for (let bi = 0; bi < bushCount; bi += 1) {
          const bang = (bi / bushCount) * Math.PI * 2 + hash2(g.z, g.x + bi) * 1.4;
          const brad = 1.8 + hash2(g.x + bi, g.z) * (g.radius * 0.72);
          const bx = g.x + Math.cos(bang) * brad;
          const bz = g.z + Math.sin(bang) * brad;
          if (
            !isInBrookChannel(bx, bz, 1.5)
            && Math.hypot(bx, bz) < WORLD_PLAY_RADIUS - 2.0
            && !zones.some((z) => z.kind !== "plaza" && Math.hypot(bx - z.x, bz - z.z) < z.radius + 1.8)
            && !villages.some((v) => Math.hypot(bx - v.x, bz - v.z) < v.radius + 2.0)
            && minRoadDistance(bx, bz).dist > 2.4
          ) {
            addBushAndRockCluster(bucketBuilder, bx, bz, 0.88 + hash2(bx, bz) * 0.36);
          }
        }
        if (gi < 14) {
          gladeFlowerAnchors.push({ x: g.x, z: g.z, count: 14, minR: 2.0, spread: g.radius * 0.85 });
        }
      }
    }

    addFenceRun(bucketBuilder, -9.8, -8.8, -5.2, -9.4, 4);
    addFenceRun(bucketBuilder, 6.8, -8.6, 11.4, -7.2, 4);
    const scenicBushes: readonly [number, number, number][] = [
      [-5.6, -3.2, 1.0],
      [6.4, -2.4, 0.92],
      [-1.2, 6.2, 1.05],
      [-6.8, -7.8, 0.96],
      [7.4, -6.2, 0.94],
      [3.6, 5.4, 0.88],
      [-7.4, 5.2, 1.02],
      [11.4, 6.8, 0.98],
      [-14.6, 6.4, 0.96],
    ];
    for (const [bx, bz, bsc] of scenicBushes) {
      const overlapsZone = zones.some((z) => z.kind !== "plaza" && Math.hypot(bx - z.x, bz - z.z) < z.radius + 1.6);
      const overlapsVillage = villages.some((v) => Math.hypot(bx - v.x, bz - v.z) < v.radius + 1.8);
      const rd = minRoadDistance(bx, bz);
      if (overlapsZone || overlapsVillage || rd.dist < rd.halfWidth + 1.15) continue;
      addBushAndRockCluster(bucketBuilder, bx, bz, bsc);
    }

    // 중앙 길드 광장 장식 화단 4기 (flowerbed.glb)
    if (assetRegistry.hasCustomModel("flowerbed")) {
      const plazaFlowerbeds: readonly [number, number, number][] = [
        [-6.1, -5.0, 0.96],
        [7.8, -5.1, 0.94],
        [-4.8, 1.5, 0.92],
        [4.8, 3.6, 0.92],
      ];
      for (const [fx, fz, fsc] of plazaFlowerbeds) {
        const fy = getTerrainBaseHeight(fx, fz);
        if (fy < 0.05) continue;
        queueInstancedSlot("flowerbed", {
          x: fx,
          y: fy,
          z: fz,
          rotationY: hash2(fx, fz) * Math.PI * 2,
          scale: fsc,
        });
        addContactShadow(bucketBuilder, fx, fz, 0.92 * fsc, 0.92 * fsc);
        addGrassClearZone(fx, fz, 1.18 * fsc);
      }
    }

    dynamicWorldGroup.add(bucketBuilder.build("meadow-instanced-world"));

    // 4b. Blender `.glb` 인스탠싱 배치(나무·관목·목교·구역 건물 Tier 1~5) — 슬롯별 서브메시 InstancedMesh 1회 생성
    for (const [slot, transforms] of instancedSlotQueues) {
      assetRegistry.mountInstancedSlot({
        slot,
        container: dynamicWorldGroup,
        transforms,
        targetHeight: INSTANCED_SLOT_TARGET_HEIGHTS[slot],
        castShadow: true,
        receiveShadow: true,
      });
    }

    // 4c. 카메라 스프링-암 3D 레이캐스트용 4분면 경량 비가시 InstancedMesh 차폐 프록시 (0 draw call, Box3 브로드페이즈 최적화)
    if (cameraOccluders.length > 0) {
      const quadBuckets: [CameraOccluder[], CameraOccluder[], CameraOccluder[], CameraOccluder[]] = [[], [], [], []];
      for (let i = 0; i < cameraOccluders.length; i += 1) {
        const occ = cameraOccluders[i]!;
        const qIdx = (occ.x >= 0 ? 1 : 0) + (occ.z >= 0 ? 2 : 0);
        quadBuckets[qIdx]!.push(occ);
      }
      const occDummy = new Object3D();
      for (let qi = 0; qi < quadBuckets.length; qi += 1) {
        const list = quadBuckets[qi]!;
        if (list.length === 0) continue;
        const proxyInst = new InstancedMesh(districtHitGeo, matInvisibleHit, list.length);
        proxyInst.name = `camera-occluder-proxy-q${qi}`;
        proxyInst.userData["kind"] = "camera-occluder";
        for (let i = 0; i < list.length; i += 1) {
          const occ = list[i]!;
          const minY = occ.minY ?? 0;
          const gy = Math.max(0, getTerrainBaseHeight(occ.x, occ.z));
          const spanY = Math.max(0.25, occ.height - minY);
          occDummy.position.set(occ.x, gy + minY, occ.z);
          occDummy.rotation.set(0, 0, 0);
          occDummy.scale.set(occ.radius, spanY, occ.radius);
          occDummy.updateMatrix();
          proxyInst.setMatrixAt(i, occDummy.matrix);
        }
        proxyInst.instanceMatrix.needsUpdate = true;
        proxyInst.computeBoundingBox();
        proxyInst.computeBoundingSphere();
        dynamicWorldGroup.add(proxyInst);
        cameraOccluderObjects.push(proxyInst);
      }
    }

    // 동적 인스턴스 색상 초기화 (깃발 · 크리스탈 등대)
    const tmpInstColor = new Color();
    bannerInstanced.count = animatedBanners.length;
    for (let i = 0; i < animatedBanners.length; i += 1) {
      tmpInstColor.setHex(animatedBanners[i]!.colorHex);
      bannerInstanced.setColorAt(i, tmpInstColor);
    }
    if (bannerInstanced.instanceColor) bannerInstanced.instanceColor.needsUpdate = true;

    flameOuterInst.count = animatedFlames.length;
    flameCoreInst.count = animatedFlames.length;
    flameCoalInst.count = animatedFlames.length;
    flameEmberInst.count = animatedFlames.length * EMBERS_PER_FLAME;

    crystalInst.count = animatedCrystals.length;
    crystalRingInst.count = animatedCrystals.length;
    for (let i = 0; i < animatedCrystals.length; i += 1) {
      tmpInstColor.setHex(animatedCrystals[i]!.colorHex);
      crystalInst.setColorAt(i, tmpInstColor);
    }
    if (crystalInst.instanceColor) crystalInst.instanceColor.needsUpdate = true;

    routineRotorInst.count = animatedRoutineWindmills.length;

    // 하이라이트 링 높이 재동기화
    syncHoverVisualTarget(lastHoveredDistrict, lastSelectedDistrict);
    applyHighlightMesh(selectedHighlightMesh, selectedHighlightMat, lastSelectedDistrict);

    // 마을 바이옴별 국지 낙화·단풍·눈송이·민들레 파티클 자동 동기화
    syncVillageBiomeParticlesInternal(villages);

    // 5. 풀잎(InstancedMesh) & 들꽃(InstancedMesh) 배치 — 석재 광장·도로·수면·마을 석재/담장·건물 바닥 OBB 완전 제외
    const dummy = new Object3D();
    const grassColors = [
      new Color(0x52c258),
      new Color(0x6bd460),
      new Color(0x42aa4e),
      new Color(0x80dc67),
      new Color(0x5db954),
    ];
    let gCount = 0;
    for (let attempt = 0; attempt < MAX_GRASS * 2 && gCount < MAX_GRASS; attempt += 1) {
      const u1 = hash2(attempt * 1.13, 7.31);
      const u2 = hash2(attempt * 2.71, 19.4);
      const rad = Math.pow(u1, 0.56) * (WORLD_PLAY_RADIUS - 2.0);
      const ang = u2 * Math.PI * 2;
      const gx = Math.cos(ang) * rad;
      const gz = Math.sin(ang) * rad;
      const gy = getTerrainBaseHeight(gx, gz);
      if (gy < 0.14) continue;
      if (Math.hypot(gx, gz + 1.6) < 5.65) continue;
      const rd = minRoadDistance(gx, gz);
      if (rd.dist < rd.halfWidth + 0.45) continue;
      if (villages.some((v) => Math.hypot(gx - v.x, gz - v.z) < v.radius + 0.90)) continue;
      if (colliders.some((c) => Math.hypot(gx - c.x, gz - c.z) < c.r + 0.34)) continue;
      if (grassClearZones.some((z) => Math.hypot(gx - z.x, gz - z.z) < z.r + 0.14)) continue;
      if (isPointInGrassClearBoxes(gx, gz, 0.14)) continue;

      dummy.position.set(gx, gy - 0.02, gz);
      dummy.rotation.set(
        (hash2(gx, gz) - 0.5) * 0.24,
        hash2(gz, gx) * Math.PI * 2,
        (hash2(gx + 3, gz) - 0.5) * 0.24,
      );
      const sc = 0.86 + hash2(gx * 2, gz * 2) * 0.82;
      dummy.scale.set(sc, sc * (0.88 + hash2(attempt, 3.1) * 0.58), sc);
      dummy.updateMatrix();
      grassInstanced.setMatrixAt(gCount, dummy.matrix);
      grassInstanced.setColorAt(gCount, grassColors[attempt % grassColors.length]!);
      gCount += 1;
    }
    grassInstanced.count = gCount;
    grassInstanced.instanceMatrix.needsUpdate = true;
    if (grassInstanced.instanceColor) grassInstanced.instanceColor.needsUpdate = true;

    const flowerPalette = [
      new Color(0xfffbeb), // 데이지 크림
      new Color(0xfef08a), // 미나리아재비 골드
      new Color(0xf9a8d4), // 코스모스 핑크
      new Color(0x7dd3fc), // 물망초 하늘색
      new Color(0xfb7185), // 코랄 양귀비
      new Color(0xc4b5fd), // 들라벤더 연보라
    ];
    let fCount = 0;
    // 초원 쉼터·풍차 언덕·숲 군락·강변 주변에 화사한 들꽃 군락 우선 배치 (0 추가 draw call)
    for (let gi = 0; gi < gladeFlowerAnchors.length && fCount < MAX_FLOWERS; gi += 1) {
      const glade = gladeFlowerAnchors[gi]!;
      for (let k = 0; k < glade.count && fCount < MAX_FLOWERS; k += 1) {
        const ang = (k / glade.count) * Math.PI * 2 + hash2(glade.x + k, glade.z) * 0.55;
        const rad = glade.minR + hash2(glade.z + k * 1.7, glade.x) * glade.spread;
        const fx = glade.x + Math.cos(ang) * rad;
        const fz = glade.z + Math.sin(ang) * rad;
        const fy = getTerrainBaseHeight(fx, fz);
        if (fy < 0.18 || isInBrookChannel(fx, fz, 0.8)) continue;
        if (Math.hypot(fx, fz + 1.6) < 5.75) continue;
        const rd = minRoadDistance(fx, fz);
        if (rd.dist < rd.halfWidth + 0.58) continue;
        if (villages.some((v) => Math.hypot(fx - v.x, fz - v.z) < v.radius + 0.95)) continue;
        if (colliders.some((c) => Math.hypot(fx - c.x, fz - c.z) < c.r + 0.36)) continue;
        if (grassClearZones.some((z) => Math.hypot(fx - z.x, fz - z.z) < z.r + 0.18)) continue;
        if (isPointInGrassClearBoxes(fx, fz, 0.18)) continue;

        dummy.position.set(fx, fy - 0.02, fz);
        dummy.rotation.set(0, hash2(fx, fz) * Math.PI * 2, 0);
        const sc = 0.88 + hash2(fz, fx) * 0.62;
        dummy.scale.setScalar(sc);
        dummy.updateMatrix();
        flowerInstanced.setMatrixAt(fCount, dummy.matrix);
        flowerInstanced.setColorAt(fCount, flowerPalette[(gi * 3 + k) % flowerPalette.length]!);
        fCount += 1;
      }
    }
    for (let attempt = 0; attempt < MAX_FLOWERS * 3 && fCount < MAX_FLOWERS; attempt += 1) {
      const u1 = hash2(attempt * 3.17 + 50, 11.7);
      const u2 = hash2(attempt * 5.09 + 20, 29.3);
      const rad = 3.5 + Math.sqrt(u1) * (WORLD_PLAY_RADIUS - 5.5);
      const ang = u2 * Math.PI * 2;
      const fx = Math.cos(ang) * rad;
      const fz = Math.sin(ang) * rad;
      const fy = getTerrainBaseHeight(fx, fz);
      if (fy < 0.18) continue;
      if (Math.hypot(fx, fz + 1.6) < 5.75) continue;
      const rd = minRoadDistance(fx, fz);
      if (rd.dist < rd.halfWidth + 0.58) continue;
      if (villages.some((v) => Math.hypot(fx - v.x, fz - v.z) < v.radius + 0.95)) continue;
      if (colliders.some((c) => Math.hypot(fx - c.x, fz - c.z) < c.r + 0.38)) continue;
      if (grassClearZones.some((z) => Math.hypot(fx - z.x, fz - z.z) < z.r + 0.20)) continue;
      if (isPointInGrassClearBoxes(fx, fz, 0.20)) continue;

      dummy.position.set(fx, fy - 0.02, fz);
      dummy.rotation.set(0, hash2(fx, fz) * Math.PI * 2, 0);
      const sc = 0.78 + hash2(fz, fx) * 0.62;
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      flowerInstanced.setMatrixAt(fCount, dummy.matrix);
      flowerInstanced.setColorAt(fCount, flowerPalette[attempt % flowerPalette.length]!);
      fCount += 1;
    }
    flowerInstanced.count = fCount;
    flowerInstanced.instanceMatrix.needsUpdate = true;
    if (flowerInstanced.instanceColor) flowerInstanced.instanceColor.needsUpdate = true;
  }

  function classifyWorkStepFx(step: string): LiveWorkshopFxKind {
    const lower = step.toLowerCase();
    if (lower.includes("edit") || lower.includes("write") || lower.includes("run") || lower.includes("bash") || lower.includes("build")) {
      return "spark";
    }
    if (lower.includes("think") || lower.includes("read") || lower.includes("search") || lower.includes("fetch") || lower.includes("delegate")) {
      return "pulse";
    }
    return "smoke";
  }

  function districtRoofHeight(tier: number): number {
    switch (tier) {
      case 0: return 1.1;
      case 1: return 1.6;
      case 2: return 2.5;
      case 3: return 3.4;
      case 4: return 4.2;
      default: return 5.2;
    }
  }

  /**
   * 실시간 작업·질문·경보 상태를 전체 지형/건물 리빌드 없이 경량 비콘/에미터 버퍼에만 반영한다.
   */
  const statusColorScratch = new Color();
  function syncLiveVillageStates(villages: readonly WorldVillageSpec[]): void {
    const nextEmitters: LiveWorkshopEmitter[] = [];
    const nextBeacons: AnimatedStatusBeacon[] = [];
    const nextHoloTables: typeof activeHoloTables = [];
    const nextChimneySmokes: typeof activeChimneySmokes = [];
    workingVillageIds.clear();

    const pushBeacon = (
      x: number,
      y: number,
      groundY: number,
      z: number,
      ringRadius: number,
      colorHex: number,
      pulseSpeed: number,
    ) => {
      if (nextBeacons.length >= MAX_STATUS_BEACONS) return;
      nextBeacons.push({
        x,
        y,
        groundY,
        z,
        ringRadius,
        colorHex,
        pulseSpeed,
        phase: x * 0.19 + z * 0.23,
      });
    };

    const pushHoloAndSmoke = (
      yardX: number,
      yardZ: number,
      roofX: number,
      roofY: number,
      roofZ: number,
      colorHex: number,
    ) => {
      if (nextHoloTables.length < MAX_HOLO_TABLES) {
        const ygy = Math.max(0.08, getTerrainBaseHeight(yardX, yardZ));
        nextHoloTables.push({
          x: yardX,
          y: ygy,
          z: yardZ,
          colorHex,
          phase: yardX * 0.31 + yardZ * 0.27,
        });
      }
      if (nextChimneySmokes.length < MAX_HOLO_TABLES) {
        nextChimneySmokes.push({
          x: roofX,
          y: roofY,
          z: roofZ,
          phase: roofX * 0.23 + roofZ * 0.19,
        });
      }
    };

    for (const v of villages) {
      const gy = Math.max(0.1, getTerrainBaseHeight(v.x, v.z));
      const isVillageWorking = Boolean(v.workStep) || v.activeObjectiveCount > 0;
      if (isVillageWorking) {
        workingVillageIds.add(v.id);
      }

      if (v.hasError) {
        nextEmitters.push({ x: v.x, y: gy + 2.8, z: v.z, kind: "alert" });
        pushBeacon(v.x, gy + 3.05, gy, v.z, 2.35, 0xf43f5e, 5.2);
      } else if (v.needsAttention || v.openAsksCount > 0) {
        nextEmitters.push({ x: v.x, y: gy + 2.6, z: v.z, kind: "ask" });
        pushBeacon(v.x, gy + 2.95, gy, v.z, 2.25, 0xfbbf24, 3.6);
      } else if (v.workStep) {
        pushBeacon(v.x, gy + 2.75, gy, v.z, 2.15, 0x38bdf8, 2.8);
      }

      let emittedOnDistrict = false;
      let addedDistrictHolo = false;
      for (const d of v.districts) {
        const dgy = Math.max(0.1, getTerrainBaseHeight(d.x, d.z));
        const roofY = dgy + districtRoofHeight(d.tier);
        if (d.hasError) {
          nextEmitters.push({ x: d.x, y: roofY, z: d.z, kind: "alert" });
          pushBeacon(d.x, roofY + 0.85, dgy, d.z, d.radius * 0.72, 0xf43f5e, 5.2);
          emittedOnDistrict = true;
        } else if (d.needsAttention) {
          nextEmitters.push({ x: d.x, y: roofY, z: d.z, kind: "ask" });
          pushBeacon(d.x, roofY + 0.80, dgy, d.z, d.radius * 0.70, 0xfbbf24, 3.6);
          emittedOnDistrict = true;
        } else if (d.activeWorkStep) {
          const kind = classifyWorkStepFx(d.activeWorkStep);
          nextEmitters.push({ x: d.x, y: roofY, z: d.z, kind });
          if (kind === "spark" && d.tier >= 2) {
            nextEmitters.push({ x: d.x + 0.35, y: roofY + 0.25, z: d.z - 0.35, kind: "smoke" });
          }
          emittedOnDistrict = true;
        }

        if (d.activeWorkStep || (d.linkedObjectiveIds.length > 0 && v.activeObjectiveCount > 0)) {
          // 구역 건물 정면 마당에 회전 홀로그램 작전 테이블 + 지붕 굴뚝 연기 활성화
          const frontDist = Math.max(1.35, d.radius * 0.58);
          const yardX = d.x + Math.sin(d.rotationY) * frontDist;
          const yardZ = d.z + Math.cos(d.rotationY) * frontDist;
          pushHoloAndSmoke(yardX, yardZ, d.x - 0.35, roofY + 0.18, d.z - 0.25, TONE_CRYSTAL_HEX[d.tone]);
          addedDistrictHolo = true;
        }
      }

      if (v.workStep && !emittedOnDistrict) {
        const kind = classifyWorkStepFx(v.workStep);
        nextEmitters.push({ x: v.x, y: gy + 2.2, z: v.z, kind });
      }
      if (isVillageWorking && !addedDistrictHolo) {
        // 활성 목표/작업이 있는 마을 중앙 마당에 홀로그램 작전 테이블 + 대표 건물 지붕 연기 표시
        const primaryD = v.districts[0];
        const roofX = primaryD ? primaryD.x - 0.3 : v.x;
        const roofZ = primaryD ? primaryD.z - 0.2 : v.z;
        const roofY = primaryD
          ? Math.max(0.1, getTerrainBaseHeight(primaryD.x, primaryD.z)) + districtRoofHeight(primaryD.tier) + 0.18
          : gy + 1.85;
        pushHoloAndSmoke(v.x, v.z, roofX, roofY, roofZ, TONE_CRYSTAL_HEX[v.tone]);
      }
    }

    liveWorkshopEmitters = nextEmitters;
    animatedStatusBeacons = nextBeacons;
    activeHoloTables = nextHoloTables;
    activeChimneySmokes = nextChimneySmokes;

    statusBeaconInst.count = nextBeacons.length;
    statusRingInst.count = nextBeacons.length;
    for (let i = 0; i < nextBeacons.length; i += 1) {
      statusColorScratch.setHex(nextBeacons[i]!.colorHex);
      statusBeaconInst.setColorAt(i, statusColorScratch);
      statusRingInst.setColorAt(i, statusColorScratch);
    }
    if (statusBeaconInst.instanceColor) statusBeaconInst.instanceColor.needsUpdate = true;
    if (statusRingInst.instanceColor) statusRingInst.instanceColor.needsUpdate = true;

    holoTableInst.count = nextHoloTables.length;
    holoRingInst.count = nextHoloTables.length;
    for (let i = 0; i < nextHoloTables.length; i += 1) {
      statusColorScratch.setHex(nextHoloTables[i]!.colorHex);
      holoRingInst.setColorAt(i, statusColorScratch);
    }
    if (holoRingInst.instanceColor) holoRingInst.instanceColor.needsUpdate = true;

    activeSmokeInst.count = nextChimneySmokes.length * SMOKE_PUFFS_PER_ROOF;
  }

  // rAF 제로 할당 스크래치 변수
  const animMat = new Matrix4();
  const animFinalMat = new Matrix4();
  const animPos = new Vector3();
  const animEuler = new Euler();
  const animQuat = new Quaternion();
  const animScale = new Vector3();
  const animSpinQuat = new Quaternion();
  const zAxisVec = new Vector3(0, 0, 1);
  const terrainDayTint = new Color(0xffffff);
  const terrainNightTint = new Color(0x88a4cc);

  scene.add(root);

  return {
    group: root,
    streetlampAnchors,
    syncZones(zones, villages = []) {
      const zoneSig = zones
        .filter((z) => z.kind !== "village")
        .map((z) => `${z.id}:${z.kind}:${z.x}:${z.z}:${z.roofTone}`)
        .join("|");
      const villageSig = villages
        .map(
          (v) =>
            `${v.id}:${v.label}:${v.x}:${v.z}:${v.radius}:${v.tone}:${v.biome}:${v.overallTier}:${v.routineCount > 0 ? 1 : 0}:${Math.min(5, v.completedObjectiveCount)}[`
            + v.districts.map((d) => `${d.id}:${d.tier}:${d.x}:${d.z}:${d.radius}`).join(",")
            + "]",
        )
        .join("|");
      const sig = `${zoneSig}||${villageSig}`;
      if (sig !== currentSignature) {
        currentSignature = sig;
        rebuildWorld(zones, villages);
      }
      // 작업/질문/경보 상태는 지형·건물 리빌드 없이 경량 비콘 & 에미터만 즉시 갱신한다.
      syncLiveVillageStates(villages);
    },
    setDistrictHighlight(hovered, selected) {
      lastHoveredDistrict = hovered;
      lastSelectedDistrict = selected;
      syncHoverVisualTarget(hovered, selected);
      applyHighlightMesh(selectedHighlightMesh, selectedHighlightMat, selected);
    },
    setHoveredDistrict(theaterIdOrDistrictId) {
      let found: WorldDistrictSpec | null = null;
      if (theaterIdOrDistrictId) {
        for (let vi = 0; vi < currentVillages.length && !found; vi += 1) {
          const ds = currentVillages[vi]!.districts;
          for (let di = 0; di < ds.length; di += 1) {
            const d = ds[di]!;
            if (d.theaterId === theaterIdOrDistrictId || d.id === theaterIdOrDistrictId) {
              found = d;
              break;
            }
          }
        }
      }
      lastHoveredDistrict = found;
      syncHoverVisualTarget(found, lastSelectedDistrict);
    },
    getDistrictHitGroup() {
      return districtHitGroup;
    },
    getDistrictHitTargets() {
      return districtHitTargets;
    },
    raycastDistrict(raycaster) {
      if (districtHitTargets.length === 0) return null;
      districtRaycastScratch.length = 0;
      raycaster.intersectObjects(districtHitTargets, false, districtRaycastScratch);
      if (districtRaycastScratch.length === 0) return null;
      const hitObj = districtRaycastScratch[0]!.object;
      return (hitObj.userData["district"] as WorldDistrictSpec | undefined) ?? null;
    },
    getCameraOccluderObjects() {
      return cameraOccluderObjects;
    },
    getFishingSpotAnchors() {
      return fishingSpotAnchors;
    },
    setQuestBoardAlert(urgentCount) {
      questBoardUrgentCount = Math.max(0, urgentCount);
      questAlertGroup.visible = questBoardUrgentCount > 0;
    },
    setDispatchFlags(flags) {
      const next: typeof activeDispatchFlags = [];
      const limit = Math.min(flags.length, MAX_DISPATCH_FLAGS);
      for (let i = 0; i < limit; i += 1) {
        const f = flags[i]!;
        next.push({
          x: f.x,
          z: f.z,
          groundY: Math.max(0.1, getTerrainBaseHeight(f.x, f.z)),
          colorHex: TONE_CRYSTAL_HEX[f.tone],
          phase: f.x * 0.29 + f.z * 0.37,
        });
      }
      activeDispatchFlags = next;
      dispatchPoleInst.count = next.length;
      dispatchPennantInst.count = next.length;
      dispatchHaloInst.count = next.length;
      for (let i = 0; i < next.length; i += 1) {
        statusColorScratch.setHex(next[i]!.colorHex);
        dispatchPennantInst.setColorAt(i, statusColorScratch);
        dispatchHaloInst.setColorAt(i, statusColorScratch);
      }
      if (dispatchPennantInst.instanceColor) dispatchPennantInst.instanceColor.needsUpdate = true;
      if (dispatchHaloInst.instanceColor) dispatchHaloInst.instanceColor.needsUpdate = true;
    },
    setWeather(mode) {
      currentWeather = mode;
    },
    setDistrictNotePins(pins) {
      const next: typeof activeNotePins = [];
      const limit = Math.min(pins.length, MAX_NOTE_PINS);
      for (let i = 0; i < limit; i += 1) {
        const p = pins[i]!;
        next.push({
          x: p.x,
          z: p.z,
          groundY: Math.max(0.1, getTerrainBaseHeight(p.x, p.z)),
          phase: p.x * 0.31 + p.z * 0.23,
        });
      }
      activeNotePins = next;
      notePinInst.count = next.length;
    },
    isOnBridge(x, z) {
      return getBridgeDeckHeight(x, z) !== null;
    },
    getSurfaceType(x, z) {
      if (getBridgeDeckHeight(x, z) !== null) return "wood";
      if (Math.abs(x) < BROOK_SPAN_HALF_X) {
        const bp = brookProfile(x);
        if (Math.abs(z - bp.centerZ) < bp.halfWidth + 0.25 && getTerrainBaseHeight(x, z) < 0.06) {
          return "water";
        }
      }
      if (Math.hypot(x, z + 1.6) < 4.8) return "stone";
      const rd = minRoadDistance(x, z);
      if (rd.dist < rd.halfWidth + 0.35) return "stone";
      for (const v of currentVillages) {
        const theme = resolveEffectiveVillageTheme(v);
        if (
          (v.overallTier >= 2 || theme !== "meadow")
          && Math.hypot(x - v.x, z - v.z) < v.radius
        ) {
          return "stone";
        }
      }
      return "grass";
    },
    getSurfaceMaterial(x, z) {
      if (getBridgeDeckHeight(x, z) !== null) return "wood";
      if (Math.hypot(x, z + 1.6) <= 6.2) return "stone";
      const rd = minRoadDistance(x, z);
      if (rd.dist < rd.halfWidth + 0.35) return "stone";
      for (let i = 0; i < currentVillages.length; i += 1) {
        const v = currentVillages[i]!;
        if (Math.hypot(x - v.x, z - v.z) <= v.radius) {
          return "stone";
        }
      }
      return "grass";
    },
    getCameraOccluders() {
      return cameraOccluders;
    },
    getLiveWorkshopEmitters() {
      return liveWorkshopEmitters;
    },
    getNearestBrookDist(x, z) {
      return distanceToBrookEdge(x, z);
    },
    getNearestForestDist(x, z) {
      if (forestAudioAnchors.length === 0) return 999;
      let minDist2 = Infinity;
      for (let i = 0; i < forestAudioAnchors.length; i += 1) {
        const a = forestAudioAnchors[i]!;
        const dx = x - a.x;
        const dz = z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < minDist2) minDist2 = d2;
      }
      return Math.max(0, Math.sqrt(minDist2) - 4.5);
    },
    ringParadeBell() {
      paradeBellRingRemaining = 2.25;
      paradeBellRingAge = 0;
    },
    setMailboxUnread(hasUnread) {
      mailboxHasUnread = hasUnread;
      mailboxUnreadGroup.visible = hasUnread;
    },
    syncPondFish(speciesIds) {
      const limit = Math.min(speciesIds.length, MAX_POND_FISH);
      activePondCount = limit;
      pondFishGroup.visible = limit > 0;
      for (let i = 0; i < pondSlots.length; i += 1) {
        const slot = pondSlots[i]!;
        if (i >= limit) {
          slot.root.visible = false;
          continue;
        }
        const speciesId = speciesIds[i]!;
        const vis = POND_SPECIES_VISUALS[speciesId] ?? POND_SPECIES_VISUALS["meadow_minnow"]!;
        slot.kind = vis.kind;
        slot.isRainbow = speciesId === "rainbow_carp";
        slot.root.visible = true;
        slot.root.scale.setScalar(vis.scale);
        slot.fishWrap.visible = vis.kind === "fish";
        slot.jellyWrap.visible = vis.kind === "jelly";
        slot.shellWrap.visible = vis.kind === "shell";
        slot.bottleWrap.visible = vis.kind === "bottle";
        if (vis.kind === "fish") {
          slot.fishMat.color.setHex(vis.hex);
          slot.fishMat.emissive.setHex(vis.hex).multiplyScalar(0.28);
          slot.finMat.color.setHex(vis.finHex);
        }
      }
    },
    syncVillageBiomeParticles(villages) {
      syncVillageBiomeParticlesInternal(villages);
    },
    getGroundHeight,
    isWalkable,
    resolveMovement,
    update(dt, elapsed, nightFactor, sunDir) {
      windTimeUniform.value = elapsed;
      meadowNightUniform.value = nightFactor;
      terrainMat.color.copy(terrainDayTint).lerp(terrainNightTint, nightFactor * 0.72);
      horizonCanopyMat.color.copy(horizonCanopyDayTint).lerp(horizonCanopyNightTint, nightFactor * 0.78);
      horizonTrunkMat.color.copy(horizonTrunkDayTint).lerp(horizonTrunkNightTint, nightFactor * 0.78);
      contactShadowMat.opacity = 0.86 - nightFactor * 0.30;
      windmillBlades.rotation.z = -elapsed * 0.95;
      for (const pivot of customBladePivots) {
        pivot.rotation.z = -elapsed * 0.95;
      }
      assetRegistry.update(dt);
      assetRegistry.setNightFactor(nightFactor);

      // 구역 호버 부드러운 페이드 인/아웃 링 & 은은한 수직 아우라 + 선택 링 셰이더 갱신 (0-GC)
      const hoverActive = Boolean(
        lastHoveredDistrict && (!lastSelectedDistrict || lastHoveredDistrict.id !== lastSelectedDistrict.id),
      );
      const hoverTargetAlpha = hoverActive ? 1 : 0;
      hoverFadeAlpha += (hoverTargetAlpha - hoverFadeAlpha) * Math.min(1, dt * 9.5);
      if (hoverFadeAlpha < 0.008 && !hoverActive) {
        hoverFadeAlpha = 0;
      }
      if (hoverFadeAlpha > 0.01 && hoverDisplayedDistrict) {
        const pulse = 1.0 + Math.sin(elapsed * 3.6) * 0.032;
        const r = hoverDisplayedDistrict.radius;
        hoverHighlightMesh.visible = true;
        hoverHighlightMesh.scale.setScalar(r * (1.00 + 0.12 * hoverFadeAlpha) * pulse);
        hoverHighlightMat.uniforms["uTime"]!.value = elapsed;
        hoverAuraMesh.visible = true;
        hoverAuraMesh.scale.set(
          r * (0.94 + 0.08 * hoverFadeAlpha) * pulse,
          0.65 + 0.42 * hoverFadeAlpha,
          r * (0.94 + 0.08 * hoverFadeAlpha) * pulse,
        );
        hoverAuraMat.opacity = hoverFadeAlpha * (0.18 + Math.sin(elapsed * 3.4) * 0.045);
      } else {
        hoverHighlightMesh.visible = false;
        hoverAuraMesh.visible = false;
        hoverAuraMat.opacity = 0;
        if (!hoverActive) hoverDisplayedDistrict = null;
      }
      if (selectedHighlightMesh.visible) {
        selectedHighlightMat.uniforms["uTime"]!.value = elapsed;
      }

      // 모닥불 이중 셰이더 화염 + 숨 쉬는 숯불 디스크 + 상승 불티(ember)
      if (animatedFlames.length > 0) {
        matFlameOuter.uniforms["uTime"]!.value = elapsed;
        matFlameOuter.uniforms["uNight"]!.value = nightFactor;
        matFlameCore.uniforms["uTime"]!.value = elapsed;
        matFlameCore.uniforms["uNight"]!.value = nightFactor;
        matFlameCoal.uniforms["uTime"]!.value = elapsed;
        matFlameCoal.uniforms["uNight"]!.value = nightFactor;

        let emberIdx = 0;
        for (let i = 0; i < animatedFlames.length; i += 1) {
          const fl = animatedFlames[i]!;
          const f1 = (0.94 + Math.sin(elapsed * 9.5 + fl.phase) * 0.10) * fl.scale;
          const f2 = (0.96 + Math.cos(elapsed * 12.8 + fl.phase) * 0.10) * fl.scale;
          animPos.set(fl.x, fl.y - 0.04, fl.z);
          animQuat.identity();
          animScale.set(fl.scale, f1, fl.scale);
          animMat.compose(animPos, animQuat, animScale);
          flameOuterInst.setMatrixAt(i, animMat);

          animPos.set(fl.x, fl.y - 0.02, fl.z);
          animScale.set(fl.scale, f2, fl.scale);
          animMat.compose(animPos, animQuat, animScale);
          flameCoreInst.setMatrixAt(i, animMat);

          animPos.set(fl.x, fl.y - 0.075, fl.z);
          animScale.set(fl.scale, 1, fl.scale);
          animMat.compose(animPos, animQuat, animScale);
          flameCoalInst.setMatrixAt(i, animMat);

          // 모닥불당 4개 상승 불티(ember) 나선형 부유
          for (let e = 0; e < EMBERS_PER_FLAME; e += 1) {
            const seed = fl.phase * 1.7 + e * 1.618;
            const life = ((elapsed * (0.48 + (e % 2) * 0.14) + seed * 0.37) % 1 + 1) % 1;
            const spiralAng = elapsed * 2.6 + seed * 3.0 + life * 4.2;
            const rad = (0.10 + life * 0.28) * fl.scale;
            const ex = fl.x + Math.cos(spiralAng) * rad;
            const ez = fl.z + Math.sin(spiralAng) * rad;
            const ey = fl.y + (0.14 + life * 1.75) * fl.scale;
            const fade = Math.sin(life * Math.PI) * (0.75 + nightFactor * 0.45);
            animPos.set(ex, ey, ez);
            animScale.setScalar(Math.max(0.01, fade * fl.scale));
            animMat.compose(animPos, animQuat, animScale);
            flameEmberInst.setMatrixAt(emberIdx, animMat);
            emberIdx += 1;
          }
        }
        flameOuterInst.instanceMatrix.needsUpdate = true;
        flameCoreInst.instanceMatrix.needsUpdate = true;
        flameCoalInst.instanceMatrix.needsUpdate = true;
        flameEmberInst.instanceMatrix.needsUpdate = true;
      }

      // 깃발 바람 물결 (InstancedMesh)
      if (animatedBanners.length > 0) {
        for (let i = 0; i < animatedBanners.length; i += 1) {
          const bm = animatedBanners[i]!;
          animPos.set(bm.x, bm.y, bm.z);
          animEuler.set(0, bm.baseRotY + Math.sin(elapsed * 3.4 + bm.phase) * 0.22, 0);
          animQuat.setFromEuler(animEuler);
          animScale.set(bm.width, bm.height, 1);
          animMat.compose(animPos, animQuat, animScale);
          bannerInstanced.setMatrixAt(i, animMat);
        }
        bannerInstanced.instanceMatrix.needsUpdate = true;
      }

      // Tier 5 크리스탈 등대 회전 · 부유 애니메이션 (InstancedMesh)
      if (animatedCrystals.length > 0) {
        matCrystal.emissiveIntensity = 0.72 + nightFactor * 1.45;
        for (let i = 0; i < animatedCrystals.length; i += 1) {
          const cr = animatedCrystals[i]!;
          const bob = Math.sin(elapsed * 2.1 + cr.phase) * 0.16;
          animPos.set(cr.x, cr.y + bob, cr.z);
          animEuler.set(0.18 * Math.sin(elapsed * 1.4 + cr.phase), elapsed * 1.35 + cr.phase, 0);
          animQuat.setFromEuler(animEuler);
          animScale.set(cr.scale * 0.85, cr.scale * 1.45, cr.scale * 0.85);
          animMat.compose(animPos, animQuat, animScale);
          crystalInst.setMatrixAt(i, animMat);

          animEuler.set(0.32 * Math.cos(elapsed * 1.1 + cr.phase), -elapsed * 0.9 + cr.phase, 0.26);
          animQuat.setFromEuler(animEuler);
          animScale.setScalar(cr.scale * 1.55);
          animMat.compose(animPos, animQuat, animScale);
          crystalRingInst.setMatrixAt(i, animMat);
        }
        crystalInst.instanceMatrix.needsUpdate = true;
        crystalRingInst.instanceMatrix.needsUpdate = true;
      }

      // 루틴 미니 풍차 날개 회전 (InstancedMesh 1 draw call, 작업 중이면 가속)
      if (animatedRoutineWindmills.length > 0) {
        animScale.set(1, 1, 1);
        for (let i = 0; i < animatedRoutineWindmills.length; i += 1) {
          const wm = animatedRoutineWindmills[i]!;
          const speed = workingVillageIds.has(wm.villageId) ? 2.4 : 1.15;
          animPos.set(wm.x, wm.y, wm.z);
          animEuler.set(0, wm.faceYaw, 0);
          animQuat.setFromEuler(animEuler);
          animSpinQuat.setFromAxisAngle(zAxisVec, -elapsed * speed + wm.phase);
          animQuat.multiply(animSpinQuat);
          animMat.compose(animPos, animQuat, animScale);
          routineRotorInst.setMatrixAt(i, animMat);
        }
        routineRotorInst.instanceMatrix.needsUpdate = true;
      }

      // 실시간 작업·질문·경보 상태 비콘 & 지면 펄스 링 (InstancedMesh 2 draw calls)
      if (animatedStatusBeacons.length > 0) {
        for (let i = 0; i < animatedStatusBeacons.length; i += 1) {
          const bc = animatedStatusBeacons[i]!;
          const wave = Math.sin(elapsed * bc.pulseSpeed + bc.phase);
          const bob = wave * 0.16;
          const bScale = 0.42 + (wave * 0.5 + 0.5) * 0.16;
          animPos.set(bc.x, bc.y + bob, bc.z);
          animEuler.set(0, elapsed * 1.9 + bc.phase, 0);
          animQuat.setFromEuler(animEuler);
          animScale.set(bScale, bScale * 1.55, bScale);
          animMat.compose(animPos, animQuat, animScale);
          statusBeaconInst.setMatrixAt(i, animMat);

          const ringWave = ((elapsed * 0.65 + bc.phase * 0.3) % 1);
          const rScale = bc.ringRadius * (0.75 + ringWave * 0.52);
          animPos.set(bc.x, bc.groundY + 0.09, bc.z);
          animQuat.identity();
          animScale.set(rScale, 0.25, rScale);
          animMat.compose(animPos, animQuat, animScale);
          statusRingInst.setMatrixAt(i, animMat);
        }
        statusBeaconInst.instanceMatrix.needsUpdate = true;
        statusRingInst.instanceMatrix.needsUpdate = true;
      }

      // 홀로그램 RTS 작전 깃발 부유 · 펄럭임 · 파동 링 애니메이션 (InstancedMesh 3 draw calls)
      if (activeDispatchFlags.length > 0) {
        matDispatchPennant.emissiveIntensity = 0.72 + nightFactor * 1.15;
        for (let i = 0; i < activeDispatchFlags.length; i += 1) {
          const fl = activeDispatchFlags[i]!;
          const bob = Math.sin(elapsed * 2.8 + fl.phase) * 0.16;
          const baseY = fl.groundY + 3.85 + bob;
          animPos.set(fl.x, baseY, fl.z);
          animQuat.identity();
          animScale.set(1, 1, 1);
          animMat.compose(animPos, animQuat, animScale);
          dispatchPoleInst.setMatrixAt(i, animMat);

          animPos.set(fl.x, baseY + 2.26, fl.z);
          animEuler.set(0, elapsed * 0.55 + Math.sin(elapsed * 4.4 + fl.phase) * 0.28, 0);
          animQuat.setFromEuler(animEuler);
          animScale.set(1, 1, 1);
          animMat.compose(animPos, animQuat, animScale);
          dispatchPennantInst.setMatrixAt(i, animMat);

          const haloWave = (elapsed * 0.75 + fl.phase * 0.2) % 1;
          const haloScale = 1.15 + haloWave * 1.05;
          animPos.set(fl.x, fl.groundY + 0.14, fl.z);
          animQuat.identity();
          animScale.set(haloScale, 0.35, haloScale);
          animMat.compose(animPos, animQuat, animScale);
          dispatchHaloInst.setMatrixAt(i, animMat);
        }
        dispatchPoleInst.instanceMatrix.needsUpdate = true;
        dispatchPennantInst.instanceMatrix.needsUpdate = true;
        dispatchHaloInst.instanceMatrix.needsUpdate = true;
      }

      // 제독 메모 핀 부유 · 회전 애니메이션 (InstancedMesh 1 draw call)
      if (activeNotePins.length > 0) {
        matNotePin.emissiveIntensity = 0.85 + nightFactor * 1.15;
        for (let i = 0; i < activeNotePins.length; i += 1) {
          const pin = activeNotePins[i]!;
          const bob = Math.sin(elapsed * 2.4 + pin.phase) * 0.14;
          animPos.set(pin.x + 0.65, pin.groundY + 3.45 + bob, pin.z + 0.55);
          animEuler.set(0.14 * Math.sin(elapsed * 1.6 + pin.phase), elapsed * 1.4 + pin.phase, 0.08);
          animQuat.setFromEuler(animEuler);
          animScale.set(1, 1, 1);
          animMat.compose(animPos, animQuat, animScale);
          notePinInst.setMatrixAt(i, animMat);
        }
        notePinInst.instanceMatrix.needsUpdate = true;
      }

      // 활성 작업 구역 회전 홀로그램 작전 테이블 & 도면 링 (2 draw calls, 비활성 시 0)
      if (activeHoloTables.length > 0) {
        matHoloRing.uniforms["uTime"]!.value = elapsed;
        matHoloRing.uniforms["uNight"]!.value = nightFactor;
        for (let i = 0; i < activeHoloTables.length; i += 1) {
          const ht = activeHoloTables[i]!;
          animPos.set(ht.x, ht.y, ht.z);
          animQuat.identity();
          animScale.set(1, 1, 1);
          animMat.compose(animPos, animQuat, animScale);
          holoTableInst.setMatrixAt(i, animMat);

          const bob = Math.sin(elapsed * 2.2 + ht.phase) * 0.06;
          animPos.set(ht.x, ht.y + 0.72 + bob, ht.z);
          animEuler.set(0, elapsed * 0.75 + ht.phase, 0);
          animQuat.setFromEuler(animEuler);
          animScale.set(1, 1, 1);
          animMat.compose(animPos, animQuat, animScale);
          holoRingInst.setMatrixAt(i, animMat);
        }
        holoTableInst.instanceMatrix.needsUpdate = true;
        holoRingInst.instanceMatrix.needsUpdate = true;
      }

      // 활성 작업 구역 지붕 굴뚝 연기 입자 (단일 InstancedMesh 1 draw call, 비활성 시 0)
      if (activeChimneySmokes.length > 0) {
        animQuat.identity();
        let smokeIdx = 0;
        for (let i = 0; i < activeChimneySmokes.length; i += 1) {
          const cs = activeChimneySmokes[i]!;
          for (let p = 0; p < SMOKE_PUFFS_PER_ROOF; p += 1) {
            const life = ((elapsed * 0.30 + cs.phase * 0.37 + p / SMOKE_PUFFS_PER_ROOF) % 1 + 1) % 1;
            const driftX = life * 0.58 + Math.sin(elapsed * 1.5 + cs.phase + p * 1.7) * 0.10;
            const driftZ = -life * 0.24 + Math.cos(elapsed * 1.2 + cs.phase + p) * 0.08;
            const sy = cs.y + life * 2.15;
            const envelope = Math.sin(life * Math.PI);
            const sc = (0.38 + life * 1.05) * envelope;
            animPos.set(cs.x + driftX, sy, cs.z + driftZ);
            animScale.setScalar(Math.max(0.01, sc));
            animMat.compose(animPos, animQuat, animScale);
            activeSmokeInst.setMatrixAt(smokeIdx, animMat);
            smokeIdx += 1;
          }
        }
        activeSmokeInst.instanceMatrix.needsUpdate = true;
      }

      // 살아있는 생태계 1: 파스텔 나비 16마리 (비/눈/야간 자동 숨김)
      const butterfliesVisible =
        currentWeather !== "rain" && currentWeather !== "snow" && nightFactor <= 0.45 && butterflyLayers.length > 0;
      ecosystemButterflyGroup.visible = butterfliesVisible;
      if (butterfliesVisible) {
        for (let i = 0; i < butterflySeeds.length; i += 1) {
          const b = butterflySeeds[i]!;
          const t = elapsed * b.speed + b.phase;
          const bx = b.anchorX + Math.sin(t) * b.radiusX;
          const bz = b.anchorZ + Math.sin(t * 2.0 + 0.4) * b.radiusZ * 0.55;
          const vx = Math.cos(t) * b.radiusX * b.speed;
          const vz = Math.cos(t * 2.0 + 0.4) * b.radiusZ * 1.1 * b.speed;
          const groundY = Math.max(0.2, getTerrainBaseHeight(bx, bz));
          const by = groundY + b.baseAlt + Math.sin(elapsed * 2.8 + b.phase) * 0.24;
          const yaw = Math.atan2(vx, vz);
          const flap = Math.abs(Math.sin(elapsed * b.flapSpeed + b.phase));
          const roll = Math.sin(elapsed * b.flapSpeed + b.phase) * 0.18;

          animPos.set(bx, by, bz);
          animEuler.set(0.12 * Math.sin(t * 1.7), yaw, roll);
          animQuat.setFromEuler(animEuler);
          animScale.set(b.scale * (0.46 + 0.54 * flap), b.scale, b.scale);
          animMat.compose(animPos, animQuat, animScale);

          for (let l = 0; l < butterflyLayers.length; l += 1) {
            const layer = butterflyLayers[l]!;
            animFinalMat.multiplyMatrices(animMat, layer.baseLocalMat);
            layer.mesh.setMatrixAt(i, animFinalMat);
          }
        }
        for (let l = 0; l < butterflyLayers.length; l += 1) {
          butterflyLayers[l]!.mesh.instanceMatrix.needsUpdate = true;
        }
      }

      // 살아있는 생태계 2: 시냇물 비단잉어 10마리 (수면 아래 우아한 유영)
      if (koiLayers.length > 0) {
        for (let i = 0; i < koiSeeds.length; i += 1) {
          const k = koiSeeds[i]!;
          const t = elapsed * k.speed + k.phase;
          const kx = k.centerX + Math.sin(t) * k.spanX;
          const dx = Math.cos(t) * k.spanX * k.speed;
          const bp = brookProfile(kx);
          const bpNext = brookProfile(kx + (dx >= 0 ? 0.15 : -0.15));
          const kz = bp.centerZ + k.lateral * bp.halfWidth * 0.56 + Math.sin(t * 2.3) * 0.16;
          const dz = (bpNext.centerZ - bp.centerZ) * (dx >= 0 ? 6.6 : -6.6) * Math.abs(dx);
          const swimWiggle = Math.sin(elapsed * 7.2 + k.phase * 1.9);
          const yaw = Math.atan2(dx, dz) + swimWiggle * 0.14;

          animPos.set(kx, -0.22 + Math.sin(elapsed * 1.8 + k.phase) * 0.02, kz);
          animEuler.set(0, yaw, swimWiggle * 0.06);
          animQuat.setFromEuler(animEuler);
          animScale.set(k.scale * (1.0 + swimWiggle * 0.05), k.scale, k.scale);
          animMat.compose(animPos, animQuat, animScale);

          for (let l = 0; l < koiLayers.length; l += 1) {
            const layer = koiLayers[l]!;
            animFinalMat.multiplyMatrices(animMat, layer.baseLocalMat);
            layer.mesh.setMatrixAt(i, animFinalMat);
          }
        }
        for (let l = 0; l < koiLayers.length; l += 1) {
          koiLayers[l]!.mesh.instanceMatrix.needsUpdate = true;
        }
      }

      // 중앙 퀘스트 게시판 긴급 알림 크리스탈/링 부유 애니메이션
      if (questAlertGroup.visible) {
        const bob = Math.sin(elapsed * 3.4) * 0.14;
        const pulse = 0.88 + Math.sin(elapsed * 4.8) * 0.16;
        questAlertGroup.position.set(WORLD_NOTICE_BOARD_POS.x, questBoardBaseY + 3.08 + bob, WORLD_NOTICE_BOARD_POS.z);
        questAlertCrystal.rotation.y = elapsed * 2.1;
        questAlertRing.scale.set(0.95 * pulse, 0.45, 0.95 * pulse);
        matQuestAlertCrystal.emissiveIntensity = 1.25 + nightFactor * 0.95 + Math.sin(elapsed * 4.8) * 0.25;
      }

      // 중앙 광장 「함대 소집 종 (Parade Bell)」 타종 진자 애니메이션 (2.25초 자연 감쇠)
      if (paradeBellRingRemaining > 0) {
        paradeBellRingAge += dt;
        paradeBellRingRemaining = Math.max(0, paradeBellRingRemaining - dt);
        const decay = Math.exp(-paradeBellRingAge * 1.25) * Math.min(1, paradeBellRingRemaining / 0.35);
        paradeBellSwingPivot.rotation.z = Math.sin(paradeBellRingAge * 13.5) * 0.54 * decay;
        matBronzeBell.emissiveIntensity = 0.24 + nightFactor * 0.40 + decay * 0.65;
      } else if (paradeBellSwingPivot.rotation.z !== 0) {
        paradeBellSwingPivot.rotation.z = 0;
        matBronzeBell.emissiveIntensity = 0.24 + nightFactor * 0.40;
      } else {
        matBronzeBell.emissiveIntensity = 0.24 + nightFactor * 0.40;
      }

      // 중앙 광장 「함대 우체통」 깃발 회전 + 미확인 황금 편지/스파클 부유
      const targetFlagAngle = mailboxHasUnread
        ? 0.08 + Math.sin(elapsed * 4.2) * 0.14
        : Math.PI * 0.46;
      mailboxFlagAngle += (targetFlagAngle - mailboxFlagAngle) * Math.min(1, dt * 8.5);
      mailboxFlagPivot.rotation.x = mailboxFlagAngle;
      matMailboxFlag.emissiveIntensity = mailboxHasUnread ? 0.45 + nightFactor * 0.40 : 0.12;
      if (mailboxUnreadGroup.visible) {
        const envBob = Math.sin(elapsed * 3.1) * 0.11;
        mailboxEnvelopeWrap.position.set(0, 1.88 + envBob, 0);
        mailboxEnvelopeWrap.rotation.set(0.12 * Math.sin(elapsed * 2.2), elapsed * 1.45, 0.08 * Math.cos(elapsed * 1.9));
        matMailboxEnvelope.emissiveIntensity = 0.55 + nightFactor * 0.65 + Math.sin(elapsed * 4.2) * 0.18;
        for (let i = 0; i < mailboxSparks.length; i += 1) {
          const sp = mailboxSparks[i]!;
          const ang = elapsed * 2.4 + (i / mailboxSparks.length) * Math.PI * 2;
          const rad = 0.28 + Math.sin(elapsed * 3.0 + i * 1.7) * 0.05;
          sp.position.set(Math.cos(ang) * rad, 1.86 + Math.sin(elapsed * 3.6 + i * 2.1) * 0.14, Math.sin(ang) * rad);
          const sc = 0.72 + Math.sin(elapsed * 5.2 + i * 2.0) * 0.28;
          sp.scale.setScalar(sc);
        }
      }

      // 중앙 광장 「별빛 연못」 방생 물고기·해파리·별조개·유리병 8자/유기적 유영 (0-GC)
      if (activePondCount > 0) {
        const pondCx = STARLIGHT_POND_POS.x;
        const pondCz = STARLIGHT_POND_POS.z;
        for (let i = 0; i < activePondCount; i += 1) {
          const slot = pondSlots[i]!;
          const t = elapsed * slot.speed + slot.phase;
          const ox = Math.sin(t) * slot.radiusX;
          const oz = Math.sin(t * 2.0 + 0.35) * slot.radiusZ * 0.68;
          const vx = Math.cos(t) * slot.radiusX * slot.speed;
          const vz = Math.cos(t * 2.0 + 0.35) * slot.radiusZ * 1.36 * slot.speed;
          const yaw = Math.atan2(vx, vz);

          if (slot.kind === "fish") {
            const wiggle = Math.sin(elapsed * 11.5 + slot.phase * 2.3);
            slot.root.position.set(pondCx + ox, pondWaterSurfaceY + slot.depthOffset + Math.sin(elapsed * 2.4 + slot.phase) * 0.014, pondCz + oz);
            slot.root.rotation.set(0, yaw + wiggle * 0.09, wiggle * 0.06);
            slot.fishTailPivot.rotation.y = wiggle * 0.44;
            if (slot.isRainbow) {
              pondRainbowColorScratch.setHSL((elapsed * 0.18 + i * 0.13) % 1, 0.78, 0.62);
              slot.fishMat.color.copy(pondRainbowColorScratch);
              slot.fishMat.emissive.copy(pondRainbowColorScratch).multiplyScalar(0.36);
            }
          } else if (slot.kind === "jelly") {
            const jx = Math.cos(t * 0.65) * 0.74;
            const jz = Math.sin(t * 0.65) * 0.68;
            const pulse = 1.0 + Math.sin(elapsed * 4.2 + slot.phase) * 0.12;
            slot.root.position.set(pondCx + jx, pondWaterSurfaceY + 0.02 + Math.sin(elapsed * 2.1 + slot.phase) * 0.04, pondCz + jz);
            slot.root.rotation.set(0, elapsed * 0.6 + slot.phase, 0);
            slot.jellyWrap.scale.set(pulse, 1 / Math.sqrt(pulse), pulse);
          } else if (slot.kind === "shell") {
            const sx = Math.cos(slot.phase * 1.9) * 0.86;
            const sz = Math.sin(slot.phase * 1.9) * 0.78;
            slot.root.position.set(pondCx + sx, pondWaterSurfaceY - 0.045, pondCz + sz);
            slot.root.rotation.set(0, slot.phase + Math.sin(elapsed * 1.2 + slot.phase) * 0.18, 0);
          } else {
            const bx = Math.sin(t * 0.45) * 0.64;
            const bz = Math.cos(t * 0.38) * 0.56;
            slot.root.position.set(pondCx + bx, pondWaterSurfaceY + 0.02 + Math.sin(elapsed * 3.1 + slot.phase) * 0.018, pondCz + bz);
            slot.root.rotation.set(Math.sin(elapsed * 2.2) * 0.12, elapsed * 0.45 + slot.phase, Math.cos(elapsed * 1.9) * 0.10);
          }
        }
        for (let i = 0; i < pondRippleMeshes.length; i += 1) {
          const rm = pondRippleMeshes[i]!;
          const rT = (elapsed * 0.34 + i * 0.5) % 1;
          const sc = 0.85 + rT * 4.4;
          rm.position.set(pondCx + (i === 0 ? -0.25 : 0.32), pondWaterSurfaceY + 0.015, pondCz + (i === 0 ? 0.18 : -0.22));
          rm.scale.set(sc, 1, sc);
        }
        pondRippleMat.opacity = 0.24 + nightFactor * 0.18;
      }

      // 살아있는 생태계 3: 시냇물 오리 가족 (어미 + 노란 아기 오리 3마리 일렬 왕복 헤엄, 0-GC)
      const duckT = elapsed * 0.135;
      const duckLeadX = -1.5 + Math.sin(duckT) * 7.2;
      const duckVelSign = Math.cos(duckT) >= 0 ? 1 : -1;
      for (let i = 0; i < duckActors.length; i += 1) {
        const d = duckActors[i]!;
        const dxPos = duckLeadX - duckVelSign * d.lagDist;
        const clampedX = Math.max(-10.5, Math.min(7.2, dxPos));
        const bp = brookProfile(clampedX);
        const bpAhead = brookProfile(clampedX + duckVelSign * 0.25);
        const lateralWiggle = Math.sin(elapsed * 1.45 + d.bobPhase) * 0.16;
        const dzPos = bp.centerZ + lateralWiggle;
        const dzDelta = (bpAhead.centerZ - bp.centerZ);
        const heading = Math.atan2(duckVelSign * 0.25, dzDelta);
        const bobY = -0.05 + Math.sin(elapsed * 4.8 + d.bobPhase) * 0.024;
        d.group.position.set(clampedX, bobY, dzPos);
        d.group.rotation.set(
          Math.sin(elapsed * 4.2 + d.bobPhase) * 0.05,
          heading,
          Math.cos(elapsed * 3.6 + d.bobPhase) * 0.06,
        );
        d.headPivot.rotation.x = Math.sin(elapsed * 3.2 + d.bobPhase) * 0.12;
        const wakeT = (elapsed * 0.72 + i * 0.27) % 1;
        const wakeSc = 0.62 + wakeT * 1.35;
        d.wakeMesh.scale.set(wakeSc, 1, wakeSc);
      }

      // 살아있는 생태계 4: 하늘 지브리 하얀 철새 떼 8마리 (유기적 리사주/S곡선 선회 + 날갯짓, 0-GC)
      for (let i = 0; i < skyBirds.length; i += 1) {
        const b = skyBirds[i]!;
        const bt = elapsed - b.timeLag;
        const bx = Math.sin(bt * 0.105) * 46 + Math.cos(bt * 0.068) * 18;
        const bz = Math.sin(bt * 0.082 + 1.15) * 42 + Math.cos(bt * 0.128) * 14;
        const by = 27.5 + Math.sin(bt * 0.18 + 0.6) * 4.4 + b.offsetY;
        const vx = Math.cos(bt * 0.105) * 46 * 0.105 - Math.sin(bt * 0.068) * 18 * 0.068;
        const vz = Math.cos(bt * 0.082 + 1.15) * 42 * 0.082 - Math.sin(bt * 0.128) * 14 * 0.128;
        const vLen = Math.max(0.001, Math.hypot(vx, vz));
        const perpX = -vz / vLen;
        const perpZ = vx / vLen;
        const yaw = Math.atan2(vx, vz);
        const glideCycle = Math.sin(elapsed * 0.55 + b.flapPhase);
        const flapAmp = glideCycle > -0.25 ? 0.54 : 0.12;
        const flapAng = Math.sin(elapsed * b.flapSpeed + b.flapPhase) * flapAmp + 0.08;
        b.group.position.set(bx + perpX * b.offsetLat, by, bz + perpZ * b.offsetLat);
        b.group.rotation.set(
          -Math.cos(bt * 0.18 + 0.6) * 0.08,
          yaw,
          Math.sin(bt * 0.105) * 0.16,
        );
        b.wingL.rotation.z = -flapAng;
        b.wingR.rotation.z = flapAng;
      }

      // 살아있는 생태계 5: 바이옴별 국지 낙화·단풍·눈송이·민들레 단일 InstancedMesh (1 draw call, 0-GC)
      if (activeBiomeParticleCount > 0) {
        for (let i = 0; i < activeBiomeParticleCount; i += 1) {
          const p = biomeParticleSlots[i]!;
          const rawLife = (elapsed * p.fallSpeed + p.phase) % 1;
          const life = rawLife < 0 ? rawLife + 1 : rawLife;
          const baseRad = p.villageRadius * p.radFrac;
          const swirl = elapsed * (p.kind === "snow" ? 0.26 : 0.42) + p.phase * 6.283;
          const px = p.villageX + Math.cos(p.angle) * baseRad + Math.sin(swirl) * p.swayAmp;
          const pz = p.villageZ + Math.sin(p.angle) * baseRad + Math.cos(swirl * 0.85) * p.swayAmp;
          const py = p.kind === "meadow"
            ? 0.55 + life * 5.2 + Math.sin(elapsed * 1.9 + p.phase * 8) * 0.35
            : 0.25 + (1 - life) * 7.2;
          const envelope = Math.sin(life * Math.PI);
          const sc = p.scale * Math.max(0.01, envelope) * (p.kind === "autumn" ? 1.22 : p.kind === "snow" ? 0.78 : 1.0);

          animPos.set(px, py, pz);
          if (p.kind === "snow" || p.kind === "meadow") {
            animEuler.set(elapsed * 0.8 + p.phase * 5, elapsed * 1.1 + p.phase * 4, 0);
          } else {
            animEuler.set(
              elapsed * 2.2 + p.phase * 6.0,
              elapsed * 1.6 + p.phase * 4.5,
              Math.sin(elapsed * 3.1 + p.phase * 7.0) * 0.9,
            );
          }
          animQuat.setFromEuler(animEuler);
          animScale.set(sc, sc * (p.kind === "snow" ? 1.0 : 0.85), sc);
          animMat.compose(animPos, animQuat, animScale);
          biomeParticleInst.setMatrixAt(i, animMat);
        }
        biomeParticleInst.instanceMatrix.needsUpdate = true;
      }

      // 굴뚝 연기 뭉게 피어오름
      for (const sp of smokePuffs) {
        const life = (elapsed * 0.28 + sp.phase) % 1;
        sp.mesh.position.set(
          sp.baseX + life * 0.65 + Math.sin(elapsed * 1.6 + sp.phase * 6) * 0.08,
          sp.baseY + life * 2.35,
          sp.baseZ - life * 0.25,
        );
        const s = 0.55 + life * 1.25;
        sp.mesh.scale.setScalar(s);
      }

      matWindow.emissiveIntensity = 0.12 + nightFactor * 1.45;
      matLanternGlass.emissiveIntensity = 0.18 + nightFactor * 1.85;

      // 바람 방향(+X, +0.32Z)으로 각자 다른 속도로 유유히 흘러가는 15개 비대칭 지브리 뭉게구름 (0-GC, 1 draw call)
      animQuat.identity();
      let cloudPuffIdx = 0;
      for (let ci = 0; ci < driftingClouds.length; ci += 1) {
        const cl = driftingClouds[ci]!;
        const rawAlong = cl.startAlong + elapsed * cl.speed;
        const wrapped = ((((rawAlong + CLOUD_DRIFT_HALF) % CLOUD_DRIFT_SPAN) + CLOUD_DRIFT_SPAN) % CLOUD_DRIFT_SPAN) - CLOUD_DRIFT_HALF;
        const edgeMargin = CLOUD_DRIFT_HALF - Math.abs(wrapped);
        const edgeFade = smoothstep(0, 18, edgeMargin);
        const cx = wrapped * CLOUD_WIND_X + cl.cross * CLOUD_PERP_X;
        const cz = wrapped * CLOUD_WIND_Z + cl.cross * CLOUD_PERP_Z;
        const bobY = Math.sin(elapsed * 0.25 + ci * 1.3) * 0.28;
        const effScale = cl.scale * Math.max(0.01, edgeFade);
        for (let pi = 0; pi < cl.puffs.length; pi += 1) {
          const pf = cl.puffs[pi]!;
          animPos.set(cx + pf.ox * effScale, cl.altY + bobY + pf.oy * effScale, cz + pf.oz * effScale);
          animScale.set(pf.sx * effScale, pf.sy * effScale, pf.sz * effScale);
          animMat.compose(animPos, animQuat, animScale);
          cloudInst.setMatrixAt(cloudPuffIdx, animMat);
          cloudPuffIdx += 1;
        }
      }
      cloudInst.instanceMatrix.needsUpdate = true;

      const targetRain = currentWeather === "rain" ? 1 : 0;
      rainStrength += (targetRain - rainStrength) * Math.min(1, dt * 3.2);
      brookMat.uniforms["uTime"]!.value = elapsed;
      brookMat.uniforms["uNight"]!.value = nightFactor;
      brookMat.uniforms["uRain"]!.value = rainStrength;
      (brookMat.uniforms["uSunDir"]!.value as Vector3).copy(sunDir);

      roadRibbonMat.uniforms["uNight"]!.value = nightFactor;
      (roadRibbonMat.uniforms["uSunDir"]!.value as Vector3).copy(sunDir);

      matWaterTile.uniforms["uTime"]!.value = elapsed;
      matWaterTile.uniforms["uNight"]!.value = nightFactor;

      // 야간 반딧불이 부유
      const ffVisibility = Math.max(0, (nightFactor - 0.22) / 0.78);
      fireflyMat.opacity = ffVisibility * 0.92;
      fireflyInstanced.visible = ffVisibility > 0.02;
      if (fireflyInstanced.visible) {
        animQuat.identity();
        for (let i = 0; i < MAX_FIREFLIES; i += 1) {
          const seed = fireflySeeds[i]!;
          const fx = seed.x + Math.sin(elapsed * 0.8 + seed.phase) * 1.1;
          const fz = seed.z + Math.cos(elapsed * 0.7 + seed.phase) * 1.1;
          const fy = Math.max(0.1, getTerrainBaseHeight(fx, fz)) + 0.65 + Math.sin(elapsed * 2.1 + seed.phase) * 0.38;
          const pulse = (0.55 + 0.45 * Math.sin(elapsed * 4.2 + seed.phase * 2.3)) * ffVisibility;
          animPos.set(fx, fy, fz);
          animScale.setScalar(Math.max(0.01, pulse));
          animMat.compose(animPos, animQuat, animScale);
          fireflyInstanced.setMatrixAt(i, animMat);
        }
        fireflyInstanced.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      disposed = true;
      disposeDynamicSignResources();
      disposeObjectTree(dynamicWorldGroup);
      disposeObjectTree(ecosystemButterflyGroup);
      disposeObjectTree(ecosystemKoiGroup);
      districtHitGroup.clear();
      districtHitTargets.length = 0;
      cameraOccluderObjects.length = 0;
      fishingSpotAnchors.length = 0;
      butterflyLayers.length = 0;
      koiLayers.length = 0;
      assetRegistry.dispose();
      textures.dispose();
      cloudInst.dispose();
      bannerInstanced.dispose();
      bannerInstGeo.dispose();
      flameOuterInst.dispose();
      flameCoreInst.dispose();
      flameCoalInst.dispose();
      flameEmberInst.dispose();
      flameOuterGeo.dispose();
      flameCoreGeo.dispose();
      flameCoalGeo.dispose();
      flameEmberGeo.dispose();
      matFlameOuter.dispose();
      matFlameCore.dispose();
      matFlameCoal.dispose();
      crystalInst.dispose();
      crystalRingInst.dispose();
      routineRotorInst.dispose();
      routineRotorGeo.dispose();
      statusBeaconInst.dispose();
      statusRingInst.dispose();
      dispatchPoleInst.dispose();
      dispatchPennantInst.dispose();
      dispatchHaloInst.dispose();
      dispatchPoleGeo.dispose();
      dispatchPennantGeo.dispose();
      notePinInst.dispose();
      notePinGeo.dispose();
      holoTableInst.dispose();
      holoRingInst.dispose();
      activeSmokeInst.dispose();
      holoTableBaseGeo.dispose();
      holoRingGeo.dispose();
      matHoloRing.dispose();
      bladeHubGeo.dispose();
      bladeSparGeo.dispose();
      bladeSailGeo.dispose();
      bladeRibGeo.dispose();
      bellCrownGeo.dispose();
      bellBodyGeo.dispose();
      bellRimGeo.dispose();
      bellClapperGeo.dispose();
      bellRopeGeo.dispose();
      bellTasselGeo.dispose();
      mailboxFlagArmGeo.dispose();
      mailboxFlagTabGeo.dispose();
      mailboxEnvelopeGeo.dispose();
      mailboxSealGeo.dispose();
      mailboxSparkGeo.dispose();
      pondFishBodyGeo.dispose();
      pondFishTailGeo.dispose();
      pondJellyBellGeo.dispose();
      pondJellyTendrilGeo.dispose();
      pondShellGeo.dispose();
      pondBottleGeo.dispose();
      pondBottleCorkGeo.dispose();
      pondRippleGeo.dispose();
      duckBodyGeo.dispose();
      duckHeadGeo.dispose();
      duckBeakGeo.dispose();
      duckWingGeo.dispose();
      duckEyeGeo.dispose();
      birdBodyGeo.dispose();
      birdWingGeo.dispose();
      biomeParticleInst.dispose();
      biomeParticleGeo.dispose();
      horizonTrunkInst.dispose();
      horizonTrunkGeo.dispose();
      horizonCanopyInst.dispose();
      horizonCanopyGeo.dispose();
      smokeGeo.dispose();
      signPlaqueGeo.dispose();
      districtHitGeo.dispose();
      hoverAuraGeo.dispose();
      highlightGeo.dispose();
      hoverHighlightMat.dispose();
      selectedHighlightMat.dispose();
      terrainGeo.dispose();
      terrainMat.dispose();
      brookGeo.dispose();
      brookMat.dispose();
      roadRibbonMat.dispose();
      matWaterTile.dispose();
      grassInstanced.dispose();
      grassBladeGeo.dispose();
      grassMat.dispose();
      flowerInstanced.dispose();
      flowerHeadGeo.dispose();
      flowerMat.dispose();
      fireflyInstanced.dispose();
      fireflyGeo.dispose();
      fireflyMat.dispose();
      for (const mat of sharedMaterials) mat.dispose();
      sharedMaterials.length = 0;
      scene.remove(root);
    },
  };
}
