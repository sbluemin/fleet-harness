import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  GLSL3,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from "three";

import type { IdentityTone } from "../../../workspace/shared/identity-tones.js";
import {
  WORLD_NOTICE_BOARD_POS,
  type WorldDistrictSpec,
  type WorldVillageSpec,
  type WorldWeatherMode,
  type WorldZoneSpec,
} from "../../shared/world-types.js";
import {
  createInstancedBucketBuilder,
  disposeObjectTree,
  getUnitGeometries,
  markSharedGeometry,
  markSharedMaterial,
  type InstancedBucketBuilder,
} from "./instanced-buckets.js";
import { createMeadowTexturePack } from "./meadow-textures.js";
import {
  createWorldAssetRegistry,
  type InstancedSlotTransform,
  type WorldModelSlot,
} from "./world-asset-registry.js";

/**
 * 넓게 펼쳐진 초원 마을(Meadow Village) + 심시티 스타일 사령관별 마을(Village) & Theater 구역(District) 3D 씬.
 *
 * - 지형 260×260m, 이동 반경 56m, 산맥 시작 r > 56m.
 * - 정적 자연물(나무·덤불·울타리·다리·가로등·벤치·접지 AO)과 마을/구역 건축물(Tier 0~5)을
 *   `instanced-buckets.ts`로 배칭해 수십~수백 구역에서도 draw call을 낮게 유지하고 GPU 누수를 0으로 억제한다.
 * - 심시티 구역 호버/선택용 공유 셰이더 하이라이트 링 2개만 상주시켜 `setDistrictHighlight`로 즉시 이동한다.
 */

export const WORLD_PLAY_RADIUS = 56;

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

const BROOK_VERTEX = /* glsl */ `
uniform float uTime;
out vec3 vWorldPos;
out vec3 vWaveNorm;
out float vShore;
out float vBridgeProx;

void main() {
  vec3 lp = position;
  float w1 = sin(lp.x * 0.68 - uTime * 2.1) * cos(lp.z * 0.62 + uTime * 1.65) * 0.032;
  float w2 = sin((lp.x * 1.25 - lp.z * 0.95) - uTime * 2.85) * 0.016;
  lp.y += w1 + w2;
  vWaveNorm = normalize(vec3(
    -0.045 * cos(lp.x * 0.68 - uTime * 2.1),
    1.0,
    -0.045 * sin(lp.z * 0.62 + uTime * 1.65)
  ));
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vWorldPos = wp.xyz;

  // brookProfile(x)와 동일한 해석적 강변 거리 → 구불구불한 강둑/연못 윤곽에 밀착하는 물거품 계산
  float centerZ = 9.2 + sin(wp.x * 0.095) * 2.9 + cos(wp.x * 0.04) * 1.1;
  float pondBell = exp(-pow((wp.x - 5.8) / 4.8, 2.0));
  float halfWidth = 1.45 + pondBell * 2.15;
  vShore = clamp(abs(wp.z - centerZ) / halfWidth, 0.0, 1.5);

  // 동/서 아치 목교 교각 부근 물결 거품 근접도
  float dEast = abs(wp.x - 8.6);
  float dWest = abs(wp.x + 11.5);
  vBridgeProx = max(
    smoothstep(1.85, 0.75, dEast) * smoothstep(0.92, 0.15, vShore),
    smoothstep(1.85, 0.75, dWest) * smoothstep(0.92, 0.15, vShore)
  );

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BROOK_FRAGMENT = /* glsl */ `
in vec3 vWorldPos;
in vec3 vWaveNorm;
in float vShore;
in float vBridgeProx;
out vec4 fragColor;

uniform float uTime;
uniform float uNight;
uniform float uRain;
uniform vec3 uSunDir;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// 지브리 / 윈드웨이커 스타일 카우스틱 링용 경량 2D 보로노이 셀 거리
float voronoiEdge(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float md = 8.0;
  float md2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      o = 0.5 + 0.42 * sin(uTime * 1.35 + 6.2831 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) {
        md2 = md;
        md = d;
      } else if (d < md2) {
        md2 = d;
      }
    }
  }
  return sqrt(md2) - sqrt(md);
}

void main() {
  vec3 N = normalize(vWaveNorm);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);

  // 에메랄드 얕은 물 → 맑은 코발트 깊은 물 그라데이션 (낮 · 노을 · 밤 연동)
  float sunsetFactor = clamp(1.0 - abs(uNight - 0.38) * 2.8, 0.0, 1.0);
  vec3 dayEmerald = vec3(0.22, 0.80, 0.78);
  vec3 dayCobalt = vec3(0.08, 0.50, 0.82);
  vec3 sunsetShallow = vec3(0.36, 0.58, 0.68);
  vec3 sunsetDeep = vec3(0.16, 0.30, 0.54);
  vec3 nightShallow = vec3(0.08, 0.28, 0.42);
  vec3 nightDeep = vec3(0.04, 0.13, 0.28);

  float depthT = smoothstep(0.18, 0.92, vShore);
  vec3 shallowCol = mix(mix(dayEmerald, sunsetShallow, sunsetFactor * 0.65), nightShallow, uNight);
  vec3 deepCol = mix(mix(dayCobalt, sunsetDeep, sunsetFactor * 0.65), nightDeep, uNight);
  vec3 baseCol = mix(deepCol, shallowCol, depthT);

  // 2중 흐르는 윈드웨이커 스타일 카우스틱 물결망
  vec2 flowUv1 = vWorldPos.xz * 0.68 + vec2(-uTime * 0.36, sin(vWorldPos.x * 0.22) * 0.25);
  vec2 flowUv2 = vWorldPos.xz * 1.08 + vec2(-uTime * 0.24, uTime * 0.16);
  float c1 = 1.0 - smoothstep(0.03, 0.18, voronoiEdge(flowUv1));
  float c2 = 1.0 - smoothstep(0.02, 0.15, voronoiEdge(flowUv2));
  float caustics = clamp(c1 * 0.75 + c2 * 0.45, 0.0, 1.0);

  vec3 causticCol = mix(vec3(0.76, 0.98, 1.0), vec3(0.45, 0.68, 0.92), uNight);
  vec3 col = mix(baseCol, causticCol, caustics * (0.28 - uNight * 0.10));

  // 강둑(shoreline) & 목교 교각 하얀 물거품 테두리 (수로 밖 서쪽 강변 거품 번짐 방지를 위해 좁은 밴드+알파 클램프)
  float waveWobble = sin(vWorldPos.x * 2.4 - uTime * 3.1) * 0.05 + cos(vWorldPos.z * 3.2 + uTime * 2.2) * 0.035;
  float shorePos = vShore + waveWobble;
  float shoreBand = smoothstep(0.76, 0.92, shorePos) * (1.0 - smoothstep(0.98, 1.12, shorePos));
  float innerFroth = smoothstep(0.60, 0.78, shorePos) * (1.0 - smoothstep(0.94, 1.06, shorePos)) * c1 * 0.58;
  float bridgeFoam = vBridgeProx * smoothstep(0.20, 0.75, c1 + 0.35 * sin(vWorldPos.z * 5.0 - uTime * 4.0)) * 0.75;
  float foamMask = clamp(shoreBand * 0.88 + innerFroth + bridgeFoam, 0.0, 1.0);
  vec3 foamCol = mix(vec3(0.95, 0.99, 1.0), vec3(0.55, 0.68, 0.84), uNight * 0.78);
  col = mix(col, foamCol, foamMask);

  // 프레넬 하늘 반사 + 태양/달빛 반짝임(sparkle glints)
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.8) * 0.38;
  vec3 skyRefl = mix(mix(vec3(0.72, 0.93, 1.0), vec3(0.98, 0.68, 0.48), sunsetFactor * 0.75), vec3(0.24, 0.38, 0.62), uNight);
  col = mix(col, skyRefl, fres * (1.0 - foamMask * 0.6));

  vec3 H = normalize(L + V);
  float specBase = pow(max(dot(N, H), 0.0), 72.0);
  float sparkleNoise = sin(vWorldPos.x * 7.5 - uTime * 4.4) * cos(vWorldPos.z * 6.8 + uTime * 3.6);
  float glint = smoothstep(0.62, 0.96, sparkleNoise) * (0.35 + specBase * 2.2) * (1.0 - foamMask * 0.7);
  vec3 glintCol = mix(vec3(1.0, 0.98, 0.88), vec3(0.84, 0.92, 1.0), uNight);
  col += glintCol * (specBase * 0.85 + glint * 0.55) * (1.0 - uNight * 0.35);

  // 비 날씨(uRain > 0)일 때 시냇물 수면 위 동심원 빗방울 파문(ripple)
  if (uRain > 0.01) {
    vec2 rp1 = vWorldPos.xz * 1.45;
    vec2 c1Cell = floor(rp1);
    vec2 c1Loc = fract(rp1) - 0.5;
    vec2 rnd1 = hash22(c1Cell);
    float ph1 = fract(uTime * 1.35 + rnd1.x * 3.7 + rnd1.y * 5.3);
    float ring1 = smoothstep(0.048, 0.0, abs(length(c1Loc - (rnd1 - 0.5) * 0.52) - ph1 * 0.44)) * (1.0 - ph1) * (1.0 - ph1);

    vec2 rp2 = vWorldPos.xz * 2.15 + vec2(4.3, 2.7);
    vec2 c2Cell = floor(rp2);
    vec2 c2Loc = fract(rp2) - 0.5;
    vec2 rnd2 = hash22(c2Cell);
    float ph2 = fract(uTime * 1.65 + rnd2.x * 4.1 + rnd2.y * 2.9);
    float ring2 = smoothstep(0.042, 0.0, abs(length(c2Loc - (rnd2 - 0.5) * 0.50) - ph2 * 0.42)) * (1.0 - ph2) * (1.0 - ph2);

    float rainRipple = clamp((ring1 + ring2 * 0.78) * uRain * (1.0 - foamMask * 0.65), 0.0, 0.85);
    vec3 rippleCol = mix(vec3(0.92, 0.98, 1.0), vec3(0.62, 0.78, 0.94), uNight);
    col = mix(col, rippleCol, rainRipple * 0.62);
  }

  float bankAlpha = 1.0 - smoothstep(0.94, 1.10, vShore);
  float channelFade = 1.0 - smoothstep(43.0, 53.0, abs(vWorldPos.x));
  float waterAlpha = mix(0.88, 0.95, foamMask) * bankAlpha * channelFade;
  if (waterAlpha < 0.02) discard;

  fragColor = vec4(col, waterAlpha);
}
`;

const FOUNTAIN_WATER_VERTEX = /* glsl */ `
out vec2 vLocalXZ;
void main() {
  vLocalXZ = position.xz;
  #ifdef USE_INSTANCING
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    vec4 wp = modelMatrix * vec4(position, 1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FOUNTAIN_WATER_FRAGMENT = /* glsl */ `
in vec2 vLocalXZ;
out vec4 fragColor;

uniform float uTime;
uniform float uNight;

void main() {
  float r = clamp(length(vLocalXZ) * 2.0, 0.0, 1.0);
  float ripple = sin(r * 18.0 - uTime * 4.2) * 0.5 + 0.5;
  float ring = smoothstep(0.66, 0.94, ripple) * (1.0 - r * 0.45);
  float rimFoam = smoothstep(0.82, 0.98, r);
  float centerSplash = smoothstep(0.24, 0.04, r);

  vec3 shallow = mix(vec3(0.24, 0.84, 0.84), vec3(0.10, 0.32, 0.48), uNight);
  vec3 deep = mix(vec3(0.10, 0.54, 0.86), vec3(0.05, 0.18, 0.36), uNight);
  vec3 col = mix(deep, shallow, r * 0.65 + ring * 0.35);
  vec3 foam = mix(vec3(0.95, 0.99, 1.0), vec3(0.58, 0.72, 0.88), uNight * 0.75);
  col = mix(col, foam, clamp(rimFoam * 0.72 + centerSplash * 0.65 + ring * 0.28, 0.0, 0.92));

  fragColor = vec4(col, 0.92);
}
`;

const HIGHLIGHT_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const HIGHLIGHT_FRAGMENT = /* glsl */ `
in vec2 vUv;
out vec4 fragColor;

uniform vec3 uColor;
uniform float uTime;
uniform float uSelected;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  float angle = atan(p.y, p.x);
  float pulse = 0.84 + 0.16 * sin(uTime * (uSelected > 0.5 ? 3.8 : 2.6));

  // 외곽 발광 링
  float outerRing = smoothstep(0.98, 0.94, r) * smoothstep(0.82, 0.89, r);
  float dash = smoothstep(-0.1, 0.25, sin(angle * 16.0 - uTime * 2.4));
  float ringAlpha = outerRing * mix(0.45 + dash * 0.55, 0.95, uSelected) * pulse;

  // 선택 시 내부 이중 링 + 4개 심시티 코너 아크 강조
  float innerRing = uSelected * smoothstep(0.79, 0.76, r) * smoothstep(0.69, 0.73, r) * 0.65;
  float cornerArc = uSelected * smoothstep(0.55, 0.85, abs(cos(angle * 2.0))) * smoothstep(1.0, 0.95, r) * smoothstep(0.87, 0.91, r) * 0.55;

  // 바닥 은은한 반투명 워시
  float fill = smoothstep(0.90, 0.15, r) * mix(0.14, 0.22, uSelected);

  float alpha = clamp(ringAlpha + innerRing + cornerArc + fill, 0.0, 0.92);
  vec3 col = mix(uColor, vec3(1.0, 0.98, 0.92), (outerRing * 0.35 + cornerArc * 0.45));
  fragColor = vec4(col, alpha);
}
`;

export interface CircleCollider {
  readonly x: number;
  readonly z: number;
  readonly r: number;
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
  /** 실시간 작업/경보/질문 상태인 마을·구역의 3D 공방 FX 에미터 좌표를 반환한다. */
  getLiveWorkshopEmitters(): readonly LiveWorkshopEmitter[];
  getGroundHeight(x: number, z: number): number;
  isWalkable(x: number, z: number): boolean;
  resolveMovement(curX: number, curZ: number, nextX: number, nextZ: number, actorRadius?: number): { x: number; z: number };
  update(dt: number, elapsed: number, nightFactor: number, sunDir: Vector3): void;
  dispose(): void;
}

interface BridgeConfig {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly halfSpan: number;
  readonly deckHalfWidth: number;
  readonly walkHalfWidth: number;
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

/** 남동·남서 초원을 가로지르는 시냇물 중심선 Z 및 폭 계산 (`world-projection.ts`와 동일 수식) */
function brookProfile(x: number): { centerZ: number; halfWidth: number } {
  const centerZ = 9.2 + Math.sin(x * 0.095) * 2.9 + Math.cos(x * 0.04) * 1.1;
  const pondBell = Math.exp(-Math.pow((x - 5.8) / 4.8, 2));
  const halfWidth = 1.45 + pondBell * 2.15;
  return { centerZ, halfWidth };
}

function makeBridgeConfig(x: number, yaw: number): BridgeConfig {
  const bp = brookProfile(x);
  return {
    x,
    z: bp.centerZ,
    yaw,
    halfSpan: bp.halfWidth + 2.25,
    deckHalfWidth: 1.34,
    walkHalfWidth: 1.14,
  };
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
  const matFlameOuter = ownMat(new MeshStandardMaterial({
    color: 0xff7b1c,
    emissive: 0xff5a00,
    emissiveIntensity: 1.5,
    roughness: 0.3,
  }));
  const matFlameCore = ownMat(new MeshStandardMaterial({
    color: 0xfff078,
    emissive: 0xffd026,
    emissiveIntensity: 1.9,
    roughness: 0.2,
  }));
  const contactShadowMat = ownMat(new MeshBasicMaterial({
    map: textures.contactShadowMap,
    transparent: true,
    depthWrite: false,
    opacity: 0.74,
  }));
  const matCloud = ownMat(new MeshStandardMaterial({ color: 0xfafcff, roughness: 0.96 }));
  const matSmoke = ownMat(new MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.95, transparent: true, opacity: 0.52 }));
  const matPad = ownMat(new MeshStandardMaterial({ color: 0x3da352, roughness: 0.75 }));
  const matLotus = ownMat(new MeshStandardMaterial({ color: 0xf9a8d4, roughness: 0.65 }));

  // 1. 초원 지형 메쉬 (260m x 260m 연속 지형, 이동 반경 56m + 정점 컬러 포장도로/마을 테라스/원경 산맥)
  const TERRAIN_SIZE = 260;
  const TERRAIN_SEG = 160;
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

  // 2. 시냇물 & 연못 수면 메쉬
  const brookGeo = new PlaneGeometry(126, 34, 90, 28);
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
  brookMesh.position.set(0, -0.09, 9.5);
  root.add(brookMesh);

  // 3. 상공 뭉게구름 링 (단일 InstancedMesh로 24개 구름 덩어리 → 1 draw call)
  const cloudGroup = new Group();
  const unitGeos = getUnitGeometries();
  const cloudSeeds: readonly [number, number, number, number][] = [
    [-34, 20.5, -42, 1.4],
    [22, 22.0, -44, 1.5],
    [46, 19.5, -10, 1.3],
    [-44, 20.0, 18, 1.35],
    [18, 21.5, 44, 1.4],
    [-20, 23.0, 46, 1.25],
  ];
  const cloudPuffs: readonly [number, number, number, number, number, number][] = [
    [0, 0, 0, 5.2, 1.9, 3.3],
    [1.7, -0.18, 0.16, 3.6, 1.56, 2.7],
    [-1.65, -0.2, -0.14, 3.4, 1.48, 2.5],
    [0.45, 0.42, -0.1, 2.9, 1.44, 2.4],
  ];
  const cloudInst = new InstancedMesh(unitGeos.sphere, matCloud, cloudSeeds.length * cloudPuffs.length);
  {
    const m4 = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    let idx = 0;
    for (const [cx, cy, cz, sc] of cloudSeeds) {
      for (const [px, py, pz, sx, sy, sz] of cloudPuffs) {
        pos.set(cx + px * sc, cy + py * sc, cz + pz * sc);
        scl.set(sx * sc, sy * sc, sz * sc);
        m4.compose(pos, quat, scl);
        cloudInst.setMatrixAt(idx, m4);
        idx += 1;
      }
    }
    cloudInst.instanceMatrix.needsUpdate = true;
    cloudInst.computeBoundingSphere();
  }
  cloudGroup.add(cloudInst);
  root.add(cloudGroup);

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

  const flameOuterGeo = markSharedGeometry(new ConeGeometry(0.32, 0.72, 8));
  flameOuterGeo.translate(0, 0.36, 0);
  const flameCoreGeo = markSharedGeometry(new ConeGeometry(0.19, 0.50, 7));
  flameCoreGeo.translate(0, 0.25, 0);
  const flameOuterInst = new InstancedMesh(flameOuterGeo, matFlameOuter, MAX_ANIM_FLAMES);
  flameOuterInst.instanceMatrix.setUsage(DynamicDrawUsage);
  flameOuterInst.frustumCulled = false;
  flameOuterInst.count = 0;
  const flameCoreInst = new InstancedMesh(flameCoreGeo, matFlameCore, MAX_ANIM_FLAMES);
  flameCoreInst.instanceMatrix.setUsage(DynamicDrawUsage);
  flameCoreInst.frustumCulled = false;
  flameCoreInst.count = 0;
  root.add(flameOuterInst, flameCoreInst);

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

  // 심시티 구역 호버/선택 공유 하이라이트 링 2개
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
  const hoverHighlightMesh = new Mesh(highlightGeo, hoverHighlightMat);
  hoverHighlightMesh.visible = false;
  hoverHighlightMesh.renderOrder = 3;
  const selectedHighlightMesh = new Mesh(highlightGeo, selectedHighlightMat);
  selectedHighlightMesh.visible = false;
  selectedHighlightMesh.renderOrder = 4;
  root.add(hoverHighlightMesh, selectedHighlightMesh);

  // 5. GPU 바람 파동(Wind Gust) 인스탄싱 풀잎(7,200개) & 들꽃(960개) & 야간 반딧불이(64개)
  const MAX_GRASS = 7200;
  const MAX_FLOWERS = 960;
  const MAX_FIREFLIES = 64;
  const windTimeUniform = { value: 0 };
  const grassMaxHeightUniform = { value: 0.42 };

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
    shader.fragmentShader = `varying float vBladeH;\nvarying float vGust;\n` + shader.fragmentShader
      .replace(
        "#include <color_fragment>",
        /* glsl */ `
        #include <color_fragment>
        vec3 bladeGrad = mix(vec3(0.74, 0.84, 0.70), vec3(1.16, 1.20, 0.94), smoothstep(0.0, 1.0, vBladeH));
        // 바람이 스칠 때 잎끝이 햇살을 머금고 연둣빛으로 반짝이는 효과
        bladeGrad *= mix(1.0, 1.10, vGust * vBladeH);
        diffuseColor.rgb *= bladeGrad;
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
    shader.fragmentShader = `varying float vPart;\n` + shader.fragmentShader
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
    const rad = 5 + (i % 13) * 3.6;
    return {
      x: Math.cos(ang) * rad,
      z: Math.sin(ang) * rad,
      phase: i * 1.37,
    };
  });

  // 시냇물 횡단 아치 목교 2기 (동쪽 벚꽃 언덕 방향 + 서쪽 남서 마을 방향)
  const BRIDGES: readonly BridgeConfig[] = [
    makeBridgeConfig(8.6, 0.34),
    makeBridgeConfig(-11.5, -0.26),
  ];
  const BRIDGE_EAST = BRIDGES[0]!;
  const BRIDGE_WEST = BRIDGES[1]!;

  let currentSignature = "";
  let currentZones: readonly WorldZoneSpec[] = [];
  let currentVillages: readonly WorldVillageSpec[] = [];
  let roadSegments: { ax: number; az: number; bx: number; bz: number; width: number }[] = [];
  let colliders: CircleCollider[] = [];
  const streetlampAnchors: Vector3[] = [];
  let lastHoveredDistrict: WorldDistrictSpec | null = null;
  let lastSelectedDistrict: WorldDistrictSpec | null = null;

  /** 도로까지 최단 거리 계산 (포장도로 정점 컬러 & 풀잎 제외 마스크용) */
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
      const curve = Math.sin(t * Math.PI) * 0.72;
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

  function toBridgeLocal(bridge: BridgeConfig, x: number, z: number): { localX: number; localZ: number } {
    const dx = x - bridge.x;
    const dz = z - bridge.z;
    const c = Math.cos(bridge.yaw);
    const s = Math.sin(bridge.yaw);
    return {
      localX: dx * c - dz * s,
      localZ: dx * s + dz * c,
    };
  }

  function fromBridgeLocal(bridge: BridgeConfig, localX: number, localZ: number): { x: number; z: number } {
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

  /** 연속 초원 지형 높이 계산 (마을 테라스 평탄화 + 56m 이후 산맥 상승) */
  function getTerrainBaseHeight(x: number, z: number): number {
    const rCenter = Math.hypot(x, z);

    let h = 0.34
      + Math.sin(x * 0.065) * Math.cos(z * 0.062) * 0.50
      + Math.sin((x + z) * 0.11) * 0.16
      + Math.cos((x - z * 1.2) * 0.045) * 0.26;

    // 원경 목초지 언덕 & 산맥 실루엣 (r > 56m 부터 부드럽게 솟아오름)
    if (rCenter > WORLD_PLAY_RADIUS) {
      const rimT = smoothstep(WORLD_PLAY_RADIUS, 118, rCenter);
      const ang = Math.atan2(z, x);
      const ridge = 1.0 + 0.46 * Math.sin(ang * 5.0 + 0.7) + 0.26 * Math.cos(ang * 9.0);
      h += rimT * rimT * 18.5 * ridge;
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

    // 시냇물 & 연못 수로 조각 (x 범위 -54..54 내)
    if (Math.abs(x) < 56) {
      const { centerZ, halfWidth } = brookProfile(x);
      const bd = Math.abs(z - centerZ);
      if (bd < halfWidth + 2.2) {
        const bankFactor = 1 - smoothstep(halfWidth * 0.55, halfWidth + 2.0, bd);
        const edgeFade = 1 - smoothstep(45, 55, Math.abs(x));
        h = h * (1 - bankFactor * edgeFade) + (-0.54) * (bankFactor * edgeFade);
      }
    }

    return h;
  }

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

    // 1. 외곽 목장 경계 (반경 56m 부드러운 원형 클램프)
    const distFromOrigin = Math.hypot(rx, rz);
    if (distFromOrigin > WORLD_PLAY_RADIUS) {
      const s = WORLD_PLAY_RADIUS / distFromOrigin;
      rx *= s;
      rz *= s;
    }

    // 2. 건물·나무·우물·모닥불 원형 슬라이딩 충돌 해소
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
      }
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

  function addContactShadow(b: InstancedBucketBuilder, x: number, z: number, radiusX: number, radiusZ = radiusX): void {
    const gy = getTerrainBaseHeight(x, z);
    if (gy < 0.02) return;
    b.addPlane(contactShadowMat, [x, gy + 0.032, z], [radiusX * 2, 1, radiusZ * 2], undefined, {
      renderOrder: 1,
    });
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

  function addTree(b: InstancedBucketBuilder, _parent: Group, tx: number, tz: number, scale: number, kind: "oak" | "pine" | "blossom", addCollider = true): void {
    const gy = getTerrainBaseHeight(tx, tz);
    if (gy < 0.08) return;
    const rotY = hash2(tx, tz) * Math.PI * 2;
    const slot: WorldModelSlot = kind === "pine" ? "tree-pine" : kind === "blossom" ? "tree-blossom" : "tree-oak";

    if (assetRegistry.hasCustomModel(slot)) {
      queueInstancedSlot(slot, { x: tx, y: gy, z: tz, rotationY: rotY, scale });
    } else {
      b.withFrame(tx, gy, tz, rotY, scale, () => {
        if (kind === "pine") {
          b.addCylinder(matBark, [0, 0.18, 0], [0.60, 0.42, 0.60], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matBark, [0, 0.68, 0], [0.40, 1.35, 0.40], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          const tiers: readonly [number, number, number, number][] = [
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
          });
        } else {
          b.addCylinder(matBark, [0, 0.18, 0], [0.74, 0.44, 0.74], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matBark, [0, 0.72, 0], [0.50, 1.48, 0.50], undefined, { tapered: true, castShadow: true, receiveShadow: true });
          b.addCylinder(matBark, [0.26, 1.22, 0.08], [0.19, 0.72, 0.19], [0, 0, -0.68], { tapered: true });
          b.addCylinder(matBark, [-0.24, 1.15, -0.10], [0.18, 0.62, 0.18], [0, 0, 0.62], { tapered: true });

          const baseHex = kind === "blossom" ? 0xfba9cd : 0x3e9e4c;
          const midHex = kind === "blossom" ? 0xfba9cd : 0x5cc458;
          const topHex = kind === "blossom" ? 0xffcce2 : 0x79d464;
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
    addContactShadow(b, lx, lz, 0.40, 0.40);
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
    addContactShadow(b, bx, bz, 0.84, 0.50);
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
    colliders.push({ x: hx, z: hz + 0.15, r: 2.95 });

    // 우측 풍차 시계탑 (길드 회관 우측 처마 +2.82m와 날개 반경 2.11m 완전 분리)
    const mx = 5.25;
    const mz = -6.7;
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
    colliders.push({ x: mx, z: mz, r: 1.55 });
  }

  /** 중앙 광장 우물 · 모닥불 · 이정표 · 벤치 · 길드 퀘스트 게시판 */
  function buildPlazaCommons(b: InstancedBucketBuilder, parent: Group): void {
    const courtY = getTerrainBaseHeight(0, -1.6);
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
    colliders.push({ x: fx, z: fz, r: 0.92 });

    addWoodenBench(b, fx + 1.95, fz - 0.15, -Math.PI * 0.45);
    addWoodenBench(b, fx - 0.25, fz + 1.95, Math.PI);

    // 나무 이정표 (-2.2, 1.9)
    const sx = -2.2;
    const sz = 1.9;
    const sy = getTerrainBaseHeight(sx, sz);
    b.withFrame(sx, sy, sz, 0, 1, () => {
      b.addCylinder(matBark, [0, 0.86, 0], [0.18, 1.75, 0.18], undefined, { tapered: true });
      b.addBox(matWoodLight, [0.22, 1.48, 0], [0.92, 0.20, 0.06], [0, 0.35, 0]);
      b.addBox(matWood, [-0.20, 1.20, 0], [0.86, 0.20, 0.06], [0, -0.45, 0]);
    });
    addContactShadow(b, sx, sz, 0.55, 0.55);
    colliders.push({ x: sx, z: sz, r: 0.38 });

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
    addContactShadow(b, nbx, nbz, 1.25, 0.78);
    colliders.push({ x: nbx, z: nbz, r: 0.92 });
  }

  /** 시냇물 횡단 아치 목교(동/서 2기) + 연못 수련잎/연꽃/갈대 */
  function buildBrookBridgesAndFlora(b: InstancedBucketBuilder): void {
    const hasCustomBridge = assetRegistry.hasCustomModel("bridge");
    for (const bridge of BRIDGES) {
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
      [-22.5, -1], [-18.5, -1], [-16.4, 1], [-8.2, -1], [-6.5, 1],
      [-1.2, -1], [2.4, 1], [3.2, -1], [6.2, 1], [11.8, -1],
      [14.2, 1], [15.2, -1], [19.6, 1], [22.4, -1], [27.5, 1],
    ];
    const hasCustomReeds = assetRegistry.hasCustomModel("reeds");
    for (const [rx, bankSide] of reedSpots) {
      if (Math.abs(rx - BRIDGE_EAST.x) < 2.2 || Math.abs(rx - BRIDGE_WEST.x) < 2.2) continue;
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

    // 시냇물 양쪽 강변 이끼 낀 강돌 클러스터 (river-rock.glb)
    if (assetRegistry.hasCustomModel("river-rock")) {
      const rockSpots: readonly [number, number][] = [
        [-25.5, 1], [-20.2, -1], [-15.2, -1], [-7.6, 1], [-4.2, -1],
        [0.4, 1], [2.6, -1], [4.8, 1], [12.4, 1], [13.8, -1],
        [17.5, 1], [20.8, -1], [25.2, 1], [29.4, -1],
      ];
      for (const [rx, bankSide] of rockSpots) {
        if (Math.abs(rx - BRIDGE_EAST.x) < 2.6 || Math.abs(rx - BRIDGE_WEST.x) < 2.6) continue;
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

  // ─── 심시티 스타일 사령관 마을(Village) & Theater 구역(District Tier 0~5) 빌더 ──

  function buildDistrict(b: InstancedBucketBuilder, parent: Group, d: WorldDistrictSpec): void {
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

    if (hasCustomDistrict && districtSlot) {
      queueInstancedSlot(districtSlot, {
        x: d.x,
        y: gy,
        z: d.z,
        rotationY: d.rotationY,
        scale: fitScale,
        roofTintHex: toneHex,
      });
    } else b.withFrame(d.x, gy, d.z, d.rotationY, fitScale, () => {
      if (d.tier === 0) {
        // Tier 0 (미개척 초원): 코너 말뚝 4개 + 작은 깃대 + 이끼 바위
        const corner = 1.65;
        for (const cx of [-corner, corner]) {
          for (const cz of [-corner, corner]) {
            b.addCylinder(matBark, [cx, 0.28, cz], [0.11, 0.58, 0.11], undefined, { tapered: true });
          }
        }
        // 작은 페넌트 깃대
        b.addCylinder(matWood, [0.45, 0.95, -0.35], [0.09, 1.9, 0.09], undefined, { tapered: true });
        b.addSphere(matBrass, [0.45, 1.92, -0.35], [0.14, 0.14, 0.14]);
        // 바위 & 수풀 소품
        b.addDodeca(matStone, [-0.55, 0.16, 0.25], [0.68, 0.36, 0.56], [0.2, 0.7, 0.1], { flat: true, receiveShadow: true });
        b.addDodeca(matFoliageBase, [-0.92, 0.22, -0.15], [0.62, 0.44, 0.58], undefined, { color: 0x5cc458 });
        return;
      }

      if (d.tier === 1) {
        // Tier 1 (개척 캠프): 사령관 색 줄무늬 삼각 천막 + 모닥불 + 나무 표지판 + 통나무 의자
        b.addPitchedRoof(matRoofBase, matCanvas, matTimber, {
          x: -0.15,
          y: 0.02,
          z: -0.35,
          width: 2.05,
          height: 1.48,
          depth: 1.95,
          roofColor: toneHex,
          includeGableWall: true,
          castShadow: true,
          receiveShadow: true,
        });
        // 천막 입구 개구부
        b.addBox(matTimber, [-0.15, 0.55, 0.64], [0.64, 1.04, 0.08]);
        // 나무 표지판 (좌전면)
        b.addCylinder(matBark, [-1.15, 0.58, 0.95], [0.11, 1.18, 0.11], undefined, { tapered: true });
        b.addBox(matWoodLight, [-0.98, 0.96, 0.95], [0.68, 0.20, 0.06], [0, 0.24, 0]);
        // 모닥불 돌 테두리 + 장작 (우전면)
        for (let i = 0; i < 6; i += 1) {
          const a = (i / 6) * Math.PI * 2;
          b.addDodeca(i % 2 === 0 ? matStone : matStoneDark, [0.95 + Math.cos(a) * 0.42, 0.07, 0.85 + Math.sin(a) * 0.42], [0.26, 0.16, 0.24], undefined, { flat: true });
        }
        b.addCylinder(matBark, [0.95, 0.09, 0.85], [0.11, 0.58, 0.11], [0, 0.4, Math.PI * 0.5]);
        b.addCylinder(matBark, [0.95, 0.09, 0.85], [0.11, 0.58, 0.11], [0, -0.5, Math.PI * 0.5]);
        // 통나무 의자 + 보급 상자
        b.addCylinder(matWood, [0.18, 0.18, 1.25], [0.34, 0.36, 0.34]);
        b.addBox(matWood, [-1.18, 0.22, -0.35], [0.46, 0.44, 0.44]);
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

    // 프레임 바깥 월드 좌표 기반 동적 소품 등록 (깃발 · 불꽃 · 가로등 · 크리스탈 등대)
    const cosY = Math.cos(d.rotationY);
    const sinY = Math.sin(d.rotationY);
    const toWorld = (lx: number, ly: number, lz: number) => ({
      x: d.x + (lx * cosY + lz * sinY) * fitScale,
      y: gy + ly * fitScale,
      z: d.z + (-lx * sinY + lz * cosY) * fitScale,
    });

    if (d.tier === 0) {
      const fPos = toWorld(0.45, 1.68, -0.35);
      registerBanner(fPos.x, fPos.y, fPos.z, d.rotationY + 0.2, toneHex, 0.58 * fitScale, 0.30 * fitScale);
    } else if (d.tier === 1) {
      // district-tier1.glb EmberCore 중심 (0.88, 0.22, 0.82) × (2.15 / 2.78) ≈ (0.68, 0.17, 0.63)
      const fl = hasCustomDistrict ? toWorld(0.68, 0.17, 0.63) : toWorld(0.95, 0.12, 0.85);
      registerFlame(fl.x, fl.y, fl.z, (hasCustomDistrict ? 0.58 : 0.62) * fitScale);
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

    addContactShadow(b, d.x, d.z, d.radius * 0.78, d.radius * 0.78);
    if (d.tier >= 1) {
      colliders.push({ x: d.x, z: d.z, r: d.radius * 0.42 });
    }
    void parent;
  }

  /** 사령관별 마을(Village) — 경계 울타리/석조 담장 · Blender 정문 아치/푯말 · 자갈길 · 바이옴(meadow/sakura/citadel) · 내부 Theater 구역 */
  function buildVillage(b: InstancedBucketBuilder, parent: Group, v: WorldVillageSpec): void {
    const gy = getTerrainBaseHeight(v.x, v.z);
    if (gy < 0.05) return;

    const biome = v.biome ?? "meadow";
    const isCitadelBiome = biome === "citadel";
    const isSakuraBiome = biome === "sakura";
    const toneHex = TONE_ROOF_HEX[v.tone];
    const gateCos = Math.cos(v.gateAngle);
    const gateSin = Math.sin(v.gateAngle);
    const gateFaceYaw = Math.atan2(gateCos, gateSin);

    // 1. 마을 중앙 광장 원형 문장 디스크 (#21 폴리싱: 구역 이중 선택 링과 겹치지 않게 콤팩트 비율 적용)
    b.addCylinder(
      isCitadelBiome || v.overallTier >= 4 ? matMarble : v.overallTier >= 2 ? matStone : matStoneDark,
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
        } else {
          b.addBox(matWoodLight, [mx, my + 0.52, mz], [0.07, 0.08, segLen + 0.06], [0, segYaw, 0]);
          b.addBox(matWoodLight, [mx, my + 0.28, mz], [0.07, 0.08, segLen + 0.06], [0, segYaw, 0]);
        }
      }
    }

    // 3. 마을 입구 문주(Blender 정문 아치 GLB 우선, 폴백 유지) + 마을 푯말
    const gateDist = v.radius - 0.25;
    const gx = v.x + gateCos * gateDist;
    const gz = v.z + gateSin * gateDist;
    const perpX = -gateSin;
    const perpZ = gateCos;
    const gateHalfW = 1.95;

    const gateSlot: WorldModelSlot = isStoneWall ? "village-gate-stone" : "village-gate-wood";
    if (assetRegistry.hasCustomModel(gateSlot)) {
      const gpy = getTerrainBaseHeight(gx, gz);
      if (gpy >= 0.05) {
        queueInstancedSlot(gateSlot, {
          x: gx,
          y: gpy,
          z: gz,
          rotationY: gateFaceYaw,
          scale: 1.0,
          roofTintHex: toneHex,
        });
        addContactShadow(b, gx, gz, isStoneWall ? 2.55 : 2.15, 0.95);
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
        const gpy = getTerrainBaseHeight(gx, gz);
        b.addBox(isGrandWall ? matMarble : matTimber, [gx, gpy + 2.26, gz], [gateHalfW * 2 + 0.72, 0.26, 0.38], [0, gateFaceYaw, 0], { castShadow: true });
        b.addBox(matRoofBase, [gx, gpy + 2.48, gz], [gateHalfW * 2 + 0.94, 0.18, 0.54], [0, gateFaceYaw, 0], { color: toneHex });
      }
    }

    // 마을 입구 푯말 (오른쪽 바깥, Blender village-signpost.glb 우선)
    const signX = gx + perpX * (gateHalfW + 1.05) + gateCos * 0.45;
    const signZ = gz + perpZ * (gateHalfW + 1.05) + gateSin * 0.45;
    const signY = getTerrainBaseHeight(signX, signZ);
    if (signY >= 0.05) {
      if (assetRegistry.hasCustomModel("village-signpost")) {
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
      addContactShadow(b, signX, signZ, 0.56, 0.56);
    }

    // 입구 가로등 1기 (성채 바이옴이면 입구 양쪽 + 내부 추가 가로등으로 웅장한 야경 연출)
    const lampX = gx - perpX * (gateHalfW + 0.85) + gateCos * 0.55;
    const lampZ = gz - perpZ * (gateHalfW + 0.85) + gateSin * 0.55;
    addHangingStreetlamp(b, lampX, lampZ, gateFaceYaw + Math.PI * 0.5, true);
    if (isCitadelBiome) {
      const rightLampX = gx + perpX * (gateHalfW + 0.85) - gateCos * 0.85;
      const rightLampZ = gz + perpZ * (gateHalfW + 0.85) - gateSin * 0.85;
      addHangingStreetlamp(b, rightLampX, rightLampZ, gateFaceYaw - Math.PI * 0.5, false);
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
        const stoneMat = isCitadelBiome
          ? (si % 2 === 0 ? matMarble : matStone)
          : isSakuraBiome
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
        buildDistrict(b, parent, district);
      }
    }

    // 마을 광장 장식 화단 (flowerbed.glb — 벚꽃 바이옴이면 화단 추가 강조)
    if (assetRegistry.hasCustomModel("flowerbed")) {
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
      }
    }

    // 마을 외곽 장식 나무 (바이옴별 수종 차별화: sakura → 벚나무 풍성 배치, citadel → 침엽수/참나무)
    for (const side of [-1, 1]) {
      const tAng = v.gateAngle + Math.PI + side * 0.92;
      const tx = v.x + Math.cos(tAng) * (v.radius + 1.85);
      const tz = v.z + Math.sin(tAng) * (v.radius + 1.85);
      const kind = isSakuraBiome
        ? "blossom"
        : isCitadelBiome
          ? "pine"
          : (v.tone === "rose" || v.tone === "plum" ? "blossom" : side > 0 ? "oak" : "pine");
      addTree(b, parent, tx, tz, isSakuraBiome ? 1.06 : 0.96, kind, true);
    }
    if (isSakuraBiome) {
      // 벚꽃 정원 바이옴: 마을 입구 좌우에 화사한 분홍 벚나무 2그루 추가 (루틴 풍차 회피)
      for (const side of [-1, 1]) {
        if (side < 0 && v.routineCount > 0) continue;
        const eAng = v.gateAngle + side * 0.62;
        const tx = v.x + Math.cos(eAng) * (v.radius + 1.65);
        const tz = v.z + Math.sin(eAng) * (v.radius + 1.65);
        addTree(b, parent, tx, tz, 1.04, "blossom", true);
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

  /** 지형 정점 좌표/컬러 갱신, InstancedMesh 구조물/마을/구역 배칭, 풀잎·들꽃 인스탄싱 */
  function rebuildWorld(zones: readonly WorldZoneSpec[], villages: readonly WorldVillageSpec[]): void {
    disposeObjectTree(dynamicWorldGroup);
    while (dynamicWorldGroup.children.length > 0) {
      dynamicWorldGroup.remove(dynamicWorldGroup.children[0]!);
    }
    streetlampAnchors.length = 0;
    colliders = [];
    animatedBanners = [];
    animatedFlames = [];
    animatedCrystals = [];
    animatedRoutineWindmills = [];
    customBladePivots.length = 0;
    instancedSlotQueues = new Map();
    assetRegistry.clearActiveMixers();
    currentZones = zones;
    currentVillages = villages;

    // 1. 광장 ↔ 사령관 마을 ↔ 아웃포스트 도로 세그먼트 생성
    roadSegments = [];
    // 중앙 광장 → 양쪽 목교 기본 간선
    roadSegments.push({ ax: 1.0, az: 1.4, bx: BRIDGE_EAST.x, bz: BRIDGE_EAST.z, width: 1.35 });
    roadSegments.push({ ax: -1.8, az: 1.6, bx: BRIDGE_WEST.x, bz: BRIDGE_WEST.z, width: 1.30 });

    for (const v of villages) {
      const gateX = v.x + Math.cos(v.gateAngle) * (v.radius - 0.1);
      const gateZ = v.z + Math.sin(v.gateAngle) * (v.radius - 0.1);
      if (v.z > 13.5) {
        const bridge = v.x >= -2 ? BRIDGE_EAST : BRIDGE_WEST;
        roadSegments.push({ ax: bridge.x, az: bridge.z, bx: gateX, bz: gateZ, width: 1.35 });
      } else {
        roadSegments.push({ ax: 0, az: -1.2, bx: gateX, bz: gateZ, width: 1.35 });
      }
    }
    for (const zSpec of zones) {
      if (zSpec.kind === "plaza" || zSpec.kind === "village") continue;
      if (zSpec.kind === "garden") {
        roadSegments.push({ ax: BRIDGE_EAST.x, az: BRIDGE_EAST.z, bx: zSpec.x, bz: zSpec.z, width: 1.30 });
      } else if (zSpec.kind === "outpost") {
        const ownerVillage = zSpec.commodoreId ? villages.find((v) => v.commodoreId === zSpec.commodoreId) : undefined;
        if (ownerVillage) {
          roadSegments.push({ ax: ownerVillage.x, az: ownerVillage.z, bx: zSpec.x, bz: zSpec.z, width: 1.15 });
        } else {
          roadSegments.push({ ax: 0, az: -1.2, bx: zSpec.x * 0.92, bz: zSpec.z * 0.92, width: 1.25 });
        }
      }
    }

    // 2. 지형 정점 높이 & 정점 컬러 페인팅 (마을 종합 발전도 기반 바닥 승격 포함)
    const posAttr = terrainGeo.attributes["position"] as BufferAttribute;
    const cGrassRich = new Color(0x4eb956);
    const cGrassSun = new Color(0x6ad15e);
    const cGrassDeep = new Color(0x3b9b4b);
    const cPath = new Color(0xdac49b);
    const cGravel = new Color(0xcfc6b4);
    const cCobble = new Color(0xc7ccd4);
    const cCourtyard = new Color(0xd6dee8);
    const cSakuraFloor = new Color(0xe8d5dd);
    const cCitadelFloor = new Color(0xcfd9e6);
    const cBank = new Color(0xe2cda2);
    const cMountain = new Color(0x568d7a);
    const tmpCol = new Color();

    for (let i = 0; i < posAttr.count; i += 1) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const vy = getTerrainBaseHeight(vx, vz);
      posAttr.setY(i, vy);

      const patch = Math.sin(vx * 0.14 + Math.cos(vz * 0.12) * 1.5) * 0.5 + 0.5;
      tmpCol.copy(cGrassRich).lerp(cGrassSun, patch * 0.58);
      const shadePatch = Math.cos((vx - vz) * 0.09) * 0.5 + 0.5;
      tmpCol.lerp(cGrassDeep, shadePatch * 0.28);

      // 오솔길 & 광장 석재 바닥 블렌딩
      const roadInfo = minRoadDistance(vx, vz);
      if (roadInfo.dist < roadInfo.halfWidth + 0.95 && vy > 0.04) {
        const rw = 1 - smoothstep(roadInfo.halfWidth * 0.65, roadInfo.halfWidth + 0.95, roadInfo.dist);
        const isPlazaCore = Math.hypot(vx, vz + 1.6) < 4.5;
        tmpCol.lerp(isPlazaCore ? cCobble : cPath, rw * 0.92);
      }

      // 사령관별 마을 테라스 바닥 승격 (바이옴 + 종합 발전도 연동)
      if (vy > 0.06) {
        for (const v of villages) {
          const dv = Math.hypot(vx - v.x, vz - v.z);
          if (dv < v.radius + 0.7) {
            const vw = 1 - smoothstep(v.radius - 0.8, v.radius + 0.7, dv);
            const floorColor =
              v.biome === "citadel" ? cCitadelFloor
                : v.biome === "sakura" ? cSakuraFloor
                  : v.overallTier >= 4 ? cCourtyard
                    : v.overallTier === 3 ? cCobble
                      : v.overallTier === 2 ? cGravel
                        : cPath;
            const strength =
              v.biome === "citadel" ? 0.88
                : v.biome === "sakura" ? 0.78
                  : v.overallTier >= 4 ? 0.88 : v.overallTier === 3 ? 0.80 : v.overallTier === 2 ? 0.72 : 0.62;
            tmpCol.lerp(floorColor, vw * strength);
            break;
          }
        }
      }

      // 시냇물 수로 주변 강변 블렌딩
      if (Math.abs(vx) < 56) {
        const bp = brookProfile(vx);
        if (Math.abs(vz - bp.centerZ) < bp.halfWidth + 2.2 && vy < 0.22) {
          const bw = 1 - smoothstep(-0.18, 0.22, vy);
          tmpCol.lerp(cBank, bw * 0.88);
        }
      }

      // 원경 산맥 안개빛 녹청색 블렌딩 (r > 58m)
      const rDist = Math.hypot(vx, vz);
      if (rDist > WORLD_PLAY_RADIUS + 2) {
        const mw = smoothstep(WORLD_PLAY_RADIUS + 2, 112, rDist);
        tmpCol.lerp(cMountain, mw * 0.65);
      }

      terrainColorAttr.setXYZ(i, tmpCol.r, tmpCol.g, tmpCol.b);
    }
    posAttr.needsUpdate = true;
    terrainColorAttr.needsUpdate = true;
    terrainGeo.computeVertexNormals();

    // 3. InstancedBucketBuilder로 모든 정적 건물·마을·구역·자연물 배칭
    const bucketBuilder = createInstancedBucketBuilder();

    buildGrandGuildHall(bucketBuilder, dynamicWorldGroup);
    buildPlazaCommons(bucketBuilder, dynamicWorldGroup);
    buildBrookBridgesAndFlora(bucketBuilder);

    for (const v of villages) {
      buildVillage(bucketBuilder, dynamicWorldGroup, v);
    }
    for (const zSpec of zones) {
      if (zSpec.kind === "village" || zSpec.kind === "plaza") continue;
      buildZoneStructures(bucketBuilder, dynamicWorldGroup, zSpec);
    }

    // 4. 광장 및 초원 외곽 풍경림 · 울타리 · 가로등 배치
    addHangingStreetlamp(bucketBuilder, -2.9, -3.5, 0.4, true);
    addHangingStreetlamp(bucketBuilder, 3.1, -3.4, -0.4, true);
    addHangingStreetlamp(bucketBuilder, 5.4, 5.6, -0.8, true);

    const scenicTrees: readonly [number, number, number, "oak" | "pine" | "blossom"][] = [
      [-7.2, -5.8, 1.18, "oak"],
      [-8.6, 1.5, 1.05, "pine"],
      [-5.8, 6.4, 1.08, "blossom"],
      [8.6, -4.2, 1.12, "oak"],
      [11.2, 1.8, 0.98, "pine"],
      [-14.5, -24.5, 1.24, "pine"],
      [14.5, -24.5, 1.22, "oak"],
      [-30.5, 15.0, 1.30, "oak"],
      [30.5, 15.5, 1.28, "blossom"],
      [-46.5, -15.0, 1.42, "pine"],
      [46.5, -16.5, 1.40, "oak"],
      [-45.0, 16.0, 1.38, "pine"],
      [44.5, 17.0, 1.36, "oak"],
      [-28.0, -42.5, 1.44, "pine"],
      [28.5, -42.0, 1.42, "oak"],
      [0.0, -47.5, 1.46, "pine"],
      [-24.5, 42.5, 1.38, "blossom"],
      [24.5, 42.5, 1.36, "oak"],
      [14.5, 15.5, 1.08, "blossom"],
      [-25.5, 6.5, 1.16, "pine"],
    ];
    for (const [tx, tz, sc, kind] of scenicTrees) {
      const overlapsZone = zones.some((z) => z.kind !== "plaza" && Math.hypot(tx - z.x, tz - z.z) < z.radius + 2.2);
      const overlapsVillage = villages.some((v) => Math.hypot(tx - v.x, tz - v.z) < v.radius + 2.2);
      if (overlapsZone || overlapsVillage) continue;
      addTree(bucketBuilder, dynamicWorldGroup, tx, tz, sc, kind);
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
      const overlapsZone = zones.some((z) => z.kind !== "plaza" && Math.hypot(bx - z.x, bz - z.z) < z.radius + 1.5);
      const overlapsVillage = villages.some((v) => Math.hypot(bx - v.x, bz - v.z) < v.radius + 1.5);
      if (overlapsZone || overlapsVillage) continue;
      addBushAndRockCluster(bucketBuilder, bx, bz, bsc);
    }

    // 중앙 길드 광장 장식 화단 4기 (flowerbed.glb)
    if (assetRegistry.hasCustomModel("flowerbed")) {
      const plazaFlowerbeds: readonly [number, number, number][] = [
        [-4.9, -4.6, 0.96],
        [6.6, -4.5, 0.94],
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

    crystalInst.count = animatedCrystals.length;
    crystalRingInst.count = animatedCrystals.length;
    for (let i = 0; i < animatedCrystals.length; i += 1) {
      tmpInstColor.setHex(animatedCrystals[i]!.colorHex);
      crystalInst.setColorAt(i, tmpInstColor);
    }
    if (crystalInst.instanceColor) crystalInst.instanceColor.needsUpdate = true;

    routineRotorInst.count = animatedRoutineWindmills.length;

    // 하이라이트 링 높이 재동기화
    applyHighlightMesh(hoverHighlightMesh, hoverHighlightMat, lastHoveredDistrict);
    applyHighlightMesh(selectedHighlightMesh, selectedHighlightMat, lastSelectedDistrict);

    // 5. 풀잎(InstancedMesh) & 들꽃(InstancedMesh) 배치 — 도로·수면·마을 석재바닥·건물 회피
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
      const rad = Math.pow(u1, 0.65) * (WORLD_PLAY_RADIUS - 2.0);
      const ang = u2 * Math.PI * 2;
      const gx = Math.cos(ang) * rad;
      const gz = Math.sin(ang) * rad;
      const gy = getTerrainBaseHeight(gx, gz);
      if (gy < 0.14) continue;
      const rd = minRoadDistance(gx, gz);
      if (rd.dist < rd.halfWidth + 0.28) continue;
      if (villages.some((v) => Math.hypot(gx - v.x, gz - v.z) < v.radius - 0.15)) continue;
      if (colliders.some((c) => Math.hypot(gx - c.x, gz - c.z) < c.r + 0.25)) continue;

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
    for (let attempt = 0; attempt < MAX_FLOWERS * 3 && fCount < MAX_FLOWERS; attempt += 1) {
      const u1 = hash2(attempt * 3.17 + 50, 11.7);
      const u2 = hash2(attempt * 5.09 + 20, 29.3);
      const rad = 3.5 + Math.sqrt(u1) * (WORLD_PLAY_RADIUS - 5.5);
      const ang = u2 * Math.PI * 2;
      const fx = Math.cos(ang) * rad;
      const fz = Math.sin(ang) * rad;
      const fy = getTerrainBaseHeight(fx, fz);
      if (fy < 0.18) continue;
      const rd = minRoadDistance(fx, fz);
      if (rd.dist < rd.halfWidth + 0.45) continue;
      if (villages.some((v) => v.overallTier >= 1 && Math.hypot(fx - v.x, fz - v.z) < v.radius - 0.25)) continue;
      if (colliders.some((c) => Math.hypot(fx - c.x, fz - c.z) < c.r + 0.35)) continue;

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

    for (const v of villages) {
      const gy = Math.max(0.1, getTerrainBaseHeight(v.x, v.z));
      if (v.workStep) {
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
      }

      if (v.workStep && !emittedOnDistrict) {
        const kind = classifyWorkStepFx(v.workStep);
        nextEmitters.push({ x: v.x, y: gy + 2.2, z: v.z, kind });
      }
    }

    liveWorkshopEmitters = nextEmitters;
    animatedStatusBeacons = nextBeacons;
    statusBeaconInst.count = nextBeacons.length;
    statusRingInst.count = nextBeacons.length;
    for (let i = 0; i < nextBeacons.length; i += 1) {
      statusColorScratch.setHex(nextBeacons[i]!.colorHex);
      statusBeaconInst.setColorAt(i, statusColorScratch);
      statusRingInst.setColorAt(i, statusColorScratch);
    }
    if (statusBeaconInst.instanceColor) statusBeaconInst.instanceColor.needsUpdate = true;
    if (statusRingInst.instanceColor) statusRingInst.instanceColor.needsUpdate = true;
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
            `${v.id}:${v.x}:${v.z}:${v.radius}:${v.tone}:${v.biome}:${v.overallTier}:${v.routineCount > 0 ? 1 : 0}:${Math.min(5, v.completedObjectiveCount)}[`
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
      // 선택된 구역과 호버 구역이 같으면 선택 링만 표시
      const effectiveHover = hovered && selected && hovered.id === selected.id ? null : hovered;
      applyHighlightMesh(hoverHighlightMesh, hoverHighlightMat, effectiveHover);
      applyHighlightMesh(selectedHighlightMesh, selectedHighlightMat, selected);
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
    getLiveWorkshopEmitters() {
      return liveWorkshopEmitters;
    },
    getGroundHeight,
    isWalkable,
    resolveMovement,
    update(dt, elapsed, nightFactor, sunDir) {
      windTimeUniform.value = elapsed;
      windmillBlades.rotation.z = -elapsed * 0.95;
      for (const pivot of customBladePivots) {
        pivot.rotation.z = -elapsed * 0.95;
      }
      assetRegistry.update(dt);
      assetRegistry.setNightFactor(nightFactor);

      // 하이라이트 링 셰이더 시간 갱신
      if (hoverHighlightMesh.visible) {
        hoverHighlightMat.uniforms["uTime"]!.value = elapsed;
      }
      if (selectedHighlightMesh.visible) {
        selectedHighlightMat.uniforms["uTime"]!.value = elapsed;
      }

      // 모닥불 다층 불꽃 애니메이션 (InstancedMesh)
      if (animatedFlames.length > 0) {
        for (let i = 0; i < animatedFlames.length; i += 1) {
          const fl = animatedFlames[i]!;
          const f1 = (0.88 + Math.sin(elapsed * 13.5 + fl.phase) * 0.16) * fl.scale;
          const f2 = (0.92 + Math.cos(elapsed * 17.0 + fl.phase) * 0.14) * fl.scale;
          animPos.set(fl.x, fl.y, fl.z);
          animQuat.identity();
          animScale.set(fl.scale, f1, fl.scale);
          animMat.compose(animPos, animQuat, animScale);
          flameOuterInst.setMatrixAt(i, animMat);

          animScale.set(fl.scale, f2, fl.scale);
          animMat.compose(animPos, animQuat, animScale);
          flameCoreInst.setMatrixAt(i, animMat);
        }
        flameOuterInst.instanceMatrix.needsUpdate = true;
        flameCoreInst.instanceMatrix.needsUpdate = true;
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
      cloudGroup.rotation.y = elapsed * 0.012;

      const targetRain = currentWeather === "rain" ? 1 : 0;
      rainStrength += (targetRain - rainStrength) * Math.min(1, dt * 3.2);
      brookMat.uniforms["uTime"]!.value = elapsed;
      brookMat.uniforms["uNight"]!.value = nightFactor;
      brookMat.uniforms["uRain"]!.value = rainStrength;
      (brookMat.uniforms["uSunDir"]!.value as Vector3).copy(sunDir);

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
      disposeObjectTree(dynamicWorldGroup);
      disposeObjectTree(ecosystemButterflyGroup);
      disposeObjectTree(ecosystemKoiGroup);
      butterflyLayers.length = 0;
      koiLayers.length = 0;
      assetRegistry.dispose();
      textures.dispose();
      cloudInst.dispose();
      bannerInstanced.dispose();
      bannerInstGeo.dispose();
      flameOuterInst.dispose();
      flameCoreInst.dispose();
      flameOuterGeo.dispose();
      flameCoreGeo.dispose();
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
      bladeHubGeo.dispose();
      bladeSparGeo.dispose();
      bladeSailGeo.dispose();
      bladeRibGeo.dispose();
      smokeGeo.dispose();
      highlightGeo.dispose();
      hoverHighlightMat.dispose();
      selectedHighlightMat.dispose();
      terrainGeo.dispose();
      terrainMat.dispose();
      brookGeo.dispose();
      brookMat.dispose();
      matWaterTile.dispose();
      grassBladeGeo.dispose();
      grassMat.dispose();
      flowerHeadGeo.dispose();
      flowerMat.dispose();
      fireflyGeo.dispose();
      fireflyMat.dispose();
      for (const mat of sharedMaterials) mat.dispose();
      sharedMaterials.length = 0;
      scene.remove(root);
    },
  };
}
